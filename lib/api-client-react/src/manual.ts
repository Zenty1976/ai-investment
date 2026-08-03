/**
 * Manually maintained client hooks and types for routes that are not (yet)
 * represented in the OpenAPI spec at lib/api-spec/openapi.yaml.
 *
 * Do NOT place generated types here. Generated types live in src/generated/.
 * Add hooks/types here when a route needs a React hook but the endpoint hasn't
 * been added to the OpenAPI spec.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";
import type { SectorItem } from "./generated/api.schemas";

// ── Re-exports for backwards-compat aliases ───────────────────────────────────

/** Alias for SectorItem — the SectorMonitor page imports it as "Sector" */
export type Sector = SectorItem;

// ── Saxo Bank types ───────────────────────────────────────────────────────────
// These were not added to the OpenAPI spec, so codegen does not generate them.

export type SaxoEnvironment = "sim" | "live";

export interface SaxoStatus {
  configured: boolean;
  appKeyConfigured: boolean;
  appSecretConfigured: boolean;
  connected: boolean;
  environment: SaxoEnvironment;
  /** Auto-detected callback URL built from REPLIT_DEV_DOMAIN on the server */
  detectedCallbackUrl: string;
  redirectUrlOverride?: string;
  expiresAt?: string;
  connectedAt?: string;
  error?: string;
  /** Development/debug flag — use mock Saxo data instead of real API calls */
  useMockData: boolean;
}

// ── Portfolio Manager types ───────────────────────────────────────────────────

export interface PortfolioPosition {
  id: string;
  name: string;
  symbol: string;
  assetType: string;
  exchange: string;
  currency: string;
  accountKey: string;
  quantity: number;
  direction: string;
  averageOpenPrice: number;
  currentPrice: number;
  marketValue: number;
  marketValueBaseCurrency: number;
  profitLoss: number;
  dayChangePercent: number;
  priceDelayMinutes: number;
  isMarketOpen: boolean;
}

export interface PortfolioAccount {
  accountKey: string;
  accountId: string;
  accountName: string;
  accountType: string;
  currency: string;
  availableCash: number;
  accountValue: number;
  unrealizedProfitLoss: number;
  positions: PortfolioPosition[];
}

export interface PortfolioSnapshot {
  updatedAt: string;
  environment: SaxoEnvironment;
  baseCurrency: string;
  totalValue: number | null;
  totalAvailableCash: number | null;
  totalUnrealizedProfitLoss: number;
  accounts: PortfolioAccount[];
  isMockData?: boolean;
}

// ── Portfolio Manager ─────────────────────────────────────────────────────────

export function useGetPortfolio() {
  return useQuery({
    queryKey: ["portfolio"],
    queryFn: () => customFetch<PortfolioSnapshot | null>("/api/portfolio-manager"),
  });
}

export function useUpdatePortfolio(options?: {
  mutation?: Parameters<typeof useMutation>[0];
}) {
  return useMutation({
    mutationFn: () =>
      customFetch<PortfolioSnapshot>("/api/portfolio-manager/update", {
        method: "POST",
      }),
    ...(options?.mutation ?? {}),
  });
}

// ── Portfolio Analyzer ────────────────────────────────────────────────────────

export interface PortfolioAnalysis {
  mainConclusion: { title: string; reason: string };
  scoreDrivers: Array<{ factor: string; impact: "Positive" | "Negative"; reason: string }>;
  executiveSummary: string;
  overallRating: "Excellent" | "Good" | "Fair" | "Weak";
  overallOutlook: "Bullish" | "Moderately Bullish" | "Neutral" | "Moderately Bearish" | "Bearish";
  portfolioScore: number;
  strengths: string[];
  weaknesses: string[];
  topRisks: Array<{ title: string; reason: string; severity: "High" | "Medium" | "Low" }>;
  topOpportunities: Array<{ title: string; reason: string; confidence: "High" | "Medium" | "Low" }>;
  sectorAssessment: string;
  positionComments: Array<{ ticker: string; summary: string; attention: "High" | "Medium" | "Low" }>;
  recommendedActions: Array<{ action: string; reason: string; priority: "High" | "Medium" | "Low" }>;
  thingsToWatch: string[];
  timestamp: string;
  analysisDuration: number;
}

export function useRunPortfolioAnalysis(options?: {
  mutation?: Parameters<typeof useMutation>[0];
}) {
  return useMutation({
    mutationFn: () =>
      customFetch<PortfolioAnalysis>("/api/portfolio-analyzer/analyze", {
        method: "POST",
      }),
    ...(options?.mutation ?? {}),
  });
}

// ── Opportunity Finder ────────────────────────────────────────────────────────

export interface OpportunityFinderOpportunity {
  rank: number;
  company: string;
  ticker: string;
  exchange: string;
  sector: string;
  country: string;
  overallScore: number;
  portfolioFit: number;
  diversificationBenefit: number;
  sectorMacroFit: number;
  timing: number;
  riskReward: number;
  scoreReason: string;
  investmentThesis: string[];
  whyNow: string[];
  whyThisPortfolio: string[];
  mainCatalyst: string;
  catalystDate: string;
  mainRisk: string;
  confidence: "High" | "Medium" | "Low";
  priority: "High" | "Medium" | "Low";
  positionSizeSuitability: "Small" | "Medium" | "Large";
  positionSizeReason: string;
  companyAnalysisAvailable: boolean;
  status?: "New" | "Up" | "Down" | "Unchanged";
  sources: Array<{ title: string; url: string; published: string }>;
}

export interface OpportunityAnalysis {
  executiveSummary: string;
  overallOpportunityLevel: "High" | "Medium" | "Low";
  topOpportunities: OpportunityFinderOpportunity[];
  sectorIdeas: Array<{ sector: string; reason: string }>;
  thingsToResearch: string[];
  timestamp: string;
  analysisDuration: number;
}

export function useRunOpportunityAnalysis(options?: {
  mutation?: Parameters<typeof useMutation>[0];
}) {
  return useMutation({
    mutationFn: () =>
      customFetch<OpportunityAnalysis>("/api/opportunity-finder/analyze", {
        method: "POST",
      }),
    ...(options?.mutation ?? {}),
  });
}

// ── Risk Analyzer ─────────────────────────────────────────────────────────────

export type RiskCategory =
  | "Concentration" | "Company" | "Sector" | "Macro"
  | "Currency" | "Liquidity" | "Event" | "Geopolitical" | "Diversification";

export interface RiskProfileItem {
  category: RiskCategory;
  score: number;
  level: "Low" | "Moderate" | "High";
  reason: string;
}

export interface RiskItem {
  title: string;
  category: RiskCategory;
  probability: "Low" | "Medium" | "High";
  severity: "Low" | "Medium" | "High";
  timeHorizon: "Immediate" | "Weeks" | "Months";
  eventDate: string;
  affectedHoldings: string[];
  reason: string;
  portfolioImpact: string;
  interactionWithOtherRisks: string;
  monitor: string;
  /** Server-added — whether this risk is New, Increased, Reduced or Unchanged */
  status?: "New" | "Increased" | "Reduced" | "Unchanged";
}

export interface RiskInteraction {
  title: string;
  reason: string;
  affectedHoldings: string[];
  severity: "Low" | "Medium" | "High";
}

export interface ResolvedRisk {
  title: string;
  category: RiskCategory;
  severity: "Low" | "Medium" | "High";
  probability: "Low" | "Medium" | "High";
}

export interface RiskAnalysis {
  executiveSummary: string;
  overallRiskLevel: "Low" | "Moderate" | "High";
  mainConclusion: { title: string; reason: string };
  riskScore: number;
  scoreDrivers: Array<{ factor: string; impact: "Positive" | "Negative"; reason: string }>;
  riskProfile: RiskProfileItem[];
  topRisks: RiskItem[];
  riskInteractions: RiskInteraction[];
  portfolioWeaknesses: string[];
  portfolioStrengths: string[];
  watchClosely: string[];
  previousRiskScore?: number;
  resolvedRisks?: ResolvedRisk[];
  timestamp: string;
  analysisDuration: number;
}

export function useRunRiskAnalysis(options?: {
  mutation?: Parameters<typeof useMutation>[0];
}) {
  return useMutation({
    mutationFn: () =>
      customFetch<RiskAnalysis>("/api/risk-analyzer/analyze", { method: "POST" }),
    ...(options?.mutation ?? {}),
  });
}

// ── Market Alerts ─────────────────────────────────────────────────────────────

export interface MarketAlert {
  title: string;
  category: "Portfolio" | "Company" | "Macro" | "Sector" | "Event" | "Geopolitical" | "Currency";
  importance: "High" | "Medium" | "Low";
  isNew: boolean;
  requiresAttention: boolean;
  affectedHoldings: string[];
  summary: string;
  whyItMatters: string;
  recommendedAttention: "Monitor" | "Review" | "Prepare" | "Watch";
  sourceType: "Web" | "NewsMonitor" | "CompanyMonitor" | "EventMonitor";
  /** Server-added status */
  status?: "New" | "Updated" | "Unchanged";
}

export interface MarketAlertsAnalysis {
  overallAlertLevel: "High" | "Medium" | "Low";
  executiveSummary: string;
  headline: string;
  alerts: MarketAlert[];
  thingsToWatch: string[];
  nothingImportantChanged: boolean;
  timestamp: string;
  analysisDuration: number;
}

export function useRunMarketAlerts(options?: {
  mutation?: Parameters<typeof useMutation>[0];
}) {
  return useMutation({
    mutationFn: () =>
      customFetch<MarketAlertsAnalysis>("/api/market-alerts/analyze", { method: "POST" }),
    ...(options?.mutation ?? {}),
  });
}

// ── Trade Decision Engine ─────────────────────────────────────────────────────

export type TradeDecisionType =
  | "Hold" | "Review" | "WaitForEvent" | "PrepareToBuy" | "PrepareToReduce" | "NoAction";

export type TradeDecisionPosture =
  | "ActivelyReview" | "SelectivePreparation" | "WaitForEvents"
  | "MaintainCurrentPositioning" | "InsufficientEvidence";

export type TradeDecisionConfidence = "High" | "Medium" | "Low";
export type TradeDecisionUrgency = "Immediate" | "Days" | "Weeks" | "NoUrgency";
export type TradeDecisionStatus = "New" | "Changed" | "Unchanged";
export type TradeDecisionReadiness = "WaitingForReevaluation" | "ReadyForReview" | "Informational";

export interface TradeDecision {
  rank: number;
  subjectType: "Holding" | "Opportunity" | "Portfolio";
  company: string;
  ticker: string;
  decision: TradeDecisionType;
  title: string;
  reason: string;
  supportingEvidence: string[];
  opposingEvidence: string[];
  confidence: TradeDecisionConfidence;
  urgency: TradeDecisionUrgency;
  blockedByEvent: boolean;
  blockingEvent: string;
  blockingEventDate: string;
  whatWouldChangeDecision: string[];
  missingEvidence: string[];
  portfolioImpact: string;
  accountConsiderations: string;
  sourceModules: string[];
  targetAllocationPercent: number;
  maximumAllocationPercent: number;
  sizingConfidence: TradeDecisionConfidence | "";
  sizingReason: string;
  /** Server-added */
  status?: TradeDecisionStatus;
  /** Server-added */
  readiness?: TradeDecisionReadiness;
  /** Server-added */
  readinessReason?: string;
}

export interface TradeDecisionEngineAnalysis {
  mainConclusion: { title: string; reason: string };
  executiveSummary: string;
  overallDecisionPosture: TradeDecisionPosture;
  decisionReadinessScore: number;
  readinessDrivers: Array<{ factor: string; impact: "Positive" | "Negative"; reason: string }>;
  decisions: TradeDecision[];
  conflictsResolved: Array<{ topic: string; conflict: string; resolution: string }>;
  nextReviewTriggers: Array<{ trigger: string; date: string; affectedDecisions: string[] }>;
  timestamp: string;
  analysisDuration: number;
}

export function useRunTradeDecisionEngine(options?: {
  mutation?: Parameters<typeof useMutation>[0];
}) {
  return useMutation({
    mutationFn: () =>
      customFetch<TradeDecisionEngineAnalysis>("/api/trade-decision-engine/analyze", {
        method: "POST",
      }),
    ...(options?.mutation ?? {}),
  });
}

// ── Trade Review ──────────────────────────────────────────────────────────────

export type TradeProposalStatus =
  | "Waiting" | "Ready" | "Approved" | "Rejected" | "Executed" | "Cancelled" | "Superseded";

export interface TradeProposal {
  id: string;
  decisionId: string;
  action: "BUY" | "SELL";
  ticker: string;
  company: string;
  quantity: number;
  estimatedPrice: number;
  estimatedValue: number;
  currency: string;
  targetAllocationPercent: number;
  currentAllocationPercent: number;
  resultingAllocationPercent: number;
  availableCashAfterTrade: number | null;
  confidence: "High" | "Medium" | "Low";
  urgency: "Immediate" | "Days" | "Weeks" | "NoUrgency";
  shortReason: string;
  reasonScore: number;
  status: TradeProposalStatus;
  decisionTitle: string;
  decisionRank: number;
  sourceModules: string[];
  blockedByEvent: boolean;
  blockingEvent: string;
  blockingEventDate: string;
  sizingUnavailableReason: string | null;
  fxRate: number;
  currentPositionValueBase: number;
  sizingReason: string;
  sizingConfidence: "High" | "Medium" | "Low" | "";
  createdAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  executedAt: string | null;
  tdeTimestamp: string;
}

export interface WaitingTradeDecision {
  id: string;
  action: "BUY" | "SELL";
  ticker: string;
  company: string;
  waitingLabel: string;
  blockingEvent: string;
  blockingEventDate: string;
  readinessReason: string;
  decisionRank: number;
}

export interface TradeReviewResponse {
  proposals: TradeProposal[];
  waitingDecisions: WaitingTradeDecision[];
  tdeTimestamp: string | null;
}

export function useGetTradeReview() {
  return useQuery({
    queryKey: ["trade-review"],
    queryFn: () => customFetch<TradeReviewResponse>("/api/trade-review"),
  });
}

export function useUpdateTradeProposalStatus(options?: {
  mutation?: Parameters<typeof useMutation>[0];
}) {
  return useMutation({
    mutationFn: ({
      id,
      status,
    }: {
      id: string;
      status: "Approved" | "Rejected" | "Cancelled";
    }) =>
      customFetch<TradeProposal>(`/api/trade-review/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }),
    ...(options?.mutation ?? {}),
  });
}

// ── Saxo Bank ─────────────────────────────────────────────────────────────────

export function useGetSaxoStatus() {
  return useQuery({
    queryKey: ["saxo-status"],
    queryFn: () => customFetch<SaxoStatus>("/api/settings/saxo/status"),
  });
}

export function useSaxoSaveConfig(options?: {
  mutation?: Parameters<typeof useMutation>[0];
}) {
  return useMutation({
    mutationFn: (body: { redirectUrlOverride?: string }) =>
      customFetch<SaxoStatus>("/api/settings/saxo/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ...(options?.mutation ?? {}),
  });
}

export function useSaxoLogin(options?: {
  mutation?: Parameters<typeof useMutation>[0];
}) {
  return useMutation({
    mutationFn: (body: { redirectUrl: string; returnUrl: string }) =>
      customFetch<{ authUrl: string }>("/api/settings/saxo/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ...(options?.mutation ?? {}),
  });
}

export function useSaxoLogout(options?: {
  mutation?: Parameters<typeof useMutation>[0];
}) {
  return useMutation({
    mutationFn: () =>
      customFetch<SaxoStatus>("/api/settings/saxo/logout", { method: "POST" }),
    ...(options?.mutation ?? {}),
  });
}

export function useSaxoSetEnvironment(options?: {
  mutation?: Parameters<typeof useMutation>[0];
}) {
  return useMutation({
    mutationFn: (body: { environment: "sim" | "live" }) =>
      customFetch<SaxoStatus>("/api/settings/saxo/environment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ...(options?.mutation ?? {}),
  });
}

export function useSaxoSetMock(options?: {
  mutation?: Parameters<typeof useMutation>[0];
}) {
  return useMutation({
    mutationFn: (body: { useMockData: boolean }) =>
      customFetch<SaxoStatus>("/api/settings/saxo/mock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ...(options?.mutation ?? {}),
  });
}

// ── Company Monitor — reset ───────────────────────────────────────────────────

export function useResetCompanyMonitorData(options?: {
  mutation?: Parameters<typeof useMutation>[0];
}) {
  return useMutation({
    mutationFn: () =>
      customFetch<{
        deletedEntries: number;
        deletedAnalyses: number;
        deletedHistoryEntries: number;
        message: string;
      }>("/api/company-monitor/reset", { method: "DELETE" }),
    ...(options?.mutation ?? {}),
  });
}

// ── System Log ───────────────────────────────────────────────────────────────

export type SystemLogLevel = "user" | "info" | "warning" | "error" | "internal";

export interface SystemLogEntry {
  id: string;
  timestamp: string;
  module: string;
  level: SystemLogLevel;
  message: string;
}

export const getGetSystemLogQueryKey = () => ["system-log"] as const;

export function useGetSystemLog(options?: {
  query?: Parameters<typeof useQuery>[0];
}) {
  return useQuery({
    queryKey: getGetSystemLogQueryKey(),
    queryFn: () => customFetch<SystemLogEntry[]>("/api/system-log"),
    ...(options?.query ?? {}),
  });
}

export function useClearSystemLog(options?: {
  mutation?: Parameters<typeof useMutation>[0];
}) {
  return useMutation({
    mutationFn: () =>
      customFetch<{ ok: boolean }>("/api/system-log", { method: "DELETE" }),
    ...(options?.mutation ?? {}),
  });
}

// ── Automation Orchestrator ───────────────────────────────────────────────────

export type AutomationMode = "Manual" | "SemiAutomatic" | "FullAutomatic";

export type ModuleFreshness =
  | "Fresh" | "DueSoon" | "Stale" | "Running" | "Failed"
  | "Disabled" | "WaitingForDependency" | "NeverRun";

export type OrchestratorModuleId =
  | "portfolio-manager" | "market-monitor" | "news-monitor" | "event-monitor"
  | "sector-monitor" | "company-monitor" | "market-alerts" | "risk-analyzer"
  | "portfolio-analyzer" | "opportunity-finder" | "trade-decision-engine" | "trade-review";

export interface OrchestratorModuleSettings {
  enabled: boolean;
  supportsAutomaticRun: boolean;
  intervalMinutes: number;
  staleAfterMinutes: number;
  priority: number;
}

export interface OrchestratorModuleStatus {
  moduleId: OrchestratorModuleId;
  displayName: string;
  freshness: ModuleFreshness;
  settings: OrchestratorModuleSettings;
  defaults: {
    scheduleType: "fixed" | "trigger" | "after";
    minimumIntervalMinutes: number;
    maximumIntervalMinutes: number;
    dependencies: OrchestratorModuleId[];
    runAfter: OrchestratorModuleId[];
  };
  runtime: {
    status: "Idle" | "Running" | "Failed" | "Disabled";
    lastRunAt: string | null;
    lastSuccessfulRunAt: string | null;
    nextRunAt: string | null;
    lastError: string | null;
    currentJobId: string | null;
    waitingForDeps: OrchestratorModuleId[];
  };
  lastUpdatedAt: string | null;
  nextRunAt: string | null;
  companyMonitorAggregate?: {
    targetCount: number;
    freshTargetCount: number;
    staleTargetCount: number;
    missingTargetCount: number;
    staleOrMissingTickers: string[];
  };
}

export interface OrchestratorJob {
  id: string;
  correlationId: string;
  moduleId: OrchestratorModuleId;
  ticker?: string;
  trigger: string;
  status: "Pending" | "Running" | "Completed" | "Failed" | "Cancelled" | "Skipped" | "WaitingForDependency";
  priority: number;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  attempt: number;
  maxAttempts: number;
  error: string | null;
  affectedTickers: string[];
  parentJobId: string | null;
  resultUpdated?: boolean;
  meaningfulChange?: "None" | "Low" | "Medium" | "High";
}

export interface OrchestratorStatus {
  mode: AutomationMode;
  paused: boolean;
  modules: OrchestratorModuleStatus[];
  jobs: OrchestratorJob[];
  stats: {
    running: number;
    stale: number;
    failed: number;
    analysesToday: number;
    failedToday: number;
    nextScheduledJobAt: string | null;
  };
  lastFullCycleAt: string | null;
  cycleInProgress: boolean;
  activeCycleCorrelationId: string | null;
  cycleHistory: Array<{
    id: string;
    correlationId: string;
    trigger: string;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
    status: "InProgress" | "Completed" | "Failed" | "Aborted";
    failedModuleId?: OrchestratorModuleId;
    error?: string;
    completedModules: OrchestratorModuleId[];
  }>;
}
