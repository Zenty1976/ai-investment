/**
 * Catalyst Autonomous Pipeline (Part 3, spec §1–5)
 *
 * This is the CRITICAL MISSING LINK that connects deterministic screening
 * to deep AI analysis. Before Part 3, the orchestrator called /screen but
 * deep analysis required a manual /analyze/:ticker call.
 *
 * After Part 3: the screen endpoint fires this pipeline in the background.
 * Eligible candidates are automatically analyzed within cost budgets.
 *
 * Pipeline flow:
 *   screened candidates
 *   → derive lifecycle state
 *   → filter eligible (not screened-out, not in backoff)
 *   → score by priority
 *   → sort descending
 *   → slice to budget cap
 *   → [within budget] runCatalystAnalyzeService()
 *   → [over budget] mark deferredUntil
 *   → persist PipelineRunResult to repository
 *
 * Pipeline runs asynchronously in the background so the /screen response
 * returns immediately. Results are accessible via GET /api/catalyst-intelligence/pipeline.
 */

import { getAllCatalystStates, saveCatalystState } from "./catalyst-repository.js";
import {
  deriveLifecycleState, isEligibleForAutoAnalysis, isInBackoff,
} from "./catalyst-lifecycle.js";
import {
  computePriorityScore,
  isCatalystAnalysisStale,
  DEFAULT_CATALYST_BUDGET, DEFAULT_CATALYST_FRESHNESS,
} from "./catalyst-config.js";
import type { CatalystBudgetConfig } from "./catalyst-config.js";
import {
  runCatalystAnalyzeService, recordCatalystFailure,
} from "./catalyst-analyze-service.js";
import { analysisRepository } from "./analysis-repository.js";
import type { CatalystState } from "./catalyst-types.js";

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
  /** Total candidates considered (eligible after lifecycle check). */
  candidatesConsidered: number;
  /** Candidates analyzed within budget this cycle. */
  analyzed: PipelineCandidateResult[];
  /** Candidates deferred because budget was exhausted. */
  deferred: PipelineDeferredEntry[];
  /** Candidates that failed during analysis. */
  failed: PipelineFailedEntry[];
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

// ── Post-event detection ───────────────────────────────────────────────────────

/**
 * Detect candidates whose event has passed and mark them for post-event reassessment.
 * Called at the start of each pipeline run.
 *
 * Returns the count of newly-marked candidates.
 */
function markPostEventCandidates(nowIso: string): number {
  const all = getAllCatalystStates();
  let marked = 0;

  for (const state of all) {
    // Already marked or already past
    if ((state as CatalystState & { postEventAssessmentRequired?: boolean }).postEventAssessmentRequired) continue;
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
 */
export async function runCatalystPipeline(
  budget: CatalystBudgetConfig = DEFAULT_CATALYST_BUDGET,
  nowIso: string = new Date().toISOString()
): Promise<PipelineRunResult> {
  const startedAt = nowIso;

  // Step 1: Detect and mark post-event candidates
  markPostEventCandidates(nowIso);

  // Step 2: Get all screened candidates
  const allStates = getAllCatalystStates();

  // Step 3: Filter to eligible candidates for auto-analysis
  interface ScoredCandidate {
    state: CatalystState;
    lifecycleState: string;
    priorityScore: number;
  }

  const eligible: ScoredCandidate[] = [];

  for (const state of allStates) {
    // Skip candidates in backoff
    if (isInBackoff(state, nowIso)) continue;

    const lifecycle = deriveLifecycleState(state);

    // Only proceed if lifecycle state warrants analysis
    if (!isEligibleForAutoAnalysis(state)) continue;

    // Skip if analysis is fresh and not forced
    const needsAnalysis = !state.analysis || isCatalystAnalysisStale(
      state.lastAnalysedAt ?? null,
      state.facts?.event?.daysUntilEvent ?? null,
      DEFAULT_CATALYST_FRESHNESS
    );
    if (!needsAnalysis) continue;

    const priorityScore = computePriorityScore({
      daysUntilEvent: state.facts?.event?.daysUntilEvent ?? state.screening?.daysUntilEvent ?? null,
      eventType: state.facts?.event?.eventType ?? null,
      preliminaryState: state.screening?.preliminaryState ?? null,
      priceAsymmetry: state.screening?.priceAsymmetry ?? null,
      inPortfolio: state.discoverySource === "PORTFOLIO",
      signalCount: state.facts?.signals?.length ?? 0,
      lastAnalysedAt: state.lastAnalysedAt,
    });

    eligible.push({ state, lifecycleState: lifecycle, priorityScore });
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
    // Defer 1h (will be reconsidered next cycle)
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
    const { state } = candidate;
    const t0 = Date.now();

    try {
      const result = await runCatalystAnalyzeService(state.ticker, {
        force: false,
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
        recordCatalystFailure(state.ticker, result.error, nowIso);
        const updatedState = getAllCatalystStates().find(s => s.ticker === state.ticker);
        failed.push({
          ticker: state.ticker,
          company: state.company,
          error: result.error,
          failureCount: updatedState?.failureCount ?? 1,
          retryEligibleAt: (updatedState as (CatalystState & { retryEligibleAt?: string | null }))?.retryEligibleAt ?? null,
        });
      }
    } catch (err) {
      // Unexpected error — record failure and continue
      const msg = err instanceof Error ? err.message : String(err);
      recordCatalystFailure(state.ticker, msg, nowIso);
      const updatedState = getAllCatalystStates().find(s => s.ticker === state.ticker);
      failed.push({
        ticker: state.ticker,
        company: state.company,
        error: msg,
        failureCount: updatedState?.failureCount ?? 1,
        retryEligibleAt: (updatedState as (CatalystState & { retryEligibleAt?: string | null }))?.retryEligibleAt ?? null,
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

// ── Post-event reassessment ───────────────────────────────────────────────────

/**
 * Run post-event reassessment for a single ticker.
 *
 * Called when a candidate's event date has passed. Clears the pre-event
 * thesis and triggers fresh analysis with post-event signals.
 *
 * Per spec §7: "The event should trigger News/Event refresh, Company Monitor
 * refresh, Price Context refresh, Catalyst refresh…"
 *
 * THIS function handles only the Catalyst refresh portion.
 * The orchestrator handles the upstream module refresh chain.
 */
export async function runPostEventReassessment(
  ticker: string,
  nowIso: string = new Date().toISOString()
): Promise<{ ok: boolean; error: string | null }> {
  const state = getAllCatalystStates().find(s => s.ticker === ticker);
  if (!state) {
    return { ok: false, error: `No CatalystState found for ${ticker}` };
  }

  if (!(state as CatalystState & { postEventAssessmentRequired?: boolean }).postEventAssessmentRequired) {
    return { ok: false, error: `${ticker} does not have postEventAssessmentRequired=true` };
  }

  try {
    // Force a fresh analysis — pre-event fingerprint is stale
    const result = await runCatalystAnalyzeService(ticker, {
      force: true,
      nowIso,
    });

    // Clear the post-event flag
    if (result.state) {
      saveCatalystState(ticker, {
        ...result.state,
        postEventAssessmentRequired: false,
        updatedAt: nowIso,
      });
    }

    return { ok: true, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordCatalystFailure(ticker, `post-event reassessment failed: ${msg}`, nowIso);
    return { ok: false, error: msg };
  }
}
