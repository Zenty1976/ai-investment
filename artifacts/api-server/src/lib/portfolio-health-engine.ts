/**
 * Portfolio Health Engine
 *
 * Computes 10 deterministic sub-scores from a PortfolioSnapshot.
 * No AI calls. All scoring is rule-based.
 *
 * Sub-scores (each 0–100):
 *  1. Diversification      — number of distinct holdings
 *  2. Cash Allocation      — cash as % of total portfolio
 *  3. Concentration        — largest single position %
 *  4. Top-3 Concentration  — top-3 positions as % of total
 *  5. P&L Quality          — unrealized P&L as % of total value
 *  6. Sector Balance       — number of distinct sectors (asset types)
 *  7. Currency Exposure    — % of portfolio in non-base-currency positions
 *  8. Delayed Price Risk   — proportion of positions with delayed prices
 *  9. Position Count Score — sanity check: too few or too many
 * 10. Account Health       — accounts with zero positions or cash
 */

import type { PortfolioSnapshot } from "../routes/portfolio-manager.js";
import type {
  PortfolioHealthScore,
  HealthSubScore,
  HealthGrade,
} from "./portfolio-manager-v2-types.js";

// ── Scoring helpers ────────────────────────────────────────────────────────────

function clamp(n: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Map a value to a score using a piecewise linear table.
 * `table` is an array of [value, score] breakpoints sorted ascending by value.
 * Values below the first breakpoint → first score.
 * Values above the last breakpoint → last score.
 * Values in between are interpolated.
 */
function piecewise(value: number, table: [number, number][]): number {
  if (table.length === 0) return 50;
  if (value <= table[0][0]) return table[0][1];
  if (value >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 0; i < table.length - 1; i++) {
    const [v0, s0] = table[i];
    const [v1, s1] = table[i + 1];
    if (value >= v0 && value <= v1) {
      const t = (value - v0) / (v1 - v0);
      return s0 + t * (s1 - s0);
    }
  }
  return 50;
}

// ── Grade mapping ─────────────────────────────────────────────────────────────

function gradeFromScore(score: number): HealthGrade {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

// ── Sub-score computations ────────────────────────────────────────────────────

function scoresDiversification(positionCount: number): HealthSubScore {
  const score = clamp(Math.round(piecewise(positionCount, [
    [0, 10], [1, 30], [2, 45], [3, 58], [5, 72], [7, 83], [10, 90], [15, 100],
  ])));
  let reason: string;
  if (positionCount === 0) reason = "No positions — portfolio is entirely cash.";
  else if (positionCount <= 2) reason = `Only ${positionCount} position${positionCount === 1 ? "" : "s"} — very concentrated.`;
  else if (positionCount <= 5) reason = `${positionCount} positions provide limited diversification.`;
  else if (positionCount <= 10) reason = `${positionCount} positions offer reasonable diversification.`;
  else reason = `${positionCount} positions provide good breadth.`;
  return { name: "Diversification", score, weight: 0.14, reason };
}

function scoresCashAllocation(cashPercent: number): HealthSubScore {
  // Ideal: 5–20 %. Too much cash = opportunity cost; too little = no buffer.
  const score = clamp(Math.round(piecewise(cashPercent, [
    [0, 45], [3, 65], [5, 90], [12, 100], [20, 90], [30, 70], [40, 50], [55, 30], [100, 10],
  ])));
  let reason: string;
  if (cashPercent < 3) reason = `Cash at ${cashPercent.toFixed(1)}% — very little buffer.`;
  else if (cashPercent < 5) reason = `Cash at ${cashPercent.toFixed(1)}% — slightly below ideal range.`;
  else if (cashPercent <= 20) reason = `Cash at ${cashPercent.toFixed(1)}% — within the healthy 5–20 % range.`;
  else if (cashPercent <= 35) reason = `Cash at ${cashPercent.toFixed(1)}% — above ideal; possible opportunity cost.`;
  else reason = `Cash at ${cashPercent.toFixed(1)}% — very high; significant opportunity cost.`;
  return { name: "Cash Allocation", score, weight: 0.10, reason };
}

function scoresConcentration(maxPositionPercent: number): HealthSubScore {
  const score = clamp(Math.round(piecewise(maxPositionPercent, [
    [0, 100], [10, 100], [15, 88], [20, 74], [25, 60], [30, 46], [35, 34], [40, 22], [50, 10],
  ])));
  let reason: string;
  if (maxPositionPercent <= 10) reason = `Largest position is ${maxPositionPercent.toFixed(1)}% — well-balanced.`;
  else if (maxPositionPercent <= 20) reason = `Largest position is ${maxPositionPercent.toFixed(1)}% — moderate concentration.`;
  else if (maxPositionPercent <= 30) reason = `Largest position is ${maxPositionPercent.toFixed(1)}% — elevated single-stock risk.`;
  else reason = `Largest position is ${maxPositionPercent.toFixed(1)}% — high concentration risk.`;
  return { name: "Max Position Concentration", score, weight: 0.14, reason };
}

function scoresTop3Concentration(top3Percent: number): HealthSubScore {
  const score = clamp(Math.round(piecewise(top3Percent, [
    [0, 100], [30, 100], [40, 88], [55, 72], [65, 55], [75, 38], [85, 22], [100, 10],
  ])));
  let reason: string;
  if (top3Percent <= 35) reason = `Top-3 positions at ${top3Percent.toFixed(1)}% — excellent spread.`;
  else if (top3Percent <= 55) reason = `Top-3 positions at ${top3Percent.toFixed(1)}% — reasonable concentration.`;
  else if (top3Percent <= 70) reason = `Top-3 positions at ${top3Percent.toFixed(1)}% — portfolio is dominated by a few names.`;
  else reason = `Top-3 positions at ${top3Percent.toFixed(1)}% — critical concentration in a handful of positions.`;
  return { name: "Top-3 Concentration", score, weight: 0.12, reason };
}

function scoresPLQuality(plPercent: number): HealthSubScore {
  // plPercent = unrealised P&L / totalValue * 100
  const score = clamp(Math.round(piecewise(plPercent, [
    [-20, 10], [-10, 25], [-5, 40], [0, 60], [3, 72], [7, 85], [12, 95], [20, 100],
  ])));
  let reason: string;
  if (plPercent < -5) reason = `Unrealised P&L of ${plPercent.toFixed(1)}% — portfolio is significantly in the red.`;
  else if (plPercent < 0) reason = `Unrealised P&L of ${plPercent.toFixed(1)}% — slight overall loss.`;
  else if (plPercent < 5) reason = `Unrealised P&L of ${plPercent.toFixed(1)}% — modest gain.`;
  else reason = `Unrealised P&L of ${plPercent.toFixed(1)}% — portfolio is performing well.`;
  return { name: "P&L Quality", score, weight: 0.10, reason };
}

function scoresSectorBalance(sectorCount: number): HealthSubScore {
  const score = clamp(Math.round(piecewise(sectorCount, [
    [0, 5], [1, 25], [2, 48], [3, 65], [4, 80], [5, 90], [6, 100],
  ])));
  let reason: string;
  if (sectorCount <= 1) reason = "All positions in one sector — high sector concentration.";
  else if (sectorCount === 2) reason = "Two sectors represented — limited sector diversification.";
  else if (sectorCount <= 3) reason = `${sectorCount} sectors — moderate sector spread.`;
  else reason = `${sectorCount} sectors — good sector diversification.`;
  return { name: "Sector Balance", score, weight: 0.12, reason };
}

function scoresCurrencyExposure(foreignPercent: number, positionCount: number): HealthSubScore {
  // 0 foreign = all domestic = fine unless large portfolio
  // 10–50 % foreign = healthy diversification
  // >70 % foreign = possibly too much FX risk
  if (positionCount === 0) {
    return { name: "Currency Exposure", score: 70, weight: 0.08, reason: "No positions — currency exposure not applicable." };
  }
  const score = clamp(Math.round(piecewise(foreignPercent, [
    [0, 65], [5, 75], [15, 88], [30, 100], [50, 90], [60, 78], [75, 62], [85, 48], [100, 35],
  ])));
  let reason: string;
  if (foreignPercent < 5) reason = `Nearly all positions in base currency — minimal FX diversification.`;
  else if (foreignPercent <= 50) reason = `${foreignPercent.toFixed(0)}% in non-base currency — healthy mix.`;
  else reason = `${foreignPercent.toFixed(0)}% in non-base currency — significant FX risk.`;
  return { name: "Currency Exposure", score, weight: 0.08, reason };
}

function scoresDelayedPriceRisk(delayedProportion: number, positionCount: number): HealthSubScore {
  if (positionCount === 0) {
    return { name: "Price Freshness", score: 90, weight: 0.08, reason: "No positions to price." };
  }
  const pct = delayedProportion * 100;
  const score = clamp(Math.round(piecewise(pct, [
    [0, 100], [10, 88], [25, 72], [40, 55], [60, 38], [80, 22], [100, 10],
  ])));
  let reason: string;
  if (pct === 0) reason = "All prices are live — no delays.";
  else if (pct < 20) reason = `${pct.toFixed(0)}% of positions have delayed prices.`;
  else reason = `${pct.toFixed(0)}% of positions have delayed prices — valuations may be inaccurate.`;
  return { name: "Price Freshness", score, weight: 0.08, reason };
}

function scoresPositionCount(positionCount: number): HealthSubScore {
  // Separate from Diversification: penalises over-fragmentation
  const score = clamp(Math.round(piecewise(positionCount, [
    [0, 15], [3, 65], [5, 85], [7, 95], [12, 100], [20, 90], [30, 70], [40, 50],
  ])));
  let reason: string;
  if (positionCount === 0) reason = "No open positions.";
  else if (positionCount < 3) reason = `${positionCount} position${positionCount === 1 ? "" : "s"} — too few to be diversified.`;
  else if (positionCount <= 12) reason = `${positionCount} positions — manageable portfolio size.`;
  else if (positionCount <= 25) reason = `${positionCount} positions — active portfolio; tracking effort is high.`;
  else reason = `${positionCount} positions — over-diversified; difficult to monitor.`;
  return { name: "Position Count", score, weight: 0.08, reason };
}

function scoresAccountHealth(emptyAccountCount: number, totalAccounts: number): HealthSubScore {
  if (totalAccounts === 0) {
    return { name: "Account Health", score: 50, weight: 0.06, reason: "No accounts found." };
  }
  const emptyPct = (emptyAccountCount / totalAccounts) * 100;
  const score = clamp(Math.round(100 - emptyPct * 0.6));
  const reason =
    emptyAccountCount === 0
      ? `All ${totalAccounts} account${totalAccounts === 1 ? "" : "s"} have positions.`
      : `${emptyAccountCount} of ${totalAccounts} account${totalAccounts === 1 ? "" : "s"} ${emptyAccountCount === 1 ? "is" : "are"} empty.`;
  return { name: "Account Health", score, weight: 0.06, reason };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function computePortfolioHealth(snapshot: PortfolioSnapshot): PortfolioHealthScore {
  const allPositions = snapshot.accounts.flatMap((a) => a.positions);
  const positionCount = allPositions.length;
  const totalValue = snapshot.totalValue ?? 0;
  const cash = snapshot.totalAvailableCash ?? 0;

  // Cash percent of total
  const cashPercent = totalValue > 0 ? (cash / totalValue) * 100 : 0;

  // Market values
  const marketValues = allPositions.map((p) => p.marketValueBaseCurrency);
  const totalMarketValue = marketValues.reduce((s, v) => s + v, 0);

  // Max single position %
  const maxPositionPercent = totalValue > 0 && positionCount > 0
    ? (Math.max(0, ...marketValues) / totalValue) * 100
    : 0;

  // Top-3 concentration
  const sorted = [...marketValues].sort((a, b) => b - a);
  const top3Sum = sorted.slice(0, 3).reduce((s, v) => s + v, 0);
  const top3Percent = totalValue > 0 ? (top3Sum / totalValue) * 100 : 0;

  // P&L % of total value
  const plPercent = totalValue > 0 ? (snapshot.totalUnrealizedProfitLoss / totalValue) * 100 : 0;

  // Sector count (use assetType as a proxy for sector when sector field absent)
  const sectors = new Set(allPositions.map((p) => p.assetType || p.exchange || "Unknown").filter(Boolean));
  const sectorCount = Math.max(sectors.size, 0);

  // Foreign currency % of portfolio market value
  const foreignValue = allPositions
    .filter((p) => p.currency && p.currency !== snapshot.baseCurrency)
    .reduce((s, p) => s + p.marketValueBaseCurrency, 0);
  const foreignPercent = totalMarketValue > 0 ? (foreignValue / totalMarketValue) * 100 : 0;

  // Delayed prices
  const delayedCount = allPositions.filter((p) => (p.priceDelayMinutes ?? 0) > 15).length;
  const delayedProportion = positionCount > 0 ? delayedCount / positionCount : 0;

  // Empty accounts
  const emptyAccountCount = snapshot.accounts.filter((a) => a.positions.length === 0).length;

  const subScores: HealthSubScore[] = [
    scoresDiversification(positionCount),
    scoresCashAllocation(cashPercent),
    scoresConcentration(maxPositionPercent),
    scoresTop3Concentration(top3Percent),
    scoresPLQuality(plPercent),
    scoresSectorBalance(sectorCount),
    scoresCurrencyExposure(foreignPercent, positionCount),
    scoresDelayedPriceRisk(delayedProportion, positionCount),
    scoresPositionCount(positionCount),
    scoresAccountHealth(emptyAccountCount, snapshot.accounts.length),
  ];

  const overall = clamp(
    Math.round(subScores.reduce((sum, s) => sum + s.score * s.weight, 0))
  );

  return {
    overall,
    grade: gradeFromScore(overall),
    subScores,
    computedAt: new Date().toISOString(),
  };
}
