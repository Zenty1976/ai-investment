/**
 * Expectations Data Provider — Abstraction for analyst consensus & estimates.
 *
 * WHY THIS EXISTS (spec §10):
 *   Analyst consensus (EPS, revenue, revisions) is one of the largest current
 *   intelligence gaps. Saxo does not provide it. This abstraction layer:
 *   1. Defines the interface any future provider must satisfy
 *   2. Provides a safe NullExpectationsProvider that returns isUnavailable: true
 *   3. Prevents Catalyst Intelligence from silently treating UNKNOWN as NEUTRAL
 *
 * IMPORTANT (spec §8 / §13):
 *   Do NOT use OpenAI as the source of consensus numeric facts.
 *   OpenAI may interpret consensus data supplied by a provider.
 *   It must never create the consensus.
 *
 * TO ADD A REAL PROVIDER: implement ExpectationsDataProvider, register it via
 *   registerExpectationsProvider() in data-provider-registry.ts.
 */

import type {
  ExpectationsProfile,
  EarningsHistoryProfile,
  EarningsHistoryEntry,
} from "./catalyst-types.js";
import type {
  ExpectationsCapabilities,
  EarningsCalendarCapabilities,
  EarningsHistoryCapabilities,
  DataProvenance,
} from "./data-provider-types.js";

// ── Upcoming earnings entry ────────────────────────────────────────────────────

/**
 * A single upcoming earnings date from a structured provider (spec §6).
 */
export interface UpcomingEarningsEntry {
  ticker: string;
  earningsDate: string; // ISO date YYYY-MM-DD
  time: "BEFORE_MARKET" | "AFTER_MARKET" | "DURING_MARKET" | "UNKNOWN";
  fiscalQuarter: string | null; // e.g. "Q2 2026"
  fiscalYear: number | null;
  confirmed: boolean; // true = confirmed, false = tentative
  provenance: DataProvenance;
}

// ── Company guidance ───────────────────────────────────────────────────────────

export interface CompanyGuidanceEntry {
  ticker: string;
  period: string;
  issuedAt: string;
  metric: "EPS" | "Revenue" | "EBITDA" | "Operating_Income" | "Other";
  guidanceLow: number | null;
  guidanceHigh: number | null;
  guidanceMidpoint: number | null;
  consensusAtIssuance: number | null;
  /** "ABOVE", "BELOW", "IN_LINE", or null if consensus unavailable. */
  vsConsensus: "ABOVE" | "BELOW" | "IN_LINE" | null;
  provenance: DataProvenance;
}

// ── Primary provider interface ─────────────────────────────────────────────────

/**
 * ExpectationsDataProvider (spec §10).
 *
 * A provider does not need to implement ALL capabilities.
 * Check describeCapabilities() before calling any method.
 * Methods that are not supported MUST return a result with isUnavailable=true.
 */
export interface ExpectationsDataProvider {
  readonly name: string;

  /** Report what this provider can and cannot supply. */
  describeCapabilities(): ExpectationsCapabilities;
  describeCalendarCapabilities(): EarningsCalendarCapabilities;
  describeHistoryCapabilities(): EarningsHistoryCapabilities;

  /** Upcoming earnings dates for a ticker. */
  getUpcomingEarnings(ticker: string): Promise<UpcomingEarningsEntry[]>;

  /** Historical earnings actuals + estimates for a ticker. */
  getEarningsHistory(ticker: string): Promise<EarningsHistoryProfile>;

  /**
   * Current analyst consensus snapshot.
   * Returns profile with isUnavailable=true if not supported.
   */
  getCurrentConsensus(ticker: string): Promise<ExpectationsProfile>;

  /**
   * Historical consensus snapshots for point-in-time queries.
   * Returns [] if not supported.
   */
  getConsensusHistory(ticker: string): Promise<ExpectationsProfile[]>;

  /**
   * Estimate revision direction over recent windows.
   * Returns profile with estimateRevision1M=null if not supported.
   */
  getEstimateRevisions(ticker: string): Promise<ExpectationsProfile>;

  /** Current and historical company guidance. */
  getCompanyGuidance(ticker: string): Promise<CompanyGuidanceEntry[]>;
  getHistoricalGuidance(ticker: string): Promise<CompanyGuidanceEntry[]>;
}

// ── Null provider (safe fallback) ─────────────────────────────────────────────

const NULL_EARNINGS_HISTORY: EarningsHistoryProfile = {
  entries: [],
  dataSource: null,
  lastUpdatedAt: null,
  isUnavailable: true,
  unavailableReason:
    "No earnings-history provider is configured. " +
    "EPS actuals/estimates and revenue data require an external provider " +
    "(e.g. FactSet, Refinitiv, Alpha Vantage).",
};

const NULL_EXPECTATIONS: ExpectationsProfile = {
  revenueConsensus: null,
  epsConsensus: null,
  ebitdaConsensus: null,
  otherRelevantMetrics: {},
  estimateRevision1M: null,
  estimateRevision3M: null,
  numberOfUpwardRevisions: null,
  numberOfDownwardRevisions: null,
  recentTargetChanges: null,
  recentRecommendationChanges: null,
  expectationsTrend: "Unknown",
  dataSource: null,
  lastUpdatedAt: null,
  isUnavailable: true,
  unavailableReason:
    "No expectations provider is configured. " +
    "Analyst consensus and revision data require an external provider " +
    "(e.g. FactSet, Bloomberg, Refinitiv). " +
    "ExpectationGap will be reported as UNKNOWN — not as NEUTRAL.",
};

/**
 * NullExpectationsProvider — the safe fallback when no real provider is configured.
 *
 * Returns isUnavailable=true for everything.
 * NEVER returns fabricated numeric consensus values.
 * Catalyst Intelligence degrades gracefully with UNKNOWN rather than NEUTRAL.
 */
export class NullExpectationsProvider implements ExpectationsDataProvider {
  readonly name = "NullExpectationsProvider";

  describeCapabilities(): ExpectationsCapabilities {
    return {
      providerName: this.name,
      supportsEpsConsensus: false,
      supportsRevenueConsensus: false,
      supportsEbitdaConsensus: false,
      supportsRevisionHistory: false,
      supportsHistoricalSnapshots: false,
      supportsCompanyGuidance: false,
      supportsAnalystRecommendations: false,
      supportsDanishEquities: false,
      supportsUSEquities: false,
      limitation:
        "No external expectations provider configured. " +
        "All consensus and revision data is UNAVAILABLE. " +
        "ExpectationGap is reported as UNKNOWN (not NEUTRAL) to prevent silent data gaps.",
      requiredExternalCapability:
        "A provider with: EPS consensus, revenue consensus, estimate revisions (7D/30D/60D/90D), " +
        "historical consensus snapshots (point-in-time), company guidance, " +
        "coverage of both Danish (CSE/OMX) and US equities (NYSE/NASDAQ). " +
        "Candidates: FactSet, Bloomberg Data License, Refinitiv (LSEG), Alpha Vantage Premium.",
    };
  }

  describeCalendarCapabilities(): EarningsCalendarCapabilities {
    return {
      providerName: this.name,
      supportsBulkCalendar: false,
      supportsConfirmedDates: false,
      supportsBMO_AMC_Timing: false,
      supportsDanishEquities: false,
      supportsUSEquities: false,
      limitation:
        "No earnings-calendar provider configured. " +
        "Earnings dates come from AI web search (per-ticker, not bulk). " +
        "This requires one AI call per ticker — not scalable to thousands of companies.",
    };
  }

  describeHistoryCapabilities(): EarningsHistoryCapabilities {
    return {
      providerName: this.name,
      supportsEpsActuals: false,
      supportsRevenueActuals: false,
      supportsEpsEstimates: false,
      supportsRevenueEstimates: false,
      supportsSurpriseCalculation: false,
      supportsGuidanceHistory: false,
      supportsDanishEquities: false,
      supportsUSEquities: false,
      historyDepthYears: null,
      limitation:
        "No earnings-history provider configured. " +
        "EPS actuals, revenue actuals, estimates, and surprises are UNAVAILABLE. " +
        "Saxo Bank does not provide this data.",
    };
  }

  async getUpcomingEarnings(_ticker: string): Promise<UpcomingEarningsEntry[]> {
    return [];
  }

  async getEarningsHistory(_ticker: string): Promise<EarningsHistoryProfile> {
    return { ...NULL_EARNINGS_HISTORY };
  }

  async getCurrentConsensus(_ticker: string): Promise<ExpectationsProfile> {
    return { ...NULL_EXPECTATIONS };
  }

  async getConsensusHistory(_ticker: string): Promise<ExpectationsProfile[]> {
    return [];
  }

  async getEstimateRevisions(_ticker: string): Promise<ExpectationsProfile> {
    return { ...NULL_EXPECTATIONS };
  }

  async getCompanyGuidance(_ticker: string): Promise<CompanyGuidanceEntry[]> {
    return [];
  }

  async getHistoricalGuidance(_ticker: string): Promise<CompanyGuidanceEntry[]> {
    return [];
  }
}
