/**
 * Market Monitor Route
 *
 * Analyses current global financial market conditions using the shared AI
 * service with live web search. The server sets the timestamp — the model
 * never generates it.
 */
import { Router, type IRouter } from "express";
import { RunMarketAnalysisResponse } from "@workspace/api-zod";
import { callAiWithWebSearch } from "../lib/ai-service";

const router: IRouter = Router();

/**
 * System prompt — instructs the model to return ONLY a JSON object.
 * No timestamp field is requested; the server sets it after the call.
 * No sources field is requested; sources are extracted from URL citations.
 */
const SYSTEM_PROMPT = `You are a professional financial market analyst with access to live web search. \
You must search the web for the latest market data before composing your response. \
After completing your research, respond with ONLY a valid JSON object — no markdown fences, \
no explanatory text before or after, nothing but the JSON. \
The JSON must follow this exact structure:
{
  "summary": "2-3 sentence overview of current market conditions based on today's data",
  "marketSentiment": "Positive" | "Neutral" | "Negative",
  "riskLevel": "Low" | "Moderate" | "High",
  "confidence": <integer 0-100 reflecting how current and complete your data is>,
  "positiveFactors": ["string", ...],
  "negativeFactors": ["string", ...],
  "strongSectors": ["string", ...],
  "weakSectors": ["string", ...],
  "keyRisks": ["string", ...]
}
Rules:
- 2-4 items per array field.
- Base every claim on sources you actually found via web search — do NOT use knowledge from training data.
- If you cannot find current data, set confidence below 40 and state the limitation in the summary.`;

const USER_PROMPT = `Search the web for current global financial market conditions as of today. \
Look for: major index performance (S&P 500, NASDAQ, Dow, VIX, European and Asian indices), \
sector strength/weakness, key macro risks, and analyst sentiment. \
Return only the JSON object described in the system prompt.`;

router.post("/market-monitor/analyze", async (req, res): Promise<void> => {
  req.log.info("Running market analysis with web search");

  const { result, debug, sources } = await callAiWithWebSearch<unknown>(
    SYSTEM_PROMPT,
    USER_PROMPT,
    {
      model: "gpt-4o-mini",
      maxTokens: 1200,
      temperature: 0.3,
    }
  );

  // Validate the AI response against the Zod schema (excludes timestamp and sources — added below)
  const parsed = RunMarketAnalysisResponse.safeParse({
    ...(result as object),
    // timestamp and sources are injected by the server, not the model
    timestamp: new Date().toISOString(),
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
