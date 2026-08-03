/**
 * Portfolio History Writer
 *
 * Appends a lightweight history entry to the repository after every successful
 * Portfolio Manager v2 run. Caps the log at MAX_HISTORY entries.
 *
 * Repository key: "portfolio-manager-v2-history"
 *
 * Entries are intentionally small (no positions, no full target allocations)
 * to keep the repository file size manageable.
 */

import { analysisRepository } from "./analysis-repository.js";
import type { PortfolioSnapshot } from "../routes/portfolio-manager.js";
import type {
  PortfolioV2,
  PortfolioV2HistoryEntry,
} from "./portfolio-manager-v2-types.js";

const HISTORY_KEY  = "portfolio-manager-v2-history";
const MAX_HISTORY  = 90;

export function appendV2HistoryEntry(
  snapshot: PortfolioSnapshot,
  v2: PortfolioV2
): void {
  const existing = analysisRepository.get<PortfolioV2HistoryEntry[]>(HISTORY_KEY);
  const history: PortfolioV2HistoryEntry[] = Array.isArray(existing?.result)
    ? (existing.result as PortfolioV2HistoryEntry[])
    : [];

  const allPositions = snapshot.accounts.flatMap((a) => a.positions);
  const cashPct =
    snapshot.totalValue != null && snapshot.totalValue > 0 && snapshot.totalAvailableCash != null
      ? (snapshot.totalAvailableCash / snapshot.totalValue) * 100
      : 0;

  const entry: PortfolioV2HistoryEntry = {
    snapshotAt:             v2.generatedAt,
    healthOverall:          v2.health.overall,
    healthGrade:            v2.health.grade,
    driftItemCount:         v2.drift.length,
    highSeverityDriftCount: v2.drift.filter((d) => d.severity === "High").length,
    cashPercent:            Math.round(cashPct * 10) / 10,
    cashTargetPercent:      v2.target.cashTargetPercent,
    totalValue:             snapshot.totalValue,
    positionCount:          allPositions.length,
  };

  // Prepend newest entry and cap length
  const updated = [entry, ...history].slice(0, MAX_HISTORY);
  analysisRepository.save(HISTORY_KEY, updated);
}
