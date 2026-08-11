---
name: Dirty Propagation Architecture
description: How material changes in upstream modules immediately trigger relevant downstream modules
---

## Rule
`_triggerDownstream` in automation-orchestrator.ts handles two kinds of propagation:

1. **Standard dependency graph** — modules that list the completed module in their `dependencies` array are triggered if stale/due and meaningfulChange is Medium/High.

2. **Company-monitor → investment pipeline (special case)** — company-monitor is NOT listed as a formal dep of portfolio-analyzer, risk-analyzer, or trade-decision-engine (they depend on aggregated outputs, not per-ticker results). But when a PORTFOLIO HOLDING ticker changes materially, those modules are immediately triggered if stale/due and their declared deps are all fresh.

**Why:** The formal dependency graph would require adding company-monitor to all three modules' deps arrays, which would also block them from running until ALL company-monitor tickers are fresh. That's too strict. Instead, the special case only fires for portfolio holdings and respects all existing gates.

## How to apply
- `_triggerDownstream` signature: `(completedModuleId, correlationId, parentJobId, meaningfulChange, forceAI, completedTicker?)`
- Pass `job.ticker` as `completedTicker` when calling from `_executeJob`.
- Ticker normalization strips exchange suffix (`:XNAS`, `:XCSE`) before comparing to portfolio tickers.
- Ordered triggering: risk-analyzer first, then portfolio-analyzer, then trade-decision-engine (matches their dependency chain).

## §4 Price-only changes — ALREADY IMPLEMENTED
`analysis-repository._isPriceContextMaterial()` only bumps `materialVersion` for price-context entries when categorical fields change (priceState, recentBehavior.state, volatilityState, volatilityTrend) or 5D return moves ≥3pp. Minor floating-point fluctuations never bump materialVersion. Fingerprints downstream are therefore stable across tiny price movements.
