/**
 * Market Alerts Route
 *
 * The user's "attention manager" — answers only one question:
 * "What has changed since my previous analysis that deserves my attention?"
 *
 * HOW ALERTS ARE GENERATED (zero OpenAI calls in normal operation):
 *   A deterministic Alert Engine (alert-engine.ts) reads structured results
 *   from upstream modules (Company Monitor, News Monitor, Event Monitor,
 *   Market Monitor, Sector Monitor) and applies rule-based severity scoring.
 *   No GPT call occurs unless a future escalation path is explicitly added.
 *
 * Results are stored under "market-alerts".
 * A compact history (latest 20 analyses) is maintained under "market-alerts-history".
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunMarketAlertsResponse } from "@workspace/api-zod";
import { analysisRepository } from "../lib/analysis-repository";
import { companyIdentityStore } from "../lib/company-identity";
import { runAlertEngine, type AlertEngineDebug } from "../lib/alert-engine.js";

const router: IRouter = Router();

const MODULE_NAME = "Market Alerts";
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
  /** Ticker symbols affected — used to detect when affectedHoldings changes between runs */
  affectedHoldings?: string[];
}

interface AlertHistoryEntry {
  timestamp: string;
  overallAlertLevel: string;
  headline: string;
  alertCount: number;
  alerts: AlertHistoryAlert[];
  newsIds: string[];       // news item IDs seen at this check
  eventTitles: string[];   // event titles seen at this check
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
  alert: { normalizedKey: string; summary: string; affectedHoldings?: string[] },
  previousAlerts: AlertHistoryAlert[]
): AlertStatus {
  const prev = previousAlerts.find((p) => p.normalizedKey === alert.normalizedKey);
  if (!prev) return "New";
  if (prev.summary.toLowerCase().trim() !== alert.summary.toLowerCase().trim()) return "Updated";
  // Detect when affectedHoldings changes (e.g. after a sector-matching fix or portfolio change)
  if (prev.affectedHoldings !== undefined && alert.affectedHoldings !== undefined) {
    const prevSet = new Set(prev.affectedHoldings);
    const currSet = new Set(alert.affectedHoldings);
    const changed =
      prevSet.size !== currSet.size ||
      [...currSet].some((t) => !prevSet.has(t));
    if (changed) return "Updated";
  }
  return "Unchanged";
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/market-alerts/analyze", async (req, res): Promise<void> => {
  const orchestratorTrigger = req.headers["x-orchestrator-trigger"];
  if (orchestratorTrigger) {
    systemLog.logInfo(MODULE_NAME, `Scheduled run (trigger: ${orchestratorTrigger})`);
  } else {
    systemLog.logUser(MODULE_NAME, "User manually started market alerts analysis");
  }

  const startTime = Date.now();
  const nowIso    = new Date().toISOString();
  const nowDate   = new Date(nowIso);

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

  // Extract holding symbols for filtering and deduplication
  const positionList = accounts.flatMap((a) =>
    Array.isArray(a.positions)
      ? (a.positions as Array<Record<string, unknown>>).map((p) => ({
          symbol: String(p.symbol ?? p.ticker ?? "").trim().toUpperCase(),
          name:   String(p.name ?? ""),
        }))
      : []
  );
  const holdingSymbols = [...new Set(positionList.map((p) => p.symbol).filter(Boolean))];

  // ── Load previous history ─────────────────────────────────────────────────

  const historyEntry = analysisRepository.get<{ entries: AlertHistoryEntry[] }>(
    "market-alerts-history"
  );
  const allHistoryEntries = historyEntry?.result?.entries ?? [];

  // Newest entry of ANY type — for current news/event snapshots (history tracking).
  const previousCheckEntry = allHistoryEntries[0] ?? null;

  // Newest MEANINGFUL entry — for alert status comparison (New/Updated/Unchanged).
  // A NoChange entry must NEVER be used here: its alert list is empty, which would
  // incorrectly classify every known alert as New on the next run.
  const previousMeaningfulEntry =
    allHistoryEntries.find((e) => e.checkResult === "Meaningful") ?? null;

  const previousAlerts: AlertHistoryAlert[] = previousMeaningfulEntry?.alerts ?? [];

  // Stored market-alerts result — used to detect affectedHoldings changes when
  // history entries pre-date the affectedHoldings field (i.e. old history).
  // The stored result always has the full alert shape including affectedHoldings.
  const storedMarketAlerts = analysisRepository.get<Record<string, unknown>>("market-alerts");
  const storedAlertsList: Array<Record<string, unknown>> = Array.isArray(
    storedMarketAlerts?.result?.alerts
  )
    ? (storedMarketAlerts!.result.alerts as Array<Record<string, unknown>>)
    : [];

  // ── Build Company Monitor entries map (identity-resolved) ─────────────────
  // The Alert Engine needs raw CM results; we resolve identity here so the
  // engine doesn't need to import companyIdentityStore.

  const allRepoEntries = analysisRepository.getAll();
  const cmCandidates = allRepoEntries
    .filter((e) => e.moduleName.startsWith("company-monitor:"))
    .map((e) => ({ key: e.moduleName, result: e.result as Record<string, unknown> }));

  const cmEntries = new Map<string, Record<string, unknown>>();
  for (const account of accounts) {
    const posArr = Array.isArray(account.positions)
      ? (account.positions as Array<Record<string, unknown>>)
      : [];
    for (const pos of posArr) {
      const symbol = String(pos.symbol ?? pos.ticker ?? "").trim().toUpperCase();
      if (!symbol || cmEntries.has(symbol)) continue;
      const resolved = companyIdentityStore.resolve(
        symbol,
        { companyName: String(pos.name ?? "") },
        cmCandidates
      );
      if (resolved) {
        const entry = analysisRepository.get<Record<string, unknown>>(resolved.key);
        if (entry) {
          cmEntries.set(symbol, entry.result as Record<string, unknown>);
        }
      }
    }
  }

  // ── Current news/event snapshots (for history entry only) ─────────────────
  // These are stored in each history entry so future runs can detect delta.

  const newsEntry  = analysisRepository.get<Record<string, unknown>>("news-monitor");
  const eventEntry = analysisRepository.get<Record<string, unknown>>("event-monitor");

  const currentNewsIds = Array.isArray(newsEntry?.result?.news)
    ? (newsEntry!.result.news as Array<Record<string, unknown>>)
        .map((n) => String(n.id ?? ""))
        .filter(Boolean)
    : [];

  const currentEventTitles = Array.isArray(eventEntry?.result?.events)
    ? (eventEntry!.result.events as Array<Record<string, unknown>>)
        .map((e) => String(e.title ?? ""))
        .filter(Boolean)
    : [];

  // ── Run deterministic Alert Engine (zero OpenAI calls) ────────────────────

  const engineResult = runAlertEngine({
    holdingSymbols,
    cmEntries,
    nowDate,
    repo: analysisRepository,
  });

  const analysisDuration = Date.now() - startTime;
  const engineDebug: AlertEngineDebug = engineResult._engineDebug;

  // ── Validate output against schema ────────────────────────────────────────
  // The engine always produces schema-valid output; a failure here is a bug.

  const parsed = RunMarketAlertsResponse.safeParse({
    overallAlertLevel:     engineResult.overallAlertLevel,
    executiveSummary:      engineResult.executiveSummary,
    headline:              engineResult.headline,
    alerts:                engineResult.alerts,
    thingsToWatch:         engineResult.thingsToWatch,
    nothingImportantChanged: engineResult.nothingImportantChanged,
    timestamp:             nowIso,
    analysisDuration,
  });

  if (!parsed.success) {
    systemLog.logError(MODULE_NAME, "Alert engine produced invalid schema — this is a bug");
    res.status(500).json({
      error: "Alert engine produced an invalid response structure — this is a bug",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      _debug: { engine: engineDebug, aiCalls: 0 },
    });
    return;
  }

  // ── Assign status per alert (New / Updated / Unchanged) ──────────────────
  const alertsWithStatus = parsed.data.alerts.map((alert) => {
    const nk = normalizeAlertKey(alert.title, alert.category);
    let status = computeAlertStatus(
      { normalizedKey: nk, summary: alert.summary, affectedHoldings: alert.affectedHoldings },
      previousAlerts
    );

    // Secondary affectedHoldings check against the STORED market-alerts result.
    // Needed when history entries pre-date the affectedHoldings field (old entries).
    // If the engine produced different holdings than what is currently stored, treat
    // as Updated so the corrected output gets persisted.
    if (status === "Unchanged" && storedAlertsList.length > 0) {
      const storedAlert = storedAlertsList.find((sa) => {
        const saKey = normalizeAlertKey(String(sa.title ?? ""), String(sa.category ?? ""));
        return saKey === nk;
      });
      if (storedAlert) {
        const storedHoldings: string[] = Array.isArray(storedAlert.affectedHoldings)
          ? (storedAlert.affectedHoldings as string[])
          : [];
        const freshHoldings = alert.affectedHoldings ?? [];
        const storedSet = new Set(storedHoldings);
        const freshSet  = new Set(freshHoldings);
        const holdingsChanged =
          storedSet.size !== freshSet.size ||
          [...freshSet].some((t) => !storedSet.has(t));
        if (holdingsChanged) status = "Updated";
      }
    }

    // Override isNew based on actual status comparison (engine always sets true as placeholder)
    return { ...alert, isNew: status === "New", status };
  });

  // ── Identify resolved alerts ──────────────────────────────────────────────
  const currentKeys    = new Set(alertsWithStatus.map((a) => normalizeAlertKey(a.title, a.category)));
  const resolvedAlerts = previousAlerts.filter((p) => !currentKeys.has(p.normalizedKey));

  const existingHistoryEntries = historyEntry?.result?.entries ?? [];

  // ── Determine if this is a meaningful result ──────────────────────────────
  // Meaningful requires:
  //   (a) nothingImportantChanged === false, AND
  //   (b) at least one New or Updated alert that requires attention.
  //
  // Prevents saving as meaningful:
  //   • nothingImportantChanged=true + alerts present → NoChange
  //   • nothingImportantChanged=false + no qualifying alerts → NoChange
  //   • Unchanged-only alerts → NoChange
  const meaningfulAlerts = alertsWithStatus.filter(
    (a) =>
      a.requiresAttention === true &&
      (a.status === "New" || a.status === "Updated")
  );

  const isMeaningful =
    parsed.data.nothingImportantChanged === false &&
    meaningfulAlerts.length > 0;

  // ── MEANINGFUL PATH ───────────────────────────────────────────────────────
  if (isMeaningful) {
    const finalData = {
      ...parsed.data,
      alerts: alertsWithStatus,
      lastCheckedAt:             nowIso,
      lastMeaningfulUpdateAt:    nowIso,
      noNewDevelopmentsSinceLastCheck: false,
    };

    analysisRepository.save("market-alerts", finalData);

    const newHistoryEntry: AlertHistoryEntry = {
      timestamp:       nowIso,
      overallAlertLevel: finalData.overallAlertLevel,
      headline:        finalData.headline,
      alertCount:      alertsWithStatus.length,
      alerts:          alertsWithStatus.map((a) => ({
        title:            a.title,
        category:         a.category,
        importance:       a.importance,
        summary:          a.summary,
        normalizedKey:    normalizeAlertKey(a.title, a.category),
        affectedHoldings: a.affectedHoldings ?? [],
      })),
      newsIds:         currentNewsIds,
      eventTitles:     currentEventTitles,
      checkResult:     "Meaningful",
    };
    analysisRepository.save("market-alerts-history", {
      entries: [newHistoryEntry, ...existingHistoryEntries].slice(0, MAX_HISTORY),
    });

    // System log
    systemLog.logInfo(
      MODULE_NAME,
      `Market alerts completed via deterministic engine (${analysisDuration}ms, change: ${finalData.overallAlertLevel})`
    );

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
    const highestAlert =
      alertsWithStatus.find((a) => a.importance === "High") ?? alertsWithStatus[0];
    if (highestAlert) {
      systemLog.logInternal(
        MODULE_NAME,
        `Highest priority alert: ${highestAlert.title} [${highestAlert.category}]`
      );
    }

    res.json({
      ...finalData,
      _debug: { engine: engineDebug, aiCalls: 0 },
    });
    return;
  }

  // ── NO-CHANGE PATH ────────────────────────────────────────────────────────
  // Do not overwrite the previous meaningful alert result.
  // Load the current stored result and update only the check-metadata fields.
  const storedEntry = analysisRepository.get<Record<string, unknown>>("market-alerts");
  const prevStored  = storedEntry?.result as Record<string, unknown> | undefined;

  const noChangeData: Record<string, unknown> = {
    ...(prevStored ?? { ...parsed.data, alerts: alertsWithStatus }),
    lastCheckedAt:                   nowIso,
    analysisDuration,
    noNewDevelopmentsSinceLastCheck: true,
    lastMeaningfulUpdateAt:          prevStored?.lastMeaningfulUpdateAt ?? undefined,
  };

  analysisRepository.save("market-alerts", noChangeData);

  const noChangeHistoryEntry: AlertHistoryEntry = {
    timestamp:         nowIso,
    overallAlertLevel: String(noChangeData.overallAlertLevel ?? "Low"),
    headline:          String(noChangeData.headline ?? ""),
    alertCount:        0,
    alerts:            [],
    newsIds:           currentNewsIds,
    eventTitles:       currentEventTitles,
    checkResult:       "NoChange",
  };
  analysisRepository.save("market-alerts-history", {
    entries: [noChangeHistoryEntry, ...existingHistoryEntries].slice(0, MAX_HISTORY),
  });

  systemLog.logInfo(
    MODULE_NAME,
    `Market Alerts checked (engine): no new material developments (${analysisDuration}ms, aiCalls=0)`
  );

  res.json({
    ...noChangeData,
    _debug: { engine: engineDebug, aiCalls: 0 },
  });
});

export default router;
