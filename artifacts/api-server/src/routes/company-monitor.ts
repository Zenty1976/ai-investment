/**
 * Company Monitor Route
 *
 * Uses the OpenAI Responses API with live web search to evaluate a single
 * company as a possible investment over the next 1-3 months.
 *
 * The caller supplies { companyName?, ticker } in the request body.
 * Context from all four other monitors is pulled from the Analysis
 * Repository — never via direct module calls.
 *
 * Server-side processing after the AI call:
 *  - Validates against Zod schema
 *  - Sets timestamp and analysisDuration — never trusted from AI response
 *  - Normalises ticker to uppercase
 *
 * Results are stored under the key company-monitor:<TICKER>.
 * Invalid results are never stored.
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunCompanyAnalysisResponse } from "@workspace/api-zod";
import { callAiWithWebSearch, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 2;


// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior equity analyst evaluating the company for an investor with a 1-3 month investment horizon.

Use current web search results and the supplied market context.

Focus on what could materially move the share price during the next 1-3 months.

Distinguish clearly between confirmed facts, market expectations and your own analytical conclusions.

Do not invent financial figures, dates, guidance or events.

If reliable information is unavailable, state this clearly.

Return structured JSON only.

OUTPUT RULES:
- Return exactly the JSON structure shown below — no markdown, no code fences, no extra text
- catalysts: maximum 5 items
- risks: maximum 5 items
- All enum fields must use exactly the allowed values
- Do not include the timestamp or analysisDuration fields — the server sets those

Return exactly:
{"company":{"name":"...","ticker":"...","sector":"...","industry":"..."},"executiveSummary":"...","investmentView":{"rating":"Strong Buy|Buy|Watch|Avoid|Strong Avoid","outlook":"Bullish|Moderately Bullish|Neutral|Moderately Bearish|Bearish","reason":"..."},"currentSituation":"...","catalysts":[{"title":"...","description":"...","timeframe":"Immediate|Within 1 month|Within 3 months","impact":"High|Medium|Low"}],"risks":[{"title":"...","description":"...","impact":"High|Medium|Low"}],"earningsAndGuidance":{"summary":"...","trend":"Improving|Stable|Weakening","nextKnownEvent":"...","nextKnownEventDate":"..."},"competitivePosition":{"assessment":"Strong|Moderate|Weak","summary":"..."},"sectorContext":"...","marketSentiment":"Positive|Mixed|Negative","valuationAssessment":{"level":"Attractive|Reasonable|Expensive|Unclear","summary":"..."},"bullCase":"...","baseCase":"...","bearCase":"...","keyThingsToWatch":["...","...","..."],"confidence":"High|Medium|Low"}`;

function buildUserPrompt(
  ticker: string,
  companyName: string | undefined,
  nowIso: string,
  marketContext: string | null,
  eventContext: string | null,
  newsContext: string | null,
  sectorContext: string | null
): string {
  const displayName = companyName ? `${companyName} (${ticker})` : ticker;

  const blocks: string[] = [
    `UTC: ${nowIso}`,
    "",
    `Perform a full investment analysis of ${displayName} for the next 1-3 months.`,
    "",
    "Analyse: recent company news, latest earnings and guidance, revenue and profit trends, key products and business segments, competitive position, sector conditions, analyst expectations, upcoming company-specific events, catalysts, risks, valuation concerns, market sentiment and likely short-term direction.",
    "",
    "This must be an investment analysis — not a company description or news summary.",
  ];

  if (marketContext) {
    blocks.push(
      "",
      "Current Market Monitor context (use for macro framing — do not repeat this):",
      marketContext
    );
  }
  if (eventContext) {
    blocks.push(
      "",
      "Current Event Monitor context (use for event-driven catalyst awareness — do not repeat this):",
      eventContext
    );
  }
  if (newsContext) {
    blocks.push(
      "",
      "Current News Monitor context (use for recent market-moving developments — do not repeat this):",
      newsContext
    );
  }
  if (sectorContext) {
    blocks.push(
      "",
      "Current Sector Monitor context (use for sector conditions — do not repeat this):",
      sectorContext
    );
  }

  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/company-monitor/analyze", async (req, res): Promise<void> => {
  // ── Validate request body ────────────────────────────────────────────────

  const rawTicker = typeof req.body?.ticker === "string" ? req.body.ticker.trim() : "";
  if (!rawTicker || rawTicker.length > 10) {
    res.status(400).json({ error: "ticker is required (max 10 characters)" });
    return;
  }
  const ticker = rawTicker.toUpperCase();
  const companyName: string | undefined =
    typeof req.body?.companyName === "string" && req.body.companyName.trim()
      ? req.body.companyName.trim()
      : undefined;
  req.log.info({ ticker, companyName }, "Running company monitor analysis with web search");
  const orchestratorTrigger = req.headers['x-orchestrator-trigger'];
  if (orchestratorTrigger) {
    systemLog.logInfo("Company Monitor", `Scheduled run for ${ticker} (trigger: ${orchestratorTrigger})`);
  } else {
    systemLog.logUser("Company Monitor", `User manually started company analysis for ${ticker}`);
  }

  const startTime = Date.now();
  const nowIso = new Date().toISOString();
  let lastDebug: AiDebugInfo | undefined;

  // ── Read context from Analysis Repository ──────────────────────────────────

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
          ? (eventEntry.result.events as Array<Record<string, unknown>>).map((e) => ({
              title: e.title,
              date: e.date,
              importance: e.importance,
              expectedImpact: e.expectedImpact,
            }))
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

  const sectorEntry = analysisRepository.get<Record<string, unknown>>("sector-monitor");
  const sectorContextStr = sectorEntry
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

  req.log.info(
    {
      hasMarket: !!marketContext,
      hasEvent: !!eventContext,
      hasNews: !!newsContext,
      hasSector: !!sectorContextStr,
    },
    "Context loaded from Analysis Repository"
  );

  // ── AI call with retry ─────────────────────────────────────────────────────

  const repositoryKey = `company-monitor:${ticker}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: unknown;
    let debug: AiDebugInfo;

    try {
      ({ result, debug } = await callAiWithWebSearch<unknown>(
        SYSTEM_PROMPT,
        buildUserPrompt(ticker, companyName, nowIso, marketContext, eventContext, newsContext, sectorContextStr),
        { model: "gpt-4o", maxTokens: 4000, temperature: 0.1 }
      ));
    } catch (err) {
      const isLastAttempt = attempt >= MAX_ATTEMPTS;
      req.log[isLastAttempt ? "error" : "warn"](
        { err, attempt },
        isLastAttempt ? "AI service call failed after all attempts" : "AI service call failed — retrying"
      );
      if (isLastAttempt) {
        systemLog.logError("Company Monitor", `Company analysis failed for ${ticker}: ${err instanceof Error ? err.message : "AI service call failed"}`);
        res.status(500).json({
          error: err instanceof Error ? err.message : "AI service call failed",
          _debug: extractAiErrorDebug(err),
        });
        return;
      }
      continue;
    }

    lastDebug = debug;

    // ── Validate against Zod schema — timestamp and duration set by server ───

    const analysisDuration = Date.now() - startTime;
    const parsed = RunCompanyAnalysisResponse.safeParse({
      ...(result as Record<string, unknown>),
      timestamp: nowIso,
      analysisDuration,
    });

    if (parsed.success) {
      // ── Identity verification — never save an analysis for the wrong company ──

      const returnedTicker = parsed.data.company.ticker.toUpperCase().trim();
      if (returnedTicker !== ticker) {
        req.log.warn(
          { requestedTicker: ticker, returnedTicker },
          "AI returned analysis for wrong ticker — rejecting"
        );
        if (attempt < MAX_ATTEMPTS) {
          req.log.info("Retrying after wrong-ticker response");
          continue;
        }
        res.status(500).json({
          error: `AI returned an analysis for ${returnedTicker} instead of ${ticker}. Please try again.`,
          _debug: lastDebug,
        });
        return;
      }

      // Loose company name check: at least one significant word must appear in the returned name
      if (companyName) {
        const returnedName = parsed.data.company.name.toLowerCase();
        const requestedWords = companyName
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3);
        const nameMatches =
          requestedWords.length === 0 ||
          requestedWords.some((w) => returnedName.includes(w));
        if (!nameMatches) {
          req.log.warn(
            { requestedName: companyName, returnedName },
            "AI returned analysis for a different company name — rejecting"
          );
          if (attempt < MAX_ATTEMPTS) {
            req.log.info("Retrying after wrong-company-name response");
            continue;
          }
          res.status(500).json({
            error: `AI returned an analysis for "${parsed.data.company.name}" instead of "${companyName}". Please verify the ticker and company name.`,
            _debug: lastDebug,
          });
          return;
        }
      }

      analysisRepository.save(repositoryKey, parsed.data);
      systemLog.logInfo("Company Monitor", `Company analysis completed for ${ticker}: rating ${parsed.data.investmentView.rating}`);
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
      res.status(500).json({
        error: "AI returned an invalid response structure. Please try again.",
        _debug: lastDebug,
      });
    }
  }
});

export default router;
