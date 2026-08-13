/**
 * Portfolio Intelligence Route
 *
 * Exposes deterministic PortfolioFacts computed by the Portfolio Intelligence
 * Engine — no OpenAI calls. This endpoint returns current portfolio performance
 * data (returns, contributors/detractors, price coverage) that can be polled
 * independently of the AI Portfolio Analyzer.
 *
 * The underlying computations were introduced in task #61:
 *   computeRiskFacts()        → shared position weights, sectors, price behavior
 *   computePortfolioFacts()   → PA-specific returns, contributions, company state
 *
 * Price data freshness: the "computedAt" field reflects when this request was
 * served. Price context data comes from the analysis repository's stored
 * PriceContext entries (updated by the orchestrator on each price cycle).
 */
import { Router, type IRouter } from "express";
import { analysisRepository } from "../lib/analysis-repository.js";
import { computeRiskFacts } from "../lib/risk-intelligence-engine.js";
import { computePortfolioFacts } from "../lib/portfolio-intelligence-engine.js";

const router: IRouter = Router();

router.get("/portfolio-intelligence/performance", (req, res): void => {
  // Require portfolio data — performance is meaningless without positions.
  const portfolioEntry = analysisRepository.get("portfolio-manager");
  if (!portfolioEntry) {
    res.status(400).json({
      error: "No portfolio data available. Run Portfolio Manager first.",
    });
    return;
  }

  const nowIso = new Date().toISOString();

  try {
    const { riskFacts } = computeRiskFacts(nowIso);
    const { portfolioFacts } = computePortfolioFacts(nowIso, riskFacts);

    const perf = portfolioFacts.performance;

    // ── Price coverage ─────────────────────────────────────────────────────
    // Coverage = % of invested capital that has a valid PriceContext entry.
    // investedWeightPct sums to ~100 across all holdings (excl. cash).
    const totalWeight = perf.perHolding.reduce((s, h) => s + h.investedWeightPct, 0);
    const coveredWeight = perf.perHolding
      .filter((h) => h.return1D !== null)
      .reduce((s, h) => s + h.investedWeightPct, 0);
    const priceCoveragePct =
      totalWeight > 0 ? Math.round((coveredWeight / totalWeight) * 100) : null;
    const missingPriceCount = perf.perHolding.filter((h) => h.return1D === null).length;

    res.json({
      portfolio: portfolioFacts.portfolio,
      portfolioReturn1D: perf.portfolioReturn1D,
      portfolioReturn5D: perf.portfolioReturn5D,
      portfolioReturn1M: perf.portfolioReturn1M,
      topContributors: perf.topContributors.map((h) => ({
        ticker: h.ticker,
        investedWeightPct: h.investedWeightPct,
        return1D: h.return1D,
        contribution1DPct: h.contribution1DPct,
      })),
      topDetractors: perf.topDetractors.map((h) => ({
        ticker: h.ticker,
        investedWeightPct: h.investedWeightPct,
        return1D: h.return1D,
        contribution1DPct: h.contribution1DPct,
      })),
      priceCoveragePct,
      missingPriceCount,
      computedAt: nowIso,
    });
  } catch (err) {
    req.log.error({ err }, "portfolio-intelligence/performance computation failed");
    res.status(500).json({
      error: "Failed to compute portfolio performance data.",
    });
  }
});

export default router;
