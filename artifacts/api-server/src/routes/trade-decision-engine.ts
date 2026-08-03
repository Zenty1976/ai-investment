/**
 * Trade Decision Engine Route – Phase 2
 *
 * Phase 2 improvements over Phase 1:
 *  - Evidence scoring (internal, never exposed in response)
 *  - Multi-source confirmation gate: PrepareToBuy/PrepareToReduce require ≥2
 *    independent analytical sources — single-source optimism → Review
 *  - Company Monitor v2 field integration (investmentCaseStrength, thesis
 *    statuses, investmentCaseChange, meaningfulChange, keyThingsToWatch)
 *  - Stateful decisions: Strengthened / Weakened / Unchanged in addition to New
 *  - Preservation: Unchanged trade proposals carry forward their original text
 *    and gain a lastValidated timestamp; no repeated identical recommendations
 *  - Staleness detection: stale key analyses downgrade confidence
 *  - Previous decisions injected into the user prompt as context
 *
 * Results:  "trade-decision-engine"
 * History:  "trade-decision-engine-history" (latest 20 entries)
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunTradeDecisionEngineResponse } from "@workspace/api-zod";
import { callAiWithWebSearch, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";
import { companyIdentityStore } from "../lib/company-identity";
import type { RepositoryEntry } from "../lib/analysis-repository.js";

const router: IRouter = Router();

const MODULE_NAME = "Trade Decision Engine";
const MAX_ATTEMPTS = 2;
const MAX_HISTORY = 20;
const ROUTE_TIMEOUT_MS = 190_000;

// ---------------------------------------------------------------------------
// Staleness thresholds (hours)
// ---------------------------------------------------------------------------

const STALE_HOURS: Record<string, number> = {
  "portfolio-manager":  4,
  "risk-analyzer":     48,
  "portfolio-analyzer": 48,
  "market-alerts":     24,
  "opportunity-finder": 72,
  "company-monitor":   72,
  "event-monitor":     72,
  "sector-monitor":   168, // 1 week
};

/** Minimum fresh analytical sources required before a trade proposal is allowed. */
const MIN_TRADE_SOURCES = 2;

/**
 * Module names as returned by OpenAI in sourceModules mapped to their
 * repository keys for freshness lookup.
 */
const SOURCE_TO_REPO_KEY: Record<string, string> = {
  CompanyMonitor:    "company-monitor",   // ticker-specific — resolved per-decision
  RiskAnalyzer:      "risk-analyzer",
  PortfolioAnalyzer: "portfolio-analyzer",
  MarketAlerts:      "market-alerts",
  OpportunityFinder: "opportunity-finder",
  EventMonitor:      "event-monitor",
  SectorMonitor:     "sector-monitor",
  PortfolioManager:  "portfolio-manager",
};

/** Modules that represent independent analytical opinions (used for the gate). */
const GATE_MODULES = new Set([
  "CompanyMonitor",
  "RiskAnalyzer",
  "PortfolioAnalyzer",
  "MarketAlerts",
  "OpportunityFinder",
  "EventMonitor",
  "SectorMonitor",
]);

// ---------------------------------------------------------------------------
// History types
// ---------------------------------------------------------------------------

interface DecisionHistoryDecision {
  normalizedKey:  string;
  subjectType:    string;
  company:        string;
  ticker:         string;
  decision:       string;
  confidence:     string;
  urgency:        string;
  evidenceScore?: number;
}

interface DecisionHistoryEntry {
  timestamp:               string;
  overallDecisionPosture:  string;
  decisionReadinessScore:  number;
  decisions:               DecisionHistoryDecision[];
}

// ---------------------------------------------------------------------------
// Freshness helpers
// ---------------------------------------------------------------------------

function entryAgeHours(entry: RepositoryEntry | undefined): number {
  if (!entry) return Infinity;
  return (Date.now() - new Date(entry.updatedAt).getTime()) / 3_600_000;
}

function isModuleFresh(entry: RepositoryEntry | undefined, maxAgeHours: number): boolean {
  return entryAgeHours(entry) <= maxAgeHours;
}

function formatAge(entry: RepositoryEntry | undefined): string {
  if (!entry) return "missing";
  const h = entryAgeHours(entry);
  if (h < 1)  return `${Math.round(h * 60)}m old`;
  if (h < 24) return `${Math.round(h)}h old`;
  return `${Math.round(h / 24)}d old`;
}

// ---------------------------------------------------------------------------
// Evidence scoring (internal — never exposed in API response)
// ---------------------------------------------------------------------------

interface EvidenceScore {
  /** -100…+100 internal score; positive = case for this trade is strong */
  score:            number;
  supportingModules: string[];
  opposingModules:   string[];
  staleModules:      string[];
}

interface ModuleData {
  cmEntry:          RepositoryEntry | undefined;   // ticker-specific
  riskEntry:        RepositoryEntry | undefined;
  analyzerEntry:    RepositoryEntry | undefined;
  alertsEntry:      RepositoryEntry | undefined;
  opportunityEntry: RepositoryEntry | undefined;
}

function scoreDecisionEvidence(
  decisionType: "PrepareToBuy" | "PrepareToReduce",
  ticker: string,
  data: ModuleData
): EvidenceScore {
  const buy = decisionType === "PrepareToBuy";
  let score = 0;
  const supportingModules: string[] = [];
  const opposingModules:   string[] = [];
  const staleModules:      string[] = [];

  // ── Company Monitor ──────────────────────────────────────────────────────
  const cm = data.cmEntry;
  if (cm) {
    if (!isModuleFresh(cm, STALE_HOURS["company-monitor"])) {
      staleModules.push(`CompanyMonitor (${formatAge(cm)})`);
    } else {
      const r  = data.cmEntry!;
      const rv = r.result as Record<string, unknown>;

      // Rating contribution
      const iv = rv?.investmentView as Record<string, unknown> | null | undefined;
      const rating = String(iv?.rating ?? "");
      const ratingScore = buy
        ? ({ "Strong Buy": 35, "Buy": 25, "Watch": 5, "Avoid": -25, "Strong Avoid": -40 }[rating] ?? 0)
        : ({ "Strong Avoid": 35, "Avoid": 25, "Watch": 5, "Buy": -25, "Strong Buy": -40 }[rating] ?? 0);
      score += ratingScore;
      if (ratingScore > 0) supportingModules.push("CompanyMonitor(rating)");
      if (ratingScore < 0) opposingModules.push("CompanyMonitor(rating)");

      // investmentCaseStrength
      const ics = typeof rv?.investmentCaseStrength === "number" ? rv.investmentCaseStrength : null;
      if (ics !== null) {
        const icsScore = buy
          ? (ics >= 70 ? +10 : ics < 40 ? -15 : 0)
          : (ics < 40  ? +10 : ics >= 70 ? -10 : 0);
        score += icsScore;
        if (icsScore > 0) supportingModules.push("CompanyMonitor(strength)");
        if (icsScore < 0) opposingModules.push("CompanyMonitor(strength)");
      }

      // meaningfulChange on UpdateWithChanges
      const mc         = String(rv?.meaningfulChange ?? "");
      const updateType = String(rv?.updateType ?? "");
      if (mc === "High" && updateType === "UpdateWithChanges") {
        // Direction of change depends on rating
        const caseStrengthened = ratingScore >= 25;
        const mcScore = buy
          ? (caseStrengthened ? +15 : -15)
          : (caseStrengthened ? -15 : +15);
        score += mcScore;
        if (mcScore > 0) supportingModules.push("CompanyMonitor(meaningfulChange)");
        if (mcScore < 0) opposingModules.push("CompanyMonitor(meaningfulChange)");
      }

      // Thesis statuses
      const thesis = Array.isArray(rv?.investmentThesis)
        ? rv.investmentThesis as Array<Record<string, unknown>>
        : [];
      const invalidated = thesis.filter(p => p.status === "Invalidated").length;
      const weakened    = thesis.filter(p => p.status === "Weakened").length;
      if (invalidated > 0) {
        const s = buy ? -25 : +20;
        score += s;
        if (s > 0) supportingModules.push("CompanyMonitor(invalidatedThesis)");
        if (s < 0) opposingModules.push("CompanyMonitor(invalidatedThesis)");
      }
      if (weakened > 0) {
        const s = buy ? Math.max(-15, weakened * -5) : Math.min(+20, weakened * +10);
        score += s;
        if (s > 0) supportingModules.push("CompanyMonitor(weakenedThesis)");
        if (s < 0) opposingModules.push("CompanyMonitor(weakenedThesis)");
      }
    }
  }

  // ── Risk Analyzer ────────────────────────────────────────────────────────
  const risk = data.riskEntry;
  if (risk) {
    if (!isModuleFresh(risk, STALE_HOURS["risk-analyzer"])) {
      staleModules.push(`RiskAnalyzer (${formatAge(risk)})`);
    } else {
      const rr = risk.result as Record<string, unknown>;
      const riskScore = typeof rr?.riskScore === "number" ? rr.riskScore : null;
      if (riskScore !== null) {
        const rs = buy
          ? (riskScore < 40 ? +15 : riskScore <= 60 ? 0 : riskScore <= 75 ? -10 : -20)
          : (riskScore > 75 ? +20 : riskScore > 60 ? +10 : riskScore > 40 ? 0 : -10);
        score += rs;
        if (rs > 0) supportingModules.push("RiskAnalyzer(score)");
        if (rs < 0) opposingModules.push("RiskAnalyzer(score)");
      }

      // Ticker-specific high-severity risks
      const topRisks = Array.isArray(rr?.topRisks)
        ? rr.topRisks as Array<Record<string, unknown>>
        : [];
      const tickerLow = ticker.toLowerCase();
      const highRisksForTicker = topRisks.filter(tr =>
        tr.severity === "High" &&
        Array.isArray(tr.affectedHoldings) &&
        (tr.affectedHoldings as string[]).some(h => h.toLowerCase().includes(tickerLow))
      ).length;
      if (highRisksForTicker > 0) {
        const rs = buy
          ? Math.max(-30, highRisksForTicker * -15)
          : Math.min(+30, highRisksForTicker * +15);
        score += rs;
        if (rs > 0) supportingModules.push("RiskAnalyzer(tickerRisk)");
        if (rs < 0) opposingModules.push("RiskAnalyzer(tickerRisk)");
      }
    }
  }

  // ── Portfolio Analyzer ───────────────────────────────────────────────────
  const analyzer = data.analyzerEntry;
  if (analyzer) {
    if (!isModuleFresh(analyzer, STALE_HOURS["portfolio-analyzer"])) {
      staleModules.push(`PortfolioAnalyzer (${formatAge(analyzer)})`);
    } else {
      const ar = analyzer.result as Record<string, unknown>;
      const comments = Array.isArray(ar?.positionComments)
        ? ar.positionComments as Array<Record<string, unknown>>
        : [];
      const tickerLow = ticker.toLowerCase();
      const comment = comments.find(c =>
        String(c.ticker ?? "").toLowerCase() === tickerLow
      );
      if (comment) {
        const att = comment.attention;
        const as_ = buy
          ? (att === "High" ? -15 : att === "Medium" ? -5 : +5)
          : (att === "High" ? +15 : att === "Medium" ? +5 : -5);
        score += as_;
        if (as_ > 0) supportingModules.push("PortfolioAnalyzer(comment)");
        if (as_ < 0) opposingModules.push("PortfolioAnalyzer(comment)");
      }
    }
  }

  // ── Market Alerts ────────────────────────────────────────────────────────
  const alerts = data.alertsEntry;
  if (alerts) {
    if (!isModuleFresh(alerts, STALE_HOURS["market-alerts"])) {
      staleModules.push(`MarketAlerts (${formatAge(alerts)})`);
    } else {
      const alr = alerts.result as Record<string, unknown>;
      const allAlerts = Array.isArray(alr?.alerts)
        ? alr.alerts as Array<Record<string, unknown>>
        : [];
      const tickerLow = ticker.toLowerCase();
      const highAlertsForTicker = allAlerts.filter(a =>
        a.importance === "High" &&
        Array.isArray(a.affectedHoldings) &&
        (a.affectedHoldings as string[]).some(h => h.toLowerCase().includes(tickerLow))
      ).length;
      if (highAlertsForTicker > 0) {
        const as_ = buy
          ? Math.max(-30, highAlertsForTicker * -15)
          : Math.min(+30, highAlertsForTicker * +10);
        score += as_;
        if (as_ > 0) supportingModules.push("MarketAlerts(tickerAlert)");
        if (as_ < 0) opposingModules.push("MarketAlerts(tickerAlert)");
      }
    }
  }

  // ── Opportunity Finder (buy signals only) ────────────────────────────────
  const opp = data.opportunityEntry;
  if (opp && buy) {
    if (!isModuleFresh(opp, STALE_HOURS["opportunity-finder"])) {
      staleModules.push(`OpportunityFinder (${formatAge(opp)})`);
    } else {
      const or = opp.result as Record<string, unknown>;
      const opps = Array.isArray(or?.topOpportunities)
        ? or.topOpportunities as Array<Record<string, unknown>>
        : [];
      const tickerUp = ticker.toUpperCase();
      const oppRank = opps.findIndex(o =>
        String(o.ticker ?? "").toUpperCase() === tickerUp
      );
      if (oppRank >= 0) {
        const os = oppRank < 2 ? +25 : +15;
        score += os;
        supportingModules.push("OpportunityFinder(rank)");
      }
    }
  }

  return {
    score:    Math.max(-100, Math.min(100, score)),
    supportingModules: [...new Set(supportingModules)],
    opposingModules:   [...new Set(opposingModules)],
    staleModules,
  };
}

// ---------------------------------------------------------------------------
// Multi-source confirmation gate
// ---------------------------------------------------------------------------

/**
 * For each decision, count analytical modules that:
 *  (1) appear in sourceModules (model claims it used them)
 *  (2) have a fresh repository entry
 *  (3) belong to the GATE_MODULES set
 *
 * For CompanyMonitor, we resolve against the specific ticker's CM entry.
 */
function countFreshAnalyticalSources(
  sourceModules: string[],
  tickerCmEntry: RepositoryEntry | undefined,
  globalFreshMap: Map<string, boolean>
): { count: number; freshSources: string[] } {
  const freshSources: string[] = [];
  const seen = new Set<string>();

  for (const src of sourceModules) {
    if (seen.has(src) || !GATE_MODULES.has(src)) continue;
    seen.add(src);

    if (src === "CompanyMonitor") {
      if (tickerCmEntry && isModuleFresh(tickerCmEntry, STALE_HOURS["company-monitor"])) {
        freshSources.push(src);
      }
    } else {
      if (globalFreshMap.get(src) === true) {
        freshSources.push(src);
      }
    }
  }

  return { count: freshSources.length, freshSources };
}

type ParsedDecision = {
  rank:                    number;
  subjectType:             "Holding" | "Opportunity" | "Portfolio";
  company:                 string;
  ticker:                  string;
  decision:                string;
  title:                   string;
  reason:                  string;
  confidence:              string;
  urgency:                 string;
  blockedByEvent:          boolean;
  blockingEvent:           string;
  blockingEventDate:       string;
  supportingEvidence:      string[];
  opposingEvidence:        string[];
  whatWouldChangeDecision: string[];
  missingEvidence:         string[];
  portfolioImpact:         string;
  accountConsiderations:   string;
  sourceModules:           string[];
  targetAllocationPercent?:  number;
  maximumAllocationPercent?: number;
  sizingConfidence?:         "High" | "Medium" | "Low";
  sizingReason?:             string;
  [key: string]: unknown;
};

/**
 * Applies the multi-source confirmation gate.
 *
 * Any PrepareToBuy or PrepareToReduce with < MIN_TRADE_SOURCES fresh analytical
 * sources is downgraded to Review. The sizing fields are cleared on downgrade.
 */
function applyMultiSourceGate(
  decisions:     ParsedDecision[],
  holdingCmKeys: Map<string, string>,
  opCmKeys:      Map<string, string>,
  allCmEntries:  RepositoryEntry[],
  globalFreshMap: Map<string, boolean>
): { decisions: ParsedDecision[]; gateLog: string[] } {
  const gateLog: string[] = [];

  const result = decisions.map(d => {
    if (d.decision !== "PrepareToBuy" && d.decision !== "PrepareToReduce") return d;

    // Resolve the ticker-specific CM entry
    const cmKey = holdingCmKeys.get(d.ticker) ?? opCmKeys.get(d.ticker);
    const tickerCmEntry = cmKey
      ? allCmEntries.find(e => e.moduleName === cmKey)
      : undefined;

    const { count, freshSources } = countFreshAnalyticalSources(
      d.sourceModules,
      tickerCmEntry,
      globalFreshMap
    );

    if (count >= MIN_TRADE_SOURCES) return d; // gate passed

    // Downgrade to Review
    const note =
      `Insufficient multi-source confirmation (${count}/${MIN_TRADE_SOURCES} required ` +
      `analytical sources present — ${freshSources.length > 0 ? freshSources.join(", ") : "none fresh"}). ` +
      `Downgraded from ${d.decision} to Review.`;

    gateLog.push(`[gate] "${d.title}" (${d.ticker || d.company || "portfolio"}): ${note}`);

    return {
      ...d,
      decision: "Review" as const,
      reason: `${d.reason}\n\n[Backend gate] ${note}`,
      missingEvidence: [
        ...d.missingEvidence,
        `Additional independent analyses required before a trade proposal can be issued.`,
      ],
      // Clear sizing fields — not valid on Review decisions
      targetAllocationPercent:  undefined,
      maximumAllocationPercent: undefined,
      sizingConfidence:         undefined,
      sizingReason:             undefined,
    };
  });

  return { decisions: result, gateLog };
}

// ---------------------------------------------------------------------------
// Staleness-based confidence downgrade
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK: Record<string, number> = { High: 3, Medium: 2, Low: 1 };
const RANK_TO_CONFIDENCE: Record<number, string> = { 3: "High", 2: "Medium", 1: "Low" };

function applyStalenessDwongrade(
  decision:      ParsedDecision,
  cmEntry:       RepositoryEntry | undefined,
  riskEntry:     RepositoryEntry | undefined,
  analyzerEntry: RepositoryEntry | undefined,
  alertsEntry:   RepositoryEntry | undefined,
): ParsedDecision {
  if (decision.decision !== "PrepareToBuy" && decision.decision !== "PrepareToReduce") {
    return decision;
  }

  const criticalStale: string[] = [];
  if (!isModuleFresh(cmEntry,       STALE_HOURS["company-monitor"]))   criticalStale.push("CompanyMonitor");
  if (!isModuleFresh(riskEntry,     STALE_HOURS["risk-analyzer"]))     criticalStale.push("RiskAnalyzer");
  if (!isModuleFresh(analyzerEntry, STALE_HOURS["portfolio-analyzer"])) criticalStale.push("PortfolioAnalyzer");
  if (!isModuleFresh(alertsEntry,   STALE_HOURS["market-alerts"]))     criticalStale.push("MarketAlerts");

  if (criticalStale.length === 0) return decision;

  // Downgrade confidence by one step if any critical source is stale
  const curRank    = CONFIDENCE_RANK[decision.confidence] ?? 2;
  const newRank    = Math.max(1, curRank - 1);
  const newConf    = RANK_TO_CONFIDENCE[newRank] ?? "Low";

  const note = `Confidence reduced (${decision.confidence} → ${newConf}) — stale analysis data: ${criticalStale.join(", ")}.`;
  return {
    ...decision,
    confidence:      newConf,
    missingEvidence: [...(decision.missingEvidence ?? []), note],
  };
}

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

const URGENCY_ORDER: Record<string, number> = { Immediate: 0, Days: 1, Weeks: 2, NoUrgency: 3 };

function sortDecisionsByPriority<T extends { urgency: string; confidence: string; rank: number }>(
  decisions: T[]
): T[] {
  return [...decisions].sort((a, b) => {
    const u = (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9);
    if (u !== 0) return u;
    const c = (CONFIDENCE_RANK[a.confidence] ?? 0) - (CONFIDENCE_RANK[b.confidence] ?? 0);
    if (c !== 0) return -c; // descending confidence
    return a.rank - b.rank;
  });
}

function normalizeDecisionKey(
  subjectType: string,
  ticker:      string,
  company:     string,
  decision:    string
): string {
  const subject = (ticker?.trim() || company?.trim() || "portfolio").toLowerCase().trim();
  return `${subjectType.toLowerCase().trim()}|${subject}|${decision.toLowerCase().trim()}`;
}

// ---------------------------------------------------------------------------
// Extended status computation
// ---------------------------------------------------------------------------

type DecisionStatus = "New" | "Strengthened" | "Weakened" | "Unchanged";
// "Withdrawn" is implicit — it is not in the response but logged separately.

const URGENCY_RANK: Record<string, number> = { Immediate: 4, Days: 3, Weeks: 2, NoUrgency: 1 };

function computeExtendedStatus(
  normalizedKey: string,
  confidence:    string,
  urgency:       string,
  previousDecisions: DecisionHistoryDecision[]
): DecisionStatus {
  const prev = previousDecisions.find(p => p.normalizedKey === normalizedKey);
  if (!prev) return "New";

  const sameConf   = prev.confidence === confidence;
  const sameUrgency = prev.urgency   === urgency;
  if (sameConf && sameUrgency) return "Unchanged";

  const prevConfRank   = CONFIDENCE_RANK[prev.confidence] ?? 2;
  const curConfRank    = CONFIDENCE_RANK[confidence]      ?? 2;
  const prevUrgRank    = URGENCY_RANK[prev.urgency]       ?? 1;
  const curUrgRank     = URGENCY_RANK[urgency]            ?? 1;

  const confImproved  = curConfRank > prevConfRank;
  const confDegraded  = curConfRank < prevConfRank;
  const urgIncreased  = curUrgRank  > prevUrgRank;
  const urgDecreased  = curUrgRank  < prevUrgRank;

  if (confImproved || urgIncreased) return "Strengthened";
  if (confDegraded || urgDecreased) return "Weakened";
  return "Unchanged"; // safety fallback
}

// ---------------------------------------------------------------------------
// Readiness computation (server-side, deterministic)
// ---------------------------------------------------------------------------

type ReadinessValue = "WaitingForReevaluation" | "ReadyForReview" | "Informational";

function computeReadiness(d: {
  decision:         string;
  blockedByEvent:   boolean;
  blockingEvent:    string;
  blockingEventDate: string;
  sizingReason?:    string;
  confidence?:      string;
}): { readiness: ReadinessValue; readinessReason: string } {
  const type    = d.decision;
  const blocked = d.blockedByEvent;

  if (type === "Hold" || type === "NoAction") {
    return { readiness: "Informational", readinessReason: "No trade action required for this position." };
  }

  if (type === "WaitForEvent") {
    const event  = blocked && d.blockingEvent ? d.blockingEvent : null;
    const date   = d.blockingEventDate ? ` (${d.blockingEventDate})` : "";
    const reason = event
      ? `Waiting for ${event}${date} — decision cannot be assessed until the event occurs.`
      : "Decision depends on an upcoming event before it can be assessed.";
    return { readiness: "WaitingForReevaluation", readinessReason: reason };
  }

  if (type === "Review") {
    if (blocked) {
      const event  = d.blockingEvent;
      const date   = d.blockingEventDate ? ` (${d.blockingEventDate})` : "";
      const reason = event
        ? `Waiting for ${event}${date} — re-evaluate afterwards.`
        : "Blocked by an upcoming event — re-evaluate afterwards.";
      return { readiness: "WaitingForReevaluation", readinessReason: reason };
    }
    return { readiness: "Informational", readinessReason: "Requires closer manual assessment before a trade decision can be made." };
  }

  if (type === "PrepareToBuy" || type === "PrepareToReduce") {
    if (blocked) {
      const event  = d.blockingEvent;
      const date   = d.blockingEventDate ? ` (${d.blockingEventDate})` : "";
      const reason = event
        ? `Waiting for ${event}${date} — trade must be re-evaluated after the event with new price, risk and sizing data.`
        : "Blocked by an upcoming event — trade must be re-evaluated after the event.";
      return { readiness: "WaitingForReevaluation", readinessReason: reason };
    }
    // Low confidence on a trade proposal → informational pending better evidence
    if (d.confidence === "Low") {
      return {
        readiness: "Informational",
        readinessReason: "Confidence is Low — additional evidence needed before this decision can be actioned.",
      };
    }
    const reason = d.sizingReason?.trim() || "Decision is current and ready for manual review.";
    return { readiness: "ReadyForReview", readinessReason: reason };
  }

  return { readiness: "Informational", readinessReason: "No trade action required." };
}

// ---------------------------------------------------------------------------
// Executable-language guard
// ---------------------------------------------------------------------------

const EXECUTABLE_PATTERNS = [
  /\bbuy\s+now\b/i,
  /\bsell\s+now\b/i,
  /\bexecute\s+(the\s+)?(order|trade|position)\b/i,
  /\bplace\s+(the\s+)?order\b/i,
  /\blimit\s+price\b/i,
  /\b\d+\s+shares?\b/i,
  /\bquantity\s*[:=]\s*\d+/i,
  /\bstop\s+loss\s+at\b/i,
];

function hasExecutableLanguage(d: {
  title: string; reason: string;
  supportingEvidence: string[]; opposingEvidence: string[];
  whatWouldChangeDecision: string[]; missingEvidence: string[];
  portfolioImpact: string; accountConsiderations: string;
}): boolean {
  const textFields = [
    d.title, d.reason, d.portfolioImpact, d.accountConsiderations,
    ...d.supportingEvidence, ...d.opposingEvidence,
    ...d.whatWouldChangeDecision, ...d.missingEvidence,
  ];
  return EXECUTABLE_PATTERNS.some(p => textFields.some(t => p.test(t)));
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an institutional investment decision committee conducting a systematic review of a private investor's portfolio.

Your task is to convert the supplied portfolio analyses into cautious, transparent decision proposals for the next 1–3 months.

ROLE AND BEHAVIOUR:
- Do not simply repeat the input modules. Synthesise and resolve conflicts between them.
- Clearly distinguish facts, expectations and analytical judgement.
- Do not fabricate certainty. When evidence is conflicting or incomplete, prefer Review, WaitForEvent or NoAction.
- Do not create exact order quantities, limit prices or executable instructions.
- Do not recommend deploying all available cash.
- Do not assume a strong opportunity automatically justifies a purchase.
- A decision must not be based on one source alone when other relevant sources are available.
- Consider portfolio fit, concentration, diversification, risk score, upcoming events, existing cash, account currencies, company-specific evidence, latest alerts and evidence freshness.
- Do not recommend holding or acquiring a stock merely to receive a dividend. A dividend may be supporting context only when the underlying investment case independently justifies the decision. Replace decisions such as "Hold through ex-dividend" with a decision based on the actual investment thesis.

ALLOWED DECISION TYPES:
- Hold: Current position remains acceptable, no immediate change proposed.
- Review: Position or opportunity requires closer manual assessment.
- WaitForEvent: Do not decide before a named upcoming event or missing result.
- PrepareToBuy: Candidate may justify a future purchase, but no order is created.
- PrepareToReduce: Existing position may justify reduced exposure, but no order is created.
- NoAction: Available evidence does not justify a change.

Do not use: "buy now", "sell now", "execute", "place order".

MULTI-SOURCE REQUIREMENT — CRITICAL:
PrepareToBuy and PrepareToReduce normally require convergence from at least 2 independent analytical modules. If only one module supports a trade proposal:
- Use Review instead of PrepareToBuy
- Use Review instead of PrepareToReduce
Only escalate to a trade proposal when multiple independent sources confirm the same direction.
sourceModules must list only modules that genuinely provided material evidence for that specific decision.

COMPANY MONITOR V2 INTERPRETATION:
When Company Monitor data is available, pay special attention to these fields:
- investmentCaseStrength (0–100): current conviction score. Use this to calibrate confidence.
- investmentCaseChange.changed / severity: whether the investment case actually changed.
- investmentThesis: each point has a status (Strengthened / Unchanged / Weakened / Invalidated).
  - Invalidated thesis points carry significant weight toward PrepareToReduce.
  - Weakened points reduce confidence in PrepareToBuy proposals.
  - investmentCaseStrength changes should influence confidence, NOT directly trigger trades.
- meaningfulChange (None/Low/Medium/High): server-computed change magnitude.
- updateType: NoMaterialChange means nothing significant changed since the previous analysis.
  - NoMaterialChange with unchanged investmentCaseStrength should rarely generate a new
    PrepareToBuy or PrepareToReduce proposal. Prefer Unchanged or Hold in these cases.
  - UpdateWithChanges with weakened thesis may strengthen a PrepareToReduce proposal.
- keyThingsToWatch: analyst-flagged items requiring monitoring.

PREVIOUS DECISIONS GUIDANCE:
When previous trade decisions are provided, do not re-create decisions that haven't changed.
If a previous PrepareToBuy or PrepareToReduce remains valid and the investment case is unchanged,
return a decision with the same content. The backend preserves unchanged recommendations and only
surfaces materially new or changed decisions to the user.

INFORMATION PRIORITY (use when resolving conflicts):
1. Current portfolio and backend-calculated exposure metrics
2. Risk Analyzer
3. Portfolio Analyzer
4. Market Alerts
5. Company Monitor data (v2 fields take priority over free-text fields)
6. Opportunity Finder
7. Event Monitor
8. Sector Monitor
9. Market Monitor
10. News Monitor
11. Web search (verification only — do not let it replace stored specialist analyses)

DECISION REQUIREMENTS — for each decision state:
- subject, decision type, reason
- supporting evidence (≥1), opposing evidence
- what could change the decision (≥1)
- whether an upcoming event blocks it
- missing information
- confidence (High, Medium, Low) and urgency (Immediate, Days, Weeks, NoUrgency)
- source modules actually used

CONSISTENCY RULES:
- If blockedByEvent is true: blockingEvent must name the event; blockingEventDate must be YYYY-MM-DD or empty string if date is unverified.
- If blockedByEvent is false: blockingEvent and blockingEventDate must be empty strings "".
- company and ticker must be empty strings "" for Portfolio-level decisions.
- sourceModules must list only modules that provided material evidence for that specific decision. Use exactly these values with no spaces: PortfolioManager, PortfolioAnalyzer, RiskAnalyzer, MarketAlerts, CompanyMonitor, OpportunityFinder, EventMonitor, SectorMonitor, MarketMonitor, NewsMonitor, Web.
- Return 3–8 decisions, most important first.
- Return 3–6 readiness drivers.
- Do not create duplicate decisions for the same subject and decision type.
- decisionReadinessScore: integer 0–100 measuring whether evidence is sufficient to make useful decisions — not a prediction of portfolio return.

SIZING GUIDANCE: For every PrepareToBuy and PrepareToReduce decision, include four additional fields to support automated trade sizing. Omit these fields entirely on Hold, Review, WaitForEvent and NoAction decisions.
- targetAllocationPercent (integer 0–100): recommended portfolio weight after the trade.
- maximumAllocationPercent (integer 0–100, must be ≥ targetAllocationPercent): acceptable upper bound.
- sizingConfidence ("High" | "Medium" | "Low"): confidence in the sizing itself.
- sizingReason (string, one sentence maximum): core rationale for this sizing only.

ACCOUNT CONSIDERATIONS: Distinguish precisely: (1) trading/account currency; (2) instrument currency; (3) investor base-currency exposure; (4) underlying company currency exposure. Do not write categorical statements such as "FX neutral". Phase 1 must not select accounts or place orders.

You must perform a web search to verify current information for any decision based on earnings, guidance, legal developments, regulatory decisions, significant price moves, analyst actions or macroeconomic events.

Return JSON only — no markdown, no code fences, no extra text.
Do not include timestamp or analysisDuration — the server sets those.

Return exactly:
{"mainConclusion":{"title":"…","reason":"…"},"executiveSummary":"…","overallDecisionPosture":"ActivelyReview|SelectivePreparation|WaitForEvents|MaintainCurrentPositioning|InsufficientEvidence","decisionReadinessScore":0,"readinessDrivers":[{"factor":"…","impact":"Positive|Negative","reason":"…"}],"decisions":[{"rank":1,"subjectType":"Holding|Opportunity|Portfolio","company":"…","ticker":"…","decision":"Hold|Review|WaitForEvent|PrepareToBuy|PrepareToReduce|NoAction","title":"…","reason":"…","supportingEvidence":["…"],"opposingEvidence":["…"],"confidence":"High|Medium|Low","urgency":"Immediate|Days|Weeks|NoUrgency","blockedByEvent":false,"blockingEvent":"","blockingEventDate":"","whatWouldChangeDecision":["…"],"missingEvidence":["…"],"portfolioImpact":"…","accountConsiderations":"…","sourceModules":["PortfolioManager"],"targetAllocationPercent":5,"maximumAllocationPercent":7,"sizingConfidence":"Medium","sizingReason":"…"}],"conflictsResolved":[{"topic":"…","conflict":"…","resolution":"…"}],"nextReviewTriggers":[{"trigger":"…","date":"YYYY-MM-DD or empty string","affectedDecisions":["decision title"]}]}

Include targetAllocationPercent, maximumAllocationPercent, sizingConfidence and sizingReason only on PrepareToBuy and PrepareToReduce decisions. Omit all four fields on Hold, Review, WaitForEvent and NoAction decisions.`;

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/trade-decision-engine/analyze", async (req, res): Promise<void> => {
  const orchestratorTrigger = req.headers["x-orchestrator-trigger"];
  if (orchestratorTrigger) {
    systemLog.logInfo(MODULE_NAME, `Scheduled run (trigger: ${orchestratorTrigger})`);
  } else {
    systemLog.logUser(MODULE_NAME, "User manually started decision analysis");
  }

  const startTime = Date.now();
  const nowIso    = new Date().toISOString();
  const nowDate   = new Date(nowIso);
  let lastDebug: AiDebugInfo | undefined;

  // ── Route safety timeout ─────────────────────────────────────────────────
  let routeTimedOut = false;
  const routeTimeoutHandle = setTimeout(() => {
    routeTimedOut = true;
    systemLog.logError(MODULE_NAME, "Decision analysis timed out");
    if (!res.headersSent) {
      res.status(504).json({
        error: "Trade Decision Engine timed out — analysis took too long",
        _debug: lastDebug,
      });
    }
  }, ROUTE_TIMEOUT_MS);

  // ── Load all module entries ──────────────────────────────────────────────
  const portfolioEntry  = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  const analyzerEntry   = analysisRepository.get<Record<string, unknown>>("portfolio-analyzer");
  const riskEntry       = analysisRepository.get<Record<string, unknown>>("risk-analyzer");
  const alertsEntry     = analysisRepository.get<Record<string, unknown>>("market-alerts");
  const eventEntry      = analysisRepository.get<Record<string, unknown>>("event-monitor");
  const newsEntry       = analysisRepository.get<Record<string, unknown>>("news-monitor");
  const sectorEntry     = analysisRepository.get<Record<string, unknown>>("sector-monitor");
  const marketEntry     = analysisRepository.get<Record<string, unknown>>("market-monitor");
  const opportunityEntry = analysisRepository.get<Record<string, unknown>>("opportunity-finder");

  const allRepoEntries = analysisRepository.getAll();

  // Company-monitor entries
  const allCmEntries = allRepoEntries.filter(e => e.moduleName.startsWith("company-monitor:"));
  const cmCandidates = allCmEntries.map(e => ({
    key:    e.moduleName,
    result: e.result as Record<string, unknown>,
  }));

  // ── Load previous full TDE result for preservation ───────────────────────
  const prevTdeEntry = analysisRepository.get<Record<string, unknown>>("trade-decision-engine");
  const prevFullDecisions: Array<Record<string, unknown>> = Array.isArray(prevTdeEntry?.result?.decisions)
    ? (prevTdeEntry!.result.decisions as Array<Record<string, unknown>>)
    : [];

  // Build lookup: normalizedKey → previous full decision object
  const prevDecisionByKey = new Map<string, Record<string, unknown>>();
  for (const d of prevFullDecisions) {
    const nk = normalizeDecisionKey(
      String(d.subjectType ?? ""), String(d.ticker ?? ""),
      String(d.company ?? ""),    String(d.decision ?? "")
    );
    prevDecisionByKey.set(nk, d);
  }

  // ── Fresh module map (for multi-source gate) ─────────────────────────────
  const globalFreshMap = new Map<string, boolean>([
    ["RiskAnalyzer",      isModuleFresh(riskEntry,        STALE_HOURS["risk-analyzer"])],
    ["PortfolioAnalyzer", isModuleFresh(analyzerEntry,    STALE_HOURS["portfolio-analyzer"])],
    ["MarketAlerts",      isModuleFresh(alertsEntry,      STALE_HOURS["market-alerts"])],
    ["OpportunityFinder", isModuleFresh(opportunityEntry, STALE_HOURS["opportunity-finder"])],
    ["EventMonitor",      isModuleFresh(eventEntry,       STALE_HOURS["event-monitor"])],
    ["SectorMonitor",     isModuleFresh(sectorEntry,      STALE_HOURS["sector-monitor"])],
    ["PortfolioManager",  isModuleFresh(portfolioEntry,   STALE_HOURS["portfolio-manager"])],
  ]);

  // ── Warnings ─────────────────────────────────────────────────────────────
  if (portfolioEntry?.result?.isMockData) {
    systemLog.logWarning(MODULE_NAME, "Using mock portfolio data — decisions reflect simulated positions only");
  }

  const missingModules: string[] = [];
  if (!portfolioEntry) missingModules.push("Portfolio Manager");
  if (!riskEntry)      missingModules.push("Risk Analyzer");
  if (!analyzerEntry)  missingModules.push("Portfolio Analyzer");
  if (!alertsEntry)    missingModules.push("Market Alerts");
  if (missingModules.length > 0) {
    systemLog.logWarning(MODULE_NAME, `Required analysis context unavailable: ${missingModules.join(", ")}`);
  }

  // Stale module warnings
  const staleWarnings: string[] = [];
  if (riskEntry      && !isModuleFresh(riskEntry,      STALE_HOURS["risk-analyzer"]))      staleWarnings.push(`RiskAnalyzer (${formatAge(riskEntry)})`);
  if (analyzerEntry  && !isModuleFresh(analyzerEntry,  STALE_HOURS["portfolio-analyzer"]))  staleWarnings.push(`PortfolioAnalyzer (${formatAge(analyzerEntry)})`);
  if (alertsEntry    && !isModuleFresh(alertsEntry,    STALE_HOURS["market-alerts"]))        staleWarnings.push(`MarketAlerts (${formatAge(alertsEntry)})`);
  if (staleWarnings.length > 0) {
    systemLog.logWarning(MODULE_NAME, `Stale analysis data: ${staleWarnings.join(", ")} — confidence may be downgraded`);
  }

  // ── Portfolio data ───────────────────────────────────────────────────────
  const portfolioResult = portfolioEntry?.result as Record<string, unknown> | undefined;
  const accounts = Array.isArray(portfolioResult?.accounts)
    ? (portfolioResult!.accounts as Array<Record<string, unknown>>)
    : [];

  const baseCurrency       = typeof portfolioResult?.baseCurrency    === "string" ? portfolioResult.baseCurrency    : "Unknown";
  const totalValue         = typeof portfolioResult?.totalValue       === "number" ? portfolioResult.totalValue       : null;
  const totalAvailableCash = typeof portfolioResult?.totalAvailableCash === "number" ? portfolioResult.totalAvailableCash : null;

  const allPositions: Array<{
    ticker: string; name: string;
    marketValueBaseCurrency: number; currency: string;
    accountCurrency: string; accountName: string;
    quantity: number; unrealizedPnL: number;
  }> = [];

  for (const acc of accounts) {
    const posArr = Array.isArray(acc.positions)
      ? (acc.positions as Array<Record<string, unknown>>)
      : [];
    for (const pos of posArr) {
      allPositions.push({
        ticker:                  String(pos.symbol ?? "").toUpperCase(),
        name:                    String(pos.name ?? ""),
        marketValueBaseCurrency: typeof pos.marketValueBaseCurrency === "number" ? pos.marketValueBaseCurrency : 0,
        currency:                String(pos.currency ?? ""),
        accountCurrency:         String(acc.currency ?? ""),
        accountName:             String(acc.accountName ?? ""),
        quantity:                typeof pos.quantity === "number" ? pos.quantity : 0,
        unrealizedPnL:           typeof pos.unrealizedProfitLoss === "number" ? pos.unrealizedProfitLoss : 0,
      });
    }
  }

  // ── Company Monitor identity resolution ──────────────────────────────────
  const holdingCmKeys = new Map<string, string>();
  for (const pos of allPositions) {
    const resolved = companyIdentityStore.resolve(pos.ticker, { companyName: pos.name }, cmCandidates);
    if (resolved) holdingCmKeys.set(pos.ticker, resolved.key);
  }

  const opCmKeys = new Map<string, string>();
  const rawOpportunities = Array.isArray(opportunityEntry?.result?.topOpportunities)
    ? (opportunityEntry!.result.topOpportunities as Array<Record<string, unknown>>).slice(0, 5)
    : [];
  for (const o of rawOpportunities) {
    const ticker = String(o.ticker ?? "").toUpperCase();
    if (!ticker || holdingCmKeys.has(ticker)) continue;
    const resolved = companyIdentityStore.resolve(ticker, {}, cmCandidates);
    if (resolved) opCmKeys.set(ticker, resolved.key);
  }

  const relevantCmKeys = new Set([...holdingCmKeys.values(), ...opCmKeys.values()]);

  // ── Decision profile ─────────────────────────────────────────────────────
  const totalInvested   = allPositions.reduce((s, p) => s + p.marketValueBaseCurrency, 0);
  const baseForWeights  = totalValue ?? totalInvested;
  const cashPct         = baseForWeights > 0 && totalAvailableCash != null
    ? Math.round((totalAvailableCash / baseForWeights) * 1000) / 10
    : null;

  const positionsWithWeights = allPositions
    .map(p => ({
      ...p,
      weightOfTotal:     baseForWeights > 0 ? Math.round((p.marketValueBaseCurrency / baseForWeights) * 1000) / 10 : 0,
      weightOfInvested:  totalInvested > 0  ? Math.round((p.marketValueBaseCurrency / totalInvested)  * 1000) / 10 : 0,
      hasCompanyMonitor: holdingCmKeys.has(p.ticker),
    }))
    .sort((a, b) => b.weightOfTotal - a.weightOfTotal);

  const cashByCurrency: Record<string, number> = {};
  for (const acc of accounts) {
    const ccy  = String(acc.currency ?? "");
    const cash = typeof acc.availableCash === "number" ? acc.availableCash : 0;
    if (ccy) cashByCurrency[ccy] = (cashByCurrency[ccy] ?? 0) + cash;
  }

  const in14DaysMs     = nowDate.getTime() + 14 * 24 * 60 * 60 * 1000;
  const upcomingEvents: Array<Record<string, unknown>> = [];
  if (Array.isArray(eventEntry?.result?.events)) {
    for (const ev of eventEntry!.result.events as Array<Record<string, unknown>>) {
      if (!ev.date) continue;
      const evMs = new Date(String(ev.date)).getTime();
      if (!isNaN(evMs) && evMs >= nowDate.getTime() && evMs <= in14DaysMs && ev.importance !== "Low") {
        upcomingEvents.push({ title: ev.title, date: ev.date, importance: ev.importance });
      }
    }
  }

  const topOpportunityCandidates = Array.isArray(opportunityEntry?.result?.topOpportunities)
    ? (opportunityEntry!.result.topOpportunities as Array<Record<string, unknown>>)
        .slice(0, 5)
        .map(o => ({
          rank: o.rank, ticker: o.ticker, company: o.company, sector: o.sector,
          confidence: o.confidence, priority: o.priority, mainCatalyst: o.mainCatalyst,
          hasCompanyMonitor:
            holdingCmKeys.has(String(o.ticker ?? "").toUpperCase()) ||
            opCmKeys.has(String(o.ticker ?? "").toUpperCase()),
        }))
    : [];

  const riskScore     = typeof riskEntry?.result?.riskScore     === "number" ? riskEntry.result.riskScore     : null;
  const prevRiskScore = typeof riskEntry?.result?.previousRiskScore === "number" ? riskEntry.result.previousRiskScore : null;

  const decisionProfile = {
    generatedAt: nowIso,
    baseCurrency,
    isMockData:              portfolioEntry?.result?.isMockData ?? false,
    totalPortfolioValue:     totalValue,
    totalAvailableCash,
    cashPercentage:          cashPct,
    totalInvestedValue:      Math.round(totalInvested),
    cashByCurrency,
    largestHolding:          positionsWithWeights[0]
      ? { ticker: positionsWithWeights[0].ticker, weightOfTotal: positionsWithWeights[0].weightOfTotal,
          marketValueBaseCurrency: Math.round(positionsWithWeights[0].marketValueBaseCurrency) }
      : null,
    positions: positionsWithWeights.map(p => ({
      ticker: p.ticker, name: p.name,
      marketValueBaseCurrency: Math.round(p.marketValueBaseCurrency),
      instrumentCurrency: p.currency, accountCurrency: p.accountCurrency, accountName: p.accountName,
      quantity: p.quantity, unrealizedPnL: Math.round(p.unrealizedPnL),
      weightOfTotal: p.weightOfTotal, weightOfInvested: p.weightOfInvested,
      hasCompanyMonitor: p.hasCompanyMonitor,
    })),
    riskScore,
    previousRiskScore:       prevRiskScore,
    riskScoreChange:         riskScore != null && prevRiskScore != null ? riskScore - prevRiskScore : null,
    riskLevel:               riskEntry?.result?.overallRiskLevel ?? null,
    portfolioScore:          analyzerEntry?.result?.portfolioScore ?? null,
    portfolioOutlook:        analyzerEntry?.result?.overallOutlook ?? null,
    alertLevel:              alertsEntry?.result?.overallAlertLevel ?? null,
    alertHeadline:           alertsEntry?.result?.headline ?? null,
    upcomingHighImportanceEvents: upcomingEvents,
    topOpportunityCandidates,
    positionsWithCompanyMonitorData:    positionsWithWeights.filter(p =>  p.hasCompanyMonitor).map(p => p.ticker),
    positionsMissingCompanyMonitorData: positionsWithWeights.filter(p => !p.hasCompanyMonitor).map(p => p.ticker),
    // Staleness summary for OpenAI context awareness
    moduleDataFreshness: {
      riskAnalyzer:      riskEntry      ? `${Math.round(entryAgeHours(riskEntry))}h old`      : "missing",
      portfolioAnalyzer: analyzerEntry  ? `${Math.round(entryAgeHours(analyzerEntry))}h old`  : "missing",
      marketAlerts:      alertsEntry    ? `${Math.round(entryAgeHours(alertsEntry))}h old`    : "missing",
      opportunityFinder: opportunityEntry ? `${Math.round(entryAgeHours(opportunityEntry))}h old` : "missing",
    },
  };

  // ── Module contexts ──────────────────────────────────────────────────────
  const riskContext = riskEntry ? JSON.stringify({
    overallRiskLevel:   riskEntry.result.overallRiskLevel,
    riskScore:          riskEntry.result.riskScore,
    previousRiskScore:  riskEntry.result.previousRiskScore,
    mainConclusion:     riskEntry.result.mainConclusion,
    topRisks:           riskEntry.result.topRisks,
    riskInteractions:   riskEntry.result.riskInteractions,
    watchClosely:       riskEntry.result.watchClosely,
    updatedAt:          riskEntry.updatedAt,
  }) : null;

  const analyzerContext = analyzerEntry ? JSON.stringify({
    mainConclusion:     analyzerEntry.result.mainConclusion,
    executiveSummary:   analyzerEntry.result.executiveSummary,
    overallRating:      analyzerEntry.result.overallRating,
    overallOutlook:     analyzerEntry.result.overallOutlook,
    portfolioScore:     analyzerEntry.result.portfolioScore,
    strengths:          analyzerEntry.result.strengths,
    weaknesses:         analyzerEntry.result.weaknesses,
    topRisks:           analyzerEntry.result.topRisks,
    topOpportunities:   analyzerEntry.result.topOpportunities,
    recommendedActions: analyzerEntry.result.recommendedActions,
    sectorAssessment:   analyzerEntry.result.sectorAssessment,
    positionComments:   analyzerEntry.result.positionComments,
    updatedAt:          analyzerEntry.updatedAt,
  }) : null;

  const alertsContext = alertsEntry ? JSON.stringify({
    overallAlertLevel:   alertsEntry.result.overallAlertLevel,
    headline:            alertsEntry.result.headline,
    executiveSummary:    alertsEntry.result.executiveSummary,
    alerts:              alertsEntry.result.alerts,
    thingsToWatch:       alertsEntry.result.thingsToWatch,
    updatedAt:           alertsEntry.updatedAt,
  }) : null;

  const opportunityContext = opportunityEntry ? JSON.stringify({
    executiveSummary:        opportunityEntry.result.executiveSummary,
    overallOpportunityLevel: opportunityEntry.result.overallOpportunityLevel,
    topOpportunities:        Array.isArray(opportunityEntry.result.topOpportunities)
      ? (opportunityEntry.result.topOpportunities as Array<Record<string, unknown>>)
          .slice(0, 5)
          .map(o => ({
            rank: o.rank, company: o.company, ticker: o.ticker, sector: o.sector,
            overallScore: o.overallScore, confidence: o.confidence, priority: o.priority,
            investmentThesis: o.investmentThesis, whyNow: o.whyNow, whyThisPortfolio: o.whyThisPortfolio,
            mainCatalyst: o.mainCatalyst, mainRisk: o.mainRisk,
            companyAnalysisAvailable: o.companyAnalysisAvailable,
            positionSizeSuitability: o.positionSizeSuitability, positionSizeReason: o.positionSizeReason,
          }))
      : [],
    sectorIdeas: opportunityEntry.result.sectorIdeas,
    updatedAt:   opportunityEntry.updatedAt,
  }) : null;

  const eventContext = eventEntry ? JSON.stringify({
    summary:        eventEntry.result.summary,
    nextMajorEvent: eventEntry.result.nextMajorEvent,
    events:         Array.isArray(eventEntry.result.events)
      ? (eventEntry.result.events as Array<Record<string, unknown>>).map(e => ({
          title: e.title, date: e.date, importance: e.importance,
          expectedImpact: e.expectedImpact, category: e.category,
        }))
      : [],
    updatedAt: eventEntry.updatedAt,
  }) : null;

  const sectorContext = sectorEntry ? JSON.stringify({
    executiveSummary: sectorEntry.result.executiveSummary,
    overallOutlook:   sectorEntry.result.overallOutlook,
    sectors:          Array.isArray(sectorEntry.result.sectors)
      ? (sectorEntry.result.sectors as Array<Record<string, unknown>>).map(s => ({
          name: s.name, rating: s.rating, trend: s.trend, summary: s.summary,
        }))
      : [],
    updatedAt: sectorEntry.updatedAt,
  }) : null;

  const marketContext = marketEntry ? JSON.stringify({
    marketSentiment:  marketEntry.result.marketSentiment,
    riskLevel:        marketEntry.result.riskLevel,
    summary:          marketEntry.result.summary,
    positiveFactors:  marketEntry.result.positiveFactors,
    negativeFactors:  marketEntry.result.negativeFactors,
    keyRisks:         marketEntry.result.keyRisks,
    updatedAt:        marketEntry.updatedAt,
  }) : null;

  const newsContext = newsEntry ? JSON.stringify({
    executiveSummary:     newsEntry.result.executiveSummary,
    overallMarketImpact:  newsEntry.result.overallMarketImpact,
    topStory:             newsEntry.result.topStory,
    news:                 Array.isArray(newsEntry.result.news)
      ? (newsEntry.result.news as Array<Record<string, unknown>>).slice(0, 5).map(n => ({
          title: n.title, category: n.category, importance: n.importance,
          whyItMatters: n.whyItMatters, marketImpact: n.marketImpact,
        }))
      : [],
    updatedAt: newsEntry.updatedAt,
  }) : null;

  // Company Monitor context — include full v2 fields
  const relevantCmEntries = allCmEntries.filter(e => relevantCmKeys.has(e.moduleName));

  const companyContextLines = relevantCmEntries.map(e => {
    const result = e.result as Record<string, unknown>;
    const matchedTickers = [
      ...[...holdingCmKeys.entries()].filter(([, key]) => key === e.moduleName).map(([t]) => t),
      ...[...opCmKeys.entries()].filter(([, key]) => key === e.moduleName).map(([t]) => t),
    ];
    const matchLabel = matchedTickers.join("/") || e.moduleName.replace("company-monitor:", "");

    // Compact thesis representation: only IDs + statuses (full text wastes tokens)
    const thesisSummary = Array.isArray(result.investmentThesis)
      ? (result.investmentThesis as Array<Record<string, unknown>>).map(p => ({
          id:     p.id,
          status: p.status,
        }))
      : [];

    return `COMPANY MONITOR — ${matchLabel} (updated: ${e.updatedAt}, freshness: ${formatAge(e)}):\n${JSON.stringify({
      company:                result.company,
      updateType:             result.updateType,
      investmentView:         result.investmentView,
      investmentCaseStrength: result.investmentCaseStrength,
      investmentCaseChange:   result.investmentCaseChange,
      investmentThesis:       thesisSummary,
      meaningfulChange:       result.meaningfulChange,
      executiveSummary:       result.executiveSummary,
      currentSituation:       result.currentSituation,
      catalysts:              result.catalysts,
      risks:                  result.risks,
      earningsAndGuidance:    result.earningsAndGuidance,
      competitivePosition:    result.competitivePosition,
      valuationAssessment:    result.valuationAssessment,
      bullCase:               result.bullCase,
      baseCase:               result.baseCase,
      bearCase:               result.bearCase,
      keyThingsToWatch:       result.keyThingsToWatch,
      confidence:             result.confidence,
    })}`;
  }).join("\n\n");

  // ── History (for status computation) ────────────────────────────────────
  const historyEntry = analysisRepository.get<{ entries: DecisionHistoryEntry[] }>(
    "trade-decision-engine-history"
  );
  const previousDecisions: DecisionHistoryDecision[] =
    historyEntry?.result?.entries?.[0]?.decisions ?? [];

  // ── Previous decisions context for user prompt ───────────────────────────
  const prevDecisionsSummary =
    prevFullDecisions.length > 0
      ? prevFullDecisions.map(d => ({
          ticker:    d.ticker,
          company:   d.company,
          decision:  d.decision,
          title:     d.title,
          confidence: d.confidence,
          urgency:   d.urgency,
          status:    d.status,
        }))
      : null;

  // ── User prompt ──────────────────────────────────────────────────────────
  const addCtx = (label: string, ctx: string | null, sections: string[]) => {
    sections.push(ctx ? `\n${label}:\n${ctx}` : `\n${label}: Not available.`);
  };

  const userPromptSections: string[] = [
    `ANALYSIS DATE: ${nowIso}`,
    `\nBACKEND DECISION PROFILE (server-calculated — treat as highest-priority input):\n${JSON.stringify(decisionProfile, null, 2)}`,
  ];

  addCtx("RISK ANALYZER (priority 2)",      riskContext,      userPromptSections);
  addCtx("PORTFOLIO ANALYZER (priority 3)", analyzerContext,  userPromptSections);
  addCtx("MARKET ALERTS (priority 4)",      alertsContext,    userPromptSections);

  if (companyContextLines) {
    userPromptSections.push(`\nCOMPANY MONITOR DATA (priority 5 — includes v2 fields):\n${companyContextLines}`);
  } else {
    userPromptSections.push(`\nCOMPANY MONITOR DATA (priority 5): None available. Treat this as missing evidence for every holding.`);
  }

  addCtx("OPPORTUNITY FINDER (priority 6)", opportunityContext, userPromptSections);
  addCtx("EVENT MONITOR (priority 7)",      eventContext,      userPromptSections);
  addCtx("SECTOR MONITOR (priority 8)",     sectorContext,     userPromptSections);
  addCtx("MARKET MONITOR (priority 9)",     marketContext,     userPromptSections);
  addCtx("NEWS MONITOR (priority 10)",      newsContext,       userPromptSections);

  if (prevDecisionsSummary) {
    userPromptSections.push(
      `\nPREVIOUS TRADE DECISIONS (from ${prevTdeEntry?.updatedAt ?? "unknown"}):\n` +
      JSON.stringify(prevDecisionsSummary, null, 2) +
      `\n\nGUIDELINE: Only generate decisions that are new or materially changed. ` +
      `If a previous PrepareToBuy or PrepareToReduce remains valid with unchanged evidence, ` +
      `return it with the same content — the backend will preserve the original recommendation.`
    );
  }

  userPromptSections.push(
    `\nTask: Based on all the above, produce 3–8 cautious decision proposals for the next 1–3 months. ` +
    `Resolve conflicts between modules. Use web search to verify current information for time-sensitive decisions. ` +
    `Remember the multi-source requirement: PrepareToBuy and PrepareToReduce require ≥2 independent analytical sources.`
  );

  const userPrompt = userPromptSections.join("\n");

  // ── Retry loop ────────────────────────────────────────────────────────────
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (routeTimedOut || res.headersSent) break;

    try {
      const { result, debug } = await callAiWithWebSearch(
        SYSTEM_PROMPT,
        userPrompt,
        { model: "gpt-4o", maxTokens: 6000, temperature: 0.1 }
      );

      if (res.headersSent) { clearTimeout(routeTimeoutHandle); return; }

      const analysisDuration = Date.now() - startTime;
      lastDebug = debug;

      // Normalize sourceModules (strip spaces)
      const rawResult = result as Record<string, unknown>;
      const normalizedResult: Record<string, unknown> = {
        ...rawResult,
        decisions: Array.isArray(rawResult.decisions)
          ? rawResult.decisions.map(d => {
              if (!d || typeof d !== "object") return d;
              const dec = d as Record<string, unknown>;
              return {
                ...dec,
                sourceModules: Array.isArray(dec.sourceModules)
                  ? dec.sourceModules.map(m => typeof m === "string" ? m.replace(/\s+/g, "") : m)
                  : dec.sourceModules,
              };
            })
          : rawResult.decisions,
      };

      // Schema validation
      const parsed = RunTradeDecisionEngineResponse.safeParse({
        ...normalizedResult,
        timestamp: nowIso,
        analysisDuration,
      });
      if (!parsed.success) {
        throw new Error(
          `Schema validation failed: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        );
      }

      // Executable language guard
      const badDecisions = parsed.data.decisions.filter(hasExecutableLanguage);
      if (badDecisions.length > 0) {
        throw new Error(`Prohibited executable language in: ${badDecisions.map(d => d.title).join("; ")}`);
      }

      // Stale WaitForEvent guard
      const staleWaitFor = parsed.data.decisions.filter(d => {
        if (d.decision !== "WaitForEvent") return false;
        if (!d.blockedByEvent || !d.blockingEventDate) return false;
        const evDate = new Date(d.blockingEventDate);
        return !isNaN(evDate.getTime()) && evDate < nowDate;
      });
      if (staleWaitFor.length > 0) {
        throw new Error(
          `WaitForEvent decision(s) reference past blocking events: ` +
          staleWaitFor.map(d => `"${d.title}" (${d.blockingEventDate})`).join("; ")
        );
      }

      // ── MULTI-SOURCE GATE ──────────────────────────────────────────────
      const { decisions: gatedDecisions, gateLog } =
        applyMultiSourceGate(
          parsed.data.decisions as unknown as ParsedDecision[],
          holdingCmKeys,
          opCmKeys,
          allCmEntries,
          globalFreshMap
        );

      for (const msg of gateLog) {
        systemLog.logInternal(MODULE_NAME, msg);
      }

      // Sizing validation (only on decisions that survived the gate as Prepare*)
      const missingSizing = gatedDecisions.filter(d => {
        if (d.decision !== "PrepareToBuy" && d.decision !== "PrepareToReduce") return false;
        if (d.blockedByEvent === true) return false;
        const target = d.targetAllocationPercent as number | undefined;
        const max    = d.maximumAllocationPercent as number | undefined;
        const conf   = d.sizingConfidence as string | undefined;
        const reason = (d.sizingReason as string ?? "").trim();
        return (
          typeof target !== "number" || target <= 0 ||
          typeof max    !== "number" || max < target ||
          !["High", "Medium", "Low"].includes(conf ?? "") ||
          reason === ""
        );
      });
      if (missingSizing.length > 0) {
        throw new Error(
          `Trade-producing decision(s) missing valid sizing fields — retry required: ` +
          missingSizing.map(d => `"${d.title}" (${d.ticker})`).join("; ")
        );
      }

      // Clear stale blocking flags on non-WaitForEvent decisions
      const clearedDecisions = gatedDecisions.map(d => {
        if (d.blockedByEvent && d.blockingEventDate) {
          const evDate = new Date(d.blockingEventDate);
          if (!isNaN(evDate.getTime()) && evDate < nowDate) {
            return { ...d, blockedByEvent: false, blockingEvent: "", blockingEventDate: "" };
          }
        }
        return d;
      });

      // Filter past nextReviewTriggers
      const filteredTriggers = parsed.data.nextReviewTriggers.filter(t => {
        if (!t.date) return true;
        const trigDate = new Date(t.date);
        return isNaN(trigDate.getTime()) || trigDate >= nowDate;
      });

      // Sort → dedup → rerank
      const sorted  = sortDecisionsByPriority(clearedDecisions);
      const seenKeys = new Set<string>();
      const deduped  = sorted.filter(d => {
        const k = normalizeDecisionKey(d.subjectType, d.ticker, d.company, d.decision);
        if (seenKeys.has(k)) return false;
        seenKeys.add(k);
        return true;
      });
      const reranked = deduped.map((d, i) => ({ ...d, rank: i + 1 }));

      // ── Extended status ───────────────────────────────────────────────
      type D = (typeof reranked)[0];
      type DWithMeta = D & {
        _normalizedKey:    string;
        _status:           DecisionStatus;
        _evidenceScore?:   EvidenceScore;
      };

      const decisionsWithMeta: DWithMeta[] = reranked.map(d => {
        const nk     = normalizeDecisionKey(d.subjectType, d.ticker, d.company, d.decision);
        const status = computeExtendedStatus(nk, d.confidence, d.urgency, previousDecisions);

        // Evidence scoring for trade proposals (internal only)
        let evScore: EvidenceScore | undefined;
        if (d.decision === "PrepareToBuy" || d.decision === "PrepareToReduce") {
          const cmKey   = holdingCmKeys.get(d.ticker) ?? opCmKeys.get(d.ticker);
          const cmEntry = cmKey ? allCmEntries.find(e => e.moduleName === cmKey) : undefined;
          evScore = scoreDecisionEvidence(
            d.decision as "PrepareToBuy" | "PrepareToReduce",
            d.ticker,
            { cmEntry, riskEntry, analyzerEntry, alertsEntry, opportunityEntry }
          );
        }

        return { ...d, _normalizedKey: nk, _status: status, _evidenceScore: evScore };
      });

      // ── Staleness downgrade ─────────────────────────────────────────────
      const withStaleness = decisionsWithMeta.map(d => {
        const cmKey   = holdingCmKeys.get(d.ticker) ?? opCmKeys.get(d.ticker);
        const cmEntry = cmKey ? allCmEntries.find(e => e.moduleName === cmKey) : undefined;
        const downgraded = applyStalenessDwongrade(
          d as unknown as ParsedDecision,
          cmEntry, riskEntry, analyzerEntry, alertsEntry
        );
        return { ...d, ...downgraded };
      });

      // ── Track withdrawn decisions ────────────────────────────────────────
      const currentKeys = new Set(withStaleness.map(d => d._normalizedKey));
      const resolvedDecisions = previousDecisions.filter(p => !currentKeys.has(p.normalizedKey));

      // ── Build response decisions (with preservation) ─────────────────────
      const responseDecisions = withStaleness.map(d => {
        const { _normalizedKey: nk, _status: status, _evidenceScore: evScore, ...rest } = d;

        const { readiness, readinessReason } = computeReadiness(rest as Parameters<typeof computeReadiness>[0]);

        // Preserve Unchanged Prepare* decisions — use previous text, update metadata
        if (
          status === "Unchanged" &&
          (rest.decision === "PrepareToBuy" || rest.decision === "PrepareToReduce")
        ) {
          const prev = prevDecisionByKey.get(nk);
          if (prev) {
            return {
              // Preserved content from previous run
              rank:                  rest.rank,          // updated rank
              subjectType:           rest.subjectType,
              company:               String(prev.company ?? rest.company),
              ticker:                String(prev.ticker  ?? rest.ticker),
              decision:              rest.decision,
              title:                 String(prev.title  ?? rest.title),
              reason:                String(prev.reason ?? rest.reason),
              supportingEvidence:    Array.isArray(prev.supportingEvidence)    ? prev.supportingEvidence    : rest.supportingEvidence,
              opposingEvidence:      Array.isArray(prev.opposingEvidence)      ? prev.opposingEvidence      : rest.opposingEvidence,
              confidence:            rest.confidence,    // updated (may reflect staleness downgrade)
              urgency:               rest.urgency,
              blockedByEvent:        rest.blockedByEvent,
              blockingEvent:         rest.blockingEvent,
              blockingEventDate:     rest.blockingEventDate,
              whatWouldChangeDecision: Array.isArray(prev.whatWouldChangeDecision) ? prev.whatWouldChangeDecision : rest.whatWouldChangeDecision,
              missingEvidence:       rest.missingEvidence,  // may include staleness note
              portfolioImpact:       String(prev.portfolioImpact       ?? rest.portfolioImpact),
              accountConsiderations: String(prev.accountConsiderations ?? rest.accountConsiderations),
              sourceModules:         rest.sourceModules,  // updated
              targetAllocationPercent:  prev.targetAllocationPercent  ?? rest.targetAllocationPercent,
              maximumAllocationPercent: prev.maximumAllocationPercent ?? rest.maximumAllocationPercent,
              sizingConfidence:         prev.sizingConfidence         ?? rest.sizingConfidence,
              sizingReason:             String(prev.sizingReason ?? rest.sizingReason ?? ""),
              // Server-computed
              status,
              readiness,
              readinessReason,
              lastValidated: nowIso,
            };
          }
        }

        // New / Strengthened / Weakened / non-preserved Unchanged
        return {
          ...rest,
          status,
          readiness,
          readinessReason,
          lastValidated: nowIso,
        };
      });

      // Log evidence scores internally
      for (const d of withStaleness) {
        const ev = d._evidenceScore;
        if (ev) {
          systemLog.logInternal(
            MODULE_NAME,
            `[evidence] ${d.ticker || d.company || "portfolio"} (${d.decision}): ` +
            `score=${ev.score} supporting=[${ev.supportingModules.join(",")}] ` +
            `opposing=[${ev.opposingModules.join(",")}]` +
            (ev.staleModules.length > 0 ? ` stale=[${ev.staleModules.join(",")}]` : "")
          );
        }
      }

      const finalData = {
        ...parsed.data,
        decisions:         responseDecisions,
        nextReviewTriggers: filteredTriggers,
        timestamp:         nowIso,
        analysisDuration,
      };

      // ── Save ─────────────────────────────────────────────────────────────
      analysisRepository.save("trade-decision-engine", finalData);

      const existingHistory = historyEntry?.result?.entries ?? [];
      const newHistoryEntry: DecisionHistoryEntry = {
        timestamp:              nowIso,
        overallDecisionPosture: finalData.overallDecisionPosture,
        decisionReadinessScore: finalData.decisionReadinessScore,
        decisions: withStaleness.map(d => ({
          normalizedKey:  d._normalizedKey,
          subjectType:    d.subjectType,
          company:        d.company,
          ticker:         d.ticker,
          decision:       d.decision,
          confidence:     d.confidence,
          urgency:        d.urgency,
          evidenceScore:  d._evidenceScore?.score,
        })),
      };
      analysisRepository.save("trade-decision-engine-history", {
        entries: [newHistoryEntry, ...existingHistory].slice(0, MAX_HISTORY),
      });

      // ── System log ───────────────────────────────────────────────────────
      systemLog.logInfo(MODULE_NAME, "Decision analysis completed");
      systemLog.logInternal(
        MODULE_NAME,
        `Posture: ${finalData.overallDecisionPosture} | Readiness: ${finalData.decisionReadinessScore}/100`
      );

      const readyOnes    = responseDecisions.filter(d => d.readiness === "ReadyForReview");
      const waitingOnes  = responseDecisions.filter(d => d.readiness === "WaitingForReevaluation");
      const newOnes      = responseDecisions.filter(d => d.status === "New");
      const changedOnes  = responseDecisions.filter(d => d.status === "Strengthened" || d.status === "Weakened");
      const unchangedTrades = responseDecisions.filter(
        d => d.status === "Unchanged" && (d.decision === "PrepareToBuy" || d.decision === "PrepareToReduce")
      );

      if (readyOnes.length > 0) {
        systemLog.logInfo(
          MODULE_NAME,
          `${readyOnes.length} decision(s) ReadyForReview: ${readyOnes.map(d => d.ticker || d.company || "portfolio").join(", ")}`
        );
      }
      if (waitingOnes.length > 0) {
        systemLog.logInternal(MODULE_NAME, `${waitingOnes.length} WaitingForReevaluation`);
      }
      if (newOnes.length > 0) {
        systemLog.logInternal(MODULE_NAME, `New: ${newOnes.map(d => d.title).join("; ")}`);
      }
      if (changedOnes.length > 0) {
        systemLog.logInternal(MODULE_NAME, `Changed (Strengthened/Weakened): ${changedOnes.map(d => `${d.status} ${d.title}`).join("; ")}`);
      }
      if (unchangedTrades.length > 0) {
        systemLog.logInternal(MODULE_NAME, `Preserved Unchanged trade proposals: ${unchangedTrades.map(d => d.ticker || d.company || "portfolio").join(", ")}`);
      }
      if (resolvedDecisions.length > 0) {
        systemLog.logInternal(MODULE_NAME, `Withdrawn: ${resolvedDecisions.map(d => d.ticker || d.company || "portfolio").join(", ")}`);
      }
      if (gateLog.length > 0) {
        systemLog.logInfo(MODULE_NAME, `Multi-source gate: ${gateLog.length} decision(s) downgraded to Review`);
      }

      clearTimeout(routeTimeoutHandle);
      res.json({ ...finalData, _debug: debug });
      return;

    } catch (err) {
      const errDebug = extractAiErrorDebug(err);
      if (lastDebug || errDebug) {
        lastDebug = { ...(lastDebug ?? {}), ...(errDebug ?? {}) } as AiDebugInfo;
      }
      const isLastAttempt = attempt >= MAX_ATTEMPTS;
      req.log[isLastAttempt ? "error" : "warn"](
        { err, attempt },
        isLastAttempt ? "AI service call failed after all attempts" : "AI service call failed — retrying"
      );
      if (isLastAttempt || routeTimedOut) {
        clearTimeout(routeTimeoutHandle);
        if (!res.headersSent) {
          systemLog.logError(
            MODULE_NAME,
            `Decision analysis failed: ${err instanceof Error ? err.message : "AI service call failed"}`
          );
          res.status(500).json({
            error:  err instanceof Error ? err.message : "AI service call failed",
            _debug: lastDebug,
          });
        }
        return;
      }
    }
  }

  // Safety: loop exited without sending (route timeout fired)
  clearTimeout(routeTimeoutHandle);
  if (!res.headersSent) {
    res.status(504).json({
      error: "Trade Decision Engine timed out — analysis took too long",
      _debug: lastDebug,
    });
  }
});

export default router;
