/**
 * Portfolio Analyzer Route
 *
 * Uses the OpenAI Responses API with live web search to evaluate the user's
 * complete portfolio for a 1–3 month investment horizon.
 *
 * Reads context from five modules (Portfolio Manager, Market Monitor,
 * Event Monitor, News Monitor, Sector Monitor) and any available Company
 * Monitor analyses for currently-held positions. Never communicates
 * directly with those modules — only through the Analysis Repository.
 *
 * Results are stored under the key "portfolio-analyzer".
 * Invalid results are never stored.
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunPortfolioAnalysisResponse } from "@workspace/api-zod";
import { callAiWithWebSearch, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";

const router: IRouter = Router();

const MODULE_NAME = "Portfolio Analyzer";
const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an experienced institutional portfolio manager.

Your task is to analyse the user's current portfolio for an investment horizon of approximately 1–3 months.

WEB SEARCH REQUIREMENT:
You must perform a web search before producing your analysis. Search for recent developments, price moves, news and events relevant to the held positions and the broader market.

INFORMATION PRIORITY (after you have searched):
1. Current portfolio positions, position sizes, and cash
2. Existing Company Monitor analyses for held companies (use as primary company-specific context)
3. Sector Monitor
4. Event Monitor
5. Market Monitor
6. News Monitor
7. Web search results (use to verify and supplement the stored analyses — not to replace them)

Use the supplied module analyses as the primary analytical context.
Do not disregard or unnecessarily repeat the supplied analyses.
If fresh web information conflicts with stored context, prefer the newer reliable information and mention the conflict in the analysis.
Company-specific information should take priority over broad macro commentary when assessing an individual holding.
Broad market information should only affect a position assessment when it is materially relevant.

SCOPE — PORTFOLIO ANALYZER ONLY (not a Trade Decision Engine):
Do not recommend explicit buy, sell, trim, add or hedge actions.
Recommended actions must use language such as: Monitor, Review, Investigate, Watch, Reassess after, Prepare for.
For example, write "Review Serve Robotics exposure before earnings because event risk is high" — not "Consider trimming Serve Robotics ahead of earnings".

ANALYTICAL BALANCE:
Evaluate both the positive and negative consequences of major portfolio characteristics.
For example, a large cash position may provide flexibility but may also create opportunity cost.
Avoid one-sided conclusions.

NO REPETITION:
Do not repeat the same conclusion across Executive Summary, Weaknesses, Risks, Position Comments, Recommended Actions and Things to Watch.
Each section must contribute a different type of information.
Executive Summary must be concise — approximately 120 words maximum.

EVIDENCE-BASED REASONING:
Explain why each important conclusion follows from the portfolio data, stored module context or verified current information.
Avoid generic investment language.
Clearly distinguish confirmed facts, reasonable expectations and analytical judgement.

Return JSON only — no markdown, no code fences, no extra text.

OUTPUT RULES:
- Return exactly the JSON structure shown below — nothing else
- portfolioScore: integer 0–100
- scoreDrivers: 3–6 items explaining why the portfolio received its score
- Do not include the timestamp or analysisDuration fields — the server sets those

Return exactly:
{"mainConclusion":{"title":"...","reason":"..."},"scoreDrivers":[{"factor":"...","impact":"Positive|Negative","reason":"..."}],"executiveSummary":"...","overallRating":"Excellent|Good|Fair|Weak","overallOutlook":"Bullish|Moderately Bullish|Neutral|Moderately Bearish|Bearish","portfolioScore":75,"strengths":["..."],"weaknesses":["..."],"topRisks":[{"title":"...","reason":"...","severity":"High|Medium|Low"}],"topOpportunities":[{"title":"...","reason":"...","confidence":"High|Medium|Low"}],"sectorAssessment":"...","positionComments":[{"ticker":"...","summary":"...","attention":"High|Medium|Low"}],"recommendedActions":[{"action":"...","reason":"...","priority":"High|Medium|Low"}],"thingsToWatch":["..."]}`;

function buildUserPrompt(
  nowIso: string,
  portfolioContext: string,
  marketContext: string | null,
  eventContext: string | null,
  newsContext: string | null,
  sectorContext: string | null,
  companyContexts: Record<string, string>
): string {
  const blocks: string[] = [
    `UTC: ${nowIso}`,
    "",
    "Perform a complete portfolio analysis for the next 1-3 months.",
    "",
    "Current Portfolio:",
    portfolioContext,
  ];

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

router.post("/portfolio-analyzer/analyze", async (req, res): Promise<void> => {
  systemLog.logUser(MODULE_NAME, "User manually started portfolio analysis");

  const startTime = Date.now();
  const nowIso = new Date().toISOString();
  let lastDebug: AiDebugInfo | undefined;

  // ── Read Portfolio Manager from repository ─────────────────────────────────

  const portfolioEntry = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  if (!portfolioEntry) {
    res.status(400).json({
      error:
        "No portfolio data available. Please run Portfolio Manager first.",
    });
    return;
  }

  const portfolioResult = portfolioEntry.result as Record<string, unknown>;

  if (portfolioResult.isMockData) {
    systemLog.logWarning(
      MODULE_NAME,
      "Portfolio analysis is based on mock portfolio data"
    );
  }

  // Collect held tickers from all positions
  const accounts = Array.isArray(portfolioResult.accounts)
    ? (portfolioResult.accounts as Array<Record<string, unknown>>)
    : [];

  const tickers: string[] = [];
  for (const account of accounts) {
    const positions = Array.isArray(account.positions)
      ? (account.positions as Array<Record<string, unknown>>)
      : [];
    for (const pos of positions) {
      const ticker = String(pos.symbol ?? pos.ticker ?? "")
        .trim()
        .toUpperCase();
      if (ticker && !tickers.includes(ticker)) tickers.push(ticker);
    }
  }

  // ── Build Company Monitor alias map ──────────────────────────────────────
  // Saxo display symbols (e.g. "NOVO B") may differ from the ticker stored in
  // Company Monitor (e.g. "NVO"). We build a lookup from every stored
  // company-monitor entry: normalised ticker → repository key.

  const allRepoEntries = analysisRepository.getAll();
  const companyMonitorAliasMap = new Map<string, string>(); // UPPER ticker → repo key
  for (const entry of allRepoEntries) {
    if (entry.moduleName.startsWith("company-monitor:")) {
      // Map the key suffix itself
      const keySuffix = entry.moduleName.slice("company-monitor:".length).toUpperCase();
      companyMonitorAliasMap.set(keySuffix, entry.moduleName);
      // Also map the stored company.ticker (may differ from key suffix)
      const storedResult = entry.result as Record<string, unknown>;
      const company = storedResult.company as Record<string, unknown> | undefined;
      if (company?.ticker) {
        companyMonitorAliasMap.set(String(company.ticker).toUpperCase(), entry.moduleName);
      }
    }
  }

  // ── Load Company Monitor analyses for held positions ───────────────────────

  const companyContexts: Record<string, string> = {};
  const missingCompanyTickers: string[] = [];

  for (const ticker of tickers) {
    // 1. Try exact key match
    let entry = analysisRepository.get<Record<string, unknown>>(`company-monitor:${ticker}`);

    // 2. Fall back to alias map (handles Saxo display symbols like "NOVO B" → "NVO")
    if (!entry) {
      const aliasKey = companyMonitorAliasMap.get(ticker);
      if (aliasKey) {
        entry = analysisRepository.get<Record<string, unknown>>(aliasKey);
      }
    }

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
      missingCompanyTickers.push(ticker);
    }
  }

  for (const ticker of missingCompanyTickers) {
    systemLog.logWarning(
      MODULE_NAME,
      `Portfolio analysis performed without Company Monitor data for ${ticker}`
    );
  }

  // ── Build portfolio context string ─────────────────────────────────────────

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

  // ── Read other modules from repository ────────────────────────────────────

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

  const eventEntry = analysisRepository.get<Record<string, unknown>>("event-monitor");
  const eventContext = eventEntry
    ? JSON.stringify({
        summary: eventEntry.result.summary,
        nextMajorEvent: eventEntry.result.nextMajorEvent,
        events: Array.isArray(eventEntry.result.events)
          ? (eventEntry.result.events as Array<Record<string, unknown>>).map(
              (e) => ({
                title: e.title,
                date: e.date,
                importance: e.importance,
                expectedImpact: e.expectedImpact,
              })
            )
          : [],
      })
    : null;

  const newsEntry = analysisRepository.get<Record<string, unknown>>("news-monitor");
  const newsContext = newsEntry
    ? JSON.stringify({
        executiveSummary: newsEntry.result.executiveSummary,
        overallMarketImpact: newsEntry.result.overallMarketImpact,
        topStory: newsEntry.result.topStory,
        news: Array.isArray(newsEntry.result.news)
          ? (newsEntry.result.news as Array<Record<string, unknown>>).map(
              (n) => ({
                title: n.title,
                category: n.category,
                importance: n.importance,
                marketImpact: n.marketImpact,
                affectedMarkets: n.affectedMarkets,
              })
            )
          : [],
      })
    : null;

  const sectorEntry = analysisRepository.get<Record<string, unknown>>("sector-monitor");
  const sectorContext = sectorEntry
    ? JSON.stringify({
        executiveSummary: sectorEntry.result.executiveSummary,
        overallOutlook: sectorEntry.result.overallOutlook,
        topSector: sectorEntry.result.topSector,
        sectors: Array.isArray(sectorEntry.result.sectors)
          ? (sectorEntry.result.sectors as Array<Record<string, unknown>>).map(
              (s) => ({
                name: s.name,
                rating: s.rating,
                trend: s.trend,
                summary: s.summary,
              })
            )
          : [],
      })
    : null;

  req.log.info(
    {
      tickers,
      missingCompanyTickers,
      hasMarket: !!marketContext,
      hasEvent: !!eventContext,
      hasNews: !!newsContext,
      hasSector: !!sectorContext,
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
      systemLog.logError(MODULE_NAME, "Portfolio analysis failed");
      res.status(500).json({
        error: err instanceof Error ? err.message : "AI service call failed",
      });
      return;
    }

    lastDebug = debug;

    const analysisDuration = Date.now() - startTime;
    const parsed = RunPortfolioAnalysisResponse.safeParse({
      ...(result as Record<string, unknown>),
      timestamp: nowIso,
      analysisDuration,
    });

    if (parsed.success) {
      analysisRepository.save("portfolio-analyzer", parsed.data);

      // ── Meaningful system log entries ────────────────────────────────────

      systemLog.logInfo(MODULE_NAME, "Portfolio analysis completed");
      systemLog.logInfo(
        MODULE_NAME,
        `Main conclusion: ${parsed.data.mainConclusion.title}`
      );
      systemLog.logInfo(
        MODULE_NAME,
        `Overall rating: ${parsed.data.overallRating}`
      );
      systemLog.logInfo(
        MODULE_NAME,
        `Overall outlook: ${parsed.data.overallOutlook}`
      );

      const highRisk = parsed.data.topRisks.find((r) => r.severity === "High");
      const topRisk = highRisk ?? parsed.data.topRisks[0];
      if (topRisk) {
        systemLog.logInternal(
          MODULE_NAME,
          `Main concern identified: ${topRisk.title} — ${topRisk.reason}`
        );
      }

      const highOpp = parsed.data.topOpportunities.find(
        (o) => o.confidence === "High"
      );
      const topOpp = highOpp ?? parsed.data.topOpportunities[0];
      if (topOpp) {
        systemLog.logInternal(
          MODULE_NAME,
          `Main opportunity identified: ${topOpp.title} — ${topOpp.reason}`
        );
      }

      const highAction = parsed.data.recommendedActions.find(
        (a) => a.priority === "High"
      );
      const topAction = highAction ?? parsed.data.recommendedActions[0];
      if (topAction) {
        systemLog.logInternal(
          MODULE_NAME,
          `Recommended highest-priority action: ${topAction.action}`
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
      systemLog.logError(MODULE_NAME, "Portfolio analysis failed");
      res.status(500).json({
        error: "AI returned an invalid response structure. Please try again.",
        _debug: lastDebug,
      });
    }
  }
});

export default router;
