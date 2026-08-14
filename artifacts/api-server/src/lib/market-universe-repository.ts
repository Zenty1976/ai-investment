/**
 * Market Universe Repository — Persistent storage for universe instrument records.
 *
 * Purpose (spec §3):
 *   - Store compact MarketRecord metadata (NOT full API responses)
 *   - Refresh slowly (daily/weekly) — universe is stable
 *   - NOT rebuilt during Run All
 *   - Clearly report when in seed/limited mode (spec §4)
 *
 * Storage pattern:
 *   analysis-repository key: "market-universe:<EXCHANGE>"
 *   Each entry result: { records: MarketRecord[], refreshedAt: string }
 *
 * This is pino-free and safe to import in tests.
 */

import { analysisRepository } from "./analysis-repository.js";
import type { MarketRecord } from "./market-universe-provider.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface UniverseRefreshStats {
  exchange: string;
  count: number;
  refreshedAt: string;
  source: MarketRecord["source"];
  /** True when using only static seed data (limited coverage). */
  isSeedOnly: boolean;
  /** Warn callers that seed is NOT full market coverage. */
  coverageWarning: string | null;
}

export interface UniverseRepositoryState {
  records: MarketRecord[];
  refreshedAt: string;
  source: MarketRecord["source"];
}

// ── Repository key helpers ─────────────────────────────────────────────────────

function universeKey(exchange: string): string {
  return `market-universe:${exchange.toUpperCase()}`;
}

// ── Save / load ────────────────────────────────────────────────────────────────

/**
 * Persist universe records for an exchange.
 * Call after a successful provider refresh — not on every Run All cycle.
 *
 * @param exchange  Exchange code, e.g. "CSE", "NASDAQ".
 * @param records   Compact MarketRecord[] (no raw API payloads).
 * @param source    Where these records came from.
 */
export function saveUniverseRecords(
  exchange: string,
  records: MarketRecord[],
  source: MarketRecord["source"]
): void {
  const key = universeKey(exchange);
  const now = new Date().toISOString();
  const state: UniverseRepositoryState = { records, refreshedAt: now, source };
  analysisRepository.save(key, state);
}

/**
 * Load persisted universe records for an exchange.
 * Returns null if no records have been saved yet.
 */
export function loadUniverseRecords(exchange: string): UniverseRepositoryState | null {
  const key = universeKey(exchange);
  const entry = analysisRepository.get(key);
  if (!entry?.result) return null;
  return entry.result as UniverseRepositoryState;
}

/**
 * Return refresh stats for an exchange — used in the data-coverage endpoint.
 */
export function getUniverseStats(exchange: string): UniverseRefreshStats {
  const key = universeKey(exchange);
  const entry = analysisRepository.get(key);
  const state = entry?.result as UniverseRepositoryState | undefined;

  const count = state?.records?.length ?? 0;
  const refreshedAt = state?.refreshedAt ?? null;
  const source = state?.source ?? "STATIC_SEED";
  const isSeedOnly = source === "STATIC_SEED";

  return {
    exchange,
    count,
    refreshedAt: refreshedAt ?? "(never)",
    source,
    isSeedOnly,
    coverageWarning: isSeedOnly
      ? `[SEED MODE] Only ${count} hardcoded tickers for ${exchange}. ` +
        "This does NOT represent full market coverage. " +
        "An external exchange-constituent provider is required for broad coverage."
      : null,
  };
}

/**
 * Aggregate stats across all known exchanges.
 * Returns an array of per-exchange stats.
 */
export function getAllUniverseStats(): UniverseRefreshStats[] {
  const exchanges = ["CSE", "NASDAQ", "NYSE"];
  return exchanges.map(getUniverseStats);
}

/**
 * Check whether a full (non-seed) universe refresh has been performed.
 * Used by the orchestrator to decide whether to show coverage warnings.
 */
export function hasFullUniverseRefresh(exchange: string): boolean {
  const state = loadUniverseRecords(exchange);
  if (!state) return false;
  return state.source !== "STATIC_SEED";
}

/**
 * Seed the repository from static data if no records exist yet.
 * Idempotent — only writes if the key is missing.
 * This is called at startup so the repository always has baseline data.
 *
 * @param exchange  Exchange code.
 * @param records   Static seed records.
 */
export function seedUniverseIfEmpty(
  exchange: string,
  records: MarketRecord[]
): void {
  const existing = loadUniverseRecords(exchange);
  if (!existing) {
    saveUniverseRecords(exchange, records, "STATIC_SEED");
  }
}
