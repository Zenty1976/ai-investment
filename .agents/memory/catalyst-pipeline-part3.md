---
name: Catalyst Autonomous Pipeline (Part 3)
description: Architecture of the autonomous end-to-end catalyst pipeline; key constraints for future work.
---

## What was built
Full autonomous pipeline: universe → screen → priority queue → deep AI analysis → OF promotion → Trade Decision trigger. No manual /analyze/:ticker needed.

## Key files (Part 3 additions)
- `catalyst-config.ts` — DEFAULT_CATALYST_BUDGET, DEFAULT_CATALYST_FRESHNESS, computeRetryBackoff(), isCatalystAnalysisStale(), computePriorityScore()
- `catalyst-lifecycle.ts` — deriveLifecycleState() (PURE FUNCTION), isEligibleForAutoAnalysis(), isInBackoff()
- `market-universe-provider.ts` — MarketUniverseProvider interface, SeedMarketUniverseProvider, SaxoMarketUniverseProvider, CompositeMarketUniverseProvider
- `catalyst-analyze-service.ts` — runCatalystAnalyzeService() — extracted analyze logic (called by route + pipeline)
- `catalyst-pipeline.ts` — runCatalystPipeline(), runPostEventReassessment(), getLastPipelineRun(), markPostEventCandidates()

## CatalystState Part 3 optional fields (all optional ?: )
failureCount, lastError, retryEligibleAt, deferredUntil, deferredReason, postEventAssessmentRequired, intentionalPreEventThesis

## Pipeline trigger
POST /screen fires runCatalystPipeline() non-blocking after sending HTTP response. skipPipeline: true body param suppresses it.

## New endpoints
- GET  /api/catalyst-intelligence/pipeline → last run result
- POST /api/catalyst-intelligence/post-event/:ticker → force post-event reassessment
- GET  /api/catalyst-intelligence/status → lifecycle-aware status board

## Budget limits (DEFAULT_CATALYST_BUDGET)
maxProactiveDiscoveriesPerCycle=5, maxDeepAnalysesPerCycle=3, maxDriverProfilesPerCycle=5, maxDriverResearchPerCycle=5

## Test constraints (unchanged from Part 2)
Never import: catalyst-analyze-service.ts, catalyst-pipeline.ts, catalyst-facts-builder.ts, catalyst-event-discovery.ts — all pull in pino via price-context-service or ai-service.
Safe test imports: catalyst-config, catalyst-lifecycle, market-universe-provider (SeedMarketUniverseProvider only — NOT SaxoMarketUniverseProvider.searchInstrument), catalyst-company-events, catalyst-signal-store, catalyst-event-gate.

## Why: Saxo cannot enumerate exchange equities
SaxoMarketUniverseProvider.getEquities() always returns []. The Saxo ref/v1/instruments API only does per-ticker keyword search. No ExchangeId bulk listing exists.

## How to apply
- When adding future auto-analysis logic: use isEligibleForAutoAnalysis() + computePriorityScore() to gate and sort
- When adding new failure paths: call recordCatalystFailure(ticker, msg, nowIso) so backoff is respected
- When adding new lifecycle states: update deriveLifecycleState() in catalyst-lifecycle.ts (single source of truth)
