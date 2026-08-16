---
name: Catalyst Pipeline Activation Fixes
description: Root causes that prevented the Catalyst pipeline from producing deep analyses; fixes applied across two sessions.
---

## Session 1 Root Causes

### Root Cause 1 (Primary): jsonMode + webSearch incompatible
`catalyst-analysis.ts` Phase 2 AI call passed both `jsonMode: true` AND `webSearchContextSize: "medium"`.
OpenAI Responses API rejects `text.format.json_object` when a `web_search` tool is active → call throws,
catch block returns null, analysis stays null forever. Removing just `webSearchContextSize` from the call
site DID NOTHING — `callAiWithWebSearch` defaults to `"medium"` internally and always injects web_search tools.

**Real fix (Session 2):** Phase 2 must call `callAi` (Chat Completions API), NOT `callAiWithWebSearch`.
`callAi` always uses `response_format: { type: "json_object" }` and never injects web_search tools.
Web research is provided via the driver profile summary injected into `buildCompactFacts()`.

**Why:** `callAiWithWebSearch` unconditionally adds `tools: [{ type: "web_search_preview" }]` +
`tool_choice: "required"` regardless of whether `webSearchContextSize` is explicitly passed.
The only safe way to get structured JSON output is `callAi`.

### Root Cause 1b: Driver profile same bug
`catalyst-driver-profile.ts` called `callAiWithWebSearch` with `jsonMode: true` — same incompatibility.
Driver profile DOES need web search, so fix is different: remove `jsonMode: true` (not remove web search).
The system prompt demands strict JSON, so the model returns it without the format enforcement flag.

### Root Cause 2 (Secondary): shouldAnalyze excluded SignalAssessment + stale BasicMonitor
`catalyst-analyze-service.ts` `shouldAnalyze` gate only checked `screeningLevel === "DeepAnalysis"`.
Fix: also passes when `screeningLevel === "SignalAssessment"` OR `eligible === true && daysUntilEvent ≤ 14`.

### Root Cause 3 (Orchestrator): catalyst-intelligence not in _runFullCycle
`automation-orchestrator.ts` `_runFullCycle` did not include `catalyst-intelligence` as a stage.
Fix: Added as Stage 3.5 (after market/news/event monitors, before Company Monitor).

## Session 2 Fixes

### Failure tracking was broken
`runCatalystAnalysis` catch block called `console.error` then returned `null` — did not throw.
`runCatalystAnalyzeService` treated null return as a skipped analysis (not a failure).
Result: `failureCount` stayed 0, `lastError` stayed null, no backoff → same broken candidate retried every cycle.

**Fix:** `runCatalystAnalysis` catch block now throws instead of returning null.
`runCatalystAnalyzeService` Step 9 is wrapped in try-catch that:
  - increments `failureCount`
  - sets `lastError` (capped at 500 chars)
  - computes `retryEligibleAt` via `computeRetryBackoff()`
  - saves the failed state (preserving updated facts)
  - returns an error result (so the pipeline counts the attempt)

### Schema validation failure also fixed
`AnalysisResponseSchema.safeParse` failure now throws (not returns null) so it also triggers failure tracking.

## API + UI
- `GET /api/catalyst-intelligence/pipeline` — per-candidate debug summary
- `upcomingOpportunities` field in Command Brief response (frontend not rendering it yet)
- `buildUpcomingOpportunities()` exported from `command-brief.ts`

## Staleness Thresholds (isCatalystAnalysisStale)
- daysUntilEvent ≤ 3: stale after 4h
- daysUntilEvent 3-7: stale after deepAnalysisMs (12h default)
- daysUntilEvent > 7 or PATH B: stale after 24h

## Test count: 658 passing, 0 failures (13 Test I tests added for failure tracking)
