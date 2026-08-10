/**
 * Market Indices Route
 *
 * Fetches live index prices from Saxo Bank and returns them for the header
 * ticker strip. Results are cached for 60 seconds to avoid hammering Saxo.
 *
 * If Saxo is not connected, in mock mode, or any individual index lookup
 * fails, that index is returned with value: null so the frontend shows "—".
 *
 * Lookup strategy per index:
 *   1. Search Saxo ref API for the instrument by keyword
 *   2. Take the first matching result's Uic + AssetType
 *   3. Fetch InfoPrice for that instrument
 */

import { Router, type IRouter } from "express";
import { saxoStore } from "../lib/saxo-store.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Index definitions — keyword is sent to Saxo ref/v1/instruments search
// ---------------------------------------------------------------------------

const INDEX_TARGETS = [
  { label: "OMXC25",     keywords: "OMXC25",      assetTypes: "StockIndex" },
  { label: "S&P 500",    keywords: "S&P 500",      assetTypes: "StockIndex" },
  { label: "NASDAQ 100", keywords: "NASDAQ 100",   assetTypes: "StockIndex" },
  { label: "VIX",        keywords: "VIX",          assetTypes: "StockIndex" },
] as const;

// Mock values used when Saxo mock mode is active (approximate Aug 2026 levels)
const MOCK_VALUES: Record<string, number> = {
  "OMXC25":     2748.5,
  "S&P 500":    5612.0,
  "NASDAQ 100": 19840.0,
  "VIX":        14.2,
};

// ---------------------------------------------------------------------------
// Simple in-memory cache (60 s)
// ---------------------------------------------------------------------------

interface IndexResult {
  label: string;
  value: number | null;
}

let _cache: IndexResult[] | null = null;
let _cacheExpiry = 0;
const CACHE_TTL_MS = 60_000;

/** Call this to force a fresh fetch on the next request (e.g. after reconnect). */
export function invalidateMarketIndicesCache(): void {
  _cache = null;
  _cacheExpiry = 0;
}

// ---------------------------------------------------------------------------
// Saxo helpers (local — same pattern as portfolio-manager)
// ---------------------------------------------------------------------------

function saxoBase(env: "sim" | "live"): string {
  return env === "live"
    ? "https://gateway.saxobank.com/openapi"
    : "https://gateway.saxobank.com/sim/openapi";
}

async function saxoGet<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Saxo ${res.status} ${url}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Per-index lookup
// ---------------------------------------------------------------------------

interface SaxoInstrument {
  Identifier?: number;
  AssetType?: string;
  Description?: string;
  Symbol?: string;
}

interface SaxoInstrumentSearchResponse {
  Data?: SaxoInstrument[];
}

interface SaxoInfoPrice {
  Quote?: {
    Mid?: number;
    LastTraded?: number;
    Ask?: number;
    Bid?: number;
    Close?: number;
    Open?: number;
    ErrorCode?: string;
    PriceTypeAsk?: string;
    PriceTypeBid?: string;
  };
  DisplayAndFormat?: {
    LastClose?: number;
  };
  InstrumentPriceDetails?: {
    LastClose?: number;
    Open?: number;
  };
}

async function fetchIndexValue(
  keywords: string,
  assetTypes: string,
  token: string,
  base: string,
  fallback: number | null,
): Promise<number | null> {
  try {
    // Step 1 — find the instrument UIC
    const searchUrl =
      `${base}/ref/v1/instruments` +
      `?Keywords=${encodeURIComponent(keywords)}` +
      `&AssetTypes=${encodeURIComponent(assetTypes)}` +
      `&IncludeNonTradable=true` +
      `&$top=3`;

    const searchRes = await saxoGet<SaxoInstrumentSearchResponse>(searchUrl, token);
    const instruments = searchRes.Data ?? [];
    if (instruments.length === 0) {
      logger.warn({ keywords }, "[market-indices] No instruments found");
      return fallback;
    }

    // Pick first result — prefer exact symbol match if possible
    const match =
      instruments.find(
        (i) => i.Symbol?.toUpperCase() === keywords.toUpperCase(),
      ) ?? instruments[0];

    const uic = match.Identifier;
    const assetType = match.AssetType ?? assetTypes;
    if (!uic) return fallback;

    // Step 2 — fetch InfoPrice with extended field groups so we get Ask/Bid/LastTraded
    // and DisplayAndFormat for last-close fallback
    const priceUrl =
      `${base}/trade/v1/infoprices` +
      `?AssetType=${encodeURIComponent(assetType)}` +
      `&Uic=${uic}` +
      `&FieldGroups=Quote,DisplayAndFormat,InstrumentPriceDetails`;

    const priceRes = await saxoGet<SaxoInfoPrice>(priceUrl, token);
    const q = priceRes.Quote;

    // "NoAccess" means SIM account has no price access for this instrument.
    // Return the mock/fallback value so the topbar still shows something useful.
    if (q?.PriceTypeAsk === "NoAccess" || q?.PriceTypeBid === "NoAccess") {
      logger.warn({ keywords, uic }, "[market-indices] NoAccess — using fallback");
      return fallback;
    }

    // Prefer live mid/last-traded, then best side, then last close
    const price =
      q?.Mid ??
      q?.LastTraded ??
      q?.Ask ??
      q?.Bid ??
      q?.Close ??
      priceRes.InstrumentPriceDetails?.LastClose ??
      priceRes.DisplayAndFormat?.LastClose ??
      null;

    if (typeof price === "number") return price;

    // If still no price (e.g. market closed, only OldIndicative but no value),
    // fall back to the mock reference value rather than showing "—".
    logger.warn({ keywords, uic, quote: q }, "[market-indices] No price in response — using fallback");
    return fallback;
  } catch (err) {
    logger.warn({ err, keywords }, "[market-indices] Failed to fetch index");
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.get("/market-indices", async (_req, res): Promise<void> => {
  // Serve from cache if still fresh
  if (_cache && Date.now() < _cacheExpiry) {
    res.json(_cache);
    return;
  }

  // Mock mode — return static values immediately
  if (saxoStore.isMockMode()) {
    const mockResult: IndexResult[] = INDEX_TARGETS.map((t) => ({
      label: t.label,
      value: MOCK_VALUES[t.label] ?? null,
    }));
    _cache = mockResult;
    _cacheExpiry = Date.now() + CACHE_TTL_MS;
    res.json(mockResult);
    return;
  }

  // Not connected — return all nulls
  if (!saxoStore.isConnected()) {
    const nullResult: IndexResult[] = INDEX_TARGETS.map((t) => ({
      label: t.label,
      value: null,
    }));
    res.json(nullResult);
    return;
  }

  const token = saxoStore.getAccessToken()!;
  const env = saxoStore.getEnvironment();
  const base = saxoBase(env);

  // Fetch all 4 indices in parallel — each failure returns fallback independently
  const results = await Promise.all(
    INDEX_TARGETS.map(async (t): Promise<IndexResult> => ({
      label: t.label,
      value: await fetchIndexValue(t.keywords, t.assetTypes, token, base, MOCK_VALUES[t.label] ?? null),
    }))
  );

  _cache = results;
  _cacheExpiry = Date.now() + CACHE_TTL_MS;
  res.json(results);
});

export default router;
