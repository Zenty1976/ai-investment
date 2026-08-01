/**
 * Opportunity Finder Route
 *
 * Identifies the best investment opportunities for a 1–3 month horizon that
 * complement the user's existing portfolio. Uses the OpenAI Responses API
 * with live web search.
 *
 * Reads context from: Portfolio Manager, Portfolio Analyzer, Market Monitor,
 * Event Monitor, News Monitor, Sector Monitor, and any available Company
 * Monitor analyses. Never communicates directly with Saxo or other modules —
 * only reads from the Analysis Repository.
 *
 * Results are stored under "opportunity-finder".
 * Invalid results are never stored.
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunOpportunityFinderResponse } from "@workspace/api-zod";
import { callAiWithWebSearch, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";

const router: IRouter = Router();

const MODULE_NAME = "Opportunity Finder";
const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an experienced institutional portfolio manager.

Your task is to identify the most attractive investment opportunities for the next 1–3 months.

WEB SEARCH REQUIREMENT:
You must perform a web search before producing your analysis. Search for current market conditions, sector momentum, recent earnings, upcoming events, and specific investment opportunities that would complement the given portfolio.

OBJECTIVE:
Use the existing portfolio as your starting point.
Do not simply recommend the strongest stocks.
Instead identify opportunities that improve the portfolio considering:
- diversification
- sector exposure
- macro conditions
- upcoming events
- current market leadership
- valuation
- risk
- existing holdings
- current cash position

Avoid recommending companies already held in the portfolio unless there is a compelling reason.

INFORMATION PRIORITY:
1. Current portfolio positions, position sizes, and cash — as the baseline to improve upon
2. Portfolio Analyzer conclusions — existing gaps, weaknesses, and opportunities already identified
3. Sector Monitor
4. Event Monitor
5. Market Monitor
6. News Monitor
7. Web search results (verify and supplement stored analyses — not replace them)
8. Company Monitor data for any mentioned companies

Use the stored module analyses as the primary context.
Do not disregard or unnecessarily repeat the stored analyses.
If fresh web information conflicts with stored context, prefer the newer reliable information and mention the conflict.

EVIDENCE-BASED REASONING:
Explain why each opportunity fits this specific portfolio.
Clearly distinguish confirmed facts, reasonable expectations and analytical judgement.
Avoid generic investment language.

Return JSON only — no markdown, no code fences, no extra text.

OUTPUT RULES:
- Return approximately 5 top opportunities
- Return exactly the JSON structure shown below — nothing else
- Do not include the timestamp or analysisDuration fields — the server sets those

Return exactly:
{"executiveSummary":"...","overallOpportunityLevel":"High|Medium|Low","topOpportunities":[{"company":"...","ticker":"...","sector":"...","country":"...","summary":"...","whyItFits":"...","mainCatalyst":"...","mainRisk":"...","confidence":"High|Medium|Low","priority":"High|Medium|Low"}],"sectorIdeas":[{"sector":"...","reason":"..."}],"thingsToResearch":["..."]}`;

function buildUserPrompt(
  nowIso: string,
  portfolioContext: string,
  portfolioAnalyzerContext: string | null,
  marketContext: string | null,
  eventContext: string | null,
  newsContext: string | null,
  sectorContext: string | null,
  companyContexts: Record<string, string>
): string {
  const blocks: string[] = [
    `UTC: ${nowIso}`,
    "",
    "Identify investment opportunities that complement and strengthen this portfolio.",
    "",
    "Current Portfolio (your baseline — find opportunities that improve this):",
    portfolioContext,
  ];

  if (portfolioAnalyzerContext) {
    blocks.push(
      "",
      "Portfolio Analyzer conclusions (existing gaps, weaknesses and opportunities identified — use as your starting point for what is missing):",
      portfolioAnalyzerContext
    );
  }

  if (marketContext) {
    blocks.push(
      "",
      "Market Monitor context (macro conditions — do not repeat this verbatim):",
      marketContext
    );
  }

  if (eventContext) {
    blocks.push(
      "",
      "Event Monitor context (upcoming market events — do not repeat this verbatim):",
      eventContext
    );
  }

  if (newsContext) {
    blocks.push(
      "",
      "News Monitor context (recent market-moving news — do not repeat this verbatim):",
      newsContext
    );
  }

  if (sectorContext) {
    blocks.push(
      "",
      "Sector Monitor context (sector ratings and flows — do not repeat this verbatim):",
      sectorContext
    );
  }

  for (const [ticker, ctx] of Object.entries(companyContexts)) {
    blocks.push(
      "",
      `Company Monitor context for ${ticker} (use for company-specific assessment — do not repeat this verbatim):`,
      ctx
    );
  }

  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/opportunity-finder/analyze", async (req, res): Promise<void> => {
  systemLog.logUser(MODULE_NAME, "User manually started opportunity analysis");

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
    systemLog.logWarning(
      MODULE_NAME,
      "Opportunity analysis performed using mock portfolio data"
    );
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
        topOpportunities: analyzerEntry.result.topOpportunities,
        sectorAssessment: analyzerEntry.result.sectorAssessment,
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
        strongSectors: marketEntry.result.strongSectors,
        weakSectors: marketEntry.result.weakSectors,
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
              affectedMarkets: n.affectedMarkets,
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
        topSector: sectorEntry.result.topSector,
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

  // ── Company Monitor (for held positions) ──────────────────────────────────

  const companyContexts: Record<string, string> = {};
  const allEntries = analysisRepository.getAll();
  let hasMissingCompanyData = false;

  for (const account of accounts) {
    const posArr = Array.isArray(account.positions)
      ? (account.positions as Array<Record<string, unknown>>)
      : [];
    for (const pos of posArr) {
      const ticker = String(pos.symbol ?? pos.ticker ?? "").trim().toUpperCase();
      if (!ticker || ticker in companyContexts) continue;
      const entry = allEntries.find(
        (e) =>
          e.moduleName === `company-monitor:${ticker}` ||
          ((e.result as Record<string, unknown>).company as Record<string, unknown> | undefined)
            ?.ticker === ticker
      );
      if (entry) {
        const r = entry.result as Record<string, unknown>;
        companyContexts[ticker] = JSON.stringify({
          executiveSummary: r.executiveSummary,
          investmentView: r.investmentView,
          currentSituation: r.currentSituation,
          catalysts: r.catalysts,
          risks: r.risks,
          earningsAndGuidance: r.earningsAndGuidance,
          marketSentiment: r.marketSentiment,
          keyThingsToWatch: r.keyThingsToWatch,
        });
      } else {
        hasMissingCompanyData = true;
      }
    }
  }

  if (hasMissingCompanyData) {
    systemLog.logWarning(
      MODULE_NAME,
      "Company Monitor analysis missing for one or more portfolio holdings"
    );
  }

  req.log.info(
    {
      hasPortfolioAnalyzer: !!portfolioAnalyzerContext,
      hasMarket: !!marketContext,
      hasEvent: !!eventContext,
      hasNews: !!newsContext,
      hasSector: !!sectorContext,
      companyContextCount: Object.keys(companyContexts).length,
    },
    "Context loaded from Analysis Repository"
  );

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
      systemLog.logError(MODULE_NAME, "Opportunity analysis failed");
      res.status(500).json({
        error: err instanceof Error ? err.message : "AI service call failed",
      });
      return;
    }

    lastDebug = debug;

    const analysisDuration = Date.now() - startTime;
    const parsed = RunOpportunityFinderResponse.safeParse({
      ...(result as Record<string, unknown>),
      timestamp: nowIso,
      analysisDuration,
    });

    if (parsed.success) {
      analysisRepository.save("opportunity-finder", parsed.data);

      systemLog.logInfo(MODULE_NAME, "Opportunity analysis completed");
      systemLog.logInfo(
        MODULE_NAME,
        `Overall opportunity level: ${parsed.data.overallOpportunityLevel}`
      );

      const topOpp = parsed.data.topOpportunities.find((o) => o.priority === "High")
        ?? parsed.data.topOpportunities[0];
      if (topOpp) {
        systemLog.logInternal(
          MODULE_NAME,
          `Highest-priority opportunity: ${topOpp.company} because ${topOpp.whyItFits}`
        );
      }

      const mainReason = parsed.data.topOpportunities[0];
      if (mainReason) {
        systemLog.logInternal(
          MODULE_NAME,
          `Main reason for recommendation: ${mainReason.mainCatalyst}`
        );
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
      systemLog.logError(MODULE_NAME, "Opportunity analysis failed");
      res.status(500).json({
        error: "AI returned an invalid response structure. Please try again.",
        _debug: lastDebug,
      });
    }
  }
});

export default router;
