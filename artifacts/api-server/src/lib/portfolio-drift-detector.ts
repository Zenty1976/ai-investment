/**
 * Portfolio Drift Detector
 *
 * Compares the current portfolio snapshot against the AI-synthesised
 * TargetPortfolio and produces a ranked list of drift items covering
 * 6 drift types: Overweight, Underweight, Missing, Excess, CashTooHigh,
 * CashTooLow, SectorOverweight, SectorUnderweight.
 *
 * No AI calls — purely deterministic.
 */

import type { PortfolioSnapshot } from "../routes/portfolio-manager.js";
import type {
  TargetPortfolio,
  PortfolioDriftItem,
  DriftType,
} from "./portfolio-manager-v2-types.js";

// ── Severity thresholds ────────────────────────────────────────────────────────

function driftSeverity(deviationAbs: number): "High" | "Medium" | "Low" {
  if (deviationAbs >= 10) return "High";
  if (deviationAbs >= 4)  return "Medium";
  return "Low";
}

// ── Asset-type to sector proxy ────────────────────────────────────────────────

function sectorProxy(assetType: string, exchange: string): string {
  // Use assetType as primary label; fall back to exchange
  return assetType || exchange || "Unknown";
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function detectDrift(
  snapshot: PortfolioSnapshot,
  target: TargetPortfolio
): PortfolioDriftItem[] {
  const items: PortfolioDriftItem[] = [];

  const totalValue = snapshot.totalValue ?? 0;
  const cash       = snapshot.totalAvailableCash ?? 0;
  const cashPct    = totalValue > 0 ? (cash / totalValue) * 100 : 0;

  const allPositions = snapshot.accounts.flatMap((a) => a.positions);

  // Build a map of ticker → current market value as % of total
  const currentPct = new Map<string, number>();
  for (const pos of allPositions) {
    const ticker = pos.symbol.toUpperCase().trim();
    const pct    = totalValue > 0 ? (pos.marketValueBaseCurrency / totalValue) * 100 : 0;
    currentPct.set(ticker, (currentPct.get(ticker) ?? 0) + pct);
  }

  // Build a map of ticker → target allocation from the TargetPortfolio
  const targetPct = new Map<string, number>();
  for (const alloc of target.allocations) {
    targetPct.set(alloc.ticker.toUpperCase(), alloc.targetPercent);
  }

  // ── Cash drift ───────────────────────────────────────────────────────────────

  const cashDev = cashPct - target.cashTargetPercent;
  if (Math.abs(cashDev) >= 3) {
    const type: DriftType = cashDev > 0 ? "CashTooHigh" : "CashTooLow";
    items.push({
      type,
      currentPercent: Math.round(cashPct * 10) / 10,
      targetPercent:  Math.round(target.cashTargetPercent * 10) / 10,
      deviationPercent: Math.round(cashDev * 10) / 10,
      severity: driftSeverity(Math.abs(cashDev)),
      action:
        type === "CashTooHigh"
          ? `Deploy ${(cashDev).toFixed(1)}% of portfolio from cash into positions`
          : `Build cash reserve from ${cashPct.toFixed(1)}% to ${target.cashTargetPercent.toFixed(1)}%`,
    });
  }

  // ── Position-level drift ─────────────────────────────────────────────────────

  // Overweight and Excess (held but not in target)
  for (const [ticker, pct] of currentPct) {
    const tgt = targetPct.get(ticker);
    if (tgt === undefined) {
      // Excess — not in target at all
      if (pct >= 1) {
        items.push({
          type: "Excess",
          ticker,
          currentPercent:  Math.round(pct  * 10) / 10,
          targetPercent:   0,
          deviationPercent: Math.round(pct * 10) / 10,
          severity: driftSeverity(pct),
          action: `Consider exiting ${ticker} — not part of target portfolio`,
        });
      }
    } else {
      const dev = pct - tgt;
      if (dev >= 3) {
        items.push({
          type: "Overweight",
          ticker,
          currentPercent:   Math.round(pct  * 10) / 10,
          targetPercent:    Math.round(tgt  * 10) / 10,
          deviationPercent: Math.round(dev  * 10) / 10,
          severity: driftSeverity(dev),
          action: `Trim ${ticker} from ${pct.toFixed(1)}% to target ${tgt.toFixed(1)}%`,
        });
      }
    }
  }

  // Underweight and Missing (in target but not held / below target)
  for (const alloc of target.allocations) {
    const ticker = alloc.ticker.toUpperCase();
    const cur    = currentPct.get(ticker) ?? 0;
    const dev    = cur - alloc.targetPercent;
    if (cur === 0) {
      // Missing
      if (alloc.targetPercent >= 1) {
        items.push({
          type: "Missing",
          ticker,
          currentPercent:   0,
          targetPercent:    Math.round(alloc.targetPercent * 10) / 10,
          deviationPercent: -Math.round(alloc.targetPercent * 10) / 10,
          severity: driftSeverity(alloc.targetPercent),
          action: `Initiate position in ${ticker} — target allocation ${alloc.targetPercent.toFixed(1)}%`,
        });
      }
    } else if (dev < -3) {
      items.push({
        type: "Underweight",
        ticker,
        currentPercent:   Math.round(cur  * 10) / 10,
        targetPercent:    Math.round(alloc.targetPercent * 10) / 10,
        deviationPercent: Math.round(dev  * 10) / 10,
        severity: driftSeverity(Math.abs(dev)),
        action: `Add to ${ticker} from ${cur.toFixed(1)}% toward target ${alloc.targetPercent.toFixed(1)}%`,
      });
    }
  }

  // ── Sector-level drift ────────────────────────────────────────────────────────

  // Compute current sector weights
  const sectorValues = new Map<string, number>();
  for (const pos of allPositions) {
    const sector = sectorProxy(pos.assetType, pos.exchange);
    sectorValues.set(sector, (sectorValues.get(sector) ?? 0) + pos.marketValueBaseCurrency);
  }

  // Build target sector weights from target allocations
  // (map each target ticker to a sector using current positions where available)
  const tickerToSector = new Map<string, string>();
  for (const pos of allPositions) {
    tickerToSector.set(pos.symbol.toUpperCase(), sectorProxy(pos.assetType, pos.exchange));
  }

  const targetSectorPct = new Map<string, number>();
  for (const alloc of target.allocations) {
    const sector = tickerToSector.get(alloc.ticker.toUpperCase());
    if (sector) {
      targetSectorPct.set(sector, (targetSectorPct.get(sector) ?? 0) + alloc.targetPercent);
    }
  }

  for (const [sector, value] of sectorValues) {
    const curSectorPct = totalValue > 0 ? (value / totalValue) * 100 : 0;
    const tgtSectorPct = targetSectorPct.get(sector) ?? 0;
    // Only add sector drift when we have a target reference for this sector
    if (tgtSectorPct === 0) continue;
    const sectorDev = curSectorPct - tgtSectorPct;
    if (sectorDev >= 5) {
      items.push({
        type: "SectorOverweight",
        sector,
        currentPercent:   Math.round(curSectorPct * 10) / 10,
        targetPercent:    Math.round(tgtSectorPct * 10) / 10,
        deviationPercent: Math.round(sectorDev    * 10) / 10,
        severity: driftSeverity(sectorDev),
        action: `Reduce ${sector} exposure from ${curSectorPct.toFixed(1)}% toward ${tgtSectorPct.toFixed(1)}%`,
      });
    } else if (sectorDev <= -5) {
      items.push({
        type: "SectorUnderweight",
        sector,
        currentPercent:   Math.round(curSectorPct * 10) / 10,
        targetPercent:    Math.round(tgtSectorPct * 10) / 10,
        deviationPercent: Math.round(sectorDev    * 10) / 10,
        severity: driftSeverity(Math.abs(sectorDev)),
        action: `Increase ${sector} exposure from ${curSectorPct.toFixed(1)}% toward ${tgtSectorPct.toFixed(1)}%`,
      });
    }
  }

  // Sort: High severity first, then by absolute deviation descending
  items.sort((a, b) => {
    const severityOrder = { High: 0, Medium: 1, Low: 2 };
    const sDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (sDiff !== 0) return sDiff;
    return Math.abs(b.deviationPercent) - Math.abs(a.deviationPercent);
  });

  return items;
}
