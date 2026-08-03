---
name: TDE policy config architecture
description: How the Trade Decision Engine's configurable policy profiles work, where values live, and how to extend them.
---

## Rule
All evidence weights, staleness tolerances, band thresholds, gate requirements, and readiness thresholds live in `artifacts/api-server/src/lib/trade-decision-policy-config.ts`. The TDE route handler and its helper functions never hardcode these values — they call `getActivePolicyConfig()` (sync, O(1)) at the start of each request and thread the returned `TradePolicyConfig` object through as a parameter.

## Active profile management
- `initPolicyStore()` is called in `artifacts/api-server/src/index.ts` before `app.listen()`.
- The in-memory cache `_activeConfig` is updated synchronously on `setActivePolicyProfile()`.
- The selected profile is persisted to `analysisRepository` under key `"trade-decision-policy-settings"`.
- `getActivePolicySettings()` returns `{ profile, updatedAt }` — used by the settings API.

## Hard safety rules (never profile-overridable)
- `blockedByEvent` decisions → never ReadyForReview.
- Low confidence → never ReadyForReview.
- `criticalOpposingModules` always includes CompanyMonitor and RiskAnalyzer.
- No profile may set `minimumSupportingModules < 1`.

## Three profiles
- **Conservative**: minimumEvidenceScore=35, minimumSupportingModules=3, requireCompanyMonitorForCompanyTrades=true, maximumTargetAllocationPercent=8.
- **Balanced**: minimumEvidenceScore=25, minimumSupportingModules=2 — reproduces original TDE behaviour exactly.
- **Aggressive**: minimumEvidenceScore=15, minimumSupportingModules=2, wider staleness tolerances.

## Evidence weight scaling
Supporting/opposing max weights are profile-driven. Internal scoring ratios stay fixed (e.g. Buy = 0.75×supporting, Invalidated = opposing, Avoid = 0.857×opposing). This preserves relative signal proportions while scaling magnitudes per profile.

**Why:** Centralising thresholds prevents drift between gate checks and readiness checks; scaling by ratios keeps Balanced output identical to pre-config behaviour.

**How to apply:** When adding new evidence modules, define `supporting/opposing/stale/missing` in each profile's `evidenceWeights` section and use those values (with ratio multipliers) inside `classifyDecisionEvidence`.
