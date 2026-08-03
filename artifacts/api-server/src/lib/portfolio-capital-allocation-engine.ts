/**
 * Portfolio Capital Allocation Engine
 *
 * Determines how available cash should be deployed to close the gap between
 * the current portfolio and the target allocation.
 *
 * Deployment gates (items are only actionable when ALL conditions hold):
 *  1. allocationStatus === "StrategicTarget" (missing → treated as StrategicTarget)
 *  2. No TDE entry exists for the ticker, OR TDE readiness === "ReadyForReview"
 *  3. TDE blockedByEvent === false (or no TDE entry)
 *
 * Items failing these gates are surfaced in blockedItems or provisionalItems
 * with suggestedAmountBase = 0, so the UI can explain why cash is not deployed.
 *
 * Excluded allocations are returned in excludedItems — they are deliberately
 * out of scope, not merely pending evidence, and must never appear as provisional.
 *
 * IMMUTABILITY GUARANTEE:
 *   This function never mutates the supplied TargetPortfolio or its allocations.
 *   An effectiveStatus local variable absorbs TDE-driven status changes.
 *
 * Backward compatibility:
 *   plan.items is always equal to plan.actionableItems so existing consumers
 *   continue to work.
 */

import type { PortfolioSnapshot } from "../routes/portfolio-manager.js";
import type {
  TargetPortfolio,
  CapitalAllocationPlan,
  CapitalAllocationItem,
  AllocationStatus,
  PortfolioRole,
} from "./portfolio-manager-v2-types.js";

// ── TDE readiness input ───────────────────────────────────────────────────────

export interface TdeCapitalData {
  readiness: string;
  blockedByEvent: boolean;
  blockingEvent?: string;
}

// ── Gap record (internal) ─────────────────────────────────────────────────────

interface Gap {
  ticker: string;
  company: string;
  role: PortfolioRole;
  currentPercent: number;
  targetPercent: number;
  gapPercent: number;
  gapValueBase: number;
  /** Effective status after TDE override — never written back to the source alloc */
  effectiveStatus: AllocationStatus;
  blockingReason?: string;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function computeCapitalAllocation(
  snapshot: PortfolioSnapshot,
  target: TargetPortfolio,
  tdeByTicker?: Map<string, TdeCapitalData>
): CapitalAllocationPlan {
  const totalValue     = snapshot.totalValue ?? 0;
  const availableCash  = snapshot.totalAvailableCash ?? 0;
  const cashPercent    = totalValue > 0 ? (availableCash / totalValue) * 100 : 0;
  const cashFloor      = (target.cashTargetPercent / 100) * totalValue;
  const deployableCash = Math.max(0, availableCash - cashFloor);
  const now            = new Date().toISOString();
  const tde            = tdeByTicker ?? new Map<string, TdeCapitalData>();

  const empty = (): CapitalAllocationPlan => ({
    availableCashBase:               Math.round(availableCash),
    totalPortfolioBase:              Math.round(totalValue),
    cashPercent:                     Math.round(cashPercent * 10) / 10,
    cashTargetPercent:               target.cashTargetPercent,
    deployableCashBase:              0,
    items:                           [],
    actionableItems:                 [],
    blockedItems:                    [],
    provisionalItems:                [],
    excludedItems:                   [],
    totalSuggestedDeploymentBase:    0,
    residualCashAfterDeploymentBase: Math.round(availableCash),
    computedAt:                      now,
  });

  if (totalValue === 0 || deployableCash <= 0) return empty();

  // ── Build current market value map ────────────────────────────────────────
  const allPositions = snapshot.accounts.flatMap((a) => a.positions);
  const currentMarketValue = new Map<string, number>();
  for (const pos of allPositions) {
    const ticker = pos.symbol.toUpperCase().trim();
    currentMarketValue.set(ticker, (currentMarketValue.get(ticker) ?? 0) + pos.marketValueBaseCurrency);
  }

  // ── Classify each target position — reading alloc read-only ───────────────
  const gaps: Gap[] = [];

  for (const alloc of target.allocations) {
    const ticker      = alloc.ticker.toUpperCase();
    const currentVal  = currentMarketValue.get(ticker) ?? 0;
    const currentPct  = totalValue > 0 ? (currentVal / totalValue) * 100 : 0;
    const gapPct      = alloc.targetPercent - currentPct;
    if (gapPct < 1) continue; // at or above target

    // Read the CIO-assigned status (never mutated from here)
    const cioStatus: AllocationStatus = alloc.allocationStatus ?? "StrategicTarget";

    // Compute effective deployment status locally — does NOT write back to alloc
    let effectiveStatus: AllocationStatus = cioStatus;
    let blockingReason: string | undefined;

    if (cioStatus === "Blocked") {
      blockingReason = alloc.blockingFactors?.join("; ") ?? alloc.reasonForStatus ?? "Allocation is blocked.";
    } else if (cioStatus === "Provisional") {
      blockingReason = alloc.reasonForStatus ?? "Allocation is provisional — evidence incomplete.";
    } else if (cioStatus === "Excluded") {
      blockingReason = alloc.reasonForStatus ?? "Allocation is excluded from capital deployment.";
    } else {
      // StrategicTarget — check TDE readiness, may downgrade effectiveStatus locally
      const tdeEntry = tde.get(ticker);
      if (tdeEntry) {
        if (tdeEntry.blockedByEvent) {
          effectiveStatus = "Blocked";
          blockingReason = tdeEntry.blockingEvent
            ? `Trade Decision blocked pending event: ${tdeEntry.blockingEvent}`
            : "Trade Decision blocked by an imminent event.";
        } else if (tdeEntry.readiness !== "ReadyForReview") {
          effectiveStatus = "Provisional";
          blockingReason = `Trade Decision readiness is "${tdeEntry.readiness}" — not yet ReadyForReview.`;
        }
      }
    }

    gaps.push({
      ticker,
      company:        alloc.company,
      role:           alloc.role,
      currentPercent: Math.round(currentPct * 10) / 10,
      targetPercent:  alloc.targetPercent,
      gapPercent:     Math.round(gapPct * 10) / 10,
      gapValueBase:   (gapPct / 100) * totalValue,
      effectiveStatus,
      blockingReason,
    });
  }

  if (gaps.length === 0) return {
    availableCashBase:               Math.round(availableCash),
    totalPortfolioBase:              Math.round(totalValue),
    cashPercent:                     Math.round(cashPercent * 10) / 10,
    cashTargetPercent:               target.cashTargetPercent,
    deployableCashBase:              Math.round(deployableCash),
    items:                           [],
    actionableItems:                 [],
    blockedItems:                    [],
    provisionalItems:                [],
    excludedItems:                   [],
    totalSuggestedDeploymentBase:    0,
    residualCashAfterDeploymentBase: Math.round(availableCash),
    computedAt:                      now,
  };

  // ── Split into four groups ──────────────────────────────────────────────────
  // Excluded is kept strictly separate — it is not provisional (the CIO decided
  // this company should not receive capital, period).
  const actionableGaps  = gaps.filter((g) => g.effectiveStatus === "StrategicTarget" && !g.blockingReason);
  const blockedGaps     = gaps.filter((g) => g.effectiveStatus === "Blocked");
  const provisionalGaps = gaps.filter((g) => g.effectiveStatus === "Provisional");
  const excludedGaps    = gaps.filter((g) => g.effectiveStatus === "Excluded");

  // Effective deployable is capped at aggregate gap of actionable items only
  const actionableGapValue  = actionableGaps.reduce((s, g) => s + g.gapValueBase, 0);
  const effectiveDeployable = Math.min(deployableCash, actionableGapValue);
  const totalGapPct         = actionableGaps.reduce((s, g) => s + g.gapPercent, 0);

  // ── Build actionable items with proportional deployment ───────────────────
  const actionableItems: CapitalAllocationItem[] = actionableGaps
    .sort((a, b) => b.gapPercent - a.gapPercent)
    .map((gap) => {
      const proportion        = totalGapPct > 0 ? gap.gapPercent / totalGapPct : 1 / actionableGaps.length;
      const proportionalShare = effectiveDeployable * proportion;
      const suggestedAmount   = Math.round(Math.min(proportionalShare, gap.gapValueBase));
      const priority: "High" | "Medium" | "Low" =
        gap.gapPercent >= 8 ? "High" : gap.gapPercent >= 4 ? "Medium" : "Low";
      const rationale = gap.currentPercent === 0
        ? `${gap.ticker} is a target position with no current holding — open a new position`
        : `${gap.ticker} is ${gap.gapPercent.toFixed(1)}% below target; add to close the gap`;
      return {
        ticker:              gap.ticker,
        company:             gap.company,
        role:                gap.role,
        currentPercent:      gap.currentPercent,
        targetPercent:       gap.targetPercent,
        gapPercent:          gap.gapPercent,
        suggestedAmountBase: suggestedAmount,
        priority,
        rationale,
        allocationStatus:    "StrategicTarget" as AllocationStatus,
      };
    });

  // ── Build blocked items (suggestedAmount = 0) ─────────────────────────────
  const blockedItems: CapitalAllocationItem[] = blockedGaps
    .sort((a, b) => b.gapPercent - a.gapPercent)
    .map((gap) => ({
      ticker:              gap.ticker,
      company:             gap.company,
      role:                gap.role,
      currentPercent:      gap.currentPercent,
      targetPercent:       gap.targetPercent,
      gapPercent:          gap.gapPercent,
      suggestedAmountBase: 0,
      priority:            "Low" as const,
      rationale:           gap.blockingReason ?? "Blocked — cannot deploy capital now.",
      allocationStatus:    "Blocked" as AllocationStatus,
      blockingReason:      gap.blockingReason,
    }));

  // ── Build provisional items (suggestedAmount = 0) ─────────────────────────
  const provisionalItems: CapitalAllocationItem[] = provisionalGaps
    .sort((a, b) => b.gapPercent - a.gapPercent)
    .map((gap) => ({
      ticker:              gap.ticker,
      company:             gap.company,
      role:                gap.role,
      currentPercent:      gap.currentPercent,
      targetPercent:       gap.targetPercent,
      gapPercent:          gap.gapPercent,
      suggestedAmountBase: 0,
      priority:            "Low" as const,
      rationale:           gap.blockingReason ?? "Provisional — deployment pending complete evidence.",
      allocationStatus:    "Provisional" as AllocationStatus,
      blockingReason:      gap.blockingReason,
    }));

  // ── Build excluded items (suggestedAmount = 0) ────────────────────────────
  // These are shown for awareness only — no capital suggestion.
  const excludedItems: CapitalAllocationItem[] = excludedGaps
    .sort((a, b) => b.gapPercent - a.gapPercent)
    .map((gap) => ({
      ticker:              gap.ticker,
      company:             gap.company,
      role:                gap.role,
      currentPercent:      gap.currentPercent,
      targetPercent:       gap.targetPercent,
      gapPercent:          gap.gapPercent,
      suggestedAmountBase: 0,
      priority:            "Low" as const,
      rationale:           gap.blockingReason ?? "Excluded — CIO does not want capital allocated here.",
      allocationStatus:    "Excluded" as AllocationStatus,
      blockingReason:      gap.blockingReason,
    }));

  const totalSuggested = actionableItems.reduce((s, i) => s + i.suggestedAmountBase, 0);

  return {
    availableCashBase:               Math.round(availableCash),
    totalPortfolioBase:              Math.round(totalValue),
    cashPercent:                     Math.round(cashPercent * 10) / 10,
    cashTargetPercent:               target.cashTargetPercent,
    deployableCashBase:              Math.round(deployableCash),
    items:                           actionableItems, // backward-compat alias
    actionableItems,
    blockedItems,
    provisionalItems,
    excludedItems,
    totalSuggestedDeploymentBase:    Math.round(totalSuggested),
    residualCashAfterDeploymentBase: Math.round(availableCash - totalSuggested),
    computedAt:                      now,
  };
}
