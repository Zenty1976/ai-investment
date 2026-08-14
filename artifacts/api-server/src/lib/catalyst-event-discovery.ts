/**
 * Catalyst Event Discovery — shared discovery logic (spec §4)
 *
 * Extracts the web-search event discovery logic from routes/company-events.ts
 * into a shared, cost-safe function callable from:
 *   - routes/company-events.ts (manual endpoint)
 *   - routes/catalyst-intelligence.ts (proactive discovery during screen runs)
 *
 * Cost-safe gates (spec §4):
 *   - Checks lastDiscoveredAt before calling Saxo/OpenAI
 *   - Minimum 48h between discovery runs per ticker
 *   - Skip if there are already upcoming events in the screening window
 *   - Cap: max N discoveries per screen run (caller-controlled)
 */

import { callAiWithWebSearch } from "./ai-service.js";
import { getModel } from "./ai-model-config.js";
import {
  getCompanyEvents, saveCompanyEvents,
  mergeCompanyEvent, classifyEventType, eventTypeImpact,
  daysUntilEventDate, getUpcomingEventsForTicker,
} from "./catalyst-company-events.js";
import type { CompanySpecificEvent, ScheduledCatalystType } from "./catalyst-types.js";

// Re-export gate constants and function so callers only need one import.
export {
  DISCOVERY_MIN_INTERVAL_MS,
  DISCOVERY_SKIP_IF_EVENTS_GTE,
  DISCOVERY_WINDOW_DAYS,
  shouldSkipDiscovery,
} from "./catalyst-event-gate.js";

// Local import for use within this file
import { shouldSkipDiscovery as _shouldSkipDiscovery } from "./catalyst-event-gate.js";

// ── Discovery system prompt ───────────────────────────────────────────────────

const DISCOVERY_SYSTEM_PROMPT = `You are a financial events research assistant. Find upcoming, scheduled company-specific events that could move the stock price in the next 3 months.

Focus on: earnings dates, investor days, capital markets days, FDA decisions, product launches, clinical readouts, shareholder meetings, developer conferences.

RULES:
- Only events with a SPECIFIC date (YYYY-MM-DD) or narrow date window
- NEVER include events already passed
- isConfirmed = true only for officially announced events
- isConfirmed = false for analyst estimates or historical-pattern guesses
- potentialMarketImpact: "High" for earnings/FDA/investor day; "Medium" for product launches; "Low" for routine

OUTPUT: strict JSON array (may be empty []):
[{
  "eventType": "EARNINGS|GUIDANCE_UPDATE|INVESTOR_DAY|CAPITAL_MARKETS_DAY|PRODUCT_LAUNCH|AI_MODEL_LAUNCH|CLINICAL_READOUT|FDA_DECISION|REGULATORY_DECISION|STRATEGY_UPDATE|SHAREHOLDER_MEETING|COMPANY_MEETING|DEVELOPER_CONFERENCE|KEYNOTE|OTHER_COMPANY_CATALYST",
  "title": "Brief event title",
  "eventDate": "YYYY-MM-DD",
  "beforeAfterMarket": "BeforeMarket|AfterMarket|DuringMarket|Unknown",
  "isConfirmed": true,
  "expectedTopics": ["topic 1"],
  "potentialMarketImpact": "High|Medium|Low|Unknown",
  "uncertainty": "High|Medium|Low",
  "source": "Source name or URL"
}]`;

// ── Discovery function ────────────────────────────────────────────────────────

export interface DiscoveryResult {
  ticker: string;
  discovered: number;
  totalUpcoming: number;
  skipped: boolean;
  skipReason: string | null;
  events: CompanySpecificEvent[];
}

/**
 * Discover upcoming company-specific events for a ticker via AI web search.
 *
 * Cost-safe — checks the freshness gate before making any AI call.
 * Merges results into the persistent company-events store.
 *
 * @param ticker   Ticker symbol
 * @param company  Company display name
 * @param force    If true, bypasses the freshness gate (use for manual refresh)
 */
export async function discoverEventsForTicker(
  ticker: string,
  company: string,
  force = false,
  maxDaysAhead = 90
): Promise<DiscoveryResult> {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // Freshness gate
  if (!force) {
    const skipReason = _shouldSkipDiscovery(ticker, now);
    if (skipReason) {
      const upcoming = getUpcomingEventsForTicker(ticker, maxDaysAhead, now);
      return { ticker, discovered: 0, totalUpcoming: upcoming.length, skipped: true, skipReason, events: upcoming };
    }
  }

  const userPrompt = `Find all upcoming company-specific events for ${company} (ticker: ${ticker}) in the next ${maxDaysAhead} days.

Search for: earnings dates, investor days, FDA decisions, product launches, clinical readouts, major conferences, strategy updates.

Return strict JSON array (can be empty []).`;

  let rawArray: unknown[] = [];
  try {
    const { result } = await callAiWithWebSearch<unknown[]>(
      DISCOVERY_SYSTEM_PROMPT,
      userPrompt,
      {
        model: getModel("discovery", "company-events"),
        maxTokens: 1500,
        temperature: 0.1,
        jsonMode: false,
        module: "company-events",
        operation: "discover",
        retryNumber: 0,
        webSearchContextSize: "medium",
      }
    );
    rawArray = Array.isArray(result) ? result : [];
  } catch {
    // Discovery failure is non-fatal — return empty
    const upcoming = getUpcomingEventsForTicker(ticker, maxDaysAhead, now);
    return { ticker, discovered: 0, totalUpcoming: upcoming.length, skipped: false, skipReason: null, events: upcoming };
  }

  // Parse discovered events
  const discovered: CompanySpecificEvent[] = [];
  for (const item of rawArray) {
    if (!item || typeof item !== "object") continue;
    const ev = item as Record<string, unknown>;
    const eventDateRaw = String(ev["eventDate"] ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDateRaw) || eventDateRaw < today) continue;

    const rawEventType = String(ev["eventType"] ?? "").trim();
    const title = String(ev["title"] ?? "").trim();
    const eventType: ScheduledCatalystType = classifyEventType(rawEventType, title) ?? "OTHER_COMPANY_CATALYST";

    const beforeAfterRaw = String(ev["beforeAfterMarket"] ?? "Unknown");
    const validTimings = ["BeforeMarket", "AfterMarket", "DuringMarket", "Unknown"];
    const beforeAfterMarket = validTimings.includes(beforeAfterRaw)
      ? beforeAfterRaw as CompanySpecificEvent["beforeAfterMarket"]
      : "Unknown";

    const impactRaw = String(ev["potentialMarketImpact"] ?? "Unknown");
    const validImpacts = ["High", "Medium", "Low", "Unknown"];
    const potentialMarketImpact = validImpacts.includes(impactRaw)
      ? impactRaw as "High" | "Medium" | "Low" | "Unknown"
      : eventTypeImpact(eventType);

    const uncertaintyRaw = String(ev["uncertainty"] ?? "Medium");
    const validUncertainties = ["High", "Medium", "Low"];
    const uncertainty = validUncertainties.includes(uncertaintyRaw)
      ? uncertaintyRaw as "High" | "Medium" | "Low"
      : "Medium";

    // Build stable eventId
    const eventId = `${ticker.toUpperCase()}-${eventType}-${eventDateRaw}`;

    discovered.push({
      eventId,
      ticker: ticker.toUpperCase(),
      company,
      eventType,
      title: title || `${eventType} — ${company}`,
      eventDate: eventDateRaw,
      eventTime: null,
      beforeAfterMarket,
      isConfirmed: ev["isConfirmed"] === true,
      expectedTopics: Array.isArray(ev["expectedTopics"]) ? ev["expectedTopics"].map(String) : [],
      potentialMarketImpact,
      uncertainty,
      source: String(ev["source"] ?? "Web Discovery"),
      sourceType: "ReliableReporting",
      sourceOriginId: null,
      canonicalSource: null,
      classification: "Unknown",
      discoveredAt: now,
      lastUpdatedAt: now,
    });
  }

  // Merge into persistent store
  let existingEvents = getCompanyEvents(ticker);
  for (const ev of discovered) {
    existingEvents = mergeCompanyEvent(existingEvents, ev);
  }
  // saveCompanyEvents updates lastDiscoveredAt
  saveCompanyEvents(ticker, existingEvents);

  const upcoming = existingEvents.filter(ev => ev.eventDate >= today);
  return { ticker, discovered: discovered.length, totalUpcoming: upcoming.length, skipped: false, skipReason: null, events: upcoming };
}
