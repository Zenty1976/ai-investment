/**
 * Data Provider Registry — Centralized provider management (spec §20).
 *
 * WHY THIS EXISTS:
 *   Prevent scattered if(Saxo)...else if(providerX)...else(web) logic
 *   throughout routes. A single place where each data domain resolves
 *   to a configured provider.
 *
 * DOMAINS:
 *   MarketUniverse   → MarketUniverseProvider (existing abstraction)
 *   Expectations     → ExpectationsDataProvider (new)
 *   (Future: EarningsCalendar, FinancialHistory can be added here)
 *
 * INITIALIZATION:
 *   Call initDataProviderRegistry() at startup after providers are known.
 *   Defaults to NullExpectationsProvider if not configured.
 */

import {
  NullExpectationsProvider,
  type ExpectationsDataProvider,
} from "./expectations-provider.js";
import {
  getMarketUniverseProvider,
  isMarketUniverseProviderInitialized,
} from "./market-universe-provider.js";
import {
  getCalendarCoveredTickerCount,
} from "./earnings-calendar-repository.js";
import {
  getConsensusCoveredTickerCount,
  getTotalSnapshotCount,
} from "./consensus-repository.js";
import { getAllUniverseStats } from "./market-universe-repository.js";
import type { DomainCoverageStatus } from "./data-provider-types.js";

// ── Registry state ─────────────────────────────────────────────────────────────

let _expectationsProvider: ExpectationsDataProvider = new NullExpectationsProvider();

// ── Registration ───────────────────────────────────────────────────────────────

/**
 * Register the expectations data provider.
 * Call once at startup. Replaces the NullExpectationsProvider default.
 */
export function registerExpectationsProvider(provider: ExpectationsDataProvider): void {
  _expectationsProvider = provider;
}

/**
 * Get the active expectations data provider.
 * Always returns a valid provider (NullExpectationsProvider if none registered).
 */
export function getExpectationsProvider(): ExpectationsDataProvider {
  return _expectationsProvider;
}

// ── Health report ──────────────────────────────────────────────────────────────

/**
 * Full data coverage health report (spec §25).
 * Used by the /api/data-coverage endpoint and the frontend debug page.
 */
export interface DataCoverageReport {
  generatedAt: string;

  marketUniverse: {
    dk: UniverseRegionStatus;
    us: UniverseRegionStatus;
    providerName: string;
    providerCanEnumerate: boolean;
    limitation: string;
  };

  earningsCalendar: {
    providerName: string;
    status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
    supportsBulkCalendar: boolean;
    coveredTickers: number;
    limitation: string;
  };

  expectations: {
    providerName: string;
    epsConsensus: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
    revenueConsensus: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
    estimateRevisions: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
    historicalSnapshots: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
    guidance: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
    consensusSnapshotCount: number;
    consensusCoveredTickers: number;
    limitation: string;
  };

  earningsHistory: {
    providerName: string;
    status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
    supportsActuals: boolean;
    supportsEstimates: boolean;
    limitation: string;
  };

  priceData: {
    providerName: "Saxo Bank";
    status: "AVAILABLE";
    historyDepthDays: 92;
    detail: string;
  };

  domains: DomainCoverageStatus[];

  /** Externally-required data gaps that need a paid provider (spec §21-22). */
  externalDataGaps: ExternalDataGap[];
}

export interface UniverseRegionStatus {
  provider: string;
  equityCount: number;
  lastRefresh: string;
  status: "FULL" | "SEED_ONLY";
  coverageWarning: string | null;
}

export interface ExternalDataGap {
  domain: string;
  priority: "REQUIRED" | "NICE_TO_HAVE" | "NOT_NEEDED";
  description: string;
  whyItMatters: string;
  /** The provider abstraction that would receive this data. */
  targetAbstraction: string;
  /** What any future provider must supply. */
  requirements: string;
}

function toStatus(supported: boolean): "AVAILABLE" | "UNAVAILABLE" {
  return supported ? "AVAILABLE" : "UNAVAILABLE";
}

/**
 * Build the complete data coverage report.
 */
export function buildDataCoverageReport(): DataCoverageReport {
  const now = new Date().toISOString();
  const allUniverseStats = getAllUniverseStats();
  const cseStats = allUniverseStats.find(s => s.exchange === "CSE") ?? {
    exchange: "CSE", count: 0, refreshedAt: "(never)", source: "STATIC_SEED" as const,
    isSeedOnly: true, coverageWarning: "No CSE data seeded.",
  };
  const nasdaqStats = allUniverseStats.find(s => s.exchange === "NASDAQ") ?? {
    exchange: "NASDAQ", count: 0, refreshedAt: "(never)", source: "STATIC_SEED" as const,
    isSeedOnly: true, coverageWarning: "No NASDAQ data seeded.",
  };

  const universeProv = isMarketUniverseProviderInitialized()
    ? getMarketUniverseProvider().describeCapability()
    : null;

  const expCap = _expectationsProvider.describeCapabilities();
  const calCap = _expectationsProvider.describeCalendarCapabilities();
  const hisCap = _expectationsProvider.describeHistoryCapabilities();

  const calendarTickers = getCalendarCoveredTickerCount();
  const consensusTickers = getConsensusCoveredTickerCount();
  const snapshotCount = getTotalSnapshotCount();

  const externalDataGaps: ExternalDataGap[] = [
    {
      domain: "Market Universe — Danish Equities",
      priority: "REQUIRED",
      description:
        "Cannot enumerate all CSE/OMX equities. Universe is 25 hardcoded tickers.",
      whyItMatters:
        "Catalyst Intelligence can only discover events for tickers in the universe. " +
        "With 25 tickers, ~90% of the Danish market is invisible to the pipeline.",
      targetAbstraction: "SaxoMarketUniverseProvider.getEquities() or new ExchangeConstituentProvider",
      requirements:
        "API that can list all tradeable equities on CSE/OMX by exchange filter. " +
        "Required fields: ticker, company, exchange, currency. " +
        "Candidates: STOXX constituent feed, OMX Nordic exchange data, Saxo API extension.",
    },
    {
      domain: "Market Universe — US Equities",
      priority: "REQUIRED",
      description:
        "Cannot enumerate all NYSE/NASDAQ equities. Universe is ~60 hardcoded tickers.",
      whyItMatters:
        "Same limitation as DK — only ~0.01% of US market is discoverable.",
      targetAbstraction: "SaxoMarketUniverseProvider.getEquities() or new ExchangeConstituentProvider",
      requirements:
        "API supporting NYSE/NASDAQ equity listing. " +
        "Candidates: S&P index constituents (FactSet), CRSP, Quandl, Financial Modeling Prep.",
    },
    {
      domain: "Earnings Calendar",
      priority: "REQUIRED",
      description:
        "No bulk earnings calendar. Current source: AI web search per ticker.",
      whyItMatters:
        "Catalyst Intelligence is event-driven. Knowing upcoming earnings for ALL universe " +
        "tickers without per-ticker AI calls is essential for scalable discovery.",
      targetAbstraction: "ExpectationsDataProvider.getUpcomingEarnings() / EarningsCalendarRepository",
      requirements:
        "Bulk earnings calendar covering DK + US equities. " +
        "Required fields: ticker, earningsDate, BMO/AMC timing, fiscalQuarter, confirmed/tentative. " +
        "Candidates: Alpha Vantage, Financial Modeling Prep, Refinitiv, FactSet.",
    },
    {
      domain: "EPS / Revenue Consensus",
      priority: "REQUIRED",
      description:
        "No analyst consensus data. ExpectationGap is always UNKNOWN.",
      whyItMatters:
        "The core pre-event thesis depends on the gap between real-world signals and " +
        "market expectations. Without consensus, we cannot assess whether anything is " +
        "priced in or whether estimates are moving. This significantly degrades analysis quality.",
      targetAbstraction: "ExpectationsDataProvider.getCurrentConsensus()",
      requirements:
        "EPS consensus, revenue consensus, number of estimates, high/low range. " +
        "Danish AND US coverage. Daily refresh. " +
        "Candidates: FactSet, Bloomberg, Refinitiv (LSEG), Alpha Vantage Premium.",
    },
    {
      domain: "Estimate Revisions",
      priority: "REQUIRED",
      description:
        "No estimate revision history. Cannot compute 7D/30D/60D/90D revision direction.",
      whyItMatters:
        "Rising estimates are one of the most powerful pre-event signals. " +
        "A company where 10 analysts all raised EPS estimates in the last 30 days is very " +
        "different from one with flat consensus.",
      targetAbstraction: "ConsensusRepository (existing) + ExpectationsDataProvider.getEstimateRevisions()",
      requirements:
        "Historical consensus snapshots (point-in-time capable). " +
        "At minimum: 90-day history of EPS/revenue consensus. " +
        "Same candidates as consensus above.",
    },
    {
      domain: "EPS / Revenue Actuals (Earnings History)",
      priority: "REQUIRED",
      description:
        "No historical earnings actuals. Cannot compute beat rate, surprise %, or guidance history.",
      whyItMatters:
        "Historical beat/miss patterns and stock reactions are strong context for " +
        "evaluating the current setup. A company that has beaten EPS 8 of the last 10 times " +
        "is treated differently from one that has missed 6 of 10.",
      targetAbstraction: "ExpectationsDataProvider.getEarningsHistory()",
      requirements:
        "EPS actual + estimate, revenue actual + estimate, guidance action per quarter. " +
        "Minimum 8 quarters. " +
        "Candidates: same as consensus (FactSet, Refinitiv, Alpha Vantage).",
    },
    {
      domain: "Company Guidance",
      priority: "NICE_TO_HAVE",
      description: "No structured company guidance data.",
      whyItMatters:
        "Management guidance vs consensus is a key expectation gap signal. " +
        "Currently handled partially via CM AI interpretation of web content.",
      targetAbstraction: "ExpectationsDataProvider.getCompanyGuidance()",
      requirements: "Guidance ranges per period, vs consensus comparison.",
    },
    {
      domain: "Financial Statements",
      priority: "NICE_TO_HAVE",
      description:
        "No structured quarterly P&L, balance sheet, or cash flow data.",
      whyItMatters:
        "Useful for trend analysis (margin expansion, FCF trajectory) but can be partially " +
        "substituted by strong CM + driver signals.",
      targetAbstraction: "Future FinancialHistoryProvider",
      requirements:
        "Quarterly: revenue, operating income, net income, EPS, gross margin, FCF, debt, cash.",
    },
    {
      domain: "Market Cap / Sector (structured)",
      priority: "NICE_TO_HAVE",
      description:
        "Sector/industry comes from static seed. No live structured metadata.",
      whyItMatters:
        "Sector context helps Catalyst Intelligence filter events appropriately.",
      targetAbstraction: "MarketUniverseRepository (existing) enriched via provider",
      requirements: "Market cap, GICS sector/industry per ticker.",
    },
  ];

  const domains: DomainCoverageStatus[] = [
    {
      domain: "Market Universe (DK)",
      providerName: universeProv?.providerName ?? "SeedMarketUniverseProvider",
      status: cseStats.isSeedOnly ? "PARTIAL" : "AVAILABLE",
      detail: cseStats.coverageWarning ?? `${cseStats.count} equities, last refreshed ${cseStats.refreshedAt}`,
      lastRefreshedAt: cseStats.refreshedAt === "(never)" ? null : cseStats.refreshedAt,
    },
    {
      domain: "Market Universe (US)",
      providerName: universeProv?.providerName ?? "SeedMarketUniverseProvider",
      status: nasdaqStats.isSeedOnly ? "PARTIAL" : "AVAILABLE",
      detail: nasdaqStats.coverageWarning ?? `${nasdaqStats.count} equities, last refreshed ${nasdaqStats.refreshedAt}`,
      lastRefreshedAt: nasdaqStats.refreshedAt === "(never)" ? null : nasdaqStats.refreshedAt,
    },
    {
      domain: "Earnings Calendar",
      providerName: calCap.providerName,
      status: calendarTickers > 0 ? "PARTIAL" : "UNAVAILABLE",
      detail: calendarTickers > 0
        ? `${calendarTickers} tickers have cached calendar entries (AI web search, per-ticker).`
        : "No bulk calendar. AI web search provides per-ticker dates only.",
      lastRefreshedAt: null,
    },
    {
      domain: "EPS Consensus",
      providerName: expCap.providerName,
      status: toStatus(expCap.supportsEpsConsensus),
      detail: expCap.supportsEpsConsensus ? "Available" : expCap.limitation,
      lastRefreshedAt: null,
    },
    {
      domain: "Revenue Consensus",
      providerName: expCap.providerName,
      status: toStatus(expCap.supportsRevenueConsensus),
      detail: expCap.supportsRevenueConsensus ? "Available" : expCap.limitation,
      lastRefreshedAt: null,
    },
    {
      domain: "Estimate Revisions",
      providerName: expCap.providerName,
      status: toStatus(expCap.supportsRevisionHistory),
      detail: expCap.supportsRevisionHistory
        ? `${snapshotCount} snapshots for ${consensusTickers} tickers`
        : expCap.limitation,
      lastRefreshedAt: null,
    },
    {
      domain: "Earnings History",
      providerName: hisCap.providerName,
      status: toStatus(hisCap.supportsEpsActuals),
      detail: hisCap.supportsEpsActuals ? "Available" : hisCap.limitation,
      lastRefreshedAt: null,
    },
    {
      domain: "Price History",
      providerName: "Saxo Bank",
      status: "AVAILABLE",
      detail: "~92 daily OHLC bars via Saxo chart API. 6h cache. Used for price context and earnings behavior.",
      lastRefreshedAt: null,
    },
  ];

  return {
    generatedAt: now,
    marketUniverse: {
      dk: {
        provider: universeProv?.providerName ?? "SeedMarketUniverseProvider",
        equityCount: cseStats.count,
        lastRefresh: cseStats.refreshedAt,
        status: cseStats.isSeedOnly ? "SEED_ONLY" : "FULL",
        coverageWarning: cseStats.coverageWarning,
      },
      us: {
        provider: universeProv?.providerName ?? "SeedMarketUniverseProvider",
        equityCount: nasdaqStats.count,
        lastRefresh: nasdaqStats.refreshedAt,
        status: nasdaqStats.isSeedOnly ? "SEED_ONLY" : "FULL",
        coverageWarning: nasdaqStats.coverageWarning,
      },
      providerName: universeProv?.providerName ?? "none",
      providerCanEnumerate: universeProv?.canEnumerateExchangeEquities ?? false,
      limitation: universeProv?.limitation ?? "Provider not initialized.",
    },
    earningsCalendar: {
      providerName: calCap.providerName,
      status: calCap.supportsBulkCalendar ? "AVAILABLE" : calendarTickers > 0 ? "PARTIAL" : "UNAVAILABLE",
      supportsBulkCalendar: calCap.supportsBulkCalendar,
      coveredTickers: calendarTickers,
      limitation: calCap.limitation,
    },
    expectations: {
      providerName: expCap.providerName,
      epsConsensus: toStatus(expCap.supportsEpsConsensus),
      revenueConsensus: toStatus(expCap.supportsRevenueConsensus),
      estimateRevisions: toStatus(expCap.supportsRevisionHistory),
      historicalSnapshots: toStatus(expCap.supportsHistoricalSnapshots),
      guidance: toStatus(expCap.supportsCompanyGuidance),
      consensusSnapshotCount: snapshotCount,
      consensusCoveredTickers: consensusTickers,
      limitation: expCap.limitation,
    },
    earningsHistory: {
      providerName: hisCap.providerName,
      status: toStatus(hisCap.supportsEpsActuals),
      supportsActuals: hisCap.supportsEpsActuals,
      supportsEstimates: hisCap.supportsEpsEstimates,
      limitation: hisCap.limitation,
    },
    priceData: {
      providerName: "Saxo Bank",
      status: "AVAILABLE",
      historyDepthDays: 92,
      detail:
        "Saxo chart API provides ~92 daily OHLC bars per ticker. " +
        "Price context (trend, volatility, asymmetry) is computed deterministically. " +
        "Price reactions around earnings can be computed when earnings dates are known.",
    },
    domains,
    externalDataGaps,
  };
}
