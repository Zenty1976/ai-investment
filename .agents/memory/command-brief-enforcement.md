---
name: Command Brief Catalyst Enforcement
description: Deterministic post-AI enforcement guaranteeing HighInterest catalyst candidates appear in Command Brief with correct Trade Decision wording.
---

## Rule

After `RunCommandBriefResponse.safeParse()` succeeds, `enforceRequiredCatalystItems()` in `src/lib/command-brief-catalyst-enforcement.ts` is called before save/response. It is a pure function — zero AI calls, zero external deps.

**What it does:**
1. Finds the top qualifying candidate: `upcomingOpportunities` with `interestLevel === "HIGH_INTEREST"` that has a matching TDE decision, sorted by `daysUntilEvent` ascending.
2. Checks if ticker is already in items (by `symbol` field OR text starting with `"TICKER:"`), case-insensitive, exchange-suffix-tolerant (`KEYS` matches `KEYS:XNAS`).
3. If absent → inserts item; if at cap (6) → evicts lowest-priority item by score (action=100, symbol=10, critical=8, warning=6, watch=4, neutral=2, positive=1).
4. If present but wrong wording (e.g. no "wait" for WaitForEvent) → corrects text in-place.
5. If correct → no change.

**actionStatus, overallStatus, headline are never modified.** Trade Review authority preserved by design.

**Why:** Prompt rules alone were insufficient — the model consistently dropped or mis-worded catalyst candidates. Deterministic enforcement is the only reliable guarantee.

**How to apply:** If adding new catalyst opportunity states or TDE decision types in the future:
- Update `communicatesDecisionState()` with the new decision keyword.
- Update `buildRequiredItemText()` with appropriate wording.
- `TDE_QUALIFYING_STATES` in `tde-catalyst-candidates.ts` controls which states feed into TDE candidates (and thus into enforcement).

## TDE maxTokens

TDE `maxTokens` was raised 3500 → **5000** when catalyst candidates caused token truncation. If further growth causes truncation again, raise further.

## Tests

22 deterministic tests CB-A through CB-V in `src/lib/__tests__/command-brief-catalyst-enforcement.test.ts`.
