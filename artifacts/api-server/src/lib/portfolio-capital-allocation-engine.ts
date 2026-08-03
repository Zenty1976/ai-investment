/**
 * Portfolio Capital Allocation Engine
 *
 * Determines how available cash should be deployed to close the gap between
 * the current portfolio and the target allocation.
 *
 * Logic:
 * 1. Compute the cash floor: cashTargetPercent × totalValue = minimum cash to retain.
 * 2. Deployable cash = available cash − cash floor (clamped to ≥ 0).
 * 3. Compute the aggregate target-gap value: sum of (gapPercent × totalValue / 100)
 *    for all underweight/missing positions.
 * 4. Effective deployable = min(deployable cash, aggregate gap value).
 *    Cash above the aggregate gap has no valid deployment target and is left as
 *    residual rather than pushing any position beyond its target.
 * 5. For each gap, suggest min(proportional share of effective deployable, position gap value).
 *    This ensures no position's suggestion exceeds its actual target gap in dollars.
 *
 * No AI calls — purely deterministic.
 */

import type { PortfolioSnapshot } from "../routes/portfolio-manager.js";
import type {
  TargetPortfolio,
  CapitalAllocationPlan,
  CapitalAllocationItem,
} from "./portfolio-manager-v2-types.js";

export function computeCapitalAllocation(
  snapshot: PortfolioSnapshot,
  target: TargetPortfolio
): CapitalAllocationPlan {
  const totalValue     = snapshot.totalValue ?? 0;
  const availableCash  = snapshot.totalAvailableCash ?? 0;
  const cashPercent    = totalValue > 0 ? (availableCash / totalValue) * 100 : 0;
  const cashFloor      = (target.cashTargetPercent / 100) * totalValue;
  const deployableCash = Math.max(0, availableCash - cashFloor);
  const now            = new Date().toISOString();

  if (totalValue === 0 || deployableCash <= 0) {
    return {
      availableCashBase:              Math.round(availableCash),
      totalPortfolioBase:             Math.round(totalValue),
      cashPercent:                    Math.round(cashPercent * 10) / 10,
      cashTargetPercent:              target.cashTargetPercent,
      deployableCashBase:             0,
      items:                          [],
      totalSuggestedDeploymentBase:   0,
      residualCashAfterDeploymentBase: Math.round(availableCash),
      computedAt: now,
    };
  }

  // Build current market value map
  const allPositions = snapshot.accounts.flatMap((a) => a.positions);
  const currentMarketValue = new Map<string, number>();
  for (const pos of allPositions) {
    const ticker = pos.symbol.toUpperCase().trim();
    currentMarketValue.set(ticker, (currentMarketValue.get(ticker) ?? 0) + pos.marketValueBaseCurrency);
  }

  // Build list of underweight / missing target positions with their dollar gap
  interface Gap {
    ticker: string;
    company: string;
    role: TargetPortfolio["allocations"][0]["role"];
    currentPercent: number;
    targetPercent: number;
    gapPercent: number;
    /** Exact dollar value needed to reach target from current — the hard cap */
    gapValueBase: number;
  }

  const gaps: Gap[] = [];

  for (const alloc of target.allocations) {
    const ticker     = alloc.ticker.toUpperCase();
    const currentVal = currentMarketValue.get(ticker) ?? 0;
    const currentPct = totalValue > 0 ? (currentVal / totalValue) * 100 : 0;
    const gapPct     = alloc.targetPercent - currentPct;

    if (gapPct >= 1) {
      gaps.push({
        ticker,
        company:        alloc.company,
        role:           alloc.role,
        currentPercent: Math.round(currentPct  * 10) / 10,
        targetPercent:  alloc.targetPercent,
        gapPercent:     Math.round(gapPct      * 10) / 10,
        gapValueBase:   (gapPct / 100) * totalValue,
      });
    }
  }

  // Sort by gap size descending
  gaps.sort((a, b) => b.gapPercent - a.gapPercent);

  if (gaps.length === 0) {
    return {
      availableCashBase:              Math.round(availableCash),
      totalPortfolioBase:             Math.round(totalValue),
      cashPercent:                    Math.round(cashPercent * 10) / 10,
      cashTargetPercent:              target.cashTargetPercent,
      deployableCashBase:             Math.round(deployableCash),
      items:                          [],
      totalSuggestedDeploymentBase:   0,
      residualCashAfterDeploymentBase: Math.round(availableCash),
      computedAt: now,
    };
  }

  // ── Effective deployable cap ──────────────────────────────────────────────────
  // Do not deploy more than the sum of all target gaps. Excess cash above
  // this amount has no valid position target and must stay as residual.
  const totalGapPct       = gaps.reduce((s, g) => s + g.gapPercent, 0);
  const totalGapValueBase = gaps.reduce((s, g) => s + g.gapValueBase, 0);
  const effectiveDeployable = Math.min(deployableCash, totalGapValueBase);

  // ── Per-position deployment ───────────────────────────────────────────────────
  // Proportional allocation across gaps, but each item is also capped at its
  // own dollar gap so it cannot be pushed past its target.
  const items: CapitalAllocationItem[] = [];

  for (const gap of gaps) {
    const proportion = totalGapPct > 0 ? gap.gapPercent / totalGapPct : 1 / gaps.length;
    const proportionalShare = effectiveDeployable * proportion;
    // Hard cap: never suggest more than what is needed to reach the target
    const suggestedAmount = Math.round(Math.min(proportionalShare, gap.gapValueBase));

    const priority: "High" | "Medium" | "Low" =
      gap.gapPercent >= 8 ? "High" :
      gap.gapPercent >= 4 ? "Medium" : "Low";

    const rationale =
      gap.currentPercent === 0
        ? `${gap.ticker} is a target position with no current holding — open a new position`
        : `${gap.ticker} is ${gap.gapPercent.toFixed(1)}% below target; add to close the gap`;

    items.push({
      ticker:              gap.ticker,
      company:             gap.company,
      role:                gap.role,
      currentPercent:      gap.currentPercent,
      targetPercent:       gap.targetPercent,
      gapPercent:          gap.gapPercent,
      suggestedAmountBase: suggestedAmount,
      priority,
      rationale,
    });
  }

  const totalSuggested = items.reduce((s, i) => s + i.suggestedAmountBase, 0);

  return {
    availableCashBase:              Math.round(availableCash),
    totalPortfolioBase:             Math.round(totalValue),
    cashPercent:                    Math.round(cashPercent * 10) / 10,
    cashTargetPercent:              target.cashTargetPercent,
    deployableCashBase:             Math.round(deployableCash),
    items,
    totalSuggestedDeploymentBase:   Math.round(totalSuggested),
    residualCashAfterDeploymentBase: Math.round(availableCash - totalSuggested),
    computedAt: now,
  };
}
