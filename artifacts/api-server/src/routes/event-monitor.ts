/**
 * Event Monitor Route
 *
 * Searches for upcoming financial-market events in the next 14 days using the
 * shared AI service with live web search. Optionally reads the latest Market
 * Monitor result from the Analysis Repository to prioritize events that are
 * relevant to current market conditions.
 *
 * Server-side processing after the AI call:
 *  - Filters events with dates in the past
 *  - Deduplicates by title (case-insensitive)
 *  - Sorts by importance (High → Medium → Low), then by date ascending
 *  - Caps at 5 events
 *  - Derives nextMajorEvent from the top-ranked event
 *  - Calculates countdownDays — never trusted from the AI response
 *  - Sets timestamp and analysisDuration
 *
 * Invalid, incomplete or failed results are never stored in the repository.
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunEventAnalysisResponse } from "@workspace/api-zod";
import { callAiWithWebSearch, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 2;
const IMPORTANCE_ORDER = { High: 0, Medium: 1, Low: 2 } as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function calcCountdownDays(dateStr: string, todayMs: number): number {
  const d = new Date(dateStr);
  d.setUTCHours(0, 0, 0, 0);
  return Math.max(0, Math.round((d.getTime() - todayMs) / 86_400_000));
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a financial events analyst. Search the web for scheduled events that will affect financial markets. Return JSON only — no markdown, no surrounding text.

FOCUS: Central bank meetings / rate decisions, CPI/PPI releases, employment reports, GDP releases, major company earnings, trade-policy and tariff announcements, regulatory decisions, geopolitical events with a confirmed or expected date.

SOURCES: Prefer official sources (central bank calendars, government statistics offices, stock exchange calendars, company IR pages). Reuters, Bloomberg, FT, WSJ may supplement.

OUTPUT RULES:
- Only include events scheduled within the 14-day window provided.
- Return at most 5 events. Prioritise by importance, then by date.
- No duplicate events.
- summary: ≤4 short sentences, objective tone, no inflated language.
- Each event: a short title, the exact date (YYYY-MM-DD), a category, importance (High/Medium/Low), affectedMarkets (1–3 markets or sectors), expectedImpact (one sentence), reason (one to two sentences explaining why the event matters to markets).
- sources: 2–5 entries you actually retrieved, each {title, url, published: "YYYY-MM-DD or \\"\\""}.
- Do NOT include a countdownDays field anywhere — the server calculates it.
- No URLs or citation markers outside the sources array.

{"data_unavailable":true,"reason":"..."} — ONLY if the web search returns absolutely no financial event data. Never use it because a source was hard to verify.
Otherwise return exactly:
{"summary":"...","events":[{"title":"...","date":"YYYY-MM-DD","category":"...","importance":"High|Medium|Low","affectedMarkets":["..."],"expectedImpact":"...","reason":"..."}],"sources":[{"title":"...","url":"...","published":"..."}]}`;

function buildUserPrompt(
  nowIso: string,
  todayStr: string,
  endDateStr: string,
  marketContext: string | null
): string {
  const contextBlock = marketContext
    ? `\nCurrent Market Monitor context (use to prioritise events relevant to current conditions — do not repeat this analysis):\n${marketContext}`
    : "";

  return `UTC: ${nowIso}
Today: ${todayStr}
14-day event window: ${todayStr} → ${endDateStr}

Search for all significant scheduled financial events within the above 14-day window.${contextBlock}`;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/event-monitor/analyze", async (req, res): Promise<void> => {
  req.log.info("Running event monitor analysis with web search");
  const orchestratorTrigger = req.headers['x-orchestrator-trigger'];
  if (orchestratorTrigger) {
    systemLog.logInfo("Event Monitor", `Scheduled run (trigger: ${orchestratorTrigger})`);
  } else {
    systemLog.logUser("Event Monitor", "User manually started event analysis");
  }

  const startTime = Date.now();
  const nowIso = new Date().toISOString();

  // Anchor today to UTC midnight for consistent countdown calculations
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const todayStr = today.toISOString().slice(0, 10);
  const endDateStr = new Date(todayMs + 14 * 86_400_000).toISOString().slice(0, 10);

  // Optional: read the latest Market Monitor result for context
  const marketEntry = analysisRepository.get<Record<string, unknown>>("market-monitor");
  const marketContext = marketEntry
    ? JSON.stringify(
        {
          sentiment: (marketEntry.result as { marketSentiment?: string }).marketSentiment,
          riskLevel: (marketEntry.result as { riskLevel?: string }).riskLevel,
          keyRisks: (marketEntry.result as { keyRisks?: string[] }).keyRisks,
          summary: (marketEntry.result as { summary?: string }).summary,
        },
        null,
        0
      )
    : null;

  if (marketContext) {
    req.log.info("Using Market Monitor context for event prioritisation");
  } else {
    req.log.info("No Market Monitor context available — proceeding without it");
  }

  let lastDebug: AiDebugInfo | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: unknown;
    let debug: AiDebugInfo;

    try {
      ({ result, debug } = await callAiWithWebSearch<unknown>(
        SYSTEM_PROMPT,
        buildUserPrompt(nowIso, todayStr, endDateStr, marketContext),
        { model: "gpt-4o", maxTokens: 1500, temperature: 0.1 }
      ));
    } catch (err) {
      const isLastAttempt = attempt >= MAX_ATTEMPTS;
      req.log[isLastAttempt ? "error" : "warn"](
        { err, attempt },
        isLastAttempt ? "AI service call failed after all attempts" : "AI service call failed — retrying"
      );
      if (isLastAttempt) {
        systemLog.logError("Event Monitor", `Event analysis failed: ${err instanceof Error ? err.message : "AI service call failed"}`);
        res.status(500).json({
          error: err instanceof Error ? err.message : "AI service call failed",
          _debug: extractAiErrorDebug(err),
        });
        return;
      }
      continue;
    }

    lastDebug = debug;

    // ── data_unavailable guard ───────────────────────────────────────────────
    const resultObj = result as Record<string, unknown>;
    if (resultObj?.data_unavailable === true) {
      req.log.warn({ reason: resultObj.reason }, "Event data unavailable");
      systemLog.logWarning("Event Monitor", `Event data unavailable: ${String(resultObj.reason ?? "no data")}`);
      res.status(503).json({
        error: `Event data unavailable: ${
          resultObj.reason ?? "Could not retrieve upcoming event data. Please try again later."
        }`,
        _debug: debug,
      });
      return;
    }

    // ── Server-side event processing ─────────────────────────────────────────

    type RawEvent = {
      title?: string;
      date?: string;
      category?: string;
      importance?: string;
      affectedMarkets?: string[];
      expectedImpact?: string;
      reason?: string;
    };

    const rawEvents: RawEvent[] = Array.isArray(resultObj.events)
      ? (resultObj.events as RawEvent[])
      : [];

    // 1. Filter events to the exact 14-day window [today, endDateStr] (UTC)
    const windowEndMs = new Date(endDateStr).setUTCHours(23, 59, 59, 999);
    const futureEvents = rawEvents.filter((e) => {
      if (!e.date) return false;
      const d = new Date(e.date);
      if (isNaN(d.getTime())) return false;
      d.setUTCHours(0, 0, 0, 0);
      const ms = d.getTime();
      return ms >= todayMs && ms <= windowEndMs;
    });

    // 2. Deduplicate by title (case-insensitive)
    const seen = new Set<string>();
    const deduped = futureEvents.filter((e) => {
      const key = String(e.title ?? "")
        .toLowerCase()
        .trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 3. Sort: importance High → Medium → Low, then date ascending
    const sorted = [...deduped].sort((a, b) => {
      const ia =
        IMPORTANCE_ORDER[a.importance as keyof typeof IMPORTANCE_ORDER] ?? 3;
      const ib =
        IMPORTANCE_ORDER[b.importance as keyof typeof IMPORTANCE_ORDER] ?? 3;
      if (ia !== ib) return ia - ib;
      return (
        new Date(a.date ?? "").getTime() - new Date(b.date ?? "").getTime()
      );
    });

    // 4. Cap at 5
    const events = sorted.slice(0, 5);

    if (events.length === 0) {
      if (attempt < MAX_ATTEMPTS) {
        req.log.warn(
          { attempt },
          "No valid upcoming events found — retrying once"
        );
        continue;
      }
      req.log.error("No upcoming events found after retry");
      systemLog.logError("Event Monitor", "Event analysis failed: no upcoming events found");
      res.status(503).json({
        error:
          "No upcoming financial events were found for the next 14 days. Please try again later.",
        _debug: lastDebug,
      });
      return;
    }

    // 5. Derive nextMajorEvent from the top-ranked event (server-authoritative)
    const topEvent = events[0];
    const nextMajorEvent = {
      title: topEvent.title,
      date: topEvent.date,
      countdownDays: calcCountdownDays(topEvent.date ?? "", todayMs),
    };

    // ── Validate against Zod schema — timestamp and duration set by server ───
    const analysisDuration = Date.now() - startTime;
    const parsed = RunEventAnalysisResponse.safeParse({
      summary: resultObj.summary,
      nextMajorEvent,
      events,
      sources: Array.isArray(resultObj.sources) ? resultObj.sources : [],
      timestamp: nowIso,
      analysisDuration,
    });

    if (parsed.success) {
      analysisRepository.save("event-monitor", parsed.data);
      const highCount = parsed.data.events.filter((e) => e.importance === "High").length;
      systemLog.logInfo("Event Monitor", `Event analysis completed: ${parsed.data.events.length} upcoming event${parsed.data.events.length !== 1 ? "s" : ""}, ${highCount} high importance`);
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
