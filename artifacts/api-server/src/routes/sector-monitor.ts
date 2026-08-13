/**
 * Sector Monitor Route
 *
 * Uses the OpenAI Responses API with live web search to analyse where
 * institutional money appears to be flowing across major equity sectors
 * over the next 1-3 months.
 *
 * Reads market-monitor, event-monitor and news-monitor context from the
 * Analysis Repository to improve reasoning. Never communicates directly
 * with other modules.
 *
 * Server-side processing after the AI call:
 *  - Validates against Zod schema
 *  - Sets timestamp and analysisDuration — never trusted from AI response
 *
 * Invalid results are never stored in the repository.
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunSectorAnalysisResponse } from "@workspace/api-zod";
import { callAiWithWebSearch, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";
import { getModel } from "../lib/ai-model-config.js";
import { normalizeAiResponse, classifyRetryReason } from "../lib/ai-response-normalizer.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior institutional equity strategist. Your task is to determine where capital appears to be flowing across major market sectors over the next 1-3 months. Use live web search to gather current data. Return JSON only — no markdown, no surrounding text.

GOAL: Identify sector rotation opportunities by analysing the current macro environment, market sentiment, recent news, upcoming events, earnings trends, interest rates, inflation, commodities, currencies and geopolitical developments. This is NOT a news summary — synthesise signals into actionable sector views.

QUESTION TO ANSWER: "Which sectors currently offer the most attractive opportunities over the next 1-3 months, and why?"

ALWAYS ANALYSE AT LEAST THESE SECTORS:
AI & Software, Semiconductors, Healthcare, Biotechnology, Financials, Industrials, Energy, Utilities, Consumer Discretionary, Consumer Staples, Communication Services, Materials, Real Estate

You may add additional sectors if market conditions warrant it.

You will receive Market Monitor, Event Monitor and News Monitor analyses as context. Use them to sharpen your reasoning — do NOT repeat or summarise them.

OUTPUT RULES:
- executiveSummary: ≤80 words — the key macro thesis driving sector allocation right now
- overallOutlook: one concise sentence on the broad market tone and what it means for sector rotation
- topSector: the single sector with the strongest near-term risk/reward { name, reason (≤30 words) }
- sectors: all analysed sectors, ordered from strongest to weakest rating
- Each sector:
  - name: sector name
  - rating: exactly one of "Strong" | "Moderately Strong" | "Neutral" | "Moderately Weak" | "Weak"
  - trend: exactly one of "Improving" | "Stable" | "Weakening"
  - summary: ≤35 words — current state and near-term thesis
  - drivers: 2-4 specific factors supporting the thesis (short phrases)
  - risks: 1-3 specific risks that could invalidate the view (short phrases)
  - outlook: one sentence on the 1-3 month outlook
  - confidence: exactly one of "High" | "Medium" | "Low"

Return exactly:
{"executiveSummary":"...","overallOutlook":"...","topSector":{"name":"...","reason":"..."},"sectors":[{"name":"...","rating":"Strong|Moderately Strong|Neutral|Moderately Weak|Weak","trend":"Improving|Stable|Weakening","summary":"...","drivers":["...","..."],"risks":["..."],"outlook":"...","confidence":"High|Medium|Low"}]}`;

function buildUserPrompt(
  nowIso: string,
  marketContext: string | null,
  eventContext: string | null,
  newsContext: string | null
): string {
  const blocks: string[] = [`UTC: ${nowIso}`, ""];
  blocks.push(
    "Analyse major equity sectors and determine where institutional capital is most likely to flow over the next 1-3 months."
  );

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

  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/sector-monitor/analyze", async (req, res): Promise<void> => {
  req.log.info("Running sector monitor analysis with web search");
  const orchestratorTrigger = req.headers['x-orchestrator-trigger'];
  if (orchestratorTrigger) {
    systemLog.logInfo("Sector Monitor", `Scheduled run (trigger: ${orchestratorTrigger})`);
  } else {
    systemLog.logUser("Sector Monitor", "User manually started sector analysis");
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

  if (marketContext) {
    req.log.info("Using Market Monitor context for sector analysis");
  } else {
    req.log.info("No Market Monitor context available — proceeding without it");
  }

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

  if (eventContext) {
    req.log.info("Using Event Monitor context for sector analysis");
  }

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

  if (newsContext) {
    req.log.info("Using News Monitor context for sector analysis");
  }

  // ── AI call with retry ─────────────────────────────────────────────────────

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: unknown;
    let debug: AiDebugInfo;

    try {
      ({ result, debug } = await callAiWithWebSearch<unknown>(
        SYSTEM_PROMPT,
        buildUserPrompt(nowIso, marketContext, eventContext, newsContext),
        { model: getModel("monitor", "sector-monitor"), maxTokens: 2500, temperature: 0.1, module: "sector-monitor", operation: "analyze", retryNumber: attempt, webSearchContextSize: "medium" }
      ));
    } catch (err) {
      const isLastAttempt = attempt >= MAX_ATTEMPTS;
      req.log[isLastAttempt ? "error" : "warn"](
        { err, attempt },
        isLastAttempt ? "AI service call failed after all attempts" : "AI service call failed — retrying"
      );
      if (isLastAttempt) {
        systemLog.logError("Sector Monitor", `Sector analysis failed: ${err instanceof Error ? err.message : "AI service call failed"}`);
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
    const assembled = { ...(result as Record<string, unknown>), timestamp: nowIso, analysisDuration };
    const { normalized: normAssembled, changes: normChanges } = normalizeAiResponse(assembled, RunSectorAnalysisResponse);
    if (normChanges.length > 0) req.log.info({ changes: normChanges, attempt }, "Sector Monitor: normalizer repaired formatting — no retry needed");
    const parsed = RunSectorAnalysisResponse.safeParse(normAssembled);

    if (parsed.success) {
      // ── Deterministic materiality check — no AI involved ────────────────
      // Compare the sorted sector name+rating+trend fingerprint. If the
      // institutional view is unchanged, downstream AI modules should not re-run.
      const prevEntry = analysisRepository.get<Record<string, unknown>>("sector-monitor");
      const prevKey = (Array.isArray(prevEntry?.result?.sectors)
        ? (prevEntry!.result!.sectors as Array<Record<string, unknown>>)
        : []
      ).map(s => `${String(s["name"] ?? "")}:${String(s["rating"] ?? "")}:${String(s["trend"] ?? "")}`).sort().join(";");
      const newKey = parsed.data.sectors.map(s => `${s.name}:${s.rating}:${s.trend}`).sort().join(";");
      const isMaterial = prevKey !== newKey;

      const weakest = parsed.data.sectors[parsed.data.sectors.length - 1];
      if (isMaterial) {
        analysisRepository.save("sector-monitor", parsed.data);
        systemLog.logInfo("Sector Monitor", `Sector analysis completed (MATERIAL CHANGE): ${parsed.data.topSector.name} strongest, ${weakest?.name ?? "—"} weakest`);
      } else {
        analysisRepository.saveSkipped("sector-monitor");
        systemLog.logInfo("Sector Monitor", `Sector analysis completed (no material change): same sector ratings — materialVersion unchanged`);
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
      res.status(500).json({
        error: "AI returned an invalid response structure. Please try again.",
        _debug: lastDebug,
      });
    }
  }
});

export default router;
