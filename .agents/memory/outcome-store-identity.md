---
name: Outcome store identity model
description: How DecisionOutcome records are identified and looked up; what changed from the original decisionId model and why.
---

## Rule
`DecisionOutcome.subjectDecisionId` is the stable identity for a subject across all decision-type changes:
- Format: `"${subjectType}:${ticker}"` — e.g. `"Holding:AAPL"`, `"Opportunity:CAT"`
- Changing from PrepareToBuy → PrepareToReduce under the same subject closes the old version as Expired and opens a new version under the same `subjectDecisionId`
- `id` is the immutable per-version record key: `"${subjectDecisionId}:v${decisionVersion}"` — e.g. `"Holding:AAPL:v2"`

## outcomeId on TradeProposal
Every `TradeProposal` stores `outcomeId: string | null` — the exact `DecisionOutcome.id` linked at proposal-generation time. The Trade Review PATCH handler uses this exact ID so the correct version is updated (not an older or newer one). Never reconstruct the ID from ticker + decision type alone.

## Deferral ("Later")
- PATCH `status = "Later"` is a valid action in the Trade Review route. It does **not** change the proposal status (stays "Ready").
- Outcome store records it as `newStatus: "Deferred"`, incrementing `deferredCount` and setting `deferredAt` / `lastDeferredAt`.
- `outcomeStatus` stays `"Tracking"` — Deferred is not a terminal status.

## Approved quantity
`approvedQuantity` is set when the user approves with a quantity in Trade Review. It is distinct from `executedQuantity` (populated later if/when a Saxo order is placed). Both may differ from the TDE-suggested `targetAllocationPercent`-derived quantity.

## resolveStatus
`resolveStatus(existing)` takes no `isReadyForReview` param. It preserves terminal statuses (Rejected, Expired, Executed, Closed) and AwaitingExecution; returns `"Tracking"` for everything else. `becameReadyAt` communicates readiness — no separate status needed.

## Backward compat
Old stored records with `decisionId` (not `subjectDecisionId`) are migrated by `normalizeRecord()` in `loadActive()`. They get `subjectDecisionId = decisionId` (old format: `"AAPL:PrepareToBuy"`), so no new lookups will find them — they are phantom records that age out naturally.

**Why:** Using `"Holding:AAPL"` as stable identity avoids creating completely separate outcome histories when the TDE decision type changes from PrepareToBuy to Review to PrepareToReduce.

**How to apply:** When calling `recordDecisionOutcome` from the TDE, always construct `subjectDecisionId = "${subjectType}:${ticker}"`. When calling `updateDecisionOutcomeFromReview` from Trade Review, always use `proposal.outcomeId` — never reconstruct the ID.
