/**
 * Portfolio Facts — shared types and pure deterministic fingerprint function.
 *
 * Kept separate from portfolio-intelligence-engine.ts so the fingerprint
 * logic can be imported and unit-tested without pulling in the engine's
 * dependency chain (price-context-service → saxo-store → pino logger).
 *
 * Import this file for types and fingerprinting.
 * Import portfolio-intelligence-engine.ts for computePortfolioFacts().
 */
import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Performance and contribution for a single held position. */
export interface HoldingPerformance {
  ticker: string;
  /** % of invested capital (position's share of total invested, excl. cash) */
  investedWeightPct: number;
  /** 1-day price return in % (null if PriceContext unavailable or field absent) */
  return1D: number | null;
  /** 5-day price return in % */
  return5D: number | null;
  /** 30-day price return in % */
  return1M: number | null;
  /**
   * Portfolio contribution from 1D return: (investedWeightPct / 100) × return1D.
   * null when return1D is null.
   */
  contribution1DPct: number | null;
}

export interface PortfolioPerformanceFacts {
  /** All held positions with individual returns and contributions. */
  perHolding: HoldingPerformance[];
  /** Top contributors sorted by contribution1DPct descending (positive only). */
  topContributors: HoldingPerformance[];
  /** Top detractors sorted by contribution1DPct ascending (negative only). */
  topDetractors: HoldingPerformance[];
  /** Weighted average 1-day return across positions with available data. null if no data. */
  portfolioReturn1D: number | null;
  /** Weighted average 5-day return. null if insufficient data. */
  portfolioReturn5D: number | null;
  /** Weighted average 30-day return. null if insufficient data. */
  portfolioReturn1M: number | null;
}

export interface CompanyStateFacts {
  /** Tickers where at least one thesis point has status = "Strengthened". */
  strengthenedHoldings: string[];
  /** Tickers where at least one thesis point has status = "Weakened". */
  weakenedHoldings: string[];
  /** Tickers where at least one thesis point has status = "Invalidated". */
  invalidatedHoldings: string[];
  /** Holdings with investmentCaseStrength < 40. */
  lowCaseStrength: Array<{ ticker: string; strength: number }>;
  /** investmentView.rating distribution across holdings. */
  viewDistribution: Record<string, number>;
  /** Holdings rated Avoid or Strong Avoid. */
  avoidViewHoldings: Array<{ ticker: string; view: string }>;
}

/** Snapshot of a held position's categorical price state (from PriceContext). */
export interface PortfolioPriceStateSnapshot {
  priceState: string;
  volatilityState: string;
  recentBehaviorState: string | null;
}

export interface PortfolioPriceBehaviorFacts {
  strongUptrendPct: number;
  strongUptrendHoldings: string[];
  strongDowntrendPct: number;
  strongDowntrendHoldings: string[];
  highVolatilityPct: number;
  highVolatilityHoldings: string[];
  fallingFastHoldings: string[];
  risingHoldings: string[];
  stabilizingFromDowntrendHoldings: string[];
  /** Full categorical state per held position — used by fingerprint to detect any regime shift. */
  perPositionState: Record<string, PortfolioPriceStateSnapshot>;
}

export interface PortfolioUpcomingEvent {
  title: string;
  date: string;
  importance: string;
  affectedHoldings: string[];
}

/** Complete deterministic portfolio fact set. All quantities are computed in backend. */
export interface PortfolioFacts {
  portfolio: {
    totalValue: number | null;
    cashPct: number;
    holdingCount: number;
    baseCurrency: string;
  };
  performance: PortfolioPerformanceFacts;
  allocation: {
    topPositions: Array<{ ticker: string; investedWeightPct: number; sector: string }>;
    sectorExposure: Array<{ name: string; pct: number }>;
    currencyExposure: Array<{ currency: string; pct: number }>;
    largestPositionTicker: string | null;
    largestPositionPct: number;
    top3Pct: number;
    top3Tickers: string[];
  };
  priceBehavior: PortfolioPriceBehaviorFacts;
  companyState: CompanyStateFacts;
  events: {
    upcomingHoldingEvents: PortfolioUpcomingEvent[];
  };
  /** Plain-language notable facts for prompt grounding. */
  notableFacts: string[];
}

export interface PortfolioIntelligenceResult {
  portfolioFacts: PortfolioFacts;
  fingerprint: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function bandN(n: number, size: number): number {
  return Math.round(n / size) * size;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce a deterministic fingerprint of material PortfolioFacts.
 *
 * Changes when a meaningful portfolio condition changes:
 *  - Portfolio composition (any holding added/removed)
 *  - Any position's priceState, volatilityState, or recentBehavior
 *  - Significant allocation shift (>2% band for individual positions)
 *  - Sector or currency exposure crossing a 5% band
 *  - Thesis status change (strengthened / weakened / invalidated)
 *  - Company view rating change
 *  - Event entering/leaving the 7-day window
 *  - Market or sector material version bump (regime change)
 *  - Material performance movement (portfolio 1D return crossing 3% band,
 *    5D return crossing 5% band)
 *
 * Does NOT change for: timestamps, tiny price fluctuations within a band,
 * minor return variations within a band.
 *
 * @param marketMaterialVersion  materialVersion of the market-monitor repo entry
 * @param sectorMaterialVersion  materialVersion of the sector-monitor repo entry
 */
export function computePortfolioFactsFingerprint(
  facts: PortfolioFacts,
  marketMaterialVersion: number,
  sectorMaterialVersion: number,
): string {
  // Per-position categorical price state — catches any regime shift.
  const perPositionPriceState = Object.fromEntries(
    Object.entries(facts.priceBehavior.perPositionState)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ticker, snap]) => [
        ticker,
        `${snap.priceState}|${snap.volatilityState}|${snap.recentBehaviorState ?? ""}`,
      ])
  );

  const material = {
    // ── Composition & allocation ────────────────────────────────────────────
    topTickers: facts.allocation.topPositions.map((p) => p.ticker).sort(),
    holdingCount: facts.portfolio.holdingCount,
    cashBand: bandN(facts.portfolio.cashPct, 5),
    top3Band: bandN(facts.allocation.top3Pct, 5),
    // Individual banded weights — catches meaningful per-position shifts (2% band)
    topPositionWeights: facts.allocation.topPositions
      .map((p) => `${p.ticker}:${bandN(p.investedWeightPct, 2)}`)
      .sort(),
    // All sector/currency exposures banded at 5%
    sectorBands: facts.allocation.sectorExposure
      .map((s) => `${s.name}:${bandN(s.pct, 5)}`)
      .sort(),
    currencyBands: facts.allocation.currencyExposure
      .map((c) => `${c.currency}:${bandN(c.pct, 5)}`)
      .sort(),

    // ── Price state (per-position categorical) ──────────────────────────────
    perPositionPriceState,
    fallingFastHoldings: [...facts.priceBehavior.fallingFastHoldings].sort(),

    // ── Performance bands ───────────────────────────────────────────────────
    // Coarse banding suppresses daily noise; material moves fire a new AI call.
    return1DBand: bandN(facts.performance.portfolioReturn1D ?? 0, 3),
    return5DBand: bandN(facts.performance.portfolioReturn5D ?? 0, 5),
    return1MBand: bandN(facts.performance.portfolioReturn1M ?? 0, 10),

    // ── Events (title + date + importance + affected holdings) ──────────────
    events7d: facts.events.upcomingHoldingEvents
      .map(
        (e) =>
          `${e.title}|${e.date}|${e.importance}|${[...e.affectedHoldings].sort().join(",")}`
      )
      .sort(),

    // ── Company state ────────────────────────────────────────────────────────
    strengthened: [...facts.companyState.strengthenedHoldings].sort(),
    weakened: [...facts.companyState.weakenedHoldings].sort(),
    invalidated: [...facts.companyState.invalidatedHoldings].sort(),
    avoidView: facts.companyState.avoidViewHoldings
      .map((h) => `${h.ticker}:${h.view}`)
      .sort(),
    viewDistribution: Object.entries(facts.companyState.viewDistribution)
      .map(([rating, count]) => `${rating}:${count}`)
      .sort(),
    lowStrength: facts.companyState.lowCaseStrength
      .map((l) => `${l.ticker}:${bandN(l.strength, 10)}`)
      .sort(),

    // ── Market / sector regime (version bumps on categorical changes) ────────
    marketVersion: marketMaterialVersion,
    sectorVersion: sectorMaterialVersion,
  };

  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}
