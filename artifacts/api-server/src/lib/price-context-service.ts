/**
 * Price Context Service
 *
 * Fetches 90 days of daily OHLC from Saxo Bank (chart/v3/charts) for a set of
 * symbols, calculates deterministic PriceContext for each, and persists results
 * to the Analysis Repository under "price-context:<SYMBOL>".
 *
 * TARGET COVERAGE (four sources):
 *   1. Portfolio positions          — UICs always available from position data
 *   2. Company Monitor companies    — UICs resolved via Saxo instrument search
 *   3. Opportunity Finder candidates — UICs resolved via Saxo instrument search
 *   4. Trade Decision symbols       — covered via OF + portfolio sets above
 *
 * INCREMENTAL ENRICHMENT:
 *   Stage 1.5 (after portfolio-manager): portfolio + CM + previous-cycle OF targets
 *   Stage 8.5 (after opportunity-finder): newly discovered OF candidates only
 *   fetchAndStorePriceContexts() skips symbols whose Price Context is already fresh.
 *   No duplicate Saxo history requests are made within a cycle.
 *
 * FRESHNESS POLICY:
 *   Daily OHLC bars don't change meaningfully intraday.
 *   PRICE_CONTEXT_MAX_AGE_MS = 6 hours — rejects at file boundary, then re-fetches.
 *   getPriceContext() returns undefined for stale entries.
 *   getAllPriceContexts() silently omits stale entries.
 *   Stale data is NEVER sent to OpenAI as current.
 *
 * UIC RESOLUTION:
 *   Portfolio positions: UIC always present (comes from Saxo position data).
 *   CM/OF symbols: resolved via Saxo ref/v1/instruments keyword search.
 *   If a symbol cannot be resolved to a UIC, it is skipped and the reason is logged.
 *   Resolved UICs are cached in memory per call to avoid redundant Saxo lookups.
 *
 * AI modules read from repository only — they never call this service directly.
 *
 * Graceful degradation: if Saxo is unavailable, Price Context is omitted from AI
 * prompts entirely. Modules continue without Price Context.
 */

import { analysisRepository } from "./analysis-repository.js";
import { saxoStore } from "./saxo-store.js";
import { logger } from "./logger.js";
import { calculatePriceContext, formatPriceContextForPrompt, type PriceContext } from "./price-context-calculator.js";

// ── Freshness policy ──────────────────────────────────────────────────────────

/**
 * Price Context is considered fresh for 6 hours.
 * Daily OHLC bars represent historical closes and don't change intraday.
 * After 6 hours we re-fetch to capture the latest available bar.
 */
export const PRICE_CONTEXT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function isPriceContextFresh(ctx: PriceContext): boolean {
  // Legacy entries (created before recentBehavior was added) must be re-fetched
  // even if their timestamp is recent — the shape is incomplete.
  if (!ctx.recentBehavior) return false;
  const age = Date.now() - new Date(ctx.asOf).getTime();
  return age < PRICE_CONTEXT_MAX_AGE_MS;
}

// ── Saxo API types ────────────────────────────────────────────────────────────

interface SaxoChartBar {
  Time: string;
  Open?: number;
  High?: number;
  Low?: number;
  Close: number;
  Volume?: number;
}

interface SaxoChartResponse {
  Data?: SaxoChartBar[];
}

interface SaxoInstrument {
  Identifier?: number;
  AssetType?: string;
  Symbol?: string;
  Description?: string;
}

interface SaxoInstrumentSearchResponse {
  Data?: SaxoInstrument[];
}

// ── Repository keys ───────────────────────────────────────────────────────────

export const PRICE_CONTEXT_KEY_PREFIX = "price-context";

export function priceContextKey(symbol: string): string {
  return `${PRICE_CONTEXT_KEY_PREFIX}:${symbol.toUpperCase()}`;
}

export const PRICE_HISTORY_KEY_PREFIX = "price-history";

export function priceHistoryKey(symbol: string): string {
  return `${PRICE_HISTORY_KEY_PREFIX}:${symbol.toUpperCase()}`;
}

// ── Price History types ───────────────────────────────────────────────────────

export interface PriceHistoryBar {
  /** ISO date string (YYYY-MM-DD) */
  date: string;
  close: number;
}

export interface PriceHistoryEntry {
  ticker: string;
  bars: PriceHistoryBar[];
  fetchedAt: string;
}

/** Price history is fresh for 4 hours */
const PRICE_HISTORY_MAX_AGE_MS = 4 * 60 * 60 * 1000;

function isPriceHistoryFresh(entry: PriceHistoryEntry): boolean {
  return Date.now() - new Date(entry.fetchedAt).getTime() < PRICE_HISTORY_MAX_AGE_MS;
}

// ── Input descriptor ──────────────────────────────────────────────────────────

export interface PriceContextTarget {
  /** Display symbol / repository key (e.g. "NOVO B", "AVGO"). Always stored uppercase. */
  symbol: string;
  /**
   * Saxo UIC for the instrument.
   * Optional — if absent, resolved automatically via Saxo ref/v1/instruments search.
   * Callers such as Company Monitor that only have a display ticker may omit this.
   */
  uic?: number;
  /**
   * Saxo AssetType (e.g. "Stock", "Etf").
   * Optional — resolved alongside uic when absent.
   */
  assetType?: string;
}

// ── Saxo helpers ──────────────────────────────────────────────────────────────

function saxoBaseUrl(env: "sim" | "live"): string {
  return env === "live"
    ? "https://gateway.saxobank.com/openapi"
    : "https://gateway.saxobank.com/sim/openapi";
}

async function saxoGet<T>(url: string, token: string): Promise<T> {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Saxo API error (${resp.status}) ${url}: ${body.slice(0, 200)}`);
  }
  return resp.json() as Promise<T>;
}

// ── UIC resolution via Saxo instrument search ─────────────────────────────────

/**
 * Resolve a ticker symbol to a Saxo UIC + AssetType via ref/v1/instruments search.
 *
 * Prefers exact Symbol match; falls back to first result.
 * Returns null if no instrument is found or if Saxo returns an error.
 * Caller must log the reason for skipping.
 */
async function resolveUicForTicker(
  ticker: string,
  token: string,
  baseUrl: string
): Promise<{ uic: number; assetType: string } | null> {
  try {
    const url =
      `${baseUrl}/ref/v1/instruments` +
      `?Keywords=${encodeURIComponent(ticker)}` +
      `&AssetTypes=Stock,Etf,StockIndex` +
      `&IncludeNonTradable=false` +
      `&$top=5`;

    const res = await saxoGet<SaxoInstrumentSearchResponse>(url, token);
    const instruments = res.Data ?? [];

    if (instruments.length === 0) {
      logger.warn({ ticker }, "[price-context-service] UIC resolution: no instruments found");
      return null;
    }

    // Prefer exact symbol match (case-insensitive), then first result
    const exactMatch = instruments.find(
      (i) => i.Symbol?.toUpperCase() === ticker.toUpperCase()
    );
    const chosen = exactMatch ?? instruments[0];

    if (!chosen.Identifier || !chosen.AssetType) {
      logger.warn({ ticker, chosen }, "[price-context-service] UIC resolution: missing Identifier or AssetType");
      return null;
    }

    return { uic: chosen.Identifier, assetType: chosen.AssetType };
  } catch (err) {
    logger.warn({ err, ticker }, "[price-context-service] UIC resolution: Saxo search failed");
    return null;
  }
}

// ── Saxo OHLC fetch ───────────────────────────────────────────────────────────

async function fetchChartBars(
  uic: number,
  assetType: string,
  token: string,
  baseUrl: string,
  count = 92  // slightly over 90 to ensure ≥90 trading days
): Promise<SaxoChartBar[]> {
  const url =
    `${baseUrl}/chart/v3/charts` +
    `?AssetType=${encodeURIComponent(assetType)}` +
    `&Uic=${uic}` +
    `&Horizon=1440` +    // 1440 min = 1 trading day
    `&Count=${count}`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Saxo chart API error (${resp.status}) uic=${uic}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as SaxoChartResponse;
  return data.Data ?? [];
}

// ── Core: fetch + calculate + persist ────────────────────────────────────────

/**
 * Fetch and store PriceContext for a batch of symbols.
 *
 * Skips symbols whose Price Context is already fresh (no duplicate Saxo requests).
 * Deduplicates by symbol within the call.
 *
 * @returns Map of symbol → PriceContext for successfully processed symbols.
 *          Symbols that fail (Saxo error, insufficient data) are omitted.
 */
export async function fetchAndStorePriceContexts(
  targets: PriceContextTarget[]
): Promise<Map<string, PriceContext>> {
  const result = new Map<string, PriceContext>();

  if (targets.length === 0) return result;

  // Require a live Saxo connection — never invent data
  if (!saxoStore.isConnected() || saxoStore.isMockMode()) {
    logger.warn("[price-context-service] Saxo not connected or in mock mode — skipping price context fetch");
    return result;
  }

  const token = saxoStore.getAccessToken()!;
  const env = saxoStore.getEnvironment();
  const baseUrl = saxoBaseUrl(env);
  const asOf = new Date().toISOString();

  // Deduplicate by symbol (case-insensitive) and skip already-fresh entries
  const seen = new Set<string>();
  const toFetch: PriceContextTarget[] = [];

  for (const t of targets) {
    const key = t.symbol.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // Skip if already fresh — avoid duplicate Saxo history requests
    const existing = analysisRepository.get<PriceContext>(priceContextKey(key));
    if (existing && isPriceContextFresh(existing.result)) {
      const ageMin = Math.round((Date.now() - new Date(existing.result.asOf).getTime()) / 60_000);
      logger.debug(
        { symbol: key, ageMin },
        "[price-context-service] Skipping — Price Context already fresh"
      );
      result.set(key, existing.result);
      continue;
    }

    toFetch.push({ ...t, symbol: key });
  }

  if (toFetch.length === 0) {
    logger.info("[price-context-service] All targets already have fresh Price Context — no Saxo requests needed");
    return result;
  }

  logger.info(
    { fetchCount: toFetch.length, skippedFresh: targets.length - toFetch.length },
    "[price-context-service] Fetching Price Context for new/stale targets"
  );

  // Fetch in parallel (Saxo chart API is read-only)
  await Promise.all(
    toFetch.map(async (target) => {
      try {
        // Resolve UIC + AssetType if not already provided (e.g. when called inline from a route)
        let uic = target.uic;
        let assetType = target.assetType;
        if (!uic || !assetType) {
          // Strip exchange suffix for Saxo search (e.g. "SERV:XNAS" → "SERV")
          const searchTicker = target.symbol.includes(":") ? target.symbol.split(":")[0] : target.symbol;
          const resolved = await resolveUicForTicker(searchTicker, token, baseUrl);
          if (!resolved) {
            logger.warn({ symbol: target.symbol }, "[price-context-service] UIC resolution failed — skipping");
            return;
          }
          uic = resolved.uic;
          assetType = resolved.assetType;
        }
        const bars = await fetchChartBars(uic, assetType, token, baseUrl);

        if (bars.length < 5) {
          logger.warn({ symbol: target.symbol, bars: bars.length }, "[price-context-service] Insufficient bars — skipping");
          return;
        }

        // Extract closes in chronological order (Saxo returns oldest first)
        const closes = bars
          .filter((b) => typeof b.Close === "number" && b.Close > 0)
          .map((b) => b.Close);

        if (closes.length < 5) {
          logger.warn({ symbol: target.symbol }, "[price-context-service] Too few valid close prices — skipping");
          return;
        }

        const ctx = calculatePriceContext(target.symbol, closes, asOf);

        // Persist to repository
        analysisRepository.save(priceContextKey(target.symbol), ctx);
        result.set(target.symbol, ctx);

        logger.info(
          { symbol: target.symbol, bars: closes.length, priceState: ctx.priceState, trend: ctx.trend.shortTermTrend },
          "[price-context-service] PriceContext stored"
        );
      } catch (err) {
        // Never let one symbol failure block others
        logger.warn({ err, symbol: target.symbol }, "[price-context-service] Failed to fetch chart — continuing");
      }
    })
  );

  return result;
}

// ── Price History fetch + cache ───────────────────────────────────────────────

/**
 * Fetch 30 daily close prices for a ticker from Saxo and cache them in the
 * repository as "price-history:<TICKER>".
 *
 * Shared across all modules — if the entry is already fresh (< 4 h old) the
 * cached version is returned immediately without a Saxo API call.
 *
 * Returns null when:
 *  - Saxo is not connected / is in mock mode
 *  - UIC resolution fails
 *  - Saxo chart fetch fails
 */
export async function fetchAndStorePriceHistory(
  ticker: string
): Promise<PriceHistoryEntry | null> {
  const symbol = ticker.toUpperCase();
  const key = priceHistoryKey(symbol);

  // Return cached fresh entry immediately
  const cached = analysisRepository.get<PriceHistoryEntry>(key);
  if (cached && isPriceHistoryFresh(cached.result)) {
    return cached.result;
  }

  // Require a live Saxo connection — never invent data
  if (!saxoStore.isConnected() || saxoStore.isMockMode()) {
    logger.warn({ symbol }, "[price-history] Saxo not connected — skipping");
    return null;
  }

  const token = saxoStore.getAccessToken()!;
  const env = saxoStore.getEnvironment();
  const baseUrl = saxoBaseUrl(env);

  // Strip exchange suffix for Saxo instrument search (e.g. "SERV:XNAS" → "SERV")
  const searchTicker = symbol.includes(":") ? symbol.split(":")[0] : symbol;

  const resolved = await resolveUicForTicker(searchTicker, token, baseUrl);
  if (!resolved) {
    logger.warn({ symbol }, "[price-history] UIC resolution failed — skipping");
    return null;
  }

  try {
    const bars = await fetchChartBars(resolved.uic, resolved.assetType, token, baseUrl, 32);

    const validBars: PriceHistoryBar[] = bars
      .filter((b) => typeof b.Close === "number" && b.Close > 0)
      .slice(-30)  // last 30 trading days
      .map((b) => ({
        // Saxo Time format: "2025-01-15T00:00:00.000000Z" — keep date part only
        date: b.Time.slice(0, 10),
        close: b.Close,
      }));

    if (validBars.length < 3) {
      logger.warn({ symbol, bars: validBars.length }, "[price-history] Too few bars — skipping");
      return null;
    }

    const entry: PriceHistoryEntry = {
      ticker: symbol,
      bars: validBars,
      fetchedAt: new Date().toISOString(),
    };

    analysisRepository.save(key, entry);

    logger.info({ symbol, bars: validBars.length }, "[price-history] Stored price history");
    return entry;
  } catch (err) {
    logger.warn({ err, symbol }, "[price-history] Chart fetch failed");
    return null;
  }
}

// ── Target extraction ─────────────────────────────────────────────────────────

/**
 * Build a UIC cache from portfolio positions (free — no Saxo API calls).
 * Keys are uppercase symbols.
 */
export function buildUicCacheFromPortfolio(): Map<string, PriceContextTarget> {
  const cache = new Map<string, PriceContextTarget>();
  const entry = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  if (!entry) return cache;

  const accounts = Array.isArray(entry.result.accounts)
    ? (entry.result.accounts as Array<Record<string, unknown>>)
    : [];

  for (const account of accounts) {
    const positions = Array.isArray(account.positions)
      ? (account.positions as Array<Record<string, unknown>>)
      : [];

    for (const pos of positions) {
      const symbol = String(pos.symbol ?? "").toUpperCase();
      const uic = typeof pos.uic === "number" ? pos.uic : null;
      const assetType = String(pos.assetType ?? "Stock");
      if (!symbol || !uic || cache.has(symbol)) continue;
      cache.set(symbol, { symbol, uic, assetType });
    }
  }

  return cache;
}

/**
 * Extract PriceContextTargets from the portfolio snapshot stored in the repository.
 * This is the primary source of UIC data — portfolio positions always have UIC.
 */
export function extractTargetsFromPortfolio(): PriceContextTarget[] {
  return Array.from(buildUicCacheFromPortfolio().values());
}

/**
 * Extract PriceContextTargets from stored Company Monitor entries.
 *
 * Uses the provided UIC cache (from portfolio) to avoid redundant Saxo lookups.
 * For CM companies not in the portfolio, calls Saxo ref/v1/instruments to resolve UIC.
 * Skips any symbol for which a UIC cannot be safely determined.
 *
 * @param uicCache  Pre-built UIC cache from portfolio positions (no Saxo calls needed for these)
 * @returns Array of targets for CM companies not already in the cache
 */
export async function extractTargetsFromCompanyMonitor(
  uicCache: Map<string, PriceContextTarget>
): Promise<PriceContextTarget[]> {
  // Only runs when Saxo is connected (for the instrument search fallback)
  if (!saxoStore.isConnected() || saxoStore.isMockMode()) return [];

  const token = saxoStore.getAccessToken()!;
  const baseUrl = saxoBaseUrl(saxoStore.getEnvironment());

  const cmEntries = analysisRepository.getAll().filter((e) =>
    e.moduleName.startsWith("company-monitor:")
  );

  if (cmEntries.length === 0) return [];

  const newTargets: PriceContextTarget[] = [];

  await Promise.all(
    cmEntries.map(async (entry) => {
      const result = entry.result as Record<string, unknown>;
      const companyInfo = result.company as Record<string, unknown> | undefined;
      const ticker = String(companyInfo?.ticker ?? "").toUpperCase().trim();
      if (!ticker) return;

      // Already known from portfolio → use cached UIC, no Saxo call needed
      if (uicCache.has(ticker)) return; // portfolio target already covers this

      // Check if this symbol already has fresh Price Context — skip resolution if so
      const existing = analysisRepository.get<PriceContext>(priceContextKey(ticker));
      if (existing && isPriceContextFresh(existing.result)) return;

      // Resolve UIC via Saxo instrument search
      const resolved = await resolveUicForTicker(ticker, token, baseUrl);
      if (!resolved) {
        logger.info(
          { ticker },
          "[price-context-service] Company Monitor: could not resolve UIC — skipping Price Context"
        );
        return;
      }

      newTargets.push({ symbol: ticker, uic: resolved.uic, assetType: resolved.assetType });
    })
  );

  return newTargets;
}

/**
 * Extract PriceContextTargets from the stored Opportunity Finder result.
 *
 * Uses the provided UIC cache (from portfolio) to avoid redundant Saxo lookups.
 * For OF candidates not in the portfolio, calls Saxo ref/v1/instruments to resolve UIC.
 * Skips any symbol for which a UIC cannot be safely determined.
 *
 * @param uicCache  Pre-built UIC cache from portfolio positions
 * @returns Array of targets for OF candidates not already in the cache
 */
export async function extractTargetsFromOpportunityFinder(
  uicCache: Map<string, PriceContextTarget>
): Promise<PriceContextTarget[]> {
  if (!saxoStore.isConnected() || saxoStore.isMockMode()) return [];

  const token = saxoStore.getAccessToken()!;
  const baseUrl = saxoBaseUrl(saxoStore.getEnvironment());

  const ofEntry = analysisRepository.get<Record<string, unknown>>("opportunity-finder");
  if (!ofEntry) return [];

  const opps = Array.isArray(ofEntry.result.topOpportunities)
    ? (ofEntry.result.topOpportunities as Array<Record<string, unknown>>)
    : [];

  if (opps.length === 0) return [];

  // Deduplicate within OF list
  const seenOF = new Set<string>();
  const newTargets: PriceContextTarget[] = [];

  await Promise.all(
    opps.map(async (opp) => {
      const ticker = String(opp.ticker ?? "").toUpperCase().trim();
      if (!ticker || seenOF.has(ticker)) return;
      seenOF.add(ticker);

      // Already known from portfolio
      if (uicCache.has(ticker)) return;

      // Check if already fresh
      const existing = analysisRepository.get<PriceContext>(priceContextKey(ticker));
      if (existing && isPriceContextFresh(existing.result)) return;

      // Resolve UIC via Saxo instrument search
      const resolved = await resolveUicForTicker(ticker, token, baseUrl);
      if (!resolved) {
        logger.info(
          { ticker },
          "[price-context-service] Opportunity Finder: could not resolve UIC — skipping Price Context"
        );
        return;
      }

      newTargets.push({ symbol: ticker, uic: resolved.uic, assetType: resolved.assetType });
    })
  );

  return newTargets;
}

/**
 * Collect all known Price Context targets for the start of a full cycle.
 *
 * Sources:
 *  1. Portfolio positions (UICs always available)
 *  2. Company Monitor tracked companies (UIC resolved via Saxo search)
 *  3. Opportunity Finder candidates from the PREVIOUS cycle (already stored in repo)
 *
 * Called at Stage 1.5. Opportunity Finder hasn't run yet this cycle, so only
 * previously stored OF results are available here — that is acceptable by design.
 */
export async function collectAllKnownTargets(): Promise<PriceContextTarget[]> {
  const portfolioTargets = extractTargetsFromPortfolio();
  const uicCache = buildUicCacheFromPortfolio();

  // Run CM and OF resolution in parallel
  const [cmTargets, ofTargets] = await Promise.all([
    extractTargetsFromCompanyMonitor(uicCache),
    extractTargetsFromOpportunityFinder(uicCache),
  ]);

  // Merge, deduplicating by symbol
  const merged = new Map<string, PriceContextTarget>();
  for (const t of [...portfolioTargets, ...cmTargets, ...ofTargets]) {
    if (!merged.has(t.symbol)) merged.set(t.symbol, t);
  }

  logger.info(
    {
      portfolio: portfolioTargets.length,
      companyMonitor: cmTargets.length,
      opportunityFinder: ofTargets.length,
      total: merged.size,
    },
    "[price-context-service] collectAllKnownTargets"
  );

  return Array.from(merged.values());
}

/**
 * Collect Price Context targets from the CURRENT cycle's Opportunity Finder results.
 *
 * Called at Stage 8.5 (after Opportunity Finder, before Trade Decision Engine).
 * Skips symbols that already have fresh Price Context.
 * Only fetches newly discovered candidates.
 */
export async function collectOpportunityFinderTargets(): Promise<PriceContextTarget[]> {
  const uicCache = buildUicCacheFromPortfolio();
  const ofTargets = await extractTargetsFromOpportunityFinder(uicCache);

  logger.info(
    { newCandidates: ofTargets.length },
    "[price-context-service] collectOpportunityFinderTargets (Stage 8.5)"
  );

  return ofTargets;
}

// ── Repository readers ────────────────────────────────────────────────────────

/**
 * Read a single PriceContext from the repository.
 *
 * Returns undefined if:
 *  - not found in repository
 *  - entry exists but is stale (older than PRICE_CONTEXT_MAX_AGE_MS)
 *
 * Stale data is NEVER returned to callers — AI modules must not receive
 * outdated Price Context as if it were current.
 */
export function getPriceContext(symbol: string): PriceContext | undefined {
  const entry = analysisRepository.get<PriceContext>(priceContextKey(symbol));
  if (!entry) return undefined;
  if (!isPriceContextFresh(entry.result)) {
    logger.debug(
      { symbol, asOf: entry.result.asOf },
      "[price-context-service] getPriceContext: stale — omitting"
    );
    return undefined;
  }
  return entry.result;
}

/**
 * Read PriceContext entries for a list of symbols.
 * Returns a Record<symbol, formatted-string> ready for AI prompt injection.
 * Symbols with no stored or stale context are silently omitted.
 */
export function buildPriceContextBlock(symbols: string[]): Record<string, string> {
  const block: Record<string, string> = {};
  for (const sym of symbols) {
    const ctx = getPriceContext(sym);
    if (ctx) {
      block[sym.toUpperCase()] = formatPriceContextForPrompt(ctx);
    }
  }
  return block;
}

/**
 * Read all stored PriceContext entries from the repository.
 * Returns only FRESH entries as a Record<symbol, formatted-string>.
 * Stale entries are silently omitted — never presented to OpenAI as current.
 */
export function getAllPriceContexts(): Record<string, string> {
  const entries = analysisRepository.getAll().filter((e) =>
    e.moduleName.startsWith(PRICE_CONTEXT_KEY_PREFIX + ":")
  );
  const block: Record<string, string> = {};
  let staleCnt = 0;

  for (const entry of entries) {
    const symbol = entry.moduleName.replace(PRICE_CONTEXT_KEY_PREFIX + ":", "");
    const ctx = entry.result as PriceContext;
    if (!ctx?.symbol) continue;

    if (!isPriceContextFresh(ctx)) {
      staleCnt++;
      continue; // stale — never send to OpenAI as current
    }

    block[symbol] = formatPriceContextForPrompt(ctx);
  }

  if (staleCnt > 0) {
    logger.debug({ staleCnt }, "[price-context-service] getAllPriceContexts: omitted stale entries");
  }

  return block;
}
