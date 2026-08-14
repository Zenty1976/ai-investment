/**
 * Event Intelligence Layer
 *
 * Deterministic event management — no OpenAI calls, no web search.
 * Handles proximity computation, stable event identity, state maintenance,
 * and AI discovery merging.
 *
 * Separation of concerns:
 *   MAINTENANCE  — update proximity/status for known events (zero AI)
 *   DISCOVERY    — merge AI-discovered candidates into known state
 *
 * All time calculations are deterministic and server-authoritative.
 * Downstream fingerprints change only at meaningful proximity boundaries,
 * not on every countdown tick.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Deterministic proximity bucket.
 * Transitions between buckets are the only proximity changes that matter
 * for downstream fingerprints.
 */
export type ProximityState =
  | "FUTURE"           //  > 7 days away
  | "WITHIN_7_DAYS"    //  > 3 days, ≤ 7 days
  | "WITHIN_3_DAYS"    //  > 1 day, ≤ 3 days
  | "WITHIN_24_HOURS"  //  > 0 days, ≤ 1 day (including same-UTC-day events not yet past)
  | "TODAY"            //  exactly 0 calendar days (scheduled today)
  | "PASSED";          //  date is in the past

export type EventStatus = "upcoming" | "passed";

export type EventImportance = "High" | "Medium" | "Low";

/**
 * Internal event record — richer than the public UpcomingEvent schema.
 * Persisted in the event-intelligence repository key.
 */
export interface EventRecord {
  /** Stable deterministic ID: kebab-case-title-YYYY-MM-DD */
  id: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  category: string;
  importance: EventImportance;
  affectedMarkets: string[];
  expectedImpact: string;
  reason: string;
  /** Deterministic proximity bucket — recalculated on every maintenance/discovery pass */
  proximityState: ProximityState;
  status: EventStatus;
  /** ISO 8601 — when this event was first seen */
  firstSeenAt: string;
  /** ISO 8601 — last time this event was confirmed (maintenance or AI discovery) */
  lastSeenAt: string;
  /** ISO 8601 — last time content actually changed (not just proximity or metadata) */
  lastChangedAt: string;
  /**
   * Whether this event represents a Risk, an Opportunity, both, or is Unknown.
   * Optional for backward compatibility with existing stored events — defaults to "Unknown"
   * when absent. Set by the event-monitor AI discovery prompt when classifying events.
   * Read by Catalyst Intelligence to filter earnings-opportunity events.
   */
  classification?: "Risk" | "Opportunity" | "Both" | "Unknown";
}

/** Persisted state for the event intelligence layer (repository key: event-intelligence) */
export interface EventIntelligenceState {
  events: EventRecord[];
  /** Summary prose from the last AI discovery */
  summary: string;
  /** Source citations from the last AI discovery */
  sources: Array<{ title: string; url: string; published?: string }>;
  /** ISO 8601 timestamp of the last successful AI discovery — null on first run */
  lastDiscoveryAt: string | null;
}

// ── Proximity ─────────────────────────────────────────────────────────────────

/**
 * Compute the deterministic proximity bucket for an event date.
 *
 * @param dateStr  YYYY-MM-DD event date
 * @param todayMs  Current day normalized to UTC midnight (Date.setUTCHours(0,0,0,0))
 */
export function computeProximity(dateStr: string, todayMs: number): ProximityState {
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return "FUTURE"; // malformed date — treat as distant
  const eventMs = d.getTime();
  const diffDays = (eventMs - todayMs) / 86_400_000;

  if (diffDays < 0) return "PASSED";
  if (diffDays === 0) return "TODAY";
  if (diffDays <= 1) return "WITHIN_24_HOURS"; // ≤ 1 calendar day away (includes exactly 1 day)
  if (diffDays <= 3) return "WITHIN_3_DAYS";
  if (diffDays <= 7) return "WITHIN_7_DAYS";
  return "FUTURE";
}

/**
 * Returns true when a proximity transition represents a meaningful boundary
 * crossing that downstream modules should be aware of.
 *
 * Every bucket change is material — the buckets are defined to represent
 * actionable states (e.g. entering the 3-day window warrants TDE attention).
 */
export function isProximityMaterialChange(
  prev: ProximityState,
  next: ProximityState
): boolean {
  return prev !== next;
}

// ── Event identity ────────────────────────────────────────────────────────────

/**
 * Generate a stable deterministic event ID from title and date.
 * The same event discovered across multiple runs produces the same ID.
 *
 * Format: kebab-case-title-YYYY-MM-DD (max ~70 chars)
 */
export function generateEventId(title: string, date: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug}-${date}`;
}

/** Normalize a title for case-insensitive deduplication matching. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().trim();
}

/**
 * Check if an existing event record matches an incoming event candidate.
 * Match is on normalized title + exact date (YYYY-MM-DD).
 */
export function isSameEvent(
  existing: { title: string; date: string },
  incoming: { title: string; date: string }
): boolean {
  return (
    normalizeTitle(existing.title) === normalizeTitle(incoming.title) &&
    existing.date === incoming.date
  );
}

// ── Maintenance ───────────────────────────────────────────────────────────────

export interface MaintenanceResult {
  mode: "MAINTENANCE";
  state: EventIntelligenceState;
  materialChanges: string[];
  proximityBoundariesCrossed: string[];
  passedEventsExpired: number;
}

/**
 * Run deterministic event maintenance — zero AI, zero web search.
 *
 * Updates proximity buckets, status transitions, and expires events that
 * passed more than 1 day ago. Returns a detailed change log so the route
 * can decide whether to propagate a material change to downstream modules.
 */
export function runMaintenance(
  state: EventIntelligenceState,
  todayMs: number,
  nowIso: string
): MaintenanceResult {
  const materialChanges: string[] = [];
  const proximityBoundariesCrossed: string[] = [];
  let passedEventsExpired = 0;

  const updatedEvents: EventRecord[] = [];

  for (const event of state.events) {
    const newProximity = computeProximity(event.date, todayMs);
    const newStatus: EventStatus = newProximity === "PASSED" ? "passed" : "upcoming";

    // Detect proximity boundary crossing
    if (newProximity !== event.proximityState) {
      const msg = `${event.title} (${event.date}): ${event.proximityState} → ${newProximity}`;
      proximityBoundariesCrossed.push(msg);
      if (isProximityMaterialChange(event.proximityState, newProximity)) {
        materialChanges.push(`Proximity boundary crossed: ${msg}`);
      }
    }

    // Detect event-passed transition
    if (newStatus === "passed" && event.status !== "passed") {
      materialChanges.push(`Event passed: ${event.title} (${event.date})`);
    }

    // Expire events that passed more than 1 calendar day ago
    const eventMs = new Date(event.date + "T00:00:00Z").getTime();
    const daysSincePassed = (todayMs - eventMs) / 86_400_000;
    if (newStatus === "passed" && daysSincePassed > 1) {
      passedEventsExpired++;
      continue; // silently drop — it's gone
    }

    const stateChanged = newProximity !== event.proximityState || newStatus !== event.status;
    updatedEvents.push({
      ...event,
      proximityState: newProximity,
      status: newStatus,
      lastSeenAt: nowIso,
      lastChangedAt: stateChanged ? nowIso : event.lastChangedAt,
    });
  }

  return {
    mode: "MAINTENANCE",
    state: { ...state, events: updatedEvents },
    materialChanges,
    proximityBoundariesCrossed,
    passedEventsExpired,
  };
}

// ── Discovery merge ───────────────────────────────────────────────────────────

/** A single event candidate from AI discovery output. */
export interface AiEventCandidate {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  category: string;
  importance: EventImportance;
  affectedMarkets: string[];
  expectedImpact: string;
  reason: string;
}

export interface DiscoveryResult {
  mode: "DISCOVERY";
  state: EventIntelligenceState;
  newEvents: number;
  updatedEvents: number;
  duplicatesIgnored: number;
  materialChanges: string[];
}

/**
 * Merge AI discovery candidates into the existing event intelligence state.
 *
 * Rules:
 * - Existing event (same title+date) → update content if changed, keep stable ID
 * - New event (not seen before) → add with stable ID and tracking metadata
 * - Existing event not returned by AI (still upcoming) → retain for this cycle
 * - Existing event not returned by AI (now passed) → remove (AI confirmed it's gone)
 *
 * Never replaces the full state — always merges, preserving stable IDs.
 */
export function mergeDiscovery(
  existingState: EventIntelligenceState,
  candidates: AiEventCandidate[],
  newSummary: string,
  newSources: Array<{ title: string; url: string; published?: string }>,
  todayMs: number,
  nowIso: string
): DiscoveryResult {
  let newEventsCount = 0;
  let updatedEventsCount = 0;
  let duplicatesIgnored = 0;
  const materialChanges: string[] = [];

  const mergedEvents: EventRecord[] = [];
  const processedExistingIds = new Set<string>();

  // Process every AI candidate
  for (const candidate of candidates) {
    const existing = existingState.events.find((e) => isSameEvent(e, candidate));

    if (existing) {
      // Event already known — check for content changes
      processedExistingIds.add(existing.id);

      const contentChanged =
        existing.category !== candidate.category ||
        existing.importance !== candidate.importance ||
        existing.expectedImpact !== candidate.expectedImpact ||
        normalizeTitle(existing.title) !== normalizeTitle(candidate.title);

      const newProximity = computeProximity(candidate.date, todayMs);
      const newStatus: EventStatus = newProximity === "PASSED" ? "passed" : "upcoming";
      const proximityChanged = newProximity !== existing.proximityState;

      if (contentChanged) {
        updatedEventsCount++;
        materialChanges.push(`Event updated: ${candidate.title} (${candidate.date})`);
      } else if (proximityChanged) {
        materialChanges.push(
          `Proximity boundary: ${existing.title}: ${existing.proximityState} → ${newProximity}`
        );
      } else {
        duplicatesIgnored++;
      }

      mergedEvents.push({
        ...existing,
        // AI content is authoritative — always accept from discovery
        title: candidate.title,
        category: candidate.category,
        importance: candidate.importance,
        affectedMarkets: candidate.affectedMarkets,
        expectedImpact: candidate.expectedImpact,
        reason: candidate.reason,
        proximityState: newProximity,
        status: newStatus,
        lastSeenAt: nowIso,
        lastChangedAt: contentChanged ? nowIso : existing.lastChangedAt,
      });
    } else {
      // Genuinely new event
      const newProximity = computeProximity(candidate.date, todayMs);
      const newStatus: EventStatus = newProximity === "PASSED" ? "passed" : "upcoming";
      newEventsCount++;
      materialChanges.push(`New event discovered: ${candidate.title} (${candidate.date})`);

      mergedEvents.push({
        id: generateEventId(candidate.title, candidate.date),
        title: candidate.title,
        date: candidate.date,
        category: candidate.category,
        importance: candidate.importance,
        affectedMarkets: candidate.affectedMarkets,
        expectedImpact: candidate.expectedImpact,
        reason: candidate.reason,
        proximityState: newProximity,
        status: newStatus,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        lastChangedAt: nowIso,
      });
    }
  }

  // Retain known upcoming events not seen by AI this cycle
  // (AI may have omitted them due to priority limits, not because they were cancelled)
  for (const existing of existingState.events) {
    if (processedExistingIds.has(existing.id)) continue;
    // Skip if already added via title match (shouldn't happen but guard it)
    if (mergedEvents.some((e) => e.id === existing.id)) continue;

    const newProximity = computeProximity(existing.date, todayMs);
    const newStatus: EventStatus = newProximity === "PASSED" ? "passed" : "upcoming";

    if (newStatus === "passed") {
      // AI didn't re-discover this and it's now past → consider it gone
      materialChanges.push(
        `Event removed (passed, not rediscovered): ${existing.title} (${existing.date})`
      );
      continue;
    }

    // Keep the upcoming event with updated proximity
    // Don't update lastSeenAt — signals AI didn't confirm it this cycle
    mergedEvents.push({
      ...existing,
      proximityState: newProximity,
      status: newStatus,
      lastChangedAt: newProximity !== existing.proximityState ? nowIso : existing.lastChangedAt,
    });
  }

  return {
    mode: "DISCOVERY",
    state: {
      events: mergedEvents,
      summary: newSummary,
      sources: newSources,
      lastDiscoveryAt: nowIso,
    },
    newEvents: newEventsCount,
    updatedEvents: updatedEventsCount,
    duplicatesIgnored,
    materialChanges,
  };
}

// ── Materiality ───────────────────────────────────────────────────────────────

/**
 * Compute a stable materiality fingerprint for the event intelligence state.
 *
 * Includes: event identity (title + date), importance, proximity bucket, status.
 * Excludes: countdown numbers, lastCheckedAt, ordering, formatting prose.
 *
 * Two states with the same key are NOT material changes for downstream modules.
 */
export function computeMaterialityKey(events: EventRecord[]): string {
  return events
    .map(
      (e) =>
        `${normalizeTitle(e.title)}|${e.date}|${e.importance}|${e.proximityState}|${e.status}`
    )
    .sort()
    .join(";");
}

// ── Output conversion ─────────────────────────────────────────────────────────

const IMPORTANCE_RANK: Record<EventImportance, number> = {
  High: 0,
  Medium: 1,
  Low: 2,
};

/**
 * Convert event intelligence state to the public EventMonitorAnalysis format.
 *
 * Returns only upcoming events, sorted by importance then date, capped at 5.
 * countdownDays is always recalculated deterministically — never from AI.
 */
export function toEventMonitorOutput(
  state: EventIntelligenceState,
  todayMs: number,
  timestamp: string,
  analysisDuration: number
): {
  summary: string;
  nextMajorEvent: { title: string; date: string; countdownDays: number };
  events: Array<{
    title: string;
    date: string;
    category: string;
    importance: EventImportance;
    affectedMarkets: string[];
    expectedImpact: string;
    reason: string;
  }>;
  sources: Array<{ title: string; url: string; published?: string }>;
  timestamp: string;
  analysisDuration: number;
} {
  const upcoming = state.events
    .filter((e) => e.status !== "passed")
    .sort((a, b) => {
      const ra = IMPORTANCE_RANK[a.importance] ?? 3;
      const rb = IMPORTANCE_RANK[b.importance] ?? 3;
      if (ra !== rb) return ra - rb;
      return (
        new Date(a.date + "T00:00:00Z").getTime() -
        new Date(b.date + "T00:00:00Z").getTime()
      );
    })
    .slice(0, 5);

  const topEvent = upcoming[0];
  const nextMajorEvent = topEvent
    ? {
        title: topEvent.title,
        date: topEvent.date,
        countdownDays: Math.max(
          0,
          Math.round(
            (new Date(topEvent.date + "T00:00:00Z").getTime() - todayMs) /
              86_400_000
          )
        ),
      }
    : { title: "", date: "", countdownDays: 0 };

  return {
    summary: state.summary || "",
    nextMajorEvent,
    events: upcoming.map((e) => ({
      title: e.title,
      date: e.date,
      category: e.category,
      importance: e.importance,
      affectedMarkets: e.affectedMarkets,
      expectedImpact: e.expectedImpact,
      reason: e.reason,
    })),
    sources: state.sources,
    timestamp,
    analysisDuration,
  };
}

/**
 * Build a compact event index for AI prompt context.
 * Only what's needed for deduplication — no prose, no sources.
 * Upcoming events only.
 */
export function buildEventIndex(events: EventRecord[]): string {
  const upcoming = events.filter((e) => e.status !== "passed");
  if (upcoming.length === 0) return "[]";
  return JSON.stringify(
    upcoming.map((e) => ({
      id: e.id,
      title: e.title,
      date: e.date,
      category: e.category,
      importance: e.importance,
      proximityState: e.proximityState,
    })),
    null,
    0
  );
}
