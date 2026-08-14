/**
 * Catalyst Price Asymmetry — Deterministic Calculations
 *
 * Computes price asymmetry facts from existing PriceContext.
 * Zero AI calls. Zero new Saxo calls.
 *
 * Purpose: answer "Has the market already moved in anticipation of the event?"
 *
 * Key design rules:
 *   - A stock being "down a lot" does NOT automatically mean attractive.
 *   - A large pre-event run-up DOES reduce asymmetry (market has already moved).
 *   - Asymmetry assessment uses runup + trend context together.
 *   - All thresholds are centralized in PRICE_ASYMMETRY_CONFIG.
 *   - Do NOT hardcode ticker-specific logic.
 */

import type { PriceContext } from "./price-context-calculator.js";
import type {
  PriceAsymmetryFacts,
  PriceAsymmetry,
  RunupPattern,
  CatalystScreeningConfig,
} from "./catalyst-types.js";

// ── Configuration (centralized, not ticker-specific) ──────────────────────────

export const PRICE_ASYMMETRY_CONFIG = {
  /** Pre-event runup thresholds (pct). */
  runup: {
    noRunupMax:          2.0,   // < 2% → NoRunup
    smallRunupMax:       8.0,   // 2–8% → SmallRunup
    significantRunupMax: 20.0,  // 8–20% → SignificantRunup
    // > 20% → LargeRunup
  },

  /**
   * Asymmetry classification thresholds.
   * These work together with runup pattern and longer-term context.
   */
  asymmetry: {
    // Decline thresholds for medium-term (30D/90D)
    largeDecline90D:     -20.0,  // > 20% down over 90D = significant weakness
    moderateDecline90D:  -8.0,   // > 8% down = moderate weakness

    // Near-high threshold: stock within X% of 90D high = positioned near peak
    nearHighThreshold:   -10.0,  // distanceFrom90DayHighPct > -10% = near high

    // If 90D is down significantly, large 30D run-up may be partially justified
    largeDeclineRunupBuffer: -20.0, // 90D < -20% reduces runup concern by one tier
  },
} as const;

// ── Pre-event run-up computation ──────────────────────────────────────────────

/**
 * Select the most appropriate return period for pre-event run-up assessment.
 *
 * Logic: use the shortest return period that covers the event proximity.
 * If event is in 5 days, 5D return is most relevant.
 * If event is in 20 days, 30D return better captures positioning activity.
 */
export function selectRunupPeriod(
  daysUntilEvent: number,
  pc: PriceContext
): { pct: number | null; periodLabel: string | null } {
  if (daysUntilEvent <= 5) {
    return { pct: pc.returns.fiveDayPct, periodLabel: pc.returns.fiveDayPct !== null ? "5D" : null };
  }
  if (daysUntilEvent <= 10) {
    return { pct: pc.returns.tenDayPct, periodLabel: pc.returns.tenDayPct !== null ? "10D" : null };
  }
  if (daysUntilEvent <= 30) {
    return { pct: pc.returns.thirtyDayPct, periodLabel: pc.returns.thirtyDayPct !== null ? "30D" : null };
  }
  // > 30 days: event too far out to assess pre-event runup meaningfully
  return { pct: null, periodLabel: null };
}

/**
 * Classify the run-up pattern based on the magnitude of recent upward movement.
 * Downward movement always maps to NoRunup (no bullish pre-event positioning).
 */
export function classifyRunupPattern(preEventRunupPct: number | null): RunupPattern {
  if (preEventRunupPct === null) return "Unknown";
  // Only classify UPWARD movement as runup
  if (preEventRunupPct < PRICE_ASYMMETRY_CONFIG.runup.noRunupMax)          return "NoRunup";
  if (preEventRunupPct < PRICE_ASYMMETRY_CONFIG.runup.smallRunupMax)       return "SmallRunup";
  if (preEventRunupPct < PRICE_ASYMMETRY_CONFIG.runup.significantRunupMax) return "SignificantRunup";
  return "LargeRunup";
}

// ── Price asymmetry classification ────────────────────────────────────────────

/**
 * Classify price asymmetry from run-up pattern and longer-term price context.
 *
 * The key question: "Does remaining upside appear to outweigh downside risk
 * at the current price, given what the market appears to have already priced in?"
 *
 * This is purely PRICE BEHAVIOR — not a fundamental valuation judgment.
 */
export function classifyPriceAsymmetry(
  runupPattern: RunupPattern,
  preEventRunupPct: number | null,
  momentum30D: number | null,
  momentum90D: number | null,
  distanceFrom90DayHighPct: number | null,
  config: CatalystScreeningConfig
): PriceAsymmetry {
  const { runupWeakThresholdPct, runupPoorThresholdPct } = config;
  const { asymmetry: ac } = PRICE_ASYMMETRY_CONFIG;

  // ── LargeRunup: stock has already moved significantly ─────────────────────
  if (runupPattern === "LargeRunup") {
    // Even with a large runup, if the stock fell a LOT before, context matters
    if (momentum90D !== null && momentum90D <= ac.largeDeclineRunupBuffer) {
      // e.g. -30% over 90D but +22% recently — still Weak, not Neutral
      return "Weak";
    }
    return "Poor";
  }

  // ── SignificantRunup: stock up materially, asymmetry reduced ──────────────
  if (runupPattern === "SignificantRunup" && preEventRunupPct !== null &&
      preEventRunupPct >= runupPoorThresholdPct) {
    return "Poor"; // above poor threshold regardless of context
  }
  if (runupPattern === "SignificantRunup") {
    // Near 90D high AND significant runup → Weak
    if (distanceFrom90DayHighPct !== null && distanceFrom90DayHighPct > ac.nearHighThreshold) {
      return "Weak";
    }
    // Large 90D decline context reduces severity by one tier
    if (momentum90D !== null && momentum90D <= ac.largeDecline90D) {
      return "Neutral"; // significant runup but from very depressed level
    }
    return "Weak";
  }

  // ── SmallRunup: minor movement ────────────────────────────────────────────
  if (runupPattern === "SmallRunup") {
    // Near the 90D high with even a small runup = Weak
    if (distanceFrom90DayHighPct !== null && distanceFrom90DayHighPct > ac.nearHighThreshold) {
      return "Weak";
    }
    // Stock weak over 90D with small runup = better asymmetry
    if (momentum90D !== null && momentum90D <= ac.moderateDecline90D) {
      return "Attractive";
    }
    return "Neutral";
  }

  // ── NoRunup: stock has not moved up pre-event ─────────────────────────────
  if (runupPattern === "NoRunup") {
    // Stock deeply weak over 90D AND not moved up pre-event = best asymmetry
    if (momentum90D !== null && momentum90D <= ac.largeDecline90D) {
      return "VeryAttractive";
    }
    // Moderate weakness with no runup
    if (momentum90D !== null && momentum90D <= ac.moderateDecline90D) {
      return "Attractive";
    }
    // Flat or gently positive trend with no runup = neutral
    return "Neutral";
  }

  // ── Unknown runup (insufficient data) ────────────────────────────────────
  return "Neutral";
}

// ── Reasoning generator ───────────────────────────────────────────────────────

function buildReasoning(
  runupPattern: RunupPattern,
  preEventRunupPct: number | null,
  preEventRunupPeriod: string | null,
  momentum30D: number | null,
  momentum90D: number | null,
  asymmetry: PriceAsymmetry
): string {
  const parts: string[] = [];

  if (preEventRunupPct !== null && preEventRunupPeriod) {
    const sign = preEventRunupPct >= 0 ? "+" : "";
    parts.push(`${preEventRunupPeriod} move: ${sign}${preEventRunupPct.toFixed(1)}% (${runupPattern})`);
  } else {
    parts.push("Insufficient price data for pre-event run-up period");
  }

  if (momentum30D !== null) {
    const sign = momentum30D >= 0 ? "+" : "";
    parts.push(`30D: ${sign}${momentum30D.toFixed(1)}%`);
  }
  if (momentum90D !== null) {
    const sign = momentum90D >= 0 ? "+" : "";
    parts.push(`90D: ${sign}${momentum90D.toFixed(1)}%`);
  }

  parts.push(`→ Asymmetry: ${asymmetry}`);
  return parts.join(" | ");
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Build complete price asymmetry facts from PriceContext.
 *
 * @param pc              PriceContext from price-context-service
 * @param daysUntilEvent  Calendar days until the catalyst event
 * @param config          Configurable screening thresholds
 */
export function buildPriceAsymmetryFacts(
  pc: PriceContext,
  daysUntilEvent: number,
  config: CatalystScreeningConfig
): PriceAsymmetryFacts {
  const { pct: preEventRunupPct, periodLabel: preEventRunupPeriod } =
    selectRunupPeriod(daysUntilEvent, pc);

  const runupPattern = classifyRunupPattern(preEventRunupPct);

  const momentum30D = pc.returns.thirtyDayPct ?? null;
  const momentum90D = pc.returns.ninetyDayPct ?? null;
  const distanceFrom90DayHighPct = pc.range.distanceFrom90DayHighPct ?? null;

  const asymmetry = classifyPriceAsymmetry(
    runupPattern,
    preEventRunupPct,
    momentum30D,
    momentum90D,
    distanceFrom90DayHighPct,
    config
  );

  return {
    preEventRunupPct: preEventRunupPct !== null ? +preEventRunupPct.toFixed(2) : null,
    preEventRunupPeriod,
    recentMomentum5D:        pc.returns.fiveDayPct ?? null,
    recentMomentum10D:       pc.returns.tenDayPct ?? null,
    momentum30D,
    momentum90D,
    drawdownFrom30DayHighPct: pc.range.distanceFrom30DayHighPct ?? null,
    distanceFrom90DayHighPct,
    distanceFrom90DayLowPct:  pc.range.distanceFrom90DayLowPct ?? null,
    runupPattern,
    asymmetry,
    reasoning: buildReasoning(
      runupPattern, preEventRunupPct, preEventRunupPeriod,
      momentum30D, momentum90D, asymmetry
    ),
  };
}
