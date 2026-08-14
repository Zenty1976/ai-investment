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
 * IMPORTANT EPISTEMOLOGICAL DISTINCTIONS:
 *   fact: "US container imports increased 12% MoM" (observable data)
 *   interpretation: "This may support stronger shipping demand" (derived)
 * Do NOT store interpretations as if they were facts.
 *
 * Source independence fields (spec §7):
 *   sourceOriginId — the original reporting entity (dedup key)
 *   canonicalSource — primary/authoritative source URL or name
 *
 * Point-in-time safety (spec §25):
 *   availableAt — when this signal was first available to the system
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

  // ── Part 2 additions ──────────────────────────────────────────────────────

  /** How this information should be classified (spec §6). */
  informationCategory: InformationCategory;

  /**
   * Deduplication key for source independence (spec §7).
   * Identifies the ORIGINAL reporting entity (not the repeater).
   * Example: a Reuters story re-published on 10 sites → sourceOriginId = "reuters.com"
   */
  sourceOriginId: string | null;

  /**
   * Canonical primary source (URL or name) for this signal.
   * Used to cluster evidence groups and prevent counting the same story twice.
   */
  canonicalSource: string | null;

  /**
   * When this signal first became available to the system (ISO timestamp).
   * Used for point-in-time regression testing — no information published
   * after the simulated decision time may be included (spec §25).
   */
  availableAt: string;
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
  | "InvestorDay"          // Investor Day / Capital Markets Day (major)
  | "CapitalMarketsDay"
  | "CompanyMeeting"       // Company or shareholder meeting
  | "ProductLaunch"        // Product launch, tech demo, keynote, developer conference
  | "ClinicalReadout"      // Clinical trial readout
  | "RegulatoryDecision"   // FDA decision, regulatory approval/rejection
  | "AGM"
  | "Other";

export type CatalystEventSource =
  | "CompanyMonitor"    // from CM.earningsAndGuidance.nextKnownEventDate
  | "EventMonitor"      // from event-monitor events list
  | "CompanyEvents"     // from catalyst-company-events store (web-discovered)
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

  /**
   * The upcoming scheduled event (PATH A), or null for PATH B (emerging setup).
   * When null, triggerType is EMERGING_SETUP and event-related fields are unavailable.
   */
  event: CatalystEvent | null;

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

// ── Part 2 additions ──────────────────────────────────────────────────────────

/**
 * What kind of catalyst triggered this analysis.
 * PATH A = known scheduled event; PATH B = signal accumulation.
 */
export type TriggerType = "SCHEDULED_EVENT" | "EARNINGS" | "EMERGING_SETUP";

/** Overall direction of the catalyst evidence. */
export type CatalystDirection =
  | "STRONGLY_NEGATIVE" | "NEGATIVE" | "NEUTRAL"
  | "POSITIVE" | "STRONGLY_POSITIVE";

/** Whether the thesis appears already priced into the stock. */
export type AlreadyPricedIn = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";

/** Whether this is a fresh full analysis, a material update, or no change. */
export type AnalysisUpdateType = "FULL_ANALYSIS" | "MATERIAL_UPDATE" | "NO_MATERIAL_CHANGE";

/**
 * How the company was discovered as a Catalyst candidate.
 * Logged in _debug for full decision-chain visibility (spec §30).
 */
export type DiscoverySource =
  | "UNIVERSE_SEED"        // seeded from MarketUniverseProvider (DISCOVERED state, not yet screened)
  | "UNIVERSE_EVENT"       // discovered via market universe + upcoming event
  | "EXISTING_EVENT"       // from existing EventRecord or CompanySpecificEvent
  | "NEWS_SIGNAL"          // from news-monitor signals
  | "COMPANY_SIGNAL"       // from company-monitor changes
  | "SECTOR_SIGNAL"        // from sector-monitor changes
  | "EMERGING_SETUP"       // from signal accumulation path (PATH B)
  | "PORTFOLIO"            // already a portfolio holding
  | "OPPORTUNITY_FINDER"   // already an OF candidate
  | "OTHER";

/**
 * Classification of a pre-event information item.
 * IMPORTANT: AI_INTERPRETATION must NEVER be stored as a confirmed fact.
 */
export type InformationCategory =
  | "CONFIRMED_FACT"          // verifiable, confirmed event/announcement
  | "OFFICIAL_EXPECTATION"    // company-stated forward-looking statement
  | "RELIABLE_REPORTING"      // major news outlet with original research
  | "ANALYST_EXPECTATION"     // sell-side analyst forecast or expectation
  | "INDUSTRY_SIGNAL"         // industry data, supply chain, or sector observation
  | "CREDIBLE_RUMOR"          // multiple independent sources, unconfirmed
  | "UNVERIFIED_RUMOR"        // single low-confidence or anecdotal source
  | "AI_INTERPRETATION";      // AI-derived synthesis — must be clearly labeled

/**
 * Supported scheduled catalyst event types (spec §3).
 * Not every type will have structured API data — some require web discovery.
 */
export type ScheduledCatalystType =
  | "EARNINGS"
  | "GUIDANCE_UPDATE"
  | "INVESTOR_DAY"
  | "CAPITAL_MARKETS_DAY"
  | "COMPANY_MEETING"
  | "SHAREHOLDER_MEETING"
  | "PRODUCT_LAUNCH"
  | "AI_MODEL_LAUNCH"
  | "TECHNOLOGY_DEMONSTRATION"
  | "DEVELOPER_CONFERENCE"
  | "KEYNOTE"
  | "CLINICAL_READOUT"
  | "FDA_DECISION"
  | "REGULATORY_DECISION"
  | "COURT_DECISION"
  | "MAJOR_CONTRACT_DECISION"
  | "M_AND_A_EVENT"
  | "LOCKUP_EXPIRATION"
  | "STRATEGY_UPDATE"
  | "MANAGEMENT_PRESENTATION"
  | "OTHER_COMPANY_CATALYST";

/**
 * Company-specific scheduled catalyst event (distinct from market-wide EventRecord).
 * Stored under repository key: "company-events:<TICKER>"
 *
 * Source independence fields (spec §7):
 *   sourceOriginId — the original reporting entity (e.g. "reuters.com")
 *   canonicalSource — the primary/authoritative source URL or name
 *   derivedFrom — sourceOriginId of the parent source (if this is a re-report)
 */
export interface CompanySpecificEvent {
  /** Stable ID: "<ticker>-<eventType>-<YYYY-MM-DD>" */
  eventId: string;
  ticker: string;
  company: string;
  eventType: ScheduledCatalystType;
  title: string;
  /** YYYY-MM-DD */
  eventDate: string;
  /** HH:MM in company's local time, or null if unknown. */
  eventTime: string | null;
  beforeAfterMarket: "BeforeMarket" | "AfterMarket" | "DuringMarket" | "Unknown";
  /** Whether the event date/time has been officially confirmed. */
  isConfirmed: boolean;
  /** Topics the company has officially said will be covered. */
  expectedTopics: string[];
  potentialMarketImpact: "High" | "Medium" | "Low" | "Unknown";
  /** Qualitative uncertainty level for this event. */
  uncertainty: "High" | "Medium" | "Low";
  source: string;
  sourceType: SourceQualityCategory;
  sourceOriginId: string | null;
  canonicalSource: string | null;
  classification: EventClassification;
  /** ISO timestamp when first discovered. */
  discoveredAt: string;
  /** ISO timestamp of last update. */
  lastUpdatedAt: string;
}

/**
 * Expectation profile for a non-earnings scheduled catalyst event.
 * The non-earnings equivalent of analyst consensus (spec §13).
 *
 * Each item is tagged with InformationCategory to prevent mixing
 * confirmed facts with unverified rumors.
 */
export interface EventExpectationItem {
  content: string;
  category: InformationCategory;
  source: string;
  sourceOriginId: string | null;
  /** ISO date the expectation was published/stated. */
  publishedAt: string | null;
  /** ISO date this information was collected (for point-in-time safety). */
  observedAt: string;
}

export type ExpectationDirection =
  | "NEGATIVE" | "MIXED" | "NEUTRAL" | "POSITIVE" | "VERY_POSITIVE" | "UNKNOWN";

export interface EventExpectationProfile {
  eventId: string;
  confirmedTopics: EventExpectationItem[];
  expectedTopics: EventExpectationItem[];
  officialHints: EventExpectationItem[];
  reliableReportingExpectations: EventExpectationItem[];
  analystExpectations: EventExpectationItem[];
  credibleRumors: EventExpectationItem[];
  unverifiedRumors: EventExpectationItem[];
  /** AI-synthesized market narrative — clearly labeled AI_INTERPRETATION. */
  marketNarrative: EventExpectationItem | null;
  expectationDirection: ExpectationDirection;
  expectationIntensity: "LOW" | "MEDIUM" | "HIGH";
  expectationConfidence: "LOW" | "MEDIUM" | "HIGH";
  potentialSurpriseAreas: string[];
  alreadyWidelyExpected: string[];
  unknowns: string[];
  /** ISO timestamp when this profile was built. */
  builtAt: string;
  dataSource: "WebResearch" | "ExistingIntelligence" | "Partial" | "NotAvailable";
}

// ── Signal Accumulation (spec §10) ────────────────────────────────────────────

export type SignalMomentum =
  | "DETERIORATING" | "WEAKENING" | "STABLE" | "IMPROVING" | "ACCELERATING";

export type SignalOverallDirection =
  | "STRONGLY_NEGATIVE" | "NEGATIVE" | "MIXED" | "NEUTRAL"
  | "POSITIVE" | "STRONGLY_POSITIVE";

/**
 * Represents a group of signals that share the same original evidence source.
 * Used to enforce source independence when computing evidence confidence.
 * Ten re-publications of one Reuters story = one evidence group.
 */
export interface IndependentEvidenceGroup {
  groupId: string;
  sourceOriginId: string;
  canonicalSource: string;
  signalIds: string[];
  /** Net direction of this evidence group (majority rules). */
  netDirection: SignalDirection;
}

export interface SignalWindowStats {
  positiveMaterialSignals: number;
  negativeMaterialSignals: number;
  neutralSignals: number;
  independentPositiveGroups: number;
  independentNegativeGroups: number;
}

export interface SignalAccumulationState {
  ticker: string;
  /** ISO timestamp of computation. */
  computedAt: string;

  window7D: SignalWindowStats;
  window14D: SignalWindowStats;
  window30D: SignalWindowStats;

  /** Drivers that have been accumulating positive signals. */
  strengtheningDrivers: string[];
  /** Drivers that have been accumulating negative signals. */
  weakeningDrivers: string[];

  /** Signal IDs that arrived after the previous assessment. */
  newSignalsSinceLastAssessment: string[];
  /** Signal IDs that point in the opposite direction of the majority. */
  contradictorySignals: string[];

  /** Evidence groups for independent source tracking. */
  evidenceGroups: IndependentEvidenceGroup[];

  signalMomentum: SignalMomentum;
  overallDirection: SignalOverallDirection;
  evidenceConfidence: EvidenceConfidence;
}

// ── Emerging Setup (spec §11, PATH B) ─────────────────────────────────────────

export type EmergingSetupState =
  | "NONE"          // no meaningful signal accumulation
  | "EARLY"         // weak/nascent signals, worth watching
  | "DEVELOPING"    // growing evidence, warrants attention
  | "STRONG"        // strong multi-driver convergence
  | "URGENT_REVIEW"; // time-sensitive, should run deep analysis soon

export interface EmergingSetup {
  state: EmergingSetupState;
  /** Human-readable reasons for this state assignment. */
  reasons: string[];
  /** Drivers contributing to the emerging setup. */
  keyDrivers: string[];
  /** Whether price action is consistent with a setup (stabilizing after weakness). */
  priceSetupConsistent: boolean;
  /** Evidence confidence for this emerging setup. */
  evidenceConfidence: EvidenceConfidence;
  /** ISO timestamp of computation. */
  computedAt: string;
}

// ── Equity Universe (spec §2) ─────────────────────────────────────────────────

/**
 * A single entry in the supported equity universe.
 * Used to enumerate DISCOVERABLE companies for proactive catalyst screening.
 *
 * The universe enables PATH A (scheduled event) discovery for companies
 * NOT yet in the portfolio, Opportunity Finder, or Company Monitor.
 */
export interface EquityUniverseEntry {
  ticker: string;
  company: string;
  exchange: string;
  country: string;
  currency: string;
  sector: string | null;
  industry: string | null;
  /** Saxo UIC identifier (if known). */
  uic: number | null;
  /** Whether this instrument can be traded via Saxo. */
  tradeable: boolean;
  /** Whether this equity is currently active (not delisted). */
  active: boolean;
  /** How this entry was added to the universe. */
  source: "STATIC_SEED" | "SAXO_DISCOVERY" | "REPOSITORY_DISCOVERY";
}

// ── Catalyst Promotion (spec §18) ─────────────────────────────────────────────

/**
 * Compact promotion record written when Catalyst Intelligence promotes
 * a company to Opportunity Finder consideration.
 * Repository key: "catalyst-promotions"
 */
export interface CatalystPromotion {
  ticker: string;
  company: string;
  promotedAt: string;
  triggerType: TriggerType;
  /** Event date if PATH A; null for PATH B. */
  eventDate: string | null;
  /** Event type if PATH A; null for PATH B. */
  eventType: ScheduledCatalystType | null;
  catalystDirection: CatalystDirection;
  evidenceConfidence: EvidenceConfidence;
  expectationGap: ExpectationGap;
  priceAsymmetry: PriceAsymmetry;
  opportunityState: PreEventOpportunityState;
  /** IDs of signals that supported the promotion decision. */
  keySignalIds: string[];
  keyRisks: string[];
  thesis: string;
  invalidationConditions: string[];
  /** Whether this promotion has been acknowledged by Opportunity Finder. */
  acknowledgedAt: string | null;
  /** Whether this promotion has expired (event passed / setup resolved). */
  expired: boolean;
  expiresAt: string | null;
}

// ── Extended Catalyst Analysis Result (Part 2 — replaces Part 1 placeholder) ──

/**
 * Structured output from the deep Catalyst Intelligence AI analysis.
 *
 * AI must reference actual stored signal IDs (supportingSignalIds,
 * contradictingSignalIds) — invented evidence is not permitted.
 *
 * The analysis update type tracks whether this is a new full analysis,
 * an incremental update, or a no-change confirmation.
 */
export interface CatalystAnalysisResult {
  triggerType: TriggerType;
  catalystType: ScheduledCatalystType | "EMERGING_SETUP" | null;
  /** Event ID if triggered by a CompanySpecificEvent; null otherwise. */
  eventId: string | null;

  // ── Core qualitative dimensions ────────────────────────────────────────────
  catalystDirection: CatalystDirection;
  evidenceConfidence: EvidenceConfidence;
  expectationGap: ExpectationGap;
  priceAsymmetry: PriceAsymmetry;
  alreadyPricedIn: AlreadyPricedIn;
  catalystRisk: CatalystRisk;
  opportunityState: PreEventOpportunityState;
  temporaryVsStructural: TemporaryVsStructural;

  // ── Earnings-specific (null for non-earnings) ──────────────────────────────
  earningsSurpriseSignal: EarningsSurpriseSignal | null;

  // ── Reasoning ─────────────────────────────────────────────────────────────
  thesis: string;
  whatMarketMayBeMissing: string | null;
  strongestCounterargument: string;
  alreadyPricedInAssessment: string;
  invalidationConditions: string[];
  dataLimitations: string[];

  // ── Signal references (must be actual stored signal IDs) ──────────────────
  supportingSignalIds: string[];
  contradictingSignalIds: string[];

  recommendedNextStep: RecommendedNextStep;
  analysisUpdateType: AnalysisUpdateType;
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

  /** AI analysis result (null until Part 2 deep analysis runs). */
  analysis: CatalystAnalysisResult | null;

  /**
   * Material fingerprint from the last AI analysis run.
   * If unchanged → skip AI call (spec §17).
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

  // ── Part 2 additions ──────────────────────────────────────────────────────

  /** How this ticker entered the Catalyst pipeline (spec §30 debug). */
  discoverySource: DiscoverySource | null;

  /** Which trigger path produced this analysis. */
  triggerType: TriggerType | null;

  /** Signal accumulation state for PATH B (emerging setup detection). */
  signalAccumulation: SignalAccumulationState | null;

  /** Emerging setup assessment for PATH B candidates. */
  emergingSetup: EmergingSetup | null;

  /** ISO timestamp when this was promoted to Opportunity Finder. Null if not yet promoted. */
  promotedAt: string | null;

  /** Type of the most recent AI analysis update. */
  lastAnalysisUpdateType: AnalysisUpdateType | null;

  // ── Part 3 additions ──────────────────────────────────────────────────────

  /**
   * Number of consecutive analysis failures for this ticker.
   * Resets to 0 on any successful analysis.
   */
  failureCount?: number;

  /**
   * Error message from the last failed analysis attempt.
   * Null when no failure or after a successful run.
   */
  lastError?: string | null;

  /**
   * ISO timestamp when this candidate is eligible for retry after failures.
   * Uses exponential backoff. Null if not in backoff.
   */
  retryEligibleAt?: string | null;

  /**
   * ISO timestamp until which deep analysis is deferred (budget exhausted).
   * Null if not deferred.
   */
  deferredUntil?: string | null;

  /**
   * Human-readable reason for the current deferral (e.g. budget cap).
   */
  deferredReason?: string | null;

  /**
   * Whether the catalyst event has passed and a fresh post-event analysis
   * is required. Set by the pipeline when eventDate is in the past AND
   * a pre-event analysis exists. Cleared after post-event reassessment runs.
   */
  postEventAssessmentRequired?: boolean;

  /**
   * Whether this opportunity is an intentional pre-event thesis
   * (the trade exists BECAUSE of the upcoming catalyst).
   *
   * When true, Trade Decision must independently evaluate whether to enter
   * before the event. When false, the event is irrelevant to the decision.
   *
   * Per spec §8: upcoming events must NOT automatically block OR create trades.
   */
  intentionalPreEventThesis?: boolean;
}
