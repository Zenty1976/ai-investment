/**
 * Command Brief Route
 *
 * Produces a compact executive summary of the current state of the AI Investor
 * system — designed to be understood in approximately 20 seconds.
 *
 * It is a SUMMARY/INFORMATION module only. It does NOT make independent
 * investment decisions, create trade recommendations, or perform web research.
 *
 * Required sources: Trade Decision, Trade Review, Portfolio Manager, Risk Analyzer.
 * Optional context: Market Alerts, Event Monitor, Market Monitor, Sector Monitor,
 * Opportunity Finder.
 *
 * Results are stored under "command-brief".
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunCommandBriefResponse } from "@workspace/api-zod";
import { callAi, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";
import { automationOrchestrator } from "../lib/automation-orchestrator";
import { getModel } from "../lib/ai-model-config.js";
import { normalizeAiResponse, classifyRetryReason } from "../lib/ai-response-normalizer.js";
import { getAllCatalystStates } from "../lib/catalyst-repository.js";

const router: IRouter = Router();

const MODULE_NAME = "Command Brief";
const MAX_ATTEMPTS = 2;

// ── Upcoming Opportunities builder (no AI calls) ─────────────────────────────

export interface UpcomingOpportunity {
  ticker: string;
  company: string;
  event: string;
  daysUntilEvent: number;
  interestLevel: "HIGH_INTEREST" | "INVESTIGATE" | "MONITOR";
  opportunityScore: number | null;
  oneLineReason: string;
  promotedAt: string | null;
  priceRunup: number | null; // pre-event runup % (negative signal if high)
}

/**
 * Deterministically selects up to 3 upcoming catalyst opportunities from already-
 * computed Catalyst Intelligence data.
 *
 * Selection criteria:
 *   1. Must have a future event (daysUntilEvent > 0)
 *   2. Must have a completed analysis (not null)
 *   3. Must have a positive opportunityState (HighInterest, CandidateForTradeDecision,
 *      or Investigate — Monitor is excluded from the top section)
 *   4. Negative for stocks with extreme pre-event runup (price already extended)
 *
 * Ranking (descending):
 *   - HighInterest/CandidateForTradeDecision > Investigate
 *   - Promoted candidates first within each tier
 *   - Closer event (fewer days) ranks higher within the same tier
 *
 * ZERO AI calls — pure deterministic computation.
 */
export function buildUpcomingOpportunities(maxCount = 3): UpcomingOpportunity[] {
  const allStates = getAllCatalystStates();
  const now = new Date();

  // Filter to candidates that meet the criteria
  const candidates = allStates
    .filter(state => {
      if (!state.analysis) return false;
      const oppState = state.analysis.opportunityState as string | undefined;
      if (!oppState) return false;
      // Must be at least Investigate to appear as an "opportunity"
      const isInteresting = ["HighInterest", "CandidateForTradeDecision", "Investigate"].includes(oppState);
      if (!isInteresting) return false;
      // Must have a future event
      const daysUntilEvent = state.facts?.event?.daysUntilEvent ?? state.screening?.daysUntilEvent ?? null;
      if (daysUntilEvent === null || daysUntilEvent <= 0) return false;
      return true;
    })
    .map(state => {
      const oppState = state.analysis!.opportunityState as string;
      const daysUntilEvent = state.facts?.event?.daysUntilEvent ?? state.screening?.daysUntilEvent ?? 0;
      const eventType = state.facts?.event?.eventType ?? "Event";
      const priceAsymmetryFacts = state.facts?.price?.priceAsymmetryFacts as Record<string, unknown> | undefined;
      const runupPct = priceAsymmetryFacts?.preEventRunupPct as number | null ?? null;

      // Tier: 0=CandidateForTD/HighInterest, 1=Investigate
      const tier = ["HighInterest", "CandidateForTradeDecision"].includes(oppState) ? 0 : 1;

      // Interest level label
      const interestLevel: UpcomingOpportunity["interestLevel"] =
        tier === 0 ? "HIGH_INTEREST" : "INVESTIGATE";

      // Build one-line reason from analysis
      const thesis = state.analysis!.thesis as string | undefined;
      const priceAsymmetry = state.analysis!.priceAsymmetry ?? (state.screening?.priceAsymmetry ?? null);
      const runupNote = runupPct !== null && runupPct > 12
        ? ` (⚠ +${runupPct.toFixed(0)}% pre-event runup)`
        : "";
      const oneLineReason = thesis
        ? thesis.slice(0, 100) + (thesis.length > 100 ? "…" : "") + runupNote
        : `${eventType} in ${daysUntilEvent}d · ${oppState}${runupNote}`;

      // Opportunity score from analysis (may not be in schema but check anyway)
      const analysisRecord = state.analysis as unknown as Record<string, unknown>;
      const opportunityScore = (analysisRecord.opportunityScore as number | null) ?? null;

      return {
        ticker: state.ticker,
        company: state.company,
        event: `${eventType} in ${daysUntilEvent}d`,
        daysUntilEvent,
        interestLevel,
        opportunityScore,
        oneLineReason,
        promotedAt: state.promotedAt ?? null,
        priceRunup: runupPct,
        // Sorting key: tier (asc), promoted (desc), days (asc)
        _sortKey: tier * 10_000 + (state.promotedAt ? 0 : 1000) + daysUntilEvent,
      };
    })
    .sort((a, b) => a._sortKey - b._sortKey)
    .slice(0, maxCount)
    .map(({ _sortKey: _k, ...rest }) => rest);

  return candidates as UpcomingOpportunity[];
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are generating the executive Command Brief for an AI investment system.

Your job is to summarize the supplied module outputs into an extremely concise situational overview that can be understood in approximately 20 seconds.

You are NOT an independent investment decision engine.

Never create a BUY, SELL, REDUCE or other trading instruction that is not explicitly supported by Trade Decision / Trade Review.

Trade Review is authoritative for whether a trade is actionable NOW.

Trade Decision is authoritative for Hold, Review, PrepareToBuy, PrepareToReduce, WaitForEvent and similar states.

If Trade Review contains zero ready trades, explicitly communicate that no trade requires approval or action now.

Prioritize CHANGE and ATTENTION over repeating normal information. Focus on:
- increasing or decreasing risk
- important new alerts
- positions requiring monitoring
- decisions waiting for events
- new opportunities under review
- upcoming events capable of changing the outlook
- actual trades ready for approval

Do not simply summarize every input module. A user should understand the important situation in approximately 20 seconds.

Be concise, factual and action-oriented without creating new investment recommendations.

Return a valid JSON object matching the required schema exactly. Do not include any additional fields.`;

// ---------------------------------------------------------------------------
// Input builder
// ---------------------------------------------------------------------------

function buildUserPrompt(input: Record<string, unknown>, nowIso: string): string {
  return `Generate the Command Brief for the following system state.

${JSON.stringify(input)}

Return a JSON object with EXACTLY this shape — no extra fields:
{
  "overallStatus": "normal | attention | action",
  "headline": "one-line summary of the most important situation",
  "items": [
    {
      "category": "system | portfolio | risk | market | stock | event | opportunity | action",
      "severity": "positive | neutral | watch | warning | critical",
      "symbol": "optional ticker symbol — omit if not stock-specific",
      "text": "short sentence, preferably fitting one line"
    }
  ],
  "actionStatus": {
    "status": "none | monitor | review | trade_ready",
    "text": "brief description of required action (or 'No trades ready for approval' when status is none)"
  },
  "generatedAt": "${nowIso}"
}

Rules:
- Maximum 6 items. Select only the most important.
- overallStatus = "action" only if Trade Review has one or more ready trades.
- overallStatus = "attention" if something needs monitoring but no trade is ready now.
- overallStatus = "normal" if everything is healthy with nothing requiring immediate attention.
- If readyTradeCount is 0, actionStatus.status MUST be "none" and text must say no trades require approval.
- Do not invent information not present in the supplied input.
- Do not add extra JSON keys beyond the schema above.`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

router.post("/command-brief/analyze", async (req, res): Promise<void> => {
  const orchestratorTrigger = req.headers["x-orchestrator-trigger"];
  if (orchestratorTrigger) {
    systemLog.logInfo(MODULE_NAME, `Scheduled run (trigger: ${orchestratorTrigger})`);
  } else {
    systemLog.logUser(MODULE_NAME, "User manually started Command Brief generation");
  }

  const startTime = Date.now();
  const nowIso = new Date().toISOString();
  let lastDebug: AiDebugInfo | undefined;

  // ── Required sources ────────────────────────────────────────────────────────

  const portfolioEntry = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  if (!portfolioEntry) {
    res.status(400).json({ error: "No portfolio data available. Run Portfolio Manager first." });
    return;
  }

  const tdeEntry = analysisRepository.get<Record<string, unknown>>("trade-decision-engine");
  if (!tdeEntry) {
    res.status(400).json({ error: "No trade decision data available. Run Trade Decision Engine first." });
    return;
  }

  const riskEntry = analysisRepository.get<Record<string, unknown>>("risk-analyzer");
  if (!riskEntry) {
    res.status(400).json({ error: "No risk data available. Run Risk Analyzer first." });
    return;
  }

  const tradeReviewEntry = analysisRepository.get<Record<string, unknown>>("trade-review");
  if (!tradeReviewEntry) {
    res.status(400).json({ error: "No trade review data available. Run Trade Review first." });
    return;
  }

  // ── Automation system health ─────────────────────────────────────────────────

  const automationStatus = automationOrchestrator.getStatus();
  const moduleStatuses = automationStatus.modules;
  const freshCount = moduleStatuses.filter(
    (m) => m.freshness === "Fresh" || m.freshness === "DueSoon"
  ).length;
  const staleCount = moduleStatuses.filter((m) => m.freshness === "Stale").length;
  const failedCount = moduleStatuses.filter((m) => m.freshness === "Failed").length;
  const systemHealth =
    failedCount > 0 ? "degraded" : staleCount > 0 ? "stale" : "healthy";

  // ── Portfolio summary ────────────────────────────────────────────────────────

  const portfolioResult = portfolioEntry.result as Record<string, unknown>;
  const accounts = Array.isArray(portfolioResult.accounts)
    ? (portfolioResult.accounts as Array<Record<string, unknown>>)
    : [];
  const totalValue = accounts.reduce((s, a) => s + (Number(a.accountValue) || 0), 0);
  const totalPL = accounts.reduce((s, a) => s + (Number(a.unrealizedProfitLoss) || 0), 0);
  const allPositions = accounts.flatMap((a) =>
    Array.isArray(a.positions) ? (a.positions as Array<Record<string, unknown>>) : []
  );

  // ── Trade Decision Engine (compact) ─────────────────────────────────────────

  const tdeResult = tdeEntry.result as Record<string, unknown>;
  const tdeDecisions = Array.isArray(tdeResult.decisions)
    ? (tdeResult.decisions as Array<Record<string, unknown>>).slice(0, 6).map((d) => ({
        ticker: d.ticker || d.company,
        decision: d.decision,
        urgency: d.urgency,
        confidence: d.confidence,
        readiness: d.readiness,
        reason: typeof d.reason === "string" ? d.reason.slice(0, 150) : "",
      }))
    : [];

  // ── Trade Review (count ready trades) ───────────────────────────────────────

  const tradeReviewResult = tradeReviewEntry.result as Record<string, unknown>;
  const proposals = Array.isArray(tradeReviewResult.proposals)
    ? (tradeReviewResult.proposals as Array<Record<string, unknown>>)
    : [];
  const readyTrades = proposals.filter((p) => p.status === "ReadyForReview");

  // ── Risk (compact) ───────────────────────────────────────────────────────────

  const riskResult = riskEntry.result as Record<string, unknown>;
  const topRisks = Array.isArray(riskResult.topRisks)
    ? (riskResult.topRisks as Array<Record<string, unknown>>).slice(0, 3).map((r) => ({
        title: r.title,
        severity: r.severity,
        category: r.category,
      }))
    : [];

  // ── Optional sources ─────────────────────────────────────────────────────────

  const alertsEntry = analysisRepository.get<Record<string, unknown>>("market-alerts");
  const eventEntry = analysisRepository.get<Record<string, unknown>>("event-monitor");
  const marketEntry = analysisRepository.get<Record<string, unknown>>("market-monitor");
  const sectorEntry = analysisRepository.get<Record<string, unknown>>("sector-monitor");
  const ofEntry = analysisRepository.get<Record<string, unknown>>("opportunity-finder");

  // ── Assemble compact input ───────────────────────────────────────────────────

  const input: Record<string, unknown> = {
    generatedAt: nowIso,

    system: {
      fresh: freshCount,
      stale: staleCount,
      failed: failedCount,
      total: moduleStatuses.length,
      status: systemHealth,
    },

    portfolio: {
      totalValue,
      unrealizedPL: totalPL,
      positionCount: allPositions.length,
      positions: allPositions.map((p) => ({
        symbol: p.symbol,
        name: p.name,
        marketValueBaseCurrency: p.marketValueBaseCurrency ?? p.marketValue,
        profitLoss: p.profitLoss,
        dayChangePercent: p.dayChangePercent,
      })),
    },

    risk: {
      score: riskResult.riskScore,
      level: riskResult.overallRiskLevel,
      mainConclusion:
        (riskResult.mainConclusion as Record<string, unknown> | undefined)?.title ??
        riskResult.overallConclusion,
      topRisks,
    },

    tradeDecisions: {
      overallReadiness: tdeResult.decisionReadinessScore,
      stance: tdeResult.overallDecisionPosture,
      mainConclusion: (tdeResult.mainConclusion as Record<string, unknown> | undefined)
        ?.title,
      decisions: tdeDecisions,
    },

    tradeReview: {
      readyTradeCount: readyTrades.length,
      readyTrades: readyTrades.slice(0, 3).map((p) => ({
        ticker: p.ticker,
        company: p.company,
        action: p.recommendedAction,
        quantity: p.approvedQuantity,
        title: p.title,
      })),
    },
  };

  // Optional: Market Alerts
  if (alertsEntry) {
    const ar = alertsEntry.result as Record<string, unknown>;
    const highAlerts = Array.isArray(ar.alerts)
      ? (ar.alerts as Array<Record<string, unknown>>)
          .filter((a) => a.importance === "High")
          .slice(0, 3)
          .map((a) => ({ title: a.title, category: a.category }))
      : [];
    input.alerts = {
      level: ar.overallAlertLevel,
      headline: ar.headline,
      noChanges: ar.noNewDevelopmentsSinceLastCheck,
      highAlerts,
    };
  }

  // Optional: Event Monitor
  if (eventEntry) {
    const er = eventEntry.result as Record<string, unknown>;
    input.events = {
      nextMajorEvent: er.nextMajorEvent,
      summary:
        typeof er.summary === "string" ? er.summary.slice(0, 200) : er.summary,
    };
  }

  // Optional: Market Monitor
  if (marketEntry) {
    const mr = marketEntry.result as Record<string, unknown>;
    input.marketContext = {
      sentiment: mr.marketSentiment,
      riskLevel: mr.riskLevel,
      summary:
        typeof mr.summary === "string" ? mr.summary.slice(0, 200) : undefined,
    };
  }

  // Optional: Sector Monitor
  if (sectorEntry) {
    const sr = sectorEntry.result as Record<string, unknown>;
    input.sectors = {
      overallOutlook: sr.overallOutlook,
      topSectors: Array.isArray(sr.sectors)
        ? (sr.sectors as Array<Record<string, unknown>>).slice(0, 4).map((s) => ({
            name: s.name,
            rating: s.rating,
            trend: s.trend,
          }))
        : [],
    };
  }

  // Optional: Opportunity Finder
  if (ofEntry) {
    const of_ = ofEntry.result as Record<string, unknown>;
    input.opportunities = Array.isArray(of_.topOpportunities)
      ? (of_.topOpportunities as Array<Record<string, unknown>>).slice(0, 3).map((o) => ({
          symbol: o.ticker,
          company: o.company,
          score: o.overallScore,
          priority: o.priority,
        }))
      : [];
  }

  // ── Upcoming Opportunities — deterministic from Catalyst Intelligence ─────────
  // ZERO additional AI calls. Reads already-computed catalyst analysis results.
  // Selects up to 3 candidates with: future event + positive evidence + sufficient analysis.
  // Does NOT re-analyze stocks — purely presentation of already-stored results.

  const upcomingOpportunities = buildUpcomingOpportunities();
  // Also inject into AI input so the model can reference them in items if relevant.
  if (upcomingOpportunities.length > 0) {
    input.upcomingCatalysts = upcomingOpportunities.map(o => ({
      ticker: o.ticker,
      company: o.company,
      event: o.event,
      daysUntilEvent: o.daysUntilEvent,
      interestLevel: o.interestLevel,
      opportunityScore: o.opportunityScore,
      oneLineReason: o.oneLineReason,
    }));
  }

  // ── AI call with retry ───────────────────────────────────────────────────────

  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      const { result: raw, debug } = await callAi<unknown>(
        SYSTEM_PROMPT,
        buildUserPrompt(input, nowIso),
        { model: getModel("brief", "command-brief"), maxTokens: 800, temperature: 0.1, module: "command-brief", operation: "analyze", retryNumber: attempt }
      );
      lastDebug = debug;

      // Ensure generatedAt is present (model sometimes omits it)
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const obj = raw as Record<string, unknown>;
        if (!obj.generatedAt) obj.generatedAt = nowIso;
      }

      const { normalized: normRaw, changes: normChanges } = normalizeAiResponse(raw, RunCommandBriefResponse);
      if (normChanges.length > 0) req.log.info({ changes: normChanges, attempt }, "Command Brief: normalizer repaired formatting — no retry needed");
      const parsed = RunCommandBriefResponse.safeParse(normRaw);
      if (!parsed.success) {
        const errMsg = parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        if (attempt < MAX_ATTEMPTS) {
          systemLog.logWarning(
            MODULE_NAME,
            `Schema validation failed (attempt ${attempt}): ${errMsg} — retrying`
          );
          continue;
        }
        res.status(500).json({
          error: `Schema validation failed: ${errMsg}`,
          _debug: lastDebug,
        });
        return;
      }

      const finalData = parsed.data;
      const analysisDuration = Date.now() - startTime;

      analysisRepository.save("command-brief", {
        ...finalData,
        upcomingOpportunities,
        analysisDuration,
      });
      systemLog.logInfo(
        MODULE_NAME,
        `Command Brief generated (${analysisDuration}ms): ${finalData.overallStatus} — ${finalData.headline}${upcomingOpportunities.length > 0 ? ` | ${upcomingOpportunities.length} upcoming opportunity(-ies)` : ""}`
      );

      res.json({
        ...finalData,
        upcomingOpportunities,
        analysisDuration,
        _debug: lastDebug,
      });
      return;
    } catch (err) {
      const aiDebug = extractAiErrorDebug(err);
      if (aiDebug) lastDebug = aiDebug as AiDebugInfo;
      if (attempt >= MAX_ATTEMPTS) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
          _debug: lastDebug,
        });
        return;
      }
    }
  }
});

export default router;
