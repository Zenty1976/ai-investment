/**
 * Portfolio Analyzer Route
 *
 * Hybrid architecture: deterministic Portfolio Intelligence Engine computes
 * all quantitative facts (position weights, performance/contributions, sector/
 * currency exposure, price behaviour, company state, upcoming events) into a
 * compact PortfolioFacts object. OpenAI receives only that compact ground truth
 * and handles qualitative interpretation only.
 *
 * Skip logic: fingerprint of PortfolioFacts is stored on the result and
 * compared on every run. If unchanged, the stored result is returned without
 * calling OpenAI (saveSkipped + trackSkipped + _aiCalled: false).
 *
 * Reads context from Portfolio Manager, Market Monitor, News Monitor, Sector
 * Monitor, and Company Monitor analyses for held positions via the Analysis
 * Repository. Event Monitor data is consumed through the intelligence engine
 * (portfolioFacts.events) — not passed as raw JSON.
 *
 * Results are stored under the key "portfolio-analyzer".
 * Invalid results are never stored.
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunPortfolioAnalysisResponse } from "@workspace/api-zod";
import { callAi, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { getModel } from "../lib/ai-model-config.js";
import { normalizeAiResponse, classifyRetryReason } from "../lib/ai-response-normalizer.js";
import { analysisRepository } from "../lib/analysis-repository";
import { companyIdentityStore } from "../lib/company-identity";
import { buildPriceContextBlockCompact } from "../lib/price-context-service.js";
import {
  getMarketAiContext,
  getNewsAiContext,
  getSectorAiContext,
  getCompanyAiContext,
} from "../lib/downstream-ai-context.js";
import { computeRiskFacts } from "../lib/risk-intelligence-engine.js";
import {
  computePortfolioFacts,
  buildSlimPortfolioFacts,
} from "../lib/portfolio-intelligence-engine.js";
import { trackSkipped } from "../lib/openai-usage-service.js";

const router: IRouter = Router();

const MODULE_NAME = "Portfolio Analyzer";
const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an experienced institutional portfolio manager.

Your task is to analyse the user's current portfolio for an investment horizon of approximately 1–3 months.

PORTFOLIO FACTS — USE AS GROUND TRUTH:
All objective portfolio metrics have been pre-calculated by the backend and provided as
"Portfolio Facts" in the user message. These include: position weights, cash %,
sector/currency exposures, concentration, price-behaviour exposure percentages,
performance contributions (1D/5D/1M returns by holding), company state signals,
and upcoming events for held positions.
Use these facts as ground truth. Do NOT recalculate or re-derive these metrics.
Do NOT restate the numbers verbatim — interpret them.
Your role is qualitative portfolio interpretation: what is driving performance,
is the portfolio positioned well, what deserves attention next?

INFORMATION PRIORITY:
1. Portfolio Facts (pre-calculated ground truth — treat as authoritative)
2. Company Monitor contexts for held positions (primary qualitative source per company)
3. Sector Monitor (sector-level signals for held sectors only)
4. Market Monitor (macro context — only when materially relevant to holdings)
5. News Monitor (recent events affecting held positions)

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

// ─────────────────────────────────────────────────────────────────────────────
// Compact previous PA state (sent to AI for continuity — avoids full result)
// ─────────────────────────────────────────────────────────────────────────────

function buildCompactPreviousPaState(
  entry: { result: Record<string, unknown> } | undefined | null
): Record<string, unknown> | null {
  if (!entry?.result) return null;
  const r = entry.result;
  return {
    overallRating: r.overallRating,
    overallOutlook: r.overallOutlook,
    portfolioScore: r.portfolioScore,
    mainConclusionTitle: (r.mainConclusion as Record<string, unknown>)?.title,
    topRisks: (Array.isArray(r.topRisks) ? r.topRisks : [])
      .slice(0, 3)
      .map((risk: Record<string, unknown>) => risk.title),
    strengths: (Array.isArray(r.strengths) ? r.strengths : []).slice(0, 3),
    holdingsToWatch: Array.isArray(r.thingsToWatch)
      ? (r.thingsToWatch as string[]).slice(0, 3)
      : [],
    computedAt: r.timestamp,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// User prompt (hybrid)
// ─────────────────────────────────────────────────────────────────────────────

function buildUserPrompt(
  nowIso: string,
  slimPortfolioFacts: Record<string, unknown>,
  marketContext: string | null,
  newsContext: string | null,
  sectorContext: string | null,
  companyContexts: Record<string, string>,
  priceContexts: Record<string, string>,
  previousPaState: Record<string, unknown> | null
): string {
  const blocks: string[] = [
    `UTC: ${nowIso}`,
    "",
    "Analyse this portfolio for the next 1–3 months.",
    "Portfolio Facts are pre-calculated by the backend — use as ground truth for all quantitative assertions.",
    "",
    "PORTFOLIO FACTS (calculated deterministically — ground truth):",
    JSON.stringify(slimPortfolioFacts),
  ];

  if (marketContext) {
    blocks.push(
      "",
      "Market Monitor (macro context — apply only when materially relevant to a held position):",
      marketContext
    );
  }
  if (newsContext) {
    blocks.push(
      "",
      "News Monitor (recent news affecting held positions — do not repeat verbatim):",
      newsContext
    );
  }
  if (sectorContext) {
    blocks.push(
      "",
      "Sector Monitor (portfolio sectors only — sector ratings and flows):",
      sectorContext
    );
  }

  for (const [ticker, ctx] of Object.entries(companyContexts)) {
    blocks.push(
      "",
      `Company Monitor — ${ticker} (use for company-specific qualitative assessment):`,
      ctx
    );
  }

  // Compact price context — one JSON line per symbol
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

  if (previousPaState) {
    blocks.push(
      "",
      "Previous Portfolio Assessment (compact — for continuity only, not a constraint):",
      JSON.stringify(previousPaState)
    );
  }

  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/portfolio-analyzer/analyze", async (req, res): Promise<void> => {
  const orchestratorTrigger = req.headers["x-orchestrator-trigger"];
  if (orchestratorTrigger) {
    systemLog.logInfo(MODULE_NAME, `Scheduled run (trigger: ${orchestratorTrigger})`);
  } else {
    systemLog.logUser(MODULE_NAME, "User manually started portfolio analysis");
  }

  const startTime = Date.now();
  const nowIso = new Date().toISOString();
  let lastDebug: AiDebugInfo | undefined;

  // ── Check Portfolio Manager data is available ─────────────────────────────

  const portfolioEntry = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  if (!portfolioEntry) {
    res.status(400).json({
      error: "No portfolio data available. Please run Portfolio Manager first.",
    });
    return;
  }

  const portfolioResult = portfolioEntry.result as Record<string, unknown>;

  if (portfolioResult.isMockData) {
    systemLog.logWarning(MODULE_NAME, "Portfolio analysis is based on mock portfolio data");
  }

  // ── Compute deterministic Portfolio Facts ─────────────────────────────────
  // Risk engine provides shared foundation (weights, sectors, currencies, price
  // behaviour, event risk, company risk). Portfolio engine adds performance
  // (returns/contributors/detractors) and strengthened-thesis detection.

  const { riskFacts } = computeRiskFacts(nowIso);
  const { portfolioFacts, fingerprint } = computePortfolioFacts(nowIso, riskFacts);

  // ── Skip check — fingerprint unchanged means no material change ───────────

  const storedEntry = analysisRepository.get<Record<string, unknown>>("portfolio-analyzer");
  const previousFingerprint = storedEntry
    ? String((storedEntry.result as Record<string, unknown>)._portfolioFactsFingerprint ?? "")
    : "";

  if (previousFingerprint && previousFingerprint === fingerprint && storedEntry) {
    req.log.info({ fingerprint }, "Portfolio Analyzer skip: PortfolioFacts fingerprint unchanged");
    systemLog.logInfo(MODULE_NAME, "Portfolio analysis skipped — no material portfolio change detected");
    analysisRepository.saveSkipped("portfolio-analyzer");
    trackSkipped("portfolio-analyzer", "fingerprint_unchanged");
    res.json({
      ...storedEntry.result,
      _aiCalled: false,
      _debug: {
        aiCalled: false,
        skipReason: "fingerprint_unchanged",
        fingerprint,
        previousFingerprint,
        portfolioFacts,
      },
    });
    return;
  }

  // ── Collect held tickers ──────────────────────────────────────────────────

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

  // ── Build Company Monitor contexts for held positions ─────────────────────

  const allRepoEntries = analysisRepository.getAll();
  const companyMonitorCandidates = allRepoEntries
    .filter((e) => e.moduleName.startsWith("company-monitor:"))
    .map((e) => ({
      key: e.moduleName,
      result: e.result as Record<string, unknown>,
    }));

  const companyContexts: Record<string, string> = {};
  const missingCompanyTickers: string[] = [];
  const matchLog: Array<{ symbol: string; key: string; method: string }> = [];

  for (const ticker of tickers) {
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

  req.log.debug({ matchLog }, "Company Monitor identity resolution");

  for (const ticker of missingCompanyTickers) {
    systemLog.logWarning(
      MODULE_NAME,
      `Portfolio analysis performed without Company Monitor data for ${ticker}`
    );
  }

  // ── Build compact contexts ─────────────────────────────────────────────────

  const marketCtx = getMarketAiContext();
  const marketContext = marketCtx ? JSON.stringify(marketCtx) : null;

  // News filtered to held tickers + High-importance items.
  const newsCtx = getNewsAiContext(tickers);
  const newsContext = newsCtx ? JSON.stringify(newsCtx) : null;

  // Sector context filtered to sectors represented in the portfolio.
  const portfolioSectors = riskFacts.sectors.exposures
    .map((s) => s.name)
    .filter(Boolean);
  const sectorCtx = getSectorAiContext(portfolioSectors.length ? portfolioSectors : undefined);
  const sectorContext = sectorCtx ? JSON.stringify(sectorCtx) : null;

  // Compact previous PA state (for AI continuity — not the full stored result).
  const previousPaState = buildCompactPreviousPaState(storedEntry);

  // Slim portfolioFacts (strips internal fingerprinting detail).
  const slimPortfolioFacts = buildSlimPortfolioFacts(portfolioFacts);

  req.log.info(
    {
      tickers,
      missingCompanyTickers,
      hasMarket: !!marketContext,
      hasNews: !!newsContext,
      hasSector: !!sectorContext,
      fingerprint,
      previousFingerprint,
    },
    "Portfolio Facts ready — calling AI"
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
          slimPortfolioFacts,
          marketContext,
          newsContext,
          sectorContext,
          companyContexts,
          buildPriceContextBlockCompact(tickers),
          previousPaState
        ),
        {
          model: getModel("analysis", "portfolio-analyzer"),
          maxTokens: 2500,
          temperature: 0.1,
          module: "portfolio-analyzer",
          operation: "analyze",
          retryNumber: attempt,
        }
      ));
    } catch (err) {
      const isLastAttempt = attempt >= MAX_ATTEMPTS;
      req.log[isLastAttempt ? "error" : "warn"](
        { err, attempt },
        isLastAttempt
          ? "AI service call failed after all attempts"
          : "AI service call failed — retrying"
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
    const assembled = { ...(result as Record<string, unknown>), timestamp: nowIso, analysisDuration };
    const { normalized: normAssembled, changes: normChanges } = normalizeAiResponse(assembled, RunPortfolioAnalysisResponse);
    if (normChanges.length > 0) req.log.info({ changes: normChanges, attempt }, "Portfolio Analyzer: normalizer repaired formatting — no retry needed");
    const parsed = RunPortfolioAnalysisResponse.safeParse(normAssembled);

    if (parsed.success) {
      // Attach fingerprint to stored result (not exposed to clients in the
      // main payload — only in _debug).
      const resultWithFingerprint = {
        ...parsed.data,
        _portfolioFactsFingerprint: fingerprint,
      };

      analysisRepository.save("portfolio-analyzer", resultWithFingerprint);

      // ── System log entries ───────────────────────────────────────────────

      systemLog.logInfo(MODULE_NAME, "Portfolio analysis completed");
      systemLog.logInfo(MODULE_NAME, `Main conclusion: ${parsed.data.mainConclusion.title}`);
      systemLog.logInfo(MODULE_NAME, `Overall rating: ${parsed.data.overallRating}`);
      systemLog.logInfo(MODULE_NAME, `Overall outlook: ${parsed.data.overallOutlook}`);

      const highRisk = parsed.data.topRisks.find((r) => r.severity === "High");
      const topRisk = highRisk ?? parsed.data.topRisks[0];
      if (topRisk) {
        systemLog.logInternal(
          MODULE_NAME,
          `Main concern identified: ${topRisk.title} — ${topRisk.reason}`
        );
      }

      const highOpp = parsed.data.topOpportunities.find((o) => o.confidence === "High");
      const topOpp = highOpp ?? parsed.data.topOpportunities[0];
      if (topOpp) {
        systemLog.logInternal(
          MODULE_NAME,
          `Main opportunity identified: ${topOpp.title} — ${topOpp.reason}`
        );
      }

      const highAction = parsed.data.recommendedActions.find((a) => a.priority === "High");
      const topAction = highAction ?? parsed.data.recommendedActions[0];
      if (topAction) {
        systemLog.logInternal(
          MODULE_NAME,
          `Recommended highest-priority action: ${topAction.action}`
        );
      }

      res.json({
        ...parsed.data,
        _aiCalled: true,
        _debug: {
          aiCalled: true,
          fingerprint,
          previousFingerprint,
          portfolioFacts,
          ...debug,
        },
      });
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
