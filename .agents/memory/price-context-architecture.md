---
name: Price Context Architecture
description: How deterministic price context (from Saxo OHLC) flows into AI modules — fetch, store, inject pattern with freshness policy and incremental enrichment.
---

## Architecture

**Flow**: Orchestrator → `fetchAndStorePriceContexts()` → repository → AI modules

### Two orchestrator stages

**Stage 1.5** (after portfolio-manager, before monitors):
- Calls `collectAllKnownTargets()` which merges three sources:
  1. Portfolio positions (UICs always free from Saxo position data)
  2. Company Monitor tracked companies (UICs resolved via Saxo `ref/v1/instruments` search)
  3. Opportunity Finder candidates from the **previous** cycle (already in repo)
- Calls `fetchAndStorePriceContexts(targets)` — skips already-fresh symbols (no duplicate Saxo calls)

**Stage 8.5** (after opportunity-finder, before trade-decision-engine):
- Calls `collectOpportunityFinderTargets()` — reads the **current** cycle's newly discovered OF candidates
- Calls `fetchAndStorePriceContexts()` again — incremental, only new/stale symbols
- Ensures TDE always receives Price Context for freshly discovered OF candidates in the **same** cycle
- Safe to call twice: fresh symbols are skipped by the freshness check inside the fetch function

### Freshness policy
- `PRICE_CONTEXT_MAX_AGE_MS = 6 * 60 * 60 * 1000` (6 hours)
- `isPriceContextFresh(ctx)` — checks `ctx.asOf` timestamp
- `getPriceContext(symbol)` returns `undefined` when stale
- `getAllPriceContexts()` silently omits stale entries
- Stale data is **NEVER** sent to OpenAI as current
- No re-fetch when fresh — a second fetch call within 6h skips Saxo entirely

### UIC resolution for CM/OF symbols
- `resolveUicForTicker(ticker, token, baseUrl)` — calls Saxo `ref/v1/instruments?Keywords=<ticker>&AssetTypes=Stock,Etf,StockIndex&$top=5`
- Prefers exact Symbol match; falls back to first result
- Returns `null` on failure; logs reason; symbol is silently skipped
- Never invents UICs — if resolution fails, Price Context is omitted for that symbol

### Repository keys
- `price-context:<SYMBOL>` (uppercase) — one entry per symbol
- `PRICE_CONTEXT_KEY_PREFIX = "price-context"` in price-context-service.ts

### Key files
- `lib/price-context-calculator.ts` — pure math: `calculatePriceContext()`, `formatPriceContextForPrompt()`, `PRICE_CONTEXT_CONFIG` thresholds
- `lib/price-context-service.ts` — full service: Saxo fetch, freshness, UIC resolution, target collection, repository persistence
  - `fetchAndStorePriceContexts(targets)` — core fetch, skip-if-fresh, persist
  - `collectAllKnownTargets()` — Stage 1.5: portfolio + CM + prev-cycle OF
  - `collectOpportunityFinderTargets()` — Stage 8.5: current-cycle OF
  - `getPriceContext(symbol)` — freshness-checked single read
  - `getAllPriceContexts()` — all fresh entries as formatted Record
- `lib/automation-orchestrator.ts` — Stage 1.5 (`price-context-initial`) + Stage 8.5 (`price-context-incremental`)
- `routes/company-monitor.ts` — `getPriceContext(ticker)` + `formatPriceContextForPrompt()`
- `routes/opportunity-finder.ts`, `risk-analyzer.ts`, `portfolio-analyzer.ts` — `getAllPriceContexts()`
- `routes/trade-decision-engine.ts` — `getAllPriceContexts()` as priority 5.5 section
- `pages/CompanyMonitor.tsx` — `PriceContextPanel` component; reads `price-context:<TICKER>` via repository hook

### Semantic rules (in every AI module system prompt)
- `StabilizingAfterDecline` ≠ bottom confirmed
- `PossibleRecovery` ≠ durable reversal
- `ExtendedAfterRally` ≠ sell signal
- Never move `investmentCaseStrength` solely from price movement
- Price falling ≠ cheap; price rising ≠ expensive
- Price Context alone cannot satisfy the ≥2 independent sources requirement (TDE)

**Why:**
- OpenAI never sees raw prices — only deterministic backend metrics
- Duplicate Saxo requests prevented by freshness check inside `fetchAndStorePriceContexts()`
- Circular dependency avoided: OF discovers candidates first, then Stage 8.5 enriches
- Stale data never silently passed to OpenAI — omitted instead (graceful degradation)
