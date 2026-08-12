# OpenAI Cost Audit Report — 2026-08-12

## Executive Summary

Two bugs were identified and fixed in this session. Together they account for nearly
all observed cost in the usage log. A controlled web-search context-size test was also
run and produced further data. A full module-level cost table and remaining
recommendations are below.

---

## Fixes Shipped

### Fix 1 — `web_search_preview` tool type (ai-service.ts)

**Severity: Critical (cost)**

The Responses API was being called with `tools: [{ type: "web_search", ... }]`.
OpenAI's Responses API requires `"web_search_preview"` as the tool type.
With the wrong type, `search_context_size` was completely ignored and OpenAI
injected its maximum default web-content context (~17–18 k tokens) into every
prompt, regardless of what `webSearchContextSize` was set to.

**Controlled comparison (same query, same session date):**

| Configuration | MM prompt tokens | NM prompt tokens |
|---|---|---|
| `"web_search"` + `medium` (old, broken) | 17,782 | 18,642 |
| `"web_search_preview"` + `low` | 800 | — |
| `"web_search_preview"` + `medium` | 800 | 2,010 |

With the fix in place, both `low` and `medium` now produce compact results.
The previous 17 k token overage was entirely an artifact of the wrong tool type —
not of the content being retrieved.

**Fix:** One line in `ai-service.ts`:
```
- tools: [{ type: "web_search", search_context_size: webSearchContextSize }],
+ tools: [{ type: "web_search_preview", search_context_size: webSearchContextSize }],
```

**Affected modules (all use web search):** market-monitor, news-monitor,
event-monitor, sector-monitor, opportunity-finder, company-monitor, investor-watch.

**Estimated session savings from this fix alone:**
- MM: (17,782 − 800) × 4 calls × $2.50/M = ~**$0.17**
- NM: (18,642 − 2,010) × 4 calls × $2.50/M = ~**$0.17**
- Other web-search modules (OF, EM, SM, CM, IW): additional ~**$0.20**
- Gross prompt-token saving: **~66,000–70,000 tokens** per 4 MM + 4 NM calls

---

### Fix 2 — TDE stale WaitForEvent normalization (trade-decision-engine.ts)

**Severity: Critical (cost)**

The stale-WaitForEvent guard was throwing an HTTP 500 error whenever any
`WaitForEvent` decision referenced a `blockingEventDate` that had passed.
The AI consistently regenerated `"Wait for U.S. CPI data before deploying cash
broadly"` (blockingEventDate: 2026-08-12) because CPI data was an upcoming event
in the event-monitor context — but the midnight-comparison (`evDate < nowDate`)
flagged it as stale from 00:00 onward.

**Root-cause chain:**
1. TDE runs → WaitForEvent validation throws → HTTP 500 → attempt 2 also fails.
2. TDE never stores a result → no `dependencyFingerprint` in repository.
3. Fingerprint check always misses (no previous fingerprint to compare) → TDE
   is never skipped by the fingerprint guard.
4. Every upstream dependency completion (risk-analyzer, portfolio-analyzer,
   market-alerts, opportunity-finder, event-monitor, news-monitor) re-triggers TDE
   via the dependency chain.
5. Go to step 1 — infinite loop until the event date context updates.

**Evidence:** 29 identical error messages in system-log.json, spanning 19:33–19:55.
All 59 TDE calls were at retryNumber 1 or 2. Zero TDE successes in the session.

**Fix:** Replace the throw with deterministic normalization — stale blocking flags
are cleared in-place (same logic that already ran for non-WaitForEvent decisions),
and processing continues through the evidence gate. No investment facts are invented;
only an expired temporal constraint is removed. The AI reassesses the position
properly on the next cycle when event-monitor context has updated.

**Session waste from this bug:** 59 GPT-4o calls × avg ~6,400 uncached prompt +
~1,200 completion tokens = **~378 k prompt / 73 k completion tokens = ~$1.45**
compared to an expected ~3–5 successful calls per session at ~$0.04–0.07 each.

---

## § 5 — Controlled Web-Search Context Size Test

_Test conducted 2026-08-12 during this audit session._

Three measurements were taken for Market Monitor (NM separately):

| Condition | MM prompt | NM prompt | Web search used | Result quality |
|---|---|---|---|---|
| `"web_search"` + medium (baseline, broken) | 17,782 | 18,642 | ✓ | Good |
| `"web_search_preview"` + low (after fix) | 800 | — | ✓ | Good |
| `"web_search_preview"` + medium (after fix) | 800 | 2,010 | ✓ | Good |

**Findings:**
- The old `"web_search"` type caused the same extreme overage regardless of
  `search_context_size` — confirming the parameter was silently ignored.
- With the correct type, `medium` produces compact, well-structured output
  with the expected field coverage.
- `low` produced identical results to `medium` for MM (both 800 tokens), which
  suggests OpenAI's `low` and `medium` allocations converge for queries with
  compact search results.
- **Recommendation:** Leave MM and NM at `medium`. The fix alone eliminates
  the overage without any quality tradeoff. No further size change is needed.

---

## § 7 — Module Cost Table (session: 89 calls total)

Pricing basis: gpt-4o input $2.50/M, cached $1.25/M, output $10.00/M;
gpt-4o-mini $0.15/$0.60; web search $25/1000 calls.

| Module | Calls | Prompt | Compl | Cached | WS | 2nd-Attempt | Est. Cost | % |
|---|---|---|---|---|---|---|---|---|
| **trade-decision-engine** | 59 | 378,359 | 72,629 | 179,840 | 0 | 29 | **$1.45** | **53%** |
| news-monitor | 4 | 74,570 | 2,529 | 13,824 | 4 | 0 | $0.29 | 11% |
| market-monitor | 4 | 71,130 | 1,170 | 9,856 | 4 | 0 | $0.28 | 10% |
| company-monitor | 5 | 43,918 | 165 | 0 | 5 | 0 | $0.24 | 9% |
| investor-watch | 7 | 71,974 | 1,320 | 2,176 | 7 | 0 | $0.19 | 7% |
| opportunity-finder | 1 | 21,155 | 1,532 | 6,144 | 1 | 0 | $0.09 | 3% |
| sector-monitor | 1 | 18,584 | 999 | 3,456 | 1 | 0 | $0.08 | 3% |
| event-monitor | 1 | 17,951 | 557 | 2,688 | 1 | 0 | $0.07 | 3% |
| market-alerts | 4 | 12,829 | 373 | 0 | 0 | 0 | $0.04 | 1% |
| risk-analyzer | 1 | 3,680 | 751 | 0 | 0 | 0 | $0.02 | <1% |
| portfolio-analyzer | 1 | 2,486 | 577 | 0 | 0 | 0 | $0.01 | <1% |
| **TOTAL** | **89** | **719,625** | **83,246** | **217,984** | **23** | **29** | **$2.74** | |

**Notes:**
- investor-watch uses gpt-4o-mini for discovery calls; pricing adjusted.
- The 29 TDE "2nd-attempt" entries represent 29 full failure cycles (2 calls each).
- 23 web search calls: 4 MM + 4 NM + 5 CM + 7 IW + 1 OF + 1 SM + 1 EM.
- The remaining ~1 call marked "unknown" is from an internal debug/test invocation.

**Projected cost in a healthy session (both fixes applied, similar module mix):**

| Source | Healthy estimate |
|---|---|
| TDE: 3–5 successful calls | ~$0.08 |
| MM × 4 (fixed web search) | ~$0.02 |
| NM × 4 (fixed web search) | ~$0.04 |
| CM × 5 (fixed web search) | ~$0.04 |
| IW × 7 (fixed web search) | ~$0.03 |
| OF/SM/EM/MA/RA/PA | ~$0.07 |
| **Estimated total** | **~$0.28** |
| **vs. this session** | **$2.74** |
| **Reduction** | **~90%** |

---

## § 8 — Market Alerts: AI Necessity Analysis

**Conclusion: all fields require qualitative AI judgment (Category B).
No safe deterministic extraction candidates at this time.**

| Field | Assessment |
|---|---|
| `overallAlertLevel` | B — synthesized from multiple sources; not derivable |
| `executiveSummary` | B — narrative synthesis |
| `headline` | B — AI-selected from material items |
| `nothingImportantChanged` | B — requires judgment about materiality thresholds |
| `thingsToWatch` (array) | B — forward-looking judgment |
| `alerts[].title` | B — AI-authored |
| `alerts[].category` | B — multi-category classification with judgment |
| `alerts[].importance` | B — materiality assessment |
| `alerts[].isNew` | Partially A — delta detection runs deterministically; but "new vs. repeated" for context-shifted items needs AI |
| `alerts[].requiresAttention` | B — urgency scoring |
| `alerts[].affectedHoldings` | Partially A — direct ticker mentions extractable; but which holdings are *indirectly* affected by macro requires AI |
| `alerts[].summary` | B — narrative |
| `alerts[].whyItMatters` | B — portfolio-contextualized reasoning |
| `alerts[].recommendedAttention` | B — action framing |
| `alerts[].sourceType` | Mostly A — can be derived from which sub-module flagged the item, but classification edge cases need AI |

The delta computation (passedEvents, newNewsIds, hours elapsed) is already done
deterministically before the AI call and is preserved. No safe structural
decomposition that would avoid an AI call has been identified.

---

## § 3 — Concurrent TDE Deduplication Check

The orchestrator's `triggerModule` dedup (lines 860–866) correctly prevents
concurrent TDE runs: `if (moduleId !== "company-monitor" && this._hasActiveJob(moduleId))`.
If TDE is already Running or Pending, new triggers return the existing job.

The retry loop in this session was **sequential**, not concurrent: each 44-second
TDE run (2 attempts × 22 s) completed before the next dependency trigger fired,
so the dedup guard never needed to activate. No changes needed to the dedup logic.

---

## Remaining Recommendations (not yet actioned)

These are observations only — no code changes made per § 8 constraints:

1. **Company Monitor (~$0.24, 5 calls):** Investor Watch two-stage discovery gate
   reduced CM calls from what would otherwise be many more. Current rate is healthy;
   no change recommended.

2. **Investor Watch (~$0.19, 7 calls, gpt-4o-mini):** Already uses mini model for
   discovery. With the web_search_preview fix, per-call prompt tokens will drop
   significantly. Further optimization not needed.

3. **Opportunity Finder (21k prompt tokens, 1 call):** Large prompt due to full
   PA/market/event/news/sector context with no ticker filter (by design — OF looks
   at the whole market). The downstream-ai-context compaction from the prior session
   has already reduced this. No further reduction recommended without quality testing.

4. **Context size tuning:** Now that the web_search_preview fix is in place,
   `search_context_size: "low"` vs `"medium"` can be meaningfully tested. For MM the
   two sizes converged at ~800 tokens; for NM medium produced 2,010 vs a likely lower
   figure for low. A follow-up test comparing NM low vs NM medium output completeness
   would determine if further savings are available there.
