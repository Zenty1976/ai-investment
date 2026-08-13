/**
 * Risk Facts — shared types and pure deterministic fingerprint function.
 *
 * Kept separate from risk-intelligence-engine.ts so the fingerprint logic
 * can be imported and unit-tested without pulling in the full engine's
 * dependency chain (price-context-service → saxo-store → pino logger).
 *
 * Import this file for types and fingerprinting.
 * Import risk-intelligence-engine.ts for computeRiskFacts().
 */
import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single held position with both weight bases. */
export interface PositionFact {
  ticker: string;
  name: string;
  /** % of total portfolio value (includes cash denominator) */
  portfolioWeightPct: number;
  /** % of invested capital (excludes cash) */
  investedWeightPct: number;
  currency: string;
  sector: string;
  marketValueBase: number;
}

export interface ConcentrationFacts {
  /** Top 5 positions by invested-capital weight, descending. */
  topPositions: PositionFact[];
  largestPositionTicker: string | null;
  /** % of invested capital */
  largestPositionPct: number;
  top3Pct: number;
  top5Pct: number;
  top3Tickers: string[];
  /** Holdings with investedWeightPct > 20% */
  positionsAbove20Pct: string[];
  /** Holdings with investedWeightPct > 30% */
  positionsAbove30Pct: string[];
}

export interface SectorFacts {
  /** Sorted descending by portfolio-weight percentage. */
  exposures: Array<{ name: string; pct: number }>;
  largestSectorPct: number;
  largestSectorName: string | null;
}

export interface CurrencyFacts {
  /** Sorted descending by portfolio-weight percentage. */
  exposures: Array<{ currency: string; pct: number }>;
}

/** Categorical price state snapshot for a single held position. */
export interface PositionPriceSnapshot {
  priceState: string;
  volatilityState: string;
  /** null when recentBehavior is absent (legacy cache entry). */
  recentBehaviorState: string | null;
}

export interface PriceRiskFacts {
  /** % of invested portfolio value in High-volatility positions */
  highVolatilityPct: number;
  highVolatilityHoldings: string[];
  /** % of invested portfolio value in StrongDowntrend positions */
  strongDowntrendPct: number;
  strongDowntrendHoldings: string[];
  /** % of invested portfolio value in StrongUptrend positions */
  strongUptrendPct: number;
  strongUptrendHoldings: string[];
  /** Holdings with recentBehavior.state = "FallingFast" */
  fallingFastHoldings: string[];
  /** Holdings with recentBehavior.state = "Rising" */
  risingHoldings: string[];
  /** Holdings with recentBehavior.state = "Stabilizing" while priceState is a downtrend */
  stabilizingFromDowntrendHoldings: string[];
  /** Tickers for which no fresh PriceContext was found */
  missingPriceContext: string[];
  /**
   * Full categorical price/volatility/behavior state per held position.
   * Used by the fingerprint to detect any regime shift (e.g. Flat → Uptrend,
   * Low → Elevated volatility) — not just extreme-subset changes.
   * Absent for tickers in missingPriceContext.
   */
  perPositionState: Record<string, PositionPriceSnapshot>;
}

export interface UpcomingEventFact {
  title: string;
  date: string;
  importance: string;
  affectedHoldings: string[];
}

export interface EventRiskFacts {
  /** Non-Low importance events in the next 3 days, sorted by date. */
  eventsNext3Days: UpcomingEventFact[];
  /** Non-Low importance events in the next 7 days, sorted by date. */
  eventsNext7Days: UpcomingEventFact[];
  /** % of total portfolio value (incl. cash) with a material event in next 3 days */
  portfolioPctWithEventNext3Days: number;
  /** % of total portfolio value (incl. cash) with a material event in next 7 days */
  portfolioPctWithEventNext7Days: number;
}

export interface ThesisFact {
  ticker: string;
  thesisId: string;
}

export interface CompanyRiskFacts {
  /** Thesis points currently Invalidated for any holding */
  invalidatedTheses: ThesisFact[];
  /** Thesis points currently Weakened for any holding */
  weakenedTheses: ThesisFact[];
  /** Holdings with investmentCaseStrength < 40 */
  lowCaseStrength: Array<{ ticker: string; strength: number }>;
  /** Holdings with investmentView.rating = "Avoid" or "Strong Avoid" */
  avoidViewHoldings: Array<{ ticker: string; view: string }>;
  /** investmentView.rating distribution across holdings */
  viewDistribution: Record<string, number>;
}

/** Complete deterministic risk fact set. All quantities are computed in backend. */
export interface RiskFacts {
  baseCurrency: string;
  /** Total portfolio value in base currency. null when unavailable. */
  portfolioValue: number | null;
  /** Cash as % of total portfolio value (includes available cash). */
  cashPct: number;
  numberOfHoldings: number;
  concentration: ConcentrationFacts;
  sectors: SectorFacts;
  currencies: CurrencyFacts;
  priceRisk: PriceRiskFacts;
  eventRisk: EventRiskFacts;
  companyRisk: CompanyRiskFacts;
  /** Human-readable plain-language flags summarising material risk conditions. */
  portfolioRiskFlags: string[];
  computedAt: string;
}

export interface RiskIntelligenceResult {
  riskFacts: RiskFacts;
  /** Material fingerprint — changes only when meaningful risk facts change. */
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
 * Produce a deterministic fingerprint of material RiskFacts.
 *
 * Bands continuous values to avoid fingerprint churn from tiny movements.
 * Changes when a meaningful risk threshold is crossed:
 *   - Any held position's priceState, volatilityState, or recentBehavior changes
 *   - Largest position crosses a 2% band
 *   - Top-3 concentration crosses a 5% band
 *   - Sector exposure crosses a 5% band
 *   - Event enters or leaves the 7-day window (by title+date)
 *   - Thesis point becomes Invalidated or Weakened
 *   - Portfolio composition changes (top-5 holding set)
 */
export function computeRiskFactsFingerprint(facts: RiskFacts): string {
  // Per-position categorical price state: catches any regime shift
  // (e.g. Flat → Uptrend, Low → Elevated volatility, any recentBehavior change).
  // Categorical strings need no banding — they're already discrete.
  const perPositionPriceState = Object.fromEntries(
    Object.entries(facts.priceRisk.perPositionState)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ticker, snap]) => [
        ticker,
        `${snap.priceState}|${snap.volatilityState}|${snap.recentBehaviorState ?? ""}`,
      ])
  );

  const material = {
    cashBand: bandN(facts.cashPct, 5),

    // ── Concentration ─────────────────────────────────────────────────────
    largestPosBand: bandN(facts.concentration.largestPositionPct, 2),
    top3Band: bandN(facts.concentration.top3Pct, 5),
    above20: [...facts.concentration.positionsAbove20Pct].sort(),
    above30: [...facts.concentration.positionsAbove30Pct].sort(),
    // Individual banded weights for top-5: catches meaningful per-position shifts
    topPositionWeights: facts.concentration.topPositions
      .map((p) => `${p.ticker}:${bandN(p.investedWeightPct, 2)}`)
      .sort(),

    // ── Sector & currency exposure (ALL entries banded at 5%) ─────────────
    // Covers shifts in any sector/currency — not only the largest one.
    sectorBands: facts.sectors.exposures
      .map((s) => `${s.name}:${bandN(s.pct, 5)}`)
      .sort(),
    currencyBands: facts.currencies.exposures
      .map((c) => `${c.currency}:${bandN(c.pct, 5)}`)
      .sort(),

    // ── Price state (per-position categorical) ────────────────────────────
    perPositionPriceState,
    fallingFastHoldings: [...facts.priceRisk.fallingFastHoldings].sort(),

    // ── Events (title + date + importance + affected holdings) ────────────
    // Importance and affected-holding changes are material risk signals.
    events7d: facts.eventRisk.eventsNext7Days
      .map(
        (e) =>
          `${e.title}|${e.date}|${e.importance}|${[...e.affectedHoldings].sort().join(",")}`
      )
      .sort(),

    // ── Company risk ──────────────────────────────────────────────────────
    invalidated: facts.companyRisk.invalidatedTheses
      .map((t) => `${t.ticker}:${t.thesisId}`)
      .sort(),
    weakened: facts.companyRisk.weakenedTheses
      .map((t) => `${t.ticker}:${t.thesisId}`)
      .sort(),
    lowStrength: facts.companyRisk.lowCaseStrength
      .map((l) => `${l.ticker}:${bandN(l.strength, 10)}`)
      .sort(),
    // Investment view: Avoid/Strong-Avoid is a direct risk signal; full
    // viewDistribution catches any rating change (e.g. Buy → Avoid).
    avoidViewHoldings: facts.companyRisk.avoidViewHoldings
      .map((h) => `${h.ticker}:${h.view}`)
      .sort(),
    viewDistribution: Object.entries(facts.companyRisk.viewDistribution)
      .map(([rating, count]) => `${rating}:${count}`)
      .sort(),

    numberOfHoldings: facts.numberOfHoldings,
    topTickers: facts.concentration.topPositions.map((p) => p.ticker).sort(),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}
