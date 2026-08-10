/**
 * Price Context Calculator
 *
 * Pure, deterministic calculations on daily close price arrays.
 * No external dependencies. All thresholds are centralized in PRICE_CONTEXT_CONFIG.
 *
 * Architecture:
 *   raw close array → calculatePriceContext() → PriceContext
 *
 * OpenAI must never receive raw price arrays — only the compact PriceContext output.
 *
 * IMPORTANT SEMANTIC DISTINCTION:
 *   "Price has fallen" ≠ "stock is cheap"
 *   PriceContext describes MARKET PRICE BEHAVIOR only.
 *   Valuation and fundamental quality are separate concepts.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type TrendLabel =
  | "StrongDowntrend" | "Downtrend" | "Flat" | "Uptrend" | "StrongUptrend";

export type MomentumChange =
  | "AcceleratingNegative"
  | "Negative"
  | "NegativeMomentumWeakening"
  | "Stable"
  | "PositiveMomentumDeveloping"
  | "Positive"
  | "AcceleratingPositive";

export type VolatilityState = "Low" | "Normal" | "Elevated" | "High";
export type VolatilityTrend = "Falling" | "Stable" | "Rising";

export type PriceState =
  | "StrongDowntrend"
  | "Downtrend"
  | "StabilizingAfterDecline"
  | "RangeBound"
  | "PossibleRecovery"
  | "Uptrend"
  | "StrongUptrend"
  | "ExtendedAfterRally";

export interface PriceContext {
  symbol: string;
  asOf: string;
  source: "saxo";
  currentPrice: number;

  returns: {
    oneDayPct: number | null;
    fiveDayPct: number | null;
    tenDayPct: number | null;
    thirtyDayPct: number | null;
    ninetyDayPct: number | null;
  };

  range: {
    thirtyDayHigh: number | null;
    thirtyDayLow: number | null;
    distanceFrom30DayHighPct: number | null;
    distanceFrom30DayLowPct: number | null;
    ninetyDayHigh: number | null;
    ninetyDayLow: number | null;
    distanceFrom90DayHighPct: number | null;
    distanceFrom90DayLowPct: number | null;
  };

  trend: {
    fiveDaySlope: number | null;
    tenDaySlope: number | null;
    thirtyDaySlope: number | null;
    ninetyDaySlope: number | null;
    shortTermTrend: TrendLabel;
    mediumTermTrend: TrendLabel;
    longTermTrend: TrendLabel;
    momentumChange: MomentumChange;
  };

  volatility: {
    fiveDay: number | null;
    thirtyDay: number | null;
    volatilityState: VolatilityState;
    volatilityTrend: VolatilityTrend;
  };

  structure: {
    higherLows: boolean | null;
    lowerHighs: boolean | null;
  };

  priceState: PriceState;

  dataQuality: {
    availableTradingDays: number;
    sufficientFor90DayAnalysis: boolean;
  };

  // Future-ready: relativeToMarket30D and relativeToSector30D can be added here
}

// ── Centralized thresholds ────────────────────────────────────────────────────
// All classification boundaries live here so the same data always produces the
// same classification, and future tuning only requires editing this one object.

export const PRICE_CONTEXT_CONFIG = {
  // Normalized slope thresholds (%/day relative to window start)
  slope: {
    strongUp:   0.0050,   // > +0.5%/day normalized → StrongUptrend
    up:         0.0015,   // > +0.15%/day → Uptrend
    down:      -0.0015,   // < -0.15%/day → Downtrend
    strongDown: -0.0050,  // < -0.5%/day → StrongDowntrend
    // [-0.15%, +0.15%] → Flat
  },

  // Annualized realized volatility (%) thresholds
  volatility: {
    low:      20,   // < 20% → Low
    normal:   35,   // 20–35% → Normal
    elevated: 55,   // 35–55% → Elevated
    // > 55% → High
  },

  // Volatility trend: ratio of 5d vol to 30d vol
  volatilityTrend: {
    fallingRatio: 0.75,  // 5d/30d < 0.75 → Falling
    risingRatio:  1.30,  // 5d/30d > 1.30 → Rising
    // else → Stable
  },

  // PriceState thresholds
  priceState: {
    // StabilizingAfterDecline: requires long decline + weakening short-term momentum
    stabilizingMinDecline30d:  -10,   // 30d or 90d must be < -10%
    stabilizingMinDecline90d:  -15,
    // PossibleRecovery: was in decline, short term now turning positive
    possibleRecoveryMinDecline30d: -10,
    // ExtendedAfterRally: strong rally, vol rising
    extendedAfterRallyMin30d: 25,
    // StrongDowntrend composite: both long+medium must be StrongDowntrend AND 90d < -25%
    strongDowntrendMin90d: -25,
    // StrongUptrend: all three trends StrongUptrend AND 30d > +15%
    strongUptrendMin30d: 15,
  },

  // Minimum bars to compute each metric
  minBars: {
    oneDay:    2,
    fiveDay:   6,
    tenDay:    11,
    thirtyDay: 21,
    ninetyDay: 60,
    structure: 10,
  },

  // 90-day completeness threshold
  sufficient90DayBars: 55,
} as const;

// ── Math helpers ──────────────────────────────────────────────────────────────

/**
 * Simple linear regression of y on x = [0, 1, ..., N-1].
 * Returns slope in y-units per step. Returns null if fewer than 2 points.
 */
function linearSlope(values: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    num += dx * (values[i] - yMean);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Normalized slope: regress prices relative to the window start.
 * Result is ≈ "fraction of first-price gained per trading day".
 * Multiply by 100 for %/day. Comparable across stocks.
 */
function normalizedSlope(closes: number[], windowSize: number): number | null {
  if (closes.length < Math.max(2, windowSize)) return null;
  const window = closes.slice(-windowSize);
  const first = window[0];
  if (!first || first === 0) return null;
  const normalized = window.map((p) => p / first);
  return linearSlope(normalized);
}

/**
 * Annualized realized volatility from daily log returns.
 * Returns null if fewer than 2 prices.
 */
function annualizedVol(closes: number[], windowSize: number): number | null {
  if (closes.length < Math.max(2, windowSize)) return null;
  const window = closes.slice(-windowSize);
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    if (window[i - 1] > 0 && window[i] > 0) {
      returns.push(Math.log(window[i] / window[i - 1]));
    }
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100; // annualized %
}

function pctReturn(closes: number[], lookback: number): number | null {
  const n = closes.length;
  if (n < lookback + 1) return null;
  const base = closes[n - 1 - lookback];
  if (!base || base === 0) return null;
  return ((closes[n - 1] - base) / base) * 100;
}

function windowHigh(closes: number[], windowSize: number): number | null {
  if (closes.length < windowSize) return null;
  return Math.max(...closes.slice(-windowSize));
}

function windowLow(closes: number[], windowSize: number): number | null {
  if (closes.length < windowSize) return null;
  return Math.min(...closes.slice(-windowSize));
}

function distancePct(current: number, level: number): number {
  return ((current - level) / level) * 100;
}

// ── Trend classification ──────────────────────────────────────────────────────

function classifyTrend(slope: number | null): TrendLabel {
  if (slope === null) return "Flat";
  const cfg = PRICE_CONTEXT_CONFIG.slope;
  if (slope >= cfg.strongUp)   return "StrongUptrend";
  if (slope >= cfg.up)         return "Uptrend";
  if (slope > cfg.down)        return "Flat";        // includes 0 and small values
  if (slope >= cfg.strongDown) return "Downtrend";
  return "StrongDowntrend";
}

// ── Momentum change ───────────────────────────────────────────────────────────

function classifyMomentumChange(
  fiveSlope: number | null,
  thirtySlope: number | null,
  ninetySlope: number | null
): MomentumChange {
  const s5  = fiveSlope ?? 0;
  const s30 = thirtySlope ?? ninetySlope ?? 0;
  const cfg = PRICE_CONTEXT_CONFIG.slope;

  const is5Flat = Math.abs(s5) < Math.abs(cfg.down) * 0.5;  // |s5| < 0.075%/day
  const is5Positive = s5 >= cfg.up;
  const is30Negative = s30 <= cfg.down;
  const is30StrongNeg = s30 <= cfg.strongDown;

  // Both strongly accelerating downward
  if (s5 <= cfg.strongDown && s30 <= cfg.strongDown) return "AcceleratingNegative";

  // 30d strongly negative, 5d only moderately negative → slowing
  if (is30StrongNeg && s5 > cfg.strongDown && !is5Flat) return "Negative";

  // 30d negative, 5d now flat (momentum clearly weakening)
  if (is30Negative && is5Flat) return "NegativeMomentumWeakening";

  // 30d negative/flat, 5d already positive (possible turn)
  if (is30Negative && is5Positive) return "PositiveMomentumDeveloping";

  // Both positive
  if (s5 >= cfg.strongUp && s30 >= cfg.strongUp) return "AcceleratingPositive";
  if (s5 >= cfg.up && s30 >= cfg.up) return "Positive";

  // Small positive momentum developing from neutral
  if (s5 >= cfg.up && s30 >= cfg.down) return "PositiveMomentumDeveloping";

  return "Stable";
}

// ── Volatility classification ─────────────────────────────────────────────────

function classifyVolatilityState(vol30: number | null): VolatilityState {
  if (vol30 === null) return "Normal";
  const cfg = PRICE_CONTEXT_CONFIG.volatility;
  if (vol30 < cfg.low)      return "Low";
  if (vol30 < cfg.normal)   return "Normal";
  if (vol30 < cfg.elevated) return "Elevated";
  return "High";
}

function classifyVolatilityTrend(vol5: number | null, vol30: number | null): VolatilityTrend {
  if (vol5 === null || vol30 === null || vol30 === 0) return "Stable";
  const ratio = vol5 / vol30;
  const cfg = PRICE_CONTEXT_CONFIG.volatilityTrend;
  if (ratio < cfg.fallingRatio) return "Falling";
  if (ratio > cfg.risingRatio)  return "Rising";
  return "Stable";
}

// ── Price structure ───────────────────────────────────────────────────────────

/**
 * Detect simple price structure from daily closes.
 * Finds local minima/maxima using a 3-bar window and checks if last 3 are ascending/descending.
 * Returns null if insufficient data or pattern is ambiguous.
 */
function detectStructure(closes: number[], minBars: number): { higherLows: boolean | null; lowerHighs: boolean | null } {
  if (closes.length < minBars) return { higherLows: null, lowerHighs: null };

  const lows: number[] = [];
  const highs: number[] = [];

  for (let i = 1; i < closes.length - 1; i++) {
    if (closes[i] < closes[i - 1] && closes[i] < closes[i + 1]) lows.push(closes[i]);
    if (closes[i] > closes[i - 1] && closes[i] > closes[i + 1]) highs.push(closes[i]);
  }

  let higherLows: boolean | null = null;
  let lowerHighs: boolean | null = null;

  if (lows.length >= 3) {
    const last3 = lows.slice(-3);
    higherLows = last3[0] < last3[1] && last3[1] < last3[2];
  }
  if (highs.length >= 3) {
    const last3 = highs.slice(-3);
    lowerHighs = last3[0] > last3[1] && last3[1] > last3[2];
  }

  return { higherLows, lowerHighs };
}

// ── PriceState composite classifier ──────────────────────────────────────────
//
// Conservative by design. Rules err on the side of understatement.
// StabilizingAfterDecline requires multiple confirming signals.
// PossibleRecovery requires even stronger evidence.

function classifyPriceState(
  returns: PriceContext["returns"],
  trend: Pick<PriceContext["trend"], "shortTermTrend" | "mediumTermTrend" | "longTermTrend" | "momentumChange">,
  vol: PriceContext["volatility"],
  structure: PriceContext["structure"],
  ninetyDaySlope: number | null
): PriceState {
  const cfg = PRICE_CONTEXT_CONFIG.priceState;
  const { shortTermTrend: stt, mediumTermTrend: mtt, longTermTrend: ltt, momentumChange } = trend;
  const r30 = returns.thirtyDayPct ?? 0;
  const r90 = returns.ninetyDayPct ?? 0;

  const downtrendLabels: TrendLabel[] = ["Downtrend", "StrongDowntrend"];
  const uptrendLabels: TrendLabel[] = ["Uptrend", "StrongUptrend"];
  const isShortDown = downtrendLabels.includes(stt);
  const isMedDown   = downtrendLabels.includes(mtt);
  const isLongDown  = downtrendLabels.includes(ltt);
  const isShortUp   = uptrendLabels.includes(stt);
  const isMedUp     = uptrendLabels.includes(mtt);
  const isLongUp    = uptrendLabels.includes(ltt);

  // StrongDowntrend: all three timeframes down AND significant 90d decline
  if (stt === "StrongDowntrend" && mtt === "StrongDowntrend" && ltt === "StrongDowntrend"
    && r90 < cfg.strongDowntrendMin90d) {
    return "StrongDowntrend";
  }

  // ExtendedAfterRally: sustained strong rally with vol now rising (overheated signal)
  if (isShortUp && isMedUp && r30 > cfg.extendedAfterRallyMin30d && vol.volatilityTrend === "Rising") {
    return "ExtendedAfterRally";
  }

  // StrongUptrend: all three trends up AND 30d substantial positive
  if (isShortUp && isMedUp && isLongUp && r30 > cfg.strongUptrendMin30d) {
    return "StrongUptrend";
  }

  // Uptrend: medium + long both in uptrend territory
  if (isMedUp && isLongUp) return "Uptrend";

  // PossibleRecovery: was in decline (30d or 90d significant negative), short term now positive
  // Requires stronger evidence than StabilizingAfterDecline
  const wasInDecline = r30 < cfg.possibleRecoveryMinDecline30d || r90 < cfg.stabilizingMinDecline90d;
  const shortTurnedPositive = isShortUp && !isMedDown; // medium at least flat now
  if (wasInDecline && shortTurnedPositive && structure.higherLows === true) {
    return "PossibleRecovery";
  }

  // StabilizingAfterDecline: significant longer decline + weakening short-term momentum
  // Conservative — requires multiple confirming signals
  const significantDecline =
    r30 < cfg.stabilizingMinDecline30d ||
    r90 < cfg.stabilizingMinDecline90d;

  const longMedNegative = isMedDown || isLongDown; // at least one of medium/long still negative

  const momentumWeakening =
    momentumChange === "NegativeMomentumWeakening" ||
    momentumChange === "Stable" ||
    momentumChange === "PositiveMomentumDeveloping";

  const shortTermCalming = !isShortDown || stt === "Flat"; // short term no longer strongly down

  // Volatility signal (optional but adds confidence)
  const volFalling = vol.volatilityTrend === "Falling";

  // Require: significant decline + medium/long still negative + momentum clearly weakening + short calming
  // Optionally: vol also falling
  const stabilizingEvidence = significantDecline && longMedNegative && momentumWeakening && shortTermCalming;
  const strongEvidence = stabilizingEvidence && (volFalling || structure.higherLows === true);

  if (stabilizingEvidence && strongEvidence) return "StabilizingAfterDecline";

  // General Downtrend
  if (isMedDown && isLongDown) return "Downtrend";
  if (isShortDown && isMedDown) return "Downtrend";

  // All slopes flat — range bound
  const allFlat = [stt, mtt, ltt].every((t) => t === "Flat");
  if (allFlat) return "RangeBound";

  // Default: any single-timeframe trend dominates
  if (isShortUp || isMedUp) return "Uptrend";
  if (isShortDown || isMedDown) return "Downtrend";

  return "RangeBound";
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function calculatePriceContext(
  symbol: string,
  closes: number[],  // chronological, oldest first; last element = most recent
  asOf: string
): PriceContext {
  const cfg = PRICE_CONTEXT_CONFIG.minBars;
  const n = closes.length;
  const current = n > 0 ? closes[n - 1] : 0;

  // Returns
  const r1d  = n >= cfg.oneDay    ? pctReturn(closes, 1)  : null;
  const r5d  = n >= cfg.fiveDay   ? pctReturn(closes, 5)  : null;
  const r10d = n >= cfg.tenDay    ? pctReturn(closes, 10) : null;
  const r30d = n >= cfg.thirtyDay ? pctReturn(closes, 30) : null;
  const r90d = n >= cfg.ninetyDay ? pctReturn(closes, 90) : null;

  // Range
  const high30 = n >= cfg.thirtyDay ? windowHigh(closes, 30) : null;
  const low30  = n >= cfg.thirtyDay ? windowLow(closes, 30)  : null;
  const high90 = n >= cfg.ninetyDay ? windowHigh(closes, 90) : null;
  const low90  = n >= cfg.ninetyDay ? windowLow(closes, 90)  : null;

  // Normalized slopes
  const s5d  = n >= cfg.fiveDay   ? normalizedSlope(closes, 5)  : null;
  const s10d = n >= cfg.tenDay    ? normalizedSlope(closes, 10) : null;
  const s30d = n >= cfg.thirtyDay ? normalizedSlope(closes, 30) : null;
  const s90d = n >= cfg.ninetyDay ? normalizedSlope(closes, 90) : null;

  // Trend labels
  const shortTermTrend  = classifyTrend(s5d);
  const mediumTermTrend = classifyTrend(s30d ?? s10d);
  const longTermTrend   = classifyTrend(s90d ?? s30d);
  const momentumChange  = classifyMomentumChange(s5d, s30d, s90d);

  // Volatility
  const vol5d  = n >= cfg.fiveDay   ? annualizedVol(closes, 5)  : null;
  const vol30d = n >= cfg.thirtyDay ? annualizedVol(closes, 30) : null;
  const volatilityState = classifyVolatilityState(vol30d);
  const volatilityTrend = classifyVolatilityTrend(vol5d, vol30d);

  // Structure
  const structure = detectStructure(closes, cfg.structure);

  const returns = {
    oneDayPct:     r1d  !== null ? +r1d.toFixed(2)  : null,
    fiveDayPct:    r5d  !== null ? +r5d.toFixed(2)  : null,
    tenDayPct:     r10d !== null ? +r10d.toFixed(2) : null,
    thirtyDayPct:  r30d !== null ? +r30d.toFixed(2) : null,
    ninetyDayPct:  r90d !== null ? +r90d.toFixed(2) : null,
  };

  const trend = {
    fiveDaySlope:    s5d  !== null ? +(s5d * 100).toFixed(4)  : null,
    tenDaySlope:     s10d !== null ? +(s10d * 100).toFixed(4) : null,
    thirtyDaySlope:  s30d !== null ? +(s30d * 100).toFixed(4) : null,
    ninetyDaySlope:  s90d !== null ? +(s90d * 100).toFixed(4) : null,
    shortTermTrend,
    mediumTermTrend,
    longTermTrend,
    momentumChange,
  };

  const volatility = {
    fiveDay:         vol5d  !== null ? +vol5d.toFixed(1)  : null,
    thirtyDay:       vol30d !== null ? +vol30d.toFixed(1) : null,
    volatilityState,
    volatilityTrend,
  };

  const priceState = classifyPriceState(returns, trend, volatility, structure, s90d);

  return {
    symbol,
    asOf,
    source: "saxo",
    currentPrice: +current.toFixed(4),
    returns,
    range: {
      thirtyDayHigh:             high30 !== null ? +high30.toFixed(4) : null,
      thirtyDayLow:              low30  !== null ? +low30.toFixed(4)  : null,
      distanceFrom30DayHighPct:  (high30 && current) ? +distancePct(current, high30).toFixed(1) : null,
      distanceFrom30DayLowPct:   (low30  && current) ? +distancePct(current, low30).toFixed(1)  : null,
      ninetyDayHigh:             high90 !== null ? +high90.toFixed(4) : null,
      ninetyDayLow:              low90  !== null ? +low90.toFixed(4)  : null,
      distanceFrom90DayHighPct:  (high90 && current) ? +distancePct(current, high90).toFixed(1) : null,
      distanceFrom90DayLowPct:   (low90  && current) ? +distancePct(current, low90).toFixed(1)  : null,
    },
    trend,
    volatility,
    structure,
    priceState,
    dataQuality: {
      availableTradingDays:       n,
      sufficientFor90DayAnalysis: n >= PRICE_CONTEXT_CONFIG.sufficient90DayBars,
    },
  };
}

// ── Compact text formatter for AI prompts ─────────────────────────────────────
//
// This is the ONLY format sent to OpenAI — never the raw close array.
// Designed to be concise and semantically precise.

export function formatPriceContextForPrompt(ctx: PriceContext): string {
  const fmt = (v: number | null, suffix = "%"): string =>
    v === null ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(1)}${suffix}`;

  const lines: string[] = [
    `PRICE CONTEXT — ${ctx.symbol} (as of ${ctx.asOf.substring(0, 10)}, source: Saxo ${ctx.dataQuality.sufficientFor90DayAnalysis ? "90d" : ctx.dataQuality.availableTradingDays + "d"} history)`,
    `Current price: ${ctx.currentPrice}`,
    `Returns:  1D ${fmt(ctx.returns.oneDayPct)} | 5D ${fmt(ctx.returns.fiveDayPct)} | 10D ${fmt(ctx.returns.tenDayPct)} | 30D ${fmt(ctx.returns.thirtyDayPct)} | 90D ${fmt(ctx.returns.ninetyDayPct)}`,
  ];

  // Range position
  if (ctx.range.thirtyDayLow !== null && ctx.range.thirtyDayHigh !== null) {
    lines.push(
      `30D range: ${ctx.range.thirtyDayLow} – ${ctx.range.thirtyDayHigh}` +
      ` | From 30D high: ${fmt(ctx.range.distanceFrom30DayHighPct)}` +
      ` | From 30D low: ${fmt(ctx.range.distanceFrom30DayLowPct)}`
    );
  }
  if (ctx.range.ninetyDayLow !== null && ctx.range.ninetyDayHigh !== null) {
    lines.push(
      `90D range: ${ctx.range.ninetyDayLow} – ${ctx.range.ninetyDayHigh}` +
      ` | From 90D high: ${fmt(ctx.range.distanceFrom90DayHighPct)}` +
      ` | From 90D low: ${fmt(ctx.range.distanceFrom90DayLowPct)}`
    );
  }

  // Trend
  lines.push(
    `Trend:    Short ${ctx.trend.shortTermTrend} | Medium ${ctx.trend.mediumTermTrend} | Long ${ctx.trend.longTermTrend}`,
    `Momentum: ${ctx.trend.momentumChange}`
  );

  // Volatility
  lines.push(
    `Volatility: ${ctx.volatility.volatilityState} (${ctx.volatility.volatilityTrend})` +
    (ctx.volatility.thirtyDay !== null ? ` | 30D realized: ${ctx.volatility.thirtyDay.toFixed(0)}% annualized` : "")
  );

  // Structure
  const structureNotes: string[] = [];
  if (ctx.structure.higherLows === true)  structureNotes.push("higher lows");
  if (ctx.structure.higherLows === false) structureNotes.push("lower lows");
  if (ctx.structure.lowerHighs === true)  structureNotes.push("lower highs");
  if (ctx.structure.lowerHighs === false) structureNotes.push("higher highs");
  if (structureNotes.length > 0) lines.push(`Structure: ${structureNotes.join(", ")}`);

  // Price state
  lines.push(`Price state: ${ctx.priceState}`);

  // Semantic reminder — always included to constrain AI interpretation
  lines.push(
    `[Note: Price state is descriptive market-price behavior only. ` +
    `It is NOT a forecast. "${ctx.priceState}" does NOT imply a valuation judgment or a trading signal. ` +
    `Use this together with fundamentals, valuation, news, and events.]`
  );

  return lines.join("\n");
}
