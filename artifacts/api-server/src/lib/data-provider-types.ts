/**
 * Data Provider Types — Shared contracts for all financial-data domains.
 *
 * Every structured financial-data object in this system must carry provenance
 * so we can answer "what did the system know on date X?" (spec §27).
 *
 * Architecture principles:
 *   - Never silently combine conflicting values (spec §18)
 *   - UNKNOWN ≠ NEUTRAL — missing data must be explicit (spec §19)
 *   - Provider capabilities must be reported, not assumed (spec §11)
 */

// ── Data quality ───────────────────────────────────────────────────────────────

export type DataQualityLevel = "HIGH" | "MEDIUM" | "LOW";

export type DataAvailabilityStatus =
  | "AVAILABLE"    // data is present and from a reliable structured source
  | "PARTIAL"      // some fields available, others missing
  | "UNAVAILABLE"; // no data from any provider

// ── Source provenance ──────────────────────────────────────────────────────────

/**
 * Every structured financial-data object must carry provenance so point-in-time
 * queries can be answered correctly (spec §27).
 */
export interface DataProvenance {
  /** Human-readable provider name, e.g. "Saxo Bank", "NullExpectationsProvider". */
  provider: string;
  /** Provider-specific record identifier (if applicable). */
  sourceId?: string;
  /** ISO timestamp when this record was fetched from the source. */
  retrievedAt: string;
  /** ISO date/timestamp representing the "as of" date of the underlying data. */
  dataAsOf: string;
  /** Overall quality assessment for this data point. */
  quality: DataQualityLevel;
  /** Limitations or caveats that consumers should be aware of. */
  limitations?: string[];
}

/**
 * Provenance for web-derived (non-structured) data.
 * Extends DataProvenance with publication metadata.
 */
export interface WebDataProvenance extends DataProvenance {
  publishedAt: string | null;
  sourceUrl: string | null;
  /** Classification of the source: "official", "news", "analysis", "social". */
  sourceClassification: "official" | "news" | "analysis" | "social" | "unknown";
}

// ── Provider capability declarations ──────────────────────────────────────────

/**
 * Capabilities for a market-universe provider.
 * Consumers must check capabilities before relying on specific features.
 */
export interface MarketUniverseCapabilities {
  providerName: string;
  /** Can list all equities on an exchange without knowing tickers a priori. */
  supportsFullDanishUniverse: boolean;
  supportsFullUSUniverse: boolean;
  /** Can search/validate a known ticker. */
  supportsTickerSearch: boolean;
  /** Can provide sector/industry metadata. */
  supportsMetadata: boolean;
  estimatedDanishUniverseSize: number;
  estimatedUSUniverseSize: number;
  /** ISO timestamp of last successful universe refresh. */
  lastRefreshedAt: string | null;
  /** Human-readable description of what this provider can and cannot do. */
  limitation: string;
  /** What would be needed to fill the gap. */
  requiredExternalCapability?: string;
}

/**
 * Capabilities for an expectations/consensus data provider.
 */
export interface ExpectationsCapabilities {
  providerName: string;
  supportsEpsConsensus: boolean;
  supportsRevenueConsensus: boolean;
  supportsEbitdaConsensus: boolean;
  supportsRevisionHistory: boolean;
  /** Supports point-in-time historical snapshots (not just current). */
  supportsHistoricalSnapshots: boolean;
  supportsCompanyGuidance: boolean;
  supportsAnalystRecommendations: boolean;
  supportsDanishEquities: boolean;
  supportsUSEquities: boolean;
  limitation: string;
  requiredExternalCapability?: string;
}

/**
 * Capabilities for an earnings-calendar provider.
 */
export interface EarningsCalendarCapabilities {
  providerName: string;
  /** Can provide upcoming earnings for a broad universe without per-ticker queries. */
  supportsBulkCalendar: boolean;
  /** Can confirm vs tentative dates. */
  supportsConfirmedDates: boolean;
  supportsBMO_AMC_Timing: boolean;
  supportsDanishEquities: boolean;
  supportsUSEquities: boolean;
  limitation: string;
}

/**
 * Capabilities for an earnings-history provider.
 */
export interface EarningsHistoryCapabilities {
  providerName: string;
  supportsEpsActuals: boolean;
  supportsRevenueActuals: boolean;
  supportsEpsEstimates: boolean;
  supportsRevenueEstimates: boolean;
  supportsSurpriseCalculation: boolean;
  supportsGuidanceHistory: boolean;
  supportsDanishEquities: boolean;
  supportsUSEquities: boolean;
  historyDepthYears: number | null;
  limitation: string;
}

/**
 * Summary status for the data coverage health report (spec §25).
 */
export interface DomainCoverageStatus {
  domain: string;
  providerName: string;
  status: DataAvailabilityStatus;
  detail: string;
  lastRefreshedAt: string | null;
}
