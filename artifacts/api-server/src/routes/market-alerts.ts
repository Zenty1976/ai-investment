/**
 * Market Alerts Route
 *
 * The user's "attention manager" — answers only one question:
 * "What has changed since my previous analysis that deserves my attention?"
 *
 * Does NOT summarise the market or provide a daily newsletter.
 * Compares current context against the previous run, identifies new
 * developments, and assigns New / Updated / Unchanged status per alert.
 *
 * Results are stored under "market-alerts".
 * A compact history (latest 20 analyses) is maintained under "market-alerts-history".
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunMarketAlertsResponse } from "@workspace/api-zod";
import { callAiWithWebSearch, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";
import { companyIdentityStore } from "../lib/company-identity";

const router: IRouter = Router();

const MODULE_NAME = "Market Alerts";
const MAX_ATTEMPTS = 2;
const MAX_HISTORY = 20;

// ---------------------------------------------------------------------------
// History types
// ---------------------------------------------------------------------------

interface AlertHistoryAlert {
  title: string;
  category: string;
  importance: string;
  summary: string;
  normalizedKey: string; // `${title.toLowerCase().trim()}|${category.toLowerCase()}`
}

interface AlertHistoryEntry {
  timestamp: string;
  overallAlertLevel: string;
  headline: string;
  alertCount: number;
  alerts: AlertHistoryAlert[];
  newsIds: string[];       // news item IDs seen, for delta detection
  eventTitles: string[];   // event titles seen, for delta detection
  /** "Meaningful" = had actionable alerts; "NoChange" = no new material developments */
  checkResult: "Meaningful" | "NoChange";
}

// ---------------------------------------------------------------------------
// Status tracking
// ---------------------------------------------------------------------------

function normalizeAlertKey(title: string, category: string): string {
  return `${title.toLowerCase().trim()}|${category.toLowerCase().trim()}`;
}

type AlertStatus = "New" | "Updated" | "Unchanged";

function computeAlertStatus(
  alert: { normalizedKey: string; summary: string },
  previousAlerts: AlertHistoryAlert[]
): AlertStatus {
  const prev = previousAlerts.find((p) => p.normalizedKey === alert.normalizedKey);
  if (!prev) return "New";
  // Consider updated if summary has materially changed (simple length/content heuristic)
  if (prev.summary.toLowerCase().trim() !== alert.summary.toLowerCase().trim()) return "Updated";
  return "Unchanged";
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an institutional portfolio attention manager.

Your only task is to identify important developments that require the user's attention since the previous update.

WEB SEARCH REQUIREMENT:
You must perform a web search before producing your analysis. Search specifically for:
- Breaking news or developments affecting the held portfolio companies since the previous analysis timestamp
- New macroeconomic or geopolitical developments since then
- Any earnings results, guidance updates, or analyst actions since the previous analysis

CORE PRINCIPLE:
Answer exactly one question: "What has changed since the last analysis that deserves attention?"

Do NOT:
- Summarize the market
- Repeat yesterday's news (unless it materially changed)
- Provide a daily newsletter
- Repeat the same topic under different wording
- Include routine, expected, or already-known information

DO:
- Surface only meaningful NEW developments
- Think like an institutional morning briefing analyst
- Prefer quality over quantity
- Distinguish clearly between confirmed facts and market expectations
- Use the hours-since-previous-analysis, newly-added-news, and passed-events context provided

ALERT CATEGORIES:
- Portfolio: directly affects the user's current holdings as a whole
- Company: specific company news for a held position
- Macro: macroeconomic policy or data
- Sector: sector rotation or outlook change
- Event: scheduled event that occurred or is imminent
- Geopolitical: geopolitical developments with market impact
- Currency: currency movements relevant to the portfolio

IMPORTANCE:
- High: requires immediate review or action
- Medium: worth noting before the next trading session
- Low: background context only

IF NOTHING IMPORTANT HAS CHANGED:
Set overallAlertLevel to "Low" and nothingImportantChanged to true.
Explain briefly in executiveSummary why nothing requires immediate attention.
Return alerts as an empty array — if nothingImportantChanged is true, alerts MUST be [].

RESPONSE CONSISTENCY RULES (must not be violated):
- If nothingImportantChanged is true, the alerts array must be empty ([]).
- If the alerts array contains one or more items, nothingImportantChanged must be false.
- Do not return a known upcoming event as a new alert unless genuinely new information about that event has emerged since the previous check.
- Unchanged alerts (same title, category, and summary as the previous run) do not make the result meaningful — only omit them from the response entirely or mark requiresAttention as false.

Return JSON only — no markdown, no code fences, no extra text.
Do not include timestamp or analysisDuration — the server sets those.

Return exactly:
{"overallAlertLevel":"High|Medium|Low","executiveSummary":"...","headline":"...","alerts":[{"title":"...","category":"Portfolio|Company|Macro|Sector|Event|Geopolitical|Currency","importance":"High|Medium|Low","isNew":true,"requiresAttention":true,"affectedHoldings":["..."],"summary":"...","whyItMatters":"...","recommendedAttention":"Monitor|Review|Prepare|Watch","sourceType":"Web|NewsMonitor|CompanyMonitor|EventMonitor"}],"thingsToWatch":["..."],"nothingImportantChanged":false}`;

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

function buildUserPrompt(
  nowIso: string,
  hoursSincePrevious: number | null,
  portfolioContext: string,
  deltaContext: string,
  portfolioAnalyzerContext: string | null,
  riskAnalyzerContext: string | null,
  opportunityFinderContext: string | null,
  marketContext: string | null,
  sectorContext: string | null,
  eventContext: string | null,
  newsContext: string | null,
  companyContexts: Record<string, string>,
  alertHistoryContext: string | null
): string {
  const blocks: string[] = [
    `Current UTC: ${nowIso}`,
    "",
    hoursSincePrevious !== null
      ? `Hours since previous alert analysis: ${hoursSincePrevious.toFixed(1)}`
      : "No previous alert analysis found — this is the first run.",
    "",
    "CHANGE DETECTION CONTEXT (key input — use this to identify what is new):",
    deltaContext,
    "",
    "Current Portfolio:",
    portfolioContext,
  ];

  if (portfolioAnalyzerContext) {
    blocks.push(
      "",
      "Portfolio Analyzer summary (existing context — not necessarily new):",
      portfolioAnalyzerContext
    );
  }

  if (riskAnalyzerContext) {
    blocks.push(
      "",
      "Risk Analyzer summary (existing context — flag only genuinely new developments):",
      riskAnalyzerContext
    );
  }

  if (opportunityFinderContext) {
    blocks.push(
      "",
      "Opportunity Finder summary (existing context):",
      opportunityFinderContext
    );
  }

  for (const [ticker, ctx] of Object.entries(companyContexts)) {
    blocks.push(
      "",
      `Company Monitor for held position ${ticker}:`,
      ctx
    );
  }

  if (eventContext) {
    blocks.push(
      "",
      "Event Monitor:",
      eventContext
    );
  }

  if (sectorContext) {
    blocks.push(
      "",
      "Sector Monitor:",
      sectorContext
    );
  }

  if (marketContext) {
    blocks.push(
      "",
      "Market Monitor:",
      marketContext
    );
  }

  if (newsContext) {
    blocks.push(
      "",
      "News Monitor:",
      newsContext
    );
  }

  if (alertHistoryContext) {
    blocks.push(
      "",
      "Previous alert history (latest — avoid repeating these unless materially changed):",
      alertHistoryContext
    );
  }

  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/market-alerts/analyze", async (req, res): Promise<void> => {
  systemLog.logUser(MODULE_NAME, "User manually started market alerts analysis");

  const startTime = Date.now();
  const nowIso = new Date().toISOString();
  const nowDate = new Date(nowIso);
  let lastDebug: AiDebugInfo | undefined;

  // ── Portfolio Manager (required) ──────────────────────────────────────────

  const portfolioEntry = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  if (!portfolioEntry) {
    res.status(400).json({
      error: "No portfolio data available. Please run Portfolio Manager first.",
    });
    return;
  }

  const portfolioResult = portfolioEntry.result as Record<string, unknown>;
  const accounts = Array.isArray(portfolioResult.accounts)
    ? (portfolioResult.accounts as Array<Record<string, unknown>>)
    : [];

  // Compact portfolio context (positions only — no full detail)
  const positionList = accounts.flatMap((a) =>
    Array.isArray(a.positions)
      ? (a.positions as Array<Record<string, unknown>>).map((p) => ({
          symbol: p.symbol,
          name: p.name,
          currency: p.currency,
          marketValueBaseCurrency: p.marketValueBaseCurrency,
        }))
      : []
  );
  const portfolioContext = JSON.stringify({
    baseCurrency: portfolioResult.baseCurrency,
    totalValue: portfolioResult.totalValue,
    totalAvailableCash: portfolioResult.totalAvailableCash,
    positions: positionList,
  });

  // ── Load previous history for delta calculation ───────────────────────────

  const historyEntry = analysisRepository.get<{ entries: AlertHistoryEntry[] }>(
    "market-alerts-history"
  );
  const allHistoryEntries = historyEntry?.result?.entries ?? [];

  // Newest entry of ANY type — for elapsed-time, news-delta and events-delta.
  // A NoChange entry is fine here: it still carries the correct timestamp,
  // newsIds and eventTitles from that check.
  const previousCheckEntry = allHistoryEntries[0] ?? null;

  // Newest entry where meaningful alerts were found — for alert comparison
  // (New / Updated / Unchanged classification and resolved-alert detection).
  // A NoChange entry must NEVER be used here because its alert list is empty,
  // which would incorrectly classify every known alert as New on the next run.
  const previousMeaningfulEntry =
    allHistoryEntries.find((e) => e.checkResult === "Meaningful") ?? null;

  // ── Calculate delta context ───────────────────────────────────────────────

  let hoursSincePrevious: number | null = null;
  const passedEvents: string[] = [];
  const newNewsIds: string[] = [];

  if (previousCheckEntry) {
    const prevDate = new Date(previousCheckEntry.timestamp);
    hoursSincePrevious = (nowDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60);
  }

  // Events that occurred between previous run and now
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

  if (previousCheckEntry && eventEntry && Array.isArray(eventEntry.result.events)) {
    const prevDate = new Date(previousCheckEntry.timestamp);
    const prevEventTitles = new Set(previousCheckEntry.eventTitles);
    for (const ev of eventEntry.result.events as Array<Record<string, unknown>>) {
      const evDate = new Date(String(ev.date ?? ""));
      if (!isNaN(evDate.getTime()) && evDate >= prevDate && evDate <= nowDate) {
        if (!prevEventTitles.has(String(ev.title ?? ""))) {
          passedEvents.push(`${ev.title} (${ev.date})`);
        }
      }
    }
  }

  // Newly added news items since last run
  const newsEntry = analysisRepository.get<Record<string, unknown>>("news-monitor");
  const newsContext = newsEntry
    ? JSON.stringify({
        executiveSummary: newsEntry.result.executiveSummary,
        overallMarketImpact: newsEntry.result.overallMarketImpact,
        topStory: newsEntry.result.topStory,
        news: Array.isArray(newsEntry.result.news)
          ? (newsEntry.result.news as Array<Record<string, unknown>>).map((n) => ({
              id: n.id,
              title: n.title,
              category: n.category,
              importance: n.importance,
              whyItMatters: n.whyItMatters,
              marketImpact: n.marketImpact,
              publishedAt: n.publishedAt,
            }))
          : [],
      })
    : null;

  if (previousCheckEntry && newsEntry && Array.isArray(newsEntry.result.news)) {
    const prevNewsIds = new Set(previousCheckEntry.newsIds);
    for (const n of newsEntry.result.news as Array<Record<string, unknown>>) {
      const id = String(n.id ?? "");
      if (id && !prevNewsIds.has(id)) {
        newNewsIds.push(id);
      }
    }
  }

  // Build delta context block for the prompt.
  // Time/news/events delta uses previousCheckEntry (most recent check of any kind).
  // Alert level/titles use previousMeaningfulEntry (last check that had real alerts).
  const deltaLines: string[] = [];
  if (hoursSincePrevious !== null) {
    deltaLines.push(`- Previous check was ${hoursSincePrevious.toFixed(1)} hours ago (${previousCheckEntry!.timestamp})`);
  }
  if (passedEvents.length > 0) {
    deltaLines.push(`- Events that occurred since previous check: ${passedEvents.join("; ")}`);
  } else {
    deltaLines.push("- No tracked events have passed since previous check");
  }
  if (newNewsIds.length > 0) {
    deltaLines.push(`- Newly added news items (${newNewsIds.length} new vs previous check)`);
  } else if (previousCheckEntry) {
    deltaLines.push("- No new news items detected vs previous check");
  }
  if (previousMeaningfulEntry) {
    deltaLines.push(
      `- Last meaningful alert level: ${previousMeaningfulEntry.overallAlertLevel}, headline: "${previousMeaningfulEntry.headline}"`
    );
    if (previousMeaningfulEntry.alerts.length > 0) {
      deltaLines.push(
        `- Known alerts (do not repeat unless materially changed): ${previousMeaningfulEntry.alerts.map((a) => a.title).join("; ")}`
      );
    }
  }
  const deltaContext = deltaLines.join("\n");

  // ── Optional module contexts ───────────────────────────────────────────────

  const analyzerEntry = analysisRepository.get<Record<string, unknown>>("portfolio-analyzer");
  const portfolioAnalyzerContext = analyzerEntry
    ? JSON.stringify({
        mainConclusion: analyzerEntry.result.mainConclusion,
        overallRating: analyzerEntry.result.overallRating,
        overallOutlook: analyzerEntry.result.overallOutlook,
        topRisks: analyzerEntry.result.topRisks,
        weaknesses: analyzerEntry.result.weaknesses,
      })
    : null;

  const riskEntry = analysisRepository.get<Record<string, unknown>>("risk-analyzer");
  const riskAnalyzerContext = riskEntry
    ? JSON.stringify({
        overallRiskLevel: riskEntry.result.overallRiskLevel,
        riskScore: riskEntry.result.riskScore,
        mainConclusion: riskEntry.result.mainConclusion,
        topRisks: Array.isArray(riskEntry.result.topRisks)
          ? (riskEntry.result.topRisks as Array<Record<string, unknown>>).slice(0, 3).map((r) => ({
              title: r.title,
              category: r.category,
              severity: r.severity,
              probability: r.probability,
            }))
          : [],
      })
    : null;

  const opportunityEntry = analysisRepository.get<Record<string, unknown>>("opportunity-finder");
  const opportunityFinderContext = opportunityEntry
    ? JSON.stringify({
        overallOpportunityLevel: opportunityEntry.result.overallOpportunityLevel,
        topOpportunities: Array.isArray(opportunityEntry.result.topOpportunities)
          ? (opportunityEntry.result.topOpportunities as Array<Record<string, unknown>>).slice(0, 3).map((o) => ({
              company: o.company,
              ticker: o.ticker,
              mainCatalyst: o.mainCatalyst,
              mainRisk: o.mainRisk,
            }))
          : [],
      })
    : null;

  const marketEntry = analysisRepository.get<Record<string, unknown>>("market-monitor");
  const marketContext = marketEntry
    ? JSON.stringify({
        marketSentiment: marketEntry.result.marketSentiment,
        riskLevel: marketEntry.result.riskLevel,
        summary: marketEntry.result.summary,
        keyRisks: marketEntry.result.keyRisks,
      })
    : null;

  const sectorEntry = analysisRepository.get<Record<string, unknown>>("sector-monitor");
  const sectorContext = sectorEntry
    ? JSON.stringify({
        overallOutlook: sectorEntry.result.overallOutlook,
        sectors: Array.isArray(sectorEntry.result.sectors)
          ? (sectorEntry.result.sectors as Array<Record<string, unknown>>).map((s) => ({
              name: s.name,
              rating: s.rating,
              trend: s.trend,
            }))
          : [],
      })
    : null;

  // ── Company Monitor for held positions ─────────────────────────────────────

  const allRepoEntries = analysisRepository.getAll();
  const companyMonitorCandidates = allRepoEntries
    .filter((e) => e.moduleName.startsWith("company-monitor:"))
    .map((e) => ({ key: e.moduleName, result: e.result as Record<string, unknown> }));

  const companyContexts: Record<string, string> = {};
  for (const account of accounts) {
    const posArr = Array.isArray(account.positions)
      ? (account.positions as Array<Record<string, unknown>>)
      : [];
    for (const pos of posArr) {
      const symbol = String(pos.symbol ?? pos.ticker ?? "").trim().toUpperCase();
      if (!symbol || symbol in companyContexts) continue;
      const resolved = companyIdentityStore.resolve(
        symbol,
        { companyName: String(pos.name ?? "") },
        companyMonitorCandidates
      );
      if (resolved) {
        const entry = analysisRepository.get<Record<string, unknown>>(resolved.key);
        if (entry) {
          const r = entry.result as Record<string, unknown>;
          companyContexts[symbol] = JSON.stringify({
            executiveSummary: r.executiveSummary,
            investmentView: r.investmentView,
            catalysts: r.catalysts,
            risks: r.risks,
            earningsAndGuidance: r.earningsAndGuidance,
          });
        }
      }
    }
  }

  // ── Compact alert history context for prompt ──────────────────────────────

  const alertHistoryContext = historyEntry?.result?.entries
    ? JSON.stringify(
        historyEntry.result.entries.slice(0, 5).map((e) => ({
          timestamp: e.timestamp,
          overallAlertLevel: e.overallAlertLevel,
          headline: e.headline,
          alerts: e.alerts.map((a) => ({ title: a.title, category: a.category })),
        }))
      )
    : null;

  // ── Previous alerts for change tracking ──────────────────────────────────

  const previousAlerts: AlertHistoryAlert[] = previousMeaningfulEntry?.alerts ?? [];

  // ── AI call with retry ────────────────────────────────────────────────────
  // Retryable failures (web search not detected, empty response, invalid JSON,
  // transient OpenAI errors) proceed to the next attempt.  Only a final failed
  // attempt returns HTTP 500.  The request payload — including tools and
  // tool_choice — is identical on every attempt.

  const userPromptText = buildUserPrompt(
    nowIso,
    hoursSincePrevious,
    portfolioContext,
    deltaContext,
    portfolioAnalyzerContext,
    riskAnalyzerContext,
    opportunityFinderContext,
    marketContext,
    sectorContext,
    eventContext,
    newsContext,
    companyContexts,
    alertHistoryContext
  );

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: unknown;
    let debug: AiDebugInfo;

    try {
      ({ result, debug } = await callAiWithWebSearch<unknown>(
        SYSTEM_PROMPT,
        userPromptText,
        { model: "gpt-4o", maxTokens: 4000, temperature: 0.1 }
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
        systemLog.logError(MODULE_NAME, "Market alerts analysis failed");
        res.status(500).json({
          error: err instanceof Error ? err.message : "AI service call failed",
          _debug: extractAiErrorDebug(err),
        });
        return;
      }
      continue;
    }

    lastDebug = debug;
    const analysisDuration = Date.now() - startTime;

    const parsed = RunMarketAlertsResponse.safeParse({
      ...(result as Record<string, unknown>),
      timestamp: nowIso,
      analysisDuration,
    });

    if (parsed.success) {
      // ── Assign status per alert ───────────────────────────────────────────
      const alertsWithStatus = parsed.data.alerts.map((alert) => {
        const nk = normalizeAlertKey(alert.title, alert.category);
        const status = computeAlertStatus({ normalizedKey: nk, summary: alert.summary }, previousAlerts);
        return { ...alert, status };
      });

      // ── Identify resolved alerts ──────────────────────────────────────────
      const currentKeys = new Set(alertsWithStatus.map((a) => normalizeAlertKey(a.title, a.category)));
      const resolvedAlerts = previousAlerts.filter((p) => !currentKeys.has(p.normalizedKey));

      // ── Shared context for history ────────────────────────────────────────
      const currentNewsIds = Array.isArray(newsEntry?.result?.news)
        ? (newsEntry!.result.news as Array<Record<string, unknown>>).map((n) => String(n.id ?? "")).filter(Boolean)
        : [];
      const currentEventTitles = Array.isArray(eventEntry?.result?.events)
        ? (eventEntry!.result.events as Array<Record<string, unknown>>).map((e) => String(e.title ?? "")).filter(Boolean)
        : [];

      const existingHistoryEntries = historyEntry?.result?.entries ?? [];

      // ── Determine if this is a meaningful result ──────────────────────────
      // A result is only meaningful when:
      //   (a) OpenAI explicitly declared nothingImportantChanged = false, AND
      //   (b) there is at least one New or Updated alert that requires attention.
      //
      // This prevents four contradictory states from being saved as meaningful:
      //   • nothingImportantChanged = true  + alerts present  → NoChange
      //   • nothingImportantChanged = false + no qualifying alerts → NoChange
      //   • Unchanged-only alerts                             → NoChange
      //   • Empty alert list regardless of flag               → NoChange
      const meaningfulAlerts = alertsWithStatus.filter(
        (a) =>
          a.requiresAttention === true &&
          (a.status === "New" || a.status === "Updated")
      );

      const isMeaningful =
        parsed.data.nothingImportantChanged === false &&
        meaningfulAlerts.length > 0;

      // ── MEANINGFUL PATH ───────────────────────────────────────────────────
      if (isMeaningful) {
        const finalData = {
          ...parsed.data,
          alerts: alertsWithStatus,
          lastCheckedAt: nowIso,
          lastMeaningfulUpdateAt: nowIso,
          noNewDevelopmentsSinceLastCheck: false,
        };

        analysisRepository.save("market-alerts", finalData);

        const newHistoryEntry: AlertHistoryEntry = {
          timestamp: nowIso,
          overallAlertLevel: finalData.overallAlertLevel,
          headline: finalData.headline,
          alertCount: alertsWithStatus.length,
          alerts: alertsWithStatus.map((a) => ({
            title: a.title,
            category: a.category,
            importance: a.importance,
            summary: a.summary,
            normalizedKey: normalizeAlertKey(a.title, a.category),
          })),
          newsIds: currentNewsIds,
          eventTitles: currentEventTitles,
          checkResult: "Meaningful",
        };
        analysisRepository.save("market-alerts-history", {
          entries: [newHistoryEntry, ...existingHistoryEntries].slice(0, MAX_HISTORY),
        });

        // System log
        systemLog.logInfo(MODULE_NAME, "Market alerts analysis completed");

        const newAlerts = alertsWithStatus.filter((a) => a.status === "New");
        if (newAlerts.length > 0) {
          systemLog.logInternal(
            MODULE_NAME,
            `${newAlerts.length} new alert(s): ${newAlerts.map((a) => a.title).join("; ")}`
          );
        }
        if (resolvedAlerts.length > 0) {
          systemLog.logInternal(
            MODULE_NAME,
            `${resolvedAlerts.length} alert(s) resolved: ${resolvedAlerts.map((a) => a.title).join("; ")}`
          );
        }
        const highestAlert = alertsWithStatus.find((a) => a.importance === "High") ?? alertsWithStatus[0];
        if (highestAlert) {
          systemLog.logInternal(
            MODULE_NAME,
            `Highest priority alert: ${highestAlert.title} [${highestAlert.category}]`
          );
        }

        res.json({ ...finalData, _debug: debug });
        return;
      }

      // ── NO-CHANGE PATH ────────────────────────────────────────────────────
      // Do not overwrite the previous meaningful alert result.
      // Load the current stored result and update only the check-metadata fields.
      const storedEntry = analysisRepository.get<Record<string, unknown>>("market-alerts");
      const prevStored = storedEntry?.result as Record<string, unknown> | undefined;

      // Base is previous stored result (which already holds the last meaningful data),
      // or the AI response itself if nothing has been stored yet.
      const noChangeData: Record<string, unknown> = {
        ...(prevStored ?? { ...parsed.data, alerts: alertsWithStatus }),
        // Override only the check-metadata fields
        lastCheckedAt: nowIso,
        analysisDuration: parsed.data.analysisDuration,
        noNewDevelopmentsSinceLastCheck: true,
        // Preserve lastMeaningfulUpdateAt from whatever was stored previously
        lastMeaningfulUpdateAt: prevStored?.lastMeaningfulUpdateAt ?? undefined,
      };

      analysisRepository.save("market-alerts", noChangeData);

      const noChangeHistoryEntry: AlertHistoryEntry = {
        timestamp: nowIso,
        overallAlertLevel: String(noChangeData.overallAlertLevel ?? "Low"),
        headline: String(noChangeData.headline ?? ""),
        alertCount: 0,
        alerts: [],
        newsIds: currentNewsIds,
        eventTitles: currentEventTitles,
        checkResult: "NoChange",
      };
      analysisRepository.save("market-alerts-history", {
        entries: [noChangeHistoryEntry, ...existingHistoryEntries].slice(0, MAX_HISTORY),
      });

      systemLog.logInfo(MODULE_NAME, "Market Alerts checked: no new material developments");

      res.json({ ...noChangeData, _debug: debug });
      return;
    }

    if (attempt < MAX_ATTEMPTS) {
      req.log.warn(
        { errors: parsed.error.message, attempt },
        "Invalid AI response schema — retrying once"
      );
    } else {
      req.log.error({ errors: parsed.error.message }, "Invalid AI response schema after retry");
      systemLog.logError(MODULE_NAME, "Market alerts analysis failed — invalid response structure");
      res.status(500).json({
        error: "AI returned an invalid response structure. Please try again.",
        _debug: lastDebug,
      });
    }
  }
});

export default router;
