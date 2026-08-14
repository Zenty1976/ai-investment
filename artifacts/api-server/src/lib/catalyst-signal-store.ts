/**
 * Persistent Signal Store — Catalyst Intelligence (spec §7, §8)
 *
 * Stores LeadingIndicatorSignal records ACROSS pipeline runs so that
 * 7D/14D/30D signal accumulation windows can draw on real historical evidence,
 * not only the signals present in the current execution.
 *
 * Repository keys:
 *   "catalyst-signals:<TICKER>"          — stored signals
 *   "catalyst-signal-research:<TICKER>"  — research freshness metadata
 *
 * Design rules (spec §8 — DO NOT DUPLICATE RESEARCH):
 *   - Research fingerprint prevents re-running when nothing material has changed.
 *   - A 24h minimum interval prevents cost blow-up during frequent screen runs.
 *   - Signals older than MAX_SIGNAL_AGE_DAYS are pruned automatically.
 */

import { analysisRepository } from "./analysis-repository.js";
import type { LeadingIndicatorSignal } from "./catalyst-types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Prune signals older than this (days). */
export const MAX_SIGNAL_AGE_DAYS = 90;

/** Minimum time between driver-directed research runs per ticker (ms). */
export const RESEARCH_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ── Stored types ──────────────────────────────────────────────────────────────

interface StoredSignalRecord {
  ticker: string;
  signals: LeadingIndicatorSignal[];
  updatedAt: string;
}

interface ResearchFreshnessRecord {
  ticker: string;
  /** ISO timestamp of last driver-directed signal research. */
  lastResearchedAt: string;
  /**
   * Fingerprint of the situation when research ran.
   * If driver profile changed substantially, this will differ and force a re-run.
   */
  researchFingerprint: string;
}

// ── Repository keys ───────────────────────────────────────────────────────────

export function signalStoreKey(ticker: string): string {
  return `catalyst-signals:${ticker.toUpperCase()}`;
}

export function researchFreshnessKey(ticker: string): string {
  return `catalyst-signal-research:${ticker.toUpperCase()}`;
}

// ── Signal storage helpers ────────────────────────────────────────────────────

/**
 * Get stored signals for a ticker.
 *
 * @param ticker     The ticker symbol.
 * @param maxDaysOld If provided, only return signals with availableAt within this age.
 */
export function getStoredSignals(
  ticker: string,
  maxDaysOld?: number
): LeadingIndicatorSignal[] {
  const entry = analysisRepository.get<StoredSignalRecord>(signalStoreKey(ticker));
  const signals = entry?.result?.signals ?? [];

  if (maxDaysOld === undefined) return signals;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDaysOld);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  return signals.filter(s => {
    const ts = s.availableAt ?? s.observationDate;
    return ts.slice(0, 10) >= cutoffDate;
  });
}

/**
 * Merge new signals into the stored signal set.
 *
 * - Deduplicates by signalId (new signal overwrites old with same ID)
 * - Prunes signals older than MAX_SIGNAL_AGE_DAYS automatically
 */
export function mergeStoredSignals(
  ticker: string,
  newSignals: LeadingIndicatorSignal[]
): void {
  if (newSignals.length === 0) return;

  const existing = getStoredSignals(ticker); // no age filter — all signals for dedup
  const byId = new Map<string, LeadingIndicatorSignal>(existing.map(s => [s.signalId, s]));

  for (const s of newSignals) {
    byId.set(s.signalId, s);
  }

  // Prune old signals
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_SIGNAL_AGE_DAYS);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const pruned = [...byId.values()].filter(s => {
    const ts = s.availableAt ?? s.observationDate;
    return ts.slice(0, 10) >= cutoffDate;
  });

  analysisRepository.save(signalStoreKey(ticker), {
    ticker: ticker.toUpperCase(),
    signals: pruned,
    updatedAt: new Date().toISOString(),
  } satisfies StoredSignalRecord);
}

/**
 * Save (replace) all stored signals for a ticker.
 * Prefer mergeStoredSignals for incremental updates.
 */
export function saveStoredSignals(
  ticker: string,
  signals: LeadingIndicatorSignal[]
): void {
  analysisRepository.save(signalStoreKey(ticker), {
    ticker: ticker.toUpperCase(),
    signals,
    updatedAt: new Date().toISOString(),
  } satisfies StoredSignalRecord);
}

/**
 * Get the number of stored signals for a ticker (quick count without loading all data).
 */
export function getStoredSignalCount(ticker: string): number {
  return getStoredSignals(ticker).length;
}

// ── Research freshness ────────────────────────────────────────────────────────

/**
 * Returns true if driver-directed signal research was run recently and
 * the situation fingerprint matches (i.e., no re-research needed).
 *
 * @param ticker      The ticker symbol.
 * @param fingerprint Current situation fingerprint (e.g., hash of driver profile + facts).
 *                    If provided, also checks that the fingerprint hasn't changed.
 */
export function isSignalResearchFresh(
  ticker: string,
  fingerprint?: string
): boolean {
  const entry = analysisRepository.get<ResearchFreshnessRecord>(researchFreshnessKey(ticker));
  if (!entry?.result) return false;

  const age = Date.now() - new Date(entry.result.lastResearchedAt).getTime();
  if (age > RESEARCH_MIN_INTERVAL_MS) return false;

  if (fingerprint && entry.result.researchFingerprint !== fingerprint) return false;

  return true;
}

/**
 * Record that driver-directed signal research was completed for this ticker.
 * Must be called after every genuine research run (not skips).
 *
 * @param ticker      The ticker symbol.
 * @param fingerprint Fingerprint of the driver profile + facts at research time.
 */
export function recordSignalResearch(ticker: string, fingerprint: string): void {
  analysisRepository.save(researchFreshnessKey(ticker), {
    ticker: ticker.toUpperCase(),
    lastResearchedAt: new Date().toISOString(),
    researchFingerprint: fingerprint,
  } satisfies ResearchFreshnessRecord);
}

/**
 * Get the ISO timestamp of the last signal research run for a ticker.
 * Returns null if never researched.
 */
export function getLastResearchTimestamp(ticker: string): string | null {
  const entry = analysisRepository.get<ResearchFreshnessRecord>(researchFreshnessKey(ticker));
  return entry?.result?.lastResearchedAt ?? null;
}

/**
 * Build a research fingerprint from the driver profile's key drivers
 * and a few stable company facts. Used to detect if re-research is warranted.
 *
 * Not cryptographic — just a stable string comparison.
 */
export function buildResearchFingerprint(
  ticker: string,
  driverTopics: string[]
): string {
  const topicsFragment = driverTopics.slice(0, 5).sort().join("|");
  return `${ticker.toUpperCase()}:${topicsFragment}`;
}
