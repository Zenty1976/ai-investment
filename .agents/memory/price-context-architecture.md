---
name: Price Context Architecture
description: How deterministic price context (from Saxo OHLC) flows into AI modules — fetch, store, inject pattern with freshness policy, incremental enrichment, and recentBehavior extension.
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

### Freshness policy
- `PRICE_CONTEXT_MAX_AGE_MS = 6 hours`
- `getPriceContext(symbol)` returns `undefined` when stale
- `getAllPriceContexts()` silently omits stale entries — never forwarded to OpenAI
- No re-fetch when fresh — second call within 6h skips Saxo entirely

### UIC resolution for CM/OF symbols
- `resolveUicForTicker(ticker, token, baseUrl)` — Saxo `ref/v1/instruments?Keywords=<ticker>&AssetTypes=Stock,Etf,StockIndex&$top=5`
- Prefers exact Symbol match; falls back to first result
- Returns `null` on failure; symbol silently skipped

### Repository keys
- `price-context:<SYMBOL>` (uppercase, e.g. `price-context:SERV:XNAS`)

### Key files
- `lib/price-context-calculator.ts` — pure math: all types, `PRICE_CONTEXT_CONFIG`, `calculatePriceContext()`, `formatPriceContextForPrompt()`
- `lib/price-context-service.ts` — Saxo fetch, freshness, UIC resolution, target collection, repository persistence
- `lib/automation-orchestrator.ts` — Stage 1.5 + Stage 8.5

---

## PriceContext data shape

Main fields: `returns`, `range`, `trend`, `volatility`, `structure`, `priceState`, `recentBehavior`, `dataQuality`

### recentBehavior (added in session Aug 2026)
```typescript
recentBehavior: {
  twoDayReturnPct: number | null      // 2-session % return
  threeDayReturnPct: number | null    // 3-session % return
  threeDaySlope: number | null        // normalized regression slope over last 3 closes (%/day × 100)
  daysSinceRecentLow: number | null   // within 30D window; 0 = today IS the 30D low
  newLowLast3Days: boolean | null     // 30D low occurred in last 3 sessions
  newLowLast5Days: boolean | null     // 30D low occurred in last 5 sessions
  declineDecelerating: boolean        // 3D slope materially less negative than 5D slope
  state: RecentBehaviorState          // FallingFast | Falling | DeclineSlowing | Stabilizing | Recovering | Rising
}
```

**Key design principle**: `priceState` and `recentBehavior.state` are INDEPENDENT and can coexist:
- `priceState=StrongDowntrend` + `recentBehavior.state=Stabilizing`
  = "Broader downtrend ongoing, but very recent (2–3 session) selling pressure appears to be easing"

**State thresholds** (raw normalized slope, fraction/day):
- `FallingFast`: 3D slope < -0.01 (-1.0%/day)
- `Falling`: 3D slope < -0.002 (-0.2%/day)
- `Stabilizing`: broader downtrend + |3D slope| < 0.0015 + declineDecelerating + no new 30D low in 3 sessions + |3D return| < 5%
- `DeclineSlowing`: broader downtrend + declineDecelerating (but not fully stabilizing)
- `Recovering`: broader negative + 2D return > +2%
- `Rising`: 3D slope > +0.002

**Deceleration definition**: `5D slope ≤ -0.002` AND `3D slope > 5D slope × 0.5` (at least 50% less negative) AND `3D slope > -0.005`

**Semantic rules in all AI system prompts:**
- `recentBehavior` describes ONLY the last 2–3 sessions
- `Stabilizing`/`Recovering` ≠ bottom confirmed, reversal confirmed, BUY
- Never change investment view, risk assessment, or trade conviction solely from recentBehavior

---

## Known model behavior quirks (company-monitor)

**Ticker identity**: Models (gpt-4o) return base symbol (`SERV`) instead of full exchange-suffix ticker (`SERV:XNAS`).
- **Fix**: In identity check, if `returnedTicker === ticker.split(":")[0]`, accept and override silently.

**JSON trailing fields**: Model occasionally places conditional fields (e.g. `investmentCaseStrengthChange`) AFTER the closing `}` of the main object, inside a spurious outer `{}` wrapper:
- Pattern: `{main_object},"conditionalField":{...}}`
- **Fix**: Recovery step in `ai-service.ts` — find first complete object, strip trailing `}`, merge trailing fields into main object. Logged as warn.

---

## Semantic safeguards (in every AI module system prompt)
- `StabilizingAfterDecline` ≠ bottom confirmed
- `PossibleRecovery` ≠ durable reversal
- `ExtendedAfterRally` ≠ sell signal
- `recentBehavior.Stabilizing`/`Recovering` ≠ bottom, reversal, or BUY
- Never move `investmentCaseStrength` or trade decision solely from price movement
- Price falling ≠ cheap; price rising ≠ expensive
- Price Context alone cannot satisfy the ≥2 independent sources requirement (TDE)

**Why:**
- OpenAI never sees raw prices — only deterministic backend metrics
- Duplicate Saxo requests prevented by freshness check inside `fetchAndStorePriceContexts()`
- Circular dependency avoided: OF discovers candidates first, then Stage 8.5 enriches
- Stale data never silently passed to OpenAI — omitted instead (graceful degradation)
