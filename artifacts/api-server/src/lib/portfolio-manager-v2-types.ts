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
}

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
  score: number;   // 0–100
  weight: number;  // contribution weight; weights across all sub-scores sum to 1
  reason: string;
}

export type HealthGrade = "A" | "B" | "C" | "D" | "F";

export interface PortfolioHealthScore {
  /** Weighted composite of all sub-scores, 0–100 */
  overall: number;
  grade: HealthGrade;
  subScores: HealthSubScore[];
  computedAt: string;
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
}

export interface CapitalAllocationPlan {
  availableCashBase: number;
  totalPortfolioBase: number;
  cashPercent: number;
  cashTargetPercent: number;
  /** Cash that can be deployed without breaching the cash floor */
  deployableCashBase: number;
  items: CapitalAllocationItem[];
  totalSuggestedDeploymentBase: number;
  residualCashAfterDeploymentBase: number;
  computedAt: string;
}

// ── Replacement Opportunities ─────────────────────────────────────────────────

export interface ReplacementOpportunity {
  holdingTicker: string;
  holdingCompany: string;
  holdingCurrentPercent: number;
  /** Score proxy for the holding (0–100 from portfolio analyzer attention, inverted) */
  holdingScore: number;
  candidateTicker: string;
  candidateCompany: string;
  candidateOverallScore: number;
  scoreDelta: number;
  rationale: string;
  priority: "High" | "Medium" | "Low";
}

// ── Change Explainer ──────────────────────────────────────────────────────────

export type PortfolioChangeType =
  | "AddedPosition"
  | "RemovedPosition"
  | "TargetIncreased"
  | "TargetDecreased"
  | "RoleChanged"
  | "CashTargetChanged";

export interface PortfolioChange {
  type: PortfolioChangeType;
  ticker?: string;
  description: string;
  previousValue?: number;
  newValue?: number;
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
}

// ── Top-level v2 result ───────────────────────────────────────────────────────

export interface PortfolioV2 {
  generatedAt: string;
  durationMs: number;
  /**
   * The `updatedAt` timestamp of the PortfolioSnapshot this analysis was
   * computed from. Used to detect staleness: if the current snapshot has a
   * different `updatedAt`, this v2 result belongs to an older snapshot and
   * must not be presented as analysis of the current holdings.
   */
  snapshotUpdatedAt: string;
  health: PortfolioHealthScore;
  target: TargetPortfolio;
  drift: PortfolioDriftItem[];
  capitalAllocation: CapitalAllocationPlan;
  replacements: ReplacementOpportunity[];
  changes: PortfolioChange[];
}
