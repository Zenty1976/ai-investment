/**
 * Catalyst Intelligence Route — Part 2 (Full Pipeline, Corrected)
 *
 * Endpoints:
 *   POST /api/catalyst-intelligence/screen            — screening for all universe tickers
 *   POST /api/catalyst-intelligence/screen/:ticker    — screen a specific ticker
 *   POST /api/catalyst-intelligence/analyze/:ticker   — deep AI analysis (PATH A or B)
 *   POST /api/catalyst-intelligence/driver-profile/:ticker — generate/refresh driver profile
 *   GET  /api/catalyst-intelligence/status            — all tracked tickers' states
 *   GET  /api/catalyst-intelligence/promotions        — active OF promotions
 *   GET  /api/catalyst-intelligence/universe          — universe status + Saxo report (§13)
 *   GET  /api/catalyst-intelligence/debug/:ticker     — full debug dump
 *   GET  /api/catalyst-intelligence/facts/:ticker     — assembled CatalystFacts
 *
 * Integration fixes (correction spec):
 *   1. Universe: collectAllScreenableTickers() from catalyst-universe (includes seed)
 *   2. Events: CompanySpecificEvents checked first; earnings is the FALLBACK
 *   3. PATH B: analyze/:ticker builds facts with event=null when no event found
 *   4. Signal persistence: stored signals included in facts for accumulation windows
 *   5. Proactive event discovery: cost-safe, gated by shouldSkipDiscovery()
 *   6. Saxo universe: enrichUniverseWithSaxo() runs non-blocking during screen
 */

import { Router } from "express";
import { analysisRepository } from "../lib/analysis-repository.js";
import { getPriceContext } from "../lib/price-context-service.js";
import {
  getCatalystState, saveCatalystState, getAllCatalystStates,
} from "../lib/catalyst-repository.js";
import { buildCatalystFacts } from "../lib/catalyst-facts-builder.js";
import { buildPriceAsymmetryFacts } from "../lib/catalyst-price-asymmetry.js";
import { screenCatalystCandidate } from "../lib/catalyst-screening.js";
import { DEFAULT_CATALYST_SCREENING_CONFIG } from "../lib/catalyst-types.js";
import type {
  CatalystEvent, CatalystState, PriceAsymmetry, TriggerType,
  CatalystEventType, ScheduledCatalystType,
} from "../lib/catalyst-types.js";
import {
  getOrGenerateDriverProfile, getDriverProfile,
} from "../lib/catalyst-driver-profile.js";
import { computeSignalAccumulationState } from "../lib/catalyst-signal-accumulation.js";
import { detectEmergingSetup, emergingSetupWarrantsAnalysis } from "../lib/catalyst-emerging-setup.js";
import { runCatalystAnalysis, qualifiesForPromotion } from "../lib/catalyst-analysis.js";
import {
  promoteToOpportunityFinder, getActivePromotions, buildPromotionsContextBlock,
} from "../lib/catalyst-promotion.js";
import {
  collectAllScreenableTickers, getUniverseEntry,
} from "../lib/catalyst-universe.js";
import {
  getUpcomingEventsForTicker, daysUntilEventDate,
} from "../lib/catalyst-company-events.js";
import type { CompanySpecificEvent } from "../lib/catalyst-types.js";
import {
  getStoredSignals, mergeStoredSignals,
} from "../lib/catalyst-signal-store.js";
import {
  discoverEventsForTicker, shouldSkipDiscovery,
} from "../lib/catalyst-event-discovery.js";
import {
  enrichUniverseWithSaxo, getSaxoUniverseStatus,
} from "../lib/catalyst-saxo-universe.js";
import { researchDriverSignals } from "../lib/catalyst-signal-research.js";
import {
  runCatalystPipeline, getLastPipelineRun, runPostEventReassessment,
} from "../lib/catalyst-pipeline.js";
import { recordCatalystFailure } from "../lib/catalyst-analyze-service.js";
import { deriveLifecycleState } from "../lib/catalyst-lifecycle.js";
import { DEFAULT_CATALYST_BUDGET } from "../lib/catalyst-config.js";
import { getProviderCapabilityReport } from "../lib/market-universe-provider.js";

const router = Router();
const MODULE = "catalyst-intelligence";

// ── Max proactive discoveries per screen run (cost control) ───────────────────
const MAX_PROACTIVE_DISCOVERIES = 5;

// ── Event type mapping ────────────────────────────────────────────────────────

/**
 * Map ScheduledCatalystType (catalyst-company-events) to CatalystEventType (catalyst-types).
 * ScheduledCatalystType is the more granular set; CatalystEventType is the compact analysis type.
 */
function scheduledTypeToCatalystEventType(t: ScheduledCatalystType): CatalystEventType {
  switch (t) {
    case "EARNINGS":                                      return "Earnings";
    case "GUIDANCE_UPDATE":                               return "GuidanceUpdate";
    case "INVESTOR_DAY":                                  return "InvestorDay";
    case "CAPITAL_MARKETS_DAY":                           return "CapitalMarketsDay";
    case "COMPANY_MEETING":   case "SHAREHOLDER_MEETING": return "CompanyMeeting";
    case "PRODUCT_LAUNCH":    case "AI_MODEL_LAUNCH":
    case "TECHNOLOGY_DEMONSTRATION": case "DEVELOPER_CONFERENCE":
    case "KEYNOTE":                                       return "ProductLaunch";
    case "CLINICAL_READOUT":                              return "ClinicalReadout";
    case "FDA_DECISION":      case "REGULATORY_DECISION":
    case "COURT_DECISION":                                return "RegulatoryDecision";
    default:                                              return "Other";
  }
}

/**
 * Convert a CompanySpecificEvent to the CatalystEvent shape used in facts + AI analysis.
 */
function companyEventToCatalystEvent(
  ev: CompanySpecificEvent,
  ticker: string,
  company: string,
  nowIso: string,
): CatalystEvent {
  return {
    ticker,
    company,
    eventType: scheduledTypeToCatalystEventType(ev.eventType),
    eventDate: ev.eventDate,
    daysUntilEvent: daysUntilEventDate(ev.eventDate, nowIso),
    reportingPeriod: ev.eventType === "EARNINGS" ? inferReportingPeriod(ev.eventDate) : null,
    // Map "DuringMarket" → "Unknown" since CatalystEvent.marketTiming doesn't include it
    marketTiming: ev.beforeAfterMarket === "DuringMarket" ? "Unknown" : ev.beforeAfterMarket,
    source: "CompanyEvents",
    sourceConfidence: ev.isConfirmed ? "High" : "Low",
    classification: "Unknown",
  };
}

// ── Earnings date detection (fallback only) ────────────────────────────────────

interface EarningsDate {
  date: string;
  daysUntil: number;
  source: "CompanyMonitor" | "EventMonitor";
  confidence: "High" | "Medium" | "Low";
}

/**
 * Fallback: find an earnings date from CM.earningsAndGuidance or Event Monitor.
 * Only called when getUpcomingEventsForTicker() returns nothing in the window.
 */
function findNextEarningsDate(
  ticker: string,
  cmResult: Record<string, unknown> | undefined,
  today: Date
): EarningsDate | null {
  const todayMs = today.getTime();

  // Source 1: Company Monitor nextKnownEventDate
  const eg = cmResult?.earningsAndGuidance as Record<string, unknown> | undefined;
  const cmDate = String(eg?.nextKnownEventDate ?? "").trim();

  if (cmDate && /^\d{4}-\d{2}-\d{2}$/.test(cmDate)) {
    const eventMs = new Date(cmDate + "T00:00:00Z").getTime();
    const daysUntil = Math.round((eventMs - todayMs) / 86_400_000);
    if (daysUntil >= 0) {
      return { date: cmDate, daysUntil, source: "CompanyMonitor", confidence: "High" };
    }
  }

  // Source 2: Event Monitor — scan for earnings events matching ticker
  const eiState = analysisRepository.get<{
    events: Array<{
      id: string; title: string; date: string; status: string;
      category: string; affectedMarkets?: string[];
    }>;
  }>("event-intelligence");

  if (eiState?.result?.events) {
    const companyBase = ticker.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 5);
    for (const ev of eiState.result.events) {
      if (ev.status === "passed") continue;
      const titleUpper = ev.title.toUpperCase();
      const mentionsTicker =
        titleUpper.includes(companyBase) || titleUpper.includes(ticker.toUpperCase());
      const isEarnings = /EARNINGS|RESULTS|REPORT|QUARTERLY|ANNUAL/.test(titleUpper);
      if (!mentionsTicker || !isEarnings) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) continue;
      const eventMs = new Date(ev.date + "T00:00:00Z").getTime();
      const daysUntil = Math.round((eventMs - todayMs) / 86_400_000);
      if (daysUntil >= 0) {
        return { date: ev.date, daysUntil, source: "EventMonitor", confidence: "Low" };
      }
    }
  }

  return null;
}

// ── Reporting period helper ───────────────────────────────────────────────────

function inferReportingPeriod(eventDate: string): string | null {
  const d = new Date(eventDate + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  const month = d.getUTCMonth() + 1;
  if (month >= 1  && month <= 3)  return `Q4 ${d.getUTCFullYear() - 1}`;
  if (month >= 4  && month <= 6)  return `Q1 ${d.getUTCFullYear()}`;
  if (month >= 7  && month <= 9)  return `Q2 ${d.getUTCFullYear()}`;
  if (month >= 10 && month <= 12) return `Q3 ${d.getUTCFullYear()}`;
  return null;
}

// ── Screen a single ticker ─────────────────────────────────────────────────────

interface ScreenTickerResult {
  ticker: string;
  state: CatalystState | null;
  error: string | null;
}

/**
 * Deterministic screening for one ticker.
 *
 * Event discovery priority (spec §3):
 *   1. CompanySpecificEvents store — any type (EARNINGS, INVESTOR_DAY, etc.)
 *   2. CM / Event Monitor earnings fallback
 *   3. null event (PATH B eligible)
 *
 * Historical signals from the persistent signal store are included
 * so 7D/14D/30D accumulation windows work correctly.
 */
function screenTicker(ticker: string, now: Date): ScreenTickerResult {
  const screenedAt = now.toISOString();

  try {
    // ── Company name resolution ────────────────────────────────────────────────
    // Priority: universe entry → CM entry → ticker symbol
    const universeEntry = getUniverseEntry(ticker);

    const cmEntry = analysisRepository.get<Record<string, unknown>>(
      `company-monitor:${ticker.toUpperCase()}`
    );
    const cmResult = cmEntry?.result;
    const cmCompanyObj = cmResult?.company as Record<string, unknown> | undefined;
    const company = String(
      universeEntry?.company ??
      cmCompanyObj?.name ??
      (typeof cmResult?.company === "string" ? cmResult.company : null) ??
      ticker
    ).trim() || ticker;

    // ── Step 1: Find best upcoming event (spec §3) ────────────────────────────
    // First: check the CompanySpecificEvents store for ANY event type
    const storedEvents = getUpcomingEventsForTicker(
      ticker,
      DEFAULT_CATALYST_SCREENING_CONFIG.maxDaysUntilEvent,
      screenedAt
    );

    // Filter to events within the minimum window and rank by impact × proximity
    const IMPACT_SCORE: Record<string, number> = { High: 3, Medium: 2, Low: 1, Unknown: 1 };
    const rankedEvents = storedEvents
      .filter(ev => {
        const days = daysUntilEventDate(ev.eventDate, screenedAt);
        return days >= DEFAULT_CATALYST_SCREENING_CONFIG.minDaysUntilEvent;
      })
      .sort((a, b) => {
        const impA = IMPACT_SCORE[a.potentialMarketImpact] ?? 1;
        const impB = IMPACT_SCORE[b.potentialMarketImpact] ?? 1;
        if (impA !== impB) return impB - impA; // higher impact first
        return a.eventDate.localeCompare(b.eventDate); // earlier date first
      });

    let event: CatalystEvent | null = null;

    if (rankedEvents.length > 0) {
      // Use the best stored event (any type)
      event = companyEventToCatalystEvent(rankedEvents[0], ticker, company, screenedAt);
    } else {
      // Fallback: look for earnings in CM / Event Monitor
      const earningsDate = findNextEarningsDate(ticker, cmResult, now);
      if (earningsDate) {
        event = {
          ticker,
          company,
          eventType: "Earnings",
          eventDate: earningsDate.date,
          daysUntilEvent: earningsDate.daysUntil,
          reportingPeriod: inferReportingPeriod(earningsDate.date),
          marketTiming: "Unknown",
          source: earningsDate.source,
          sourceConfidence: earningsDate.confidence,
          classification: "Unknown",
        };
      }
      // If still null → PATH B eligible (event = null)
    }

    // ── Step 2: Price context ─────────────────────────────────────────────────
    const pc = getPriceContext(ticker);
    const daysForAsymmetry = event?.daysUntilEvent ?? 45;
    const priceAsymmetryFacts = pc
      ? buildPriceAsymmetryFacts(pc, daysForAsymmetry, DEFAULT_CATALYST_SCREENING_CONFIG)
      : null;
    const priceAsymmetry: PriceAsymmetry = priceAsymmetryFacts?.asymmetry ?? "Neutral";

    // ── Step 3: Load stored signals (for accumulation windows) ───────────────
    const storedSignals = getStoredSignals(ticker, 30); // last 30 days

    // ── Step 4: Assemble CatalystFacts ────────────────────────────────────────
    const facts = buildCatalystFacts({ ticker, event, storedSignals });

    // ── Step 5: Count relevant signals ────────────────────────────────────────
    const relevantSignalCount = facts.signals.filter(s => s.direction !== "Neutral").length;

    // ── Step 6: Deterministic screening ───────────────────────────────────────
    const screening = screenCatalystCandidate({
      ticker,
      company,
      daysUntilEvent: event?.daysUntilEvent ?? null,
      priceAsymmetry,
      investmentView: facts.company.investmentView,
      earningsGuidanceTrend: facts.company.earningsGuidanceTrend,
      relevantSignalCount,
      signals: facts.signals,
      hasPriceContext: !!pc,
      hasCompanyMonitor: !!cmResult,
      facts,
      config: DEFAULT_CATALYST_SCREENING_CONFIG,
      screenedAt,
    });

    // ── Step 7: Build and save state ──────────────────────────────────────────
    const existingState = getCatalystState(ticker);

    const state: CatalystState = {
      ticker,
      company,
      screening,
      // Store facts if event is present (PATH A) or if eligible for PATH B
      facts: (event || screening.eligible) ? facts : null,
      analysis: existingState?.analysis ?? null,
      lastAnalysisFingerprint: existingState?.lastAnalysisFingerprint ?? null,
      lastScreenedAt: screenedAt,
      lastAnalysedAt: existingState?.lastAnalysedAt ?? null,
      eventPassed: event ? event.daysUntilEvent < 0 : false,
      updatedAt: screenedAt,
      // Part 2 fields — preserve across screen runs
      // DiscoverySource: derive from company monitor + universe presence
      // (portfolio/OF flags are only on collectAllScreenableTickers(), not EquityUniverseEntry)
      discoverySource: existingState?.discoverySource ?? (
        cmResult ? "COMPANY_SIGNAL"
        : universeEntry ? "UNIVERSE_EVENT"
        : null
      ) as CatalystState["discoverySource"],
      triggerType: existingState?.triggerType ?? null,
      signalAccumulation: existingState?.signalAccumulation ?? null,
      emergingSetup: existingState?.emergingSetup ?? null,
      promotedAt: existingState?.promotedAt ?? null,
      lastAnalysisUpdateType: existingState?.lastAnalysisUpdateType ?? null,
    };

    saveCatalystState(ticker, state);

    return { ticker, state, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ticker, state: null, error: msg };
  }
}

// ── Proactive event discovery (cost-safe) ─────────────────────────────────────

/**
 * Proactively discover events for universe-seed tickers that:
 *   a) Are not yet in portfolio/OF/CM (pure universe candidates), AND
 *   b) Have no recent stored events, AND
 *   c) Haven't been discovered recently (shouldSkipDiscovery gate)
 *
 * Runs a maximum of MAX_PROACTIVE_DISCOVERIES AI calls per screen run.
 * Failures are silently swallowed — proactive discovery is best-effort.
 */
async function runProactiveEventDiscovery(
  allTickers: ReturnType<typeof collectAllScreenableTickers>,
  nowIso: string,
): Promise<{ discovered: number; skipped: number; candidates: string[] }> {
  // Only target pure universe-seed tickers (not already in watchlist sources)
  const candidates = allTickers.filter(t =>
    t.inUniverseSeed && !t.inPortfolio && !t.inOpportunityFinder && !t.inCompanyMonitor
  );

  const toDiscover = candidates.filter(t => !shouldSkipDiscovery(t.ticker, nowIso));
  const limited = toDiscover.slice(0, MAX_PROACTIVE_DISCOVERIES);

  let discovered = 0;
  for (const t of limited) {
    try {
      const result = await discoverEventsForTicker(t.ticker, t.company, false);
      if (!result.skipped && result.discovered > 0) discovered++;
    } catch {
      // Non-fatal
    }
  }

  return {
    discovered,
    skipped: toDiscover.length - limited.length,
    candidates: limited.map(t => t.ticker),
  };
}

// ── Endpoints ──────────────────────────────────────────────────────────────────

/**
 * POST /api/catalyst-intelligence/screen
 *
 * Runs deterministic screening for all universe tickers.
 * Uses collectAllScreenableTickers() which includes portfolio + OF + CM + universe seed.
 *
 * Also triggers:
 *   - Proactive event discovery for pure universe-seed tickers (cost-safe)
 *   - Background Saxo universe enrichment (non-blocking)
 *
 * Body: { tickers?: string[], skipDiscovery?: boolean }
 */
router.post("/catalyst-intelligence/screen", async (req, res): Promise<void> => {
  const now = new Date();
  const nowIso = now.toISOString();

  // Get all screenable tickers from the canonical universe function
  const allScreenable = collectAllScreenableTickers();

  let tickersToScreen: string[];
  if (Array.isArray(req.body?.tickers) && req.body.tickers.length > 0) {
    const requested = req.body.tickers.map((t: unknown) => String(t).trim().toUpperCase()).filter(Boolean);
    tickersToScreen = requested;
  } else {
    tickersToScreen = allScreenable.map(t => t.ticker);
  }

  if (tickersToScreen.length === 0) {
    res.status(200).json({
      ok: true,
      screened: [],
      skipped: [],
      message: "No tickers in universe. Add holdings to portfolio, run opportunity-finder, or check catalyst-universe.",
      _debug: { module: MODULE },
    });
    return;
  }

  // Proactive event discovery — async but awaited before screening to ensure events are available
  const skipDiscovery = req.body?.skipDiscovery === true;
  let discoveryStats = { discovered: 0, skipped: 0, candidates: [] as string[] };
  if (!skipDiscovery) {
    try {
      discoveryStats = await runProactiveEventDiscovery(allScreenable, nowIso);
    } catch {
      // Non-fatal — continue with screening
    }
  }

  // Background Saxo universe enrichment (fire-and-forget — uses cache so rarely makes API calls)
  const seedEntries = (await import("../lib/catalyst-universe.js")).getAllUniverseEntries();
  enrichUniverseWithSaxo(seedEntries).catch(() => { /* non-fatal */ });

  // Screen each ticker (synchronous — deterministic only)
  const screened: object[] = [];
  const skipped: string[] = [];
  const errors: Record<string, string> = {};

  for (const ticker of tickersToScreen) {
    const result = screenTicker(ticker, now);
    if (result.error) {
      errors[ticker] = result.error;
      skipped.push(ticker);
    } else if (result.state) {
      screened.push({
        ticker,
        company: result.state.company,
        eligible: result.state.screening?.eligible ?? false,
        screeningLevel: result.state.screening?.screeningLevel,
        daysUntilEvent: result.state.screening?.daysUntilEvent,
        eventType: result.state.facts?.event?.eventType ?? null,
        preliminaryState: result.state.screening?.preliminaryState,
        priceAsymmetry: result.state.screening?.priceAsymmetry,
        materialFingerprint: result.state.screening?.materialFingerprint,
        screeningReasons: result.state.screening?.screeningReasons ?? [],
        exclusionReason: result.state.screening?.exclusionReason ?? null,
        discoverySource: result.state.discoverySource,
      });
    }
  }

  const eligibleCount = (screened as Array<{ eligible: boolean }>).filter(s => s.eligible).length;

  // ── Part 3: Fire autonomous pipeline in background ──────────────────────────
  // Picks up DeepAnalysis-eligible candidates and runs deep analysis within
  // the per-cycle budget. Non-blocking — screen response returns immediately.
  const skipPipeline = req.body?.skipPipeline === true;
  if (!skipPipeline) {
    runCatalystPipeline(DEFAULT_CATALYST_BUDGET, nowIso).catch(pipelineErr => {
      console.error("[catalyst-intelligence] background pipeline error:", String(pipelineErr));
    });
  }

  res.status(200).json({
    ok: true,
    screened,
    skipped,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
    summary: {
      universeSize: allScreenable.length,
      total: tickersToScreen.length,
      eligible: eligibleCount,
      excluded: tickersToScreen.length - eligibleCount - skipped.length,
      skipped: skipped.length,
    },
    proactiveDiscovery: discoveryStats,
    pipeline: {
      fired: !skipPipeline,
      budget: DEFAULT_CATALYST_BUDGET,
      note: "Pipeline runs asynchronously. Check GET /api/catalyst-intelligence/pipeline for results.",
    },
    _debug: {
      module: MODULE,
      aiCalled: discoveryStats.discovered > 0,
      screenedAt: nowIso,
    },
  });
});

/**
 * POST /api/catalyst-intelligence/screen/:ticker
 * Screen a specific ticker.
 */
router.post("/catalyst-intelligence/screen/:ticker", (req, res) => {
  const ticker = req.params.ticker?.trim().toUpperCase();
  if (!ticker) return res.status(400).json({ ok: false, error: "Missing ticker" });

  const now = new Date();
  const result = screenTicker(ticker, now);

  if (result.error) {
    return res.status(500).json({ ok: false, ticker, error: result.error });
  }

  return res.status(200).json({
    ok: true,
    ticker,
    state: result.state,
    _debug: { module: MODULE, aiCalled: false, screenedAt: now.toISOString() },
  });
});

/**
 * GET /api/catalyst-intelligence/status
 */
router.get("/catalyst-intelligence/status", (_req, res) => {
  const allStates = getAllCatalystStates();

  const summary = allStates.map(s => ({
    ticker: s.ticker,
    company: s.company,
    eligible: s.screening?.eligible ?? false,
    screeningLevel: s.screening?.screeningLevel ?? "Excluded",
    daysUntilEvent: s.screening?.daysUntilEvent ?? null,
    eventType: s.facts?.event?.eventType ?? null,
    preliminaryState: s.screening?.preliminaryState ?? "NotInteresting",
    priceAsymmetry: s.screening?.priceAsymmetry ?? "Neutral",
    lastScreenedAt: s.lastScreenedAt,
    lastAnalysedAt: s.lastAnalysedAt,
    eventPassed: s.eventPassed,
    hasAnalysis: !!s.analysis,
    opportunityState: s.analysis?.opportunityState ?? null,
    discoverySource: s.discoverySource ?? null,
    triggerType: s.triggerType ?? null,
    promotedAt: s.promotedAt ?? null,
  }));

  return res.status(200).json({
    ok: true,
    tracked: allStates.length,
    eligible: summary.filter(s => s.eligible).length,
    withAnalysis: summary.filter(s => s.hasAnalysis).length,
    promoted: summary.filter(s => s.promotedAt).length,
    states: summary,
    _debug: { module: MODULE },
  });
});

/**
 * GET /api/catalyst-intelligence/pipeline
 *
 * Returns the last pipeline run result and a per-candidate debug summary
 * for the current eligible candidates. Use this to verify that:
 *   - how many candidates were screened/eligible/analyzed/deferred/skipped
 *   - which candidates were deep-analyzed this cycle
 *   - why any candidate was skipped or deferred
 *   - whether any promotions were produced
 */
router.get("/catalyst-intelligence/pipeline", (_req, res) => {
  const lastRun = getLastPipelineRun();
  const allStates = getAllCatalystStates();
  const nowIso = new Date().toISOString();

  // Per-candidate debug summary for all eligible candidates
  const { deriveLifecycleState: _derive, isEligibleForAutoAnalysis: _eligible } =
    require("../lib/catalyst-lifecycle.js") as typeof import("../lib/catalyst-lifecycle.js");

  const eligibleDebug = allStates
    .filter(s => s.screening?.eligible === true)
    .map(s => {
      const lifecycle = _derive(s, nowIso);
      const eligible = _eligible(s, nowIso);
      const ext = s as unknown as Record<string, unknown>;
      return {
        ticker: s.ticker,
        company: s.company,
        screeningLevel: s.screening?.screeningLevel ?? "Excluded",
        screeningState: s.screening?.preliminaryState ?? "NotInteresting",
        daysUntilEvent: s.facts?.event?.daysUntilEvent ?? s.screening?.daysUntilEvent ?? null,
        eventType: s.facts?.event?.eventType ?? null,
        lifecycleState: lifecycle,
        eligibleForAutoAnalysis: eligible,
        deepAnalysisCalled: !!s.lastAnalysedAt,
        hasAnalysis: !!s.analysis,
        opportunityState: s.analysis?.opportunityState ?? null,
        promotedAt: s.promotedAt ?? null,
        lastAnalysedAt: s.lastAnalysedAt,
        skipReason: (!eligible
          ? lifecycle === "DEFERRED" ? `Deferred until ${String(ext.deferredUntil ?? "?")}` : lifecycle
          : null),
        deferredUntil: ext.deferredUntil as string | null ?? null,
        failureCount: ext.failureCount as number ?? 0,
        lastError: ext.lastError as string | null ?? null,
      };
    })
    .sort((a, b) => {
      // Sort: analyzed first, then by days until event
      if (a.hasAnalysis !== b.hasAnalysis) return a.hasAnalysis ? -1 : 1;
      const da = a.daysUntilEvent ?? 999;
      const db = b.daysUntilEvent ?? 999;
      return da - db;
    });

  // Cycle summary
  const cycleStats = {
    screened: allStates.filter(s => s.lastScreenedAt).length,
    eligible: allStates.filter(s => s.screening?.eligible === true).length,
    deepAnalyzed: allStates.filter(s => s.lastAnalysedAt).length,
    withAnalysis: allStates.filter(s => !!s.analysis).length,
    promoted: allStates.filter(s => !!s.promotedAt).length,
    deferred: allStates.filter(s => {
      const ext = s as unknown as Record<string, unknown>;
      return ext.deferredUntil && new Date(String(ext.deferredUntil)).getTime() > Date.now();
    }).length,
    failed: allStates.filter(s => {
      const ext = s as unknown as Record<string, unknown>;
      const fc = ext.failureCount as number ?? 0;
      return fc >= 3;
    }).length,
  };

  return res.status(200).json({
    ok: true,
    lastPipelineRun: lastRun
      ? {
          startedAt: lastRun.startedAt,
          completedAt: lastRun.completedAt,
          candidatesConsidered: lastRun.candidatesConsidered,
          analyzed: lastRun.analyzed.length,
          deferred: lastRun.deferred.length,
          failed: lastRun.failed.length,
          newPromotions: lastRun.newPromotions,
          budgetUsed: lastRun.budgetUsed,
          budgetLimits: lastRun.budgetLimits,
          analyzedDetail: lastRun.analyzed,
          deferredDetail: lastRun.deferred,
          failedDetail: lastRun.failed,
        }
      : null,
    cycleStats,
    eligibleCandidates: eligibleDebug,
    _debug: { module: MODULE, generatedAt: nowIso },
  });
});

/**
 * GET /api/catalyst-intelligence/universe
 * Universe status + Saxo enrichment report (spec §13, Question 2).
 */
router.get("/catalyst-intelligence/universe", (_req, res) => {
  const { getAllUniverseEntries, getUniverseSize } = require("../lib/catalyst-universe.js");
  const universeEntries = getAllUniverseEntries();
  const sizes = getUniverseSize();
  const saxoStatus = getSaxoUniverseStatus();

  return res.status(200).json({
    ok: true,
    universe: {
      total: sizes.total,
      danish: sizes.danish,
      us: sizes.us,
      entries: universeEntries.map((e: ReturnType<typeof getAllUniverseEntries>[number]) => ({
        ticker: e.ticker,
        company: e.company,
        exchange: e.exchange,
        country: e.country,
        sector: e.sector,
        uic: e.uic,
        source: e.source,
        tradeable: e.tradeable,
      })),
    },
    saxoEnrichment: saxoStatus,
    _debug: { module: MODULE },
  });
});

/**
 * GET /api/catalyst-intelligence/debug/:ticker
 */
router.get("/catalyst-intelligence/debug/:ticker", (req, res) => {
  const ticker = req.params.ticker?.trim().toUpperCase();
  if (!ticker) return res.status(400).json({ ok: false, error: "Missing ticker" });

  const state = getCatalystState(ticker);

  if (!state) {
    return res.status(404).json({
      ok: false,
      ticker,
      error: `No catalyst state for ${ticker}. Run POST /api/catalyst-intelligence/screen/:ticker first.`,
    });
  }

  const storedSignals = getStoredSignals(ticker, 30);

  return res.status(200).json({
    ok: true,
    ticker,
    state,
    _debug: {
      module: MODULE,
      fingerprintFromScreening: state.screening?.materialFingerprint ?? null,
      factsAssembledAt: state.facts?.assembledAt ?? null,
      dataQuality: state.facts?.dataQuality ?? null,
      eventType: state.facts?.event?.eventType ?? null,
      signalCount: state.facts?.signals.length ?? 0,
      storedSignalCount: storedSignals.length,
      signalBreakdown: state.facts?.signals.map(s => ({
        signalId: s.signalId,
        driver: s.driver,
        direction: s.direction,
        source: s.source,
        sourceQuality: s.sourceQuality,
        freshness: s.freshness,
        informationCategory: s.informationCategory,
      })) ?? [],
    },
  });
});

/**
 * GET /api/catalyst-intelligence/facts/:ticker
 */
router.get("/catalyst-intelligence/facts/:ticker", (req, res) => {
  const ticker = req.params.ticker?.trim().toUpperCase();
  if (!ticker) return res.status(400).json({ ok: false, error: "Missing ticker" });

  const state = getCatalystState(ticker);

  if (!state?.facts) {
    return res.status(404).json({
      ok: false,
      ticker,
      error: `No catalyst facts for ${ticker}. Run screen first.`,
    });
  }

  return res.status(200).json({
    ok: true,
    ticker,
    facts: state.facts,
    _debug: { module: MODULE, assembledAt: state.facts.assembledAt },
  });
});

// ── Part 2: Deep AI Analysis ───────────────────────────────────────────────────

/**
 * POST /api/catalyst-intelligence/analyze/:ticker
 *
 * Full Part 2 pipeline for one ticker:
 *   1. Screen (if not screened yet)
 *   2. Build PATH B facts if no event found (null event)
 *   3. Compute signal accumulation with historical stored signals
 *   4. Detect emerging setup (PATH B check)
 *   5. Get/generate driver profile
 *   6. Driver-directed signal research (cost-safe, freshness-gated)
 *   7. Rebuild facts with all accumulated signals
 *   8. Deep AI analysis (fingerprint-skipped if unchanged)
 *   9. Promote to OF if qualified
 *
 * Body: { force?: boolean }
 */
router.post("/catalyst-intelligence/analyze/:ticker", async (req, res): Promise<void> => {
  const ticker = req.params.ticker?.trim().toUpperCase();
  if (!ticker) {
    res.status(400).json({ ok: false, error: "Missing ticker" });
    return;
  }

  const force = req.body?.force === true;
  const now = new Date();
  const nowIso = now.toISOString();

  try {
    // ── Step 1: Ensure screening is current ────────────────────────────────────
    let state = getCatalystState(ticker);
    if (!state || !state.lastScreenedAt) {
      const screenResult = screenTicker(ticker, now);
      if (screenResult.error || !screenResult.state) {
        res.status(500).json({ ok: false, ticker, error: screenResult.error ?? "Screening failed" });
        return;
      }
      state = screenResult.state;
    }

    const companyName = state.company;

    // ── Step 2: Build facts (PATH A or PATH B) ─────────────────────────────────
    // PATH A: event found during screening → state.facts is populated
    // PATH B: no event → state.facts may be null OR event may be null
    //         We still proceed with signal accumulation + emerging setup

    let facts = state.facts;

    if (!facts) {
      // No facts yet — build PATH B facts with null event
      // Include all stored signals for signal accumulation
      const storedSignals = getStoredSignals(ticker, 30);
      facts = buildCatalystFacts({ ticker, event: null, storedSignals });
    }

    // ── Step 3: Compute signal accumulation ────────────────────────────────────
    // Use all available signals (current facts + stored historical)
    const storedSignals = getStoredSignals(ticker, 30);
    const currentSignalIds = new Set(facts.signals.map(s => s.signalId));
    const allSignals = [
      ...facts.signals,
      ...storedSignals.filter(s => !currentSignalIds.has(s.signalId)),
    ];
    const prevSignalIds: string[] = []; // No prev IDs needed — accumulation tracks internally
    const signalAccumulation = computeSignalAccumulationState(ticker, allSignals, prevSignalIds);

    // ── Step 4: Detect emerging setup (PATH B) ─────────────────────────────────
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

    // Determine trigger type
    const triggerType: TriggerType = hasScheduledEvent
      ? (facts.event!.eventType === "Earnings" ? "EARNINGS" : "SCHEDULED_EVENT")
      : "EMERGING_SETUP";

    // ── Step 5: Eligibility check ──────────────────────────────────────────────
    const isEligible = state.screening?.eligible ?? false;
    const isDeepAnalysis = state.screening?.screeningLevel === "DeepAnalysis";
    const pathBEligible =
      triggerType === "EMERGING_SETUP" && emergingSetupWarrantsAnalysis(emergingSetup);

    const shouldAnalyze = isDeepAnalysis || pathBEligible;

    // ── Step 6: Driver profile ─────────────────────────────────────────────────
    let driverProfile = getDriverProfile(ticker) ?? null;
    if ((isDeepAnalysis || pathBEligible) && !driverProfile) {
      const universeEntry = getUniverseEntry(ticker);
      driverProfile = await getOrGenerateDriverProfile(
        ticker,
        companyName,
        universeEntry?.sector ?? facts.company.sector,
        universeEntry?.industry ?? facts.company.industry
      );
    }

    // ── Step 7: Driver-directed signal research ────────────────────────────────
    // Only runs if eligible and driver profile is available.
    // Cost-safe: isSignalResearchFresh() gate prevents re-runs within 24h.
    let researchResult = null;
    if (shouldAnalyze && driverProfile) {
      researchResult = await researchDriverSignals(
        ticker,
        companyName,
        driverProfile,
        facts.event?.daysUntilEvent ?? null,
        force
      );

      // Rebuild facts with all accumulated signals (current + historical + new research)
      if (researchResult.allStoredSignals.length > 0) {
        facts = buildCatalystFacts({
          ticker,
          event: facts.event,
          storedSignals: researchResult.allStoredSignals,
        });
      }
    }

    // ── Step 8: Deep AI analysis ───────────────────────────────────────────────
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

    // ── Step 9: Update state ───────────────────────────────────────────────────
    const updatedState: CatalystState = {
      ...state,
      facts,
      signalAccumulation,
      emergingSetup: triggerType === "EMERGING_SETUP" ? emergingSetup : null,
      triggerType,
      analysis: analysisOutput?.result ?? state.analysis,
      lastAnalysisFingerprint: analysisOutput?.fingerprint ?? state.lastAnalysisFingerprint,
      lastAnalysedAt:
        analysisOutput && !analysisOutput.skipped ? nowIso : state.lastAnalysedAt,
      lastAnalysisUpdateType:
        analysisOutput?.result?.analysisUpdateType ?? state.lastAnalysisUpdateType,
      updatedAt: nowIso,
    };

    // ── Step 10: Promote to OF if qualified ────────────────────────────────────
    let promoted = false;
    if (analysisOutput?.result && qualifiesForPromotion(analysisOutput.result) && !state.promotedAt) {
      promoteToOpportunityFinder(ticker, companyName, analysisOutput.result, facts);
      updatedState.promotedAt = nowIso;
      promoted = true;
    }

    saveCatalystState(ticker, updatedState);

    res.status(200).json({
      ok: true,
      ticker,
      company: companyName,
      triggerType,
      pathType: hasScheduledEvent ? "PATH_A" : "PATH_B",
      analysisUpdateType: updatedState.lastAnalysisUpdateType,
      opportunityState: updatedState.analysis?.opportunityState ?? null,
      catalystDirection: updatedState.analysis?.catalystDirection ?? null,
      thesis: updatedState.analysis?.thesis ?? null,
      promoted,
      signalAccumulation: {
        window14D: signalAccumulation.window14D,
        momentum: signalAccumulation.signalMomentum,
        direction: signalAccumulation.overallDirection,
        evidenceConfidence: signalAccumulation.evidenceConfidence,
      },
      emergingSetup: triggerType === "EMERGING_SETUP"
        ? {
            state: emergingSetup.state,
            reasons: emergingSetup.reasons.slice(0, 3),
            keyDrivers: emergingSetup.keyDrivers,
            warrantsAnalysis: pathBEligible,
          }
        : null,
      event: facts.event
        ? {
            eventType: facts.event.eventType,
            eventDate: facts.event.eventDate,
            daysUntilEvent: facts.event.daysUntilEvent,
            source: facts.event.source,
          }
        : null,
      _debug: {
        module: MODULE,
        aiCalled,
        skipped: analysisOutput?.skipped ?? true,
        skipReason: analysisOutput?.skipReason ?? (shouldAnalyze ? null : "Not eligible for deep analysis"),
        tokensUsed: analysisOutput?.tokensUsed ?? 0,
        driverProfileAvailable: !!driverProfile,
        signalCount: facts.signals.length,
        storedSignalCount: storedSignals.length,
        newResearchSignals: researchResult?.newSignals.length ?? 0,
        researchSkipped: researchResult?.skipped ?? true,
        screeningLevel: state.screening?.screeningLevel ?? "Unknown",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[catalyst-intelligence] analyze error for ${ticker}:`, msg);
    // Record failure with backoff so pipeline respects it next cycle
    recordCatalystFailure(ticker, msg, nowIso);
    res.status(500).json({ ok: false, ticker, error: msg });
  }
});

/**
 * POST /api/catalyst-intelligence/driver-profile/:ticker
 * Generate or refresh the Company Driver Profile.
 * Body: { force?: boolean }
 */
router.post("/catalyst-intelligence/driver-profile/:ticker", async (req, res): Promise<void> => {
  const ticker = req.params.ticker?.trim().toUpperCase();
  if (!ticker) {
    res.status(400).json({ ok: false, error: "Missing ticker" });
    return;
  }

  const force = req.body?.force === true;

  try {
    const state = getCatalystState(ticker);
    const company = state?.company ?? ticker;
    const facts = state?.facts;
    const universeEntry = getUniverseEntry(ticker);

    const profile = await getOrGenerateDriverProfile(
      ticker,
      company,
      universeEntry?.sector ?? facts?.company.sector ?? null,
      universeEntry?.industry ?? facts?.company.industry ?? null,
      force
    );

    if (!profile) {
      res.status(500).json({ ok: false, ticker, error: "Driver profile generation failed" });
      return;
    }

    res.status(200).json({
      ok: true,
      ticker,
      company,
      profile,
      _debug: { module: MODULE, aiCalled: true },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, ticker, error: msg });
  }
});

/**
 * GET /api/catalyst-intelligence/promotions
 */
router.get("/catalyst-intelligence/promotions", (_req, res) => {
  const active = getActivePromotions();
  const contextBlock = buildPromotionsContextBlock();

  res.status(200).json({
    ok: true,
    count: active.length,
    promotions: active,
    contextBlock,
    _debug: { module: MODULE },
  });
});

/**
 * GET /api/catalyst-intelligence/pipeline
 *
 * Returns the result of the last autonomous pipeline run.
 * Shows: analyzed, deferred, failed counts, budget usage, promotions.
 */
router.get("/catalyst-intelligence/pipeline", (_req, res) => {
  const lastRun = getLastPipelineRun();

  res.status(200).json({
    ok: true,
    lastRun,
    budget: DEFAULT_CATALYST_BUDGET,
    _debug: { module: MODULE },
  });
});

/**
 * POST /api/catalyst-intelligence/post-event/:ticker
 *
 * Trigger post-event reassessment for a ticker whose catalyst has passed.
 * Clears the pre-event thesis and forces a fresh analysis.
 *
 * Per spec §7: "The event should trigger … Catalyst refresh … new post-event assessment."
 */
router.post("/catalyst-intelligence/post-event/:ticker", async (req, res): Promise<void> => {
  const ticker = req.params.ticker?.trim().toUpperCase();
  if (!ticker) {
    res.status(400).json({ ok: false, error: "Missing ticker" });
    return;
  }

  const nowIso = new Date().toISOString();
  const result = await runPostEventReassessment(ticker, nowIso);

  res.status(result.ok ? 200 : 400).json({
    ok: result.ok,
    ticker,
    error: result.error ?? null,
    _debug: { module: MODULE },
  });
});

/**
 * GET /api/catalyst-intelligence/status
 *
 * Returns all tracked tickers with their current lifecycle state and key metrics.
 * Replaces the old status endpoint with lifecycle-aware output (Part 3).
 *
 * Sections:
 *   - upcomingCatalysts: PATH A candidates with events in the window
 *   - emergingSetups: PATH B candidates (no event, signal accumulation)
 *   - recentlyPromoted: candidates promoted to OF in the last 7 days
 *   - deferred: candidates over budget this cycle
 *   - failed: candidates in error/backoff state
 */
router.get("/catalyst-intelligence/status", (_req, res) => {
  const all = getAllCatalystStates();
  const nowIso = new Date().toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();

  type StateRow = {
    ticker: string;
    company: string;
    lifecycleState: string;
    opportunityState: string | null;
    eventType: string | null;
    daysUntilEvent: number | null;
    priceAsymmetry: string | null;
    evidenceConfidence: string | null;
    promotedAt: string | null;
    lastAnalysedAt: string | null;
    lastError: string | null;
    failureCount: number;
    deferredUntil: string | null;
    postEventAssessmentRequired: boolean;
  };

  const rows: StateRow[] = all.map(state => ({
    ticker: state.ticker,
    company: state.company,
    lifecycleState: deriveLifecycleState(state),
    opportunityState: state.analysis?.opportunityState ?? null,
    eventType: state.facts?.event?.eventType ?? null,
    daysUntilEvent: state.facts?.event?.daysUntilEvent ?? state.screening?.daysUntilEvent ?? null,
    priceAsymmetry: state.screening?.priceAsymmetry ?? null,
    evidenceConfidence: state.signalAccumulation?.evidenceConfidence ?? null,
    promotedAt: state.promotedAt ?? null,
    lastAnalysedAt: state.lastAnalysedAt ?? null,
    lastError: state.lastError ?? null,
    failureCount: state.failureCount ?? 0,
    deferredUntil: state.deferredUntil ?? null,
    postEventAssessmentRequired: state.postEventAssessmentRequired ?? false,
  }));

  const upcomingCatalysts = rows.filter(r =>
    r.daysUntilEvent !== null && r.daysUntilEvent >= 0 &&
    !["SCREENED_OUT", "FAILED"].includes(r.lifecycleState)
  ).sort((a, b) => (a.daysUntilEvent ?? 999) - (b.daysUntilEvent ?? 999));

  const emergingSetups = rows.filter(r =>
    r.daysUntilEvent === null && r.lifecycleState !== "SCREENED_OUT" && r.lifecycleState !== "FAILED"
  );

  const recentlyPromoted = rows.filter(r =>
    r.promotedAt && r.promotedAt >= sevenDaysAgo
  ).sort((a, b) => (b.promotedAt ?? "").localeCompare(a.promotedAt ?? ""));

  const deferred = rows.filter(r =>
    r.deferredUntil && r.deferredUntil > nowIso
  );

  const failed = rows.filter(r => r.lifecycleState === "FAILED" || r.failureCount > 0);

  const stale = rows.filter(r => r.postEventAssessmentRequired);

  res.status(200).json({
    ok: true,
    upcomingCatalysts,
    emergingSetups,
    recentlyPromoted,
    deferred,
    failed,
    stale,
    counts: {
      total: rows.length,
      upcomingCatalysts: upcomingCatalysts.length,
      emergingSetups: emergingSetups.length,
      recentlyPromoted: recentlyPromoted.length,
      deferred: deferred.length,
      failed: failed.length,
      stale: stale.length,
    },
    _debug: { module: MODULE, generatedAt: nowIso },
  });
});

export default router;
