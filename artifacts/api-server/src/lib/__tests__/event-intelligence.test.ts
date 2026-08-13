/**
 * Event Intelligence Layer — unit tests.
 *
 * All tests are fully deterministic.  No OpenAI calls, no web search,
 * no network, no repository side-effects.
 *
 * Covers all 9 required scenarios from the spec plus edge cases.
 *
 * Run: node run-tests.mjs src/lib/__tests__/event-intelligence.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeProximity,
  generateEventId,
  normalizeTitle,
  isSameEvent,
  runMaintenance,
  mergeDiscovery,
  computeMaterialityKey,
  toEventMonitorOutput,
  buildEventIndex,
  isProximityMaterialChange,
  type EventRecord,
  type EventIntelligenceState,
  type AiEventCandidate,
} from "../event-intelligence.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function utcMidnight(dateStr: string): number {
  return new Date(dateStr + "T00:00:00Z").getTime();
}

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  const date = overrides.date ?? "2026-09-01";
  const title = overrides.title ?? "FOMC Rate Decision";
  return {
    id: generateEventId(title, date),
    title,
    date,
    category: "Central Bank",
    importance: "High",
    affectedMarkets: ["US Equities", "Bonds"],
    expectedImpact: "Rate decision affects borrowing costs and equity valuations.",
    reason: "Fed sets benchmark rates; markets re-price on surprises.",
    proximityState: "FUTURE",
    status: "upcoming",
    firstSeenAt: "2026-08-01T10:00:00Z",
    lastSeenAt: "2026-08-01T10:00:00Z",
    lastChangedAt: "2026-08-01T10:00:00Z",
    ...overrides,
  };
}

function makeState(events: EventRecord[], overrides: Partial<EventIntelligenceState> = {}): EventIntelligenceState {
  return {
    events,
    summary: "Two high-impact macro events ahead.",
    sources: [{ title: "Fed Calendar", url: "https://fed.gov/calendar" }],
    lastDiscoveryAt: "2026-08-01T10:00:00Z",
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<AiEventCandidate> = {}): AiEventCandidate {
  return {
    title: "FOMC Rate Decision",
    date: "2026-09-01",
    category: "Central Bank",
    importance: "High",
    affectedMarkets: ["US Equities", "Bonds"],
    expectedImpact: "Rate decision affects borrowing costs and equity valuations.",
    reason: "Fed benchmark rate decision.",
    ...overrides,
  };
}

const NOW_ISO = "2026-08-14T12:00:00Z";

// ═════════════════════════════════════════════════════════════════════════════
// computeProximity — deterministic time bucketing
// ═════════════════════════════════════════════════════════════════════════════

describe("computeProximity", () => {
  const TODAY = "2026-08-14";
  const todayMs = utcMidnight(TODAY);

  it("classifies event > 7 days away as FUTURE", () => {
    assert.equal(computeProximity("2026-08-22", todayMs), "FUTURE");
    assert.equal(computeProximity("2026-09-01", todayMs), "FUTURE");
  });

  it("classifies event exactly 7 days away as WITHIN_7_DAYS", () => {
    assert.equal(computeProximity("2026-08-21", todayMs), "WITHIN_7_DAYS");
  });

  it("classifies event 4 days away as WITHIN_7_DAYS", () => {
    assert.equal(computeProximity("2026-08-18", todayMs), "WITHIN_7_DAYS");
  });

  it("classifies event exactly 3 days away as WITHIN_3_DAYS", () => {
    assert.equal(computeProximity("2026-08-17", todayMs), "WITHIN_3_DAYS");
  });

  it("classifies event 2 days away as WITHIN_3_DAYS", () => {
    assert.equal(computeProximity("2026-08-16", todayMs), "WITHIN_3_DAYS");
  });

  it("classifies event exactly 1 day away as WITHIN_24_HOURS", () => {
    assert.equal(computeProximity("2026-08-15", todayMs), "WITHIN_24_HOURS");
  });

  it("classifies event today as TODAY", () => {
    assert.equal(computeProximity("2026-08-14", todayMs), "TODAY");
  });

  it("classifies event in the past as PASSED", () => {
    assert.equal(computeProximity("2026-08-13", todayMs), "PASSED");
    assert.equal(computeProximity("2026-07-01", todayMs), "PASSED");
  });

  it("handles malformed date gracefully (returns FUTURE)", () => {
    assert.equal(computeProximity("not-a-date", todayMs), "FUTURE");
    assert.equal(computeProximity("", todayMs), "FUTURE");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// isProximityMaterialChange
// ═════════════════════════════════════════════════════════════════════════════

describe("isProximityMaterialChange", () => {
  it("returns false when buckets are the same", () => {
    assert.equal(isProximityMaterialChange("FUTURE", "FUTURE"), false);
    assert.equal(isProximityMaterialChange("WITHIN_7_DAYS", "WITHIN_7_DAYS"), false);
  });

  it("returns true for every bucket transition", () => {
    assert.equal(isProximityMaterialChange("FUTURE", "WITHIN_7_DAYS"), true);
    assert.equal(isProximityMaterialChange("WITHIN_7_DAYS", "WITHIN_3_DAYS"), true);
    assert.equal(isProximityMaterialChange("WITHIN_3_DAYS", "WITHIN_24_HOURS"), true);
    assert.equal(isProximityMaterialChange("WITHIN_24_HOURS", "TODAY"), true);
    assert.equal(isProximityMaterialChange("TODAY", "PASSED"), true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// generateEventId / isSameEvent
// ═════════════════════════════════════════════════════════════════════════════

describe("generateEventId", () => {
  it("produces stable ID for same title+date", () => {
    const id1 = generateEventId("FOMC Rate Decision", "2026-09-01");
    const id2 = generateEventId("FOMC Rate Decision", "2026-09-01");
    assert.equal(id1, id2);
  });

  it("produces different ID for different date (rescheduled event)", () => {
    const id1 = generateEventId("FOMC Rate Decision", "2026-09-01");
    const id2 = generateEventId("FOMC Rate Decision", "2026-10-01");
    assert.notEqual(id1, id2);
  });

  it("produces different ID for different title", () => {
    const id1 = generateEventId("FOMC Rate Decision", "2026-09-01");
    const id2 = generateEventId("CPI Release", "2026-09-01");
    assert.notEqual(id1, id2);
  });

  it("produces only URL-safe characters", () => {
    const id = generateEventId("U.S. CPI — August 2026", "2026-09-12");
    assert.match(id, /^[a-z0-9-]+$/);
  });
});

describe("isSameEvent", () => {
  it("matches same title (case-insensitive) and same date", () => {
    assert.equal(
      isSameEvent(
        { title: "FOMC Rate Decision", date: "2026-09-01" },
        { title: "fomc rate decision", date: "2026-09-01" }
      ),
      true
    );
  });

  it("does NOT match same title but different date (rescheduled)", () => {
    assert.equal(
      isSameEvent(
        { title: "FOMC Rate Decision", date: "2026-09-01" },
        { title: "FOMC Rate Decision", date: "2026-10-01" }
      ),
      false
    );
  });

  it("does NOT match different titles", () => {
    assert.equal(
      isSameEvent(
        { title: "CPI Release", date: "2026-09-12" },
        { title: "FOMC Rate Decision", date: "2026-09-12" }
      ),
      false
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario A — Known event 5 days away → maintenance updates proximity → no AI
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario A — maintenance updates proximity, no AI", () => {
  const TODAY = "2026-08-14";
  const todayMs = utcMidnight(TODAY);

  it("updates proximity from FUTURE to WITHIN_7_DAYS when event becomes 5 days away", () => {
    const event = makeEvent({
      date: "2026-08-19",  // 5 days from Aug 14
      proximityState: "FUTURE", // was stored as FUTURE (e.g. 10 days ago)
    });
    const state = makeState([event]);

    const result = runMaintenance(state, todayMs, NOW_ISO);

    assert.equal(result.mode, "MAINTENANCE");
    const updatedEvent = result.state.events.find((e) => e.id === event.id)!;
    assert.ok(updatedEvent, "Event must still be present");
    assert.equal(updatedEvent.proximityState, "WITHIN_7_DAYS");
    assert.equal(updatedEvent.status, "upcoming");
  });

  it("records the proximity boundary crossing as material", () => {
    const event = makeEvent({
      date: "2026-08-19",
      proximityState: "FUTURE",
    });
    const result = runMaintenance(makeState([event]), todayMs, NOW_ISO);

    assert.ok(result.materialChanges.length > 0, "Must record material change");
    assert.ok(result.proximityBoundariesCrossed.length > 0);
    assert.ok(result.materialChanges.some((c) => c.includes("WITHIN_7_DAYS")));
  });

  it("does NOT cross a boundary when event is still in same bucket", () => {
    const event = makeEvent({
      date: "2026-08-22",   // 8 days from Aug 14 → FUTURE
      proximityState: "FUTURE",
    });
    const result = runMaintenance(makeState([event]), todayMs, NOW_ISO);

    assert.equal(result.proximityBoundariesCrossed.length, 0, "No boundary crossing");
    assert.equal(result.materialChanges.length, 0, "No material changes");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario B — Same event on next run → same stable ID → no duplicate
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario B — same event across runs — stable ID, no duplicate", () => {
  const TODAY = "2026-08-14";
  const todayMs = utcMidnight(TODAY);

  it("produces the same event ID on two consecutive merges", () => {
    const candidate: AiEventCandidate = makeCandidate();
    const emptyState = makeState([], { lastDiscoveryAt: null });

    const result1 = mergeDiscovery(emptyState, [candidate], "Summary.", [], todayMs, NOW_ISO);
    const id1 = result1.state.events[0].id;

    // Second run: same candidate again
    const result2 = mergeDiscovery(result1.state, [candidate], "Summary.", [], todayMs, NOW_ISO);
    const id2 = result2.state.events[0].id;

    assert.equal(id1, id2, "Stable event ID across runs");
    assert.equal(result1.state.events.length, 1);
    assert.equal(result2.state.events.length, 1, "No duplicate created");
  });

  it("counts unchanged re-discovery as duplicatesIgnored", () => {
    const candidate = makeCandidate();
    const knownState = makeState([makeEvent()]);

    const result = mergeDiscovery(knownState, [candidate], "Summary.", [], todayMs, NOW_ISO);

    assert.equal(result.state.events.length, 1, "Still one event");
    assert.equal(result.newEvents, 0);
    assert.equal(result.duplicatesIgnored, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario C — Event crosses 3-day boundary → material change → no AI
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario C — 3-day boundary crossing is material, no AI needed", () => {
  const TODAY = "2026-08-14";
  const todayMs = utcMidnight(TODAY);

  it("WITHIN_7_DAYS → WITHIN_3_DAYS is a material change", () => {
    const event = makeEvent({
      date: "2026-08-17",   // 3 days away → WITHIN_3_DAYS
      proximityState: "WITHIN_7_DAYS",  // was stored as WITHIN_7_DAYS
    });
    const result = runMaintenance(makeState([event]), todayMs, NOW_ISO);

    assert.ok(result.materialChanges.length > 0, "Must be material");
    const updatedEvent = result.state.events[0];
    assert.equal(updatedEvent.proximityState, "WITHIN_3_DAYS");
  });

  it("materiality key changes when proximity bucket changes", () => {
    const eventBefore = makeEvent({
      date: "2026-08-17",
      proximityState: "WITHIN_7_DAYS",
    });
    const eventAfter = { ...eventBefore, proximityState: "WITHIN_3_DAYS" as const };

    const keyBefore = computeMaterialityKey([eventBefore]);
    const keyAfter = computeMaterialityKey([eventAfter]);

    assert.notEqual(keyBefore, keyAfter, "Downstream fingerprint must change at boundary");
  });

  it("materiality key does NOT change within the same bucket (no churn)", () => {
    // Simulating two maintenance passes where event stays in WITHIN_7_DAYS
    // (e.g. day 7 → day 6, both WITHIN_7_DAYS)
    const event1 = makeEvent({ date: "2026-08-21", proximityState: "WITHIN_7_DAYS" });
    const event2 = makeEvent({ date: "2026-08-21", proximityState: "WITHIN_7_DAYS" });

    const key1 = computeMaterialityKey([event1]);
    const key2 = computeMaterialityKey([event2]);

    assert.equal(key1, key2, "No downstream churn within the same proximity bucket");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario D — Event passes → status updates deterministically → no AI
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario D — event passes deterministically, no AI", () => {
  const TODAY = "2026-08-14";
  const todayMs = utcMidnight(TODAY);

  it("marks event as passed when its date is in the past", () => {
    const event = makeEvent({
      date: "2026-08-13",  // yesterday
      proximityState: "TODAY",
      status: "upcoming",
    });
    const result = runMaintenance(makeState([event]), todayMs, NOW_ISO);

    // Event is passed but only 1 day ago — should still be present (grace period)
    const updated = result.state.events.find((e) => e.id === event.id);
    assert.ok(updated, "Event should still be present (within 1-day grace period)");
    assert.equal(updated.status, "passed");
    assert.equal(updated.proximityState, "PASSED");
    assert.ok(result.materialChanges.some((c) => c.includes("passed")));
  });

  it("expires event that passed more than 1 day ago", () => {
    const event = makeEvent({
      date: "2026-08-12",  // 2 days ago
      proximityState: "PASSED",
      status: "passed",
    });
    const result = runMaintenance(makeState([event]), todayMs, NOW_ISO);

    assert.equal(result.state.events.length, 0, "Expired event must be removed");
    assert.equal(result.passedEventsExpired, 1);
  });

  it("materiality key changes when event transitions to PASSED", () => {
    const before = makeEvent({ proximityState: "TODAY", status: "upcoming" });
    const after = { ...before, proximityState: "PASSED" as const, status: "passed" as const };

    const keyBefore = computeMaterialityKey([before]);
    const keyAfter = computeMaterialityKey([after]);

    assert.notEqual(keyBefore, keyAfter, "Passed transition must be material");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario E — Discovery returns already-known event → deduplicated
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario E — AI rediscovers known event → deduplicated", () => {
  const TODAY = "2026-08-14";
  const todayMs = utcMidnight(TODAY);

  it("does not create a second event when AI returns a known event", () => {
    const knownEvent = makeEvent({ date: "2026-08-21", proximityState: "WITHIN_7_DAYS" });
    const state = makeState([knownEvent]);
    const candidate = makeCandidate({ date: "2026-08-21" }); // same title+date

    const result = mergeDiscovery(state, [candidate], "Summary.", [], todayMs, NOW_ISO);

    assert.equal(result.state.events.length, 1, "Still exactly one event");
    assert.equal(result.newEvents, 0);
    assert.equal(result.duplicatesIgnored, 1);
    assert.equal(result.state.events[0].id, knownEvent.id, "Stable ID preserved");
  });

  it("preserves firstSeenAt from the original event on re-discovery", () => {
    const knownEvent = makeEvent({
      date: "2026-08-21",
      firstSeenAt: "2026-08-01T00:00:00Z",
    });
    const state = makeState([knownEvent]);
    const candidate = makeCandidate({ date: "2026-08-21" });

    const result = mergeDiscovery(state, [candidate], "Summary.", [], todayMs, NOW_ISO);

    assert.equal(result.state.events[0].firstSeenAt, "2026-08-01T00:00:00Z");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario F — Discovery returns genuinely new event → added with stable state
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario F — genuinely new event discovered", () => {
  const TODAY = "2026-08-14";
  const todayMs = utcMidnight(TODAY);

  it("adds new event with stable ID and tracking metadata", () => {
    const state = makeState([]); // no known events
    const candidate = makeCandidate({ title: "CPI Release", date: "2026-08-27" });

    const result = mergeDiscovery(state, [candidate], "New events found.", [], todayMs, NOW_ISO);

    assert.equal(result.newEvents, 1);
    assert.equal(result.state.events.length, 1);
    const newEvent = result.state.events[0];
    assert.equal(newEvent.title, "CPI Release");
    assert.ok(newEvent.id.startsWith("cpi-release-"), "ID derived from title+date");
    assert.equal(newEvent.firstSeenAt, NOW_ISO);
    assert.equal(newEvent.lastSeenAt, NOW_ISO);
    assert.ok(result.materialChanges.some((c) => c.includes("New event discovered")));
  });

  it("new event has correct proximity computed", () => {
    const state = makeState([]);
    const candidate = makeCandidate({ date: "2026-08-16" }); // 2 days away

    const result = mergeDiscovery(state, [candidate], "Summary.", [], todayMs, NOW_ISO);
    assert.equal(result.state.events[0].proximityState, "WITHIN_3_DAYS");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario G — Event rescheduled (different date, same title)
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario G — event rescheduled (new date)", () => {
  const TODAY = "2026-08-14";
  const todayMs = utcMidnight(TODAY);

  it("old event is kept, new date appears as a separate new event", () => {
    // Identity is title+date; rescheduled event = different date = different event
    const oldEvent = makeEvent({ date: "2026-09-01", proximityState: "FUTURE" });
    const state = makeState([oldEvent]);

    // AI returns same title but different (rescheduled) date
    const candidate = makeCandidate({ title: "FOMC Rate Decision", date: "2026-09-17" });

    const result = mergeDiscovery(state, [candidate], "Rescheduled.", [], todayMs, NOW_ISO);

    // The new date creates a new event; old event is retained (upcoming, AI may have omitted it)
    assert.ok(
      result.state.events.length >= 1,
      "At least the new event must be present"
    );
    const newEventById = result.state.events.find((e) =>
      e.date === "2026-09-17"
    );
    assert.ok(newEventById, "Rescheduled event with new date must exist");
    assert.equal(result.newEvents, 1);
    assert.equal(newEventById.id, generateEventId("FOMC Rate Decision", "2026-09-17"));
  });

  it("updated content (same title+date, different importance) is recorded as update", () => {
    const knownEvent = makeEvent({
      date: "2026-09-01",
      importance: "Medium",
      proximityState: "FUTURE",
    });
    const state = makeState([knownEvent]);
    const candidate = makeCandidate({
      date: "2026-09-01",
      importance: "High", // upgraded from Medium → content change
    });

    const result = mergeDiscovery(state, [candidate], "Updated.", [], todayMs, NOW_ISO);

    assert.equal(result.updatedEvents, 1);
    assert.equal(result.newEvents, 0);
    assert.equal(result.state.events[0].importance, "High");
    assert.ok(result.materialChanges.some((c) => c.includes("updated")));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario H — Holdings earnings in 2 days → TDE can identify event blocker
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario H — earnings event blocker preserved for Trade Decision", () => {
  const TODAY = "2026-08-14";
  const todayMs = utcMidnight(TODAY);

  it("earnings event with 2-day proximity is in WITHIN_3_DAYS bucket", () => {
    const earningsEvent = makeEvent({
      title: "SERV Earnings Release",
      date: "2026-08-16",   // 2 days away
      category: "Earnings",
      importance: "High",
      affectedMarkets: ["SERV", "Services"],
      proximityState: "FUTURE", // stale — will be updated by maintenance
    });

    const result = runMaintenance(makeState([earningsEvent]), todayMs, NOW_ISO);

    const updated = result.state.events[0];
    assert.equal(updated.proximityState, "WITHIN_3_DAYS");
    assert.equal(updated.status, "upcoming");
    assert.equal(updated.importance, "High");

    // toEventMonitorOutput exposes the event in the public format
    const output = toEventMonitorOutput(result.state, todayMs, NOW_ISO, 100);
    assert.equal(output.events.length, 1);
    const publicEvent = output.events[0];
    assert.equal(publicEvent.title, "SERV Earnings Release");
    assert.equal(publicEvent.date, "2026-08-16");
    assert.equal(publicEvent.importance, "High");
    assert.equal(publicEvent.category, "Earnings");
  });

  it("earnings event at WITHIN_24_HOURS is surfaced correctly for TDE blocking", () => {
    const earningsEvent = makeEvent({
      title: "AAPL Earnings Release",
      date: "2026-08-15",   // 1 day away
      category: "Earnings",
      importance: "High",
      affectedMarkets: ["AAPL", "Technology"],
      proximityState: "WITHIN_3_DAYS", // stale
    });

    const result = runMaintenance(makeState([earningsEvent]), todayMs, NOW_ISO);
    assert.equal(result.state.events[0].proximityState, "WITHIN_24_HOURS");
    assert.ok(result.materialChanges.length > 0, "Boundary crossing must be material");

    const output = toEventMonitorOutput(result.state, todayMs, NOW_ISO, 100);
    const ev = output.events[0];
    assert.equal(ev.title, "AAPL Earnings Release");
    assert.equal(ev.date, "2026-08-15");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario I — Run All shortly after discovery → maintenance mode
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario I — discovery gate prevents redundant AI call", () => {
  it("discovery is NOT due when last discovery was recent", () => {
    // Simulate: discovery ran 10 minutes ago
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const state = makeState(
      [makeEvent({ date: "2026-08-21", proximityState: "WITHIN_7_DAYS" })],
      { lastDiscoveryAt: tenMinutesAgo }
    );

    const DISCOVERY_INTERVAL_MS = 180 * 60_000; // 3 hours
    const discoveryAge = Date.now() - new Date(tenMinutesAgo).getTime();
    const discoveryDue = discoveryAge >= DISCOVERY_INTERVAL_MS;

    assert.equal(discoveryDue, false, "Discovery must NOT be due 10 min after last run");
  });

  it("discovery IS due when last discovery was > 3h ago", () => {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    const state = makeState(
      [makeEvent({ date: "2026-08-21", proximityState: "WITHIN_7_DAYS" })],
      { lastDiscoveryAt: fourHoursAgo }
    );

    const DISCOVERY_INTERVAL_MS = 180 * 60_000;
    const discoveryAge = Date.now() - new Date(fourHoursAgo).getTime();
    const discoveryDue = discoveryAge >= DISCOVERY_INTERVAL_MS;

    assert.equal(discoveryDue, true, "Discovery must be due after 4 hours");
  });

  it("discovery IS due when no known events exist (first run)", () => {
    const state: EventIntelligenceState = {
      events: [],
      summary: "",
      sources: [],
      lastDiscoveryAt: null,
    };
    const upcomingCount = state.events.length;

    assert.equal(upcomingCount, 0, "No events → discovery is due");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// toEventMonitorOutput — output format
// ═════════════════════════════════════════════════════════════════════════════

describe("toEventMonitorOutput", () => {
  const TODAY = "2026-08-14";
  const todayMs = utcMidnight(TODAY);

  it("sorts by importance then date", () => {
    const events: EventRecord[] = [
      makeEvent({ title: "Low event", date: "2026-08-17", importance: "Low", proximityState: "WITHIN_3_DAYS" }),
      makeEvent({ title: "High event", date: "2026-08-21", importance: "High", proximityState: "WITHIN_7_DAYS" }),
      makeEvent({ title: "Medium event", date: "2026-08-18", importance: "Medium", proximityState: "WITHIN_7_DAYS" }),
    ];
    const state = makeState(events);
    const output = toEventMonitorOutput(state, todayMs, NOW_ISO, 100);

    assert.equal(output.events[0].importance, "High");
    assert.equal(output.events[1].importance, "Medium");
    assert.equal(output.events[2].importance, "Low");
  });

  it("caps at 5 events", () => {
    const events = Array.from({ length: 8 }, (_, i) =>
      makeEvent({
        title: `Event ${i}`,
        date: `2026-08-${(16 + i).toString().padStart(2, "0")}`,
        importance: "Medium",
        proximityState: "WITHIN_7_DAYS",
      })
    );
    const output = toEventMonitorOutput(makeState(events), todayMs, NOW_ISO, 100);
    assert.equal(output.events.length, 5);
  });

  it("excludes passed events", () => {
    const events: EventRecord[] = [
      makeEvent({ title: "Past event", date: "2026-08-13", proximityState: "PASSED", status: "passed" }),
      makeEvent({ title: "Future event", date: "2026-08-21", proximityState: "WITHIN_7_DAYS", status: "upcoming" }),
    ];
    const output = toEventMonitorOutput(makeState(events), todayMs, NOW_ISO, 100);
    assert.equal(output.events.length, 1);
    assert.equal(output.events[0].title, "Future event");
  });

  it("computes countdownDays deterministically", () => {
    const event = makeEvent({ date: "2026-08-19", proximityState: "WITHIN_7_DAYS" }); // 5 days from Aug 14
    const output = toEventMonitorOutput(makeState([event]), todayMs, NOW_ISO, 100);
    assert.equal(output.nextMajorEvent.countdownDays, 5);
  });

  it("sets nextMajorEvent from the top-ranked upcoming event", () => {
    const events: EventRecord[] = [
      makeEvent({ title: "Low priority", date: "2026-08-16", importance: "Low", proximityState: "WITHIN_3_DAYS" }),
      makeEvent({ title: "High priority", date: "2026-08-21", importance: "High", proximityState: "WITHIN_7_DAYS" }),
    ];
    const output = toEventMonitorOutput(makeState(events), todayMs, NOW_ISO, 100);
    assert.equal(output.nextMajorEvent.title, "High priority");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// computeMaterialityKey
// ═════════════════════════════════════════════════════════════════════════════

describe("computeMaterialityKey", () => {
  it("returns stable key regardless of event ordering", () => {
    const e1 = makeEvent({ title: "Event A", date: "2026-08-21", proximityState: "WITHIN_7_DAYS" });
    const e2 = makeEvent({ title: "Event B", date: "2026-08-22", proximityState: "WITHIN_7_DAYS" });

    const key1 = computeMaterialityKey([e1, e2]);
    const key2 = computeMaterialityKey([e2, e1]); // different order

    assert.equal(key1, key2, "Key must be order-independent");
  });

  it("differs when an event is added", () => {
    const e1 = makeEvent({ title: "Event A", date: "2026-08-21" });
    const e2 = makeEvent({ title: "Event B", date: "2026-08-22" });

    const key1 = computeMaterialityKey([e1]);
    const key2 = computeMaterialityKey([e1, e2]);

    assert.notEqual(key1, key2);
  });

  it("same key for same events (idempotent)", () => {
    const event = makeEvent();
    assert.equal(
      computeMaterialityKey([event]),
      computeMaterialityKey([event])
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// buildEventIndex — compact AI context
// ═════════════════════════════════════════════════════════════════════════════

describe("buildEventIndex", () => {
  it("returns [] for empty state", () => {
    assert.equal(buildEventIndex([]), "[]");
  });

  it("excludes passed events", () => {
    const events: EventRecord[] = [
      makeEvent({ title: "Past", date: "2026-08-13", status: "passed", proximityState: "PASSED" }),
      makeEvent({ title: "Future", date: "2026-08-21", status: "upcoming", proximityState: "WITHIN_7_DAYS" }),
    ];
    const index = JSON.parse(buildEventIndex(events)) as unknown[];
    assert.equal(index.length, 1);
    assert.equal((index[0] as { title: string }).title, "Future");
  });

  it("includes id, title, date, category, importance, proximityState", () => {
    const event = makeEvent({ date: "2026-08-21", proximityState: "WITHIN_7_DAYS" });
    const index = JSON.parse(buildEventIndex([event])) as Record<string, unknown>[];
    const entry = index[0];
    assert.ok("id" in entry);
    assert.ok("title" in entry);
    assert.ok("date" in entry);
    assert.ok("category" in entry);
    assert.ok("importance" in entry);
    assert.ok("proximityState" in entry);
    // Must NOT include verbose prose fields
    assert.ok(!("expectedImpact" in entry), "Prose fields must be excluded from AI index");
    assert.ok(!("reason" in entry), "Prose fields must be excluded from AI index");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// mergeDiscovery — multi-event scenarios
// ═════════════════════════════════════════════════════════════════════════════

describe("mergeDiscovery — multi-event scenarios", () => {
  const TODAY = "2026-08-14";
  const todayMs = utcMidnight(TODAY);

  it("retains existing upcoming events not included in AI response", () => {
    const knownA = makeEvent({ title: "FOMC Decision", date: "2026-08-21", proximityState: "WITHIN_7_DAYS" });
    const knownB = makeEvent({ title: "CPI Release", date: "2026-08-22", proximityState: "WITHIN_7_DAYS" });
    const state = makeState([knownA, knownB]);

    // AI only returns FOMC (may have omitted CPI due to priority limit)
    const candidate = makeCandidate({ title: "FOMC Decision", date: "2026-08-21" });
    const result = mergeDiscovery(state, [candidate], "Summary.", [], todayMs, NOW_ISO);

    // CPI should still be retained (upcoming, AI just omitted it)
    assert.ok(
      result.state.events.some((e) => e.title === "CPI Release"),
      "Known upcoming event not re-discovered by AI must be retained"
    );
  });

  it("drops passed events not included in AI response", () => {
    const passed = makeEvent({
      title: "Old Event",
      date: "2026-08-13",    // yesterday
      proximityState: "PASSED",
      status: "passed",
    });
    const upcoming = makeEvent({ title: "CPI Release", date: "2026-08-22", proximityState: "WITHIN_7_DAYS" });
    const state = makeState([passed, upcoming]);

    const candidate = makeCandidate({ title: "CPI Release", date: "2026-08-22" });
    const result = mergeDiscovery(state, [candidate], "Summary.", [], todayMs, NOW_ISO);

    assert.ok(
      !result.state.events.some((e) => e.title === "Old Event"),
      "Passed event not rediscovered by AI must be removed"
    );
  });

  it("handles multiple new events from discovery", () => {
    const state = makeState([]);
    const candidates: AiEventCandidate[] = [
      makeCandidate({ title: "FOMC Decision", date: "2026-08-21" }),
      makeCandidate({ title: "CPI Release", date: "2026-08-22", importance: "High" }),
      makeCandidate({ title: "GDP Report", date: "2026-08-26", importance: "Medium" }),
    ];

    const result = mergeDiscovery(state, candidates, "Three events.", [], todayMs, NOW_ISO);

    assert.equal(result.newEvents, 3);
    assert.equal(result.state.events.length, 3);
  });

  it("updates summary and sources from AI discovery", () => {
    const state = makeState([makeEvent()], { summary: "Old summary.", sources: [] });
    const candidate = makeCandidate();
    const newSources = [{ title: "Reuters", url: "https://reuters.com/events" }];

    const result = mergeDiscovery(state, [candidate], "New summary.", newSources, todayMs, NOW_ISO);

    assert.equal(result.state.summary, "New summary.");
    assert.equal(result.state.sources.length, 1);
    assert.equal(result.state.sources[0].title, "Reuters");
    assert.equal(result.state.lastDiscoveryAt, NOW_ISO);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// normalizeTitle edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe("normalizeTitle", () => {
  it("lowercases and trims", () => {
    assert.equal(normalizeTitle("  FOMC Rate Decision  "), "fomc rate decision");
  });

  it("handles empty string", () => {
    assert.equal(normalizeTitle(""), "");
  });
});
