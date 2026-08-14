/**
 * Earnings Calendar Repository — Point-in-time safe calendar store.
 *
 * Purpose (spec §6 / §27):
 *   Store known upcoming earnings dates with provenance so historical validation
 *   can answer "what earnings dates did the system know on date X?"
 *
 * Point-in-time safety:
 *   Each EarningsCalendarEntry has a retrievedAt timestamp.
 *   Queries must only use entries where retrievedAt <= asOf.
 *
 * Current data source (spec §5 audit):
 *   AI web search — per-ticker, not bulk. Requires one web search per ticker.
 *   This is the ONLY source currently available. A bulk calendar provider
 *   (FactSet, Alpha Vantage, Financial Modeling Prep) would eliminate per-ticker cost.
 *
 * Storage: analysis-repository key "earnings-calendar:<TICKER>"
 */

import { analysisRepository } from "./analysis-repository.js";
import type { DataProvenance } from "./data-provider-types.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * A single upcoming earnings entry with provenance (spec §6, §12).
 */
export interface EarningsCalendarEntry {
  ticker: string;
  /** ISO date YYYY-MM-DD of the earnings release. */
  earningsDate: string;
  /** When in the trading day the result is expected. */
  time: "BEFORE_MARKET" | "AFTER_MARKET" | "DURING_MARKET" | "UNKNOWN";
  /** Fiscal quarter label, e.g. "Q2 2026". Null if not known. */
  fiscalQuarter: string | null;
  /** Fiscal year, e.g. 2026. Null if not known. */
  fiscalYear: number | null;
  /** Whether this date has been confirmed by the company (vs tentative). */
  confirmed: boolean;
  /** Human-readable source description. */
  source: string;
  provenance: DataProvenance;
}

/** Internal storage shape per ticker. */
interface CalendarStore {
  entries: EarningsCalendarEntry[];
}

// ── Repository key helpers ─────────────────────────────────────────────────────

function calendarKey(ticker: string): string {
  return `earnings-calendar:${ticker.toUpperCase()}`;
}

// ── Save / load ────────────────────────────────────────────────────────────────

/**
 * Save an earnings calendar entry for a ticker.
 * Deduplicates by (earningsDate) — updates in place if date matches.
 */
export function saveCalendarEntry(ticker: string, entry: EarningsCalendarEntry): void {
  const key = calendarKey(ticker);
  const existing = analysisRepository.get(key);
  const store: CalendarStore = (existing?.result as CalendarStore | undefined) ?? { entries: [] };

  const idx = store.entries.findIndex(e => e.earningsDate === entry.earningsDate);
  if (idx >= 0) {
    store.entries[idx] = entry;
  } else {
    store.entries.push(entry);
  }

  // Keep sorted by earningsDate ascending
  store.entries.sort((a, b) => a.earningsDate.localeCompare(b.earningsDate));
  analysisRepository.save(key, store);
}

/**
 * Get all calendar entries for a ticker.
 * Returns [] if none saved.
 */
export function getCalendarEntries(ticker: string): EarningsCalendarEntry[] {
  const key = calendarKey(ticker);
  const existing = analysisRepository.get(key);
  const store = existing?.result as CalendarStore | undefined;
  return store?.entries ?? [];
}

/**
 * Get the next upcoming earnings entry after a given date (inclusive).
 * Point-in-time safe: only uses entries retrieved at or before asOf.
 *
 * @param ticker   Ticker to query.
 * @param afterDate ISO date — return the next earnings on or after this date.
 * @param asOf      ISO timestamp — only use entries retrieved at/before this time.
 */
export function getNextEarnings(
  ticker: string,
  afterDate: string,
  asOf: string
): EarningsCalendarEntry | null {
  const entries = getCalendarEntries(ticker);
  const eligible = entries.filter(
    e =>
      e.earningsDate >= afterDate &&
      e.provenance.retrievedAt <= asOf
  );
  if (eligible.length === 0) return null;
  // Return soonest
  return eligible.sort((a, b) => a.earningsDate.localeCompare(b.earningsDate))[0];
}

/**
 * Get all past earnings entries for a ticker (earningsDate < today).
 * Used by the EarningsBehaviorCalculator to enumerate known report dates.
 *
 * @param ticker   Ticker to query.
 * @param before   ISO date — return entries with earningsDate < before.
 */
export function getPastEarningsDates(ticker: string, before: string): string[] {
  const entries = getCalendarEntries(ticker);
  return entries
    .filter(e => e.earningsDate < before)
    .map(e => e.earningsDate)
    .sort();
}

/**
 * Count how many tickers have calendar entries in the repository.
 * Used in the data-coverage health report.
 */
export function getCalendarCoveredTickerCount(): number {
  return analysisRepository.getAll()
    .filter(e => e.moduleName.startsWith("earnings-calendar:"))
    .length;
}
