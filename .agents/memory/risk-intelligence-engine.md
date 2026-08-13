---
name: Risk Intelligence Engine
description: Deterministic pre-computation layer for Risk Analyzer (and Portfolio Analyzer); replaces raw portfolio data in AI prompts with typed RiskFacts so OpenAI only does qualitative interpretation.
---

## Architecture

Two-file split keeps the pure logic testable without the heavy dependency chain:
- `lib/risk-facts.ts` — types + `computeRiskFactsFingerprint()`. Only imports `node:crypto`. Import this for tests or type-only consumers.
- `lib/risk-intelligence-engine.ts` — `computeRiskFacts(nowIso)`. Reads from `analysisRepository`, `companyIdentityStore`, `getPriceContext`. Re-exports everything from `risk-facts.ts`.

## What the engine computes
- **Concentration**: topPositions (up to 5), largestPositionPct, top3Pct, top5Pct, positionsAbove20/30Pct — all as % of invested capital
- **Sectors/Currencies**: exposure % of total portfolio value, sorted descending
- **PriceRisk**: highVolatilityPct/Holdings, strongDowntrendPct/Holdings, strongUptrendPct/Holdings, fallingFastHoldings, risingHoldings ("Rising" state only — no "RisingFast" in RecentBehaviorState), stabilizingFromDowntrendHoldings, missingPriceContext; **perPositionState** (full categorical state per holding for fingerprinting)
- **EventRisk**: eventsNext3Days/7d (non-Low only, future only), portfolioPctWithEvent3d/7d
- **CompanyRisk**: invalidatedTheses, weakenedTheses, lowCaseStrength (<40), avoidViewHoldings, viewDistribution
- **portfolioRiskFlags**: plain-language flags for all material conditions

## Fingerprint
`computeRiskFactsFingerprint(facts)` — SHA-256 of banded material fields (16-char hex prefix).
**Key design**: `perPositionState` maps every held ticker to `{priceState|volatilityState|recentBehaviorState}` as a pipe-delimited string. Categorical — no banding needed. This catches any regime shift (Flat→Uptrend, Low→Elevated volatility, any behavior change) not just extreme subsets.
Banded fields: cashPct to 5%, largestPositionPct to 2%, top3Pct to 5%, sectorPct to 5%.
Band function: `Math.round(n/size)*size`. Note: 56 and 57 are in DIFFERENT 2-bands (56→56, 57→58); 55 and 56 share the same band (both→56).

## Skip logic in risk-analyzer.ts
`_riskFactsFingerprint` stored on result object (added after Zod parse, not in schema).
On each run: compare stored to current; match → `saveSkipped()` + `trackSkipped("risk-analyzer", "fingerprint_unchanged")` + return stored with `_aiCalled: false`.

## Portfolio Analyzer reuse rule
**Why:** Portfolio Analyzer must call `computeRiskFacts()` and reuse `RiskFacts` fields directly. Do NOT duplicate position weights, sector/currency exposure, or event exposure. Only add PA-specific calculations (contributors/detractors, performance) in a new `portfolio-intelligence-engine.ts`. Import from `risk-facts.ts` for types.
