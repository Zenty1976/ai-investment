/**
 * Trade Decision Engine Route – Phase 1
 *
 * Converts portfolio analyses into cautious, transparent decision proposals.
 * Phase 1 NEVER places, modifies or cancels Saxo orders.
 *
 * Results:  "trade-decision-engine"
 * History:  "trade-decision-engine-history" (latest 20 entries)
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunTradeDecisionEngineResponse } from "@workspace/api-zod";
import { callAiWithWebSearch, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";
import { companyIdentityStore } from "../lib/company-identity";

const router: IRouter = Router();

const MODULE_NAME = "Trade Decision Engine";
const MAX_ATTEMPTS = 2;
const MAX_HISTORY = 20;
/** Maximum total duration for the route — two 90 s attempts plus processing overhead. */
const ROUTE_TIMEOUT_MS = 190_000;

// ---------------------------------------------------------------------------
// History types
// ---------------------------------------------------------------------------

interface DecisionHistoryDecision {
  normalizedKey: string;
  subjectType: string;
  company: string;
  ticker: string;
  decision: string;
  confidence: string;
  urgency: string;
}

interface DecisionHistoryEntry {
  timestamp: string;
  overallDecisionPosture: string;
  decisionReadinessScore: number;
  decisions: DecisionHistoryDecision[];
}

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

const URGENCY_ORDER: Record<string, number> = { Immediate: 0, Days: 1, Weeks: 2, NoUrgency: 3 };
const CONFIDENCE_ORDER: Record<string, number> = { High: 0, Medium: 1, Low: 2 };

function sortDecisionsByPriority<T extends { urgency: string; confidence: string; rank: number }>(
  decisions: T[]
): T[] {
  return [...decisions].sort((a, b) => {
    const u = (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9);
    if (u !== 0) return u;
    const c = (CONFIDENCE_ORDER[a.confidence] ?? 9) - (CONFIDENCE_ORDER[b.confidence] ?? 9);
    if (c !== 0) return c;
    return a.rank - b.rank;
  });
}

function normalizeDecisionKey(
  subjectType: string,
  ticker: string,
  company: string,
  decision: string
): string {
  const subject = (ticker?.trim() || company?.trim() || "portfolio").toLowerCase().trim();
  return `${subjectType.toLowerCase().trim()}|${subject}|${decision.toLowerCase().trim()}`;
}

type DecisionStatus = "New" | "Changed" | "Unchanged" | "Resolved";

function computeDecisionStatus(
  normalizedKey: string,
  confidence: string,
  urgency: string,
  previousDecisions: DecisionHistoryDecision[]
): DecisionStatus {
  const prev = previousDecisions.find((p) => p.normalizedKey === normalizedKey);
  if (!prev) return "New";
  if (prev.confidence !== confidence || prev.urgency !== urgency) return "Changed";
  return "Unchanged";
}

// ---------------------------------------------------------------------------
// Executable-language guard
// ---------------------------------------------------------------------------

const EXECUTABLE_PATTERNS = [
  /\bbuy\s+now\b/i,
  /\bsell\s+now\b/i,
  /\bexecute\s+(the\s+)?(order|trade|position)\b/i,
  /\bplace\s+(the\s+)?order\b/i,
  /\blimit\s+price\b/i,
  /\b\d+\s+shares?\b/i,
  /\bquantity\s*[:=]\s*\d+/i,
  /\bstop\s+loss\s+at\b/i,
];

function hasExecutableLanguage(d: { title: string; reason: string }): boolean {
  return EXECUTABLE_PATTERNS.some((p) => p.test(d.title) || p.test(d.reason));
}

// ---------------------------------------------------------------------------
// System prompt (built once at module load)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an institutional investment decision committee conducting a systematic review of a private investor's portfolio.

Your task is to convert the supplied portfolio analyses into cautious, transparent decision proposals for the next 1–3 months.

ROLE AND BEHAVIOUR:
- Do not simply repeat the input modules. Synthesise and resolve conflicts between them.
- Clearly distinguish facts, expectations and analytical judgement.
- Do not fabricate certainty. When evidence is conflicting or incomplete, prefer Review, WaitForEvent or NoAction.
- Do not create exact order quantities, limit prices or executable instructions.
- Do not recommend deploying all available cash.
- Do not assume a strong opportunity automatically justifies a purchase.
- A decision must not be based on one source alone when other relevant sources are available.
- Consider portfolio fit, concentration, diversification, risk score, upcoming events, existing cash, account currencies, company-specific evidence, latest alerts and evidence freshness.

ALLOWED DECISION TYPES:
- Hold: Current position remains acceptable, no immediate change proposed.
- Review: Position or opportunity requires closer manual assessment.
- WaitForEvent: Do not decide before a named upcoming event or missing result.
- PrepareToBuy: Candidate may justify a future purchase, but no order is created.
- PrepareToReduce: Existing position may justify reduced exposure, but no order is created.
- NoAction: Available evidence does not justify a change.

Do not use: "buy now", "sell now", "execute", "place order".

INFORMATION PRIORITY (use when resolving conflicts):
1. Current portfolio and backend-calculated exposure metrics
2. Risk Analyzer
3. Portfolio Analyzer
4. Market Alerts
5. Company Monitor data
6. Opportunity Finder
7. Event Monitor
8. Sector Monitor
9. Market Monitor
10. News Monitor
11. Web search (verification only — do not let it replace stored specialist analyses)

DECISION REQUIREMENTS — for each decision state:
- subject, decision type, reason
- supporting evidence (≥1), opposing evidence
- what could change the decision (≥1)
- whether an upcoming event blocks it
- missing information
- confidence (High, Medium, Low) and urgency (Immediate, Days, Weeks, NoUrgency)
- source modules actually used

CONSISTENCY RULES:
- If blockedByEvent is true: blockingEvent must name the event; blockingEventDate must be YYYY-MM-DD or empty string if date is unverified.
- If blockedByEvent is false: blockingEvent and blockingEventDate must be empty strings "".
- company and ticker must be empty strings "" for Portfolio-level decisions.
- sourceModules must list only modules that provided material evidence for that specific decision.
- Return 3–8 decisions, most important first.
- Return 3–6 readiness drivers.
- Do not create duplicate decisions for the same subject and decision type.
- decisionReadinessScore: integer 0–100 measuring whether evidence is sufficient to make useful decisions — not a prediction of portfolio return.

ACCOUNT CONSIDERATIONS: Phase 1 may note account currency considerations (e.g. USD cash available, DKK account requiring FX conversion) but must not select accounts or claim instrument eligibility unless confirmed from stored data.

You must perform a web search to verify current information for any decision based on earnings, guidance, legal developments, regulatory decisions, significant price moves, analyst actions or macroeconomic events.

Return JSON only — no markdown, no code fences, no extra text.
Do not include timestamp or analysisDuration — the server sets those.

Return exactly:
{"mainConclusion":{"title":"…","reason":"…"},"executiveSummary":"…","overallDecisionPosture":"ActivelyReview|SelectivePreparation|WaitForEvents|MaintainCurrentPositioning|InsufficientEvidence","decisionReadinessScore":0,"readinessDrivers":[{"factor":"…","impact":"Positive|Negative","reason":"…"}],"decisions":[{"rank":1,"subjectType":"Holding|Opportunity|Portfolio","company":"…","ticker":"…","decision":"Hold|Review|WaitForEvent|PrepareToBuy|PrepareToReduce|NoAction","title":"…","reason":"…","supportingEvidence":["…"],"opposingEvidence":["…"],"confidence":"High|Medium|Low","urgency":"Immediate|Days|Weeks|NoUrgency","blockedByEvent":false,"blockingEvent":"","blockingEventDate":"","whatWouldChangeDecision":["…"],"missingEvidence":["…"],"portfolioImpact":"…","accountConsiderations":"…","sourceModules":["PortfolioManager"]}],"conflictsResolved":[{"topic":"…","conflict":"…","resolution":"…"}],"nextReviewTriggers":[{"trigger":"…","date":"YYYY-MM-DD or empty string","affectedDecisions":["decision title"]}]}`;

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/trade-decision-engine/analyze", async (req, res): Promise<void> => {
  systemLog.logUser(MODULE_NAME, "User manually started decision analysis");

  const startTime = Date.now();
  const nowIso = new Date().toISOString();
  const nowDate = new Date(nowIso);
  let lastDebug: AiDebugInfo | undefined;

  // ── Route-level safety timeout ───────────────────────────────────────────
  // Guards against any situation where per-attempt timeouts fail to fire.
  // Returns 504 and stops further processing if the total duration is exceeded.
  let routeTimedOut = false;
  const routeTimeoutHandle = setTimeout(() => {
    routeTimedOut = true;
    systemLog.logError(MODULE_NAME, "Decision analysis timed out");
    if (!res.headersSent) {
      res.status(504).json({
        error: "Trade Decision Engine timed out — analysis took too long",
        _debug: lastDebug,
      });
    }
  }, ROUTE_TIMEOUT_MS);

  // ── Load all module entries ──────────────────────────────────────────────

  const portfolioEntry = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  const analyzerEntry  = analysisRepository.get<Record<string, unknown>>("portfolio-analyzer");
  const riskEntry      = analysisRepository.get<Record<string, unknown>>("risk-analyzer");
  const alertsEntry    = analysisRepository.get<Record<string, unknown>>("market-alerts");
  const eventEntry     = analysisRepository.get<Record<string, unknown>>("event-monitor");
  const newsEntry      = analysisRepository.get<Record<string, unknown>>("news-monitor");
  const sectorEntry    = analysisRepository.get<Record<string, unknown>>("sector-monitor");
  const marketEntry    = analysisRepository.get<Record<string, unknown>>("market-monitor");
  const opportunityEntry = analysisRepository.get<Record<string, unknown>>("opportunity-finder");

  const allRepoEntries = analysisRepository.getAll();
  const companyEntries = allRepoEntries
    .filter((e) => e.moduleName.startsWith("company-monitor:"))
    .map((e) => ({
      ticker: e.moduleName.replace("company-monitor:", "").toUpperCase(),
      result: e.result as Record<string, unknown>,
      updatedAt: e.updatedAt,
    }));

  // ── Warnings ──────────────────────────────────────────────────────────────

  if (portfolioEntry?.result?.isMockData) {
    systemLog.logWarning(MODULE_NAME, "Using mock portfolio data — decisions reflect simulated positions only");
  }

  const missingModules: string[] = [];
  if (!portfolioEntry) missingModules.push("Portfolio Manager");
  if (!riskEntry)      missingModules.push("Risk Analyzer");
  if (!analyzerEntry)  missingModules.push("Portfolio Analyzer");
  if (!alertsEntry)    missingModules.push("Market Alerts");
  if (missingModules.length > 0) {
    systemLog.logWarning(MODULE_NAME, `Required analysis context unavailable: ${missingModules.join(", ")}`);
  }

  // ── Backend decision profile ─────────────────────────────────────────────

  const portfolioResult = portfolioEntry?.result as Record<string, unknown> | undefined;
  const accounts = Array.isArray(portfolioResult?.accounts)
    ? (portfolioResult!.accounts as Array<Record<string, unknown>>)
    : [];

  const baseCurrency       = typeof portfolioResult?.baseCurrency === "string" ? portfolioResult.baseCurrency : "Unknown";
  const totalValue         = typeof portfolioResult?.totalValue === "number" ? portfolioResult.totalValue : null;
  const totalAvailableCash = typeof portfolioResult?.totalAvailableCash === "number" ? portfolioResult.totalAvailableCash : null;

  const allPositions: Array<{
    ticker: string; name: string;
    marketValueBaseCurrency: number; currency: string;
    accountCurrency: string; accountName: string;
    quantity: number; unrealizedPnL: number;
  }> = [];

  for (const acc of accounts) {
    const posArr = Array.isArray(acc.positions)
      ? (acc.positions as Array<Record<string, unknown>>)
      : [];
    for (const pos of posArr) {
      allPositions.push({
        ticker:                 String(pos.symbol ?? "").toUpperCase(),
        name:                   String(pos.name ?? ""),
        marketValueBaseCurrency: typeof pos.marketValueBaseCurrency === "number" ? pos.marketValueBaseCurrency : 0,
        currency:               String(pos.currency ?? ""),
        accountCurrency:        String(acc.currency ?? ""),
        accountName:            String(acc.accountName ?? ""),
        quantity:               typeof pos.quantity === "number" ? pos.quantity : 0,
        unrealizedPnL:          typeof pos.unrealizedProfitLoss === "number" ? pos.unrealizedProfitLoss : 0,
      });
    }
  }

  const totalInvested   = allPositions.reduce((s, p) => s + p.marketValueBaseCurrency, 0);
  const baseForWeights  = totalValue ?? totalInvested;
  const cashPct         = baseForWeights > 0 && totalAvailableCash != null
    ? Math.round((totalAvailableCash / baseForWeights) * 1000) / 10
    : null;

  const positionsWithWeights = allPositions
    .map((p) => ({
      ...p,
      weightOfTotal:    baseForWeights > 0 ? Math.round((p.marketValueBaseCurrency / baseForWeights)  * 1000) / 10 : 0,
      weightOfInvested: totalInvested  > 0 ? Math.round((p.marketValueBaseCurrency / totalInvested)   * 1000) / 10 : 0,
      hasCompanyMonitor: companyEntries.some((c) => c.ticker === p.ticker),
    }))
    .sort((a, b) => b.weightOfTotal - a.weightOfTotal);

  // Cash by currency
  const cashByCurrency: Record<string, number> = {};
  for (const acc of accounts) {
    const ccy  = String(acc.currency ?? "");
    const cash = typeof acc.availableCash === "number" ? acc.availableCash : 0;
    if (ccy) cashByCurrency[ccy] = (cashByCurrency[ccy] ?? 0) + cash;
  }

  // Upcoming high/medium events within 14 days
  const in14DaysMs = nowDate.getTime() + 14 * 24 * 60 * 60 * 1000;
  const upcomingEvents: Array<Record<string, unknown>> = [];
  if (Array.isArray(eventEntry?.result?.events)) {
    for (const ev of eventEntry!.result.events as Array<Record<string, unknown>>) {
      if (!ev.date) continue;
      const evMs = new Date(String(ev.date)).getTime();
      if (!isNaN(evMs) && evMs >= nowDate.getTime() && evMs <= in14DaysMs && ev.importance !== "Low") {
        upcomingEvents.push({ title: ev.title, date: ev.date, importance: ev.importance });
      }
    }
  }

  // Top opportunity candidates
  const topOpportunityCandidates = Array.isArray(opportunityEntry?.result?.topOpportunities)
    ? (opportunityEntry!.result.topOpportunities as Array<Record<string, unknown>>).slice(0, 5).map((o) => ({
        rank: o.rank, ticker: o.ticker, company: o.company, sector: o.sector,
        confidence: o.confidence, priority: o.priority,
        mainCatalyst: o.mainCatalyst,
        hasCompanyMonitor: companyEntries.some((c) => c.ticker === String(o.ticker ?? "").toUpperCase()),
      }))
    : [];

  const riskScore     = typeof riskEntry?.result?.riskScore === "number" ? riskEntry.result.riskScore : null;
  const prevRiskScore = typeof riskEntry?.result?.previousRiskScore === "number" ? riskEntry.result.previousRiskScore : null;

  const decisionProfile = {
    generatedAt:    nowIso,
    baseCurrency,
    isMockData:     portfolioEntry?.result?.isMockData ?? false,
    totalPortfolioValue:   totalValue,
    totalAvailableCash,
    cashPercentage:        cashPct,
    totalInvestedValue:    Math.round(totalInvested),
    cashByCurrency,
    largestHolding:        positionsWithWeights[0]
      ? { ticker: positionsWithWeights[0].ticker, weightOfTotal: positionsWithWeights[0].weightOfTotal, marketValueBaseCurrency: Math.round(positionsWithWeights[0].marketValueBaseCurrency) }
      : null,
    positions:             positionsWithWeights.map((p) => ({
      ticker: p.ticker, name: p.name,
      marketValueBaseCurrency: Math.round(p.marketValueBaseCurrency),
      instrumentCurrency: p.currency, accountCurrency: p.accountCurrency, accountName: p.accountName,
      quantity: p.quantity, unrealizedPnL: Math.round(p.unrealizedPnL),
      weightOfTotal: p.weightOfTotal, weightOfInvested: p.weightOfInvested,
      hasCompanyMonitor: p.hasCompanyMonitor,
    })),
    riskScore,
    previousRiskScore:     prevRiskScore,
    riskScoreChange:       riskScore != null && prevRiskScore != null ? riskScore - prevRiskScore : null,
    riskLevel:             riskEntry?.result?.overallRiskLevel ?? null,
    portfolioScore:        analyzerEntry?.result?.portfolioScore ?? null,
    portfolioOutlook:      analyzerEntry?.result?.overallOutlook ?? null,
    alertLevel:            alertsEntry?.result?.overallAlertLevel ?? null,
    alertHeadline:         alertsEntry?.result?.headline ?? null,
    alertsNoNewDevelopments: alertsEntry?.result?.noNewDevelopmentsSinceLastCheck ?? null,
    upcomingHighImportanceEvents: upcomingEvents,
    topOpportunityCandidates,
    positionsWithCompanyMonitorData:  positionsWithWeights.filter((p) => p.hasCompanyMonitor).map((p) => p.ticker),
    positionsMissingCompanyMonitorData: positionsWithWeights.filter((p) => !p.hasCompanyMonitor).map((p) => p.ticker),
  };

  // ── Module contexts ──────────────────────────────────────────────────────

  const riskContext = riskEntry ? JSON.stringify({
    overallRiskLevel: riskEntry.result.overallRiskLevel, riskScore: riskEntry.result.riskScore,
    previousRiskScore: riskEntry.result.previousRiskScore, mainConclusion: riskEntry.result.mainConclusion,
    topRisks: riskEntry.result.topRisks, riskInteractions: riskEntry.result.riskInteractions,
    watchClosely: riskEntry.result.watchClosely, updatedAt: riskEntry.updatedAt,
  }) : null;

  const analyzerContext = analyzerEntry ? JSON.stringify({
    mainConclusion: analyzerEntry.result.mainConclusion, executiveSummary: analyzerEntry.result.executiveSummary,
    overallRating: analyzerEntry.result.overallRating, overallOutlook: analyzerEntry.result.overallOutlook,
    portfolioScore: analyzerEntry.result.portfolioScore, strengths: analyzerEntry.result.strengths,
    weaknesses: analyzerEntry.result.weaknesses, topRisks: analyzerEntry.result.topRisks,
    topOpportunities: analyzerEntry.result.topOpportunities, recommendedActions: analyzerEntry.result.recommendedActions,
    sectorAssessment: analyzerEntry.result.sectorAssessment, positionComments: analyzerEntry.result.positionComments,
    updatedAt: analyzerEntry.updatedAt,
  }) : null;

  const alertsContext = alertsEntry ? JSON.stringify({
    overallAlertLevel: alertsEntry.result.overallAlertLevel, headline: alertsEntry.result.headline,
    executiveSummary: alertsEntry.result.executiveSummary, alerts: alertsEntry.result.alerts,
    thingsToWatch: alertsEntry.result.thingsToWatch,
    noNewDevelopmentsSinceLastCheck: alertsEntry.result.noNewDevelopmentsSinceLastCheck,
    lastCheckedAt: alertsEntry.result.lastCheckedAt, lastMeaningfulUpdateAt: alertsEntry.result.lastMeaningfulUpdateAt,
    updatedAt: alertsEntry.updatedAt,
  }) : null;

  const opportunityContext = opportunityEntry ? JSON.stringify({
    executiveSummary: opportunityEntry.result.executiveSummary,
    overallOpportunityLevel: opportunityEntry.result.overallOpportunityLevel,
    topOpportunities: Array.isArray(opportunityEntry.result.topOpportunities)
      ? (opportunityEntry.result.topOpportunities as Array<Record<string, unknown>>).slice(0, 5).map((o) => ({
          rank: o.rank, company: o.company, ticker: o.ticker, sector: o.sector,
          overallScore: o.overallScore, confidence: o.confidence, priority: o.priority,
          investmentThesis: o.investmentThesis, whyNow: o.whyNow, whyThisPortfolio: o.whyThisPortfolio,
          mainCatalyst: o.mainCatalyst, mainRisk: o.mainRisk,
          companyAnalysisAvailable: o.companyAnalysisAvailable,
          positionSizeSuitability: o.positionSizeSuitability, positionSizeReason: o.positionSizeReason,
        }))
      : [],
    sectorIdeas: opportunityEntry.result.sectorIdeas,
    updatedAt: opportunityEntry.updatedAt,
  }) : null;

  const eventContext = eventEntry ? JSON.stringify({
    summary: eventEntry.result.summary, nextMajorEvent: eventEntry.result.nextMajorEvent,
    events: Array.isArray(eventEntry.result.events)
      ? (eventEntry.result.events as Array<Record<string, unknown>>).map((e) => ({
          title: e.title, date: e.date, importance: e.importance, expectedImpact: e.expectedImpact, category: e.category,
        }))
      : [],
    updatedAt: eventEntry.updatedAt,
  }) : null;

  const sectorContext = sectorEntry ? JSON.stringify({
    executiveSummary: sectorEntry.result.executiveSummary, overallOutlook: sectorEntry.result.overallOutlook,
    sectors: Array.isArray(sectorEntry.result.sectors)
      ? (sectorEntry.result.sectors as Array<Record<string, unknown>>).map((s) => ({
          name: s.name, rating: s.rating, trend: s.trend, summary: s.summary,
        }))
      : [],
    updatedAt: sectorEntry.updatedAt,
  }) : null;

  const marketContext = marketEntry ? JSON.stringify({
    marketSentiment: marketEntry.result.marketSentiment, riskLevel: marketEntry.result.riskLevel,
    summary: marketEntry.result.summary, positiveFactors: marketEntry.result.positiveFactors,
    negativeFactors: marketEntry.result.negativeFactors, keyRisks: marketEntry.result.keyRisks,
    updatedAt: marketEntry.updatedAt,
  }) : null;

  const newsContext = newsEntry ? JSON.stringify({
    executiveSummary: newsEntry.result.executiveSummary, overallMarketImpact: newsEntry.result.overallMarketImpact,
    topStory: newsEntry.result.topStory,
    news: Array.isArray(newsEntry.result.news)
      ? (newsEntry.result.news as Array<Record<string, unknown>>).slice(0, 5).map((n) => ({
          title: n.title, category: n.category, importance: n.importance,
          whyItMatters: n.whyItMatters, marketImpact: n.marketImpact,
        }))
      : [],
    updatedAt: newsEntry.updatedAt,
  }) : null;

  const companyContextLines = companyEntries.map((c) => {
    const identity = companyIdentityStore.resolve(
      c.ticker,
      { companyName: String(c.result.companyName ?? "") },
      companyEntries.map((e) => ({ key: `company-monitor:${e.ticker}`, result: e.result }))
    );
    return `COMPANY MONITOR — ${c.ticker} (${identity.displayName}, updated: ${c.updatedAt}):\n${JSON.stringify({
      companyName: c.result.companyName, ticker: c.result.ticker,
      recommendation: c.result.recommendation, overallScore: c.result.overallScore,
      priceTarget: c.result.priceTarget, mainConclusion: c.result.mainConclusion,
      keyStrengths: c.result.keyStrengths, keyRisks: c.result.keyRisks,
      catalysts: c.result.catalysts, recentDevelopments: c.result.recentDevelopments,
    })}`;
  }).join("\n\n");

  // ── User prompt ──────────────────────────────────────────────────────────

  const userPromptSections: string[] = [
    `ANALYSIS DATE: ${nowIso}`,
    `\nBACKEND DECISION PROFILE (server-calculated — treat as highest-priority input):\n${JSON.stringify(decisionProfile, null, 2)}`,
  ];

  const addCtx = (label: string, ctx: string | null) => {
    userPromptSections.push(ctx ? `\n${label}:\n${ctx}` : `\n${label}: Not available.`);
  };

  addCtx("RISK ANALYZER (priority 2)",         riskContext);
  addCtx("PORTFOLIO ANALYZER (priority 3)",     analyzerContext);
  addCtx("MARKET ALERTS (priority 4)",          alertsContext);

  if (companyContextLines) {
    userPromptSections.push(`\nCOMPANY MONITOR DATA (priority 5):\n${companyContextLines}`);
  } else {
    userPromptSections.push(`\nCOMPANY MONITOR DATA (priority 5): None available. Treat this as missing evidence for every holding.`);
  }

  addCtx("OPPORTUNITY FINDER (priority 6)",     opportunityContext);
  addCtx("EVENT MONITOR (priority 7)",          eventContext);
  addCtx("SECTOR MONITOR (priority 8)",         sectorContext);
  addCtx("MARKET MONITOR (priority 9)",         marketContext);
  addCtx("NEWS MONITOR (priority 10)",          newsContext);

  userPromptSections.push(
    `\nTask: Based on all the above, produce 3–8 cautious decision proposals for the next 1–3 months. Resolve conflicts between modules. Use web search to verify current information for time-sensitive decisions.`
  );

  const userPrompt = userPromptSections.join("\n");

  // ── History ──────────────────────────────────────────────────────────────

  const historyEntry = analysisRepository.get<{ entries: DecisionHistoryEntry[] }>(
    "trade-decision-engine-history"
  );
  const previousDecisions: DecisionHistoryDecision[] =
    historyEntry?.result?.entries?.[0]?.decisions ?? [];

  // ── Retry loop ───────────────────────────────────────────────────────────

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Stop if the route safety timeout already fired and sent a 504.
    if (routeTimedOut || res.headersSent) break;

    try {
      const { result, debug } = await callAiWithWebSearch(
        SYSTEM_PROMPT,
        userPrompt,
        { model: "gpt-4o", maxTokens: 6000, temperature: 0.1 }
      );

      // The route timeout may have fired while we were awaiting OpenAI.
      if (res.headersSent) { clearTimeout(routeTimeoutHandle); return; }

      const analysisDuration = Date.now() - startTime;
      lastDebug = debug;

      // ── Normalize sourceModules ──────────────────────────────────────────
      // The model sometimes returns human-readable names with spaces
      // (e.g. "Risk Analyzer") instead of the PascalCase enum values the
      // schema requires ("RiskAnalyzer"). Strip internal spaces as a
      // pre-validation normalization step — does not alter any other field.
      const rawResult = result as Record<string, unknown>;
      const normalizedResult: Record<string, unknown> = {
        ...rawResult,
        decisions: Array.isArray(rawResult.decisions)
          ? rawResult.decisions.map((d) => {
              if (!d || typeof d !== "object") return d;
              const dec = d as Record<string, unknown>;
              return {
                ...dec,
                sourceModules: Array.isArray(dec.sourceModules)
                  ? dec.sourceModules.map((m) =>
                      typeof m === "string" ? m.replace(/\s+/g, "") : m
                    )
                  : dec.sourceModules,
              };
            })
          : rawResult.decisions,
      };

      // Schema validation (callAiWithWebSearch already parsed the JSON)
      const parsed = RunTradeDecisionEngineResponse.safeParse({
        ...normalizedResult,
        timestamp: nowIso,
        analysisDuration,
      });
      if (!parsed.success) {
        throw new Error(
          `Schema validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        );
      }

      // Executable language guard
      const badDecisions = parsed.data.decisions.filter(hasExecutableLanguage);
      if (badDecisions.length > 0) {
        throw new Error(
          `Prohibited executable language in: ${badDecisions.map((d) => d.title).join("; ")}`
        );
      }

      // Verify event dates: past dates must not block decisions
      const validatedDecisions = parsed.data.decisions.map((d) => {
        if (d.blockedByEvent && d.blockingEventDate) {
          const evDate = new Date(d.blockingEventDate);
          if (!isNaN(evDate.getTime()) && evDate < nowDate) {
            return { ...d, blockedByEvent: false, blockingEvent: "", blockingEventDate: "" };
          }
        }
        return d;
      });

      // Sort → dedup → reassign ranks
      const sorted = sortDecisionsByPriority(validatedDecisions);

      const seenKeys = new Set<string>();
      const deduped = sorted.filter((d) => {
        const k = normalizeDecisionKey(d.subjectType, d.ticker, d.company, d.decision);
        if (seenKeys.has(k)) return false;
        seenKeys.add(k);
        return true;
      });

      const reranked = deduped.map((d, i) => ({ ...d, rank: i + 1 }));

      // Assign status and track normalizedKey for history
      type RawD = (typeof reranked)[0];
      type DWithKey = RawD & { normalizedKey: string; status: DecisionStatus };

      const decisionsWithKeys: DWithKey[] = reranked.map((d) => {
        const nk = normalizeDecisionKey(d.subjectType, d.ticker, d.company, d.decision);
        return {
          ...d,
          normalizedKey: nk,
          status: computeDecisionStatus(nk, d.confidence, d.urgency, previousDecisions),
        };
      });

      const currentKeys = new Set(decisionsWithKeys.map((d) => d.normalizedKey));
      const resolvedDecisions = previousDecisions.filter((p) => !currentKeys.has(p.normalizedKey));

      // Strip normalizedKey from response (internal field only)
      const responseDecisions = decisionsWithKeys.map(({ normalizedKey: _nk, ...rest }) => rest);

      const finalData = { ...parsed.data, decisions: responseDecisions, timestamp: nowIso, analysisDuration };

      // ── Save ─────────────────────────────────────────────────────────────
      analysisRepository.save("trade-decision-engine", finalData);

      const existingHistory = historyEntry?.result?.entries ?? [];
      const newHistoryEntry: DecisionHistoryEntry = {
        timestamp: nowIso,
        overallDecisionPosture:  finalData.overallDecisionPosture,
        decisionReadinessScore:  finalData.decisionReadinessScore,
        decisions: decisionsWithKeys.map((d) => ({
          normalizedKey: d.normalizedKey,
          subjectType:   d.subjectType,
          company:       d.company,
          ticker:        d.ticker,
          decision:      d.decision,
          confidence:    d.confidence,
          urgency:       d.urgency,
        })),
      };
      analysisRepository.save("trade-decision-engine-history", {
        entries: [newHistoryEntry, ...existingHistory].slice(0, MAX_HISTORY),
      });

      // ── System log ───────────────────────────────────────────────────────
      systemLog.logInfo(MODULE_NAME, "Decision analysis completed");
      systemLog.logInternal(
        MODULE_NAME,
        `Posture: ${finalData.overallDecisionPosture} | Readiness: ${finalData.decisionReadinessScore}/100`
      );

      const topD = responseDecisions[0];
      if (topD) {
        systemLog.logInternal(
          MODULE_NAME,
          `Top decision: [${topD.decision}] ${topD.title} — ${topD.confidence} confidence, ${topD.urgency} urgency`
        );
      }

      const newOnes     = responseDecisions.filter((d) => d.status === "New");
      const changedOnes = responseDecisions.filter((d) => d.status === "Changed");
      if (newOnes.length > 0) {
        systemLog.logInternal(MODULE_NAME, `${newOnes.length} new decision(s): ${newOnes.map((d) => d.title).join("; ")}`);
      }
      if (changedOnes.length > 0) {
        systemLog.logInternal(MODULE_NAME, `${changedOnes.length} changed: ${changedOnes.map((d) => d.title).join("; ")}`);
      }
      if (resolvedDecisions.length > 0) {
        systemLog.logInternal(
          MODULE_NAME,
          `${resolvedDecisions.length} resolved: ${resolvedDecisions.map((d) => d.ticker || d.company || "portfolio").join("; ")}`
        );
      }

      clearTimeout(routeTimeoutHandle);
      res.json({ ...finalData, _debug: debug });
      return;

    } catch (err) {
      const errDebug = extractAiErrorDebug(err);
      if (lastDebug || errDebug) {
        lastDebug = { ...(lastDebug ?? {}), ...(errDebug ?? {}) } as AiDebugInfo;
      }
      const isLastAttempt = attempt >= MAX_ATTEMPTS;
      req.log[isLastAttempt ? "error" : "warn"](
        { err, attempt },
        isLastAttempt ? "AI service call failed after all attempts" : "AI service call failed — retrying"
      );
      if (isLastAttempt || routeTimedOut) {
        clearTimeout(routeTimeoutHandle);
        if (!res.headersSent) {
          systemLog.logError(
            MODULE_NAME,
            `Decision analysis failed: ${err instanceof Error ? err.message : "AI service call failed"}`
          );
          res.status(500).json({
            error:  err instanceof Error ? err.message : "AI service call failed",
            _debug: lastDebug,
          });
        }
        return;
      }
      continue;
    }
  }

  // Safety: loop exited without sending a response (route timeout fired before any attempt ran)
  clearTimeout(routeTimeoutHandle);
  if (!res.headersSent) {
    res.status(504).json({
      error: "Trade Decision Engine timed out — analysis took too long",
      _debug: lastDebug,
    });
  }
});

export default router;
