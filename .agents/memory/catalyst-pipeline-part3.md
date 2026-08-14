---
name: Catalyst Autonomous Pipeline (Part 3 + Part 4)
description: Part 3 wired Catalyst→OF→TDE downstream; Part 4 added data provider infrastructure.
---

## Part 3 — Autonomous Pipeline
- `catalyst-pipeline.ts` is pino-free with injectable `CatalystAnalyzeStrategy`
- `markPostEventCandidates()` uses `computeEventThresholdMs()`: BeforeMarket→T14:30Z, AfterMarket→T22:00Z, Unknown→nextday T06:00Z
- `runPostEventReassessment()` only clears flag after **successful** reassessment
- Correction: OF has `STATIC_DEPS: ["catalyst-promotions"]`; TDE receives `buildCatalystTdeContext()` for promoted tickers

## Part 4 — Data Provider Infrastructure
New pino-free lib files:
- `data-provider-types.ts` — DataProvenance, capability interfaces
- `market-universe-repository.ts` — persistent universe record store; `seedUniverseIfEmpty()` called at startup
- `expectations-provider.ts` — ExpectationsDataProvider interface + NullExpectationsProvider
- `earnings-calendar-repository.ts` — point-in-time safe calendar store
- `consensus-repository.ts` — snapshot history with `getSnapshotAt(ticker, asOf)` point-in-time query
- `earnings-behavior-calculator.ts` — deterministic price-reaction calculator (pino-free, testable)
- `data-provider-registry.ts` — `buildDataCoverageReport()` for /api/data-coverage endpoint

New types in `catalyst-types.ts`:
- `EarningsBehaviorProfile` — price-reaction profile; `CatalystFacts.behaviorProfile` (null until provider)
- `CatalystFacts.dataQuality.earningsBehaviorAvailable` added

**Why:**
- UNKNOWN ≠ NEUTRAL — NullExpectationsProvider explicitly returns isUnavailable:true
- Point-in-time: `getSnapshotAt(ticker, asOf)` filters by dataAsOf ≤ asOf
- Deduplication: consensus snapshots only stored if ≥0.5% material change

## Test count: 609 passing, 0 failing
