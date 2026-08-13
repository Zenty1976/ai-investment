---
name: Sector Intelligence Architecture
description: Hybrid skip/discovery architecture for Sector Monitor — input fingerprinting, portfolio exposure computation, data gaps, and downstream compatibility.
---

## Architecture

`sector-intelligence.ts` — pure deterministic functions, no AI, no network.
`sector-monitor.ts` — rewritten to check input fingerprint BEFORE calling AI.

### Two modes

**MAINTENANCE (zero AI):** When `inputFingerprint === entry.dependencyFingerprint`. Calls `saveSkipped()`, returns cached sector analysis with `_debug.mode = "MAINTENANCE"`.

**DISCOVERY (AI + web search):** When inputs changed or no previous result. AI receives compact SectorFacts (portfolio exposure) + upstream contexts. `setFingerprint()` called after success.

### Input fingerprint

Built from DISCRETE structured fields only (not prose):
- Market: sentiment + riskLevel + sorted strongSectors/weakSectors names
- Events: sorted "title|date" pairs for upcoming events
- News: overallMarketImpact + topStory.title
- Portfolio: sorted "sector:band" pairs (None bands excluded)

Stored in `entry.dependencyFingerprint` via `analysisRepository.setFingerprint()`.

### Output fingerprint

`computeOutputFingerprint(sectors)` → sorted `name:rating:trend` — same as previous sector-monitor implementation but extracted to pure function. Used for materialVersion tracking after AI runs.

### Portfolio sector exposure

`computePortfolioSectorExposure(positions, sectorByTicker)` — reads portfolio-manager snapshot positions + iterates `company-monitor:<TICKER>` repository entries to build sectorByTicker map. Returns `SectorMonitorFacts` (NOT `SectorFacts` — that name is taken by risk-facts.ts).

Exposure bands: Significant ≥15%, Moderate 5-14.99%, Minor 1-4.99%, None <1%

### Data gaps (no sector price series)

No ETF/index data exists — these could NOT be implemented:
- return1D/5D/1M, relativeToMarket, rank, rotation, dispersion

Could be added later by adding sector ETF UICs to `fetchAndStorePriceHistory()` — infrastructure already handles Saxo OHLC.

### Downstream compatibility

`downstream-ai-context.getSectorAiContext()` reads `overallOutlook` + `name/rating/trend` per sector. Output shape unchanged — no downstream changes needed.

**Why:** AI was previously called on EVERY sector-monitor request, THEN materiality was checked on the output. The new architecture checks a deterministic input fingerprint BEFORE the AI call, so unchanged market state produces zero AI spend rather than a full web-search call.
