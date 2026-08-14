/**
 * Company-Specific Catalyst Events (spec §3)
 *
 * Distinct from market-wide EventRecord (event-intelligence).
 * Each CompanySpecificEvent is a scheduled company event that may
 * create a pre-event investment opportunity.
 *
 * Repository key: "company-events:<TICKER>"
 *
 * Source independence (spec §7):
 *   - sourceOriginId tracks the ORIGINAL reporter (not republishers)
 *   - Events from different sources about the SAME underlying happening
 *     are merged (not stored as separate events)
 */

import { analysisRepository } from "./analysis-repository.js";
import type { CompanySpecificEvent, ScheduledCatalystType } from "./catalyst-types.js";

// ── Repository helpers ─────────────────────────────────────────────────────────

export function companyEventsKey(ticker: string): string {
  return `company-events:${ticker.toUpperCase()}`;
}

export interface StoredCompanyEvents {
  ticker: string;
  events: CompanySpecificEvent[];
  lastDiscoveredAt: string;
}

export function getCompanyEvents(ticker: string): CompanySpecificEvent[] {
  const entry = analysisRepository.get<StoredCompanyEvents>(companyEventsKey(ticker));
  return entry?.result?.events ?? [];
}

export function saveCompanyEvents(ticker: string, events: CompanySpecificEvent[]): void {
  const now = new Date().toISOString();
  analysisRepository.save(companyEventsKey(ticker), {
    ticker: ticker.toUpperCase(),
    events,
    lastDiscoveredAt: now,
  });
}

export function getAllStoredCompanyEvents(): Record<string, CompanySpecificEvent[]> {
  const result: Record<string, CompanySpecificEvent[]> = {};
  const allEntries = analysisRepository.getAll();
  for (const entry of allEntries) {
    if (entry.moduleName.startsWith("company-events:")) {
      const ticker = entry.moduleName.replace("company-events:", "");
      const stored = (entry.result as StoredCompanyEvents | undefined)?.events ?? [];
      result[ticker] = stored;
    }
  }
  return result;
}

// ── Upcoming event helpers ─────────────────────────────────────────────────────

/** Returns all upcoming (future-dated) events across all tickers. */
export function getAllUpcomingCompanyEvents(nowIso?: string): CompanySpecificEvent[] {
  const now = nowIso ?? new Date().toISOString();
  const all = getAllStoredCompanyEvents();
  const upcoming: CompanySpecificEvent[] = [];

  for (const events of Object.values(all)) {
    for (const ev of events) {
      if (ev.eventDate >= now.slice(0, 10)) {
        upcoming.push(ev);
      }
    }
  }

  // Sort ascending by eventDate
  upcoming.sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  return upcoming;
}

/** Get upcoming events for a specific ticker within a day window. */
export function getUpcomingEventsForTicker(
  ticker: string,
  maxDaysAhead = 90,
  nowIso?: string
): CompanySpecificEvent[] {
  const now = nowIso ?? new Date().toISOString();
  const today = now.slice(0, 10);
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + maxDaysAhead);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  return getCompanyEvents(ticker).filter(
    ev => ev.eventDate >= today && ev.eventDate <= cutoffStr
  );
}

/** How many days until a given event date. Negative if in the past. */
export function daysUntilEventDate(eventDateStr: string, nowIso?: string): number {
  const now = nowIso ?? new Date().toISOString();
  const nowDate = new Date(now.slice(0, 10) + "T00:00:00Z");
  const evDate = new Date(eventDateStr + "T00:00:00Z");
  return Math.round((evDate.getTime() - nowDate.getTime()) / (1000 * 60 * 60 * 24));
}

// ── Event building helpers ─────────────────────────────────────────────────────

/**
 * Build a stable event ID for a company-specific event.
 * Format: "<TICKER>-<eventType>-<YYYY-MM-DD>"
 * Ensures idempotent merging of events from different sources.
 */
export function buildEventId(ticker: string, eventType: string, eventDate: string): string {
  return `${ticker.toUpperCase()}-${eventType}-${eventDate}`;
}

/**
 * Merge a new event into the existing events list.
 * If an event with the same eventId already exists, update it if the new
 * data is from a higher-quality or more-confirmed source.
 * Returns the updated events list.
 */
export function mergeCompanyEvent(
  existing: CompanySpecificEvent[],
  incoming: CompanySpecificEvent
): CompanySpecificEvent[] {
  const idx = existing.findIndex(e => e.eventId === incoming.eventId);
  if (idx === -1) {
    return [...existing, incoming];
  }

  const prev = existing[idx];
  // Prefer confirmed over unconfirmed
  const usePrev = prev.isConfirmed && !incoming.isConfirmed;
  const merged: CompanySpecificEvent = {
    ...prev,
    ...incoming,
    // Keep the original discoveredAt
    discoveredAt: prev.discoveredAt,
    // Always update lastUpdatedAt
    lastUpdatedAt: new Date().toISOString(),
    // Once confirmed, stay confirmed
    isConfirmed: prev.isConfirmed || incoming.isConfirmed,
    // Merge expected topics (dedup)
    expectedTopics: dedup([...prev.expectedTopics, ...incoming.expectedTopics]),
  };

  if (usePrev) {
    // Restore quality fields from the confirmed event
    Object.assign(merged, {
      source:         prev.source,
      sourceType:     prev.sourceType,
      sourceOriginId: prev.sourceOriginId,
      canonicalSource: prev.canonicalSource,
    });
  }

  const updated = [...existing];
  updated[idx] = merged;
  return updated;
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

// ── Type helpers ───────────────────────────────────────────────────────────────

/**
 * Map from event-intelligence EventRecord classification to ScheduledCatalystType.
 * Returns null if the event type cannot be mapped.
 */
export function classifyEventType(
  rawType: string | undefined,
  rawTitle: string
): ScheduledCatalystType | null {
  const t = (rawType ?? "").toLowerCase();
  const title = rawTitle.toLowerCase();

  if (t.includes("earn") || title.includes("earn") || title.includes("q1") || title.includes("q2") || title.includes("q3") || title.includes("q4") || title.includes("annual result")) return "EARNINGS";
  if (t.includes("guidance") || title.includes("guidance") || title.includes("profit warning") || title.includes("preannouncement")) return "GUIDANCE_UPDATE";
  if (t.includes("investor day") || title.includes("investor day") || title.includes("investor event")) return "INVESTOR_DAY";
  if (t.includes("capital markets") || title.includes("capital markets day") || title.includes("cmd")) return "CAPITAL_MARKETS_DAY";
  if (t.includes("agm") || t.includes("shareholder") || title.includes("annual general meeting") || title.includes("agm")) return "SHAREHOLDER_MEETING";
  if (title.includes("product launch") || title.includes("launches") || title.includes("new model") || title.includes("unveil")) return "PRODUCT_LAUNCH";
  if (title.includes("ai model") || title.includes("gpt") || title.includes("gemini") || title.includes("claude") || title.includes("llm launch")) return "AI_MODEL_LAUNCH";
  if (title.includes("developer") && (title.includes("conference") || title.includes("day") || title.includes("summit"))) return "DEVELOPER_CONFERENCE";
  if (title.includes("keynote")) return "KEYNOTE";
  if (title.includes("fda") && (title.includes("decision") || title.includes("approval") || title.includes("pdufa"))) return "FDA_DECISION";
  if (title.includes("clinical") || title.includes("trial result") || title.includes("phase 2") || title.includes("phase 3") || title.includes("readout")) return "CLINICAL_READOUT";
  if (title.includes("regulatory") || title.includes("approval")) return "REGULATORY_DECISION";
  if (title.includes("court") || title.includes("ruling") || title.includes("verdict")) return "COURT_DECISION";
  if (title.includes("merger") || title.includes("acquisition") || title.includes("takeover") || title.includes("m&a")) return "M_AND_A_EVENT";
  if (title.includes("lockup") || title.includes("lock-up") || title.includes("lock up expir")) return "LOCKUP_EXPIRATION";
  if (title.includes("strategy") || title.includes("strategic update") || title.includes("medium-term plan")) return "STRATEGY_UPDATE";
  if (title.includes("contract") || title.includes("tender") || title.includes("awarded")) return "MAJOR_CONTRACT_DECISION";
  if (title.includes("management") && title.includes("presentation")) return "MANAGEMENT_PRESENTATION";

  return "OTHER_COMPANY_CATALYST";
}

/** Compute potentialMarketImpact from event type. */
export function eventTypeImpact(eventType: ScheduledCatalystType): "High" | "Medium" | "Low" {
  const highImpact: ScheduledCatalystType[] = [
    "EARNINGS", "GUIDANCE_UPDATE", "FDA_DECISION", "M_AND_A_EVENT",
    "CLINICAL_READOUT", "REGULATORY_DECISION", "INVESTOR_DAY", "CAPITAL_MARKETS_DAY",
    "STRATEGY_UPDATE",
  ];
  const mediumImpact: ScheduledCatalystType[] = [
    "PRODUCT_LAUNCH", "AI_MODEL_LAUNCH", "DEVELOPER_CONFERENCE", "KEYNOTE",
    "COURT_DECISION", "MAJOR_CONTRACT_DECISION", "LOCKUP_EXPIRATION",
    "SHAREHOLDER_MEETING", "COMPANY_MEETING",
  ];
  if (highImpact.includes(eventType)) return "High";
  if (mediumImpact.includes(eventType)) return "Medium";
  return "Low";
}

/** Label for display in the UI. */
export function eventTypeLabel(eventType: ScheduledCatalystType): string {
  const labels: Record<ScheduledCatalystType, string> = {
    EARNINGS: "Earnings",
    GUIDANCE_UPDATE: "Guidance Update",
    INVESTOR_DAY: "Investor Day",
    CAPITAL_MARKETS_DAY: "Capital Markets Day",
    COMPANY_MEETING: "Company Meeting",
    SHAREHOLDER_MEETING: "Shareholder Meeting",
    PRODUCT_LAUNCH: "Product Launch",
    AI_MODEL_LAUNCH: "AI Model Launch",
    TECHNOLOGY_DEMONSTRATION: "Tech Demo",
    DEVELOPER_CONFERENCE: "Developer Conference",
    KEYNOTE: "Keynote",
    CLINICAL_READOUT: "Clinical Readout",
    FDA_DECISION: "FDA Decision",
    REGULATORY_DECISION: "Regulatory Decision",
    COURT_DECISION: "Court Decision",
    MAJOR_CONTRACT_DECISION: "Major Contract",
    M_AND_A_EVENT: "M&A Event",
    LOCKUP_EXPIRATION: "Lock-up Expiration",
    STRATEGY_UPDATE: "Strategy Update",
    MANAGEMENT_PRESENTATION: "Management Presentation",
    OTHER_COMPANY_CATALYST: "Other Catalyst",
  };
  return labels[eventType] ?? eventType;
}
