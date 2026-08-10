/**
 * Price Context Service
 *
 * Fetches 90 days of daily OHLC from Saxo Bank (chart/v3/charts) for a set of
 * symbols, calculates deterministic PriceContext for each, and persists results
 * to the Analysis Repository under "price-context:<SYMBOL>".
 *
 * Callers must provide a UIC + AssetType for each symbol (available from the
 * portfolio snapshot). Symbols without a known UIC are skipped gracefully.
 *
 * Architecture:
 *   Automation Orchestrator → fetchAndStorePriceContexts()
 *     → Saxo chart/v3/charts (one request per symbol)
 *     → calculatePriceContext()
 *     → analysisRepository.save("price-context:<SYMBOL>", ...)
 *
 * AI modules read from repository only — they never call this service directly.
 *
 * Graceful degradation: if Saxo is unavailable, returns an empty result map
 * and logs a warning. AI modules continue without Price Context.
 */

import { analysisRepository } from "./analysis-repository.js";
import { saxoStore } from "./saxo-store.js";
import { logger } from "./logger.js";
import { calculatePriceContext, formatPriceContextForPrompt, type PriceContext } from "./price-context-calculator.js";

// ── Saxo response types ───────────────────────────────────────────────────────

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

// ── Repository key ────────────────────────────────────────────────────────────

export const PRICE_CONTEXT_KEY_PREFIX = "price-context";

export function priceContextKey(symbol: string): string {
  return `${PRICE_CONTEXT_KEY_PREFIX}:${symbol.toUpperCase()}`;
}

// ── Input descriptor ──────────────────────────────────────────────────────────

export interface PriceContextTarget {
  symbol: string;   // e.g. "NOVOb:xcse"
  uic: number;
  assetType: string; // e.g. "Stock"
}

// ── Saxo fetch ────────────────────────────────────────────────────────────────

function saxoBaseUrl(env: "sim" | "live"): string {
  return env === "live"
    ? "https://gateway.saxobank.com/openapi"
    : "https://gateway.saxobank.com/sim/openapi";
}

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

  // Deduplicate by symbol (case-insensitive)
  const seen = new Set<string>();
  const unique = targets.filter((t) => {
    const key = t.symbol.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Fetch all in parallel (Saxo chart API is read-only and lightweight)
  await Promise.all(
    unique.map(async (target) => {
      try {
        const bars = await fetchChartBars(target.uic, target.assetType, token, baseUrl);

        if (bars.length < 5) {
          logger.warn({ symbol: target.symbol, bars: bars.length }, "[price-context-service] Insufficient bars — skipping");
          return;
        }

        // Extract closes, chronological order (Saxo returns oldest first)
        const closes = bars
          .filter((b) => typeof b.Close === "number" && b.Close > 0)
          .map((b) => b.Close);

        if (closes.length < 5) {
          logger.warn({ symbol: target.symbol }, "[price-context-service] Too few valid close prices — skipping");
          return;
        }

        const ctx = calculatePriceContext(target.symbol.toUpperCase(), closes, asOf);

        // Persist to repository
        analysisRepository.save(priceContextKey(target.symbol), ctx);

        result.set(target.symbol.toUpperCase(), ctx);

        logger.info(
          { symbol: target.symbol, bars: closes.length, priceState: ctx.priceState, trend: ctx.trend.shortTermTrend },
          "[price-context-service] PriceContext stored"
        );
      } catch (err) {
        // Never let one symbol failure block others
        logger.warn({ err, symbol: target.symbol }, "[price-context-service] Failed to fetch chart for symbol — continuing");
      }
    })
  );

  return result;
}

// ── Repository readers ────────────────────────────────────────────────────────

/**
 * Read a single PriceContext from the repository.
 * Returns undefined if not found or stale.
 */
export function getPriceContext(symbol: string): PriceContext | undefined {
  const entry = analysisRepository.get<PriceContext>(priceContextKey(symbol));
  if (!entry) return undefined;
  return entry.result;
}

/**
 * Read PriceContext entries for a list of symbols.
 * Returns a Record<symbol, formatted-string> ready for AI prompt injection.
 * Symbols with no stored context are omitted (graceful degradation).
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
 * Returns a Record<symbol, formatted-string>.
 */
export function getAllPriceContexts(): Record<string, string> {
  const entries = analysisRepository.getAll().filter((e) =>
    e.moduleName.startsWith(PRICE_CONTEXT_KEY_PREFIX + ":")
  );
  const block: Record<string, string> = {};
  for (const entry of entries) {
    const symbol = entry.moduleName.replace(PRICE_CONTEXT_KEY_PREFIX + ":", "");
    const ctx = entry.result as PriceContext;
    if (ctx && ctx.symbol) {
      block[symbol] = formatPriceContextForPrompt(ctx);
    }
  }
  return block;
}

/**
 * Extract PriceContextTargets from the portfolio snapshot stored in the repository.
 * This is the primary source of UIC data — portfolio positions always have UIC.
 */
export function extractTargetsFromPortfolio(): PriceContextTarget[] {
  const entry = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  if (!entry) return [];

  const accounts = Array.isArray(entry.result.accounts)
    ? (entry.result.accounts as Array<Record<string, unknown>>)
    : [];

  const targets: PriceContextTarget[] = [];
  const seen = new Set<string>();

  for (const account of accounts) {
    const positions = Array.isArray(account.positions)
      ? (account.positions as Array<Record<string, unknown>>)
      : [];

    for (const pos of positions) {
      const symbol = String(pos.symbol ?? "").toUpperCase();
      const uic = typeof pos.uic === "number" ? pos.uic : null;
      const assetType = String(pos.assetType ?? "Stock");

      if (!symbol || !uic || seen.has(symbol)) continue;
      seen.add(symbol);

      targets.push({ symbol, uic, assetType });
    }
  }

  return targets;
}
