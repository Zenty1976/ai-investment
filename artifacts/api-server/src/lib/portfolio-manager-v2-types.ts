/**
 * Portfolio Manager v2 — Type definitions
 *
 * All interfaces used by the CIO (Chief Investment Officer) second-pass
 * analysis that runs after every portfolio snapshot.
 */

// ── Portfolio role vocabulary ──────────────────────────────────────────────────

export type PortfolioRole =
  | "Cash"
  | "CoreHolding"
  | "GrowthCore"
  | "SpeculativeGrowth"
  | "IncomeDividend"
  | "Defensive"
  | "CyclicalExposure"
  | "InternationalDiversifier"
  | "SectorPlay"
  | "EventDriven";

// ── Allocation status & conviction ─────────────────────────────────────────────

/**
 * Lifecycle status for every target allocation.
 *
 * StrategicTarget — valid, immediately deployable long-term allocation.
 * Provisional     — company may belong in portfolio; important evidence incomplete.
 * Blocked         — a future event or critical condition prevents deployment.
 * Excluded        — considered but must not receive capital at present.
 */
export type AllocationStatus = "StrategicTarget" | "Provisional" | "Blocked" | "Excluded";

export type Conviction = "High" | "Medium" | "Low";

/** Modules that may be cited as supporting or blocking evidence. */
export type SupportingModule =
  | "PortfolioAnalyzer"
  | "RiskAnalyzer"
  | "OpportunityFinder"
  | "CompanyMonitor"
  | "TradeDecisionEngine"
  | "SectorMonitor"
  | "MarketAlerts"
  | "MarketMonitor";

// ── Target Portfolio (AI-synthesised) ─────────────────────────────────────────

export interface TargetAllocation {
  ticker: string;
  company: string;
  role: PortfolioRole;
  /** Ideal allocation as percentage of total portfolio (0–100) */
  targetPercent: number;
  minPercent: number;
  maxPercent: number;
  rationale: string;
  /** How strongly the CIO believes this allocation is correct */
  conviction: Conviction;
  /** Lifecycle status: only StrategicTarget allocations are immediately deployable */
  allocationStatus: AllocationStatus;
  /** Human-readable explanation for the chosen status */
  reasonForStatus: string;
  /** Factors that block or limit this allocation (empty array for non-Blocked statuses) */
  blockingFactors: string[];
  /** Modules whose data directly supports this allocation recommendation */
  supportingModules: SupportingModule[];
}

/**
 * Legacy allocation shape — used when reading stored targets generated before
 * strict validation was enforced (prior to v2.1).  The five structured fields
 * that are now required on TargetAllocation were previously optional.
 *
 * IMPORTANT: never use LegacyTargetAllocation as input to the capital allocation
 * engine or the synthesiser — use it only for reading/displaying historical records.
 */
export type LegacyTargetAllocation = Omit<
  TargetAllocation,
  "conviction" | "allocationStatus" | "reasonForStatus" | "blockingFactors" | "supportingModules"
> & {
  conviction?: Conviction;
  allocationStatus?: AllocationStatus;
  reasonForStatus?: string;
  blockingFactors?: string[];
  supportingModules?: SupportingModule[];
};

/**
 * Legacy portfolio shape — TargetPortfolio whose allocations may be incomplete.
 * Use for test fixtures that intentionally omit required fields, or when reading
 * pre-v2.1 stored data.
 */
export type LegacyTargetPortfolio = Omit<TargetPortfolio, "allocations"> & {
  allocations: LegacyTargetAllocation[];
};

export interface TargetPortfolio {
  generatedAt: string;
  /** Sum of all targetPercent values across allocations (excludes cash) */
  totalEquityTargetPercent: number;
  cashTargetPercent: number;
  allocations: TargetAllocation[];
  strategicRationale: string;
  keyAssumptions: string[];
}

// ── Portfolio Health Score (deterministic, no AI) ─────────────────────────────

export interface HealthSubScore {
  name: string;
  score: number;    // 0–100
  weight: number;   // contribution weight; weights across all sub-scores sum to 1
  reason: string;
  /** True when the score is unreliable due to missing/sparse input data */
  lowConfidence?: boolean;
}

export type HealthGrade = "A" | "B" | "C" | "D" | "F";

export interface PortfolioHealthScore {
  /** Weighted composite of all sub-scores, 0–100 */
  overall: number;
  grade: HealthGrade;
  subScores: HealthSubScore[];
  computedAt: string;
  /** % of positions that have a real sector classification (not Unknown) */
  classifiedPositionPercent: number;
  /** % of portfolio market value in positions with Unknown sector */
  unknownSectorPercent: number;
  /** Confidence in sector-based scores */
  sectorCoverageConfidence: "High" | "Medium" | "Low";
}

// ── Drift Detection ───────────────────────────────────────────────────────────

export type DriftType =
  | "Overweight"
  | "Underweight"
  | "Missing"
  | "Excess"
  | "CashTooHigh"
  | "CashTooLow"
  | "SectorOverweight"
  | "SectorUnderweight";

export interface PortfolioDriftItem {
  type: DriftType;
  /** Set for position-level drifts */
  ticker?: string;
  /** Set for sector-level drifts */
  sector?: string;
  currentPercent: number;
  targetPercent: number;
  /** currentPercent - targetPercent (positive = overweight) */
  deviationPercent: number;
  severity: "High" | "Medium" | "Low";
  /** Human-readable suggested action, e.g. "Trim AAPL from 15% to 10%" */
  action: string;
}

// ── Capital Allocation Plan ───────────────────────────────────────────────────

export interface CapitalAllocationItem {
  ticker: string;
  company: string;
  role: PortfolioRole;
  currentPercent: number;
  targetPercent: number;
  gapPercent: number;
  /** Suggested deployment amount in base currency */
  suggestedAmountBase: number;
  priority: "High" | "Medium" | "Low";
  rationale: string;
  allocationStatus?: AllocationStatus;
  /** Present on blocked items — explains why cash cannot be deployed here now */
  blockingReason?: string;
}

export interface CapitalAllocationPlan {
  availableCashBase: number;
  totalPortfolioBase: number;
  cashPercent: number;
  cashTargetPercent: number;
  /** Cash that can be deployed without breaching the cash floor */
  deployableCashBase: number;
  /**
   * Backward-compatible alias — always equal to actionableItems.
   * Existing consumers that read `plan.items` continue to work.
   */
  items: CapitalAllocationItem[];
  /** StrategicTarget allocations ready for immediate deployment */
  actionableItems: CapitalAllocationItem[];
  /** Allocations with Blocked status or a blocking TDE condition */
  blockedItems: CapitalAllocationItem[];
  /** Allocations with Provisional status — visible gap but no deployment suggested */
  provisionalItems: CapitalAllocationItem[];
  /**
   * Allocations with Excluded status — CIO deliberately omitted these from capital deployment.
   * Excluded is distinct from Provisional: no evidence is expected to change the decision.
   */
  excludedItems: CapitalAllocationItem[];
  /** Sum of suggestedAmountBase for actionableItems only */
  totalSuggestedDeploymentBase: number;
  residualCashAfterDeploymentBase: number;
  computedAt: string;
}

// ── Replacement Opportunities ─────────────────────────────────────────────────

export interface ReplacementOpportunity {
  holdingTicker: string;
  holdingCompany: string;
  holdingCurrentPercent: number;
  /** Composite holding quality score (0–100) */
  holdingScore: number;
  holdingCaseStrength?: number;
  holdingInvestmentView?: string;
  holdingThesisDirection?: string;
  candidateTicker: string;
  candidateCompany: string;
  candidateOverallScore: number;
  candidateCaseStrength?: number;
  candidateInvestmentView?: string;
  scoreDelta: number;
  rationale: string;
  priority: "High" | "Medium" | "Low";
  /**
   * True when Company Monitor is missing for either side, Trade Decision is missing
   * for the candidate, or the candidate is not ReadyForReview.
   * A provisional comparison is a research idea, not a validated recommendation.
   */
  isProvisional: boolean;
  /**
   * Human-readable reasons why this comparison is provisional.
   * Empty array when isProvisional is false.
   */
  provisionalReasons: string[];
}

// ── Change Explainer ──────────────────────────────────────────────────────────

export type PortfolioChangeType =
  | "AddedPosition"
  | "RemovedPosition"
  | "TargetIncreased"
  | "TargetDecreased"
  | "RoleChanged"
  | "CashTargetChanged"
  | "StatusChanged"
  | "ConvictionChanged";

export interface PortfolioChange {
  type: PortfolioChangeType;
  ticker?: string;
  description: string;
  previousValue?: number;
  newValue?: number;
}

// ── Source Provenance ─────────────────────────────────────────────────────────

/**
 * Records which modules were consulted and how fresh their data was
 * at the time of a CIO target-portfolio synthesis.
 */
export interface PortfolioV2Provenance {
  /** All module keys that were read (regardless of freshness) */
  sourceModulesUsed: string[];
  /** updatedAt / savedAt timestamps for each consulted module */
  sourceUpdatedAt: Record<string, string>;
  /** Module keys whose data was older than the staleness threshold */
  staleSources: string[];
  /** Module keys expected by the CIO pass but absent from the repository */
  missingSources: string[];
  /**
   * Composite confidence in the resulting target portfolio.
   * High   — all critical sources present and fresh.
   * Medium — some secondary sources stale or absent.
   * Low    — critical sources (Portfolio Analyzer / Risk) missing or stale.
   */
  targetConfidence: "High" | "Medium" | "Low";
  /**
   * Deterministic hash of the material CIO inputs.
   * If unchanged on the next run, the AI target synthesis is skipped
   * and only deterministic downstream components are recomputed.
   */
  inputFingerprint: string;
}

// ── History ───────────────────────────────────────────────────────────────────

export interface PortfolioV2HistoryEntry {
  snapshotAt: string;
  healthOverall: number;
  healthGrade: HealthGrade;
  driftItemCount: number;
  highSeverityDriftCount: number;
  cashPercent: number;
  cashTargetPercent: number;
  totalValue: number | null;
  positionCount: number;
  // Richer fields added in v2.1
  targetFingerprint?: string;
  targetConfidence?: "High" | "Medium" | "Low";
  /** Compact snapshot of target allocations at time of entry */
  targetAllocations?: Array<{
    ticker: string;
    percent: number;
    role: string;
    status: string;
  }>;
  /** e.g. "7/8 sources fresh" */
  sourceFreshnessSummary?: string;
  /** Top changes vs previous target */
  majorChanges?: string[];
  /** First 120 chars of strategicRationale */
  strategicRationaleSummary?: string;
}

// ── Top-level v2 result ───────────────────────────────────────────────────────

export interface PortfolioV2 {
  generatedAt: string;
  durationMs: number;
  /**
   * The `updatedAt` timestamp of the PortfolioSnapshot this analysis was
   * computed from. Used to detect staleness.
   */
  snapshotUpdatedAt: string;
  health: PortfolioHealthScore;
  target: TargetPortfolio;
  drift: PortfolioDriftItem[];
  capitalAllocation: CapitalAllocationPlan;
  replacements: ReplacementOpportunity[];
  changes: PortfolioChange[];
  /** Source provenance and fingerprint for this CIO pass */
  provenance?: PortfolioV2Provenance;
}
