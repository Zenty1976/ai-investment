---
name: Saxo Authenticated Enumeration Audit
description: Results of 2026-08-14 authenticated Saxo API capability recheck. Confirms exchange enumeration works.
---

## Result

**Environment:** SIM (gateway.saxobank.com/sim/openapi)  
**User:** Lars Warren Ramsdal — MarketDataViaOpenApiTermsAccepted: true

## Instrument Enumeration — CONFIRMED WORKING

`GET /ref/v1/instruments?AssetTypes=Stock&ExchangeId=<exchange>&$top=200` with `__next` pagination:
- CSE (Denmark): **117 stocks**, 1 page
- NASDAQ (US): **1,979 stocks**, 10 pages
- NYSE (US): **2,039 stocks**, 11 pages
- Total: **~4,135 equities** discoverable without knowing tickers

Response fields per instrument: UIC (Identifier), Symbol (e.g. "NOVOb:xcse"), Description, ExchangeId, CurrencyCode, IssuerCountry, TradableAs, GroupId, PrimaryListing.  
**Does NOT include:** sector, industry, SIC, market cap.

## Price History — CONFIRMED

- Daily bars (Horizon=1440): **500+ bars (~2 years)** ← was thought to be 92 only
- Weekly bars (Horizon=10080): working
- Monthly bars (Horizon=43200): working
- Intraday 1h (Horizon=60): working (recent periods)

## NOT AVAILABLE in Authenticated Saxo API

All confirmed 404:
- Corporate actions: 404
- Financial data / key ratios: 404
- Earnings history (EPS actuals/estimates): 404
- Analyst consensus: 404
- News API: 404
- FieldGroups on /ref/v1/instruments: all 400

## Architecture Changes Made

- `saxo-universe-refresh.ts` — new pino-using service; pages CSE/NASDAQ/NYSE at startup
- `SaxoMarketUniverseProvider.getEquities()` — now reads from MarketUniverseRepository (SAXO_API cache)
- `canEnumerateExchangeEquities: true` for SaxoMarketUniverseProvider
- `priceData.historyDepthDays: 500` (corrected from 92)
- Removed "Market Universe" from REQUIRED external gaps (now available via Saxo)
- Background refresh at startup (fire-and-forget, 7-day TTL)

**Why:** Previous unauthenticated tests missed the ExchangeId enumeration capability.
