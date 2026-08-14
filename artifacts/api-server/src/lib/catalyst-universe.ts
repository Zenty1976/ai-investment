/**
 * Supported Market Universe — Catalyst Intelligence (spec §2)
 *
 * Provides a clean abstraction for the discoverable equity universe.
 * Zero AI calls. Zero Saxo calls. Purely data-driven.
 *
 * The universe enables PROACTIVE discovery of companies NOT yet in:
 *   - Portfolio
 *   - Opportunity Finder
 *   - Company Monitor
 *
 * Architecture:
 *   STATIC_SEED   → pre-defined Danish + US equities
 *   REPOSITORY_DISCOVERY → augments from existing CM/OF/Portfolio entries
 *
 * The universe does NOT trigger analysis for every company.
 * It is the SEARCHABLE list for event-driven candidate discovery.
 */

import { analysisRepository } from "./analysis-repository.js";
import type { EquityUniverseEntry } from "./catalyst-types.js";

// ── Static seeds ───────────────────────────────────────────────────────────────

/**
 * Core Danish equities — C25 index members and major Danish companies.
 * Tickers use Saxo conventions (exchange-qualified where needed).
 * DO NOT add company-specific logic here — this is only metadata.
 */
const DANISH_SEED: EquityUniverseEntry[] = [
  { ticker: "NOVO B",   company: "Novo Nordisk",             exchange: "CSE", country: "DK", currency: "DKK", sector: "Healthcare",    industry: "Pharmaceuticals",         uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "MAERSK B", company: "A.P. Møller-Mærsk",        exchange: "CSE", country: "DK", currency: "DKK", sector: "Industrials",   industry: "Marine Shipping",         uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "MAERSK A", company: "A.P. Møller-Mærsk A",      exchange: "CSE", country: "DK", currency: "DKK", sector: "Industrials",   industry: "Marine Shipping",         uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "DSV",      company: "DSV A/S",                  exchange: "CSE", country: "DK", currency: "DKK", sector: "Industrials",   industry: "Freight & Logistics",     uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "COLOB",    company: "Coloplast",                exchange: "CSE", country: "DK", currency: "DKK", sector: "Healthcare",    industry: "Medical Devices",         uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "TRYG",     company: "Tryg A/S",                 exchange: "CSE", country: "DK", currency: "DKK", sector: "Financials",   industry: "Insurance",               uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "ORSTED",   company: "Ørsted A/S",               exchange: "CSE", country: "DK", currency: "DKK", sector: "Utilities",    industry: "Renewable Energy",        uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "CARL B",   company: "Carlsberg",                exchange: "CSE", country: "DK", currency: "DKK", sector: "Cons. Staples", industry: "Beverages",              uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "VESTAS",   company: "Vestas Wind Systems",      exchange: "CSE", country: "DK", currency: "DKK", sector: "Industrials",   industry: "Wind Energy",             uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "GN",       company: "GN Store Nord",            exchange: "CSE", country: "DK", currency: "DKK", sector: "Technology",   industry: "Audio/Communication",     uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "NETCB",    company: "Netcompany",               exchange: "CSE", country: "DK", currency: "DKK", sector: "Technology",   industry: "IT Services",             uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "BAVA",     company: "Bavarian Nordic",          exchange: "CSE", country: "DK", currency: "DKK", sector: "Healthcare",    industry: "Biotechnology",           uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "DANSKE",   company: "Danske Bank",              exchange: "CSE", country: "DK", currency: "DKK", sector: "Financials",   industry: "Banks",                   uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "NZYME",    company: "Novozymes",                exchange: "CSE", country: "DK", currency: "DKK", sector: "Materials",    industry: "Specialty Chemicals",     uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "AMBU",     company: "Ambu A/S",                 exchange: "CSE", country: "DK", currency: "DKK", sector: "Healthcare",    industry: "Medical Devices",         uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "DEMANT",   company: "Demant A/S",               exchange: "CSE", country: "DK", currency: "DKK", sector: "Healthcare",    industry: "Medical Devices",         uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "PNDORA",   company: "Pandora",                  exchange: "CSE", country: "DK", currency: "DKK", sector: "Cons. Disc.",  industry: "Jewelry",                 uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "ISS",      company: "ISS A/S",                  exchange: "CSE", country: "DK", currency: "DKK", sector: "Industrials",   industry: "Facilities Management",   uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "NSIS B",   company: "NKT A/S",                  exchange: "CSE", country: "DK", currency: "DKK", sector: "Industrials",   industry: "Electrical Equipment",    uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "SIM",      company: "Simcorp A/S",              exchange: "CSE", country: "DK", currency: "DKK", sector: "Technology",   industry: "Financial Software",      uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "JYSK",     company: "Jyske Bank",               exchange: "CSE", country: "DK", currency: "DKK", sector: "Financials",   industry: "Banks",                   uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "SYDB",     company: "Sydbank",                  exchange: "CSE", country: "DK", currency: "DKK", sector: "Financials",   industry: "Banks",                   uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "TOPDK",    company: "Topdanmark",               exchange: "CSE", country: "DK", currency: "DKK", sector: "Financials",   industry: "Insurance",               uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "RBREW",    company: "Royal Unibrew",            exchange: "CSE", country: "DK", currency: "DKK", sector: "Cons. Staples", industry: "Beverages",              uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
  { ticker: "HRLJB",    company: "H. Lundbeck",              exchange: "CSE", country: "DK", currency: "DKK", sector: "Healthcare",    industry: "Pharmaceuticals",         uic: null, tradeable: true,  active: true, source: "STATIC_SEED" },
];

/**
 * Core US equities — S&P 500 leaders and high-catalyst-frequency companies.
 * Selected for event frequency (earnings, investor days, product launches).
 */
const US_SEED: EquityUniverseEntry[] = [
  // Technology
  { ticker: "AAPL",  company: "Apple Inc.",             exchange: "NASDAQ", country: "US", currency: "USD", sector: "Technology",   industry: "Consumer Electronics",    uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "MSFT",  company: "Microsoft Corporation",  exchange: "NASDAQ", country: "US", currency: "USD", sector: "Technology",   industry: "Software",                uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "NVDA",  company: "NVIDIA Corporation",     exchange: "NASDAQ", country: "US", currency: "USD", sector: "Technology",   industry: "Semiconductors",          uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "GOOGL", company: "Alphabet Inc.",          exchange: "NASDAQ", country: "US", currency: "USD", sector: "Technology",   industry: "Internet Services",       uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "META",  company: "Meta Platforms",         exchange: "NASDAQ", country: "US", currency: "USD", sector: "Technology",   industry: "Social Media",            uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "AMZN",  company: "Amazon.com Inc.",        exchange: "NASDAQ", country: "US", currency: "USD", sector: "Cons. Disc.",  industry: "E-Commerce / Cloud",      uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "TSLA",  company: "Tesla Inc.",             exchange: "NASDAQ", country: "US", currency: "USD", sector: "Cons. Disc.",  industry: "Electric Vehicles",       uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "AMD",   company: "Advanced Micro Devices", exchange: "NASDAQ", country: "US", currency: "USD", sector: "Technology",   industry: "Semiconductors",          uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "INTC",  company: "Intel Corporation",     exchange: "NASDAQ", country: "US", currency: "USD", sector: "Technology",   industry: "Semiconductors",          uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "CRM",   company: "Salesforce Inc.",        exchange: "NYSE",   country: "US", currency: "USD", sector: "Technology",   industry: "Enterprise Software",     uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "ADBE",  company: "Adobe Inc.",             exchange: "NASDAQ", country: "US", currency: "USD", sector: "Technology",   industry: "Software",                uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "ORCL",  company: "Oracle Corporation",    exchange: "NYSE",   country: "US", currency: "USD", sector: "Technology",   industry: "Enterprise Software",     uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "NOW",   company: "ServiceNow Inc.",        exchange: "NYSE",   country: "US", currency: "USD", sector: "Technology",   industry: "Enterprise Software",     uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  // Financials
  { ticker: "JPM",   company: "JPMorgan Chase",         exchange: "NYSE",   country: "US", currency: "USD", sector: "Financials",   industry: "Banks",                   uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "GS",    company: "Goldman Sachs",          exchange: "NYSE",   country: "US", currency: "USD", sector: "Financials",   industry: "Investment Banking",      uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "BRK.B", company: "Berkshire Hathaway",    exchange: "NYSE",   country: "US", currency: "USD", sector: "Financials",   industry: "Diversified",             uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  // Healthcare
  { ticker: "NVO",   company: "Novo Nordisk ADR",       exchange: "NYSE",   country: "DK", currency: "USD", sector: "Healthcare",   industry: "Pharmaceuticals",         uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "LLY",   company: "Eli Lilly and Company",  exchange: "NYSE",   country: "US", currency: "USD", sector: "Healthcare",   industry: "Pharmaceuticals",         uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "JNJ",   company: "Johnson & Johnson",      exchange: "NYSE",   country: "US", currency: "USD", sector: "Healthcare",   industry: "Diversified Healthcare",  uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "UNH",   company: "UnitedHealth Group",     exchange: "NYSE",   country: "US", currency: "USD", sector: "Healthcare",   industry: "Health Insurance",        uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  // Industrials
  { ticker: "CAT",   company: "Caterpillar Inc.",       exchange: "NYSE",   country: "US", currency: "USD", sector: "Industrials",  industry: "Heavy Machinery",         uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "BA",    company: "Boeing Company",         exchange: "NYSE",   country: "US", currency: "USD", sector: "Industrials",  industry: "Aerospace & Defense",     uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  // Consumer
  { ticker: "DIS",   company: "Walt Disney Company",    exchange: "NYSE",   country: "US", currency: "USD", sector: "Cons. Disc.", industry: "Entertainment",            uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "SBUX",  company: "Starbucks Corporation",  exchange: "NASDAQ", country: "US", currency: "USD", sector: "Cons. Disc.", industry: "Restaurants",             uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  // Energy
  { ticker: "XOM",   company: "Exxon Mobil",            exchange: "NYSE",   country: "US", currency: "USD", sector: "Energy",       industry: "Oil & Gas",               uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  // Asia / other
  { ticker: "0700",  company: "Tencent Holdings",       exchange: "HK",     country: "CN", currency: "HKD", sector: "Technology",  industry: "Internet Services",        uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "BABA",  company: "Alibaba Group",          exchange: "NYSE",   country: "CN", currency: "USD", sector: "Technology",  industry: "E-Commerce",               uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
  { ticker: "TSM",   company: "Taiwan Semiconductor",   exchange: "NYSE",   country: "TW", currency: "USD", sector: "Technology",  industry: "Semiconductors",           uic: null, tradeable: true, active: true, source: "STATIC_SEED" },
];

// ── In-memory universe cache ───────────────────────────────────────────────────

let _universeCache: Map<string, EquityUniverseEntry> | null = null;

function buildUniverseMap(): Map<string, EquityUniverseEntry> {
  const map = new Map<string, EquityUniverseEntry>();

  // 1. Static seeds
  for (const e of [...DANISH_SEED, ...US_SEED]) {
    map.set(e.ticker.toUpperCase(), e);
  }

  // 2. Dynamic augmentation from existing repository entries
  const allEntries = analysisRepository.getAll();
  for (const entry of allEntries) {
    if (entry.moduleName.startsWith("company-monitor:")) {
      const ticker = entry.moduleName.replace("company-monitor:", "").toUpperCase();
      if (map.has(ticker)) continue; // seed takes priority

      const r = entry.result as Record<string, unknown> | undefined;
      const comp = r?.company as Record<string, unknown> | undefined;
      map.set(ticker, {
        ticker,
        company: String(comp?.name ?? r?.companyName ?? ticker),
        exchange: String(comp?.exchange ?? ""),
        country:  String(comp?.country ?? ""),
        currency: String(comp?.currency ?? ""),
        sector:   String(comp?.sector ?? "") || null,
        industry: String(comp?.industry ?? "") || null,
        uic: null,
        tradeable: true,
        active: true,
        source: "REPOSITORY_DISCOVERY",
      });
    }
  }

  return map;
}

function getUniverseMap(): Map<string, EquityUniverseEntry> {
  if (!_universeCache) {
    _universeCache = buildUniverseMap();
  }
  return _universeCache;
}

/** Invalidate the cache (call after new CM entries are added). */
export function invalidateUniverseCache(): void {
  _universeCache = null;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Look up a ticker in the supported universe. Returns undefined if not found. */
export function getUniverseEntry(ticker: string): EquityUniverseEntry | undefined {
  return getUniverseMap().get(ticker.toUpperCase());
}

/** Get all entries in the supported universe. */
export function getAllUniverseEntries(): EquityUniverseEntry[] {
  return [...getUniverseMap().values()];
}

/** Get all Danish equities from the universe. */
export function getDanishUniverseEntries(): EquityUniverseEntry[] {
  return getAllUniverseEntries().filter(e => e.country === "DK");
}

/** Get all US equities from the universe. */
export function getUsUniverseEntries(): EquityUniverseEntry[] {
  return getAllUniverseEntries().filter(e => e.country === "US");
}

/**
 * Collect all tickers that should be screened for catalyst opportunities.
 *
 * Combines (in order of priority):
 *   1. Portfolio holdings
 *   2. Opportunity Finder candidates
 *   3. Existing Company Monitor entries
 *   4. Static universe seed (for proactive discovery of NEW companies)
 *
 * Deduplicates. Excludes inactive tickers.
 */
export function collectAllScreenableTickers(): Array<{
  ticker: string;
  company: string;
  inPortfolio: boolean;
  inOpportunityFinder: boolean;
  inCompanyMonitor: boolean;
  inUniverseSeed: boolean;
}> {
  const result = new Map<string, {
    ticker: string; company: string;
    inPortfolio: boolean; inOpportunityFinder: boolean;
    inCompanyMonitor: boolean; inUniverseSeed: boolean;
  }>();

  const addOrUpdate = (
    ticker: string, company: string,
    flags: Partial<{ inPortfolio: boolean; inOpportunityFinder: boolean;
                     inCompanyMonitor: boolean; inUniverseSeed: boolean }>
  ) => {
    const key = ticker.toUpperCase();
    const existing = result.get(key);
    if (existing) {
      Object.assign(existing, flags);
    } else {
      result.set(key, {
        ticker: key, company,
        inPortfolio: false, inOpportunityFinder: false,
        inCompanyMonitor: false, inUniverseSeed: false,
        ...flags,
      });
    }
  };

  // Portfolio holdings
  const pmEntry = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  const positions = (pmEntry?.result as Record<string, unknown> | undefined)?.positions;
  if (Array.isArray(positions)) {
    for (const pos of positions) {
      const p = pos as Record<string, unknown>;
      const sym = String(p["symbol"] ?? "").trim().toUpperCase();
      const name = String(p["displayName"] ?? p["symbol"] ?? sym);
      if (sym) addOrUpdate(sym, name, { inPortfolio: true });
    }
  }

  // Opportunity Finder candidates
  const ofEntry = analysisRepository.get<Record<string, unknown>>("opportunity-finder");
  const candidates = (ofEntry?.result as Record<string, unknown> | undefined)?.topOpportunities;
  if (Array.isArray(candidates)) {
    for (const c of candidates) {
      const cObj = c as Record<string, unknown>;
      const sym = String(cObj["ticker"] ?? "").trim().toUpperCase();
      const name = String(cObj["company"] ?? sym);
      if (sym) addOrUpdate(sym, name, { inOpportunityFinder: true });
    }
  }

  // Existing Company Monitor entries
  const allEntries = analysisRepository.getAll();
  for (const entry of allEntries) {
    if (entry.moduleName.startsWith("company-monitor:")) {
      const sym = entry.moduleName.replace("company-monitor:", "").toUpperCase();
      const r = entry.result as Record<string, unknown> | undefined;
      const comp = r?.company as Record<string, unknown> | undefined;
      const name = String(comp?.name ?? r?.companyName ?? sym);
      if (sym) addOrUpdate(sym, name, { inCompanyMonitor: true });
    }
  }

  // Universe seed — for proactive discovery
  const universeMap = getUniverseMap();
  for (const [ticker, entry] of universeMap) {
    if (!entry.active) continue;
    addOrUpdate(ticker, entry.company, { inUniverseSeed: true });
  }

  return [...result.values()];
}

/** Get total universe size. */
export function getUniverseSize(): { danish: number; us: number; total: number } {
  const all = getAllUniverseEntries();
  return {
    danish: all.filter(e => e.country === "DK").length,
    us:     all.filter(e => e.country === "US").length,
    total:  all.length,
  };
}
