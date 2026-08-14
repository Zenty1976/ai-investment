/**
 * Catalyst Intelligence Route — Part 2 (AI Analysis + Signal Accumulation)
 *
 * Endpoints:
 *   POST /api/catalyst-intelligence/screen            — run deterministic screening
 *   POST /api/catalyst-intelligence/screen/:ticker    — screen a specific ticker
 *   POST /api/catalyst-intelligence/analyze/:ticker   — deep AI analysis for a ticker
 *   POST /api/catalyst-intelligence/driver-profile/:ticker — generate/refresh driver profile
 *   GET  /api/catalyst-intelligence/status            — all tracked tickers' states
 *   GET  /api/catalyst-intelligence/promotions        — active OF promotions
 *   GET  /api/catalyst-intelligence/debug/:ticker     — full debug dump
 *   GET  /api/catalyst-intelligence/facts/:ticker     — assembled CatalystFacts
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
import {
  getOrGenerateDriverProfile, getDriverProfile,
} from "../lib/catalyst-driver-profile.js";
import {
  computeSignalAccumulationState,
} from "../lib/catalyst-signal-accumulation.js";
import {
  detectEmergingSetup, emergingSetupWarrantsAnalysis,
} from "../lib/catalyst-emerging-setup.js";
import {
  runCatalystAnalysis, qualifiesForPromotion,
} from "../lib/catalyst-analysis.js";
import {
  promoteToOpportunityFinder, getActivePromotions, buildPromotionsContextBlock,
} from "../lib/catalyst-promotion.js";
import type {
  CatalystEvent, CatalystState, PriceAsymmetry, TriggerType,
} from "../lib/catalyst-types.js";

const router = Router();
const MODULE = "catalyst-intelligence";

// ── Event detection ────────────────────────────────────────────────────────────

interface EarningsDate {
  date: string;
  daysUntil: number;
  source: "CompanyMonitor" | "EventMonitor";
  confidence: "High" | "Medium" | "Low";
}

function findNextEarningsDate(
  ticker: string,
  cmResult: Record<string, unknown> | undefined,
  today: Date
): EarningsDate | null {
  const todayMs = today.getTime();

  // ── Source 1: Company Monitor nextKnownEventDate (primary) ────────────────
  const eg = cmResult?.earningsAndGuidance as Record<string, unknown> | undefined;
  const cmDate = String(eg?.nextKnownEventDate ?? "").trim();

  if (cmDate && /^\d{4}-\d{2}-\d{2}$/.test(cmDate)) {
    const eventMs = new Date(cmDate + "T00:00:00Z").getTime();
    const daysUntil = Math.round((eventMs - todayMs) / 86_400_000);
    if (daysUntil >= 0) {
      return { date: cmDate, daysUntil, source: "CompanyMonitor", confidence: "High" };
    }
  }

  // ── Source 2: Event Monitor — scan for earnings events matching ticker ─────
  const eiState = analysisRepository.get<{
    events: Array<{
      id: string; title: string; date: string; status: string;
      category: string; affectedMarkets?: string[];
    }>
  }>("event-intelligence");

  if (eiState?.result?.events) {
    const companyBase = ticker.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 5);
    for (const ev of eiState.result.events) {
      if (ev.status === "passed") continue;
      const titleUpper = ev.title.toUpperCase();
      // Match on ticker fragment or earnings-related keywords
      const mentionsTicker = titleUpper.includes(companyBase) ||
        titleUpper.includes(ticker.toUpperCase());
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

// ── Derive reporting period from event date ────────────────────────────────────

function inferReportingPeriod(eventDate: string): string | null {
  const d = new Date(eventDate + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  const month = d.getUTCMonth() + 1; // 1-indexed
  // Rough heuristic: reports roughly 4-6 weeks after quarter end
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

function screenTicker(ticker: string, now: Date): ScreenTickerResult {
  const screenedAt = now.toISOString();

  try {
    // Get Company Monitor entry
    const cmEntry = analysisRepository.get<Record<string, unknown>>(
      `company-monitor:${ticker.toUpperCase()}`
    );
    const cmResult = cmEntry?.result;
    const company = String(
      (cmResult?.company as Record<string, unknown> | undefined)?.name ?? ticker
    ).trim() || ticker;

    // Find upcoming event
    const earningsDate = findNextEarningsDate(ticker, cmResult, now);

    // Get price context
    const pc = getPriceContext(ticker);
    const priceAsymmetryFacts = pc && earningsDate
      ? buildPriceAsymmetryFacts(pc, earningsDate.daysUntil, DEFAULT_CATALYST_SCREENING_CONFIG)
      : null;

    const priceAsymmetry: PriceAsymmetry = priceAsymmetryFacts?.asymmetry ?? "Neutral";

    // Build event object for facts assembly
    const event: CatalystEvent | null = earningsDate
      ? {
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
        }
      : null;

    // Assemble CatalystFacts (needed for fingerprint even when screening excludes)
    const facts = event
      ? buildCatalystFacts({ ticker, event })
      : buildCatalystFacts({
          ticker,
          event: {
            ticker, company,
            eventType: "Earnings",
            eventDate: "",
            daysUntilEvent: 999,
            reportingPeriod: null,
            marketTiming: "Unknown",
            source: "CompanyMonitor",
            sourceConfidence: "Low",
            classification: "Unknown",
          },
        });

    // Count relevant (non-neutral) signals
    const relevantSignalCount = facts.signals.filter(s => s.direction !== "Neutral").length;

    // Run deterministic screening
    const screening = screenCatalystCandidate({
      ticker,
      company,
      daysUntilEvent: earningsDate?.daysUntil ?? null,
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

    // Preserve existing Part 2 state fields when overwriting screening
    const existingState = getCatalystState(ticker);

    const state: CatalystState = {
      ticker,
      company,
      screening,
      facts: event ? facts : null,
      analysis: existingState?.analysis ?? null,
      lastAnalysisFingerprint: existingState?.lastAnalysisFingerprint ?? null,
      lastScreenedAt: screenedAt,
      lastAnalysedAt: existingState?.lastAnalysedAt ?? null,
      eventPassed: !earningsDate || earningsDate.daysUntil < 0,
      updatedAt: screenedAt,
      // Part 2 fields
      discoverySource: existingState?.discoverySource ?? null,
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

// ── Collect tickers to screen ──────────────────────────────────────────────────

function collectScreenableTickers(): string[] {
  const tickers = new Set<string>();

  // From portfolio manager
  const pmEntry = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  const positions = (pmEntry?.result as Record<string, unknown> | undefined)?.positions;
  if (Array.isArray(positions)) {
    for (const pos of positions) {
      const sym = String((pos as Record<string, unknown>)["symbol"] ?? "").trim();
      if (sym) tickers.add(sym.toUpperCase());
    }
  }

  // From opportunity finder
  const ofEntry = analysisRepository.get<Record<string, unknown>>("opportunity-finder");
  const candidates = (ofEntry?.result as Record<string, unknown> | undefined)?.candidates;
  if (Array.isArray(candidates)) {
    for (const c of candidates) {
      const sym = String((c as Record<string, unknown>)["ticker"] ?? "").trim();
      if (sym) tickers.add(sym.toUpperCase());
    }
  }

  // From existing company-monitor entries
  const allEntries = analysisRepository.getAll();
  for (const entry of allEntries) {
    if (entry.moduleName.startsWith("company-monitor:")) {
      const sym = entry.moduleName.replace("company-monitor:", "").toUpperCase();
      if (sym) tickers.add(sym);
    }
  }

  return [...tickers];
}

// ── Endpoints ──────────────────────────────────────────────────────────────────

/**
 * POST /api/catalyst-intelligence/screen
 * Runs deterministic screening for all known tickers.
 * Body: { tickers?: string[] } — if provided, screen only those tickers.
 */
router.post("/catalyst-intelligence/screen", (req, res) => {
  const requestedTickers: string[] = Array.isArray(req.body?.tickers)
    ? req.body.tickers.map((t: unknown) => String(t).trim().toUpperCase()).filter(Boolean)
    : collectScreenableTickers();

  if (requestedTickers.length === 0) {
    return res.status(200).json({
      ok: true,
      screened: [],
      skipped: [],
      message: "No tickers found to screen. Run portfolio-manager or opportunity-finder first.",
      _debug: { module: MODULE },
    });
  }

  const now = new Date();
  const screened: object[] = [];
  const skipped: string[] = [];
  const errors: Record<string, string> = {};

  for (const ticker of requestedTickers) {
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
        preliminaryState: result.state.screening?.preliminaryState,
        priceAsymmetry: result.state.screening?.priceAsymmetry,
        materialFingerprint: result.state.screening?.materialFingerprint,
        screeningReasons: result.state.screening?.screeningReasons ?? [],
        exclusionReason: result.state.screening?.exclusionReason ?? null,
      });
    }
  }

  const eligibleCount = (screened as Array<{ eligible: boolean }>).filter(s => s.eligible).length;

  return res.status(200).json({
    ok: true,
    screened,
    skipped,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
    summary: {
      total: requestedTickers.length,
      eligible: eligibleCount,
      excluded: requestedTickers.length - eligibleCount - skipped.length,
      skipped: skipped.length,
    },
    _debug: { module: MODULE, aiCalled: false, screenedAt: now.toISOString() },
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
 * Returns current catalyst state for all tracked tickers.
 */
router.get("/catalyst-intelligence/status", (_req, res) => {
  const allStates = getAllCatalystStates();

  const summary = allStates.map(s => ({
    ticker: s.ticker,
    company: s.company,
    eligible: s.screening?.eligible ?? false,
    screeningLevel: s.screening?.screeningLevel ?? "Excluded",
    daysUntilEvent: s.screening?.daysUntilEvent ?? null,
    preliminaryState: s.screening?.preliminaryState ?? "NotInteresting",
    priceAsymmetry: s.screening?.priceAsymmetry ?? "Neutral",
    lastScreenedAt: s.lastScreenedAt,
    lastAnalysedAt: s.lastAnalysedAt,
    eventPassed: s.eventPassed,
    hasAnalysis: !!s.analysis,
  }));

  return res.status(200).json({
    ok: true,
    tracked: allStates.length,
    eligible: summary.filter(s => s.eligible).length,
    states: summary,
    _debug: { module: MODULE },
  });
});

/**
 * GET /api/catalyst-intelligence/debug/:ticker
 * Full debug dump including screening result, facts, and fingerprint.
 */
router.get("/catalyst-intelligence/debug/:ticker", (req, res) => {
  const ticker = req.params.ticker?.trim().toUpperCase();
  if (!ticker) return res.status(400).json({ ok: false, error: "Missing ticker" });

  const state = getCatalystState(ticker);

  if (!state) {
    return res.status(404).json({
      ok: false,
      ticker,
      error: `No catalyst state found for ${ticker}. Run POST /api/catalyst-intelligence/screen/:ticker first.`,
    });
  }

  return res.status(200).json({
    ok: true,
    ticker,
    state,
    _debug: {
      module: MODULE,
      fingerprintFromScreening: state.screening?.materialFingerprint ?? null,
      factsAssembledAt: state.facts?.assembledAt ?? null,
      dataQuality: state.facts?.dataQuality ?? null,
      signalCount: state.facts?.signals.length ?? 0,
      signalBreakdown: state.facts?.signals.map(s => ({
        signalId: s.signalId,
        driver: s.driver,
        direction: s.direction,
        source: s.source,
        sourceQuality: s.sourceQuality,
        freshness: s.freshness,
      })) ?? [],
    },
  });
});

/**
 * GET /api/catalyst-intelligence/facts/:ticker
 * Returns the assembled CatalystFacts for inspection/debugging.
 * Useful for verifying what will be sent to the Part 2 AI analysis.
 */
router.get("/catalyst-intelligence/facts/:ticker", (req, res) => {
  const ticker = req.params.ticker?.trim().toUpperCase();
  if (!ticker) return res.status(400).json({ ok: false, error: "Missing ticker" });

  const state = getCatalystState(ticker);

  if (!state?.facts) {
    return res.status(404).json({
      ok: false,
      ticker,
      error: `No catalyst facts found for ${ticker}. Run screen first.`,
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
 * Runs the full Part 2 Catalyst Intelligence pipeline for a single ticker:
 *   1. Screen (if not already screened)
 *   2. Compute signal accumulation (deterministic)
 *   3. Detect emerging setup (PATH B, if no scheduled event)
 *   4. Get or generate driver profile (cached, expensive)
 *   5. Run deep AI analysis (fingerprint-skipped if no material change)
 *   6. Promote to Opportunity Finder if qualified
 *
 * Body: { force?: boolean } — if true, re-runs even if fingerprint unchanged
 */
router.post("/catalyst-intelligence/analyze/:ticker", async (req, res): Promise<void> => {
  const ticker = req.params.ticker?.trim().toUpperCase();
  if (!ticker) {
    res.status(400).json({ ok: false, error: "Missing ticker" });
    return;
  }

  const force = req.body?.force === true;
  const now = new Date();

  try {
    // ── Step 1: Ensure screening is current ─────────────────────────────────
    let state = getCatalystState(ticker);
    if (!state || !state.lastScreenedAt) {
      const screenResult = screenTicker(ticker, now);
      if (screenResult.error || !screenResult.state) {
        res.status(500).json({ ok: false, ticker, error: screenResult.error ?? "Screening failed" });
        return;
      }
      state = screenResult.state;
    }

    if (!state.facts) {
      res.status(200).json({
        ok: true, ticker,
        skipped: true,
        skipReason: "No upcoming event found — no facts to analyze",
        state: null,
        _debug: { module: MODULE, aiCalled: false },
      });
      return;
    }

    const facts = state.facts;
    const companyName = state.company;

    // ── Step 2: Compute signal accumulation ──────────────────────────────────
    const prevSignalIds = state.signalAccumulation
      ? [...(state.signalAccumulation.window14D ? [] : [])]
      : [];
    const signalAccumulation = computeSignalAccumulationState(ticker, facts.signals, prevSignalIds);

    // ── Step 3: Emerging setup (PATH B — only if no scheduled event) ─────────
    const hasScheduledEvent = !!facts.event.eventDate;
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
      ? (facts.event.eventType === "Earnings" ? "EARNINGS" : "SCHEDULED_EVENT")
      : "EMERGING_SETUP";

    // ── Step 4: Driver profile ───────────────────────────────────────────────
    // Generate driver profile if eligible and not fresh
    const isEligible = state.screening?.eligible ?? false;
    const isDeepAnalysis = state.screening?.screeningLevel === "DeepAnalysis";
    const pathBEligible = triggerType === "EMERGING_SETUP" && emergingSetupWarrantsAnalysis(emergingSetup);

    let driverProfile = getDriverProfile(ticker) ?? null;
    if ((isDeepAnalysis || pathBEligible) && !driverProfile && companyName) {
      const universeEntry = (await import("../lib/catalyst-universe.js")).getUniverseEntry(ticker);
      driverProfile = await getOrGenerateDriverProfile(
        ticker, companyName,
        universeEntry?.sector ?? facts.company.sector,
        universeEntry?.industry ?? facts.company.industry
      );
    }

    // ── Step 5: Deep AI analysis ─────────────────────────────────────────────
    let analysisOutput = null;
    let aiCalled = false;

    const shouldAnalyze = isDeepAnalysis || pathBEligible;

    if (shouldAnalyze) {
      const analysisInput = {
        facts,
        triggerType,
        eventId: null,
        driverProfile,
        lastFingerprint: force ? null : (state.lastAnalysisFingerprint ?? null),
        retryNumber: 0,
      };

      analysisOutput = await runCatalystAnalysis(analysisInput);
      if (analysisOutput && !analysisOutput.skipped) {
        aiCalled = true;
      }
    }

    // ── Step 6: Update state ─────────────────────────────────────────────────
    const updatedState: CatalystState = {
      ...state,
      signalAccumulation,
      emergingSetup: hasScheduledEvent ? null : emergingSetup,
      triggerType,
      analysis: analysisOutput?.result ?? state.analysis,
      lastAnalysisFingerprint: analysisOutput?.fingerprint ?? state.lastAnalysisFingerprint,
      lastAnalysedAt: analysisOutput && !analysisOutput.skipped ? now.toISOString() : state.lastAnalysedAt,
      lastAnalysisUpdateType: analysisOutput?.result?.analysisUpdateType ?? state.lastAnalysisUpdateType,
      updatedAt: now.toISOString(),
    };

    // ── Step 7: Promote to OF if qualified ───────────────────────────────────
    let promoted = false;
    if (analysisOutput?.result && qualifiesForPromotion(analysisOutput.result) && !state.promotedAt) {
      promoteToOpportunityFinder(ticker, companyName, analysisOutput.result, facts);
      updatedState.promotedAt = now.toISOString();
      promoted = true;
    }

    saveCatalystState(ticker, updatedState);

    res.status(200).json({
      ok: true,
      ticker,
      company: companyName,
      triggerType,
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
      emergingSetup: triggerType === "EMERGING_SETUP" ? {
        state: emergingSetup.state,
        reasons: emergingSetup.reasons.slice(0, 3),
        keyDrivers: emergingSetup.keyDrivers,
      } : null,
      _debug: {
        module: MODULE,
        aiCalled,
        skipped: analysisOutput?.skipped ?? true,
        skipReason: analysisOutput?.skipReason ?? (shouldAnalyze ? null : "Not eligible for deep analysis"),
        tokensUsed: analysisOutput?.tokensUsed ?? 0,
        driverProfileAvailable: !!driverProfile,
        signalCount: facts.signals.length,
        screeningLevel: state.screening?.screeningLevel ?? "Unknown",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[catalyst-intelligence] analyze error for ${ticker}:`, msg);
    res.status(500).json({ ok: false, ticker, error: msg });
  }
});

/**
 * POST /api/catalyst-intelligence/driver-profile/:ticker
 * Force-generates or refreshes the Company Driver Profile.
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

    const { getUniverseEntry } = await import("../lib/catalyst-universe.js");
    const universeEntry = getUniverseEntry(ticker);

    const profile = await getOrGenerateDriverProfile(
      ticker, company,
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
 * Returns all active Catalyst → Opportunity Finder promotions.
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

export default router;
