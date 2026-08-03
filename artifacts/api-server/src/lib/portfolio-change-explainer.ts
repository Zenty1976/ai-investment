/**
 * Portfolio Change Explainer
 *
 * Diffs a new TargetPortfolio against the previous one and returns a list
 * of PortfolioChange items describing what changed.
 *
 * Change types detected:
 *   AddedPosition     — new ticker appears in target
 *   RemovedPosition   — ticker removed from target
 *   TargetIncreased   — targetPercent grew by ≥ 1 pp
 *   TargetDecreased   — targetPercent shrank by ≥ 1 pp
 *   RoleChanged       — same ticker, different role
 *   CashTargetChanged — cashTargetPercent changed by ≥ 1 pp
 *   StatusChanged     — allocationStatus changed (e.g. Provisional → StrategicTarget)
 *   ConvictionChanged — conviction changed (e.g. Medium → High)
 *
 * No AI calls — purely deterministic.
 */

import type {
  TargetPortfolio,
  PortfolioChange,
  PortfolioChangeType,
} from "./portfolio-manager-v2-types.js";

export function explainChanges(
  newTarget: TargetPortfolio,
  previousTarget: TargetPortfolio | null
): PortfolioChange[] {
  if (!previousTarget) return [];

  const changes: PortfolioChange[] = [];

  // ── Cash target change ───────────────────────────────────────────────────────
  const cashDiff = newTarget.cashTargetPercent - previousTarget.cashTargetPercent;
  if (Math.abs(cashDiff) >= 1) {
    changes.push({
      type: "CashTargetChanged",
      description:
        `Cash target ${cashDiff > 0 ? "raised" : "lowered"} from ` +
        `${previousTarget.cashTargetPercent.toFixed(1)}% to ${newTarget.cashTargetPercent.toFixed(1)}%`,
      previousValue: previousTarget.cashTargetPercent,
      newValue:      newTarget.cashTargetPercent,
    });
  }

  // ── Build lookup maps ────────────────────────────────────────────────────────
  const prevMap = new Map(
    previousTarget.allocations.map((a) => [a.ticker.toUpperCase(), a])
  );
  const newMap = new Map(
    newTarget.allocations.map((a) => [a.ticker.toUpperCase(), a])
  );

  // ── Added positions ──────────────────────────────────────────────────────────
  for (const [ticker, alloc] of newMap) {
    if (!prevMap.has(ticker)) {
      const statusNote = alloc.allocationStatus && alloc.allocationStatus !== "StrategicTarget"
        ? ` [${alloc.allocationStatus}]` : "";
      changes.push({
        type: "AddedPosition",
        ticker,
        description:
          `${ticker} (${alloc.company}) added to target at ${alloc.targetPercent.toFixed(1)}% as ${alloc.role}${statusNote}`,
        newValue: alloc.targetPercent,
      });
    }
  }

  // ── Removed positions ────────────────────────────────────────────────────────
  for (const [ticker, alloc] of prevMap) {
    if (!newMap.has(ticker)) {
      changes.push({
        type: "RemovedPosition",
        ticker,
        description:
          `${ticker} (${alloc.company}) removed from target (was ${alloc.targetPercent.toFixed(1)}%)`,
        previousValue: alloc.targetPercent,
      });
    }
  }

  // ── Changes for positions present in both ────────────────────────────────────
  for (const [ticker, newAlloc] of newMap) {
    const prev = prevMap.get(ticker);
    if (!prev) continue;

    const pctDiff = newAlloc.targetPercent - prev.targetPercent;
    if (Math.abs(pctDiff) >= 1) {
      const type: PortfolioChangeType = pctDiff > 0 ? "TargetIncreased" : "TargetDecreased";
      changes.push({
        type,
        ticker,
        description:
          `${ticker} target ${pctDiff > 0 ? "increased" : "decreased"} from ` +
          `${prev.targetPercent.toFixed(1)}% to ${newAlloc.targetPercent.toFixed(1)}%`,
        previousValue: prev.targetPercent,
        newValue:      newAlloc.targetPercent,
      });
    }

    if (prev.role !== newAlloc.role) {
      changes.push({
        type: "RoleChanged",
        ticker,
        description: `${ticker} role changed from ${prev.role} to ${newAlloc.role}`,
      });
    }

    // Status change (e.g. Provisional → StrategicTarget — actionable signal)
    const prevStatus = prev.allocationStatus ?? "StrategicTarget";
    const newStatus  = newAlloc.allocationStatus ?? "StrategicTarget";
    if (prevStatus !== newStatus) {
      changes.push({
        type: "StatusChanged",
        ticker,
        description: `${ticker} allocation status changed from ${prevStatus} to ${newStatus}`,
      });
    }

    // Conviction change
    const prevConv = prev.conviction ?? "Medium";
    const newConv  = newAlloc.conviction ?? "Medium";
    if (prevConv !== newConv) {
      changes.push({
        type: "ConvictionChanged",
        ticker,
        description: `${ticker} conviction changed from ${prevConv} to ${newConv}`,
      });
    }
  }

  // ── Sort ──────────────────────────────────────────────────────────────────────
  const typeOrder: Record<PortfolioChangeType, number> = {
    RemovedPosition:   0,
    AddedPosition:     1,
    CashTargetChanged: 2,
    StatusChanged:     3,
    ConvictionChanged: 4,
    TargetIncreased:   5,
    TargetDecreased:   6,
    RoleChanged:       7,
  };

  changes.sort((a, b) => {
    const tDiff = (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9);
    if (tDiff !== 0) return tDiff;
    return (a.ticker ?? "").localeCompare(b.ticker ?? "");
  });

  return changes;
}
