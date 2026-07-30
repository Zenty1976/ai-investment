/**
 * Market Monitor Route
 *
 * Analyses overall financial market conditions using the shared AI service.
 */
import { Router, type IRouter } from "express";
import { RunMarketAnalysisResponse } from "@workspace/api-zod";
import { callAi } from "../lib/ai-service";

const router: IRouter = Router();

const SYSTEM_PROMPT = `You are a financial market analyst. Return ONLY valid JSON with no markdown, no surrounding text, and no explanations. The response must be exactly this structure:
{
  "summary": "string",
  "marketSentiment": "Positive" | "Neutral" | "Negative",
  "riskLevel": "Low" | "Moderate" | "High",
  "confidence": number (0-100),
  "positiveFactors": ["string"],
  "negativeFactors": ["string"],
  "strongSectors": ["string"],
  "weakSectors": ["string"],
  "keyRisks": ["string"],
  "timestamp": "ISO 8601 string"
}`;

const USER_PROMPT = `Analyse current global financial market conditions as of today. Be concise. Provide 2-4 items per array field. Set the timestamp to the current UTC datetime in ISO 8601 format.`;

router.post("/market-monitor/analyze", async (req, res): Promise<void> => {
  req.log.info("Running market analysis");

  const { result, debug } = await callAi<unknown>(SYSTEM_PROMPT, USER_PROMPT, {
    model: "gpt-4o-mini",
    maxTokens: 600,
    temperature: 0.3,
  });

  const parsed = RunMarketAnalysisResponse.safeParse(result);
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
