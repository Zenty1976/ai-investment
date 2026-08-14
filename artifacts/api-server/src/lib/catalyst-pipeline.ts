/**
 * Catalyst Autonomous Pipeline (Part 3, spec §1–6)
 *
 * This is the CRITICAL MISSING LINK that connects deterministic screening
 * to deep AI analysis. Before Part 3, the orchestrator called /screen but
 * deep analysis required a manual /analyze/:ticker call.
 *
 * After Part 3: the screen endpoint fires this pipeline in the background.
 * Eligible candidates are automatically analyzed within cost budgets.
 *
 * Pipeline flow:
 *   1. Seed DISCOVERED states for any universe ticker not yet in the repository
 *   2. Mark post-event candidates (set postEventAssessmentRequired = true)
 *   3. Derive lifecycle state + filter eligible
 *   4. Score by priority (computePriorityScore)
 *   5. Sort descending
 *   6. Slice to budget cap → analyze; rest → DEFERRED
 *   7. For STALE (post-event) candidates → force=true analyze
 *   8. Persist PipelineRunResult to repository
 *
 * DESIGN NOTE: This file intentionally avoids importing catalyst-analyze-service.ts
 * (which is pino-tainted via price-context-service → logger → pino). Instead it
 * accepts an injectable analyzeStrategy, defaulting to a lazy-imported real service.
 * This makes the pipeline fully testable without OpenAI calls.
 *
 * Pipeline runs asynchronously in the background so the /screen response returns
 * immediately. Results are accessible via GET /api/catalyst-intelligence/pipeline.
 */

import { getCatalystState, getAllCatalystStates, saveCatalystState } from "./catalyst-repository.js";
import {
  deriveLifecycleState, isEligibleForAutoAnalysis, isInBackoff,
  needsPostEventReassessment,
} from "./catalyst-lifecycle.js";
import {
  computePriorityScore, isCatalystAnalysisStale,
  DEFAULT_CATALYST_BUDGET, DEFAULT_CATALYST_FRESHNESS,
  computeRetryBackoff,
} from "./catalyst-config.js";
import type { CatalystBudgetConfig } from "./catalyst-config.js";
import { analysisRepository } from "./analysis-repository.js";
import type { CatalystState } from "./catalyst-types.js";
import {
  getMarketUniverseProvider,
} from "./market-universe-provider.js";

// ── Injectable analyze strategy (enables testing without pino) ─────────────────

/**
 * Strategy function type matching `runCatalystAnalyzeService` signature.
 * Inject a mock for testing; omit to use the real service (lazy-loaded).
 */
export type CatalystAnalyzeStrategy = (
  ticker: string,
  options: {
    force?: boolean;
    nowIso?: string;
    budgetHints?: {
      driverProfilesConsumed: number;
      researchConsumed: number;
      budget: CatalystBudgetConfig;
    };
  }
) => Promise<{
  error: string | null;
  promoted: boolean;
  aiCalled: boolean;
  driverProfileGenerated: boolean;
  researchRan: boolean;
  analysisUpdateType: string | null;
  opportunityState: string | null;
  state?: CatalystState;
}>;

// ── Inline failure recording (pino-free — no import of analyze-service) ────────

function _recordFailure(ticker: string, error: string, nowIso: string): void {
  const state = getCatalystState(ticker);
  if (!state) return;
  const newFailureCount = (state.failureCount ?? 0) + 1;
  const backoffMs = computeRetryBackoff(newFailureCount, DEFAULT_CATALYST_FRESHNESS);
  const retryEligibleAt = new Date(new Date(nowIso).getTime() + backoffMs).toISOString();
  saveCatalystState(ticker, {
    ...state,
    failureCount: newFailureCount,
    lastError: error.slice(0, 500),
    retryEligibleAt,
    updatedAt: nowIso,
  });
}

// ── Repository key for pipeline run history ────────────────────────────────────

const PIPELINE_RUN_KEY = "catalyst-pipeline:last-run";

// ── Result shapes ─────────────────────────────────────────────────────────────

export interface PipelineCandidateResult {
  ticker: string;
  company: string;
  priorityScore: number;
  lifecycleState: string;
  promoted: boolean;
  aiCalled: boolean;
  analysisUpdateType: string | null;
  opportunityState: string | null;
  durationMs: number;
}

export interface PipelineDeferredEntry {
  ticker: string;
  company: string;
  priorityScore: number;
  lifecycleState: string;
  deferredReason: string;
  deferredUntil: string;
}

export interface PipelineFailedEntry {
  ticker: string;
  company: string;
  error: string;
  failureCount: number;
  retryEligibleAt: string | null;
}

export interface PipelineRunResult {
  /** ISO timestamp when this pipeline run started. */
  startedAt: string;
  /** ISO timestamp when this pipeline run completed. */
  completedAt: string;
  /** Total eligible candidates considered (after lifecycle + backoff check). */
  candidatesConsidered: number;
  /** Candidates analyzed within budget this cycle. */
  analyzed: PipelineCandidateResult[];
  /** Candidates deferred because budget was exhausted. */
  deferred: PipelineDeferredEntry[];
  /** Candidates that failed during analysis. */
  failed: PipelineFailedEntry[];
  /** Post-event candidates detected and marked this cycle. */
  postEventMarked: number;
  /** Universe tickers seeded as DISCOVERED this cycle. */
  universeSeeded: number;
  /** Number of new Driver Profiles generated. */
  driverProfilesGenerated: number;
  /** Number of signal research runs completed. */
  researchRuns: number;
  /** Number of new Opportunity Finder promotions. */
  newPromotions: number;
  /** Budget used in this cycle. */
  budgetUsed: {
    deepAnalyses: number;
    driverProfiles: number;
    researchRuns: number;
  };
  /** Budget limits applied. */
  budgetLimits: CatalystBudgetConfig;
}

// ── Stored pipeline state ──────────────────────────────────────────────────────

interface StoredPipelineState {
  lastRun: PipelineRunResult | null;
  runCount: number;
  totalAnalyzed: number;
  totalPromotions: number;
}

export function getLastPipelineRun(): PipelineRunResult | null {
  const entry = analysisRepository.get<StoredPipelineState>(PIPELINE_RUN_KEY);
  return entry?.result?.lastRun ?? null;
}

function savePipelineRun(run: PipelineRunResult): void {
  const existing = analysisRepository.get<StoredPipelineState>(PIPELINE_RUN_KEY);
  const prev = existing?.result;
  analysisRepository.save(PIPELINE_RUN_KEY, {
    lastRun: run,
    runCount: (prev?.runCount ?? 0) + 1,
    totalAnalyzed: (prev?.totalAnalyzed ?? 0) + run.analyzed.length,
    totalPromotions: (prev?.totalPromotions ?? 0) + run.newPromotions,
  });
}

// ── Step 1: Universe seeding ───────────────────────────────────────────────────

/**
 * Ensure all universe tickers have a CatalystState entry (at minimum DISCOVERED).
 * This is what allows the pipeline to pick up tickers never manually interacted with.
 *
 * Uses MarketUniverseProvider so future external providers are automatically included.
 * Returns the count of newly-seeded entries.
 */
async function seedUniverseDiscoveredStates(nowIso: string): Promise<number> {
  const provider = getMarketUniverseProvider();
  let seeded = 0;

  try {
    // Get all known markets from the provider
    const markets = await provider.getSupportedMarkets();

    for (const market of markets) {
      const equities = await provider.getEquities(market);
      for (const equity of equities) {
        const existing = getCatalystState(equity.ticker);
        if (!existing) {
          saveCatalystState(equity.ticker, {
            ticker: equity.ticker,
            company: equity.company,
            screening: null,
            facts: null,
            analysis: null,
            lastAnalysisFingerprint: null,
            lastScreenedAt: null,
            lastAnalysedAt: null,
            eventPassed: false,
            updatedAt: nowIso,
            discoverySource: "UNIVERSE_SEED" as const,
            triggerType: null,
            signalAccumulation: null,
            emergingSetup: null,
            promotedAt: null,
            lastAnalysisUpdateType: null,
            failureCount: 0,
            lastError: null,
            retryEligibleAt: null,
            postEventAssessmentRequired: false,
          });
          seeded++;
        }
      }
    }
  } catch {
    // Non-fatal — pipeline continues with existing states
  }

  return seeded;
}

// ── Step 2: Post-event detection ───────────────────────────────────────────────

/**
 * Detect candidates whose event has passed and mark them for post-event reassessment.
 * Called at the start of each pipeline run.
 *
 * Per spec §6: "An old INTENTIONAL_PRE_EVENT_THESIS must never remain actionable
 * after the event without a new post-event assessment."
 *
 * Returns the count of newly-marked candidates.
 */
export function markPostEventCandidates(nowIso: string): number {
  const all = getAllCatalystStates();
  let marked = 0;

  for (const state of all) {
    if (state.postEventAssessmentRequired) continue;
    if (state.eventPassed) continue;

    const eventDate = state.facts?.event?.eventDate;
    if (!eventDate) continue;

    const eventMs = new Date(eventDate + "T00:00:00Z").getTime();
    const nowMs = new Date(nowIso).getTime();

    if (nowMs > eventMs && state.analysis) {
      // Event has passed AND we had a pre-event analysis → needs post-event reassessment
      saveCatalystState(state.ticker, {
        ...state,
        eventPassed: true,
        postEventAssessmentRequired: true,
        updatedAt: nowIso,
      });
      marked++;
    }
  }

  return marked;
}

// ── Core pipeline function ────────────────────────────────────────────────────

/**
 * Run the autonomous catalyst pipeline.
 *
 * Picks up eligible candidates from the repository, scores them, and
 * runs deep analysis within the configured budget.
 *
 * Safe to call concurrently — each ticker save is atomic.
 * If a ticker fails, failure is recorded and the pipeline continues.
 *
 * @param budget Override default budget limits (useful for testing).
 * @param nowIso Override current time (useful for testing).
 * @param analyzeStrategy Injectable analyze function (real service or test mock).
 *   If omitted, the real `runCatalystAnalyzeService` is loaded lazily.
 */
export async function runCatalystPipeline(
  budget: CatalystBudgetConfig = DEFAULT_CATALYST_BUDGET,
  nowIso: string = new Date().toISOString(),
  analyzeStrategy?: CatalystAnalyzeStrategy
): Promise<PipelineRunResult> {
  const startedAt = nowIso;

  // Resolve analyze function: inject for tests, lazy-load real service for production
  const analyze: CatalystAnalyzeStrategy = analyzeStrategy ?? (
    async (ticker, options) => {
      const { runCatalystAnalyzeService } = await import("./catalyst-analyze-service.js");
      return runCatalystAnalyzeService(ticker, options);
    }
  );

  // Step 1: Seed DISCOVERED states for all universe tickers
  const universeSeeded = await seedUniverseDiscoveredStates(nowIso);

  // Step 2: Detect and mark post-event candidates
  const postEventMarked = markPostEventCandidates(nowIso);

  // Step 3: Get all candidates and derive lifecycle
  const allStates = getAllCatalystStates();

  interface ScoredCandidate {
    state: CatalystState;
    lifecycleState: string;
    priorityScore: number;
    isPostEvent: boolean;
  }

  const eligible: ScoredCandidate[] = [];

  for (const state of allStates) {
    // Skip candidates in backoff
    if (isInBackoff(state, nowIso)) continue;

    const lifecycle = deriveLifecycleState(state, nowIso);
    const isPostEvent = needsPostEventReassessment(state);

    // Only proceed if lifecycle state warrants analysis
    if (!isEligibleForAutoAnalysis(state, nowIso)) continue;

    // For non-STALE candidates: skip if analysis is still fresh
    if (!isPostEvent) {
      const needsAnalysis =
        !state.analysis ||
        isCatalystAnalysisStale(
          state.lastAnalysedAt ?? null,
          state.facts?.event?.daysUntilEvent ?? null,
          DEFAULT_CATALYST_FRESHNESS,
          new Date(nowIso).getTime()
        );
      if (!needsAnalysis) continue;
    }

    const priorityScore = computePriorityScore({
      daysUntilEvent: state.facts?.event?.daysUntilEvent ?? state.screening?.daysUntilEvent ?? null,
      eventType: state.facts?.event?.eventType ?? null,
      preliminaryState: state.screening?.preliminaryState ?? null,
      priceAsymmetry: state.screening?.priceAsymmetry ?? null,
      inPortfolio: state.discoverySource === "PORTFOLIO",
      signalCount: state.facts?.signals?.length ?? 0,
      lastAnalysedAt: state.lastAnalysedAt,
    });

    // Post-event candidates get +50 priority bonus to ensure they run this cycle
    const adjustedScore = isPostEvent ? priorityScore + 50 : priorityScore;

    eligible.push({ state, lifecycleState: lifecycle, priorityScore: adjustedScore, isPostEvent });
  }

  // Step 4: Sort by priority (descending)
  eligible.sort((a, b) => b.priorityScore - a.priorityScore);

  // Step 5: Slice to queue size limit
  const queue = eligible.slice(0, budget.analysisCandidateQueueSize);

  // Step 6: Apply budget cap — top N get analyzed, rest deferred
  const toAnalyze = queue.slice(0, budget.maxDeepAnalysesPerCycle);
  const toDefer = queue.slice(budget.maxDeepAnalysesPerCycle);

  // Step 7: Mark deferred candidates
  const deferred: PipelineDeferredEntry[] = [];
  for (const candidate of toDefer) {
    const { state } = candidate;
    // Defer 1 hour (will be reconsidered next cycle)
    const deferredUntil = new Date(new Date(nowIso).getTime() + 60 * 60_000).toISOString();
    const deferredReason = `Budget cap (${budget.maxDeepAnalysesPerCycle} analyses/cycle) — priority score ${candidate.priorityScore}`;

    saveCatalystState(state.ticker, {
      ...state,
      deferredUntil,
      deferredReason,
      updatedAt: nowIso,
    });

    deferred.push({
      ticker: state.ticker,
      company: state.company,
      priorityScore: candidate.priorityScore,
      lifecycleState: candidate.lifecycleState,
      deferredReason,
      deferredUntil,
    });
  }

  // Step 8: Analyze within budget (with failure isolation)
  const analyzed: PipelineCandidateResult[] = [];
  const failed: PipelineFailedEntry[] = [];
  let driverProfilesGenerated = 0;
  let researchRuns = 0;
  let newPromotions = 0;
  let deepAnalysesUsed = 0;
  let driverProfilesUsed = 0;
  let researchUsed = 0;

  for (const candidate of toAnalyze) {
    const { state, isPostEvent } = candidate;
    const t0 = Date.now();

    try {
      const result = await analyze(state.ticker, {
        force: isPostEvent, // force re-analysis for post-event candidates
        nowIso,
        budgetHints: {
          driverProfilesConsumed: driverProfilesUsed,
          researchConsumed: researchUsed,
          budget,
        },
      });

      if (!result.error) {
        if (result.aiCalled) deepAnalysesUsed++;
        if (result.driverProfileGenerated) { driverProfilesGenerated++; driverProfilesUsed++; }
        if (result.researchRan) { researchRuns++; researchUsed++; }
        if (result.promoted) newPromotions++;

        // Clear post-event flag on success
        if (isPostEvent && result.state) {
          saveCatalystState(state.ticker, {
            ...result.state,
            postEventAssessmentRequired: false,
            updatedAt: nowIso,
          });
        }

        analyzed.push({
          ticker: state.ticker,
          company: state.company,
          priorityScore: candidate.priorityScore,
          lifecycleState: candidate.lifecycleState,
          promoted: result.promoted,
          aiCalled: result.aiCalled,
          analysisUpdateType: result.analysisUpdateType,
          opportunityState: result.opportunityState,
          durationMs: Date.now() - t0,
        });
      } else {
        // Service returned an error (not a throw)
        _recordFailure(state.ticker, result.error, nowIso);
        const updatedState = getCatalystState(state.ticker);
        failed.push({
          ticker: state.ticker,
          company: state.company,
          error: result.error,
          failureCount: updatedState?.failureCount ?? 1,
          retryEligibleAt: updatedState?.retryEligibleAt ?? null,
        });
      }
    } catch (err) {
      // Unexpected error — record failure and continue
      const msg = err instanceof Error ? err.message : String(err);
      _recordFailure(state.ticker, msg, nowIso);
      const updatedState = getCatalystState(state.ticker);
      failed.push({
        ticker: state.ticker,
        company: state.company,
        error: msg,
        failureCount: updatedState?.failureCount ?? 1,
        retryEligibleAt: updatedState?.retryEligibleAt ?? null,
      });
    }
  }

  // Step 9: Build and persist result
  const completedAt = new Date().toISOString();
  const result: PipelineRunResult = {
    startedAt,
    completedAt,
    candidatesConsidered: eligible.length,
    analyzed,
    deferred,
    failed,
    postEventMarked,
    universeSeeded,
    driverProfilesGenerated,
    researchRuns,
    newPromotions,
    budgetUsed: {
      deepAnalyses: deepAnalysesUsed,
      driverProfiles: driverProfilesUsed,
      researchRuns: researchUsed,
    },
    budgetLimits: budget,
  };

  savePipelineRun(result);
  return result;
}

// ── Post-event reassessment (single ticker) ────────────────────────────────────

/**
 * Run post-event reassessment for a single ticker.
 *
 * Per spec §6: "An old INTENTIONAL_PRE_EVENT_THESIS must never remain actionable
 * after the event without a new post-event assessment."
 *
 * THIS function handles only the Catalyst refresh portion.
 * Upstream modules (News, CompanyMonitor, PriceContext) are refreshed by the
 * orchestrator on the NEXT cycle because catalyst-intelligence runs AFTER them.
 *
 * @param analyzeStrategy Injectable for testing (same injection as runCatalystPipeline).
 */
export async function runPostEventReassessment(
  ticker: string,
  nowIso: string = new Date().toISOString(),
  analyzeStrategy?: CatalystAnalyzeStrategy
): Promise<{ ok: boolean; error: string | null }> {
  const state = getCatalystState(ticker);
  if (!state) {
    return { ok: false, error: `No CatalystState found for ${ticker}` };
  }

  if (!state.postEventAssessmentRequired) {
    return { ok: false, error: `${ticker} does not have postEventAssessmentRequired=true` };
  }

  const analyze: CatalystAnalyzeStrategy = analyzeStrategy ?? (
    async (t, options) => {
      const { runCatalystAnalyzeService } = await import("./catalyst-analyze-service.js");
      return runCatalystAnalyzeService(t, options);
    }
  );

  try {
    // Force a fresh analysis — pre-event fingerprint is stale by definition
    const result = await analyze(ticker, { force: true, nowIso });

    // Clear the post-event flag regardless of outcome
    const freshState = getCatalystState(ticker);
    if (freshState) {
      saveCatalystState(ticker, {
        ...(result.state ?? freshState),
        postEventAssessmentRequired: false,
        updatedAt: nowIso,
      });
    }

    if (result.error) {
      _recordFailure(ticker, `post-event reassessment: ${result.error}`, nowIso);
      return { ok: false, error: result.error };
    }

    return { ok: true, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    _recordFailure(ticker, `post-event reassessment failed: ${msg}`, nowIso);
    return { ok: false, error: msg };
  }
}
