---
name: Risk Intelligence Engine
description: Deterministic pre-computation layer for Risk Analyzer (and future Portfolio Analyzer); replaces raw portfolio data in AI prompts with typed RiskFacts.
---

## Architecture

`lib/risk-intelligence-engine.ts` — reads from `analysisRepository` directly, produces `RiskFacts` + deterministic fingerprint. No OpenAI calls.

## What it computes
- **Concentration**: topPositions (up to 5), largestPositionPct, top3Pct, top5Pct, positionsAbove20/30Pct — all as % of invested capital
- **Sectors/Currencies**: exposure % of total portfolio value, sorted descending
- **PriceRisk**: highVolatilityPct/Holdings, strongDowntrendPct/Holdings, strongUptrendPct/Holdings, fallingFastHoldings, risingHoldings, stabilizingFromDowntrendHoldings, missingPriceContext
- **EventRisk**: eventsNext3Days, eventsNext7Days (non-Low only, future only), portfolioPctWithEvent3d/7d
- **CompanyRisk**: invalidatedTheses, weakenedTheses, lowCaseStrength (<40), avoidViewHoldings, viewDistribution
- **portfolioRiskFlags**: plain-language flags for all material conditions

## Fingerprint
`computeRiskFactsFingerprint(facts)` — SHA-256 of banded material fields (16-char hex prefix).
Bands: cashPct to 5%, largestPosBand to 2%, top3 to 5%, sectorPct to 5%.
Changes when: holdings composition changes, volatility regime changes, priceState crosses threshold, thesis invalidated/weakened, event enters 7-day window.

## Skip logic in risk-analyzer.ts
`_riskFactsFingerprint` stored on result object (not in Zod schema — added after parse).
On each run: compare `storedEntry.result._riskFactsFingerprint` to current fingerprint.
Match → `saveSkipped("risk-analyzer")` + `trackSkipped("risk-analyzer", "fingerprint_unchanged")` + return stored result with `_aiCalled: false`.

## RecentBehaviorState values (no "RisingFast")
Valid: "FallingFast" | "Falling" | "DeclineSlowing" | "Stabilizing" | "Recovering" | "Rising"
Engine field is `risingHoldings` (not risingFastHoldings).

**Why:** Portfolio Analyzer task (#61) must read the same engine — do NOT duplicate position weights, sector/currency exposure, or event exposure calculations there. Call `computeRiskFacts()` and reuse `RiskFacts` fields directly. Only add PA-specific calculations (contributors/detractors, performance) in a new `portfolio-intelligence-engine.ts`.
