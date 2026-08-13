/**
 * Portfolio Intelligence Engine
 *
 * Computes Portfolio-Analyzer-specific deterministic facts on top of the
 * shared Risk Intelligence Engine foundation.  No OpenAI calls are made here.
 *
 * Usage:
 *   const { riskFacts, fingerprint: riskFp } = computeRiskFacts(nowIso);
 *   const { portfolioFacts, fingerprint } = computePortfolioFacts(nowIso, riskFacts);
 *
 * Types and the pure computePortfolioFactsFingerprint() function live in
 * portfolio-facts.ts so they can be imported and tested without pulling in
 * this file's dependency chain (price-context-service → saxo-store → pino).
 */
import { analysisRepository } from "./analysis-repository.js";
import { getPriceContext } from "./price-context-service.js";
import type { RiskFacts } from "./risk-facts.js";
import {
  computePortfolioFactsFingerprint,
  type CompanyStateFacts,
  type HoldingPerformance,
  type PortfolioFacts,
  type PortfolioIntelligenceResult,
  type PortfolioPerformanceFacts,
  type PortfolioUpcomingEvent,
} from "./portfolio-facts.js";

// Re-export for single-import convenience from route files.
export {
  computePortfolioFactsFingerprint,
  type PortfolioFacts,
  type HoldingPerformance,
  type PortfolioPerformanceFacts,
  type CompanyStateFacts,
  type PortfolioIntelligenceResult,
  type PortfolioUpcomingEvent,
} from "./portfolio-facts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute PortfolioFacts from current repository state.
 *
 * @param nowIso   Current UTC timestamp (ISO 8601).
 * @param riskFacts Already-computed RiskFacts from computeRiskFacts(nowIso).
 *                  Avoids duplicate position/sector/event work.
 * @returns { portfolioFacts, fingerprint }
 */
export function computePortfolioFacts(
  nowIso: string,
  riskFacts: RiskFacts,
): PortfolioIntelligenceResult {
  // ── Read all positions from repo for performance calculation ──────────────
  // The risk engine exposes only top-5 positions. For per-holding returns and
  // portfolio-level weighted returns we need all positions.
  const portfolioEntry = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  const portfolioResult = (portfolioEntry?.result ?? {}) as Record<string, unknown>;
  const accounts: Array<Record<string, unknown>> = Array.isArray(portfolioResult.accounts)
    ? (portfolioResult.accounts as Array<Record<string, unknown>>)
    : [];

  const rawPositions: Array<{ symbol: string; marketValueBase: number }> = [];
  for (const account of accounts) {
    const posArr = Array.isArray(account.positions)
      ? (account.positions as Array<Record<string, unknown>>)
      : [];
    for (const pos of posArr) {
      const mvb =
        typeof pos.marketValueBaseCurrency === "number" ? pos.marketValueBaseCurrency : 0;
      rawPositions.push({
        symbol: String(pos.symbol ?? "").toUpperCase(),
        marketValueBase: mvb,
      });
    }
  }

  // ── Aggregate market values by ticker across all accounts ──────────────
  // The same symbol can be held in multiple accounts with different market
  // values. Accumulate before computing weights so each ticker has exactly
  // one correct weight entry and produces exactly one perHolding row.
  const tickerValues: Record<string, number> = {};
  for (const pos of rawPositions) {
    tickerValues[pos.symbol] = (tickerValues[pos.symbol] ?? 0) + pos.marketValueBase;
  }

  const totalInvested = Object.values(tickerValues).reduce((s, v) => s + v, 0);

  // invested-weight map — one entry per unique ticker
  const investedWeightMap: Record<string, number> = {};
  if (totalInvested > 0) {
    for (const [symbol, mv] of Object.entries(tickerValues)) {
      investedWeightMap[symbol] = (mv / totalInvested) * 100;
    }
  }

  // ── Per-holding performance (one row per unique ticker) ───────────────────
  // Collect PriceContext asOf timestamps to surface source data freshness.
  // Policy: expose the oldest (minimum) asOf so callers know the worst-case
  // data age — "all prices used here are at least this fresh."
  const priceAsOfs: string[] = [];

  const perHolding: HoldingPerformance[] = Object.keys(tickerValues).map((symbol) => {
    const investedW = investedWeightMap[symbol] ?? 0;
    const ctx = getPriceContext(symbol);

    if (!ctx?.returns) {
      return {
        ticker: symbol,
        investedWeightPct: r1(investedW),
        return1D: null,
        return5D: null,
        return1M: null,
        contribution1DPct: null,
      };
    }

    if (ctx.asOf) priceAsOfs.push(ctx.asOf);

    const r1d =
      typeof ctx.returns.oneDayPct === "number" ? ctx.returns.oneDayPct : null;
    const r5d =
      typeof ctx.returns.fiveDayPct === "number" ? ctx.returns.fiveDayPct : null;
    const r1m =
      typeof ctx.returns.thirtyDayPct === "number" ? ctx.returns.thirtyDayPct : null;

    return {
      ticker: symbol,
      investedWeightPct: r1(investedW),
      return1D: r1d !== null ? r2(r1d) : null,
      return5D: r5d !== null ? r2(r5d) : null,
      return1M: r1m !== null ? r2(r1m) : null,
      contribution1DPct: r1d !== null ? r2((investedW / 100) * r1d) : null,
    };
  });

  // Oldest (most conservative) asOf across covered holdings; null if none.
  const priceDataAsOf: string | null =
    priceAsOfs.length > 0
      ? priceAsOfs.reduce((oldest, t) => (t < oldest ? t : oldest))
      : null;

  // ── Contributors / detractors (by 1D contribution) ───────────────────────

  const withContrib = perHolding.filter((h) => h.contribution1DPct !== null);
  const sortedContrib = [...withContrib].sort(
    (a, b) => (b.contribution1DPct ?? 0) - (a.contribution1DPct ?? 0)
  );
  const topContributors = sortedContrib
    .filter((h) => (h.contribution1DPct ?? 0) > 0)
    .slice(0, 3);
  const topDetractors = sortedContrib
    .filter((h) => (h.contribution1DPct ?? 0) < 0)
    .reverse()
    .slice(0, 3);

  // ── Portfolio-level weighted returns ──────────────────────────────────────
  // Only returns from positions with available data are included.
  // We report the result with a note that it may be partial if some positions
  // lack price context; callers should check if perHolding has nulls.

  function weightedAvgReturn(
    key: "return1D" | "return5D" | "return1M"
  ): number | null {
    let weightSum = 0;
    let weightedReturn = 0;
    for (const h of perHolding) {
      const ret = h[key];
      if (ret === null) continue;
      const w = h.investedWeightPct;
      weightedReturn += (w / 100) * ret;
      weightSum += w / 100;
    }
    if (weightSum === 0) return null;
    // Normalise: if only 60% of the portfolio has data, scale by coverage
    return r2(weightedReturn / weightSum);
  }

  const portfolioReturn1D = weightedAvgReturn("return1D");
  const portfolioReturn5D = weightedAvgReturn("return5D");
  const portfolioReturn1M = weightedAvgReturn("return1M");

  const performance: PortfolioPerformanceFacts = {
    perHolding,
    topContributors,
    topDetractors,
    portfolioReturn1D,
    portfolioReturn5D,
    portfolioReturn1M,
    priceDataAsOf,
  };

  // ── Company state (derived from riskFacts.companyRisk) ─────────────────
  // Deduplicate by ticker: multiple thesis points can change for the same
  // company; we report unique tickers.
  const companyState: CompanyStateFacts = {
    strengthenedHoldings: [...new Set(riskFacts.companyRisk.strengthenedTheses.map((t) => t.ticker))],
    weakenedHoldings: [...new Set(riskFacts.companyRisk.weakenedTheses.map((t) => t.ticker))],
    invalidatedHoldings: [...new Set(riskFacts.companyRisk.invalidatedTheses.map((t) => t.ticker))],
    lowCaseStrength: riskFacts.companyRisk.lowCaseStrength,
    viewDistribution: riskFacts.companyRisk.viewDistribution,
    avoidViewHoldings: riskFacts.companyRisk.avoidViewHoldings,
  };

  // ── Upcoming events (reuse riskFacts.eventRisk — already filtered) ────────
  const upcomingHoldingEvents: PortfolioUpcomingEvent[] =
    riskFacts.eventRisk.eventsNext7Days.map((e) => ({
      title: e.title,
      date: e.date,
      importance: e.importance,
      affectedHoldings: e.affectedHoldings,
    }));

  // ── Notable facts (plain-language for prompt grounding) ───────────────────
  const notableFacts: string[] = [];

  // Performance
  if (portfolioReturn1D !== null) {
    const dir = portfolioReturn1D >= 0 ? "gained" : "lost";
    const abs = Math.abs(portfolioReturn1D).toFixed(2);
    notableFacts.push(`Portfolio ${dir} ${abs}% today (weighted average of available data)`);
  }
  if (topContributors.length > 0) {
    const names = topContributors.map((h) => `${h.ticker}(+${h.return1D?.toFixed(2) ?? "?"}%)`).join(", ");
    notableFacts.push(`Today's top contributors: ${names}`);
  }
  if (topDetractors.length > 0) {
    const names = topDetractors.map((h) => `${h.ticker}(${h.return1D?.toFixed(2) ?? "?"}%)`).join(", ");
    notableFacts.push(`Today's top detractors: ${names}`);
  }

  // Risk flags from engine (already covers concentration/sector/event/company signals)
  notableFacts.push(...riskFacts.portfolioRiskFlags);

  // ── Market / sector material versions for fingerprint ────────────────────
  const marketEntry = analysisRepository.get("market-monitor");
  const sectorEntry = analysisRepository.get("sector-monitor");
  const marketVersion = (marketEntry as { materialVersion?: number } | undefined)?.materialVersion ?? 0;
  const sectorVersion = (sectorEntry as { materialVersion?: number } | undefined)?.materialVersion ?? 0;

  // ── Assemble PortfolioFacts ───────────────────────────────────────────────

  const portfolioFacts: PortfolioFacts = {
    portfolio: {
      totalValue: riskFacts.portfolioValue,
      cashPct: riskFacts.cashPct,
      holdingCount: riskFacts.numberOfHoldings,
      baseCurrency: riskFacts.baseCurrency,
    },
    performance,
    allocation: {
      topPositions: riskFacts.concentration.topPositions.map((p) => ({
        ticker: p.ticker,
        investedWeightPct: p.investedWeightPct,
        sector: p.sector,
      })),
      sectorExposure: riskFacts.sectors.exposures,
      currencyExposure: riskFacts.currencies.exposures,
      largestPositionTicker: riskFacts.concentration.largestPositionTicker,
      largestPositionPct: riskFacts.concentration.largestPositionPct,
      top3Pct: riskFacts.concentration.top3Pct,
      top3Tickers: riskFacts.concentration.top3Tickers,
    },
    priceBehavior: {
      strongUptrendPct: riskFacts.priceRisk.strongUptrendPct,
      strongUptrendHoldings: riskFacts.priceRisk.strongUptrendHoldings,
      strongDowntrendPct: riskFacts.priceRisk.strongDowntrendPct,
      strongDowntrendHoldings: riskFacts.priceRisk.strongDowntrendHoldings,
      highVolatilityPct: riskFacts.priceRisk.highVolatilityPct,
      highVolatilityHoldings: riskFacts.priceRisk.highVolatilityHoldings,
      fallingFastHoldings: riskFacts.priceRisk.fallingFastHoldings,
      risingHoldings: riskFacts.priceRisk.risingHoldings,
      stabilizingFromDowntrendHoldings: riskFacts.priceRisk.stabilizingFromDowntrendHoldings,
      perPositionState: riskFacts.priceRisk.perPositionState,
    },
    companyState,
    events: { upcomingHoldingEvents },
    notableFacts,
  };

  const fingerprint = computePortfolioFactsFingerprint(
    portfolioFacts,
    marketVersion,
    sectorVersion,
  );

  return { portfolioFacts, fingerprint };
}

// ─────────────────────────────────────────────────────────────────────────────
// Compact representation for the AI prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce a compact, AI-ready version of PortfolioFacts.
 *
 * Strips fields that are redundant or excessive in a prompt context:
 * - perHolding full array (AI gets topContributors/topDetractors and the
 *   company/price contexts for detailed per-holding reasoning)
 * - perPositionState detail (AI uses price context snippets instead)
 *
 * Keeps everything the AI needs to reason about portfolio health,
 * allocation, performance, and company state.
 */
export function buildSlimPortfolioFacts(facts: PortfolioFacts): Record<string, unknown> {
  return {
    portfolio: facts.portfolio,
    performance: {
      portfolioReturn1D: facts.performance.portfolioReturn1D,
      portfolioReturn5D: facts.performance.portfolioReturn5D,
      portfolioReturn1M: facts.performance.portfolioReturn1M,
      topContributors: facts.performance.topContributors.map((h) => ({
        ticker: h.ticker,
        investedWeightPct: h.investedWeightPct,
        return1DPct: h.return1D,
        contribution1DPct: h.contribution1DPct,
      })),
      topDetractors: facts.performance.topDetractors.map((h) => ({
        ticker: h.ticker,
        investedWeightPct: h.investedWeightPct,
        return1DPct: h.return1D,
        contribution1DPct: h.contribution1DPct,
      })),
      perHolding5D: facts.performance.perHolding
        .filter((h) => h.return5D !== null)
        .map((h) => ({ ticker: h.ticker, return5DPct: h.return5D })),
    },
    allocation: facts.allocation,
    priceBehavior: {
      strongUptrendPct: facts.priceBehavior.strongUptrendPct,
      strongUptrendHoldings: facts.priceBehavior.strongUptrendHoldings,
      strongDowntrendPct: facts.priceBehavior.strongDowntrendPct,
      strongDowntrendHoldings: facts.priceBehavior.strongDowntrendHoldings,
      highVolatilityPct: facts.priceBehavior.highVolatilityPct,
      highVolatilityHoldings: facts.priceBehavior.highVolatilityHoldings,
      fallingFastHoldings: facts.priceBehavior.fallingFastHoldings,
      risingHoldings: facts.priceBehavior.risingHoldings,
      stabilizingFromDowntrendHoldings: facts.priceBehavior.stabilizingFromDowntrendHoldings,
    },
    companyState: facts.companyState,
    events: facts.events,
    notableFacts: facts.notableFacts,
  };
}
