/**
 * Event Monitor Route — Hybrid Architecture
 *
 * Two operating modes chosen deterministically before any AI call:
 *
 * ── MAINTENANCE (zero AI, zero web search, zero tokens) ─────────────────────
 *   Runs when discovery is not due and known events exist.
 *   Updates proximity buckets and status from the stored EventIntelligenceState.
 *   Material changes (proximity boundary crossings, passed events) still
 *   propagate to downstream modules via the event-monitor materialVersion.
 *   Debug shows:  mode: MAINTENANCE  aiCalled: false  webSearchUsed: false
 *
 * ── DISCOVERY (AI + web search) ──────────────────────────────────────────────
 *   Runs when discovery interval elapsed, force_refresh requested, or no
 *   known events exist yet.
 *   AI output is merged (not replaced) into the EventIntelligenceState:
 *   - Known events get updated content if changed; stable ID is preserved.
 *   - Genuinely new events are added.
 *   - Redundant re-discoveries are deduplicated silently.
 *   Debug shows:  mode: DISCOVERY  reason: <why>  aiCalled: true
 *
 * Downstream fingerprint stability:
 *   The event-monitor materialVersion only bumps on meaningful state transitions:
 *   event added/removed, content changed, or proximity bucket boundary crossed
 *   (FUTURE→WITHIN_7_DAYS, →WITHIN_3_DAYS, →WITHIN_24_HOURS, →TODAY, →PASSED).
 *   Plain countdown ticks ("74h remaining" → "73h remaining") are NOT material,
 *   preventing unnecessary Portfolio Analyzer / Risk Analyzer / TDE reruns.
 */

import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunEventAnalysisResponse } from "@workspace/api-zod";
import {
  callAiWithWebSearch,
  extractAiErrorDebug,
  type AiDebugInfo,
} from "../lib/ai-service.js";
import { analysisRepository } from "../lib/analysis-repository.js";
import { getModel } from "../lib/ai-model-config.js";
import {
  normalizeAiResponse,
  classifyRetryReason,
} from "../lib/ai-response-normalizer.js";
import {
  type EventIntelligenceState,
  type AiEventCandidate,
  type EventImportance,
  computeProximity,
  runMaintenance,
  mergeDiscovery,
  toEventMonitorOutput,
  computeMaterialityKey,
  buildEventIndex,
} from "../lib/event-intelligence.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 2;

/**
 * Minimum time between AI discovery runs.
 * Must run at least once per this interval — matches the default orchestrator
 * schedule so existing timing expectations are preserved.
 */
const DEFAULT_DISCOVERY_INTERVAL_MS = 180 * 60_000; // 3 hours

// ---------------------------------------------------------------------------
// AI Prompt
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
  marketContext: string | null,
  knownEventIndex: string
): string {
  const ctxBlock = marketContext
    ? `\nCurrent Market Monitor context (use to prioritise events relevant to current conditions — do not repeat this analysis):\n${marketContext}`
    : "";

  const knownBlock =
    knownEventIndex !== "[]"
      ? `\nKnown events already tracked (included for deduplication context — you may update their details if you find new information, and include any genuinely new events not in this list):\n${knownEventIndex}`
      : "";

  return `UTC: ${nowIso}
Today: ${todayStr}
14-day event window: ${todayStr} → ${endDateStr}

Search for all significant scheduled financial events within the above 14-day window.${ctxBlock}${knownBlock}`;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/event-monitor/analyze", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown> | undefined;
  const forceRefresh = body?.force_refresh === true;
  const orchestratorTrigger = req.headers["x-orchestrator-trigger"] as
    | string
    | undefined;
  const isForceAI =
    orchestratorTrigger === "ForceRefresh" || forceRefresh;

  if (orchestratorTrigger) {
    systemLog.logInfo(
      "Event Monitor",
      `Scheduled run (trigger: ${orchestratorTrigger})`
    );
  } else {
    systemLog.logUser("Event Monitor", "User manually started event analysis");
  }

  const startTime = Date.now();
  const nowIso = new Date().toISOString();

  // Anchor today to UTC midnight for consistent proximity calculations
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const todayStr = today.toISOString().slice(0, 10);
  const endDateStr = new Date(todayMs + 14 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // ── Load event intelligence state ─────────────────────────────────────────
  const intelligenceEntry =
    analysisRepository.get<EventIntelligenceState>("event-intelligence");
  const currentState: EventIntelligenceState = intelligenceEntry?.result ?? {
    events: [],
    summary: "",
    sources: [],
    lastDiscoveryAt: null,
  };

  // ── Discovery gate ────────────────────────────────────────────────────────
  const lastDiscoveryMs = currentState.lastDiscoveryAt
    ? new Date(currentState.lastDiscoveryAt).getTime()
    : 0;
  const discoveryAge = Date.now() - lastDiscoveryMs;

  // Count how many upcoming events we currently know about
  const upcomingCount = currentState.events.filter(
    (e) => computeProximity(e.date, todayMs) !== "PASSED"
  ).length;

  const discoveryDue =
    isForceAI ||
    upcomingCount === 0 ||
    discoveryAge >= DEFAULT_DISCOVERY_INTERVAL_MS;

  const discoveryReason = isForceAI
    ? "force_refresh"
    : upcomingCount === 0
    ? "no_known_events"
    : "scheduled_discovery";

  req.log.info(
    {
      mode: discoveryDue ? "DISCOVERY" : "MAINTENANCE",
      discoveryDue,
      discoveryAgeMin: Math.round(discoveryAge / 60_000),
      knownUpcoming: upcomingCount,
      discoveryReason: discoveryDue ? discoveryReason : undefined,
    },
    "Event Monitor mode determined"
  );

  // ══════════════════════════════════════════════════════════════════════════
  // MAINTENANCE PATH — zero AI, zero web search, zero tokens
  // ══════════════════════════════════════════════════════════════════════════

  if (!discoveryDue) {
    const maintenanceResult = runMaintenance(currentState, todayMs, nowIso);
    const analysisDuration = Date.now() - startTime;
    const output = toEventMonitorOutput(
      maintenanceResult.state,
      todayMs,
      nowIso,
      analysisDuration
    );

    // Validate output — maintenance path must produce a valid schema response
    const parsed = RunEventAnalysisResponse.safeParse(output);

    if (!parsed.success) {
      // Rare: stored state can't produce a valid response — fall through to discovery
      req.log.warn(
        { errors: parsed.error.message },
        "Event Monitor: maintenance output failed schema validation — forcing discovery"
      );
      // Fall through to discovery below
    } else {
      // Materiality check using proximity-aware key
      const prevMaterialityKey = computeMaterialityKey(currentState.events);
      const newMaterialityKey = computeMaterialityKey(
        maintenanceResult.state.events
      );
      const isMaterial = prevMaterialityKey !== newMaterialityKey;

      // Always update internal event-intelligence state (proximity may have changed)
      analysisRepository.save("event-intelligence", maintenanceResult.state);

      if (isMaterial) {
        analysisRepository.save("event-monitor", parsed.data);
        const summary = maintenanceResult.materialChanges.join("; ");
        systemLog.logInfo(
          "Event Monitor",
          `Maintenance (MATERIAL): ${summary}`
        );
      } else {
        analysisRepository.saveSkipped("event-monitor");
        systemLog.logInfo(
          "Event Monitor",
          `Maintenance (no material change): ${maintenanceResult.state.events.length} event(s) — materialVersion unchanged`
        );
      }

      res.json({
        ...parsed.data,
        _debug: {
          mode: "MAINTENANCE",
          discoveryDue: false,
          discoveryAgeMin: Math.round(discoveryAge / 60_000),
          aiCalled: false,
          webSearchUsed: false,
          knownEvents: maintenanceResult.state.events.length,
          isMaterial,
          materialChanges: maintenanceResult.materialChanges,
          proximityBoundariesCrossed:
            maintenanceResult.proximityBoundariesCrossed,
          passedEventsExpired: maintenanceResult.passedEventsExpired,
        },
      });
      return;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DISCOVERY PATH — AI + web search
  // ══════════════════════════════════════════════════════════════════════════

  // Optional: read Market Monitor for event prioritization
  const marketEntry =
    analysisRepository.get<Record<string, unknown>>("market-monitor");
  const marketContext = marketEntry
    ? JSON.stringify(
        {
          sentiment: (marketEntry.result as Record<string, unknown>)
            .marketSentiment,
          riskLevel: (marketEntry.result as Record<string, unknown>).riskLevel,
          keyRisks: (marketEntry.result as Record<string, unknown>).keyRisks,
          summary: (marketEntry.result as Record<string, unknown>).summary,
        },
        null,
        0
      )
    : null;

  if (marketContext) {
    req.log.info("Using Market Monitor context for event prioritisation");
  }

  // Build compact known-event index for AI deduplication context
  const knownEventIndex = buildEventIndex(currentState.events);

  req.log.info(
    {
      discoveryReason,
      knownEvents: currentState.events.length,
      hasMarketContext: marketContext !== null,
    },
    "Running event discovery with AI + web search"
  );

  let lastDebug: AiDebugInfo | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: unknown;
    let debug: AiDebugInfo;

    try {
      ({ result, debug } = await callAiWithWebSearch<unknown>(
        SYSTEM_PROMPT,
        buildUserPrompt(
          nowIso,
          todayStr,
          endDateStr,
          marketContext,
          knownEventIndex
        ),
        {
          model: getModel("monitor", "event-monitor"),
          maxTokens: 1500,
          temperature: 0.1,
          module: "event-monitor",
          operation: "analyze",
          retryNumber: attempt,
          webSearchContextSize: "low",
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
        systemLog.logError(
          "Event Monitor",
          `Event discovery failed: ${
            err instanceof Error ? err.message : "AI service call failed"
          }`
        );
        res.status(500).json({
          error:
            err instanceof Error ? err.message : "AI service call failed",
          _debug: extractAiErrorDebug(err),
        });
        return;
      }
      continue;
    }

    lastDebug = debug;

    // ── data_unavailable guard ─────────────────────────────────────────────
    const resultObj = result as Record<string, unknown>;
    if (resultObj?.data_unavailable === true) {
      req.log.warn({ reason: resultObj.reason }, "Event data unavailable");
      systemLog.logWarning(
        "Event Monitor",
        `Event data unavailable: ${String(resultObj.reason ?? "no data")}`
      );
      res.status(503).json({
        error: `Event data unavailable: ${
          resultObj.reason ??
          "Could not retrieve upcoming event data. Please try again later."
        }`,
        _debug: debug,
      });
      return;
    }

    // ── Extract and validate AI event candidates ───────────────────────────
    const rawEvents = Array.isArray(resultObj.events)
      ? (resultObj.events as Record<string, unknown>[])
      : [];

    const windowEndMs = new Date(endDateStr).setUTCHours(23, 59, 59, 999);
    const VALID_IMPORTANCE = new Set(["High", "Medium", "Low"]);

    const candidates: AiEventCandidate[] = rawEvents
      .filter((e) => {
        if (!e.date || typeof e.date !== "string") return false;
        const d = new Date(String(e.date) + "T00:00:00Z");
        if (isNaN(d.getTime())) return false;
        const ms = d.getTime();
        return (
          ms >= todayMs &&
          ms <= windowEndMs &&
          typeof e.title === "string" &&
          String(e.title).trim().length > 0
        );
      })
      .map((e) => ({
        title: String(e.title).trim(),
        date: String(e.date),
        category: String(e.category ?? "Economic"),
        importance: (
          VALID_IMPORTANCE.has(String(e.importance))
            ? e.importance
            : "Medium"
        ) as EventImportance,
        affectedMarkets: Array.isArray(e.affectedMarkets)
          ? (e.affectedMarkets as unknown[]).map(String)
          : [],
        expectedImpact: String(e.expectedImpact ?? ""),
        reason: String(e.reason ?? ""),
      }));

    if (candidates.length === 0) {
      if (attempt < MAX_ATTEMPTS) {
        req.log.warn(
          { attempt },
          "No valid event candidates from AI — retrying once"
        );
        continue;
      }
      req.log.error("No valid events from AI after retry");
      systemLog.logError(
        "Event Monitor",
        "Event discovery failed: no valid events found"
      );
      res.status(503).json({
        error:
          "No upcoming financial events were found for the next 14 days. Please try again later.",
        _debug: lastDebug,
      });
      return;
    }

    // ── Merge discovery with known event state ─────────────────────────────
    const rawSources = Array.isArray(resultObj.sources)
      ? (resultObj.sources as Record<string, unknown>[])
      : [];
    const sources = rawSources.map((s) => ({
      title: String(s.title ?? ""),
      url: String(s.url ?? ""),
      ...(s.published ? { published: String(s.published) } : {}),
    }));

    const discoveryResult = mergeDiscovery(
      currentState,
      candidates,
      String(resultObj.summary ?? ""),
      sources,
      todayMs,
      nowIso
    );

    // ── Assemble and validate output ───────────────────────────────────────
    const analysisDuration = Date.now() - startTime;
    const output = toEventMonitorOutput(
      discoveryResult.state,
      todayMs,
      nowIso,
      analysisDuration
    );

    const { normalized: normOutput, changes: normChanges } = normalizeAiResponse(
      output,
      RunEventAnalysisResponse
    );
    if (normChanges.length > 0) {
      req.log.info(
        { changes: normChanges, attempt },
        "Event Monitor: normalizer repaired formatting — no retry needed"
      );
    }
    const parsed = RunEventAnalysisResponse.safeParse(normOutput);

    if (parsed.success) {
      // ── Materiality check ────────────────────────────────────────────────
      const prevMaterialityKey = computeMaterialityKey(currentState.events);
      const newMaterialityKey = computeMaterialityKey(
        discoveryResult.state.events
      );
      const isMaterial =
        prevMaterialityKey !== newMaterialityKey ||
        discoveryResult.newEvents > 0 ||
        discoveryResult.updatedEvents > 0;

      // Always save event-intelligence (discovery always updates lastDiscoveryAt)
      analysisRepository.save("event-intelligence", discoveryResult.state);

      const highCount = parsed.data.events.filter(
        (e) => e.importance === "High"
      ).length;
      if (isMaterial) {
        analysisRepository.save("event-monitor", parsed.data);
        systemLog.logInfo(
          "Event Monitor",
          `Discovery (MATERIAL CHANGE): ${parsed.data.events.length} event(s), ${highCount} high, ` +
            `${discoveryResult.newEvents} new, ${discoveryResult.updatedEvents} updated, ` +
            `${discoveryResult.duplicatesIgnored} duplicates ignored`
        );
      } else {
        analysisRepository.saveSkipped("event-monitor");
        systemLog.logInfo(
          "Event Monitor",
          `Discovery (no material change): same ${parsed.data.events.length} event(s) — materialVersion unchanged`
        );
      }

      res.json({
        ...parsed.data,
        _debug: {
          ...debug,
          mode: "DISCOVERY",
          discoveryReason,
          discoveryDue: true,
          aiCalled: true,
          webSearchUsed: debug.webSearchUsed,
          model: getModel("monitor", "event-monitor"),
          isMaterial,
          newEvents: discoveryResult.newEvents,
          updatedEvents: discoveryResult.updatedEvents,
          duplicatesIgnored: discoveryResult.duplicatesIgnored,
          materialChanges: discoveryResult.materialChanges,
          knownEventsBeforeDiscovery: currentState.events.length,
        },
      });
      return;
    }

    // Schema validation failed
    if (attempt < MAX_ATTEMPTS) {
      const retryReason = classifyRetryReason(parsed.error, normChanges);
      req.log.warn(
        { errors: parsed.error.message, retryReason, attempt },
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
