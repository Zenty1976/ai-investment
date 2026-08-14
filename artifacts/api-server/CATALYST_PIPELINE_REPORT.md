# Catalyst Intelligence Pipeline — §13 Final Report

> Answers to the 12 mandatory questions required after the correction spec integration.
> Status: All pipeline stages wired and verified. 490 tests pass. TypeScript clean.

---

## Q1 — How does the universe get built, and what tickers does it cover?

**Answer:** `collectAllScreenableTickers()` in `lib/catalyst-universe.ts` is the **single canonical function** used by the screening route. It combines four sources in priority order (highest first):

1. **Portfolio holdings** — from `portfolio-manager` repository entry
2. **Opportunity Finder candidates** — from `opportunity-finder` repository entry
3. **Company Monitor entries** — all `company-monitor:<TICKER>` repository keys
4. **Static universe seed** — 25 Danish (C25 + major companies) + 20+ US (S&P 500 leaders)

Total at launch: ~50 tickers. All results are deduplicated; each entry carries `inPortfolio`, `inOpportunityFinder`, `inCompanyMonitor`, `inUniverseSeed` flags.

**The old `collectScreenableTickers()` function (which only covered sources 1–3) has been deleted from the route.** It was the root cause of universe seed tickers being missed.

---

## Q2 — What can Saxo provide for the universe, and what is missing?

**Answer:** The Saxo `ref/v1/instruments` API supports **per-ticker keyword lookup** only (`?Keywords=<ticker>`). It does NOT support bulk listing by exchange. This means:

- ✅ **What Saxo CAN provide:** UIC (instrument identifier) + AssetType enrichment for the static seed tickers. We verify tradeable status and resolve UICs for instruments already in our list.
- ❌ **What Saxo CANNOT provide:** Discovery of new tickers we don't already know about. We cannot call `?ExchangeId=CSE` to get all Copenhagen equities.

**The limitation text (stored in every `SaxoUniverseCache` response):**
> "The Saxo ref/v1/instruments API supports per-ticker keyword lookup only. Bulk listing by exchange is not available. To expand the universe, add tickers to DANISH_SEED or US_SEED in `catalyst-universe.ts`. True exchange-wide discovery requires a separate data vendor (STOXX, FactSet, Bloomberg)."

Saxo enrichment runs asynchronously during `POST /api/catalyst-intelligence/screen` via `enrichUniverseWithSaxo()` (cached 24h). The `GET /api/catalyst-intelligence/universe` endpoint returns full status.

---

## Q3 — How is the best upcoming event selected during screening?

**Answer:** `screenTicker()` now uses a **three-level priority cascade**:

1. **`getUpcomingEventsForTicker(ticker, 90, nowIso)`** — reads all `CompanySpecificEvent` records stored in the `catalyst-company-events:<TICKER>` repository key. These can be ANY event type (EARNINGS, INVESTOR_DAY, PRODUCT_LAUNCH, FDA_DECISION, etc.), not just earnings.
   - Filter: `daysUntilEvent >= minDaysUntilEvent` (default 0)
   - Sort: higher `potentialMarketImpact` first, then earliest `eventDate`
   - The top-ranked event is mapped to `CatalystEvent` via `companyEventToCatalystEvent()`.

2. **`findNextEarningsDate(ticker, cmResult, now)`** — fallback that checks `CM.earningsAndGuidance.nextKnownEventDate` and the Event Monitor. Only invoked when the CompanySpecificEvents store returns nothing in the window.

3. **`event = null`** — if neither source finds an event. The ticker is PATH B eligible.

`ScheduledCatalystType` is mapped to `CatalystEventType` via `scheduledTypeToCatalystEventType()`:
- INVESTOR_DAY → "InvestorDay"
- PRODUCT_LAUNCH / AI_MODEL_LAUNCH / KEYNOTE → "ProductLaunch"
- FDA_DECISION / REGULATORY_DECISION → "RegulatoryDecision"
- CLINICAL_READOUT → "ClinicalReadout"
- etc.

---

## Q4 — How does proactive event discovery work, and what are its cost controls?

**Answer:** `runProactiveEventDiscovery()` is called at the start of `POST /api/catalyst-intelligence/screen`. It targets **pure universe-seed tickers** (not in portfolio/OF/CM — lowest priority watchlist).

**Cost gates in `shouldSkipDiscovery()` (in `lib/catalyst-event-gate.ts`):**
1. **48h minimum interval** — if `StoredCompanyEvents.lastDiscoveredAt` is < 48h ago, skip.
2. **Enough events already** — if `getUpcomingEventsForTicker()` returns ≥ 2 upcoming events, skip.

**Per-screen cap:** `MAX_PROACTIVE_DISCOVERIES = 5`. Only the first 5 eligible tickers get a web search.

**Discovery gate is separated** from discovery logic: `lib/catalyst-event-gate.ts` (no AI/pino dependency, importable in tests) vs `lib/catalyst-event-discovery.ts` (has `callAiWithWebSearch`).

The screen endpoint can skip proactive discovery entirely with `{ skipDiscovery: true }` in the body.

---

## Q5 — How does PATH B (no event) work in the analyze endpoint?

**Answer:** `POST /api/catalyst-intelligence/analyze/:ticker` now handles PATH B correctly:

**Before the fix (broken):** If `state.facts` was null, the endpoint returned `"No upcoming event found — no facts to analyze"` and bailed.

**After the fix:** If `!state.facts`:
1. Build PATH B facts via `buildCatalystFacts({ ticker, event: null, storedSignals })` — `event: null` is now a valid input (`CatalystFacts.event: CatalystEvent | null`).
2. `computeSignalAccumulationState()` runs on all available signals.
3. `detectEmergingSetup()` runs — for PATH B (`hasKnownUpcomingEvent: false`).
4. If `emergingSetupWarrantsAnalysis(emergingSetup)` returns true (state ≥ DEVELOPING), deep AI analysis runs.
5. Driver profile is generated if needed; driver-directed signal research runs.
6. Analysis proceeds identically to PATH A.

**Key changes to support PATH B:**
- `CatalystFacts.event: CatalystEvent | null` (was `CatalystEvent`)
- `buildCatalystFacts` uses `event?.daysUntilEvent ?? 45` as fallback for price asymmetry
- `catalyst-analysis.ts` and `catalyst-screening.ts` use `facts.event?.xxx ?? fallback`
- `triggerType = "EMERGING_SETUP"` when `!hasScheduledEvent`

---

## Q6 — How are signals persisted between runs?

**Answer:** `lib/catalyst-signal-store.ts` manages persistent signals:

- **Repository key:** `catalyst-signals:<TICKER>`
- **Storage shape:** `{ ticker, signals: LeadingIndicatorSignal[], updatedAt }`
- **Deduplication:** `mergeStoredSignals()` uses `signalId` as the unique key; newer signal overwrites older.
- **Pruning:** Automatic — signals older than `MAX_SIGNAL_AGE_DAYS = 90` are removed on every merge.
- **Age filtering:** `getStoredSignals(ticker, maxDaysOld?)` returns only signals within the window.

**Integration in the pipeline:**
1. `screenTicker()` calls `getStoredSignals(ticker, 30)` and passes them as `storedSignals` to `buildCatalystFacts`.
2. `buildCatalystFacts` merges `storedSignals` with current-run signals (CM + News), deduplicating by `signalId`.
3. `analyze/:ticker` loads stored signals again, builds `allSignals = facts.signals + additional stored`, and passes them to `computeSignalAccumulationState`.
4. After driver-directed research, new signals are stored via `mergeStoredSignals`.

---

## Q7 — How does driver-directed signal research work?

**Answer:** `lib/catalyst-signal-research.ts` — `researchDriverSignals()`:

1. Call `buildDriverSearchTopics(driverProfile, daysUntilEvent)` to get the most important driver topics.
2. **Fingerprint check:** `buildResearchFingerprint(ticker, topics)` → compare with stored fingerprint in `catalyst-signal-research:<TICKER>`.
3. **Freshness gate:** `isSignalResearchFresh(ticker, fingerprint)` — skip if < 24h AND fingerprint unchanged.
4. **Coverage assessment:** Check which topics are already covered by existing stored signals (keyword matching). Only research uncovered topics.
5. **Max 3 web searches per run** (cost control) — `callAiWithWebSearch` for each uncovered topic.
6. Normalize findings into `LeadingIndicatorSignal` records via `normalizeSignal()`.
7. `mergeStoredSignals(ticker, newSignals)` — persist them.
8. `recordSignalResearch(ticker, fingerprint)` — update freshness record.

Research only runs for `DeepAnalysis` or `PATH B` eligible tickers with a driver profile available.

---

## Q8 — What integration tests cover the pipeline?

**Answer:** `src/lib/__tests__/catalyst-integration.test.ts` (28 new tests):

| Test | Assertion |
|------|-----------|
| **A — Universe** | `collectAllScreenableTickers()` includes NOVO B, AAPL; seed tickers have `inUniverseSeed=true`; ≥40 universe entries |
| **B — Non-earnings event** | `getUpcomingEventsForTicker()` returns INVESTOR_DAY; event date within 90-day window |
| **C — SpaceX-style** | PRODUCT_LAUNCH stored and retrievable; signals stored independently; event within 14 days |
| **D — PATH B** | Stored signals accessible; no scheduled events for PATH B ticker; `CatalystFacts.event` allows null (type check) |
| **E — Signal persistence** | Signals survive merge; batch2 merges with batch1; dedup by signalId (newer wins); age filter excludes old signals |
| **F — No duplicates** | `shouldSkipDiscovery` returns skip reason after recent discovery; returns null for fresh ticker; `isSignalResearchFresh` returns true after recording, false for different fingerprint |

Total test count: **490 pass, 0 fail.**

---

## Q9 — How is EventExpectationProfile populated for non-earnings events?

**Answer:** `EventExpectationProfile` types exist in `catalyst-types.ts` but are currently NOT auto-populated for non-earnings events. The facts builder sets `expectations: unavailableExpectations()` for all events because Saxo does not provide analyst consensus data.

For non-earnings events (Investor Day, Product Launch, etc.), the expectation gap is assessed qualitatively via:
- CM signals about management guidance tone (`earningsGuidanceTrend`)
- Driver-directed research signals (e.g. "analyst expected GLP-1 market share gain X%")
- Company Monitor `investmentView` and `bullCase`/`bearCase`

Full quantitative `EventExpectationProfile` for non-earnings events requires an external data vendor (FactSet, Bloomberg). This is documented in the `isUnavailable: true` field of the returned `ExpectationsProfile`.

---

## Q10 — How does the route know which path (A vs B) a ticker is on?

**Answer:** The response from `POST /api/catalyst-intelligence/analyze/:ticker` includes:

```json
{
  "triggerType": "EARNINGS" | "SCHEDULED_EVENT" | "EMERGING_SETUP",
  "pathType": "PATH_A" | "PATH_B",
  "event": { "eventType": "...", "eventDate": "...", "daysUntilEvent": 12 } | null
}
```

- `PATH_A` → `hasScheduledEvent = true` → `facts.event !== null`
- `PATH_B` → `hasScheduledEvent = false` → `facts.event === null`, `triggerType = "EMERGING_SETUP"`
- `triggerType = "EARNINGS"` is a PATH A subtype (event type is Earnings specifically)
- `triggerType = "SCHEDULED_EVENT"` is PATH A with any other event type (Investor Day, Product Launch, etc.)

---

## Q11 — How does the Saxo universe enrichment integrate with screening?

**Answer:** During `POST /api/catalyst-intelligence/screen`, after collecting all screenable tickers:

1. `enrichUniverseWithSaxo(seedEntries)` is called with `.catch(() => {})` — **fire-and-forget, non-blocking.**
2. It checks the 24h cache first; only makes Saxo API calls when cache is expired.
3. Results are stored in `catalyst-universe:saxo-cache` in the analysis repository.
4. UICs enriched from Saxo are available on subsequent `getUniverseEntry()` calls (cache invalidation needed).
5. `GET /api/catalyst-intelligence/universe` returns the full Saxo status report.

The screening itself is synchronous and does NOT wait for Saxo enrichment. Universe entry metadata (sector, industry, company name) is read from the in-memory cache which is built from the static seed immediately.

---

## Q12 — What is the complete pipeline flow from screen to promotion?

**Answer:** End-to-end flow for a new universe company with a product launch:

```
POST /api/catalyst-intelligence/screen
  → collectAllScreenableTickers() [includes universe seed]
  → runProactiveEventDiscovery() [discovers PRODUCT_LAUNCH via web search, stores it]
  → for each ticker: screenTicker()
      → getUpcomingEventsForTicker() → finds PRODUCT_LAUNCH (12 days)
      → companyEventToCatalystEvent() → CatalystEvent{eventType:"ProductLaunch"}
      → getStoredSignals(ticker, 30) → any historical signals
      → buildCatalystFacts({ticker, event, storedSignals})
      → screenCatalystCandidate() → eligible=true, DeepAnalysis
      → saveCatalystState() → {screening, facts, discoverySource:"UNIVERSE_EVENT"}

POST /api/catalyst-intelligence/analyze/:ticker
  → state = getCatalystState(ticker) [already screened]
  → facts = state.facts [PATH A, event not null]
  → allSignals = facts.signals + stored signals
  → computeSignalAccumulationState() → {window7D/14D/30D, momentum, confidence}
  → detectEmergingSetup() → NONE (PATH A has known event → PATH B skipped)
  → triggerType = "SCHEDULED_EVENT"
  → getOrGenerateDriverProfile() → AI generates profile (web search)
  → researchDriverSignals() → max 3 web searches for uncovered driver topics
      → mergeStoredSignals() → persist new signals
  → buildCatalystFacts({ticker, event, allStoredSignals}) → rebuild with all signals
  → runCatalystAnalysis({facts, triggerType:"SCHEDULED_EVENT", driverProfile})
      → fingerprint check → if changed: two-phase AI analysis
      → returns CatalystAnalysisResult{opportunityState, catalystDirection, thesis}
  → qualifiesForPromotion() → if STRONG_OPPORTUNITY: promoteToOpportunityFinder()
  → saveCatalystState() → full updated state
  → return {triggerType, pathType:"PATH_A", event, signalAccumulation, ...}
```

---

*Report generated: 2026-08-14 | Tests: 490/490 pass | TypeScript: clean*
