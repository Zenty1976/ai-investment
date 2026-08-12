# Market Alerts — Deterministic Engine Implementation Report

**Date:** 2026-08-12  
**Status:** Complete — zero OpenAI calls confirmed in production  
**Files changed:** `alert-engine.ts` (new), `market-alerts.ts` (rewritten)

---

## 1. What Market Alerts Previously Asked OpenAI

Market Alerts made **one GPT-4o call per run** with:

- A `SYSTEM_PROMPT` of ~1,500 tokens describing the alert format, categories, severity rules, and output schema.
- A `USER_PROMPT` built by calling `getNewsMonitorAiContext()`, `getEventMonitorAiContext()`, `getPortfolioAiContext()`, `getMarketMonitorAiContext()`, `getSectorMonitorAiContext()`, and `getCompanyMonitorAiContext()` — totalling 2,000–5,000 tokens of structured module output.
- A `response_format: { type: "json_object" }` request to return the full `RunMarketAlertsResponse` shape.
- A retry loop (up to 3 attempts) with web search disabled.

**Why it was called:** The original design delegated all three layers of work to GPT-4o:
1. *Detecting* which module outputs represent material changes.
2. *Classifying* severity and writing alert prose.
3. *Generating* the `executiveSummary`, `headline`, `thingsToWatch`, and `affectedHoldings` fields.

None of these three layers genuinely require AI.

---

## 2. Which Parts Are Now Deterministic

| Layer | Before | After |
|---|---|---|
| Company Monitor material change detection | GPT-4o read `investmentCaseChange.changed` indirectly | Rule: `updateType !== "NoMaterialChange"` AND `investmentCaseChange.changed === true` |
| Thesis severity mapping | GPT-4o inferred from text | Rule: Invalidated → High, Weakened → Medium, Strengthened → positive skip |
| News importance filter | GPT-4o decided | Rule: pass-through from NM's own `importance` field |
| News holding linkage | GPT-4o inferred from summary text | Rule: `matchHoldings()` against `affectedMarkets[]` |
| Event imminence and holding linkage | GPT-4o inferred | Rule: `daysUntil <= 3` for High; <= 14 for Medium; holding match via `affectedMarkets[]` |
| Market Monitor severity | GPT-4o read `riskLevel` | Rule: `riskLevel === "High"` → High alert; `"Moderate"` → Medium alert |
| Sector Monitor severity | GPT-4o read `rating`+`trend` | Rule: Weak+Weakening → High; Weak OR ModWeak+Weakening → Medium |
| Sector holding linkage | GPT-4o inferred from context | Rule: `holdingSector.includes(sectorName)` using CM-resolved sectors |
| CM deduplification (same dev in NM + CM) | GPT-4o sometimes duplicated | Rule: Medium NM items covering CM-tracked tickers are discarded |
| `title`, `summary`, `whyItMatters` | GPT-4o wrote free text | Templates using module field values |
| `executiveSummary` | GPT-4o wrote paragraph | Template: count High/Medium/watch alerts |
| `headline` | GPT-4o generated | Highest-severity `requiresAttention` alert title |
| `affectedHoldings` | GPT-4o inferred from text | Identity-resolved map from CM ticker fields |
| `overallAlertLevel` | GPT-4o set | Max of all `requiresAttention` alert severities |
| `nothingImportantChanged` | GPT-4o set | `!alerts.some(a => a.requiresAttention)` |
| `recommendedAttention` | GPT-4o set | Rule: severity + whether holding is affected |
| `requiresAttention` | GPT-4o set | Rule: High severity always; Medium only if holding is affected |

---

## 3. Fields That Genuinely Require AI

None in the current implementation. The current fields are all derivable from structured module output via rules.

**Future consideration:** If a user requests free-form narrative summaries beyond the template prose (e.g. "explain why this matters for my specific portfolio in two sentences"), a targeted AI call could be added as an *optional escalation path* for the narrative fields only — not for detection or classification. Any such call should:
- Use `callAiWithWebSearch` with `webSearch: false`
- Be gated on a feature flag
- Pass only the specific alert being narrated (~200 tokens), not the full module context

---

## 4. Confirmation of Zero AI Calls

### Controlled test (live verification — 2026-08-12)

```
POST /api/market-alerts/analyze
→ _debug.engine.aiCalls: 0
→ _debug.aiCalls: 0
→ candidateCount: 9 (from CM, NM, EM, SM)
→ finalAlertCount: 9
```

OpenAI usage log checked before and after: **no new `market-alerts` module records**.

### Unit test suite

All **134 tests pass** (0 failures), including 6 spec §15 cases:

- **A** No material changes → `nothingImportantChanged: true`, 0 requiresAttention alerts, `aiCalls: 0`
- **B** Thesis Invalidated → HIGH Company alert, `requiresAttention: true`, `recommendedAttention: "Prepare"`, `aiCalls: 0`
- **C** Medium NM item for CM-covered ticker → discarded; CM alert kept; `aiCalls: 0`
- **D** Imminent High event → Event alert, `requiresAttention: true` for ≤3 days; High events >14 days skipped; `aiCalls: 0`
- **E** PriceState source deferred — engine handles missing data without crashing; `aiCalls: 0`
- **F** Restored position → no alert when CM shows NoMaterialChange; `aiCalls: 0`

Test runner: `node:test` + esbuild (`run-tests.mjs`). No vitest.

---

## 5. Bugs Found and Fixed During Implementation

### Bug A — Sector matching false positives (backward substring direction)

**Root cause:** The original sector matching used `sectorLower.includes(tickerSector)`, which caused `"biotechnology".includes("technology")` = `true`. A Technology-sector holding (e.g. SERV:XNAS) matched the Biotechnology sector alert.

A second bug: when `holdingSectors` had no entry for a holding (empty string), `sectorLower.includes("")` was always `true`, causing every holding to match every sector.

**Fix:** Changed to `tickerSector.includes(sectorLower)` only (holding's sector contains SM sector name). Added `if (!tickerSector) return false;` guard. Added pre-population of `holdingSectors` from all CM entries before extracting CM candidates.

### Bug B — Stale NoChange path serving pre-fix alerts

**Root cause:** The route's NoChange path served the last stored `market-alerts` result. After the sector-matching fix, the engine produced different `affectedHoldings` for sector alerts, but the status comparison (title/category only) saw all alerts as "Unchanged" → NoChange path → stale result.

**Fix:** Added a secondary comparison against `storedAlertsList` in the status assignment step. If any "Unchanged" alert has different `affectedHoldings` from what is stored, it is upgraded to "Updated". Added `affectedHoldings` to `AlertHistoryAlert` for future runs.

---

## 6. Cost Impact

| Run | Market Alerts OpenAI calls | Est. cost |
|---|---|---|
| Before (per orchestrator cycle) | 1–3 (with retries) | ~$0.04–0.12 |
| After | 0 | $0.00 |
| Per session saving | — | −100% for MA |

MA was the 6th-highest cost module per session (~$0.05/session). Combined with the `web_search_preview` fix and TDE stale-loop fix from the cost audit, total projected session cost drops from $2.74 → ~$0.28 (−90%).

---

## 7. Architecture Notes

- `alert-engine.ts` exports `runAlertEngine(inputs: AlertEngineInputs): AlertEngineResult`
- Engine is pure (no side effects, no imports of analysis-repository or companyIdentityStore)
- Identity resolution (`companyIdentityStore.resolve()`) is done by the route before calling the engine
- `IAlertRepository` interface allows injection of mocks in tests
- `_engineDebug` always present with `aiCalls: 0`, `resolvedSectors`, candidates list with discard reasons
- PriceState integration (spec §3) is **not yet implemented** — price context changes will not generate sector alerts in the current version

---

## 8. Outstanding: Price Context Alerts (Deferred)

Spec §3 mentions "Price Context material state changes" as a source. Not implemented in this version. The `analysis-repository` stores `priceState` per-ticker under keys matching `price-context:*`. Future implementation:

1. Add `extractPriceContextAlerts(holdingSymbols, repo)` to `alert-engine.ts`
2. Read `price-context:{ticker}` entries from repo
3. Apply severity rules from spec (e.g. priceState ≠ last stored priceState → Medium alert)
4. Add test case E (currently tests graceful no-crash behaviour)
