/**
 * Manually maintained Zod schemas for server routes that are not (yet)
 * represented in the OpenAPI spec at lib/api-spec/openapi.yaml.
 *
 * Do NOT place generated types here. Generated types live in src/generated/.
 * Add schemas here when a route needs Zod validation but the endpoint hasn't
 * been added to the OpenAPI spec.
 */
import * as zod from "zod";

// ── Portfolio Analyzer ────────────────────────────────────────────────────────

export const RunPortfolioAnalysisResponse = zod.object({
  mainConclusion: zod.object({
    title: zod.string(),
    reason: zod.string(),
  }),
  scoreDrivers: zod
    .array(
      zod.object({
        factor: zod.string(),
        impact: zod.enum(["Positive", "Negative", "Neutral"]),
        reason: zod.string(),
      })
    )
    .min(3)
    .max(6),
  executiveSummary: zod.string(),
  overallRating: zod.enum(["Excellent", "Good", "Fair", "Weak"]),
  overallOutlook: zod.enum([
    "Bullish",
    "Moderately Bullish",
    "Neutral",
    "Moderately Bearish",
    "Bearish",
  ]),
  portfolioScore: zod.number().int().min(0).max(100),
  strengths: zod.array(zod.string()),
  weaknesses: zod.array(zod.string()),
  topRisks: zod.array(
    zod.object({
      title: zod.string(),
      reason: zod.string(),
      severity: zod.enum(["High", "Medium", "Low"]),
    })
  ),
  topOpportunities: zod.array(
    zod.object({
      title: zod.string(),
      reason: zod.string(),
      confidence: zod.enum(["High", "Medium", "Low"]),
    })
  ),
  sectorAssessment: zod.string(),
  positionComments: zod.array(
    zod.object({
      ticker: zod.string(),
      summary: zod.string(),
      attention: zod.enum(["High", "Medium", "Low"]),
    })
  ),
  recommendedActions: zod.array(
    zod.object({
      action: zod.string(),
      reason: zod.string(),
      priority: zod.enum(["High", "Medium", "Low"]),
    })
  ),
  thingsToWatch: zod.array(zod.string()),
  timestamp: zod.string(),
  analysisDuration: zod
    .number()
    .describe("Time taken to complete the analysis in milliseconds"),
});

// ── Opportunity Finder ────────────────────────────────────────────────────────

export const RunOpportunityFinderResponse = zod.object({
  executiveSummary: zod.string(),
  overallOpportunityLevel: zod.enum(["High", "Medium", "Low"]),
  topOpportunities: zod.array(
    zod.object({
      rank: zod.number().int().min(1),
      company: zod.string(),
      ticker: zod.string(),
      exchange: zod.string(),
      sector: zod.string(),
      country: zod.string(),
      overallScore: zod.number().int().min(0).max(100),
      portfolioFit: zod.number().int().min(1).max(5),
      diversificationBenefit: zod.number().int().min(1).max(5),
      sectorMacroFit: zod.number().int().min(1).max(5),
      timing: zod.number().int().min(1).max(5),
      riskReward: zod.number().int().min(1).max(5),
      scoreReason: zod.string(),
      investmentThesis: zod.array(zod.string()).min(1).max(3),
      whyNow: zod.array(zod.string()).min(1).max(3),
      whyThisPortfolio: zod.array(zod.string()).min(1).max(3),
      mainCatalyst: zod.string(),
      catalystDate: zod.string(),
      mainRisk: zod.string(),
      confidence: zod.enum(["High", "Medium", "Low"]),
      priority: zod.enum(["High", "Medium", "Low"]),
      positionSizeSuitability: zod.enum(["Small", "Medium", "Large"]),
      positionSizeReason: zod.string(),
      companyAnalysisAvailable: zod.boolean(),
      sources: zod.array(
        zod.object({
          title: zod.string(),
          url: zod.string(),
          published: zod.string(),
        })
      ),
    })
  ),
  sectorIdeas: zod.array(
    zod.object({
      sector: zod.string(),
      reason: zod.string(),
    })
  ),
  thingsToResearch: zod.array(zod.string()),
  timestamp: zod.string(),
  analysisDuration: zod
    .number()
    .describe("Time taken to complete the analysis in milliseconds"),
});

// ── Risk Analyzer ─────────────────────────────────────────────────────────────

const RiskLevelEnum = zod.enum(["Low", "Moderate", "High"]);
const ImpactEnum = zod.enum(["Low", "Medium", "High"]);

export const RunRiskAnalyzerResponse = zod.object({
  executiveSummary: zod.string(),
  overallRiskLevel: RiskLevelEnum,
  mainConclusion: zod.object({
    title: zod.string(),
    reason: zod.string(),
  }),
  riskScore: zod.number().int().min(0).max(100),
  scoreDrivers: zod.array(
    zod.object({
      factor: zod.string(),
      impact: zod.enum(["Positive", "Negative", "Neutral"]),
      reason: zod.string(),
    })
  ),
  riskProfile: zod.array(
    zod.object({
      category: zod.enum([
        "Concentration",
        "Company",
        "Sector",
        "Macro",
        "Currency",
        "Liquidity",
        "Event",
        "Geopolitical",
        "Diversification",
      ]),
      score: zod.number().int().min(0).max(100),
      level: RiskLevelEnum,
      reason: zod.string(),
    })
  ),
  topRisks: zod.array(
    zod.object({
      title: zod.string(),
      category: zod.enum([
        "Concentration",
        "Company",
        "Sector",
        "Macro",
        "Currency",
        "Liquidity",
        "Event",
        "Geopolitical",
        "Diversification",
      ]),
      probability: ImpactEnum,
      severity: ImpactEnum,
      timeHorizon: zod.enum(["Immediate", "Weeks", "Months"]),
      eventDate: zod.string(),
      affectedHoldings: zod.array(zod.string()),
      reason: zod.string(),
      portfolioImpact: zod.string(),
      interactionWithOtherRisks: zod.string(),
      monitor: zod.string(),
    })
  ),
  riskInteractions: zod.array(
    zod.object({
      title: zod.string(),
      reason: zod.string(),
      affectedHoldings: zod.array(zod.string()),
      severity: ImpactEnum,
    })
  ),
  portfolioWeaknesses: zod.array(zod.string()),
  portfolioStrengths: zod.array(zod.string()),
  watchClosely: zod.array(zod.string()),
  timestamp: zod.string(),
  analysisDuration: zod
    .number()
    .describe("Time taken to complete the analysis in milliseconds"),
});

// ── Market Alerts ─────────────────────────────────────────────────────────────

export const RunMarketAlertsResponse = zod.object({
  overallAlertLevel: zod.enum(["High", "Medium", "Low"]),
  executiveSummary: zod.string(),
  headline: zod.string(),
  alerts: zod.array(
    zod.object({
      title: zod.string(),
      category: zod.enum([
        "Portfolio",
        "Company",
        "Macro",
        "Sector",
        "Event",
        "Geopolitical",
        "Currency",
      ]),
      importance: zod.enum(["High", "Medium", "Low"]),
      isNew: zod.boolean(),
      requiresAttention: zod.boolean(),
      affectedHoldings: zod.array(zod.string()),
      summary: zod.string(),
      whyItMatters: zod.string(),
      recommendedAttention: zod.enum(["Monitor", "Review", "Prepare", "Watch"]),
      sourceType: zod.enum([
        "Web",
        "NewsMonitor",
        "CompanyMonitor",
        "EventMonitor",
      ]),
    })
  ),
  thingsToWatch: zod.array(zod.string()),
  nothingImportantChanged: zod.boolean(),
  timestamp: zod.string(),
  analysisDuration: zod
    .number()
    .describe("Time taken to complete the analysis in milliseconds"),
});

// ── Trade Decision Engine ─────────────────────────────────────────────────────

export const RunTradeDecisionEngineResponse = zod.object({
  mainConclusion: zod.object({
    title: zod.string(),
    reason: zod.string(),
  }),
  executiveSummary: zod.string(),
  overallDecisionPosture: zod.enum([
    "ActivelyReview",
    "SelectivePreparation",
    "WaitForEvents",
    "MaintainCurrentPositioning",
    "InsufficientEvidence",
  ]),
  decisionReadinessScore: zod.number().int().min(0).max(100),
  readinessDrivers: zod.array(
    zod.object({
      factor: zod.string(),
      impact: zod.enum(["Positive", "Negative", "Neutral"]),
      reason: zod.string(),
    })
  ),
  decisions: zod.array(
    zod.object({
      rank: zod.number().int().min(1),
      subjectType: zod.enum(["Holding", "Opportunity", "Portfolio"]),
      company: zod.string(),
      ticker: zod.string(),
      decision: zod.enum([
        "Hold",
        "Review",
        "WaitForEvent",
        "PrepareToBuy",
        "PrepareToReduce",
        "NoAction",
      ]),
      title: zod.string(),
      reason: zod.string(),
      supportingEvidence: zod.array(zod.string()),
      opposingEvidence: zod.array(zod.string()),
      confidence: zod.enum(["High", "Medium", "Low"]),
      urgency: zod.enum(["Immediate", "Days", "Weeks", "NoUrgency"]),
      blockedByEvent: zod.boolean(),
      blockingEvent: zod.string(),
      blockingEventDate: zod.string(),
      whatWouldChangeDecision: zod.array(zod.string()),
      missingEvidence: zod.array(zod.string()),
      portfolioImpact: zod.string(),
      accountConsiderations: zod.string(),
      sourceModules: zod.array(zod.string()),
      targetAllocationPercent: zod.number().optional(),
      maximumAllocationPercent: zod.number().optional(),
      sizingConfidence: zod.enum(["High", "Medium", "Low"]).optional(),
      sizingReason: zod.string().optional(),
    })
  ),
  conflictsResolved: zod.array(
    zod.object({
      topic: zod.string(),
      conflict: zod.string(),
      resolution: zod.string(),
    })
  ),
  nextReviewTriggers: zod.array(
    zod.object({
      trigger: zod.string(),
      date: zod.string(),
      affectedDecisions: zod.array(zod.string()),
    })
  ),
  timestamp: zod.string(),
  analysisDuration: zod
    .number()
    .describe("Time taken to complete the analysis in milliseconds"),
});

// ── Command Brief ─────────────────────────────────────────────────────────────

export const RunCommandBriefResponse = zod.object({
  overallStatus: zod.enum(["normal", "attention", "action"]),
  headline: zod.string(),
  items: zod
    .array(
      zod.object({
        category: zod.enum([
          "system", "portfolio", "risk", "market", "stock",
          "event", "opportunity", "action",
        ]),
        severity: zod.enum(["positive", "neutral", "watch", "warning", "critical"]),
        symbol: zod.string().optional(),
        text: zod.string(),
      })
    )
    .max(6),
  actionStatus: zod.object({
    status: zod.enum(["none", "monitor", "review", "trade_ready"]),
    text: zod.string(),
  }),
  whatThisMeans: zod.string(),
  generatedAt: zod.string(),
});

// ── Company Monitor (reset endpoint) ─────────────────────────────────────────

export const ResetCompanyMonitorDataResponse = zod.object({
  deletedEntries: zod.number().int(),
  deletedAnalyses: zod.number().int(),
  deletedHistoryEntries: zod.number().int(),
  message: zod.string(),
});
