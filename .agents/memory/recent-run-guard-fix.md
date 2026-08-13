---
name: Recent-Run Guard Fix
description: Why markAIAnalysis() must be called independently of setFingerprint(), and how _debug.aiCalled signals genuine AI invocation.
---

## The rule

The orchestrator must call `analysisRepository.markAIAnalysis(key, aiCallAt)` after every successful HTTP module call where the route actually invoked AI. This is **separate from** and **in addition to** `setFingerprint()`.

**Why:** `OBSERVATION_MODULE_MIN_REFRESH_MINUTES` guards (market-monitor, news-monitor, opportunity-finder, event-monitor, sector-monitor) check `entry.lastAIAnalysisAt`. `setFingerprint()` is the only prior writer of `lastAIAnalysisAt`, but it is only called when `computeFingerprint()` returns non-null — which only happens for modules that have `STATIC_DEPS` config. The five observation modules have no `STATIC_DEPS`, so `computeFingerprint()` returns null, `setFingerprint()` is never called, and `lastAIAnalysisAt` is never set. Result: every Run All clicks through to OpenAI regardless of how recent the previous run was.

**How to apply:**
- In `automation-orchestrator._executeJob()`, after a successful `fetch()`, parse the response body JSON to read `_debug.aiCalled` (default `true` if absent or non-boolean).
- If `aiActuallyCalled === true`: call `analysisRepository.markAIAnalysis(fpKey, aiCallAt)`.
- Then (independently): if `pendingFingerprint` is non-null, call `setFingerprint()` as before.
- Routes with MAINTENANCE paths (sector-monitor, event-monitor) expose `_debug.aiCalled: false` when no AI was made — the orchestrator reads this to skip `markAIAnalysis`.
- Routes that always call AI (market-monitor, news-monitor, opportunity-finder) expose `_debug.aiCalled: true` explicitly.

## The new `markAIAnalysis` method

```typescript
analysisRepository.markAIAnalysis(moduleName: string, lastAIAnalysisAt: string): void
```

- Sets `lastAIAnalysisAt` only. Does NOT touch `dependencyFingerprint`, `result`, or `materialVersion`.
- Is a no-op for non-existent entries (safe to call unconditionally).
- Must NOT be called from SKIPPED paths (SKIPPED_RECENT, SKIPPED_UNCHANGED, MAINTENANCE) — preserving the previous timestamp is the correct behaviour for skips.

## Modules and their skip strategy

| Module | Skip strategy |
|---|---|
| market-monitor | OBSERVATION_MODULE_MIN_REFRESH_MINUTES (15 min) — needs markAIAnalysis |
| news-monitor | OBSERVATION_MODULE_MIN_REFRESH_MINUTES (15 min) — needs markAIAnalysis |
| event-monitor | OBSERVATION_MODULE_MIN_REFRESH_MINUTES (60 min) — needs markAIAnalysis on DISCOVERY path |
| sector-monitor | OBSERVATION_MODULE_MIN_REFRESH_MINUTES (180 min) — needs markAIAnalysis on DISCOVERY path |
| opportunity-finder | OBSERVATION_MODULE_MIN_REFRESH_MINUTES (180 min) — needs markAIAnalysis |
| company-monitor | Fingerprint-based skip (AI_MODULE_MAX_AGE_MINUTES 240 min) — setFingerprint is called, markAIAnalysis is also called but redundant |

## Test coverage

`src/lib/__tests__/recent-run-guard.test.ts` — 11 deterministic scenarios, no OpenAI calls.
