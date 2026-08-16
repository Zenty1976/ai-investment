/**
 * Catalyst Analyze Service — Reusable Core (Part 3)
 *
 * Extracts the deep-analysis pipeline logic from the route handler
 * so it can be called by BOTH:
 *   - POST /api/catalyst-intelligence/analyze/:ticker (user-triggered)
 *   - runCatalystPipeline() (automated orchestrator-triggered)
 *
 * Logic is identical to the former route handler body. Route becomes thin wrapper.
 *
 * Budget hints allow the pipeline to track how many AI calls have been made
 * across all tickers in the current cycle, respecting per-cycle caps.
 */

import { getPriceContext } from "./price-context-service.js";
import {
  getCatalystState, saveCatalystState,
} from "./catalyst-repository.js";
import { buildCatalystFacts } from "./catalyst-facts-builder.js";
import { buildPriceAsymmetryFacts } from "./catalyst-price-asymmetry.js";
import { screenCatalystCandidate } from "./catalyst-screening.js";
import { DEFAULT_CATALYST_SCREENING_CONFIG } from "./catalyst-types.js";
import type {
  CatalystState, CatalystEvent, PriceAsymmetry,
  TriggerType, AnalysisUpdateType,
} from "./catalyst-types.js";
import {
  getOrGenerateDriverProfile, getDriverProfile,
} from "./catalyst-driver-profile.js";
import { computeSignalAccumulationState } from "./catalyst-signal-accumulation.js";
import { detectEmergingSetup, emergingSetupWarrantsAnalysis } from "./catalyst-emerging-setup.js";
import { runCatalystAnalysis, qualifiesForPromotion } from "./catalyst-analysis.js";
import {
  promoteToOpportunityFinder,
} from "./catalyst-promotion.js";
import {
  getUpcomingEventsForTicker, daysUntilEventDate,
} from "./catalyst-company-events.js";
import {
  getStoredSignals,
} from "./catalyst-signal-store.js";
import { researchDriverSignals } from "./catalyst-signal-research.js";
import { analysisRepository } from "./analysis-repository.js";
import {
  DEFAULT_CATALYST_BUDGET, DEFAULT_CATALYST_FRESHNESS,
  isCatalystAnalysisStale, computeRetryBackoff,
} from "./catalyst-config.js";
import type { CatalystBudgetConfig } from "./catalyst-config.js";
import { getUniverseEntry } from "./catalyst-universe.js";

// ── Result shape ──────────────────────────────────────────────────────────────

export interface CatalystAnalyzeServiceResult {
  ticker: string;
  company: string;
  triggerType: TriggerType | null;
  pathType: "PATH_A" | "PATH_B";
  promoted: boolean;
  aiCalled: boolean;
  analysisUpdateType: AnalysisUpdateType | null;
  opportunityState: string | null;
  catalystDirection: string | null;
  thesis: string | null;
  skipped: boolean;
  skipReason: string | null;
  error: string | null;
  state: CatalystState;
  /** For pipeline budget tracking. */
  driverProfileGenerated: boolean;
  researchRan: boolean;
}

export interface AnalyzeServiceOptions {
  force?: boolean;
  nowIso?: string;
  /**
   * Budget hints from the pipeline — allows per-cycle caps across tickers.
   * If undefined, budget is not enforced (used for user-triggered analyze).
   */
  budgetHints?: {
    driverProfilesConsumed: number;
    researchConsumed: number;
    budget: CatalystBudgetConfig;
  };
}

// ── Helpers (copied from route — kept identical to avoid divergence) ───────────

/** Available in catalyst-company-events but re-exported here for service use. */
function inferReportingPeriod(dateStr: string): string | null {
  try {
    const d = new Date(dateStr + "T00:00:00Z");
    const month = d.getUTCMonth() + 1;
    if ([1, 2].includes(month)) return "Q4";
    if ([4, 5].includes(month)) return "Q1";
    if ([7, 8].includes(month)) return "Q2";
    if ([10, 11].includes(month)) return "Q3";
    return null;
  } catch { return null; }
}

function findNextEarningsDateFromRepository(ticker: string, now: Date): {
  date: string; daysUntil: number; source: CatalystEvent["source"]; confidence: "High" | "Medium" | "Low"
} | null {
  const nowIso = now.toISOString();

  // 1. Check CM entry
  const cmEntry = analysisRepository.get<Record<string, unknown>>(`company-monitor:${ticker.toUpperCase()}`);
  const cmResult = cmEntry?.result;
  const earningsGuidance = cmResult?.earningsAndGuidance as Record<string, unknown> | undefined;
  const nextEventDate = earningsGuidance?.nextKnownEventDate as string | undefined;
  if (nextEventDate) {
    const days = daysUntilEventDate(nextEventDate, nowIso);
    if (days > 0 && days <= DEFAULT_CATALYST_SCREENING_CONFIG.maxDaysUntilEvent) {
      return { date: nextEventDate, daysUntil: days, source: "CompanyMonitor", confidence: "High" };
    }
  }

  // 2. Check Event Monitor
  const emEntry = analysisRepository.get<Record<string, unknown>>("event-monitor");
  const upcomingEvents = (emEntry?.result as Record<string, unknown> | undefined)?.upcomingEvents;
  if (Array.isArray(upcomingEvents)) {
    const earningsEvent = upcomingEvents.find((ev: Record<string, unknown>) => {
      const t = String(ev["ticker"] ?? "").toUpperCase();
      const type = String(ev["type"] ?? ev["eventType"] ?? "").toLowerCase();
      return t === ticker.toUpperCase() && type.includes("earn");
    }) as Record<string, unknown> | undefined;
    if (earningsEvent) {
      const date = String(earningsEvent["date"] ?? earningsEvent["eventDate"] ?? "");
      const days = daysUntilEventDate(date, nowIso);
      if (days > 0 && days <= DEFAULT_CATALYST_SCREENING_CONFIG.maxDaysUntilEvent) {
        return { date, daysUntil: days, source: "EventMonitor", confidence: "Medium" };
      }
    }
  }

  return null;
}

// ── Core service function ─────────────────────────────────────────────────────

/**
 * Run the full Catalyst deep-analysis pipeline for one ticker.
 *
 * Identical logic to the former route handler.
 * Returns a structured result usable by both the route and the pipeline.
 */
export async function runCatalystAnalyzeService(
  ticker: string,
  options: AnalyzeServiceOptions = {}
): Promise<CatalystAnalyzeServiceResult> {
  const force = options.force ?? false;
  const now = options.nowIso ? new Date(options.nowIso) : new Date();
  const nowIso = now.toISOString();
  const budgetHints = options.budgetHints;

  let driverProfileGenerated = false;
  let researchRan = false;

  // ── Step 1: Ensure screening is current ─────────────────────────────────────
  let state = getCatalystState(ticker);

  // If no state or no screening, screen first
  if (!state || !state.lastScreenedAt) {
    // Do a lightweight inline screen (reuse service logic from route)
    const inlineState = await _inlineScreen(ticker, nowIso);
    if (inlineState.error || !inlineState.state) {
      return {
        ticker, company: ticker, triggerType: null, pathType: "PATH_B",
        promoted: false, aiCalled: false, analysisUpdateType: null,
        opportunityState: null, catalystDirection: null, thesis: null,
        skipped: true, skipReason: null,
        error: inlineState.error ?? "Screening failed",
        state: state ?? _emptyState(ticker, nowIso),
        driverProfileGenerated: false, researchRan: false,
      };
    }
    state = inlineState.state;
  }

  const companyName = state.company;

  // ── Step 2: Stale analysis check ────────────────────────────────────────────
  // If analysis exists and is fresh and fingerprint unchanged → skip unless forced
  const isAnalysisStale = isCatalystAnalysisStale(
    state.lastAnalysedAt ?? null,
    state.facts?.event?.daysUntilEvent ?? null,
    DEFAULT_CATALYST_FRESHNESS
  );

  if (!force && state.analysis && !isAnalysisStale) {
    return {
      ticker, company: companyName, triggerType: state.triggerType,
      pathType: state.facts?.event ? "PATH_A" : "PATH_B",
      promoted: !!state.promotedAt, aiCalled: false, analysisUpdateType: null,
      opportunityState: state.analysis.opportunityState,
      catalystDirection: state.analysis.catalystDirection,
      thesis: state.analysis.thesis,
      skipped: true, skipReason: "Analysis is fresh and fingerprint unchanged",
      error: null, state, driverProfileGenerated: false, researchRan: false,
    };
  }

  // ── Step 3: Build facts (PATH A or PATH B) ──────────────────────────────────
  let facts = state.facts;

  if (!facts) {
    const storedSignals = getStoredSignals(ticker, 30);
    facts = buildCatalystFacts({ ticker, event: null, storedSignals });
  }

  // ── Step 4: Compute signal accumulation ─────────────────────────────────────
  const storedSignals = getStoredSignals(ticker, 30);
  const currentSignalIds = new Set(facts.signals.map(s => s.signalId));
  const allSignals = [
    ...facts.signals,
    ...storedSignals.filter(s => !currentSignalIds.has(s.signalId)),
  ];
  const signalAccumulation = computeSignalAccumulationState(ticker, allSignals, []);

  // ── Step 5: Detect emerging setup (PATH B) ──────────────────────────────────
  const hasScheduledEvent = !!(facts.event?.eventDate);
  const emergingSetup = detectEmergingSetup({
    signalAccumulation,
    momentum5D: facts.price.priceAsymmetryFacts.recentMomentum5D,
    momentum30D: facts.price.priceAsymmetryFacts.momentum30D,
    momentum90D: facts.price.priceAsymmetryFacts.momentum90D,
    cmStatus: facts.company.earningsGuidanceTrend ?? null,
    sectorDirection: facts.sector?.sectorSummary ?? null,
    hasKnownUpcomingEvent: hasScheduledEvent,
  });

  const triggerType: TriggerType = hasScheduledEvent
    ? (facts.event!.eventType === "Earnings" ? "EARNINGS" : "SCHEDULED_EVENT")
    : "EMERGING_SETUP";

  // ── Step 6: Eligibility check ────────────────────────────────────────────────
  // A candidate should receive deep analysis when:
  //   a) screeningLevel is DeepAnalysis or SignalAssessment (path A — close event), OR
  //   b) screening.eligible=true AND the current event is within 14 days regardless of
  //      stored screeningLevel (handles stale screenings — e.g. BasicMonitor assigned
  //      when the event was > 21 days away; now it's closer and should be analyzed), OR
  //   c) PATH B: no scheduled event but emerging setup warrants analysis.
  const currentDaysUntilEvent =
    facts.event?.daysUntilEvent ?? state.screening?.daysUntilEvent ?? null;

  const isDeepAnalysis =
    state.screening?.screeningLevel === "DeepAnalysis" ||
    state.screening?.screeningLevel === "SignalAssessment" ||
    // Stale screening guard: eligible candidate whose event has moved into the
    // deep-analysis window but screening hasn't been refreshed yet.
    (state.screening?.eligible === true &&
      currentDaysUntilEvent !== null &&
      currentDaysUntilEvent <= 14);

  const pathBEligible =
    triggerType === "EMERGING_SETUP" && emergingSetupWarrantsAnalysis(emergingSetup);

  const shouldAnalyze = isDeepAnalysis || pathBEligible;

  // ── Step 7: Driver profile ───────────────────────────────────────────────────
  let driverProfile = getDriverProfile(ticker) ?? null;
  if (shouldAnalyze && !driverProfile) {
    // Check budget
    const canGenerateProfile =
      !budgetHints ||
      budgetHints.driverProfilesConsumed < budgetHints.budget.maxDriverProfilesPerCycle;

    if (canGenerateProfile) {
      const universeEntry = getUniverseEntry(ticker);
      driverProfile = await getOrGenerateDriverProfile(
        ticker,
        companyName,
        universeEntry?.sector ?? facts.company.sector,
        universeEntry?.industry ?? facts.company.industry
      );
      if (driverProfile) driverProfileGenerated = true;
    }
  }

  // ── Step 8: Driver-directed signal research ──────────────────────────────────
  let researchResult = null;
  if (shouldAnalyze && driverProfile) {
    const canRunResearch =
      !budgetHints ||
      budgetHints.researchConsumed < budgetHints.budget.maxDriverResearchPerCycle;

    if (canRunResearch) {
      researchResult = await researchDriverSignals(
        ticker,
        companyName,
        driverProfile,
        facts.event?.daysUntilEvent ?? null,
        force
      );
      researchRan = !researchResult.skipped;

      if (researchResult.allStoredSignals.length > 0) {
        facts = buildCatalystFacts({
          ticker,
          event: facts.event,
          storedSignals: researchResult.allStoredSignals,
        });
      }
    }
  }

  // ── Step 9: Deep AI analysis ─────────────────────────────────────────────────
  let analysisOutput = null;
  let aiCalled = false;

  if (shouldAnalyze) {
    analysisOutput = await runCatalystAnalysis({
      facts,
      triggerType,
      eventId: null,
      driverProfile,
      lastFingerprint: force ? null : (state.lastAnalysisFingerprint ?? null),
      retryNumber: 0,
    });
    if (analysisOutput && !analysisOutput.skipped) {
      aiCalled = true;
    }
  }

  // ── Step 10: Update state ────────────────────────────────────────────────────
  const updatedState: CatalystState = {
    ...state,
    facts,
    signalAccumulation,
    emergingSetup: triggerType === "EMERGING_SETUP" ? emergingSetup : (state.emergingSetup ?? null),
    triggerType,
    analysis: analysisOutput?.result ?? state.analysis,
    lastAnalysisFingerprint: analysisOutput?.fingerprint ?? state.lastAnalysisFingerprint,
    lastAnalysedAt: analysisOutput && !analysisOutput.skipped ? nowIso : state.lastAnalysedAt,
    lastAnalysisUpdateType: analysisOutput?.result?.analysisUpdateType ?? state.lastAnalysisUpdateType,
    updatedAt: nowIso,
    // Clear failure state on success
    failureCount: 0,
    lastError: null,
    retryEligibleAt: null,
  };

  // ── Step 11: Promote to OF if qualified ──────────────────────────────────────
  let promoted = false;
  if (
    analysisOutput?.result &&
    qualifiesForPromotion(analysisOutput.result) &&
    !state.promotedAt
  ) {
    promoteToOpportunityFinder(ticker, companyName, analysisOutput.result, facts);
    updatedState.promotedAt = nowIso;
    promoted = true;
  }

  saveCatalystState(ticker, updatedState);

  return {
    ticker,
    company: companyName,
    triggerType,
    pathType: hasScheduledEvent ? "PATH_A" : "PATH_B",
    promoted,
    aiCalled,
    analysisUpdateType: updatedState.lastAnalysisUpdateType,
    opportunityState: updatedState.analysis?.opportunityState ?? null,
    catalystDirection: updatedState.analysis?.catalystDirection ?? null,
    thesis: updatedState.analysis?.thesis ?? null,
    skipped: analysisOutput?.skipped ?? !shouldAnalyze,
    skipReason: analysisOutput?.skipReason ?? (shouldAnalyze ? null : "Not eligible for deep analysis"),
    error: null,
    state: updatedState,
    driverProfileGenerated,
    researchRan,
  };
}

/**
 * Record a failure for a ticker and compute retry backoff.
 * Called by the pipeline when runCatalystAnalyzeService throws.
 */
export function recordCatalystFailure(ticker: string, error: string, nowIso: string): void {
  const state = getCatalystState(ticker);
  if (!state) return;

  const newFailureCount = (state.failureCount ?? 0) + 1;
  const backoffMs = computeRetryBackoff(newFailureCount, DEFAULT_CATALYST_FRESHNESS);
  const retryEligibleAt = new Date(new Date(nowIso).getTime() + backoffMs).toISOString();

  saveCatalystState(ticker, {
    ...state,
    failureCount: newFailureCount,
    lastError: error.slice(0, 500), // cap length
    retryEligibleAt,
    updatedAt: nowIso,
  });
}

// ── Inline screen (lightweight, no HTTP) ──────────────────────────────────────

async function _inlineScreen(
  ticker: string,
  nowIso: string
): Promise<{ state: CatalystState | null; error: string | null }> {
  try {
    // Import cycle-safe — these are used by the route too
    const { getPriceContext } = await import("./price-context-service.js");
    const { buildCatalystFacts } = await import("./catalyst-facts-builder.js");
    const { buildPriceAsymmetryFacts } = await import("./catalyst-price-asymmetry.js");
    const { screenCatalystCandidate } = await import("./catalyst-screening.js");
    const { DEFAULT_CATALYST_SCREENING_CONFIG } = await import("./catalyst-types.js");
    const { getUpcomingEventsForTicker, daysUntilEventDate } = await import("./catalyst-company-events.js");
    const { getStoredSignals } = await import("./catalyst-signal-store.js");
    const { getUniverseEntry } = await import("./catalyst-universe.js");
    const { getCatalystState, saveCatalystState } = await import("./catalyst-repository.js");

    const universeEntry = getUniverseEntry(ticker);
    const cmEntry = analysisRepository.get<Record<string, unknown>>(`company-monitor:${ticker.toUpperCase()}`);
    const cmResult = cmEntry?.result;
    const cmCompanyObj = cmResult?.company as Record<string, unknown> | undefined;
    const company = String(
      universeEntry?.company ?? cmCompanyObj?.name ??
      (typeof cmResult?.company === "string" ? cmResult.company : null) ?? ticker
    ).trim() || ticker;

    const storedEvents = getUpcomingEventsForTicker(ticker, DEFAULT_CATALYST_SCREENING_CONFIG.maxDaysUntilEvent, nowIso);
    const IMPACT_SCORE: Record<string, number> = { High: 3, Medium: 2, Low: 1, Unknown: 1 };
    const rankedEvents = storedEvents
      .filter(ev => daysUntilEventDate(ev.eventDate, nowIso) >= DEFAULT_CATALYST_SCREENING_CONFIG.minDaysUntilEvent)
      .sort((a, b) => {
        const diff = (IMPACT_SCORE[b.potentialMarketImpact] ?? 1) - (IMPACT_SCORE[a.potentialMarketImpact] ?? 1);
        return diff !== 0 ? diff : a.eventDate.localeCompare(b.eventDate);
      });

    let event: import("./catalyst-types.js").CatalystEvent | null = null;
    if (rankedEvents.length > 0) {
      const ev = rankedEvents[0];
      const days = daysUntilEventDate(ev.eventDate, nowIso);
      event = {
        ticker, company,
        eventType: ev.eventType as import("./catalyst-types.js").CatalystEventType,
        eventDate: ev.eventDate,
        daysUntilEvent: days,
        reportingPeriod: inferReportingPeriod(ev.eventDate),
        marketTiming: ev.beforeAfterMarket === "BeforeMarket" ? "BeforeMarket"
          : ev.beforeAfterMarket === "AfterMarket" ? "AfterMarket" : "Unknown",
        source: "CompanyEvents" as import("./catalyst-types.js").CatalystEventSource,
        sourceConfidence: "High",
        classification: "Unknown",
      };
    } else {
      const earnings = findNextEarningsDateFromRepository(ticker, new Date(nowIso));
      if (earnings) {
        event = {
          ticker, company, eventType: "Earnings",
          eventDate: earnings.date, daysUntilEvent: earnings.daysUntil,
          reportingPeriod: inferReportingPeriod(earnings.date),
          marketTiming: "Unknown", source: earnings.source,
          sourceConfidence: earnings.confidence, classification: "Unknown",
        };
      }
    }

    const pc = getPriceContext(ticker);
    const daysForAsymmetry = event?.daysUntilEvent ?? 45;
    const priceAsymmetryFacts = pc ? buildPriceAsymmetryFacts(pc, daysForAsymmetry, DEFAULT_CATALYST_SCREENING_CONFIG) : null;
    const priceAsymmetry: PriceAsymmetry = priceAsymmetryFacts?.asymmetry ?? "Neutral";
    const storedSignals = getStoredSignals(ticker, 30);
    const facts = buildCatalystFacts({ ticker, event, storedSignals });
    const relevantSignalCount = facts.signals.filter(s => s.direction !== "Neutral").length;

    const screening = screenCatalystCandidate({
      ticker, company,
      daysUntilEvent: event?.daysUntilEvent ?? null,
      priceAsymmetry,
      investmentView: facts.company.investmentView,
      earningsGuidanceTrend: facts.company.earningsGuidanceTrend,
      relevantSignalCount, signals: facts.signals,
      hasPriceContext: !!pc, hasCompanyMonitor: !!cmResult, facts,
      config: DEFAULT_CATALYST_SCREENING_CONFIG,
      screenedAt: nowIso,
    });

    const existingState = getCatalystState(ticker);
    const state: CatalystState = {
      ticker, company, screening,
      facts: (event || screening.eligible) ? facts : null,
      analysis: existingState?.analysis ?? null,
      lastAnalysisFingerprint: existingState?.lastAnalysisFingerprint ?? null,
      lastScreenedAt: nowIso,
      lastAnalysedAt: existingState?.lastAnalysedAt ?? null,
      eventPassed: event ? event.daysUntilEvent < 0 : false,
      updatedAt: nowIso,
      discoverySource: existingState?.discoverySource ?? (cmResult ? "COMPANY_SIGNAL" : universeEntry ? "UNIVERSE_EVENT" : null),
      triggerType: existingState?.triggerType ?? null,
      signalAccumulation: existingState?.signalAccumulation ?? null,
      emergingSetup: existingState?.emergingSetup ?? null,
      promotedAt: existingState?.promotedAt ?? null,
      lastAnalysisUpdateType: existingState?.lastAnalysisUpdateType ?? null,
      failureCount: existingState?.failureCount ?? 0,
      lastError: existingState?.lastError ?? null,
      retryEligibleAt: existingState?.retryEligibleAt ?? null,
      postEventAssessmentRequired: existingState?.postEventAssessmentRequired ?? false,
    };

    saveCatalystState(ticker, state);
    return { state, error: null };
  } catch (err) {
    return { state: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function _emptyState(ticker: string, nowIso: string): CatalystState {
  return {
    ticker, company: ticker,
    screening: null, facts: null, analysis: null,
    lastAnalysisFingerprint: null, lastScreenedAt: null, lastAnalysedAt: null,
    eventPassed: false, updatedAt: nowIso,
    discoverySource: null, triggerType: null,
    signalAccumulation: null, emergingSetup: null,
    promotedAt: null, lastAnalysisUpdateType: null,
    failureCount: 0, lastError: null, retryEligibleAt: null,
    postEventAssessmentRequired: false,
  };
}
