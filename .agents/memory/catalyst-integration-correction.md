---
name: Catalyst Integration Correction
description: 10 integration bugs fixed — universe, events, PATH B, signal persistence, Saxo report
---

# Catalyst Integration Correction — Completed 2026-08-14

## What was fixed (all 10 spec items)

**[1] Universe not used in screening**
- Deleted `collectScreenableTickers()` from route; replaced with `collectAllScreenableTickers()` from `catalyst-universe.ts`.
- This function includes portfolio + OF + CM + static universe seed (50+ tickers).

**[2] Saxo universe enrichment**
- New: `lib/catalyst-saxo-universe.ts` — per-ticker UIC enrichment via `ref/v1/instruments`.
- Limitation documented: Saxo API supports keyword search only, NOT bulk exchange listing.
- 24h cache in repository. Fire-and-forget during screen runs.
- `GET /api/catalyst-intelligence/universe` returns full Saxo status report.

**[3] Company events connected to screening**
- `screenTicker()` now calls `getUpcomingEventsForTicker()` FIRST (any event type).
- Ranks by `potentialMarketImpact × proximity`. Maps via `scheduledTypeToCatalystEventType()`.
- Earnings date is the FALLBACK, not the primary source.
- `CatalystEventSource` extended with `"CompanyEvents"`.
- `CatalystEventType` extended: `"InvestorDay"`, `"ClinicalReadout"`, `"CompanyMeeting"`.

**[4] Event discovery automation**
- `lib/catalyst-event-gate.ts` — lightweight cost-gate (no pino dependency, importable in tests).
- `lib/catalyst-event-discovery.ts` — actual AI web search (re-exports from gate file).
- Gates: 48h minimum + skip if ≥2 upcoming events already stored.
- `runProactiveEventDiscovery()` in route — max 5 discoveries per screen run.

**[5] PATH B — no event allowed**
- `CatalystFacts.event: CatalystEvent | null` (was `CatalystEvent`).
- `buildCatalystFacts({ event: null })` supported — uses 45-day default for price asymmetry.
- `analyze/:ticker` builds PATH B facts instead of bailing when `!state.facts`.
- `catalyst-analysis.ts` and `catalyst-screening.ts` use null-safe `facts.event?.xxx`.

**[6] Signal persistence**
- New: `lib/catalyst-signal-store.ts` — repository key `catalyst-signals:<TICKER>`.
- `mergeStoredSignals()` — dedup by signalId, prune >90 days.
- `screenTicker()` passes stored signals to `buildCatalystFacts`.
- `analyze/:ticker` rebuilds facts with all accumulated signals.

**[7] Driver research → stored signals**
- New: `lib/catalyst-signal-research.ts` — `researchDriverSignals()`.
- Max 3 web searches per run; coverage assessment skips already-covered topics.
- Freshness gate: 24h + fingerprint check via `lib/catalyst-signal-store.ts`.
- New research fingerprint key: `catalyst-signal-research:<TICKER>`.

**[8] Integration tests A-F (28 tests)**
- `src/lib/__tests__/catalyst-integration.test.ts`.
- Avoids `catalyst-facts-builder` import (causes pino dynamic require crash in test runner).
- Uses `catalyst-event-gate.ts` (not `catalyst-event-discovery.ts`) for gate function tests.
- 490 total tests pass.

**[9] EventExpectationProfile**
- Still not auto-populated for non-earnings events (requires external data vendor).
- Qualitative gap via CM signals + driver research. Documented in §13 report.

**[10] Final report**
- `artifacts/api-server/CATALYST_PIPELINE_REPORT.md` — 12 questions answered.

## Key architecture decisions

- **Gate separation**: `catalyst-event-gate.ts` has no AI/pino dep (testable). `catalyst-event-discovery.ts` has the AI call.
- **Route no longer has `collectScreenableTickers()`** — only the universe canonical function.
- **`"DuringMarket"`** maps to `"Unknown"` for `CatalystEvent.marketTiming`.
- **`DiscoverySource`**: `cmResult ? "COMPANY_SIGNAL" : universeEntry ? "UNIVERSE_EVENT" : null` in screenTicker.

## Test runner constraint
- `catalyst-facts-builder.ts` → `price-context-service.ts` → `logger.ts` → pino → dynamic `require("node:os")`.
- Never import `catalyst-facts-builder` in test files — esbuild ESM runner cannot bundle pino's dynamic require.
- TYPE correctness (event: null) is verified by `tsc --noEmit`.
