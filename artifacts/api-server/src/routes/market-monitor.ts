/**
 * Market Monitor Route
 *
 * Analyses current global financial market conditions using the shared AI
 * service with live web search. The server sets the timestamp and duration —
 * the model never generates them. Analysis fails explicitly if current data
 * cannot be found; stale or unverified market assessments are never returned.
 * If the model returns a structurally invalid response, the route retries once
 * before giving up.
 */
import { Router, type IRouter } from "express";
import { RunMarketAnalysisResponse } from "@workspace/api-zod";
import { callAiWithWebSearch, type AiDebugInfo } from "../lib/ai-service";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a financial market analyst. Search the web for current data and return JSON only — no markdown, no surrounding text.

SOURCES: Use only Reuters, Bloomberg, FT, WSJ, CNBC, MarketWatch, Yahoo Finance, official exchanges/central banks. Max 3 days old. No opinion pieces. No training-data fills.

NUMBERS: Only cite a specific figure if found in ≥2 independent sources; otherwise describe direction ("higher", "under pressure").

OUTPUT RULES:
- summary: ≤40 words, objective tone, no inflated language ("significant", "dramatic", "surge")
- Each array: 1–3 items, most important only. Name sectors, not individual companies, unless a single company is the primary market driver.
- No URLs or citation markers outside the sources array.
- sources: 3–6 entries you actually retrieved, each {title, url, published: "YYYY-MM-DD or \\"\\""}.

If no usable current data found: {"data_unavailable":true,"reason":"..."}
Otherwise return exactly:
{"summary":"...","marketSentiment":"Positive|Neutral|Negative","riskLevel":"Low|Moderate|High","positiveFactors":[...],"negativeFactors":[...],"strongSectors":[...],"weakSectors":[...],"keyRisks":[...],"sources":[...]}`;

const buildUserPrompt = (nowIso: string): string =>
  `UTC: ${nowIso}

Search current global market conditions: major indices (S&P 500, NASDAQ, Dow Jones, VIX, FTSE 100, DAX, Nikkei 225), sector leaders/laggards, active macro events (central bank decisions, inflation data, geopolitical risks, earnings), and sentiment indicators.`;

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 2;

router.post("/market-monitor/analyze", async (req, res): Promise<void> => {
  req.log.info("Running market analysis with web search");

  const startTime = Date.now();
  const nowIso = new Date().toISOString();
  let lastDebug: AiDebugInfo | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: unknown;
    let debug: AiDebugInfo;

    try {
      ({ result, debug } = await callAiWithWebSearch<unknown>(
        SYSTEM_PROMPT,
        buildUserPrompt(nowIso),
        { model: "gpt-4o", maxTokens: 900, temperature: 0.1 }
      ));
    } catch (err) {
      req.log.error({ err }, "AI service call failed");
      res.status(500).json({
        error: err instanceof Error ? err.message : "AI service call failed",
      });
      return;
    }

    lastDebug = debug;

    // ── Check if the model signalled that current data was unavailable ──────
    const resultObj = result as Record<string, unknown>;
    if (resultObj?.data_unavailable === true) {
      req.log.warn({ reason: resultObj.reason }, "Market data unavailable");
      res.status(503).json({
        error: `Market data unavailable: ${
          resultObj.reason ??
          "Could not retrieve verified current market data. Please try again later."
        }`,
        _debug: debug,
      });
      return;
    }

    // ── Validate against Zod schema — timestamp and duration set by server ──
    const analysisDuration = Date.now() - startTime;
    const parsed = RunMarketAnalysisResponse.safeParse({
      ...(result as object),
      timestamp: nowIso,
      analysisDuration,
    });

    if (parsed.success) {
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
