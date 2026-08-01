/**
 * Risk Analyzer Route
 *
 * Identifies, explains, and prioritizes the risks affecting the current
 * portfolio over the next 1–3 months. Uses the OpenAI Responses API with
 * live web search.
 *
 * Reads context from: Portfolio Manager, Portfolio Analyzer, Opportunity Finder,
 * Market Monitor, Event Monitor, News Monitor, Sector Monitor, and Company Monitor
 * analyses for currently-held positions (resolved via companyIdentityStore).
 *
 * Results are stored under "risk-analyzer".
 * A compact history (latest 20 analyses) is maintained under "risk-analyzer-history".
 * Invalid results are never stored.
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunRiskAnalyzerResponse } from "@workspace/api-zod";
import { callAiWithWebSearch, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";
import { companyIdentityStore } from "../lib/company-identity";

const router: IRouter = Router();

const MODULE_NAME = "Risk Analyzer";
const MAX_ATTEMPTS = 2;
const MAX_HISTORY = 20;

// ---------------------------------------------------------------------------
// History types
// ---------------------------------------------------------------------------

interface RiskHistoryEntry {
  timestamp: string;
  overallRiskLevel: string;
  riskScore: number;
  topThreeRisks: Array<{
    title: string;
    category: string;
    probability: string;
    severity: string;
  }>;
  overallConclusion: string;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an experienced institutional portfolio risk manager.

Your task is to identify, explain, and prioritize the risks affecting the current portfolio over the next 1–3 months.

WEB SEARCH REQUIREMENT:
You must perform a web search before producing your analysis. Search for:
- Recent developments that could affect the held companies or their sectors
- Current macroeconomic and geopolitical risk factors
- Upcoming events, earnings, or catalysts that could pose risk to the portfolio

OBJECTIVE:
Focus entirely on risk. Do not recommend buying or selling.
Use language such as: Monitor, Review, Prepare for, Watch.

EVALUATE:
- concentration risk
- company-specific risk
- sector risk
- macroeconomic risk
- geopolitical risk
- event risk
- liquidity risk
- currency risk
- opportunity cost
- portfolio diversification
- correlation between holdings

For every identified risk:
- explain why it exists in the context of this specific portfolio
- assess probability (Low/Medium/High)
- assess potential severity (Low/Medium/High)
- indicate time horizon (Immediate/Weeks/Months)
- specify what should be monitored

INFORMATION PRIORITY:
1. Current portfolio positions, sizes, and cash — the portfolio to assess
2. Portfolio Analyzer conclusions — existing weaknesses and exposure assessments
3. Opportunity Finder — risks and uncertainties already identified
4. Sector Monitor
5. Event Monitor
6. Market Monitor
7. News Monitor
8. Web search results (verify and supplement — not replace — the stored analyses)
9. Company Monitor data for held companies

CURRENT DATE VALIDATION:
The current UTC date is provided in the user prompt.
Only refer to upcoming events as upcoming if they are in the future.
If an event has already occurred, reference its published result rather than treating it as upcoming.

EVIDENCE-BASED REASONING:
Clearly distinguish facts, reasonable expectations, and analytical judgement.
Avoid generic risk language.
Explain why each risk applies specifically to this portfolio given its actual holdings and exposures.

riskScore is an integer 0–100 representing overall portfolio risk level (0 = minimal risk, 100 = extreme risk).

scoreDrivers should include 3–6 key factors that raise or lower the riskScore.
impact "Positive" means the factor reduces risk; "Negative" means it increases risk.

Return JSON only — no markdown, no code fences, no extra text.

OUTPUT RULES:
- Return approximately 5 top risks ordered by severity and probability
- Do not include the timestamp or analysisDuration fields — the server sets those

Return exactly:
{"executiveSummary":"...","overallRiskLevel":"Low|Moderate|High","mainConclusion":{"title":"...","reason":"..."},"riskScore":0,"scoreDrivers":[{"factor":"...","impact":"Positive|Negative","reason":"..."}],"topRisks":[{"title":"...","category":"Company|Sector|Macro|Currency|Liquidity|Event|Geopolitical|Diversification","probability":"Low|Medium|High","severity":"Low|Medium|High","timeHorizon":"Immediate|Weeks|Months","reason":"...","monitor":"..."}],"portfolioWeaknesses":["..."],"portfolioStrengths":["..."],"watchClosely":["..."]}`;

function buildUserPrompt(
  nowIso: string,
  portfolioContext: string,
  portfolioAnalyzerContext: string | null,
  opportunityFinderContext: string | null,
  marketContext: string | null,
  eventContext: string | null,
  newsContext: string | null,
  sectorContext: string | null,
  companyContexts: Record<string, string>
): string {
  const blocks: string[] = [
    `Current UTC: ${nowIso}`,
    "",
    "Assess the risks facing this portfolio over the next 1–3 months.",
    "",
    "Current Portfolio:",
    portfolioContext,
  ];

  if (portfolioAnalyzerContext) {
    blocks.push(
      "",
      "Portfolio Analyzer conclusions (existing weaknesses and exposures — use as your starting context):",
      portfolioAnalyzerContext
    );
  }

  if (opportunityFinderContext) {
    blocks.push(
      "",
      "Opportunity Finder context (identified risks and uncertainties — do not repeat verbatim):",
      opportunityFinderContext
    );
  }

  if (sectorContext) {
    blocks.push(
      "",
      "Sector Monitor context (sector conditions — do not repeat verbatim):",
      sectorContext
    );
  }

  if (eventContext) {
    blocks.push(
      "",
      "Event Monitor context (upcoming events — do not repeat verbatim):",
      eventContext
    );
  }

  if (marketContext) {
    blocks.push(
      "",
      "Market Monitor context (macro conditions — do not repeat verbatim):",
      marketContext
    );
  }

  if (newsContext) {
    blocks.push(
      "",
      "News Monitor context (recent news — do not repeat verbatim):",
      newsContext
    );
  }

  for (const [ticker, ctx] of Object.entries(companyContexts)) {
    blocks.push(
      "",
      `Company Monitor context for held position ${ticker} (do not repeat verbatim):`,
      ctx
    );
  }

  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/risk-analyzer/analyze", async (req, res): Promise<void> => {
  systemLog.logUser(MODULE_NAME, "User manually started risk analysis");

  const startTime = Date.now();
  const nowIso = new Date().toISOString();
  let lastDebug: AiDebugInfo | undefined;

  // ── Portfolio Manager ─────────────────────────────────────────────────────

  const portfolioEntry = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  if (!portfolioEntry) {
    res.status(400).json({
      error: "No portfolio data available. Please run Portfolio Manager first.",
    });
    return;
  }

  const portfolioResult = portfolioEntry.result as Record<string, unknown>;

  if (portfolioResult.isMockData) {
    systemLog.logWarning(MODULE_NAME, "Risk analysis performed using mock portfolio data");
  }

  const accounts = Array.isArray(portfolioResult.accounts)
    ? (portfolioResult.accounts as Array<Record<string, unknown>>)
    : [];

  const portfolioSummary = {
    baseCurrency: portfolioResult.baseCurrency,
    totalValue: portfolioResult.totalValue,
    totalAvailableCash: portfolioResult.totalAvailableCash,
    totalUnrealizedProfitLoss: portfolioResult.totalUnrealizedProfitLoss,
    accounts: accounts.map((a) => ({
      currency: a.currency,
      totalValue: a.totalValue,
      positions: Array.isArray(a.positions)
        ? (a.positions as Array<Record<string, unknown>>).map((p) => ({
            symbol: p.symbol,
            name: p.name,
            quantity: p.quantity,
            marketValue: p.marketValue,
            marketValueBaseCurrency: p.marketValueBaseCurrency,
            profitLoss: p.profitLoss,
            currency: p.currency,
          }))
        : [],
    })),
  };
  const portfolioContext = JSON.stringify(portfolioSummary);

  // ── Portfolio Analyzer ────────────────────────────────────────────────────

  const analyzerEntry = analysisRepository.get<Record<string, unknown>>("portfolio-analyzer");
  const portfolioAnalyzerContext = analyzerEntry
    ? JSON.stringify({
        executiveSummary: analyzerEntry.result.executiveSummary,
        mainConclusion: analyzerEntry.result.mainConclusion,
        overallRating: analyzerEntry.result.overallRating,
        overallOutlook: analyzerEntry.result.overallOutlook,
        portfolioScore: analyzerEntry.result.portfolioScore,
        strengths: analyzerEntry.result.strengths,
        weaknesses: analyzerEntry.result.weaknesses,
        topRisks: analyzerEntry.result.topRisks,
        sectorAssessment: analyzerEntry.result.sectorAssessment,
      })
    : null;

  // ── Opportunity Finder ────────────────────────────────────────────────────

  const opportunityEntry = analysisRepository.get<Record<string, unknown>>("opportunity-finder");
  const opportunityFinderContext = opportunityEntry
    ? JSON.stringify({
        executiveSummary: opportunityEntry.result.executiveSummary,
        overallOpportunityLevel: opportunityEntry.result.overallOpportunityLevel,
        topOpportunities: Array.isArray(opportunityEntry.result.topOpportunities)
          ? (opportunityEntry.result.topOpportunities as Array<Record<string, unknown>>).map((o) => ({
              company: o.company,
              ticker: o.ticker,
              mainRisk: o.mainRisk,
              confidence: o.confidence,
            }))
          : [],
      })
    : null;

  // ── Market Monitor ────────────────────────────────────────────────────────

  const marketEntry = analysisRepository.get<Record<string, unknown>>("market-monitor");
  const marketContext = marketEntry
    ? JSON.stringify({
        marketSentiment: marketEntry.result.marketSentiment,
        riskLevel: marketEntry.result.riskLevel,
        summary: marketEntry.result.summary,
        positiveFactors: marketEntry.result.positiveFactors,
        negativeFactors: marketEntry.result.negativeFactors,
        keyRisks: marketEntry.result.keyRisks,
      })
    : null;

  // ── Event Monitor ─────────────────────────────────────────────────────────

  const eventEntry = analysisRepository.get<Record<string, unknown>>("event-monitor");
  const eventContext = eventEntry
    ? JSON.stringify({
        summary: eventEntry.result.summary,
        nextMajorEvent: eventEntry.result.nextMajorEvent,
        events: Array.isArray(eventEntry.result.events)
          ? (eventEntry.result.events as Array<Record<string, unknown>>).map((e) => ({
              title: e.title,
              date: e.date,
              importance: e.importance,
              expectedImpact: e.expectedImpact,
            }))
          : [],
      })
    : null;

  // ── News Monitor ──────────────────────────────────────────────────────────

  const newsEntry = analysisRepository.get<Record<string, unknown>>("news-monitor");
  const newsContext = newsEntry
    ? JSON.stringify({
        executiveSummary: newsEntry.result.executiveSummary,
        overallMarketImpact: newsEntry.result.overallMarketImpact,
        topStory: newsEntry.result.topStory,
        news: Array.isArray(newsEntry.result.news)
          ? (newsEntry.result.news as Array<Record<string, unknown>>).map((n) => ({
              title: n.title,
              category: n.category,
              importance: n.importance,
              marketImpact: n.marketImpact,
            }))
          : [],
      })
    : null;

  // ── Sector Monitor ────────────────────────────────────────────────────────

  const sectorEntry = analysisRepository.get<Record<string, unknown>>("sector-monitor");
  const sectorContext = sectorEntry
    ? JSON.stringify({
        executiveSummary: sectorEntry.result.executiveSummary,
        overallOutlook: sectorEntry.result.overallOutlook,
        sectors: Array.isArray(sectorEntry.result.sectors)
          ? (sectorEntry.result.sectors as Array<Record<string, unknown>>).map((s) => ({
              name: s.name,
              rating: s.rating,
              trend: s.trend,
              summary: s.summary,
            }))
          : [],
      })
    : null;

  // ── Company Monitor for held positions (via companyIdentityStore) ─────────

  const allRepoEntries = analysisRepository.getAll();
  const companyMonitorCandidates = allRepoEntries
    .filter((e) => e.moduleName.startsWith("company-monitor:"))
    .map((e) => ({ key: e.moduleName, result: e.result as Record<string, unknown> }));

  const companyContexts: Record<string, string> = {};
  let hasMissingCompanyData = false;

  for (const account of accounts) {
    const posArr = Array.isArray(account.positions)
      ? (account.positions as Array<Record<string, unknown>>)
      : [];
    for (const pos of posArr) {
      const symbol = String(pos.symbol ?? pos.ticker ?? "").trim().toUpperCase();
      if (!symbol || symbol in companyContexts) continue;
      const resolved = companyIdentityStore.resolve(
        symbol,
        { companyName: String(pos.name ?? "") },
        companyMonitorCandidates
      );
      if (resolved) {
        const entry = analysisRepository.get<Record<string, unknown>>(resolved.key);
        if (entry) {
          const r = entry.result as Record<string, unknown>;
          companyContexts[symbol] = JSON.stringify({
            executiveSummary: r.executiveSummary,
            investmentView: r.investmentView,
            currentSituation: r.currentSituation,
            catalysts: r.catalysts,
            risks: r.risks,
            earningsAndGuidance: r.earningsAndGuidance,
            keyThingsToWatch: r.keyThingsToWatch,
          });
        } else {
          hasMissingCompanyData = true;
        }
      } else {
        hasMissingCompanyData = true;
      }
    }
  }

  if (hasMissingCompanyData) {
    systemLog.logWarning(
      MODULE_NAME,
      "Company Monitor analysis missing for one or more holdings"
    );
  }

  req.log.info(
    {
      hasPortfolioAnalyzer: !!portfolioAnalyzerContext,
      hasOpportunityFinder: !!opportunityFinderContext,
      hasMarket: !!marketContext,
      hasEvent: !!eventContext,
      hasNews: !!newsContext,
      hasSector: !!sectorContext,
      holdingCompanyContextCount: Object.keys(companyContexts).length,
    },
    "Context loaded from Analysis Repository"
  );

  // ── Load previous history for change logging ───────────────────────────────

  const historyEntry = analysisRepository.get<{ entries: RiskHistoryEntry[] }>("risk-analyzer-history");
  const previousEntry = historyEntry?.result?.entries?.[0] ?? null;

  // ── AI call with retry ─────────────────────────────────────────────────────

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: unknown;
    let debug: AiDebugInfo;

    try {
      ({ result, debug } = await callAiWithWebSearch<unknown>(
        SYSTEM_PROMPT,
        buildUserPrompt(
          nowIso,
          portfolioContext,
          portfolioAnalyzerContext,
          opportunityFinderContext,
          marketContext,
          eventContext,
          newsContext,
          sectorContext,
          companyContexts
        ),
        { model: "gpt-4o", maxTokens: 4000, temperature: 0.1 }
      ));
    } catch (err) {
      req.log.error({ err }, "AI service call failed");
      systemLog.logError(MODULE_NAME, "Risk analysis failed");
      res.status(500).json({
        error: err instanceof Error ? err.message : "AI service call failed",
      });
      return;
    }

    lastDebug = debug;

    const analysisDuration = Date.now() - startTime;
    const parsed = RunRiskAnalyzerResponse.safeParse({
      ...(result as Record<string, unknown>),
      timestamp: nowIso,
      analysisDuration,
    });

    if (parsed.success) {
      // ── Store result ──────────────────────────────────────────────────────
      analysisRepository.save("risk-analyzer", parsed.data);

      // ── Update history ────────────────────────────────────────────────────
      const existingEntries = historyEntry?.result?.entries ?? [];
      const newHistoryEntry: RiskHistoryEntry = {
        timestamp: nowIso,
        overallRiskLevel: parsed.data.overallRiskLevel,
        riskScore: parsed.data.riskScore,
        topThreeRisks: parsed.data.topRisks.slice(0, 3).map((r) => ({
          title: r.title,
          category: r.category,
          probability: r.probability,
          severity: r.severity,
        })),
        overallConclusion: parsed.data.mainConclusion.title,
      };
      const updatedHistory = [newHistoryEntry, ...existingEntries].slice(0, MAX_HISTORY);
      analysisRepository.save("risk-analyzer-history", { entries: updatedHistory });

      // ── System Log ────────────────────────────────────────────────────────
      systemLog.logInfo(MODULE_NAME, "Risk analysis completed");

      const topRisk = parsed.data.topRisks[0];
      if (topRisk) {
        systemLog.logInternal(
          MODULE_NAME,
          `Highest current risk: ${topRisk.title}`
        );
      }

      if (previousEntry) {
        const prevScore = previousEntry.riskScore;
        const currScore = parsed.data.riskScore;
        if (currScore !== prevScore) {
          const direction = currScore > prevScore ? "increased" : "decreased";
          systemLog.logInternal(
            MODULE_NAME,
            `Risk score ${direction} from ${prevScore} to ${currScore}`
          );
        }

        // Log new risks that weren't in the previous top three
        const prevRiskTitles = new Set(previousEntry.topThreeRisks.map((r) => r.title.toLowerCase()));
        for (const risk of parsed.data.topRisks.slice(0, 3)) {
          if (!prevRiskTitles.has(risk.title.toLowerCase())) {
            systemLog.logInternal(
              MODULE_NAME,
              `New ${risk.category.toLowerCase()} risk detected: ${risk.title}`
            );
          }
        }
      }

      res.json({ ...parsed.data, _debug: debug });
      return;
    }

    if (attempt < MAX_ATTEMPTS) {
      req.log.warn(
        { errors: parsed.error.message, attempt },
        "Invalid AI response schema — retrying once"
      );
    } else {
      req.log.error(
        { errors: parsed.error.message },
        "Invalid AI response schema after retry"
      );
      systemLog.logError(MODULE_NAME, "Risk analysis failed");
      res.status(500).json({
        error: "AI returned an invalid response structure. Please try again.",
        _debug: lastDebug,
      });
    }
  }
});

export default router;
