/**
 * Portfolio History Writer
 *
 * Appends a rich history entry to the repository after every successful
 * Portfolio Manager v2 run. Caps the log at MAX_HISTORY entries.
 *
 * Repository key: "portfolio-manager-v2-history"
 *
 * Entries store enough to understand strategic changes over time:
 *  - health scores and grades
 *  - drift counts
 *  - target fingerprint and confidence
 *  - compact allocation snapshot (ticker/percent/role/status)
 *  - source freshness summary
 *  - major portfolio changes
 *  - strategic rationale summary
 *
 * Full prompts and raw AI responses are never stored.
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

  // ── Compact target allocations ─────────────────────────────────────────────
  // allocationStatus is now required on TargetAllocation; no fallback needed.
  const targetAllocations = v2.target.allocations.map((a) => ({
    ticker:  a.ticker,
    percent: a.targetPercent,
    role:    a.role,
    status:  a.allocationStatus,
  }));

  // ── Source freshness summary ───────────────────────────────────────────────
  const prov = v2.provenance;
  let sourceFreshnessSummary: string;
  if (prov) {
    const total   = prov.sourceModulesUsed.length;
    const stale   = prov.staleSources.length;
    const missing = prov.missingSources.length;
    const fresh   = total - stale - missing;
    sourceFreshnessSummary = `${fresh}/${total} fresh, ${stale} stale, ${missing} missing`;
  } else {
    sourceFreshnessSummary = "provenance not available";
  }

  // ── Major changes ──────────────────────────────────────────────────────────
  const majorChanges = v2.changes
    .filter((c) => c.type === "AddedPosition" || c.type === "RemovedPosition" ||
                   (c.type === "TargetIncreased" && Math.abs((c.newValue ?? 0) - (c.previousValue ?? 0)) >= 3) ||
                   (c.type === "TargetDecreased" && Math.abs((c.newValue ?? 0) - (c.previousValue ?? 0)) >= 3))
    .slice(0, 5)
    .map((c) => c.description);

  // ── Strategic rationale summary (first 120 chars) ─────────────────────────
  const strategicRationaleSummary =
    v2.target.strategicRationale.slice(0, 120) +
    (v2.target.strategicRationale.length > 120 ? "…" : "");

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
    // Richer v2.1 fields
    targetFingerprint:         prov?.inputFingerprint,
    targetConfidence:          prov?.targetConfidence,
    targetAllocations,
    sourceFreshnessSummary,
    majorChanges:              majorChanges.length > 0 ? majorChanges : undefined,
    strategicRationaleSummary,
  };

  const updated = [entry, ...history].slice(0, MAX_HISTORY);
  analysisRepository.save(HISTORY_KEY, updated);
}
