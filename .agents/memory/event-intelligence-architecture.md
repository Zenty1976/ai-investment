---
name: Event Intelligence Architecture
description: Hybrid MAINTENANCE/DISCOVERY architecture for the event-monitor route — when each mode runs, what is stored where, and key boundary rules.
---

## What was built

`event-monitor.ts` was rewritten to use a two-mode hybrid:

- **MAINTENANCE** (zero AI) — runs when last discovery is < 180 min ago AND events already exist. Re-computes proximity buckets and status deterministically from the clock; expires passed events after 1-day grace period.
- **DISCOVERY** (AI + web search) — runs on first call, when discovery interval elapsed, or when no events exist. Merges AI candidates into existing state (never replaces wholesale).

## Storage keys

- `event-intelligence` — internal `EventIntelligenceState` (events with `EventRecord` shape, `lastDiscoveryAt`, sources, summary). Private to the event-monitor route.
- `event-monitor` — public `EventMonitorAnalysis` (existing shape). Still emitted by `toEventMonitorOutput()`; all 6+ downstream consumers read this key unchanged.

## Identity model

- Stable event ID = `kebab-case-title-YYYY-MM-DD`
- Match = normalized title + exact date (rescheduled event = new ID)
- `firstSeenAt` is never overwritten on re-discovery

## Proximity buckets (computeProximity)

```
PASSED         diffDays < 0
TODAY          diffDays === 0
WITHIN_24_HOURS  diffDays <= 1   ← boundary: exactly 1 calendar day IS within 24h
WITHIN_3_DAYS  diffDays <= 3
WITHIN_7_DAYS  diffDays <= 7
FUTURE         diffDays > 7
```

**Critical**: `diffDays <= 1` (not `< 1`) for WITHIN_24_HOURS. `diffDays === 1` (tomorrow's event) is actionable.

## Materiality fingerprint

`computeMaterialityKey` hashes `normalizedTitle|date|importance|proximityState|status` — changes only at bucket boundaries, never on countdown ticks. This prevents spurious dirty-propagation to TDE/Risk/etc.

## Discovery gate

```ts
const discoveryDue =
  state.lastDiscoveryAt === null ||
  state.events.length === 0 ||
  (now - lastDiscovery) >= 180 * 60_000;
```

## Test coverage

70 tests in `src/lib/__tests__/event-intelligence.test.ts` covering all 9 spec scenarios (A–I). All deterministic, no AI calls. Run via `node run-tests.mjs src/lib/__tests__/event-intelligence.test.ts`.

**Why:** Every maintenance pass that costs zero AI tokens instead of ~$0.01 compounds across 3-hour windows and repeated Run All calls. The discovery gate is the primary savings mechanism.
