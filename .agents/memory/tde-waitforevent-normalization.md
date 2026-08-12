---
name: TDE stale WaitForEvent loop
description: Throwing on stale WaitForEvent decisions causes TDE to never store a result, breaking the fingerprint skip and creating an infinite retry loop.
---

## Rule
Never throw for a stale `WaitForEvent` decision (one whose `blockingEventDate` has passed). Normalize it in-place by clearing `blockedByEvent: false` and let the evidence gate re-evaluate.

**Why:** Throwing prevents TDE from storing a result. Without a stored result there is no `dependencyFingerprint`, so the fingerprint skip check always misses. Every completion of any of TDE's upstream dependencies (risk-analyzer, portfolio-analyzer, market-alerts, opportunity-finder, event-monitor, news-monitor) re-triggers TDE via the dependency chain. Each re-trigger costs 2 full GPT-4o calls (MAX_ATTEMPTS=2). The loop runs until the event-monitor context updates to reflect the event has occurred.

**Evidence (2026-08-12):** 29 identical "WaitForEvent past blocking events" errors over 22 minutes. 59 wasted TDE calls, 0 successes, ~$1.45 wasted in one session. CPI data release day triggered this (blockingEventDate = today, `evDate < nowDate` from 00:00).

**How to apply:** The fix is in `trade-decision-engine.ts`. After schema validation and executable-language guard, map over `parsed.data.decisions` — for any `WaitForEvent` with a past `blockingEventDate`, set `blockedByEvent: false, blockingEvent: "", blockingEventDate: ""` and log the normalization. Pass the mapped array to `applyEvidenceGate`. Never add a new throw for this condition.
