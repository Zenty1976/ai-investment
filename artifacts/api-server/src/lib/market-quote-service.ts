/**
 * Market Quote Service
 *
 * Single price-lookup entry point for Trade Review and any other module that
 * needs a current instrument price without making a live Saxo API call.
 *
 * Lookup priority:
 *   1. Saxo live quote  (TODO: integrate Saxo InfoPrice when streaming is live)
 *   2. Stored quote repository  (TODO: future short-lived quote cache)
 *   3. Development mock quote when Saxo mock mode is enabled
 *
 * Every result carries a standard MarketQuote shape so callers never need to
 * know which source provided the price.  The fxToBase field lets Trade Review
 * convert instrument prices to portfolio base currency (DKK) without a
 * separate FX lookup.
 *
 * Rules:
 *   - Never call OpenAI here — prices must come from real or mock market data.
 *   - Never hardcode prices inside Trade Review; add them here.
 *   - fxToBase is 1 when the instrument trades in the portfolio base currency.
 */

import { FX_USD_DKK } from "./saxo-mock-data.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MarketQuote {
  ticker: string;
  price: number;
  currency: string;
  /** Rate to convert instrument price → portfolio base currency (DKK). 1 for DKK instruments. */
  fxToBase: number;
  timestamp: string;
  source: "Saxo" | "StoredQuote" | "Mock";
  isStale: boolean;
}

// ---------------------------------------------------------------------------
// Mock quote table
// ---------------------------------------------------------------------------
//
// Used only when Saxo mock mode is enabled (Settings → Saxo → Simulation).
// Prices are approximate reference values for development / demo purposes.
// Add new opportunity candidates here as needed — Trade Review will pick them
// up automatically without any changes to the Trade Review route.
//
// Prices last updated: August 2026 (development reference values).

const MOCK_QUOTES: Readonly<Record<string, { price: number; currency: string; fxToBase: number }>> = {
  // ── Currently held positions (match saxo-mock-data.ts) ─────────────────
  "NOVO B": { price:   705.60, currency: "DKK", fxToBase: 1           },
  "MSFT":   { price:   420.50, currency: "USD", fxToBase: FX_USD_DKK  },
  "SERV":   { price:     6.48, currency: "USD", fxToBase: FX_USD_DKK  },
  // ── Opportunity candidates ──────────────────────────────────────────────
  // Caterpillar Inc. (NYSE: CAT) — priced in USD
  "CAT":    { price:   350.00, currency: "USD", fxToBase: FX_USD_DKK  },
  // Eli Lilly and Company (NYSE: LLY) — priced in USD
  "LLY":    { price:   890.00, currency: "USD", fxToBase: FX_USD_DKK  },
  // ── Add further candidates below ───────────────────────────────────────
};

// ---------------------------------------------------------------------------
// Lookup function
// ---------------------------------------------------------------------------

/**
 * Return a market quote for `ticker`, or null if no price is available.
 *
 * @param ticker     Instrument symbol (case-insensitive).
 * @param mockMode   Pass `saxoStore.isMockMode()`. When false only live/stored
 *                   sources are attempted (Saxo, repository — not yet implemented).
 */
export function getMarketQuote(ticker: string, mockMode: boolean): MarketQuote | null {
  const key = ticker.trim().toUpperCase();

  // ── Priority 1: Saxo live InfoPrice ──────────────────────────────────────
  // TODO: call Saxo InfoPrice endpoint once streaming connection is integrated.

  // ── Priority 2: Stored quote repository ──────────────────────────────────
  // TODO: check analysis repository for a recent "market-quote:<ticker>" entry
  //       to avoid redundant Saxo calls within a short window.

  // ── Priority 3: Development mock ─────────────────────────────────────────
  if (mockMode) {
    const mock = MOCK_QUOTES[key];
    if (mock) {
      return {
        ticker:    key,
        price:     mock.price,
        currency:  mock.currency,
        fxToBase:  mock.fxToBase,
        timestamp: new Date().toISOString(),
        source:    "Mock",
        isStale:   false,
      };
    }
  }

  return null;
}
