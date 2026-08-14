/**
 * Catalyst Event Discovery Gate — lightweight cost-safety checks (spec §4)
 *
 * Contains ONLY the freshness/skip logic for proactive event discovery.
 * Zero AI service dependency — safe to import in tests.
 *
 * The actual AI web search lives in catalyst-event-discovery.ts which imports
 * this file for its gate functions.
 *
 * Gates:
 *   - Minimum 48h between discovery runs per ticker (DISCOVERY_MIN_INTERVAL_MS)
 *   - Skip if DISCOVERY_SKIP_IF_EVENTS_GTE or more upcoming events already stored
 */

import { analysisRepository } from "./analysis-repository.js";
import { companyEventsKey, getUpcomingEventsForTicker } from "./catalyst-company-events.js";
import type { StoredCompanyEvents } from "./catalyst-company-events.js";

// ── Gate constants ────────────────────────────────────────────────────────────

/** Minimum interval between discovery runs per ticker (ms). */
export const DISCOVERY_MIN_INTERVAL_MS = 48 * 60 * 60 * 1000; // 48 hours

/** Number of upcoming events in the window that suppresses re-discovery. */
export const DISCOVERY_SKIP_IF_EVENTS_GTE = 2;

/** Default upcoming-events window for the "enough events" check (days). */
export const DISCOVERY_WINDOW_DAYS = 90;

// ── Gate function ─────────────────────────────────────────────────────────────

/**
 * Check whether event discovery should run for a given ticker.
 *
 * Returns the reason to skip (string), or null if discovery should proceed.
 *
 * Callers: discoverEventsForTicker() (discovery module), runProactiveEventDiscovery() (route).
 */
export function shouldSkipDiscovery(ticker: string, nowIso?: string): string | null {
  const now = nowIso ?? new Date().toISOString();

  // Gate 1: Was discovery run recently (< 48h)?
  const entry = analysisRepository.get<StoredCompanyEvents>(companyEventsKey(ticker));
  const lastDiscoveredAt = entry?.result?.lastDiscoveredAt;
  if (lastDiscoveredAt) {
    const age = Date.now() - new Date(lastDiscoveredAt).getTime();
    if (age < DISCOVERY_MIN_INTERVAL_MS) {
      return `Discovery fresh (${Math.round(age / 3_600_000)}h ago < 48h minimum)`;
    }
  }

  // Gate 2: Enough upcoming events already stored in the window?
  const upcoming = getUpcomingEventsForTicker(ticker, DISCOVERY_WINDOW_DAYS, now);
  if (upcoming.length >= DISCOVERY_SKIP_IF_EVENTS_GTE) {
    return `${upcoming.length} upcoming events already stored — no discovery needed`;
  }

  return null; // proceed with discovery
}
