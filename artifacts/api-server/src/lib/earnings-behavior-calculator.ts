/**
 * Earnings Behavior Calculator — Deterministic price-reaction analysis.
 *
 * PURPOSE (spec §15 / §16):
 *   Compute historical earnings behavior profiles from:
 *   1. Known past earnings dates (from EarningsCalendar or EarningsHistoryProfile)
 *   2. Saxo OHLC price bars (existing data source — no new API calls)
 *   3. EPS/revenue data from external provider (when available)
 *
 * DESIGN PRINCIPLES (spec §24):
 *   - Fully deterministic: no AI calls, no randomness
 *   - Pure function: input → output, no side effects
 *   - Pino-free: safe for use in tests
 *   - Handles missing/insufficient data gracefully
 *   - Returns PARTIAL profile when price data is available but EPS is not
 *
 * USAGE:
 *   const profile = computeEarningsBehavior(bars, earningsDates, historyEntries);
 */

import type { EarningsHistoryEntry, EarningsBehaviorProfile } from "./catalyst-types.js";

// ── OHLC bar type ─────────────────────────────────────────────────────────────

/**
 * A single OHLC bar from Saxo chart API.
 * Dates are ISO strings: "2026-01-15T00:00:00.000000Z" or "YYYY-MM-DD".
 */
export interface OhlcBar {
  /** ISO timestamp or ISO date of the bar. */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract ISO date (YYYY-MM-DD) from a bar's time field. */
function barDate(bar: OhlcBar): string {
  return bar.time.slice(0, 10);
}

/**
 * Find the index of the last bar at or before a given ISO date.
 * Returns -1 if no such bar exists.
 */
function findBarIndexAtOrBefore(bars: OhlcBar[], isoDate: string): number {
  let idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (barDate(bars[i]) <= isoDate) idx = i;
    else break;
  }
  return idx;
}

/** Compute percentage return: (to - from) / from. Returns null if invalid. */
function pctReturn(from: number, to: number): number | null {
  if (!from || !isFinite(from) || !isFinite(to)) return null;
  return (to - from) / from;
}

/** Round to 4 decimal places. */
function r4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// ── Price reaction calculation ────────────────────────────────────────────────

export interface SingleEarningsReaction {
  earningsDate: string;
  /** Close price on the earnings date (or the day before for AMC events). */
  priceAtEvent: number | null;
  /** Price return over 1 trading day after the earnings date. */
  return1D: number | null;
  /** Price return over 5 trading days after the earnings date. */
  return5D: number | null;
  /** Price return 5 days before the earnings date vs event price. */
  preEvent5DReturn: number | null;
  /** Price return 14 days before the earnings date vs event price. */
  preEvent14DReturn: number | null;
  /** Absolute 1D move (for volatility measure). */
  absReturn1D: number | null;
}

/**
 * Compute price reaction for a single earnings date using OHLC bars.
 *
 * Handles insufficient data gracefully — returns null for unavailable fields.
 */
export function computeSingleEarningsReaction(
  bars: OhlcBar[],
  earningsDate: string
): SingleEarningsReaction {
  const result: SingleEarningsReaction = {
    earningsDate,
    priceAtEvent: null,
    return1D: null,
    return5D: null,
    preEvent5DReturn: null,
    preEvent14DReturn: null,
    absReturn1D: null,
  };

  if (bars.length < 2) return result;

  const eventIdx = findBarIndexAtOrBefore(bars, earningsDate);
  if (eventIdx < 0) return result;

  const eventBar = bars[eventIdx];
  result.priceAtEvent = eventBar.close;

  // Post-event returns
  if (eventIdx + 1 < bars.length) {
    const next1 = bars[eventIdx + 1];
    const r = pctReturn(eventBar.close, next1.close);
    result.return1D = r !== null ? r4(r) : null;
    result.absReturn1D = r !== null ? r4(Math.abs(r)) : null;
  }
  if (eventIdx + 5 < bars.length) {
    const next5 = bars[eventIdx + 5];
    const r = pctReturn(eventBar.close, next5.close);
    result.return5D = r !== null ? r4(r) : null;
  }

  // Pre-event run-up
  if (eventIdx >= 5) {
    const prev5 = bars[eventIdx - 5];
    const r = pctReturn(prev5.close, eventBar.close);
    result.preEvent5DReturn = r !== null ? r4(r) : null;
  }
  if (eventIdx >= 14) {
    const prev14 = bars[eventIdx - 14];
    const r = pctReturn(prev14.close, eventBar.close);
    result.preEvent14DReturn = r !== null ? r4(r) : null;
  }

  return result;
}

// ── Behavior profile computation ──────────────────────────────────────────────

function avg(values: number[]): number | null {
  const valid = values.filter(v => isFinite(v));
  if (valid.length === 0) return null;
  return r4(valid.reduce((a, b) => a + b, 0) / valid.length);
}

function median(values: number[]): number | null {
  const sorted = [...values].filter(v => isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return r4(sorted[mid]);
  return r4((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Compute the full EarningsBehaviorProfile from OHLC bars and known earnings dates.
 *
 * @param bars           Sorted (ascending) OHLC bars from Saxo chart API.
 * @param earningsDates  ISO dates (YYYY-MM-DD) of past earnings events.
 * @param historyEntries Structured earnings history entries (from external provider).
 *                       Pass [] when no external provider is available —
 *                       price-only fields will still be computed.
 * @param nowIso         Current ISO timestamp (for lastComputedAt).
 */
export function computeEarningsBehavior(
  bars: OhlcBar[],
  earningsDates: string[],
  historyEntries: EarningsHistoryEntry[],
  nowIso: string
): EarningsBehaviorProfile {
  const noBars = bars.length < 2;
  const noDates = earningsDates.length === 0;

  if (noBars || noDates) {
    return {
      reportsAnalyzed: 0,
      beatRateEPS: null,
      beatRateRevenue: null,
      averageEPSSurprisePct: null,
      averageRevenueSurprisePct: null,
      average1DReaction: null,
      average5DReaction: null,
      medianAbsolute1DReaction: null,
      beatButStockFellCount: 0,
      missButStockRoseCount: 0,
      historicalVolatilityAroundEarnings: null,
      priceDataSource: noBars ? "UNAVAILABLE" : "Saxo OHLC",
      fundamentalDataSource: null,
      lastComputedAt: nowIso,
      isPartial: false,
      isUnavailable: true,
      unavailableReason: noBars
        ? "Insufficient price history for earnings behavior calculation."
        : "No earnings dates available.",
    };
  }

  // Compute price reactions for each known earnings date
  const reactions = earningsDates.map(d => computeSingleEarningsReaction(bars, d));
  const reacted = reactions.filter(r => r.return1D !== null);

  // Price-derived aggregates
  const average1DReaction = avg(reacted.map(r => r.return1D!));
  const average5DReaction = avg(reacted.filter(r => r.return5D !== null).map(r => r.return5D!));
  const medianAbsolute1DReaction = median(reacted.map(r => r.absReturn1D!));
  const historicalVolatilityAroundEarnings = medianAbsolute1DReaction;

  // EPS/revenue fundamentals — from external provider entries
  const hasEpsData = historyEntries.some(
    e => e.epsActual !== null && e.epsEstimate !== null
  );
  const hasRevenueData = historyEntries.some(
    e => e.revenueActual !== null && e.revenueEstimate !== null
  );

  let beatRateEPS: number | null = null;
  let beatRateRevenue: number | null = null;
  let averageEPSSurprisePct: number | null = null;
  let averageRevenueSurprisePct: number | null = null;
  let beatButStockFellCount = 0;
  let missButStockRoseCount = 0;

  if (hasEpsData) {
    const withEps = historyEntries.filter(
      e => e.epsActual !== null && e.epsEstimate !== null
    );
    const beats = withEps.filter(e => e.epsActual! >= e.epsEstimate!);
    beatRateEPS = r4(beats.length / withEps.length);
    averageEPSSurprisePct = avg(
      withEps
        .map(e => e.epsSurprisePct ?? ((e.epsActual! - e.epsEstimate!) / Math.abs(e.epsEstimate!) * 100))
        .filter(v => isFinite(v))
    );

    // Beat-but-fell / miss-but-rose (requires price reactions aligned by date)
    for (const entry of withEps) {
      const reaction = reactions.find(r => r.earningsDate === entry.reportDate);
      if (!reaction?.return1D) continue;
      const beat = entry.epsActual! >= entry.epsEstimate!;
      const fell = reaction.return1D < -0.005;
      const rose = reaction.return1D > 0.005;
      if (beat && fell) beatButStockFellCount++;
      if (!beat && rose) missButStockRoseCount++;
    }
  }

  if (hasRevenueData) {
    const withRev = historyEntries.filter(
      e => e.revenueActual !== null && e.revenueEstimate !== null
    );
    const revBeats = withRev.filter(e => e.revenueActual! >= e.revenueEstimate!);
    beatRateRevenue = r4(revBeats.length / withRev.length);
    averageRevenueSurprisePct = avg(
      withRev
        .map(e => e.revenueSurprisePct ?? ((e.revenueActual! - e.revenueEstimate!) / Math.abs(e.revenueEstimate!) * 100))
        .filter(v => isFinite(v))
    );
  }

  const isPartial = !hasEpsData || !hasRevenueData;

  return {
    reportsAnalyzed: reacted.length,
    beatRateEPS,
    beatRateRevenue,
    averageEPSSurprisePct,
    averageRevenueSurprisePct,
    average1DReaction,
    average5DReaction,
    medianAbsolute1DReaction,
    beatButStockFellCount,
    missButStockRoseCount,
    historicalVolatilityAroundEarnings,
    priceDataSource: "Saxo OHLC",
    fundamentalDataSource: hasEpsData ? "External Provider" : null,
    lastComputedAt: nowIso,
    isPartial,
    isUnavailable: false,
    unavailableReason: isPartial
      ? "Price reactions computed from Saxo OHLC. EPS/revenue beat rates require an external provider."
      : null,
  };
}
