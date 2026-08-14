/**
 * Catalyst Intelligence Route — Part 1 (Deterministic Skeleton)
 *
 * Endpoints:
 *   POST /api/catalyst-intelligence/screen      — run deterministic screening
 *   POST /api/catalyst-intelligence/screen/:ticker — screen a specific ticker
 *   GET  /api/catalyst-intelligence/status      — all tracked tickers' states
 *   GET  /api/catalyst-intelligence/debug/:ticker — full debug dump
 *   GET  /api/catalyst-intelligence/facts/:ticker  — assembled CatalystFacts
 *
 * Part 1 = NO AI calls. Only deterministic screening + facts assembly.
 * Part 2 will add the deep OpenAI analysis on top of this skeleton.
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
  CatalystEvent, CatalystState, PriceAsymmetry,
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

    const state: CatalystState = {
      ticker,
      company,
      screening,
      facts: event ? facts : null,
      analysis: null,
      lastAnalysisFingerprint: null,
      lastScreenedAt: screenedAt,
      lastAnalysedAt: null,
      eventPassed: !earningsDate || earningsDate.daysUntil < 0,
      updatedAt: screenedAt,
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

export default router;
