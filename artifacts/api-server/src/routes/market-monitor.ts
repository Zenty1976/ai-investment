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

const SYSTEM_PROMPT = `You are a financial market data analyst. Search the web for current \
market data, then return a structured JSON object. Follow every rule below.

SOURCE QUALITY:
- Use only reputable financial sources: Reuters, Bloomberg, Financial Times, Wall Street Journal, \
CNBC, MarketWatch, Yahoo Finance, Investing.com, official exchange or central bank sites.
- Do NOT use sources older than 3 calendar days as evidence of current market conditions. \
Older material may only be cited for structural background context.
- Do NOT use training-data knowledge to fill gaps. Only report what you actually retrieved.

NUMERICAL CLAIMS:
- Only state a specific index level or percentage move if you found that exact figure in at \
least two independent retrieved sources. If you only found it in one source, describe the \
direction ("higher", "under pressure") without the number.
- Never invent, estimate, or extrapolate figures.

CONTENT FORMAT:
- Summary and all array fields: plain text only. No URLs, no domain names, no citation \
markers, no footnote numbers anywhere except the sources list.
- Each array (positiveFactors, negativeFactors, strongSectors, weakSectors, keyRisks): \
1 to 3 items maximum.

FAILURE CONDITION — only trigger this when you find NO usable current market data at all:
  {"data_unavailable": true, "reason": "<what you searched for and why it failed>"}
Do NOT trigger this just because some individual figures lack dual sourcing. \
If you found current reputable coverage of market conditions, produce the analysis.

SUCCESS OUTPUT — return ONLY this JSON object, no markdown, no surrounding text:
{
  "summary": "<2-3 sentences on today's market conditions based on retrieved sources>",
  "marketSentiment": "Positive" | "Neutral" | "Negative",
  "riskLevel": "Low" | "Moderate" | "High",
  "positiveFactors": ["<max 3 items>", ...],
  "negativeFactors": ["<max 3 items>", ...],
  "strongSectors": ["<max 3 sector names>", ...],
  "weakSectors": ["<max 3 sector names>", ...],
  "keyRisks": ["<max 3 items>", ...]
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
