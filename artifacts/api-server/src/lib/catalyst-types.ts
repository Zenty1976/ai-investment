/**
 * Catalyst / Pre-Earnings Intelligence — Core Types
 *
 * All shared types, enums, and interfaces for the Catalyst Intelligence
 * feature. Nothing here makes network or AI calls — pure type definitions.
 *
 * Architecture rule: every other catalyst module imports from here.
 * Never create competing type definitions in other catalyst files.
 *
 * IMPORTANT: Do NOT use raw percentage probabilities for qualitative
 * dimensions. Use ordinal/categorical values only (see §3 of the spec).
 */

// ── Primary qualitative dimensions ────────────────────────────────────────────

/**
 * Direction of the AI-derived earnings surprise signal.
 * Represents what OBSERVABLE evidence suggests relative to prior period,
 * NOT a calibrated probability of an actual earnings beat.
 */
export type EarningsSurpriseSignal =
  | "VeryNegative"
  | "Negative"
  | "Neutral"
  | "Positive"
  | "VeryPositive";

/**
 * Confidence in the quality and independence of the evidence base.
 * Low = few sources or all from one origin; High = multiple independent
 * sources of different types all pointing the same direction.
 */
export type EvidenceConfidence = "Low" | "Medium" | "High";

/**
 * Gap between observable real-world conditions and what market consensus
 * appears to expect. Unknown when consensus data is unavailable.
 */
export type ExpectationGap =
  | "StrongNegative"
  | "Negative"
  | "Neutral"
  | "Positive"
  | "StrongPositive"
  | "Unknown";

/**
 * Whether the pre-event price move has already consumed the potential
 * asymmetric opportunity. Computed deterministically from price data.
 */
export type PriceAsymmetry =
  | "Poor"        // large run-up, already priced in
  | "Weak"        // some run-up, partially priced in
  | "Neutral"     // balanced, unclear
  | "Attractive"  // limited run-up, asymmetry appears intact
  | "VeryAttractive"; // significant decline + minimal run-up

/**
 * Risk level specific to the upcoming catalyst event.
 */
export type CatalystRisk = "Low" | "Medium" | "High" | "Extreme";

/**
 * Overall pre-event opportunity state after all dimensions are considered.
 * This is the SCREENING output — it drives whether deep analysis runs.
 */
export type PreEventOpportunityState =
  | "NotInteresting"          // excluded by screening
  | "Monitor"                 // eligible, keep watching
  | "Investigate"             // meaningful signal, worth deeper look
  | "HighInterest"            // strong converging evidence
  | "CandidateForTradeDecision"; // send to Opportunity Finder / TDE

/**
 * Whether the company's recent weakness (if any) appears temporary,
 * structural, or cyclical. Critical for avoiding value traps.
 */
export type TemporaryVsStructural =
  | "Temporary"   // weakness driven by reversible external factor
  | "Cyclical"    // weakness driven by industry/macro cycle, likely to turn
  | "Structural"  // fundamental deterioration in business model
  | "Unknown";

/**
 * What the recommended next step is after Catalyst analysis.
 */
export type RecommendedNextStep =
  | "Ignore"
  | "Monitor"
  | "ResearchMore"
  | "SendToOpportunityFinder";

// ── Source quality ─────────────────────────────────────────────────────────────

/**
 * Categorical source quality tier.
 * Used to prevent ten repetitions of the same Reuters story from
 * inflating evidence confidence.
 */
export type SourceQualityCategory =
  | "DirectCompany"         // official company statement / IR
  | "RegulatoryFiling"      // stock exchange filing, regulatory disclosure
  | "OfficialStatistics"    // government/statistical bureau data
  | "IndustryData"          // industry association, trade body data
  | "ReliableReporting"     // major news outlet with original research
  | "AnalystData"           // sell-side analyst report / consensus provider
  | "SecondaryReporting"    // news aggregator / repeat of another source
  | "AiInterpretation";     // derived by AI from other sources

// ── Company Driver Profile ─────────────────────────────────────────────────────

/**
 * Persistent, stateful profile of a company's economic drivers.
 *
 * IMPORTANT: OpenAI should NOT rediscover these drivers on every run.
 * This profile is generated once (full profile) and updated incrementally
 * when material changes are detected.
 *
 * Repository key: "company-driver-profile:<TICKER>"
 *
 * Update states:
 *   FullProfile    = freshly generated or fully regenerated
 *   MaterialUpdate = key drivers or sensitivities changed
 *   NoMaterialChange = checked, no meaningful update needed
 */
export type DriverProfileUpdateState =
  | "FullProfile"
  | "MaterialUpdate"
  | "NoMaterialChange";

export interface CompanyDriverProfile {
  ticker: string;
  company: string;

  /** Core revenue sources in order of importance. */
  primaryRevenueDrivers: string[];

  /** Key margin drivers (pricing power, cost structure, mix). */
  primaryMarginDrivers: string[];

  /** Significant cost components that affect profitability. */
  costDrivers: string[];

  /**
   * Leading real-world indicators that tend to move BEFORE company results.
   * Examples: freight rates (shipping), prescription data (pharma),
   * enterprise IT spend (cloud), port congestion (logistics).
   */
  leadingIndicators: string[];

  /** Industry-level data sources relevant to this company. */
  industryIndicators: string[];

  /** Macroeconomic sensitivities (rates, FX, inflation, growth). */
  macroSensitivities: string[];

  /** Geopolitical factors that materially affect this company. */
  geopoliticalSensitivities: string[];

  /** Regulatory factors that materially affect this company. */
  regulatorySensitivities: string[];

  /** Key competitors that affect market share or pricing. */
  importantCompetitors: string[];

  /** Company-specific KPIs that management emphasizes (sector-specific). */
  companySpecificKPIs: string[];

  /**
   * How far in advance leading indicators typically signal company results.
   * E.g. "freight rates lead by ~6 weeks", "prescription data leads by 1 quarter".
   */
  typicalIndicatorLeadTime: string;

  /** Confidence in the completeness and quality of this driver profile. */
  driverConfidence: "High" | "Medium" | "Low";

  /** ISO timestamp of the last materially significant profile update. */
  lastMateriallyUpdatedAt: string;

  updateState: DriverProfileUpdateState;
}

// ── Earnings history ───────────────────────────────────────────────────────────

/**
 * Single historical earnings period entry.
 *
 * DATA AVAILABILITY NOTE:
 * Saxo Bank does NOT provide historical earnings data, EPS actuals/estimates,
 * revenue actuals/estimates, or EBITDA. This interface is designed for when
 * an external provider (e.g. Refinitiv, Bloomberg, Alpha Vantage) is integrated.
 * For Part 1, EarningsHistoryProfile will always be empty.
 */
export interface EarningsHistoryEntry {
  /** Reporting period label e.g. "Q1 2025", "FY 2024". */
  period: string;
  /** ISO date when results were published. */
  reportDate: string;

  // Revenue
  revenueActual: number | null;
  revenueEstimate: number | null;
  revenueSurprisePct: number | null;

  // EPS
  epsActual: number | null;
  epsEstimate: number | null;
  epsSurprisePct: number | null;

  // EBITDA (sector-specific; null for companies where EBITDA is not standard)
  ebitdaActual: number | null;
  ebitdaEstimate: number | null;
  ebitdaSurprisePct: number | null;

  /** Company guidance change at this result announcement. */
  guidanceAction: "Raised" | "Maintained" | "Lowered" | "Unknown";

  /** Stock price return 1 trading day after earnings. */
  priceReaction1D: number | null;
  /** Stock price return 5 trading days after earnings. */
  priceReaction5D: number | null;

  /** Sector/company-specific additional metrics (e.g. freight rates for shipping). */
  sectorSpecificMetrics?: Record<string, number | string | null>;
}

export interface EarningsHistoryProfile {
  entries: EarningsHistoryEntry[];
  /**
   * Data source that provided this history.
   * Null until an external provider is integrated.
   */
  dataSource: string | null;
  /** ISO timestamp when this history was last refreshed. */
  lastUpdatedAt: string | null;
  /** True when no real data is available (stub/empty profile). */
  isUnavailable: boolean;
  /** Human-readable reason why data is unavailable (if applicable). */
  unavailableReason: string | null;
}

// ── Analyst expectations / consensus ──────────────────────────────────────────

/**
 * Current analyst consensus expectations for the upcoming period.
 *
 * DATA AVAILABILITY NOTE:
 * Saxo Bank does NOT provide consensus earnings estimates, analyst revisions,
 * or recommendation changes. This interface is a placeholder for when an
 * external provider (e.g. FactSet, Bloomberg, Refinitiv) is integrated.
 * For Part 1, ExpectationsProfile will be marked as isUnavailable = true.
 */
export type ExpectationsTrend = "Falling" | "Stable" | "Rising" | "RisingFast" | "Unknown";

export interface ExpectationsProfile {
  revenueConsensus: number | null;
  epsConsensus: number | null;
  ebitdaConsensus: number | null;
  otherRelevantMetrics: Record<string, number | null>;

  /** Consensus revision over the past 1 month (positive = estimates rising). */
  estimateRevision1M: number | null;
  /** Consensus revision over the past 3 months. */
  estimateRevision3M: number | null;

  numberOfUpwardRevisions: number | null;
  numberOfDownwardRevisions: number | null;

  /** Recent analyst target price changes (positive = upgrades). */
  recentTargetChanges: string | null;
  /** Recent recommendation changes summary. */
  recentRecommendationChanges: string | null;

  expectationsTrend: ExpectationsTrend;

  dataSource: string | null;
  lastUpdatedAt: string | null;
  isUnavailable: boolean;
  unavailableReason: string | null;
}

// ── Leading indicator signals ──────────────────────────────────────────────────

export type SignalDirection =
  | "StronglyNegative"
  | "Negative"
  | "Neutral"
  | "Positive"
  | "StronglyPositive";

export type SignalSourceType =
  | "NewsMonitor"
  | "EventMonitor"
  | "SectorMonitor"
  | "MarketMonitor"
  | "CompanyMonitor"
  | "WebSearch"        // future: catalyst-specific web search
  | "ExternalData";    // future: external data provider

/**
 * A single observable signal relevant to the company's earnings drivers.
 *
 * IMPORTANT EPISTEMOLOGICAL DISTINCTION:
 *   fact: "US container imports increased 12% MoM" (observable data)
 *   interpretation: "This may support stronger shipping demand" (derived)
 * Do NOT store interpretations as if they were facts.
 */
export interface LeadingIndicatorSignal {
  /** Stable unique identifier for this signal. */
  signalId: string;
  /** Which company driver this signal relates to. */
  driver: string;
  direction: SignalDirection;

  /** Observable fact — what was actually observed. */
  observedFact: string;
  /** Qualitative interpretation — clearly separated from the fact. */
  interpretation: string | null;

  /** Previous value or context for comparison. */
  previousContext: string | null;

  /** ISO date the underlying data was observed/published. */
  observationDate: string;

  /** Source name (publication, data provider, etc.). */
  source: string;
  sourceType: SignalSourceType;
  sourceQuality: SourceQualityCategory;
  /** How confident we are that this source is accurate. */
  sourceConfidence: "High" | "Medium" | "Low";

  /**
   * How relevant this indicator's lead time is to the upcoming event.
   * High = indicator typically leads by a period consistent with the event proximity.
   */
  leadTimeRelevance: "High" | "Medium" | "Low" | "Unknown";

  /** Why this signal affects this specific company's earnings. */
  companyImpactReason: string;

  /** Is this signal fresh (< 2 weeks) or stale? */
  freshness: "Fresh" | "Aging" | "Stale";
}

// ── Price asymmetry ────────────────────────────────────────────────────────────

export type RunupPattern =
  | "NoRunup"            // <2% recent move
  | "SmallRunup"         // 2–8% recent move
  | "SignificantRunup"   // 8–20% recent move
  | "LargeRunup"         // >20% recent move — asymmetry likely consumed
  | "Unknown";           // insufficient price data

/**
 * Deterministic pre-event price asymmetry facts.
 * Computed entirely from PriceContext — no AI calls.
 */
export interface PriceAsymmetryFacts {
  /**
   * Approximate run-up since the event window started.
   * Uses the shortest available return period that fits daysUntilEvent.
   */
  preEventRunupPct: number | null;
  /** Period used for pre-event run-up (e.g. "5D", "10D", "30D"). */
  preEventRunupPeriod: string | null;

  /** 5-day return — recent directional momentum. */
  recentMomentum5D: number | null;
  /** 10-day return — short-term momentum. */
  recentMomentum10D: number | null;
  /** 30-day return — medium-term momentum. */
  momentum30D: number | null;
  /** 90-day return — longer-term context. */
  momentum90D: number | null;

  /** Percentage drawdown from the 30-day high. */
  drawdownFrom30DayHighPct: number | null;
  /** Percentage distance from 90-day high. */
  distanceFrom90DayHighPct: number | null;
  /** Percentage distance from 90-day low. */
  distanceFrom90DayLowPct: number | null;

  runupPattern: RunupPattern;
  asymmetry: PriceAsymmetry;
  /** Concise deterministic explanation of the asymmetry assessment. */
  reasoning: string;
}

// ── Catalyst event ─────────────────────────────────────────────────────────────

export type CatalystEventType =
  | "Earnings"
  | "GuidanceUpdate"
  | "CapitalMarketsDay"
  | "AGM"
  | "ProductLaunch"
  | "RegulatoryDecision"
  | "Other";

export type CatalystEventSource =
  | "CompanyMonitor"    // from CM.earningsAndGuidance.nextKnownEventDate
  | "EventMonitor"      // from event-monitor events list
  | "Manual";           // user-provided

/**
 * Event classification — whether the upcoming event represents
 * a risk to avoid, an opportunity to exploit, both, or unknown.
 * This is EVENT CONTEXT only — it does NOT decide trading action.
 */
export type EventClassification = "Risk" | "Opportunity" | "Both" | "Unknown";

export interface CatalystEvent {
  ticker: string;
  company: string;
  eventType: CatalystEventType;
  /** ISO date string YYYY-MM-DD. */
  eventDate: string;
  daysUntilEvent: number;
  /** What reporting period this event covers (e.g. "Q2 2025", "H1 2025"). */
  reportingPeriod: string | null;
  /** Time of day if known (BeforeMarket / AfterMarket / Unknown). */
  marketTiming: "BeforeMarket" | "AfterMarket" | "Unknown";
  source: CatalystEventSource;
  sourceConfidence: "High" | "Medium" | "Low";
  classification: EventClassification;
}

// ── CatalystFacts — the compact context object sent to deep AI analysis ────────

/**
 * Compact, structured facts object aggregated from all relevant sources.
 *
 * DO NOT pass entire raw module outputs to AI.
 * CatalystFacts is the ONLY thing sent to Catalyst AI analysis.
 * Every field has a clear purpose — if it cannot be justified, remove it.
 */
export interface CatalystFacts {
  /** ISO timestamp when this facts object was assembled. */
  assembledAt: string;

  event: CatalystEvent;

  price: {
    /** Current price (reference only — do not use for investment decisions). */
    currentPrice: number | null;
    priceState: string; // PriceState from price-context-calculator
    priceAsymmetryFacts: PriceAsymmetryFacts;
    volatilityState: string | null;
    volatilityTrend: string | null;
    /** Short-term trend direction. */
    shortTermTrend: string | null;
    mediumTermTrend: string | null;
    longTermTrend: string | null;
    momentumChange: string | null;
    recentBehavior: string | null; // RecentBehaviorState
  };

  history: EarningsHistoryProfile;
  expectations: ExpectationsProfile;

  company: {
    /** Current investment view from Company Monitor. */
    investmentView: string | null;
    investmentCaseStrength: string | null;
    investmentThesis: string | null;
    /** Bull / base / bear case summaries from Company Monitor. */
    bullCase: string | null;
    bearCase: string | null;
    /** Qualitative earnings/guidance trend from Company Monitor. */
    earningsGuidanceTrend: "Improving" | "Stable" | "Weakening" | null;
    /** Most recent meaningful change in Company Monitor (if any). */
    recentMeaningfulChange: string | null;
    /** Compact Company Driver Profile (null until generated). */
    driverProfile: CompanyDriverProfile | null;
    /** Company sector. */
    sector: string | null;
    industry: string | null;
  };

  signals: LeadingIndicatorSignal[];

  sector: {
    /** Current sector assessment summary. */
    sectorSummary: string | null;
    /** Whether the sector is in an improving/stable/deteriorating regime. */
    sectorTrend: string | null;
  } | null;

  market: {
    marketSentiment: string | null;
    riskLevel: string | null;
    marketSummary: string | null;
  } | null;

  news: {
    /** Only material, company/driver-relevant news items. */
    materialNews: Array<{
      headline: string;
      summary: string | null;
      publishedAt: string | null;
      sourceQuality: SourceQualityCategory;
    }>;
    newsCount: number;
  } | null;

  risks: string[];

  dataQuality: {
    /** Fields that are null/unavailable in this facts object. */
    missingFields: string[];
    /** Fields present but from stale sources. */
    staleFields: string[];
    /** Overall source confidence given available data. */
    overallSourceConfidence: "High" | "Medium" | "Low";
    /** Whether earnings history data is available. */
    earningsHistoryAvailable: boolean;
    /** Whether analyst consensus data is available. */
    consensusDataAvailable: boolean;
    /** Whether Company Driver Profile is available. */
    driverProfileAvailable: boolean;
  };
}

// ── Catalyst screening ─────────────────────────────────────────────────────────

/**
 * Configurable thresholds for the deterministic screening funnel.
 * NOT ticker-specific — generic thresholds that apply to all companies.
 */
export interface CatalystScreeningConfig {
  /** Maximum days until event to enter screening. */
  maxDaysUntilEvent: number;
  /** Minimum days until event (< this = too late to act on pre-event thesis). */
  minDaysUntilEvent: number;

  /** Pre-event run-up pct that reduces asymmetry to Weak. */
  runupWeakThresholdPct: number;
  /** Pre-event run-up pct that reduces asymmetry to Poor. */
  runupPoorThresholdPct: number;

  /** Price asymmetry levels at which screening is excluded. */
  excludedAsymmetryLevels: PriceAsymmetry[];

  /** Days until event thresholds for progressive analysis levels. */
  deepAnalysisDaysThreshold: number;    // <= this → eligible for deep analysis
  signalAssessmentDaysThreshold: number; // <= this → eligible for signal assessment
}

export const DEFAULT_CATALYST_SCREENING_CONFIG: CatalystScreeningConfig = {
  maxDaysUntilEvent: 30,
  minDaysUntilEvent: 1,
  runupWeakThresholdPct: 8,
  runupPoorThresholdPct: 20,
  excludedAsymmetryLevels: [], // Poor asymmetry doesn't auto-exclude, it reduces interest
  deepAnalysisDaysThreshold: 14,
  signalAssessmentDaysThreshold: 21,
};

/** Why a company was excluded from or retained in the screening funnel. */
export interface CatalystScreeningResult {
  ticker: string;
  company: string;
  eligible: boolean;
  /** Screening level if eligible. */
  screeningLevel: "Excluded" | "BasicMonitor" | "SignalAssessment" | "DeepAnalysis";
  /** Number of days until the upcoming catalyst event. */
  daysUntilEvent: number | null;
  /** Preliminary opportunity state from deterministic screening (before AI). */
  preliminaryState: PreEventOpportunityState;
  priceAsymmetry: PriceAsymmetry;
  /** Human-readable reasons for the screening decision. */
  screeningReasons: string[];
  /** Reason for exclusion (if !eligible). */
  exclusionReason: string | null;
  /** Deterministic material fingerprint hash for this screening context. */
  materialFingerprint: string;
  /** ISO timestamp of this screening run. */
  screenedAt: string;
}

// ── Catalyst Intelligence AI output (Part 2) ──────────────────────────────────

/**
 * Structured output from the deep Catalyst AI analysis.
 * Part 1: type definition only — actual AI calls are Part 2.
 */
export interface CatalystAnalysisResult {
  earningsSurpriseSignal: EarningsSurpriseSignal;
  evidenceConfidence: EvidenceConfidence;
  expectationGap: ExpectationGap;
  priceAsymmetry: PriceAsymmetry;
  catalystRisk: CatalystRisk;
  opportunityState: PreEventOpportunityState;

  /** Concise thesis for the pre-event case. */
  thesis: string;

  /** Signal IDs from CatalystFacts.signals that support the thesis. */
  supportingSignals: Array<{ signalId: string; reason: string }>;
  /** Signal IDs that contradict the thesis. */
  contradictingSignals: Array<{ signalId: string; reason: string }>;

  strongestCounterargument: string;
  whatMarketMayBeMissing: string | null;
  alreadyPricedInAssessment: string;
  temporaryVsStructural: TemporaryVsStructural;

  /** Conditions that would invalidate the pre-event thesis. */
  invalidationConditions: string[];
  /** Data gaps that limit confidence in this analysis. */
  dataLimitations: string[];

  recommendedNextStep: RecommendedNextStep;
}

// ── Catalyst repository state ──────────────────────────────────────────────────

/**
 * Persisted state for a single ticker's catalyst analysis.
 * Repository key: "catalyst-intelligence:<TICKER>"
 */
export interface CatalystState {
  ticker: string;
  company: string;

  /** Current screening result. */
  screening: CatalystScreeningResult | null;

  /** Catalyst facts assembled for the most recent analysis cycle. */
  facts: CatalystFacts | null;

  /** AI analysis result (null until Part 2 deep analysis is implemented). */
  analysis: CatalystAnalysisResult | null;

  /**
   * Material fingerprint from the last AI analysis run.
   * Used to detect when a new AI call is warranted.
   */
  lastAnalysisFingerprint: string | null;

  /** ISO timestamp of the last screening run. */
  lastScreenedAt: string | null;

  /** ISO timestamp of the last AI analysis run. */
  lastAnalysedAt: string | null;

  /** Whether the catalyst window has passed (event date in the past). */
  eventPassed: boolean;

  /** ISO timestamp when this state was last updated. */
  updatedAt: string;
}
