/**
 * Portfolio Health Engine
 *
 * Computes 10 deterministic sub-scores from a PortfolioSnapshot plus optional
 * analytical context from Company Monitor, Risk Analyzer, and Trade Decision.
 * No AI calls. All scoring is rule-based.
 *
 * Sub-scores (each 0–100, weights sum to 1.0):
 *  1.  Max Position Concentration    (0.14) — single-stock concentration risk
 *  2.  Top-3 Concentration           (0.11) — top-3 positions as % of total
 *  3.  Sector Balance                (0.11) — true sector diversification (not assetType)
 *  4.  Currency Concentration        (0.08) — % in non-base-currency positions
 *  5.  Cash vs Target Alignment      (0.11) — cash % vs CIO cash target (or ideal range)
 *  6.  Event Concentration           (0.09) — holdings blocked by imminent events
 *  7.  Risk Concentration            (0.11) — high-severity per-ticker risk from Risk Analyzer
 *  8.  Conviction Alignment          (0.11) — CM investmentView vs allocation weight
 *  9.  Coverage Quality              (0.09) — stale or missing analytical coverage
 * 10.  Diversification Quality       (0.05) — spread quality by position count
 *
 * NOTE: P&L Quality and Account Health are intentionally excluded.
 * Unrealised P&L measures investment luck, not portfolio construction quality.
 * Empty accounts are an operational artifact, not a portfolio health concern.
 */

import type { PortfolioSnapshot } from "../routes/portfolio-manager.js";
import type {
  PortfolioHealthScore,
  HealthSubScore,
  HealthGrade,
  TargetPortfolio,
} from "./portfolio-manager-v2-types.js";

// ── External context shapes (minimal surface) ─────────────────────────────────

export interface CmHealthData {
  ticker: string;
  sector?: string;
  investmentViewRating?: string; // "Strong Buy" | "Buy" | "Watch" | "Avoid" | "Strong Avoid"
  investmentCaseStrength?: number;
  confidence?: string;
  updatedAt?: string;
}

export interface RiskHealthData {
  topRisks?: Array<{ ticker?: string; severity?: string; title?: string }>;
  overallRiskLevel?: string;
}

export interface TdeHealthData {
  ticker: string;
  blockedByEvent?: boolean;
  readiness?: string;
}

export interface HealthEngineContext {
  target?: TargetPortfolio;
  /** Company Monitor data keyed by uppercase ticker */
  companyMonitorByTicker?: Map<string, CmHealthData>;
  riskAnalyzer?: RiskHealthData;
  /** TDE data keyed by uppercase ticker */
  tdeByTicker?: Map<string, TdeHealthData>;
}

// ── Scoring helpers ────────────────────────────────────────────────────────────

function clamp(n: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, n));
}

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

function gradeFromScore(score: number): HealthGrade {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

// ── Sub-score 1: Max Position Concentration ───────────────────────────────────

function scoreMaxConcentration(maxPositionPercent: number): HealthSubScore {
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

// ── Sub-score 2: Top-3 Concentration ─────────────────────────────────────────

function scoreTop3Concentration(top3Percent: number): HealthSubScore {
  const score = clamp(Math.round(piecewise(top3Percent, [
    [0, 100], [30, 100], [40, 88], [55, 72], [65, 55], [75, 38], [85, 22], [100, 10],
  ])));
  let reason: string;
  if (top3Percent <= 35) reason = `Top-3 positions at ${top3Percent.toFixed(1)}% — excellent spread.`;
  else if (top3Percent <= 55) reason = `Top-3 positions at ${top3Percent.toFixed(1)}% — reasonable concentration.`;
  else if (top3Percent <= 70) reason = `Top-3 positions at ${top3Percent.toFixed(1)}% — portfolio dominated by a few names.`;
  else reason = `Top-3 positions at ${top3Percent.toFixed(1)}% — critical concentration in a handful of positions.`;
  return { name: "Top-3 Concentration", score, weight: 0.11, reason };
}

// ── Sub-score 3: Sector Balance (uses real sector labels, not assetType) ──────

/**
 * Sector lookup priority:
 *  1. Company Monitor company.sector for matched companies
 *  2. Position assetType — only if it is a genuine sector (not "Stock", "ETF", exchange names)
 *  3. "Unknown"
 */
const ASSET_TYPE_IS_NOT_SECTOR = new Set([
  "Stock", "stock", "ETF", "etf", "Bond", "Cfd", "CfdIndex",
  "NASDAQ", "NYSE", "OMX", "LSE", "XETRA", "SIX", "TSX",
]);

function resolveSector(
  assetType: string,
  exchange: string,
  cmData?: CmHealthData
): string {
  if (cmData?.sector && cmData.sector.trim()) return cmData.sector.trim();
  if (assetType && !ASSET_TYPE_IS_NOT_SECTOR.has(assetType)) return assetType;
  return "Unknown";
}

function scoreSectorBalance(
  sectorValueMap: Map<string, number>,
  classifiedPercent: number,
  unknownPercent: number,
  totalMarketValue: number
): HealthSubScore {
  const knownSectors = new Set<string>();
  for (const [s] of sectorValueMap) {
    if (s !== "Unknown") knownSectors.add(s);
  }
  const sectorCount = knownSectors.size;

  // Penalise when most sectors are unknown
  const lowCoverage = classifiedPercent < 40;

  const rawScore = clamp(Math.round(piecewise(sectorCount, [
    [0, 5], [1, 25], [2, 48], [3, 65], [4, 80], [5, 90], [6, 100],
  ])));

  // Dampen score when coverage is mostly unknown
  const score = lowCoverage ? Math.round(rawScore * 0.5) : rawScore;

  let reason: string;
  if (lowCoverage) {
    reason = `Sector data available for only ${classifiedPercent.toFixed(0)}% of portfolio — score is low-confidence.`;
  } else if (sectorCount <= 1) {
    reason = unknownPercent > 20
      ? `Only ${sectorCount} identified sector (${unknownPercent.toFixed(0)}% unknown) — high sector concentration.`
      : "All classified positions in one sector — high sector concentration.";
  } else if (sectorCount === 2) {
    reason = `Two sectors represented — limited sector diversification.`;
  } else if (sectorCount <= 3) {
    reason = `${sectorCount} sectors — moderate sector spread.`;
  } else {
    reason = `${sectorCount} classified sectors — good sector diversification.`;
  }

  return {
    name: "Sector Balance",
    score,
    weight: 0.11,
    reason,
    lowConfidence: lowCoverage,
  };
}

// ── Sub-score 4: Currency Concentration ──────────────────────────────────────

function scoreCurrencyConcentration(foreignPercent: number, positionCount: number): HealthSubScore {
  if (positionCount === 0) {
    return { name: "Currency Concentration", score: 70, weight: 0.08, reason: "No positions — currency exposure not applicable." };
  }
  const score = clamp(Math.round(piecewise(foreignPercent, [
    [0, 65], [5, 75], [15, 88], [30, 100], [50, 90], [60, 78], [75, 62], [85, 48], [100, 35],
  ])));
  let reason: string;
  if (foreignPercent < 5) reason = `Nearly all positions in base currency — minimal FX diversification.`;
  else if (foreignPercent <= 50) reason = `${foreignPercent.toFixed(0)}% in non-base currency — healthy mix.`;
  else reason = `${foreignPercent.toFixed(0)}% in non-base currency — significant FX concentration risk.`;
  return { name: "Currency Concentration", score, weight: 0.08, reason };
}

// ── Sub-score 5: Cash vs Target Alignment ─────────────────────────────────────

function scoreCashAlignment(cashPercent: number, cashTarget: number | null): HealthSubScore {
  if (cashTarget !== null) {
    // When we have a CIO target, score deviation from it
    const dev = Math.abs(cashPercent - cashTarget);
    const score = clamp(Math.round(piecewise(dev, [
      [0, 100], [2, 92], [5, 78], [10, 55], [15, 35], [20, 18], [30, 5],
    ])));
    const dir = cashPercent > cashTarget ? "above" : "below";
    const reason = dev <= 2
      ? `Cash ${cashPercent.toFixed(1)}% is aligned with CIO target ${cashTarget.toFixed(1)}%.`
      : `Cash ${cashPercent.toFixed(1)}% is ${dev.toFixed(1)}pp ${dir} CIO target ${cashTarget.toFixed(1)}%.`;
    return { name: "Cash vs Target Alignment", score, weight: 0.11, reason };
  }
  // No CIO target — score against ideal 5–20% range
  const score = clamp(Math.round(piecewise(cashPercent, [
    [0, 45], [3, 65], [5, 90], [12, 100], [20, 90], [30, 70], [40, 50], [55, 30], [100, 10],
  ])));
  let reason: string;
  if (cashPercent < 3) reason = `Cash at ${cashPercent.toFixed(1)}% — very little buffer.`;
  else if (cashPercent <= 20) reason = `Cash at ${cashPercent.toFixed(1)}% — within the healthy 5–20% range.`;
  else reason = `Cash at ${cashPercent.toFixed(1)}% — above ideal; possible opportunity cost.`;
  return { name: "Cash vs Target Alignment", score, weight: 0.11, reason };
}

// ── Sub-score 6: Event Concentration ─────────────────────────────────────────

function scoreEventConcentration(
  heldTickers: string[],
  tdeByTicker: Map<string, TdeHealthData>,
  positionValueMap: Map<string, number>,
  totalValue: number
): HealthSubScore {
  if (heldTickers.length === 0 || tdeByTicker.size === 0) {
    return {
      name: "Event Concentration",
      score: 80,
      weight: 0.09,
      reason: "No Trade Decision data available — event concentration not assessed.",
      lowConfidence: true,
    };
  }
  let blockedValue = 0;
  const blockedTickers: string[] = [];
  for (const ticker of heldTickers) {
    const tde = tdeByTicker.get(ticker);
    if (tde?.blockedByEvent) {
      blockedValue += positionValueMap.get(ticker) ?? 0;
      blockedTickers.push(ticker);
    }
  }
  const blockedPercent = totalValue > 0 ? (blockedValue / totalValue) * 100 : 0;
  const score = clamp(Math.round(piecewise(blockedPercent, [
    [0, 100], [5, 92], [15, 78], [25, 58], [40, 38], [60, 18], [80, 5],
  ])));
  let reason: string;
  if (blockedTickers.length === 0) {
    reason = "No holdings are event-blocked — good event-risk spread.";
  } else if (blockedPercent < 15) {
    reason = `${blockedTickers.join(", ")} blocked by events — ${blockedPercent.toFixed(0)}% of portfolio. Moderate impact.`;
  } else {
    reason = `${blockedTickers.join(", ")} blocked by events — ${blockedPercent.toFixed(0)}% of portfolio. Significant event concentration.`;
  }
  return { name: "Event Concentration", score, weight: 0.09, reason };
}

// ── Sub-score 7: Risk Concentration ──────────────────────────────────────────

function scoreRiskConcentration(
  heldTickers: string[],
  riskData: RiskHealthData | undefined
): HealthSubScore {
  if (!riskData?.topRisks || riskData.topRisks.length === 0) {
    return {
      name: "Risk Concentration",
      score: 70,
      weight: 0.11,
      reason: "No Risk Analyzer data available — risk concentration not assessed.",
      lowConfidence: true,
    };
  }
  const heldSet = new Set(heldTickers.map((t) => t.toUpperCase()));
  const highRisks = riskData.topRisks.filter(
    (r) => r.severity === "High" || r.severity === "Critical"
  );
  // Count high risks concentrated in a single ticker
  const tickerRiskCount = new Map<string, number>();
  for (const r of highRisks) {
    if (r.ticker && heldSet.has(r.ticker.toUpperCase())) {
      const t = r.ticker.toUpperCase();
      tickerRiskCount.set(t, (tickerRiskCount.get(t) ?? 0) + 1);
    }
  }
  const maxTickerRisks = tickerRiskCount.size > 0 ? Math.max(...tickerRiskCount.values()) : 0;
  const totalHighRisks = highRisks.length;

  const score = clamp(Math.round(piecewise(maxTickerRisks, [
    [0, 95], [1, 82], [2, 65], [3, 48], [4, 30], [5, 15],
  ])));

  let reason: string;
  if (maxTickerRisks === 0 && totalHighRisks === 0) {
    reason = "No high-severity risks identified — strong risk profile.";
  } else if (maxTickerRisks === 0) {
    reason = `${totalHighRisks} high-severity risk(s) identified but none concentrated in a single holding.`;
  } else {
    const [worstTicker] = [...tickerRiskCount.entries()]
      .sort((a, b) => b[1] - a[1])[0];
    reason = `${worstTicker} has ${maxTickerRisks} high-severity risk(s) — concentrated risk exposure.`;
  }
  return { name: "Risk Concentration", score, weight: 0.11, reason };
}

// ── Sub-score 8: Conviction Alignment ────────────────────────────────────────

const INVESTMENT_VIEW_SCORE: Record<string, number> = {
  "Strong Buy": 100,
  "Buy":        80,
  "Watch":      50,
  "Avoid":      20,
  "Strong Avoid": 5,
};

function scoreConvictionAlignment(
  heldTickers: string[],
  positionValueMap: Map<string, number>,
  totalMarketValue: number,
  cmByTicker: Map<string, CmHealthData>
): HealthSubScore {
  if (heldTickers.length === 0 || cmByTicker.size === 0) {
    return {
      name: "Conviction Alignment",
      score: 65,
      weight: 0.11,
      reason: "No Company Monitor data — conviction alignment not assessed.",
      lowConfidence: true,
    };
  }

  let coveredValue = 0;
  let weightedConviction = 0;
  let misalignedTickers: string[] = [];

  for (const ticker of heldTickers) {
    const cm = cmByTicker.get(ticker);
    const value = positionValueMap.get(ticker) ?? 0;
    const weight = totalMarketValue > 0 ? value / totalMarketValue : 0;

    if (!cm?.investmentViewRating) continue;
    coveredValue += value;
    const convScore = INVESTMENT_VIEW_SCORE[cm.investmentViewRating] ?? 50;
    weightedConviction += convScore * weight;

    // Flag misalignment: large position in Avoid / Strong Avoid
    if ((cm.investmentViewRating === "Avoid" || cm.investmentViewRating === "Strong Avoid") && weight > 0.05) {
      misalignedTickers.push(ticker);
    }
  }

  const coveredPercent = totalMarketValue > 0 ? (coveredValue / totalMarketValue) * 100 : 0;

  if (coveredPercent < 30) {
    return {
      name: "Conviction Alignment",
      score: 60,
      weight: 0.11,
      reason: `Company Monitor covers only ${coveredPercent.toFixed(0)}% of portfolio by value — limited conviction data.`,
      lowConfidence: true,
    };
  }

  const normalised = totalMarketValue > 0
    ? (weightedConviction / (coveredValue / totalMarketValue))
    : weightedConviction;
  const score = clamp(Math.round(normalised));

  let reason: string;
  if (misalignedTickers.length > 0) {
    reason = `Positions in ${misalignedTickers.join(", ")} have Avoid/Strong Avoid view — poor conviction alignment.`;
  } else if (score >= 80) {
    reason = `Portfolio is predominantly in Buy/Strong Buy rated companies — strong conviction alignment.`;
  } else if (score >= 55) {
    reason = `Mixed investment views across portfolio — moderate conviction alignment.`;
  } else {
    reason = `Several holdings have cautious or negative investment views — weak conviction alignment.`;
  }
  return { name: "Conviction Alignment", score, weight: 0.11, reason };
}

// ── Sub-score 9: Coverage Quality ────────────────────────────────────────────

const STALE_COVERAGE_HOURS = 72; // 3 days

function scoreCoverageQuality(
  heldTickers: string[],
  positionValueMap: Map<string, number>,
  totalMarketValue: number,
  cmByTicker: Map<string, CmHealthData>
): HealthSubScore {
  if (heldTickers.length === 0) {
    return { name: "Coverage Quality", score: 75, weight: 0.09, reason: "No positions to assess coverage for." };
  }
  if (cmByTicker.size === 0) {
    return {
      name: "Coverage Quality",
      score: 30,
      weight: 0.09,
      reason: "No Company Monitor analyses found — analytical coverage is absent.",
      lowConfidence: true,
    };
  }

  const now = Date.now();
  let coveredValue = 0;
  let staleValue = 0;
  let missingTickers: string[] = [];
  let staleTickers: string[] = [];

  for (const ticker of heldTickers) {
    const val = positionValueMap.get(ticker) ?? 0;
    const cm = cmByTicker.get(ticker);
    if (!cm) {
      missingTickers.push(ticker);
      continue;
    }
    coveredValue += val;
    if (cm.updatedAt) {
      const ageHours = (now - new Date(cm.updatedAt).getTime()) / 3_600_000;
      if (ageHours > STALE_COVERAGE_HOURS) {
        staleValue += val;
        staleTickers.push(ticker);
      }
    }
  }

  const coveragePercent = totalMarketValue > 0 ? (coveredValue / totalMarketValue) * 100 : 0;
  const stalePercent = totalMarketValue > 0 ? (staleValue / totalMarketValue) * 100 : 0;
  const missingPercent = 100 - coveragePercent;

  const score = clamp(Math.round(
    piecewise(coveragePercent, [[0, 10], [30, 30], [50, 50], [70, 70], [85, 85], [100, 100]]) -
    piecewise(stalePercent, [[0, 0], [10, 5], [25, 12], [50, 20]])
  ));

  let reason: string;
  if (missingTickers.length === 0 && staleTickers.length === 0) {
    reason = "All holdings have current Company Monitor coverage — excellent analytical quality.";
  } else if (missingTickers.length > 0 && staleTickers.length > 0) {
    reason = `${missingTickers.join(", ")} lack coverage; ${staleTickers.join(", ")} are stale (>${STALE_COVERAGE_HOURS}h).`;
  } else if (missingTickers.length > 0) {
    reason = `${missingTickers.join(", ")} lack Company Monitor coverage.`;
  } else {
    reason = `${staleTickers.join(", ")} have stale Company Monitor data (>${STALE_COVERAGE_HOURS}h old).`;
  }
  return { name: "Coverage Quality", score, weight: 0.09, reason };
}

// ── Sub-score 10: Diversification Quality ────────────────────────────────────

function scoreDiversificationQuality(positionCount: number): HealthSubScore {
  const score = clamp(Math.round(piecewise(positionCount, [
    [0, 10], [1, 25], [2, 42], [3, 57], [5, 72], [7, 83], [10, 92], [15, 100],
    [25, 90], [35, 72], [50, 50],
  ])));
  let reason: string;
  if (positionCount === 0) reason = "No positions — portfolio is entirely cash.";
  else if (positionCount <= 2) reason = `Only ${positionCount} position${positionCount === 1 ? "" : "s"} — highly concentrated.`;
  else if (positionCount <= 5) reason = `${positionCount} positions — limited diversification.`;
  else if (positionCount <= 15) reason = `${positionCount} positions — well-diversified.`;
  else if (positionCount <= 30) reason = `${positionCount} positions — broad portfolio; tracking effort is high.`;
  else reason = `${positionCount} positions — over-diversified; difficult to maintain conviction.`;
  return { name: "Diversification Quality", score, weight: 0.05, reason };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function computePortfolioHealth(
  snapshot: PortfolioSnapshot,
  context?: HealthEngineContext
): PortfolioHealthScore {
  const allPositions    = snapshot.accounts.flatMap((a) => a.positions);
  const positionCount   = allPositions.length;
  const totalValue      = snapshot.totalValue ?? 0;
  const cash            = snapshot.totalAvailableCash ?? 0;
  const cashPercent     = totalValue > 0 ? (cash / totalValue) * 100 : 0;
  const cmByTicker      = context?.companyMonitorByTicker ?? new Map<string, CmHealthData>();
  const tdeByTicker     = context?.tdeByTicker ?? new Map<string, TdeHealthData>();
  const riskData        = context?.riskAnalyzer;
  const cashTarget      = context?.target?.cashTargetPercent ?? null;

  // ── Market value map ───────────────────────────────────────────────────────
  const positionValueMap = new Map<string, number>();
  for (const pos of allPositions) {
    const ticker = pos.symbol.toUpperCase().trim();
    positionValueMap.set(ticker, (positionValueMap.get(ticker) ?? 0) + pos.marketValueBaseCurrency);
  }

  const totalMarketValue = [...positionValueMap.values()].reduce((s, v) => s + v, 0);
  const heldTickers      = [...positionValueMap.keys()];

  // ── Concentration metrics ──────────────────────────────────────────────────
  const marketValues     = allPositions.map((p) => p.marketValueBaseCurrency);
  const maxPositionPct   = totalValue > 0 && positionCount > 0
    ? (Math.max(0, ...marketValues) / totalValue) * 100 : 0;
  const sorted           = [...marketValues].sort((a, b) => b - a);
  const top3Sum          = sorted.slice(0, 3).reduce((s, v) => s + v, 0);
  const top3Percent      = totalValue > 0 ? (top3Sum / totalValue) * 100 : 0;

  // ── Sector classification (using CM sector where available) ───────────────
  const sectorValueMap = new Map<string, number>();
  let unknownValue = 0;
  let classifiedValue = 0;

  for (const pos of allPositions) {
    const ticker = pos.symbol.toUpperCase().trim();
    const cm = cmByTicker.get(ticker);
    const sector = resolveSector(pos.assetType, pos.exchange, cm);
    sectorValueMap.set(sector, (sectorValueMap.get(sector) ?? 0) + pos.marketValueBaseCurrency);
    if (sector === "Unknown") unknownValue += pos.marketValueBaseCurrency;
    else classifiedValue += pos.marketValueBaseCurrency;
  }

  const classifiedPositionPercent = totalMarketValue > 0 ? (classifiedValue / totalMarketValue) * 100 : 0;
  const unknownSectorPercent      = totalMarketValue > 0 ? (unknownValue  / totalMarketValue) * 100 : 0;
  const sectorCoverageConfidence: "High" | "Medium" | "Low" =
    classifiedPositionPercent >= 70 ? "High" :
    classifiedPositionPercent >= 40 ? "Medium" : "Low";

  // ── Currency exposure ──────────────────────────────────────────────────────
  const foreignValue   = allPositions
    .filter((p) => p.currency && p.currency !== snapshot.baseCurrency)
    .reduce((s, p) => s + p.marketValueBaseCurrency, 0);
  const foreignPercent = totalMarketValue > 0 ? (foreignValue / totalMarketValue) * 100 : 0;

  // ── Assemble sub-scores ────────────────────────────────────────────────────
  const subScores: HealthSubScore[] = [
    scoreMaxConcentration(maxPositionPct),
    scoreTop3Concentration(top3Percent),
    scoreSectorBalance(sectorValueMap, classifiedPositionPercent, unknownSectorPercent, totalMarketValue),
    scoreCurrencyConcentration(foreignPercent, positionCount),
    scoreCashAlignment(cashPercent, cashTarget),
    scoreEventConcentration(heldTickers, tdeByTicker, positionValueMap, totalValue),
    scoreRiskConcentration(heldTickers, riskData),
    scoreConvictionAlignment(heldTickers, positionValueMap, totalMarketValue, cmByTicker),
    scoreCoverageQuality(heldTickers, positionValueMap, totalMarketValue, cmByTicker),
    scoreDiversificationQuality(positionCount),
  ];

  const overall = clamp(
    Math.round(subScores.reduce((sum, s) => sum + s.score * s.weight, 0))
  );

  return {
    overall,
    grade: gradeFromScore(overall),
    subScores,
    computedAt: new Date().toISOString(),
    classifiedPositionPercent: Math.round(classifiedPositionPercent * 10) / 10,
    unknownSectorPercent:      Math.round(unknownSectorPercent * 10) / 10,
    sectorCoverageConfidence,
  };
}
