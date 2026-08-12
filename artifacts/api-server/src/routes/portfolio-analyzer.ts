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
import { callAi, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";
import { companyIdentityStore } from "../lib/company-identity";
import { buildPriceContextBlockCompact } from "../lib/price-context-service.js";
import {
  getMarketAiContext,
  getNewsAiContext,
  getEventAiContext,
  getSectorAiContext,
  getCompanyAiContext,
} from "../lib/downstream-ai-context.js";

const router: IRouter = Router();

const MODULE_NAME = "Portfolio Analyzer";
const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an experienced institutional portfolio manager.

Your task is to analyse the user's current portfolio for an investment horizon of approximately 1–3 months.

INFORMATION PRIORITY:
1. Current portfolio positions, position sizes, and cash
2. Existing Company Monitor analyses for held companies (use as primary company-specific context)
3. Sector Monitor
4. Event Monitor
5. Market Monitor
6. News Monitor

Use the supplied module analyses as the primary analytical context.
Do not disregard or unnecessarily repeat the supplied analyses.
Company-specific information should take priority over broad macro commentary when assessing an individual holding.
Broad market information should only affect a position assessment when it is materially relevant.

SCOPE — PORTFOLIO ANALYZER ONLY (not a Trade Decision Engine):
Do not recommend explicit buy, sell, trim, add or hedge actions.
Recommended actions must use language such as: Monitor, Review, Investigate, Watch, Reassess after, Prepare for.
For example, write "Review Serve Robotics exposure before earnings because event risk is high" — not "Consider trimming Serve Robotics ahead of earnings".

POSITION ATTENTION LEVELS:
Use attention=High only when a position requires close monitoring because of material risk, uncertainty or an imminent catalyst — for example a near-term earnings release, a regulatory decision, significant recent price volatility, or a deteriorating fundamental situation.
Do not assign High merely because the company is large, well-known or performing well.
Use attention=Medium for positions that warrant periodic review without urgency.
Use attention=Low for positions that are stable and require no near-term action.

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
{"mainConclusion":{"title":"...","reason":"..."},"scoreDrivers":[{"factor":"...","impact":"Positive|Negative|Neutral","reason":"..."}],"executiveSummary":"...","overallRating":"Excellent|Good|Fair|Weak","overallOutlook":"Bullish|Moderately Bullish|Neutral|Moderately Bearish|Bearish","portfolioScore":75,"strengths":["..."],"weaknesses":["..."],"topRisks":[{"title":"...","reason":"...","severity":"High|Medium|Low"}],"topOpportunities":[{"title":"...","reason":"...","confidence":"High|Medium|Low"}],"sectorAssessment":"...","positionComments":[{"ticker":"...","summary":"...","attention":"High|Medium|Low"}],"recommendedActions":[{"action":"...","reason":"...","priority":"High|Medium|Low"}],"thingsToWatch":["..."]}`;

function buildUserPrompt(
  nowIso: string,
  portfolioContext: string,
  marketContext: string | null,
  eventContext: string | null,
  newsContext: string | null,
  sectorContext: string | null,
  companyContexts: Record<string, string>,
  priceContexts: Record<string, string>
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

  // §7: Compact price context — one JSON line per symbol; prose rules in system prompt
  const priceCtxEntries = Object.entries(priceContexts);
  if (priceCtxEntries.length > 0) {
    blocks.push(
      "",
      "PRICE CONTEXT for held positions (compact Saxo data — fields: state, recent, r5d, r1m, r3m, volatility):"
    );
    for (const [sym, pc] of priceCtxEntries) {
      blocks.push(`${sym}: ${pc}`);
    }
  }

  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/portfolio-analyzer/analyze", async (req, res): Promise<void> => {
  const orchestratorTrigger = req.headers['x-orchestrator-trigger'];
  if (orchestratorTrigger) {
    systemLog.logInfo(MODULE_NAME, `Scheduled run (trigger: ${orchestratorTrigger})`);
  } else {
    systemLog.logUser(MODULE_NAME, "User manually started portfolio analysis");
  }

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

  // ── Build Company Monitor candidate list ─────────────────────────────────
  // Collect all stored company-monitor entries as candidates for identity
  // resolution. The companyIdentityStore resolves Saxo display symbols
  // (e.g. "NOVO B") to the correct repository key using a 5-step chain:
  // UIC → ISIN → saved alias → exact ticker → normalised name.

  const allRepoEntries = analysisRepository.getAll();
  const companyMonitorCandidates = allRepoEntries
    .filter((e) => e.moduleName.startsWith("company-monitor:"))
    .map((e) => ({
      key: e.moduleName,
      result: e.result as Record<string, unknown>,
    }));

  // ── Load Company Monitor analyses for held positions ───────────────────────

  const companyContexts: Record<string, string> = {};
  const missingCompanyTickers: string[] = [];
  const matchLog: Array<{ symbol: string; key: string; method: string }> = [];

  for (const ticker of tickers) {
    // Find the original position entry so we can pass name for step-5 matching
    let posName: string | null = null;
    for (const account of accounts) {
      const posArr = Array.isArray(account.positions)
        ? (account.positions as Array<Record<string, unknown>>)
        : [];
      const found = posArr.find(
        (p) =>
          String(p.symbol ?? p.ticker ?? "")
            .trim()
            .toUpperCase() === ticker
      );
      if (found) {
        posName = String(found.name ?? "");
        break;
      }
    }

    const resolved = companyIdentityStore.resolve(
      ticker,
      { companyName: posName },
      companyMonitorCandidates
    );

    if (resolved) {
      // §1: Compact downstream context getter (replaces manual JSON construction)
      const ctx = getCompanyAiContext(resolved.key, ticker);
      if (ctx) {
        companyContexts[ticker] = JSON.stringify(ctx);
        matchLog.push({ symbol: ticker, key: resolved.key, method: resolved.method });
      } else {
        missingCompanyTickers.push(ticker);
      }
    } else {
      missingCompanyTickers.push(ticker);
    }
  }

  // Debug-only: log which Company Monitor analyses were matched and how
  req.log.debug({ matchLog }, "Company Monitor identity resolution");

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

  // ── Read other modules — §1: compact downstream context layer ─────────────

  const marketCtx = getMarketAiContext();
  const marketContext = marketCtx ? JSON.stringify(marketCtx) : null;

  // Filter events and news to held ticker symbols automatically.
  const eventCtx = getEventAiContext(tickers);
  const eventContext = eventCtx ? JSON.stringify(eventCtx) : null;

  // §6: getNewsAiContext filters to held tickers + High-importance items.
  const newsCtx = getNewsAiContext(tickers);
  const newsContext = newsCtx ? JSON.stringify(newsCtx) : null;

  const sectorCtx = getSectorAiContext();
  const sectorContext = sectorCtx ? JSON.stringify(sectorCtx) : null;

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
      ({ result, debug } = await callAi<unknown>(
        SYSTEM_PROMPT,
        buildUserPrompt(
          nowIso,
          portfolioContext,
          marketContext,
          eventContext,
          newsContext,
          sectorContext,
          companyContexts,
          buildPriceContextBlockCompact(tickers)
        ),
        { model: "gpt-4o", maxTokens: 2500, temperature: 0.1, module: "portfolio-analyzer", operation: "analyze", retryNumber: attempt }
      )); // §7: buildPriceContextBlockCompact replaces buildPriceContextBlock inside buildUserPrompt
    } catch (err) {
      const isLastAttempt = attempt >= MAX_ATTEMPTS;
      req.log[isLastAttempt ? "error" : "warn"](
        { err, attempt },
        isLastAttempt ? "AI service call failed after all attempts" : "AI service call failed — retrying"
      );
      if (isLastAttempt) {
        systemLog.logError(MODULE_NAME, "Portfolio analysis failed");
        res.status(500).json({
          error: err instanceof Error ? err.message : "AI service call failed",
          _debug: extractAiErrorDebug(err),
        });
        return;
      }
      continue;
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
