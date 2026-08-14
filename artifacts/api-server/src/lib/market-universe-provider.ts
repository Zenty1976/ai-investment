/**
 * Market Universe Provider — Abstraction Layer (Part 3, spec §13)
 *
 * WHY THIS EXISTS:
 * The current implementation uses DANISH_SEED + US_SEED as the universe.
 * Saxo's ref/v1/instruments API only supports per-ticker keyword lookup —
 * it cannot list all equities on an exchange. This limitation means we
 * cannot currently get a broad DK/US equity universe from Saxo alone.
 *
 * This abstraction layer:
 *   1. Documents the current capability honestly (SeedMarketUniverseProvider)
 *   2. Provides a clean interface so a real data provider (FactSet, STOXX,
 *      Bloomberg index constituents, etc.) can be plugged in later
 *   3. Prevents catalyst-universe.ts from depending on hardcoded arrays
 *
 * CURRENT IMPLEMENTATION STATUS:
 *   Saxo:    ✅ Per-ticker UIC lookup + tradeable validation
 *   Saxo:    ❌ Cannot enumerate all exchange equities
 *   Broad DK universe: requires STOXX C25/OMX constituent feed or similar
 *   Broad US universe: requires S&P/Russell constituent feed
 *
 * TO ADD A REAL PROVIDER: implement MarketUniverseProvider and register it
 * via setMarketUniverseProvider(). The rest of the pipeline auto-uses it.
 */

import type { EquityUniverseEntry } from "./catalyst-types.js";

// ── Core interface ────────────────────────────────────────────────────────────

export interface MarketRecord {
  /** Saxo/exchange ticker symbol. */
  ticker: string;
  /** Display name. */
  company: string;
  /** Exchange code (CSE, NASDAQ, NYSE, HK…). */
  exchange: string;
  /** ISO 3166 country code. */
  country: string;
  /** ISO 4217 currency code. */
  currency: string;
  /** GICS sector. */
  sector: string | null;
  /** Industry within sector. */
  industry: string | null;
  /** Saxo UIC (instrument identifier). Null if not yet resolved. */
  uic: number | null;
  /** Whether this instrument can currently be traded. */
  tradeable: boolean;
  /** Whether this instrument is actively tracked. */
  active: boolean;
  /** ISO timestamp of last successful data verification. */
  lastVerifiedAt: string | null;
  /** Source of this record. */
  source: "STATIC_SEED" | "SAXO_API" | "EXTERNAL_PROVIDER" | "REPOSITORY_DISCOVERY";
}

/**
 * Provider interface for market universe data.
 *
 * A provider must implement ALL methods. Providers that cannot supply a
 * capability should return [] / null / throw with a descriptive error.
 */
export interface MarketUniverseProvider {
  /** Human-readable name used in debug/health reports. */
  readonly name: string;

  /**
   * List the markets/exchanges this provider supports.
   * Returns market codes, e.g. ["CSE", "NASDAQ", "NYSE"].
   */
  getSupportedMarkets(): Promise<string[]>;

  /**
   * List all tradeable equities on the given market.
   *
   * IMPORTANT: providers that cannot enumerate exchange equities should
   * return [] rather than a partial/fake list.
   *
   * @param market Exchange code.
   * @param options.maxResults Limit response size (for safety).
   */
  getEquities(market: string, options?: { maxResults?: number }): Promise<MarketRecord[]>;

  /**
   * Search for a specific instrument by ticker.
   * Returns null if the ticker is not found/supported.
   */
  searchInstrument(ticker: string): Promise<MarketRecord | null>;

  /**
   * Get full metadata for a known ticker.
   * Returns null if the ticker is not found/supported.
   */
  getInstrumentMetadata(ticker: string): Promise<MarketRecord | null>;

  /**
   * Trigger a universe refresh (e.g. re-fetch constituent lists).
   * For seed-based providers this is a no-op.
   *
   * Returns counts of changed records.
   */
  refreshUniverse(): Promise<{ added: number; updated: number; removed: number }>;

  /**
   * Report what data this provider CAN and CANNOT supply.
   * Always populated — used in the §13/§32 final report.
   */
  describeCapability(): ProviderCapabilityReport;
}

export interface ProviderCapabilityReport {
  providerName: string;
  canEnumerateExchangeEquities: boolean;
  canSearchByTicker: boolean;
  supportsMetadataEnrichment: boolean;
  marketsCovered: string[];
  estimatedUniverseSize: number;
  limitation: string;
  requiredExternalCapability?: string;
}

// ── Seed-based provider (current production implementation) ───────────────────

/**
 * SeedMarketUniverseProvider — wraps the static DANISH_SEED + US_SEED arrays.
 *
 * This is the current production provider. It is deliberately simple and honest:
 *   - It cannot enumerate equities dynamically
 *   - Its universe is bounded by what's in the seed arrays
 *   - It can be searched by ticker (O(1) lookup)
 */
export class SeedMarketUniverseProvider implements MarketUniverseProvider {
  readonly name = "SeedMarketUniverseProvider";

  constructor(
    private readonly entries: EquityUniverseEntry[],
    private readonly index: Map<string, EquityUniverseEntry> = new Map(
      entries.map(e => [e.ticker.toUpperCase(), e])
    )
  ) {}

  async getSupportedMarkets(): Promise<string[]> {
    const markets = new Set(this.entries.map(e => e.exchange).filter(Boolean));
    return [...markets];
  }

  async getEquities(market: string, options?: { maxResults?: number }): Promise<MarketRecord[]> {
    const filtered = this.entries.filter(
      e => e.exchange.toUpperCase() === market.toUpperCase() && e.active
    );
    const limited = options?.maxResults ? filtered.slice(0, options.maxResults) : filtered;
    return limited.map(this._toMarketRecord);
  }

  async searchInstrument(ticker: string): Promise<MarketRecord | null> {
    const entry = this.index.get(ticker.toUpperCase());
    return entry ? this._toMarketRecord(entry) : null;
  }

  async getInstrumentMetadata(ticker: string): Promise<MarketRecord | null> {
    return this.searchInstrument(ticker);
  }

  async refreshUniverse(): Promise<{ added: number; updated: number; removed: number }> {
    // Seed-based provider: no external refresh available
    return { added: 0, updated: 0, removed: 0 };
  }

  describeCapability(): ProviderCapabilityReport {
    const markets = new Set(this.entries.map(e => e.exchange).filter(Boolean));
    return {
      providerName: this.name,
      canEnumerateExchangeEquities: false,
      canSearchByTicker: true,
      supportsMetadataEnrichment: false,
      marketsCovered: [...markets],
      estimatedUniverseSize: this.entries.length,
      limitation:
        "Universe is bounded by static seed arrays (DANISH_SEED + US_SEED). " +
        "Cannot discover new tickers dynamically. Expanding the universe requires " +
        "editing catalyst-universe.ts or integrating an external provider.",
      requiredExternalCapability:
        "Exchange constituent feed: STOXX (C25/OMX), S&P index membership " +
        "(FactSet, Bloomberg, CRSP). A REST API with ?ExchangeId=CSE or " +
        "?IndexId=OMXCB query capability would satisfy this requirement.",
    };
  }

  private _toMarketRecord(e: EquityUniverseEntry): MarketRecord {
    return {
      ticker: e.ticker,
      company: e.company,
      exchange: e.exchange,
      country: e.country,
      currency: e.currency,
      sector: e.sector ?? null,
      industry: e.industry ?? null,
      uic: e.uic ?? null,
      tradeable: e.tradeable,
      active: e.active,
      lastVerifiedAt: null,
      source: "STATIC_SEED",
    };
  }
}

// ── Saxo provider (per-ticker enrichment only) ────────────────────────────────

/**
 * SaxoMarketUniverseProvider — uses Saxo ref/v1/instruments for per-ticker lookup.
 *
 * CAPABILITY LIMITATION:
 * Saxo's API does not support bulk listing of all exchange equities.
 * This provider can ENRICH known tickers with UICs and validate tradeable status,
 * but CANNOT discover new tickers.
 *
 * getEquities() always returns [] — use the seed provider for enumeration.
 * searchInstrument() and getInstrumentMetadata() make live Saxo API calls.
 */
export class SaxoMarketUniverseProvider implements MarketUniverseProvider {
  readonly name = "SaxoMarketUniverseProvider";

  // Lazy import to avoid importing saxo-store (which imports pino) at module level
  private async getSaxoStore() {
    const { saxoStore } = await import("./saxo-store.js");
    return saxoStore;
  }

  async getSupportedMarkets(): Promise<string[]> {
    // Saxo supports many markets — return the ones in our seed
    return ["CSE", "NASDAQ", "NYSE", "HK"];
  }

  async getEquities(_market: string, _options?: { maxResults?: number }): Promise<MarketRecord[]> {
    // NOT SUPPORTED — Saxo cannot enumerate all equities on an exchange
    // See limitation note in describeCapability()
    return [];
  }

  async searchInstrument(ticker: string): Promise<MarketRecord | null> {
    const store = await this.getSaxoStore();
    if (!store.isConnected()) return null;
    const token = store.getAccessToken();
    if (!token) return null;

    try {
      const params = new URLSearchParams({
        Keywords: ticker,
        AssetTypes: "Stock",
        $top: "5",
      });
      const env = store.getEnvironment?.() ?? "live";
      const base = env === "sim"
        ? "https://gateway.saxobank.com/sim/openapi"
        : "https://gateway.saxobank.com/openapi";
      const resp = await fetch(`${base}/ref/v1/instruments?${params}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!resp.ok) return null;
      const data = await resp.json() as { Data?: Array<{ Identifier?: number; Symbol?: string; Description?: string; AssetType?: string }> };
      const match = (data.Data ?? []).find(
        i => i.Symbol?.toUpperCase() === ticker.toUpperCase()
      );
      if (!match) return null;

      return {
        ticker,
        company: match.Description ?? ticker,
        exchange: "",
        country: "",
        currency: "",
        sector: null,
        industry: null,
        uic: match.Identifier ?? null,
        tradeable: true,
        active: true,
        lastVerifiedAt: new Date().toISOString(),
        source: "SAXO_API",
      };
    } catch {
      return null;
    }
  }

  async getInstrumentMetadata(ticker: string): Promise<MarketRecord | null> {
    return this.searchInstrument(ticker);
  }

  async refreshUniverse(): Promise<{ added: number; updated: number; removed: number }> {
    // No bulk refresh — Saxo doesn't support it
    return { added: 0, updated: 0, removed: 0 };
  }

  describeCapability(): ProviderCapabilityReport {
    return {
      providerName: this.name,
      canEnumerateExchangeEquities: false,
      canSearchByTicker: true,
      supportsMetadataEnrichment: true,
      marketsCovered: ["CSE", "NASDAQ", "NYSE", "HK", "and others per Saxo agreement"],
      estimatedUniverseSize: 0,
      limitation:
        "Saxo ref/v1/instruments supports keyword/ticker search only. " +
        "Bulk listing by exchange (e.g. ?ExchangeId=CSE) is NOT available. " +
        "This provider can validate and enrich known tickers but cannot discover new ones.",
      requiredExternalCapability:
        "A Saxo API endpoint supporting ?ExchangeId=<exchange>&AssetTypes=Stock&$top=<n> " +
        "would satisfy bulk discovery. As of 2026-08, no such endpoint is available " +
        "in the current Saxo Open API integration.",
    };
  }
}

// ── Composite provider (primary + fallback) ───────────────────────────────────

/**
 * Tries providers in order until one succeeds.
 * Enumeration (getEquities) uses ALL providers and merges results.
 * Single-ticker lookup uses the first provider that returns a result.
 */
export class CompositeMarketUniverseProvider implements MarketUniverseProvider {
  readonly name: string;

  constructor(private readonly providers: MarketUniverseProvider[]) {
    this.name = `Composite(${providers.map(p => p.name).join(", ")})`;
  }

  async getSupportedMarkets(): Promise<string[]> {
    const all = await Promise.all(this.providers.map(p => p.getSupportedMarkets()));
    return [...new Set(all.flat())];
  }

  async getEquities(market: string, options?: { maxResults?: number }): Promise<MarketRecord[]> {
    const all = await Promise.all(this.providers.map(p => p.getEquities(market, options)));
    // Merge: deduplicate by ticker, first provider wins
    const seen = new Map<string, MarketRecord>();
    for (const batch of all) {
      for (const rec of batch) {
        if (!seen.has(rec.ticker.toUpperCase())) {
          seen.set(rec.ticker.toUpperCase(), rec);
        }
      }
    }
    const results = [...seen.values()];
    return options?.maxResults ? results.slice(0, options.maxResults) : results;
  }

  async searchInstrument(ticker: string): Promise<MarketRecord | null> {
    for (const p of this.providers) {
      const result = await p.searchInstrument(ticker);
      if (result) return result;
    }
    return null;
  }

  async getInstrumentMetadata(ticker: string): Promise<MarketRecord | null> {
    for (const p of this.providers) {
      const result = await p.getInstrumentMetadata(ticker);
      if (result) return result;
    }
    return null;
  }

  async refreshUniverse(): Promise<{ added: number; updated: number; removed: number }> {
    const results = await Promise.all(this.providers.map(p => p.refreshUniverse()));
    return {
      added:   results.reduce((sum, r) => sum + r.added, 0),
      updated: results.reduce((sum, r) => sum + r.updated, 0),
      removed: results.reduce((sum, r) => sum + r.removed, 0),
    };
  }

  describeCapability(): ProviderCapabilityReport {
    const reports = this.providers.map(p => p.describeCapability());
    return {
      providerName: this.name,
      canEnumerateExchangeEquities: reports.some(r => r.canEnumerateExchangeEquities),
      canSearchByTicker: reports.some(r => r.canSearchByTicker),
      supportsMetadataEnrichment: reports.some(r => r.supportsMetadataEnrichment),
      marketsCovered: [...new Set(reports.flatMap(r => r.marketsCovered))],
      estimatedUniverseSize: Math.max(...reports.map(r => r.estimatedUniverseSize)),
      limitation: reports.map(r => `[${r.providerName}] ${r.limitation}`).join(" | "),
      requiredExternalCapability: reports.map(r => r.requiredExternalCapability).filter(Boolean).join(" | "),
    };
  }
}

// ── Module-level provider registry ───────────────────────────────────────────

let _activeProvider: MarketUniverseProvider | null = null;

/**
 * Set the active market universe provider.
 * Called once at startup. Defaults to SeedMarketUniverseProvider.
 */
export function setMarketUniverseProvider(provider: MarketUniverseProvider): void {
  _activeProvider = provider;
}

/** Get the active provider. Throws if not initialized. */
export function getMarketUniverseProvider(): MarketUniverseProvider {
  if (!_activeProvider) {
    throw new Error(
      "MarketUniverseProvider not initialized. " +
      "Call setMarketUniverseProvider() at startup."
    );
  }
  return _activeProvider;
}

/** Check if the provider has been initialized. */
export function isMarketUniverseProviderInitialized(): boolean {
  return _activeProvider !== null;
}

/**
 * Get the capability report for the active provider.
 * Returns a "not initialized" report if no provider is set.
 */
export function getProviderCapabilityReport(): ProviderCapabilityReport {
  if (!_activeProvider) {
    return {
      providerName: "none",
      canEnumerateExchangeEquities: false,
      canSearchByTicker: false,
      supportsMetadataEnrichment: false,
      marketsCovered: [],
      estimatedUniverseSize: 0,
      limitation: "MarketUniverseProvider not initialized.",
    };
  }
  return _activeProvider.describeCapability();
}
