/**
 * Consensus Repository — Point-in-time safe analyst consensus snapshot store.
 *
 * WHY THIS EXISTS (spec §9 / §27 / §28):
 *   Analyst expectations are dynamic. The system needs to answer:
 *   "What consensus did the system see on 2026-08-12?"
 *
 *   This requires storing SNAPSHOTS, not just the latest value.
 *
 *   Example (spec §9):
 *     30 days ago EPS consensus = 8.0
 *     14 days ago = 8.5
 *     today = 10.0
 *     → revisionDirection = UP, magnitude = +25%
 *
 * Point-in-time safety (spec §32):
 *   getSnapshotAt(ticker, asOf) returns the most recent snapshot where
 *   dataAsOf <= asOf. It NEVER returns a snapshot from after asOf.
 *
 * Deduplication (spec §28):
 *   Only a new snapshot if epsConsensus or revenueConsensus changed materially
 *   (>=0.5% absolute or any non-null → null transition).
 *
 * Storage: analysis-repository key "consensus-history:<TICKER>"
 *   result shape: { snapshots: ConsensusSnapshot[] }
 *
 * This is pino-free and safe to import in tests.
 */

import { analysisRepository } from "./analysis-repository.js";
import type { DataProvenance } from "./data-provider-types.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * A point-in-time analyst consensus snapshot (spec §8 / §27).
 */
export interface ConsensusSnapshot {
  ticker: string;
  /** ISO date representing the "as of" date of this consensus (from the provider). */
  dataAsOf: string;
  /** ISO timestamp when our system fetched this from the provider. */
  retrievedAt: string;

  /** EPS consensus estimate for the upcoming period. Null if unavailable. */
  epsConsensus: number | null;
  /** Revenue consensus estimate (in reporting currency). Null if unavailable. */
  revenueConsensus: number | null;
  /** EBITDA consensus (where applicable). Null if unavailable. */
  ebitdaConsensus: number | null;

  /** Number of estimates contributing to consensus. */
  estimateCount: number | null;
  /** Highest individual EPS estimate. */
  epsHigh: number | null;
  /** Lowest individual EPS estimate. */
  epsLow: number | null;

  /** Fiscal period label, e.g. "Q2 2026". */
  fiscalPeriod: string | null;

  provenance: DataProvenance;
}

/**
 * Derived revision facts computed from two snapshots (spec §9 / §17).
 * All magnitudes are fractional (0.1 = +10%).
 */
export interface ConsensusRevisionFacts {
  ticker: string;
  windowDays: 7 | 14 | 30 | 60 | 90;
  /** Fractional change in EPS consensus. Null if insufficient data. */
  epsRevisionPct: number | null;
  /** Fractional change in revenue consensus. Null if insufficient data. */
  revenueRevisionPct: number | null;
  /** "UP" if epsRevisionPct > 0.005, "DOWN" if < -0.005, "FLAT" otherwise. */
  epsDirection: "UP" | "DOWN" | "FLAT" | "UNKNOWN";
  /** "UP" if revenueRevisionPct > 0.005, "DOWN" if < -0.005, "FLAT" otherwise. */
  revenueDirection: "UP" | "DOWN" | "FLAT" | "UNKNOWN";
  fromSnapshot: ConsensusSnapshot | null;
  toSnapshot: ConsensusSnapshot | null;
}

/** Internal storage shape. */
interface SnapshotStore {
  snapshots: ConsensusSnapshot[];
}

// ── Materiality threshold ─────────────────────────────────────────────────────

/** Minimum fractional change to warrant storing a new snapshot (0.5%). */
const MATERIALITY_THRESHOLD = 0.005;

function isMaterialChange(prev: ConsensusSnapshot, next: ConsensusSnapshot): boolean {
  // Non-null → null or null → non-null is always material
  if ((prev.epsConsensus === null) !== (next.epsConsensus === null)) return true;
  if ((prev.revenueConsensus === null) !== (next.revenueConsensus === null)) return true;

  // EPS change
  if (prev.epsConsensus !== null && next.epsConsensus !== null) {
    const eps = Math.abs((next.epsConsensus - prev.epsConsensus) / prev.epsConsensus);
    if (eps >= MATERIALITY_THRESHOLD) return true;
  }

  // Revenue change
  if (prev.revenueConsensus !== null && next.revenueConsensus !== null) {
    const rev = Math.abs((next.revenueConsensus - prev.revenueConsensus) / prev.revenueConsensus);
    if (rev >= MATERIALITY_THRESHOLD) return true;
  }

  return false;
}

// ── Repository key helpers ─────────────────────────────────────────────────────

function consensusKey(ticker: string): string {
  return `consensus-history:${ticker.toUpperCase()}`;
}

// ── Save / load ────────────────────────────────────────────────────────────────

/**
 * Save a consensus snapshot.
 * Deduplicates: only stores if values changed materially vs the most recent snapshot.
 * Returns true if stored, false if deduplicated.
 */
export function saveConsensusSnapshot(snapshot: ConsensusSnapshot): boolean {
  const key = consensusKey(snapshot.ticker);
  const existing = analysisRepository.get(key);
  const store: SnapshotStore = (existing?.result as SnapshotStore | undefined) ?? { snapshots: [] };

  // Check materiality against the most recent existing snapshot
  if (store.snapshots.length > 0) {
    const latest = store.snapshots[store.snapshots.length - 1];
    if (!isMaterialChange(latest, snapshot)) {
      return false; // Deduplicated — no new snapshot needed
    }
  }

  store.snapshots.push(snapshot);

  // Cap history to 365 snapshots per ticker (deduplication keeps this manageable)
  if (store.snapshots.length > 365) {
    store.snapshots = store.snapshots.slice(-365);
  }

  analysisRepository.save(key, store);
  return true;
}

/**
 * Get all consensus snapshots for a ticker.
 * Returns [] if none saved.
 */
export function getConsensusSnapshots(ticker: string): ConsensusSnapshot[] {
  const key = consensusKey(ticker);
  const existing = analysisRepository.get(key);
  const store = existing?.result as SnapshotStore | undefined;
  return store?.snapshots ?? [];
}

/**
 * Get the most recent snapshot available at a given point in time.
 *
 * POINT-IN-TIME SAFETY (spec §32):
 *   Only returns snapshots where dataAsOf <= asOf.
 *   NEVER returns a snapshot from after the simulated decision time.
 *
 * @param ticker  Ticker symbol.
 * @param asOf    ISO date or timestamp — the "as of" date of the simulated analysis.
 */
export function getSnapshotAt(ticker: string, asOf: string): ConsensusSnapshot | null {
  const snapshots = getConsensusSnapshots(ticker);
  // Filter: only snapshots where the data was known at or before asOf
  const eligible = snapshots.filter(s => s.dataAsOf <= asOf);
  if (eligible.length === 0) return null;
  // Return the most recent one
  return eligible[eligible.length - 1];
}

/**
 * Compute revision facts between two points in time (spec §9 / §17).
 *
 * @param ticker       Ticker symbol.
 * @param currentAsOf  The "current" time for the analysis.
 * @param windowDays   How many days back to look for the comparison snapshot.
 */
export function computeRevisionFacts(
  ticker: string,
  currentAsOf: string,
  windowDays: 7 | 14 | 30 | 60 | 90
): ConsensusRevisionFacts {
  const toSnapshot = getSnapshotAt(ticker, currentAsOf);
  if (!toSnapshot) {
    return {
      ticker, windowDays,
      epsRevisionPct: null, revenueRevisionPct: null,
      epsDirection: "UNKNOWN", revenueDirection: "UNKNOWN",
      fromSnapshot: null, toSnapshot: null,
    };
  }

  // Find the snapshot from ~windowDays ago
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const windowStart = new Date(new Date(currentAsOf).getTime() - windowMs).toISOString().slice(0, 10);
  const fromSnapshot = getSnapshotAt(ticker, windowStart);

  function directionOf(pct: number | null): "UP" | "DOWN" | "FLAT" | "UNKNOWN" {
    if (pct === null) return "UNKNOWN";
    if (pct > MATERIALITY_THRESHOLD) return "UP";
    if (pct < -MATERIALITY_THRESHOLD) return "DOWN";
    return "FLAT";
  }

  let epsRevisionPct: number | null = null;
  let revenueRevisionPct: number | null = null;

  if (fromSnapshot) {
    if (
      fromSnapshot.epsConsensus !== null &&
      toSnapshot.epsConsensus !== null &&
      fromSnapshot.epsConsensus !== 0
    ) {
      epsRevisionPct =
        (toSnapshot.epsConsensus - fromSnapshot.epsConsensus) / Math.abs(fromSnapshot.epsConsensus);
    }
    if (
      fromSnapshot.revenueConsensus !== null &&
      toSnapshot.revenueConsensus !== null &&
      fromSnapshot.revenueConsensus !== 0
    ) {
      revenueRevisionPct =
        (toSnapshot.revenueConsensus - fromSnapshot.revenueConsensus) /
        Math.abs(fromSnapshot.revenueConsensus);
    }
  }

  return {
    ticker,
    windowDays,
    epsRevisionPct,
    revenueRevisionPct,
    epsDirection: directionOf(epsRevisionPct),
    revenueDirection: directionOf(revenueRevisionPct),
    fromSnapshot,
    toSnapshot,
  };
}

/**
 * Compute revision facts for all standard windows (7D, 30D, 60D, 90D).
 * Used to populate ExpectationsProfile.estimateRevision1M / estimateRevision3M.
 */
export function computeAllRevisions(ticker: string, currentAsOf: string): {
  rev7D: ConsensusRevisionFacts;
  rev30D: ConsensusRevisionFacts;
  rev60D: ConsensusRevisionFacts;
  rev90D: ConsensusRevisionFacts;
} {
  return {
    rev7D:  computeRevisionFacts(ticker, currentAsOf, 7),
    rev30D: computeRevisionFacts(ticker, currentAsOf, 30),
    rev60D: computeRevisionFacts(ticker, currentAsOf, 60),
    rev90D: computeRevisionFacts(ticker, currentAsOf, 90),
  };
}

/**
 * Count how many tickers have consensus history in the repository.
 * Used in the data-coverage health report.
 */
export function getConsensusCoveredTickerCount(): number {
  return analysisRepository.getAll()
    .filter(e => e.moduleName.startsWith("consensus-history:"))
    .length;
}

/**
 * Get total snapshot count across all tickers.
 */
export function getTotalSnapshotCount(): number {
  return analysisRepository.getAll()
    .filter(e => e.moduleName.startsWith("consensus-history:"))
    .reduce((sum, e) => {
      const store = e.result as SnapshotStore | undefined;
      return sum + (store?.snapshots?.length ?? 0);
    }, 0);
}
