---
name: Catalyst Pipeline Activation Fixes
description: Three root causes that prevented the Catalyst pipeline from ever producing deep analyses; how they were fixed.
---

## The Three Root Causes

### Root Cause 1 (Primary): jsonMode + webSearch incompatible
`catalyst-analysis.ts` Phase 2 AI call passed both `jsonMode: true` AND `webSearchContextSize: "medium"`.
OpenAI Responses API silently rejects `text.format.json_object` when a `web_search` tool is active → the call
throws, the catch block returns `null`, analysis stays `null` forever.

**Fix:** Remove `webSearchContextSize` from the Phase 2 `callAiWithWebSearch` call. Phase 2 uses JSON mode for
reliable structured output; web search is handled in Phase 1 (the thesis research call).

**Why:** This is the same constraint documented in `openai-websearch-jsonmode.md`. Never mix the two.

### Root Cause 2 (Secondary): shouldAnalyze excluded SignalAssessment + stale BasicMonitor
`catalyst-analyze-service.ts` `shouldAnalyze` gate only checked `screeningLevel === "DeepAnalysis"`.
Candidates screened as `SignalAssessment` (close event, not quite deep) and candidates with stale `BasicMonitor`
screening whose event had since moved within 14 days were never analyzed.

**Fix:** `shouldAnalyze` now also passes when:
- `screeningLevel === "SignalAssessment"` (path A close-event candidates), OR
- `screening.eligible === true` AND current `facts.event.daysUntilEvent ≤ 14` (stale screening guard).

### Root Cause 3 (Orchestrator): catalyst-intelligence not in _runFullCycle
`automation-orchestrator.ts` `_runFullCycle` did not include `catalyst-intelligence` as a stage.
The pipeline only ran via the `/screen` endpoint's background kick — never during "Run All".

**Fix:** Added `catalyst-intelligence` as Stage 3.5 (after market/news/event monitors, before Company Monitor)
using the same `runIsolated` + `completeStage` pattern as other stages.

## New Endpoints
- `GET /api/catalyst-intelligence/pipeline` — per-candidate debug summary; screened/eligible/analyzed/deferred
  /failed/promoted counts plus last pipeline run detail. Use this to verify pipeline is running correctly.

## New Command Brief Field
`upcomingOpportunities` — deterministic section (zero AI calls) in both the response JSON and AI input.
Selection: `analysis !== null` + future event (`daysUntilEvent > 0`) + positive state (HighInterest/Investigate).
Max 3; sorted by tier (HighInterest first) → promoted → daysUntilEvent ascending.
Builder: `buildUpcomingOpportunities()` exported from `command-brief.ts`.

## Staleness Thresholds (isCatalystAnalysisStale)
- daysUntilEvent ≤ 3: stale after 4h
- daysUntilEvent 3-7: stale after deepAnalysisMs (12h default)  
- daysUntilEvent > 7 or PATH B: stale after 24h

## Test count: 644/645 passing (1 pre-existing failure unrelated to catalyst)
