/**
 * News Monitor Route
 *
 * Searches for the most important market-moving financial news. Prefers the
 * last 48 hours; older stories are included only when still dominant.
 *
 * Reads market-monitor and event-monitor context from the Analysis Repository
 * to better prioritise and explain the news. Never communicates directly with
 * other modules.
 *
 * Server-side processing after the AI call:
 *  - Sorts news by importance (High → Medium → Low), then publishedAt (newest first)
 *  - Caps at 8 items
 *  - Sets timestamp and analysisDuration — never trusted from the AI response
 *
 * Invalid results are never stored in the repository.
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunNewsAnalysisResponse } from "@workspace/api-zod";
import { callAiWithWebSearch, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 2;
const IMPORTANCE_ORDER = { High: 0, Medium: 1, Low: 2 } as const;
type ImportanceKey = keyof typeof IMPORTANCE_ORDER;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a financial news analyst. Search the web for the most important market-moving financial news. Return JSON only — no markdown, no surrounding text.

GOAL: Produce an AI-curated summary of only the most important stories affecting financial markets. This is NOT a news feed — ignore routine, repetitive and low-impact news.

TIME WINDOW: Prefer news from the last 48 hours. Only include older stories when the event is still the dominant market-moving story (e.g. an ongoing geopolitical crisis or a central bank decision whose effects are still unfolding).

DEDUPLICATION: If multiple news articles describe the same underlying event, combine them into a single news item instead of listing them separately. Use the most authoritative or detailed source.

RELEVANT SECTORS: Equities, Bonds, Interest Rates, Inflation, Commodities, Energy, FX, Technology, AI, Healthcare, Industrials, Global Macro.

QUALIFYING NEWS:
- Unexpected central bank statements, policy shifts, or rate signals
- Major inflation / employment / GDP data surprises or releases
- Significant geopolitical developments with clear market impact
- Major regulatory or policy decisions affecting markets
- Commodity price shocks with macro implications
- Technology or AI developments with broad market relevance
- Sector-level corporate developments (not individual stock moves)

IGNORE:
- Routine analyst upgrades/downgrades
- Repetitive re-coverage of already well-established stories
- Minor corporate updates with no sector-level impact
- Speculative or unverified reports

You will receive a Market Monitor and/or Event Monitor analysis as context. Use them to better prioritise and explain the news — do NOT repeat or summarise what those modules already cover.

OUTPUT RULES:
- executiveSummary: ≤60 words, objective tone, covering the 2-3 most important developments
- overallMarketImpact: one concise sentence — the net direction or tone across markets
- topStory: the single most market-significant story {title (≤12 words), summary (≤30 words), importance "High|Medium|Low"}
- news: up to 8 items, ordered by importance (High→Medium→Low) then recency (most recent first)
- Each news item:
  - id: stable kebab-case identifier derived from the story topic and date, e.g. "fed-rate-cut-2026-07-31"
  - title: concise headline ≤12 words
  - summary: ≤30 words, factual, no inflated language
  - category: exactly one of Equities|Bonds|Rates|Inflation|Commodities|Energy|FX|Technology|AI|Healthcare|Industrials|Macro
  - importance: High|Medium|Low
  - affectedMarkets: 1-3 markets or sectors most affected
  - whyItMatters: one sentence explaining specific market significance
  - marketImpact: a short sentence naming the directional effect on specific assets, e.g. "Positive for AI stocks", "Negative for government bonds", "Positive for oil", "Mixed market impact"
  - confidence: 0.0–1.0 — your confidence in the market impact assessment
  - source: publication name only (e.g. "Reuters", "Bloomberg", "FT", "WSJ", "CNBC")
  - publishedAt: ISO 8601 — as precise as found (YYYY-MM-DDThh:mm:ssZ or YYYY-MM-DD)

No URLs anywhere in the output.

Return exactly:
{"executiveSummary":"...","overallMarketImpact":"...","topStory":{"title":"...","summary":"...","importance":"High"},"news":[{"id":"topic-slug-YYYY-MM-DD","title":"...","summary":"...","category":"...","importance":"High|Medium|Low","affectedMarkets":["..."],"whyItMatters":"...","marketImpact":"Positive for AI stocks","confidence":0.85,"source":"...","publishedAt":"..."}]}`;

function buildUserPrompt(nowIso: string, marketContext: string | null, eventContext: string | null): string {
  const blocks: string[] = [`UTC: ${nowIso}`, ""];
  blocks.push("Search for the most important market-moving financial news. Prefer the last 48 hours; include older stories only if still dominant.");

  if (marketContext) {
    blocks.push(
      "",
      "Current Market Monitor context (use for prioritisation and framing — do not repeat this):",
      marketContext
    );
  }
  if (eventContext) {
    blocks.push(
      "",
      "Current Event Monitor context (use for prioritisation — do not repeat this):",
      eventContext
    );
  }

  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/news-monitor/analyze", async (req, res): Promise<void> => {
  req.log.info("Running news monitor analysis with web search");
  systemLog.logUser("News Monitor", "User manually started news analysis");

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
    req.log.info("Using Market Monitor context for news prioritisation");
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
    req.log.info("Using Event Monitor context for news prioritisation");
  }

  // ── AI call with retry ─────────────────────────────────────────────────────

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: unknown;
    let debug: AiDebugInfo;

    try {
      ({ result, debug } = await callAiWithWebSearch<unknown>(
        SYSTEM_PROMPT,
        buildUserPrompt(nowIso, marketContext, eventContext),
        { model: "gpt-4o", maxTokens: 2500, temperature: 0.1 }
      ));
    } catch (err) {
      req.log.error({ err }, "AI service call failed");
      systemLog.logError("News Monitor", `News analysis failed: ${err instanceof Error ? err.message : "AI service call failed"}`);
      res.status(500).json({
        error: err instanceof Error ? err.message : "AI service call failed",
      });
      return;
    }

    lastDebug = debug;

    // ── Server-side news processing ──────────────────────────────────────────

    const resultObj = result as Record<string, unknown>;

    const rawNews = Array.isArray(resultObj.news)
      ? (resultObj.news as Array<Record<string, unknown>>)
      : [];

    const sortedNews = [...rawNews]
      .sort((a, b) => {
        const ai = IMPORTANCE_ORDER[(a.importance as ImportanceKey) ?? "Low"] ?? 3;
        const bi = IMPORTANCE_ORDER[(b.importance as ImportanceKey) ?? "Low"] ?? 3;
        if (ai !== bi) return ai - bi;
        // Most recent first — ISO string comparison is correct for dates
        return String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? ""));
      })
      .slice(0, 8);

    // ── Validate against Zod schema — timestamp and duration set by server ───

    const analysisDuration = Date.now() - startTime;
    const parsed = RunNewsAnalysisResponse.safeParse({
      ...resultObj,
      news: sortedNews,
      timestamp: nowIso,
      analysisDuration,
    });

    if (parsed.success) {
      analysisRepository.save("news-monitor", parsed.data);
      systemLog.logInfo("News Monitor", `News analysis completed: ${parsed.data.news.length} market-moving stor${parsed.data.news.length !== 1 ? "ies" : "y"} found`);
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
