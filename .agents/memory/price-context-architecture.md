---
name: Price Context Architecture
description: How deterministic price context (from Saxo OHLC) flows into AI modules — fetch, store, inject pattern.
---

## Architecture

**Flow**: Orchestrator Stage 1.5 → `fetchAndStorePriceContexts()` → repository → AI modules

### Stage 1.5 in Orchestrator
- Runs after Stage 1 (portfolio-manager), before Stage 2 (market/news/event)
- Calls `fetchAndStorePriceContexts(extractTargetsFromPortfolio())`
- Uses `runIsolated()` — Saxo outage never aborts the full cycle
- Only runs when Saxo is connected and not in mock mode

### Repository Keys
- `price-context:<SYMBOL>` — one entry per symbol (e.g. `price-context:NOVO B`)
- Key prefix constant: `PRICE_CONTEXT_KEY_PREFIX = "price-context"` in price-context-service.ts

### Files
- `lib/price-context-calculator.ts` — pure math: `calculatePriceContext()`, `formatPriceContextForPrompt()`, `PRICE_CONTEXT_CONFIG` thresholds
- `lib/price-context-service.ts` — Saxo fetch + repository persistence; exports `fetchAndStorePriceContexts()`, `getPriceContext()`, `getAllPriceContexts()`, `extractTargetsFromPortfolio()`
- `routes/company-monitor.ts` — reads per-ticker via `getPriceContext(ticker)`; imports `formatPriceContextForPrompt` from calculator
- `routes/opportunity-finder.ts`, `risk-analyzer.ts`, `portfolio-analyzer.ts` — read all via `getAllPriceContexts()`; passed as `priceContexts: Record<string, string>` to `buildUserPrompt()`
- `routes/trade-decision-engine.ts` — reads `getAllPriceContexts()` inline; injects as priority 5.5 in userPromptSections

### Frontend: PriceContextPanel
- In `pages/CompanyMonitor.tsx`
- Uses `useGetRepositoryEntry("price-context:<TICKER>")` hook
- Renders after "Sector Context" section
- Shows: priceState badge, 1D/5D/1M/3M returns, ST/MT/LT trend badges, momentum, volatility, 30d range position
- Shows disclaimer: "Observed price behavior — not a forecast"

**Why:**
- OpenAI never sees raw prices — only deterministic backend metrics prevent the model from doing arithmetic on prices
- All thresholds in `PRICE_CONTEXT_CONFIG` (single source of truth)
- Graceful degradation: if Saxo unavailable, AI modules continue without Price Context

**Semantic rules (in every AI module system prompt):**
- `StabilizingAfterDecline` ≠ bottom confirmed
- `PossibleRecovery` ≠ durable reversal
- `ExtendedAfterRally` ≠ sell signal
- Never move `investmentCaseStrength` solely from price movement
- Price falling ≠ cheap; price rising ≠ expensive
