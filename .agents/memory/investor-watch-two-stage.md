---
name: Investor Watch Two-Stage Execution
description: Lightweight discovery stage added before expensive full analysis
---

## Rule
Investor Watch uses a two-stage flow for orchestrator-triggered runs when a previous analysis exists and it's been ≥6 hours since last check:

1. **Stage 1 (discovery):** cheap `gpt-4o-mini` call (≤150 tokens) asks "any new primary sources since [lastCheckedAt]?" → returns `{hasNewDevelopments: boolean}`.
2. **Stage 2 (full analysis):** expensive `gpt-4o` call (2200 tokens) — only if Stage 1 returns `true`.

If Stage 1 returns `false` → store `NoMaterialChange` with updated `lastCheckedAt`, call `trackSkipped("investor-watch")`, return immediately.

**Why:** Multiple investors × expensive full analysis = high cost on every scheduled run even when nothing changed.

## How to apply
- Manual/user-triggered runs always skip Stage 1 and go straight to full analysis.
- If the discovery call itself fails, `hasNewDevelopments` defaults to `true` (fail-safe: always run full analysis rather than silently skip).
- The threshold constant is `DISCOVERY_MIN_AGE_HOURS = 6` in `investor-watch.ts`.
