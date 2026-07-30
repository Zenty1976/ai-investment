/**
 * Market Monitor Route
 *
 * Analyses current global financial market conditions using the shared AI
 * service with live web search. The server sets the timestamp — the model
 * never generates it. Analysis fails explicitly if current data cannot be
 * found; stale or unverified market assessments are never returned.
 */
import { Router, type IRouter } from "express";
import { RunMarketAnalysisResponse } from "@workspace/api-zod";
import { callAiWithWebSearch } from "../lib/ai-service";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a financial market data analyst. Your sole task is to search \
the web for verified, current market data and return a structured JSON object. You must follow \
every rule below without exception.

SOURCE QUALITY RULES:
- For index levels (S&P 500, NASDAQ, Dow Jones, VIX, DAX, Nikkei, etc.) and other numerical \
market data, only use figures found on official exchange websites, index provider sites \
(S&P Global, MSCI, FTSE Russell), central bank publications, government statistical agencies, \
or major established financial news organisations (Reuters, Bloomberg, Financial Times, \
Wall Street Journal, CNBC, MarketWatch, Yahoo Finance, Investing.com).
- Every claim about current index levels or market conditions must be corroborated by at \
least two independent recent sources. If you can only find one source for a numerical figure, \
omit that figure.
- Never include a specific numerical level (e.g. "S&P 500 at 5,450") unless that exact figure \
appears in at least two of your retrieved sources.

RECENCY RULES:
- All sources used as evidence for current market conditions MUST have been published or \
last updated within the past 3 calendar days. Do not use older articles as evidence for \
today's index levels or market sentiment.
- Older background articles (e.g. about structural macro factors) may be used for context \
only, never as evidence of today's market state.

CONTENT RULES:
- Summary and all array fields must contain plain text only — no URLs, no domain names, \
no citation markers, no footnote numbers. URLs belong only in the sources list.
- Each array (positiveFactors, negativeFactors, strongSectors, weakSectors, keyRisks) must \
contain exactly 1 to 3 items. Never exceed 3.
- Do not invent, estimate, or extrapolate numerical values. Only state figures you read directly.

FAILURE RULE:
- If you cannot find at least two independent recent (≤3 days old) reputable sources \
confirming current market conditions, you MUST return this exact JSON and nothing else:
  {"data_unavailable": true, "reason": "<brief explanation of what was missing>"}
- Do not produce a market assessment from training-data knowledge under any circumstances.

OUTPUT RULE:
- Return ONLY a valid JSON object — no markdown fences, no text before or after.
- On success, the JSON must be exactly:
{
  "summary": "<2-3 sentences on today's conditions, no URLs, no numbers unless dual-sourced>",
  "marketSentiment": "Positive" | "Neutral" | "Negative",
  "riskLevel": "Low" | "Moderate" | "High",
  "positiveFactors": ["<max 3 items, plain text, no URLs>", ...],
  "negativeFactors": ["<max 3 items, plain text, no URLs>", ...],
  "strongSectors": ["<max 3 sector names>", ...],
  "weakSectors": ["<max 3 sector names>", ...],
  "keyRisks": ["<max 3 items, plain text, no URLs>", ...]
}`;

const buildUserPrompt = (nowIso: string): string =>
  `Today's date and time (UTC): ${nowIso}

Search for current global financial market conditions. Run multiple searches covering:
1. Major index performance today or most recent session: S&P 500, NASDAQ Composite, Dow Jones, \
VIX fear index, FTSE 100, DAX, Nikkei 225
2. Sector performance — which sectors are leading or lagging
3. Key macro events and risks active this week (central bank decisions, inflation data, \
geopolitical events, earnings surprises)
4. Market sentiment indicators from reputable sources

Cross-check any numerical values against at least two independent sources. \
If current data (published within the last 3 days) is unavailable for a claim, omit it. \
If overall current market data cannot be verified, return the data_unavailable JSON.

Return only the JSON object described in the system prompt.`;

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/market-monitor/analyze", async (req, res): Promise<void> => {
  req.log.info("Running market analysis with web search");

  const nowIso = new Date().toISOString();

  const { result, debug, sources } = await callAiWithWebSearch<unknown>(
    SYSTEM_PROMPT,
    buildUserPrompt(nowIso),
    {
      model: "gpt-4o",
      maxTokens: 1500,
      temperature: 0.1,
    }
  );

  // ── Check if the model signalled that current data was unavailable ────────
  const resultObj = result as Record<string, unknown>;
  if (resultObj?.data_unavailable === true) {
    req.log.warn({ reason: resultObj.reason }, "Market data unavailable");
    res.status(503).json({
      error: `Market data unavailable: ${resultObj.reason ?? "Could not retrieve verified current market data. Please try again later."}`,
      _debug: debug,
    });
    return;
  }

  // ── Validate against Zod schema — timestamp and sources injected by server ─
  const parsed = RunMarketAnalysisResponse.safeParse({
    ...(result as object),
    timestamp: nowIso,
    sources,
  });

  if (!parsed.success) {
    req.log.error({ errors: parsed.error.message }, "Invalid AI response schema");
    res.status(500).json({
      error: "AI returned an invalid response structure. Please try again.",
      _debug: debug,
    });
    return;
  }

  res.json({ ...parsed.data, _debug: debug });
});

export default router;
