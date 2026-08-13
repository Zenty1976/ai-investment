/**
 * Sector Monitor Route — Hybrid Architecture
 *
 * MAINTENANCE path (zero AI):
 *   Runs when the deterministic input fingerprint is unchanged from the last
 *   successful AI call. Returns the cached qualitative interpretation.
 *   Zero OpenAI tokens, zero web-search cost.
 *
 * DISCOVERY path (AI + web search):
 *   Runs when upstream module states or portfolio exposure have changed
 *   meaningfully, or on the first run. AI receives:
 *     • Compact deterministic SectorFacts (portfolio exposure per sector)
 *     • Compact upstream contexts (market, event, news)
 *     • Previous sector interpretation (for "what changed?" framing)
 *   AI focuses on WHY sectors are behaving as they are — not on calculating
 *   objective metrics that the backend now provides.
 *
 * Downstream compatibility:
 *   The emitted shape (executiveSummary, overallOutlook, topSector, sectors[])
 *   is unchanged. downstream-ai-context.getSectorAiContext() continues to work
 *   without modification.
 *
 * Data gaps:
 *   Sector ETF/index price series are NOT available in this application.
 *   Returns, relative performance and rotation signals derived from sector
 *   price data could NOT be implemented deterministically — see sector-intelligence.ts.
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunSectorAnalysisResponse } from "@workspace/api-zod";
import { callAiWithWebSearch, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";
import { getModel } from "../lib/ai-model-config.js";
import { normalizeAiResponse } from "../lib/ai-response-normalizer.js";
import {
  computePortfolioSectorExposure,
  buildSectorFactsBlock,
  computeInputFingerprint,
  computeOutputFingerprint,
  isOutputMaterial,
  extractMarketInputs,
  extractEventInputs,
  extractNewsInputs,
  buildExposureBandKeys,
  type SectorMonitorFacts,
} from "../lib/sector-intelligence.js";
import type { PortfolioSnapshot } from "./portfolio-manager.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior institutional equity strategist. Your task is to determine where capital appears to be flowing across major market sectors over the next 1-3 months.

You will receive:
  1. PORTFOLIO SECTOR EXPOSURE — deterministic facts pre-computed by the backend. Do NOT recalculate these.
  2. Market Monitor, Event Monitor, News Monitor context — use for macro framing.
  3. Previous sector interpretation (if available) — focus on what has CHANGED.

YOUR JOB is qualitative interpretation:
  • WHY are the strongest/weakest sectors behaving this way?
  • Does apparent rotation look meaningful or noise?
  • What macro/news/events plausibly explain the leadership pattern?
  • Is the leadership broad, narrow, defensive, cyclical, risk-on, risk-off?
  • Which sector developments deserve investor attention right now?
  • What could invalidate the current interpretation?

Use live web search to gather current sector catalyst data — especially sector-specific developments (policy changes, regulatory actions, supply shocks, industry-specific catalysts) not already covered by the upstream context you've been given. Do not rediscover general market news already present in the News/Market Monitor context.

Return JSON only — no markdown, no surrounding text.

Do NOT calculate returns, rankings, portfolio weights, or relative performance — these are provided to you as facts. Focus on WHY.

ALWAYS ANALYSE AT LEAST THESE SECTORS:
AI & Software, Semiconductors, Healthcare, Biotechnology, Financials, Industrials, Energy, Utilities, Consumer Discretionary, Consumer Staples, Communication Services, Materials, Real Estate

You may add additional sectors if market conditions warrant it.

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

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildUserPrompt(
  nowIso: string,
  sectorFacts: SectorMonitorFacts,
  marketContext: string | null,
  eventContext: string | null,
  newsContext: string | null,
  prevSectorSummary: string | null
): string {
  const blocks: string[] = [
    `UTC: ${nowIso}`,
    "",
    "Analyse major equity sectors and determine where institutional capital is most likely to flow over the next 1-3 months.",
    "",
    buildSectorFactsBlock(sectorFacts),
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
  if (prevSectorSummary) {
    blocks.push(
      "",
      "Previous sector interpretation (describe what has CHANGED from this — do not repeat it):",
      prevSectorSummary
    );
  }

  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// Portfolio sector exposure helper
// ---------------------------------------------------------------------------

function buildSectorByTicker(
): Map<string, string> {
  const map = new Map<string, string>();
  // Walk all repository entries for company-monitor:<TICKER>
  for (const entry of analysisRepository.getAll()) {
    if (!entry.moduleName.startsWith("company-monitor:")) continue;
    const ticker = entry.moduleName.slice("company-monitor:".length).toUpperCase().trim();
    if (!ticker) continue;
    const r = entry.result as Record<string, unknown>;
    const sector =
      (r.company as Record<string, unknown> | undefined)?.sector as string | undefined
      ?? r.sector as string | undefined;
    if (sector && sector.trim()) {
      map.set(ticker, sector.trim());
    }
  }
  return map;
}

function getPortfolioSectorFacts(): SectorMonitorFacts {
  const snapshot = analysisRepository.get<PortfolioSnapshot>("portfolio-manager");
  if (!snapshot) {
    return {
      portfolioExposure: [],
      unclassifiedTickers: [],
      coveragePct: 0,
      coverageConfidence: "Low",
      totalClassifiableMv: 0,
    };
  }
  const positions = snapshot.result.accounts.flatMap((a) => a.positions);
  const sectorByTicker = buildSectorByTicker();
  return computePortfolioSectorExposure(positions, sectorByTicker);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/sector-monitor/analyze", async (req, res): Promise<void> => {
  req.log.info("Running sector monitor analysis");
  const orchestratorTrigger = req.headers["x-orchestrator-trigger"];
  if (orchestratorTrigger) {
    systemLog.logInfo("Sector Monitor", `Scheduled run (trigger: ${orchestratorTrigger})`);
  } else {
    systemLog.logUser("Sector Monitor", "User manually started sector analysis");
  }

  const startTime = Date.now();
  const nowIso = new Date().toISOString();

  // ── 1. Deterministic sector facts (portfolio exposure) ─────────────────────

  const sectorFacts = getPortfolioSectorFacts();

  // ── 2. Compact upstream contexts ───────────────────────────────────────────

  const marketEntry = analysisRepository.get<Record<string, unknown>>("market-monitor");
  const marketResult = marketEntry?.result ?? null;
  const marketContext = marketResult
    ? JSON.stringify({
        marketSentiment: marketResult.marketSentiment,
        riskLevel: marketResult.riskLevel,
        summary: marketResult.summary,
        positiveFactors: marketResult.positiveFactors,
        negativeFactors: marketResult.negativeFactors,
        strongSectors: marketResult.strongSectors,
        weakSectors: marketResult.weakSectors,
        keyRisks: marketResult.keyRisks,
      })
    : null;

  const eventEntry = analysisRepository.get<Record<string, unknown>>("event-monitor");
  const eventResult = eventEntry?.result ?? null;
  const eventContext = eventResult
    ? JSON.stringify({
        summary: eventResult.summary,
        nextMajorEvent: eventResult.nextMajorEvent,
        events: Array.isArray(eventResult.events)
          ? (eventResult.events as Array<Record<string, unknown>>).map((e) => ({
              title: e.title,
              date: e.date,
              importance: e.importance,
              expectedImpact: e.expectedImpact,
            }))
          : [],
      })
    : null;

  const newsEntry = analysisRepository.get<Record<string, unknown>>("news-monitor");
  const newsResult = newsEntry?.result ?? null;
  const newsContext = newsResult
    ? JSON.stringify({
        executiveSummary: newsResult.executiveSummary,
        overallMarketImpact: newsResult.overallMarketImpact,
        topStory: newsResult.topStory,
        news: Array.isArray(newsResult.news)
          ? (newsResult.news as Array<Record<string, unknown>>).map((n) => ({
              title: n.title,
              category: n.category,
              importance: n.importance,
              marketImpact: n.marketImpact,
              affectedMarkets: n.affectedMarkets,
            }))
          : [],
      })
    : null;

  // ── 3. Compute deterministic input fingerprint ─────────────────────────────

  const mktInputs = extractMarketInputs(marketResult);
  const evtInputKeys = extractEventInputs(eventResult);
  const newsInputs = extractNewsInputs(newsResult);
  const exposureBandKeys = buildExposureBandKeys(sectorFacts.portfolioExposure);

  const inputFingerprint = computeInputFingerprint(
    mktInputs.sentiment,
    mktInputs.risk,
    mktInputs.strongSectors,
    mktInputs.weakSectors,
    evtInputKeys,
    newsInputs.impact,
    newsInputs.topStoryTitle,
    exposureBandKeys
  );

  // ── 4. Skip AI if inputs are unchanged ─────────────────────────────────────

  const prevEntry = analysisRepository.get<Record<string, unknown>>("sector-monitor");
  const storedFingerprint = prevEntry?.dependencyFingerprint ?? null;
  const hasPreviousResult = !!prevEntry;

  if (hasPreviousResult && storedFingerprint === inputFingerprint) {
    // Inputs unchanged — reuse previous qualitative interpretation
    analysisRepository.saveSkipped("sector-monitor");

    const analysisDuration = Date.now() - startTime;
    const cached = prevEntry!.result;
    const prevOutputKey = computeOutputFingerprint(
      Array.isArray(cached.sectors) ? (cached.sectors as Array<{ name: string; rating: string; trend: string }>) : []
    );

    req.log.info({ inputFingerprint }, "Sector Monitor: inputs unchanged — returning cached analysis (0 AI calls)");
    systemLog.logInfo("Sector Monitor", "Sector inputs unchanged — reusing previous qualitative interpretation (0 AI tokens)");

    res.json({
      ...cached,
      _debug: {
        mode: "MAINTENANCE",
        reason: "SECTOR_FACTS_UNCHANGED",
        inputFingerprint,
        storedFingerprint,
        aiCalled: false,
        webSearchUsed: false,
        portfolioSectorFacts: sectorFacts,
        outputFingerprint: prevOutputKey,
        analysisDuration,
      },
    });
    return;
  }

  // ── 5. DISCOVERY — call AI with compact SectorFacts ────────────────────────

  req.log.info({ inputFingerprint, storedFingerprint, hasPreviousResult }, "Sector Monitor: inputs changed — running AI analysis");

  // Previous sector summary for "what changed?" framing
  const prevSectorSummary = hasPreviousResult
    ? (() => {
        const r = prevEntry!.result;
        const topSector = r.topSector as Record<string, unknown> | undefined;
        const sectors = Array.isArray(r.sectors)
          ? (r.sectors as Array<{ name: string; rating: string; trend: string }>)
              .slice(0, 8)
              .map((s) => `${s.name}: ${s.rating} / ${s.trend}`)
              .join(", ")
          : "";
        return `Top sector: ${String(topSector?.name ?? "—")}. Ratings: ${sectors}`;
      })()
    : null;

  let lastDebug: AiDebugInfo | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: unknown;
    let debug: AiDebugInfo;

    try {
      ({ result, debug } = await callAiWithWebSearch<unknown>(
        SYSTEM_PROMPT,
        buildUserPrompt(nowIso, sectorFacts, marketContext, eventContext, newsContext, prevSectorSummary),
        {
          model: getModel("monitor", "sector-monitor"),
          maxTokens: 2500,
          temperature: 0.1,
          module: "sector-monitor",
          operation: "analyze",
          retryNumber: attempt,
          webSearchContextSize: "medium",
        }
      ));
    } catch (err) {
      const isLastAttempt = attempt >= MAX_ATTEMPTS;
      req.log[isLastAttempt ? "error" : "warn"](
        { err, attempt },
        isLastAttempt ? "AI service call failed after all attempts" : "AI service call failed — retrying"
      );
      if (isLastAttempt) {
        systemLog.logError(
          "Sector Monitor",
          `Sector analysis failed: ${err instanceof Error ? err.message : "AI service call failed"}`
        );
        res.status(500).json({
          error: err instanceof Error ? err.message : "AI service call failed",
          _debug: extractAiErrorDebug(err),
        });
        return;
      }
      continue;
    }

    lastDebug = debug;

    // ── Validate against Zod schema ────────────────────────────────────────
    const analysisDuration = Date.now() - startTime;
    const assembled = {
      ...(result as Record<string, unknown>),
      timestamp: nowIso,
      analysisDuration,
    };
    const { normalized: normAssembled, changes: normChanges } = normalizeAiResponse(
      assembled,
      RunSectorAnalysisResponse
    );
    if (normChanges.length > 0) {
      req.log.info({ changes: normChanges, attempt }, "Sector Monitor: normalizer repaired formatting");
    }
    const parsed = RunSectorAnalysisResponse.safeParse(normAssembled);

    if (parsed.success) {
      // ── Deterministic output fingerprint / materiality check ─────────────
      const prevOutputKey = hasPreviousResult
        ? computeOutputFingerprint(
            Array.isArray(prevEntry!.result.sectors)
              ? (prevEntry!.result.sectors as Array<{ name: string; rating: string; trend: string }>)
              : []
          )
        : "";
      const newOutputKey = computeOutputFingerprint(parsed.data.sectors);
      const outputMaterial = isOutputMaterial(prevOutputKey, newOutputKey);

      const weakest = parsed.data.sectors[parsed.data.sectors.length - 1];

      if (outputMaterial || !hasPreviousResult) {
        analysisRepository.save("sector-monitor", parsed.data);
        analysisRepository.setFingerprint("sector-monitor", inputFingerprint, nowIso);
        systemLog.logInfo(
          "Sector Monitor",
          `Sector analysis completed (MATERIAL CHANGE): ${parsed.data.topSector.name} strongest, ${weakest?.name ?? "—"} weakest`
        );
      } else {
        // Output unchanged — update fingerprint so future calls stay skipped
        analysisRepository.saveSkipped("sector-monitor");
        analysisRepository.setFingerprint("sector-monitor", inputFingerprint, nowIso);
        systemLog.logInfo(
          "Sector Monitor",
          `Sector analysis completed (no material change in ratings/trends): fingerprint updated`
        );
      }

      res.json({
        ...parsed.data,
        _debug: {
          ...debug,
          mode: "DISCOVERY",
          aiCalled: true,
          inputFingerprint,
          storedFingerprint,
          outputFingerprint: newOutputKey,
          previousOutputFingerprint: prevOutputKey,
          outputMaterial,
          normalizationChanges: normChanges.length > 0 ? normChanges : undefined,
          portfolioSectorFacts: sectorFacts,
          analysisDuration,
        },
      });
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
