---
name: TDE Catalyst Candidate Construction
description: How active Catalyst promotions become explicit TDE decision candidates (not just non-actionable context).
---

## Rule

Active Catalyst HighInterest and CandidateForTradeDecision promotions are lifted into TDE's decision candidate set via `buildCatalystTdeCandidates()` in `src/lib/tde-catalyst-candidates.ts`.

- Only HighInterest / CandidateForTradeDecision qualify — Monitor/Investigate/NotInteresting are excluded.
- Tickers already in OF topOpportunities.slice(0,5) are deduplicated out.
- Capped at `CATALYST_TDE_CANDIDATE_CAP = 5` for cost control.
- Result goes into `decisionProfile.catalystTdeCandidates` (JSON in user prompt).
- TDE system prompt requires every catalystTdeCandidates entry to receive an explicit decision.
- `CatalystIntelligence` added as valid sourceModules value.

**Why:** Before this, Catalyst HighInterest promotions reached OF as context but OF's ~5-candidate limit could silently drop them. TDE then only saw them as "non-actionable context." A HighInterest ticker like KEYS disappeared entirely with no TDE decision.

**How to apply:** When touching Catalyst→TDE flow, the entry point is `buildCatalystTdeCandidates()`. The qualitative context still comes from `buildCatalystTdeContext()` (unchanged). Both feed TDE for the same ticker.

## maxTokens

TDE `maxTokens` was raised from 3500 → **5000** to accommodate the additional decisions required by catalystTdeCandidates. If catalyst candidate count grows further and truncation returns, raise it again.

## Tests

14 deterministic tests in `src/lib/__tests__/tde-catalyst-candidates.test.ts` (K-A through K-M). No OpenAI, no pino.
