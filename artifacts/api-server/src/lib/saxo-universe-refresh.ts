/**
 * Saxo Universe Refresh Service — spec §5, §14
 *
 * Authenticated background fetch of the complete DK + US equity universe
 * from Saxo's ref/v1/instruments API using ExchangeId pagination.
 *
 * DISCOVERY (2026-08-14 authenticated audit):
 *   GET /ref/v1/instruments?AssetTypes=Stock&ExchangeId=CSE&$top=200
 *   → Returns ALL Danish equities with pagination. No ticker required.
 *   → CSE: 117 stocks, NASDAQ: 1,979, NYSE: 2,039 (~4,135 total)
 *
 * WHAT SAXO PROVIDES IN THE ENUMERATION RESPONSE:
 *   UIC (Identifier), Symbol, Description, ExchangeId, CurrencyCode,
 *   IssuerCountry, TradableAs, GroupId, PrimaryListing.
 *   DOES NOT INCLUDE: sector, industry, SIC code, market cap.
 *
 * WHAT SAXO DOES NOT PROVIDE (confirmed 404 in authenticated audit):
 *   Corporate actions, financial data, key ratios, earnings history,
 *   EPS/revenue actuals/estimates, analyst consensus, news API.
 *
 * Cache TTL: 7 days (universe is stable; companies rarely delisted/listed).
 * Safety: max 100 pages per exchange to prevent runaway loops.
 * Rate limiting: 150ms delay between pages.
 *
 * This file uses pino (logger). Do NOT import in tests.
 */

import { logger } from "./logger.js";
import { saxoStore } from "./saxo-store.js";
import { loadUniverseRecords, saveUniverseRecords } from "./market-universe-repository.js";
import type { MarketRecord } from "./market-universe-provider.js";

// ── Configuration ──────────────────────────────────────────────────────────────

/** Exchanges to refresh. CSE = Danish OMX Copenhagen; NASDAQ/NYSE = US. */
const REFRESH_EXCHANGES = ["CSE", "NASDAQ", "NYSE"] as const;

/** Cache TTL: 7 days. Universe composition doesn't change minute-to-minute. */
const UNIVERSE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Saxo pagination page size (max we've verified works). */
const PAGE_SIZE = 200;

/** Max pages per exchange (safety valve — 100 × 200 = 20,000 instruments). */
const MAX_PAGES = 100;

/** Milliseconds between page fetches to respect Saxo rate limits. */
const PAGE_DELAY_MS = 150;

// ── Internal types ─────────────────────────────────────────────────────────────

interface SaxoInstrumentRow {
  AssetType?: string;
  CurrencyCode?: string;
  Description?: string;
  ExchangeId?: string;
  GroupId?: number;
  Identifier?: number; // UIC
  IssuerCountry?: string;
  PrimaryListing?: number;
  SummaryType?: string;
  Symbol?: string;         // e.g. "NOVOb:xcse" or "NVDA:xnas"
  TradableAs?: string[];
}

interface SaxoInstrumentPage {
  Data?: SaxoInstrumentRow[];
  __next?: string;
}

// ── Core fetch helpers ─────────────────────────────────────────────────────────

function parseSymbol(raw: string): string {
  // "NOVOb:xcse" → "NOVOb"  |  "NVDA:xnas" → "NVDA"
  const colonIdx = raw.indexOf(":");
  return colonIdx > 0 ? raw.slice(0, colonIdx) : raw;
}

function rowToMarketRecord(row: SaxoInstrumentRow): MarketRecord | null {
  if (!row.Identifier || !row.Symbol) return null;
  const ticker = parseSymbol(row.Symbol);
  if (!ticker) return null;
  return {
    ticker,
    company: row.Description ?? ticker,
    exchange: row.ExchangeId ?? "",
    country: row.IssuerCountry ?? "",
    currency: row.CurrencyCode ?? "",
    sector: null,           // Not provided in Saxo enumeration response
    industry: null,         // Not provided in Saxo enumeration response
    uic: row.Identifier,
    tradeable: (row.TradableAs ?? []).includes("Stock"),
    active: true,
    lastVerifiedAt: new Date().toISOString(),
    source: "SAXO_API",
  };
}

async function fetchExchangePage(url: string, token: string): Promise<SaxoInstrumentPage> {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    throw new Error(`Saxo API returned ${resp.status} for ${url.slice(0, 80)}`);
  }
  return resp.json() as Promise<SaxoInstrumentPage>;
}

async function fetchAllForExchange(
  exchange: string,
  token: string,
  base: string
): Promise<{ records: MarketRecord[]; pages: number }> {
  const records: MarketRecord[] = [];
  let nextUrl: string | null = null;
  const firstUrl =
    `${base}/ref/v1/instruments` +
    `?AssetTypes=Stock` +
    `&ExchangeId=${encodeURIComponent(exchange)}` +
    `&IncludeNonTradable=false` +
    `&$top=${PAGE_SIZE}`;

  let pageCount = 0;

  while (pageCount < MAX_PAGES) {
    const page = await fetchExchangePage(nextUrl ?? firstUrl, token);
    pageCount++;

    for (const row of page.Data ?? []) {
      const rec = rowToMarketRecord(row);
      if (rec) records.push(rec);
    }

    if (page.__next && (page.Data?.length ?? 0) > 0) {
      nextUrl = page.__next;
      if (pageCount < MAX_PAGES) {
        await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
      }
    } else {
      break;
    }
  }

  return { records, pages: pageCount };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface UniverseRefreshResult {
  refreshed: string[];
  skipped: string[];
  counts: Record<string, number>;
  error: string | null;
  durationMs: number;
}

/**
 * Refresh the Saxo equity universe for CSE, NASDAQ, NYSE.
 *
 * Idempotent: skips exchanges whose cached records are <7 days old.
 * Safe to call at startup in a fire-and-forget pattern.
 * Uses pino logger — do not call from test files.
 */
export async function refreshSaxoUniverseIfStale(): Promise<UniverseRefreshResult> {
  const started = Date.now();

  if (!saxoStore.isConnected() || saxoStore.isMockMode()) {
    logger.info("[saxo-universe] Skipping refresh — Saxo not connected or in mock mode");
    return {
      refreshed: [],
      skipped: [...REFRESH_EXCHANGES],
      counts: {},
      error: "Saxo not connected",
      durationMs: 0,
    };
  }

  const token = saxoStore.getAccessToken()!;
  const base = saxoStore.getEnvironment() === "live"
    ? "https://gateway.saxobank.com/openapi"
    : "https://gateway.saxobank.com/sim/openapi";

  const refreshed: string[] = [];
  const skipped: string[] = [];
  const counts: Record<string, number> = {};

  for (const exchange of REFRESH_EXCHANGES) {
    // TTL check — skip if cache is fresh enough
    const cached = loadUniverseRecords(exchange);
    if (cached && cached.source === "SAXO_API") {
      const ageMs = Date.now() - new Date(cached.refreshedAt).getTime();
      if (ageMs < UNIVERSE_TTL_MS) {
        const ageHours = Math.round(ageMs / 3_600_000);
        logger.info(
          { exchange, count: cached.records.length, ageHours },
          "[saxo-universe] Cache fresh — skipping"
        );
        skipped.push(exchange);
        counts[exchange] = cached.records.length;
        continue;
      }
    }

    // Fetch from Saxo
    logger.info({ exchange }, "[saxo-universe] Fetching from Saxo API");
    try {
      const { records, pages } = await fetchAllForExchange(exchange, token, base);
      saveUniverseRecords(exchange, records, "SAXO_API");
      refreshed.push(exchange);
      counts[exchange] = records.length;
      logger.info(
        { exchange, count: records.length, pages },
        "[saxo-universe] Saved to repository"
      );
    } catch (err) {
      logger.error({ exchange, err }, "[saxo-universe] Fetch failed — keeping stale cache");
    }
  }

  const durationMs = Date.now() - started;
  logger.info({ refreshed, skipped, counts, durationMs }, "[saxo-universe] Refresh complete");

  return { refreshed, skipped, counts, error: null, durationMs };
}

/**
 * Force-refresh a single exchange, bypassing the TTL check.
 * Useful for manual refresh via an admin endpoint.
 */
export async function forceRefreshExchange(exchange: string): Promise<{
  count: number;
  durationMs: number;
  error: string | null;
}> {
  const started = Date.now();
  if (!saxoStore.isConnected() || saxoStore.isMockMode()) {
    return { count: 0, durationMs: 0, error: "Saxo not connected" };
  }

  const token = saxoStore.getAccessToken()!;
  const base = saxoStore.getEnvironment() === "live"
    ? "https://gateway.saxobank.com/openapi"
    : "https://gateway.saxobank.com/sim/openapi";

  try {
    const { records } = await fetchAllForExchange(exchange, token, base);
    saveUniverseRecords(exchange.toUpperCase(), records, "SAXO_API");
    return { count: records.length, durationMs: Date.now() - started, error: null };
  } catch (err) {
    return {
      count: 0,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
