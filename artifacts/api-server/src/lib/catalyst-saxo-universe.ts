/**
 * Saxo-Derived Universe Enrichment — Catalyst Intelligence (spec §2)
 *
 * Enriches the static seed universe with real Saxo UICs and validates
 * tradeable status via the Saxo ref/v1/instruments API.
 *
 * IMPORTANT LIMITATION (reported per spec §2):
 * The Saxo ref/v1/instruments API supports only per-ticker keyword search
 * (via ?Keywords=<ticker>). Bulk listing by exchange is NOT available
 * in the current Saxo integration. This means:
 *
 *   - We can validate and enrich the static seed tickers with Saxo UICs.
 *   - We CANNOT discover new tickers directly from Saxo.
 *   - True universe expansion requires a separate data vendor:
 *       e.g. STOXX index constituent feed, FactSet, Bloomberg membership list.
 *   - To add new tickers to the universe, append them to the STATIC_SEED
 *     in catalyst-universe.ts.
 *
 * When Saxo is not connected (no token), this module returns the raw static
 * seed and reports saxoAvailable = false.
 *
 * Cache TTL: 24 hours.
 */

import { analysisRepository } from "./analysis-repository.js";
import { saxoStore } from "./saxo-store.js";
import type { EquityUniverseEntry } from "./catalyst-types.js";

const SAXO_CACHE_KEY = "catalyst-universe:saxo-cache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── Local Saxo types ──────────────────────────────────────────────────────────

interface SaxoInstrument {
  Identifier?: number;
  AssetType?: string;
  Symbol?: string;
  Description?: string;
}

interface SaxoInstrumentSearchResponse {
  Data?: SaxoInstrument[];
}

// ── Cache record ──────────────────────────────────────────────────────────────

export interface SaxoUniverseCache {
  enrichedAt: string;
  entries: EquityUniverseEntry[];
  missingTickers: string[];
  saxoAvailable: boolean;
  /**
   * Human-readable explanation of the current universe source and any gaps.
   * Always populated — use this for the §13 final report.
   */
  limitation: string;
}

// ── Shared limitation message ─────────────────────────────────────────────────

const LIMITATION_TEXT =
  "The Saxo ref/v1/instruments API supports per-ticker keyword lookup only. " +
  "Bulk listing by exchange is not available. The production universe is the " +
  "static seed (catalyst-universe.ts) enriched with Saxo UICs where resolvable. " +
  "To expand the universe, add tickers to DANISH_SEED or US_SEED. True exchange-" +
  "wide discovery would require a separate data vendor (STOXX, FactSet, Bloomberg).";

// ── Cache helpers ─────────────────────────────────────────────────────────────

function getCachedUniverse(): SaxoUniverseCache | null {
  const entry = analysisRepository.get<SaxoUniverseCache>(SAXO_CACHE_KEY);
  if (!entry?.result) return null;
  const age = Date.now() - new Date(entry.result.enrichedAt).getTime();
  return age <= CACHE_TTL_MS ? entry.result : null;
}

function saveUniverseCache(cache: SaxoUniverseCache): void {
  analysisRepository.save(SAXO_CACHE_KEY, cache);
}

// ── Saxo API helpers ──────────────────────────────────────────────────────────

async function saxoGet<T>(url: string, token: string): Promise<T> {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Saxo API ${resp.status}`);
  return resp.json() as Promise<T>;
}

function saxoBaseUrl(): string {
  const env = saxoStore.getEnvironment();
  return env === "live"
    ? "https://gateway.saxobank.com/openapi"
    : "https://gateway.saxobank.com/sim/openapi";
}

async function resolveUic(
  ticker: string, token: string, baseUrl: string
): Promise<number | null> {
  try {
    const url =
      `${baseUrl}/ref/v1/instruments` +
      `?Keywords=${encodeURIComponent(ticker)}` +
      `&AssetTypes=Stock,Etf&IncludeNonTradable=false&$top=5`;
    const res = await saxoGet<SaxoInstrumentSearchResponse>(url, token);
    const instruments = res.Data ?? [];
    if (instruments.length === 0) return null;
    const exact = instruments.find(i => i.Symbol?.toUpperCase() === ticker.toUpperCase());
    const chosen = exact ?? instruments[0];
    return chosen.Identifier ?? null;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enrich static seed entries with Saxo UICs.
 * Results are cached for 24h. Non-blocking — falls back to raw seed on Saxo failure.
 *
 * @param seedEntries  The static seed entries from catalyst-universe.ts.
 */
export async function enrichUniverseWithSaxo(
  seedEntries: EquityUniverseEntry[]
): Promise<SaxoUniverseCache> {
  const cached = getCachedUniverse();
  if (cached) return cached;

  if (!saxoStore.isConnected() || saxoStore.isMockMode()) {
    const result: SaxoUniverseCache = {
      enrichedAt: new Date().toISOString(),
      entries: seedEntries,
      missingTickers: [],
      saxoAvailable: false,
      limitation: `Saxo not connected. ${LIMITATION_TEXT}`,
    };
    saveUniverseCache(result);
    return result;
  }

  const token = saxoStore.getAccessToken()!;
  const baseUrl = saxoBaseUrl();

  const enriched: EquityUniverseEntry[] = [];
  const missing: string[] = [];

  // Process in batches of 5 to avoid Saxo rate limits
  const BATCH = 5;
  for (let i = 0; i < seedEntries.length; i += BATCH) {
    const batch = seedEntries.slice(i, i + BATCH);
    const resolved = await Promise.allSettled(
      batch.map(async entry => {
        if (entry.uic !== null) return entry;
        const uic = await resolveUic(entry.ticker, token, baseUrl);
        if (!uic) {
          missing.push(entry.ticker);
          return entry;
        }
        return { ...entry, uic, source: "SAXO_DISCOVERY" as const };
      })
    );
    for (const r of resolved) {
      enriched.push(r.status === "fulfilled" ? r.value : batch[resolved.indexOf(r)]);
    }
    // Small delay to respect rate limits
    if (i + BATCH < seedEntries.length) {
      await new Promise(res => setTimeout(res, 200));
    }
  }

  const result: SaxoUniverseCache = {
    enrichedAt: new Date().toISOString(),
    entries: enriched,
    missingTickers: missing,
    saxoAvailable: true,
    limitation: LIMITATION_TEXT,
  };
  saveUniverseCache(result);
  return result;
}

/**
 * Get the current Saxo universe enrichment status (for §13 final report).
 * Never triggers a new enrichment run — only reads cached state.
 */
export function getSaxoUniverseStatus(): {
  cached: boolean;
  saxoAvailable: boolean;
  totalEntries: number;
  enrichedWithUic: number;
  missingTickers: string[];
  limitation: string;
  enrichedAt: string | null;
} {
  const cached = getCachedUniverse();
  if (!cached) {
    return {
      cached: false,
      saxoAvailable: false,
      totalEntries: 0,
      enrichedWithUic: 0,
      missingTickers: [],
      limitation: "Universe not yet enriched with Saxo data. Run a screen first.",
      enrichedAt: null,
    };
  }
  return {
    cached: true,
    saxoAvailable: cached.saxoAvailable,
    totalEntries: cached.entries.length,
    enrichedWithUic: cached.entries.filter(e => e.uic !== null).length,
    missingTickers: cached.missingTickers,
    limitation: cached.limitation,
    enrichedAt: cached.enrichedAt,
  };
}

/** Invalidate the Saxo universe cache (e.g. after Saxo reconnects). */
export function invalidateSaxoCache(): void {
  analysisRepository.save(SAXO_CACHE_KEY, null as unknown as SaxoUniverseCache);
}
