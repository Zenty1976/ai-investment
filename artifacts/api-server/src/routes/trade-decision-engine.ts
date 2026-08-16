/**
 * Trade Decision Engine Route – Phase 2 (rev 2)
 *
 * Phase 2 rev 2 improvements:
 *  - Directional evidence classification (Supporting/Opposing/Neutral/Missing/Stale per module)
 *    replaces source-count-only gate; the gate now requires ≥2 data-driven Supporting modules
 *    and no unresolved critical Opposing module
 *  - Evidence score drives readiness (score < 25 → not ReadyForReview)
 *  - Decision fingerprint replaces confidence+urgency-only comparison for Unchanged detection
 *  - Status computed after staleness downgrade and readiness (correct ordering)
 *  - Subject-first status matching: same ticker/company changing decision type is
 *    Strengthened/Weakened, not Withdrawn+New
 *  - Evidence debug metadata added to _debug response (not in normal UI)
 *
 * Results:  "trade-decision-engine"
 * History:  "trade-decision-engine-history" (latest 20 entries)
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunTradeDecisionEngineResponse } from "@workspace/api-zod";
import { callAi, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { getModel } from "../lib/ai-model-config.js";
import { normalizeAiResponse, classifyRetryReason } from "../lib/ai-response-normalizer.js";
import { analysisRepository } from "../lib/analysis-repository";
import { companyIdentityStore } from "../lib/company-identity";
import type { RepositoryEntry } from "../lib/analysis-repository.js";
import { getActivePolicyConfig, getActivePolicyProfile } from "../lib/trade-decision-policy-store.js";
import { buildPriceContextBlockCompact } from "../lib/price-context-service.js";
import {
  getRiskAnalyzerAiContext,
  getPortfolioAnalyzerAiContext,
  getMarketAlertsAiContext,
  getOpportunityAiContext,
  getEventAiContext,
  getCompanyAiContext,
} from "../lib/downstream-ai-context.js";
import { buildCatalystTdeContext, getActivePromotions } from "../lib/catalyst-promotion.js";
import { buildCatalystTdeCandidates } from "../lib/tde-catalyst-candidates.js";
import type { TradePolicyConfig } from "../lib/trade-decision-policy-config.js";
import { recordDecisionOutcome, type RecordOutcomeInput } from "../lib/trade-decision-outcome-store.js";

const router: IRouter = Router();

const MODULE_NAME = "Trade Decision Engine";
const MAX_ATTEMPTS = 2;
const MAX_HISTORY  = 20;
const ROUTE_TIMEOUT_MS = 190_000;

// ---------------------------------------------------------------------------
// Evidence weights and thresholds
// ---------------------------------------------------------------------------
// All configurable values (staleness hours, evidence band thresholds, gate
// requirements, readiness thresholds) are loaded from the active policy config
// at request time.  See:
//   artifacts/api-server/src/lib/trade-decision-policy-config.ts  — profiles
//   artifacts/api-server/src/lib/trade-decision-policy-store.ts   — active selection

// Confidence rank (ascending)
const CONFIDENCE_RANK: Record<string, number> = { High: 3, Medium: 2, Low: 1 };
const RANK_TO_CONFIDENCE: Record<number, string> = { 3: "High", 2: "Medium", 1: "Low" };

// Urgency rank (ascending, higher = more urgent)
const URGENCY_RANK: Record<string, number> = { Immediate: 4, Days: 3, Weeks: 2, NoUrgency: 1 };

// Decision strength ranking (for cross-type status comparison)
const DECISION_STRENGTH: Record<string, number> = {
  NoAction:        1,
  Hold:            2,
  WaitForEvent:    3,
  Review:          4,
  PrepareToReduce: 5,
  PrepareToBuy:    5,
};

// Readiness rank (for fingerprint comparison)
const READINESS_RANK: Record<string, number> = {
  ReadyForReview:         3,
  Informational:          2,
  WaitingForReevaluation: 1,
};

// Evidence band rank (for fingerprint comparison)
const EVIDENCE_BAND_RANK: Record<string, number> = {
  Strong:      4,
  Adequate:    3,
  Weak:        2,
  Insufficient: 1,
};

// ---------------------------------------------------------------------------
// History types
// ---------------------------------------------------------------------------

interface DecisionHistoryDecision {
  /** Subject key — subjectType|ticker_or_company (no decision type). Used for cross-type matching. */
  subjectKey:    string;
  /** Full key including decision type. */
  normalizedKey: string;
  subjectType:   string;
  company:       string;
  ticker:        string;
  decision:      string;
  confidence:    string;
  urgency:       string;
  readiness?:    string;
  evidenceScore?: number;
  evidenceBand?:  string;
  blockedByEvent?:    boolean;
  blockingEvent?:     string;
  blockingEventDate?: string;
  targetAllocationPercent?:  number;
  maximumAllocationPercent?: number;
  sizingConfidence?:         string;
  /** Deterministic fingerprint of all material fields. */
  fingerprint?:  string;
}

interface DecisionHistoryEntry {
  timestamp:              string;
  overallDecisionPosture: string;
  decisionReadinessScore: number;
  decisions:              DecisionHistoryDecision[];
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
// Directional evidence classification
// ---------------------------------------------------------------------------

type EvidenceClassification = "Supporting" | "Opposing" | "Neutral" | "Missing" | "Stale";
type EvidenceBand           = "Strong" | "Adequate" | "Weak" | "Insufficient";

interface ModuleContribution {
  module:            string;
  classification:    EvidenceClassification;
  reason:            string;
  /** Contribution to the evidence score (-100…+100 range, capped at end). */
  scoreContribution: number;
}

interface DirectionalEvidenceResult {
  evidenceScore:          number;       // -100…+100
  evidenceBand:           EvidenceBand;
  classifications:        ModuleContribution[];
  supportingModules:      string[];
  opposingModules:        string[];
  neutralModules:         string[];
  missingModules:         string[];
  staleModules:           string[];
  supportingCount:        number;
  /** True when CompanyMonitor or RiskAnalyzer classifies as Opposing. */
  hasCriticalOpposing:    boolean;
  criticalOpposingModules: string[];
  gatePassed:             boolean;
  gateFailureReason:      string;
}

interface ModuleData {
  cmEntry:          RepositoryEntry | undefined;   // ticker-specific
  riskEntry:        RepositoryEntry | undefined;
  analyzerEntry:    RepositoryEntry | undefined;
  alertsEntry:      RepositoryEntry | undefined;
  opportunityEntry: RepositoryEntry | undefined;
}

function classifyDecisionEvidence(
  decisionType: "PrepareToBuy" | "PrepareToReduce",
  ticker:       string,
  data:         ModuleData,
  policy:       TradePolicyConfig
): DirectionalEvidenceResult {
  const buy  = decisionType === "PrepareToBuy";
  const contributions: ModuleContribution[] = [];
  const sh   = policy.stalenessHours;
  const ew   = policy.evidenceWeights;

  const add = (mod: string, cls: EvidenceClassification, score: number, reason: string) =>
    contributions.push({ module: mod, classification: cls, scoreContribution: score, reason });

  // ── Company Monitor (ticker-specific) ────────────────────────────────────
  const cm  = data.cmEntry;
  const wCM = ew.CompanyMonitor;

  if (!cm) {
    // Conservative: company-specific trades require CM data — fail gate via a strong penalty
    const missScore = policy.gate.requireCompanyMonitorForCompanyTrades ? wCM.opposing : wCM.missing;
    add("CompanyMonitor", "Missing", missScore,
      policy.gate.requireCompanyMonitorForCompanyTrades
        ? `Company Monitor data is required by the active policy profile (${policy.profile}) but none is available`
        : "No Company Monitor data available for this ticker");
  } else if (!isModuleFresh(cm, sh["company-monitor"])) {
    // Conservative: stale CM treated more severely than missing with requireCM
    const staleScore = policy.gate.requireCompanyMonitorForCompanyTrades ? wCM.opposing : wCM.stale;
    add("CompanyMonitor", "Stale", staleScore,
      `Data is ${formatAge(cm)} old (limit ${sh["company-monitor"]}h)` +
      (policy.gate.requireCompanyMonitorForCompanyTrades ? " — required and stale" : ""));
  } else {
    const rv   = cm.result as Record<string, unknown>;
    const iv   = rv?.investmentView as Record<string, unknown> | null | undefined;
    const rating = String(iv?.rating ?? "");
    const ics    = typeof rv?.investmentCaseStrength === "number" ? rv.investmentCaseStrength as number : null;

    const thesis      = Array.isArray(rv?.investmentThesis)
      ? rv.investmentThesis as Array<Record<string, unknown>>
      : [];
    const invalidated = thesis.filter(p => p.status === "Invalidated").length;
    const weakened    = thesis.filter(p => p.status === "Weakened").length;

    // Scores derived from config weights; ratios preserve current relative proportions
    const strongBuyScore   = wCM.supporting;                                    // 40 balanced
    const buyScore         = Math.round(wCM.supporting * 0.75);                 // 30 balanced
    const avoidScore       = Math.round(wCM.opposing   * (30 / 35));            // -30 balanced
    const invalidatedScore = wCM.opposing;                                       // -35 balanced
    const weakPenalty      = Math.round(Math.abs(wCM.supporting) * 0.125);      // 5 balanced

    if (invalidated > 0) {
      const score = buy ? invalidatedScore : Math.abs(invalidatedScore);
      add("CompanyMonitor", buy ? "Opposing" : "Supporting", score,
        `${invalidated} invalidated thesis point(s)`);
    } else if (rating === "Strong Avoid" || rating === "Avoid") {
      add("CompanyMonitor", buy ? "Opposing" : "Supporting", buy ? avoidScore : Math.abs(avoidScore),
        `Company Monitor rating: ${rating}`);
    } else if (rating === "Strong Buy" || rating === "Buy") {
      const weakIcs = ics !== null && ics < 45;
      if (weakIcs) {
        const neutralScore = Math.round(Math.abs(wCM.supporting) * 0.125) * (buy ? 1 : -1);
        add("CompanyMonitor", "Neutral", neutralScore,
          `${rating} rating but investmentCaseStrength is low (${ics}/100)`);
      } else {
        const baseScore = buy
          ? (rating === "Strong Buy" ? strongBuyScore  : buyScore)
          : (rating === "Strong Buy" ? invalidatedScore : avoidScore); // Buy ratings oppose Reduce
        const wp = weakened * (buy ? -weakPenalty : +weakPenalty);
        add("CompanyMonitor", buy ? "Supporting" : "Opposing", baseScore + wp,
          `Company Monitor rating: ${rating}${ics !== null ? `, strength: ${ics}/100` : ""}` +
          (weakened > 0 ? `, ${weakened} weakened thesis point(s)` : ""));
      }
    } else if (weakened >= 2 && !buy) {
      add("CompanyMonitor", "Supporting", Math.round(wCM.supporting * 0.5),
        `${weakened} weakened thesis points indicate eroding investment case`);
    } else {
      add("CompanyMonitor", "Neutral", 0, `Company Monitor rating: ${rating || "Unknown"}`);
    }
  }

  // ── Risk Analyzer ────────────────────────────────────────────────────────
  const risk = data.riskEntry;
  const wRA  = ew.RiskAnalyzer;

  if (!risk) {
    add("RiskAnalyzer", "Missing", wRA.missing, "No Risk Analyzer data available");
  } else if (!isModuleFresh(risk, sh["risk-analyzer"])) {
    add("RiskAnalyzer", "Stale", wRA.stale, `Data is ${formatAge(risk)} old (limit ${sh["risk-analyzer"]}h)`);
  } else {
    const rr        = risk.result as Record<string, unknown>;
    const riskScore = typeof rr?.riskScore === "number" ? rr.riskScore as number : null;
    const riskLevel = String(rr?.overallRiskLevel ?? "");
    const topRisks  = Array.isArray(rr?.topRisks)
      ? rr.topRisks as Array<Record<string, unknown>>
      : [];

    const tickerLow = ticker.toLowerCase();
    const highTickerRisks = topRisks.filter(tr =>
      tr.severity === "High" &&
      Array.isArray(tr.affectedHoldings) &&
      (tr.affectedHoldings as string[]).some(h => h.toLowerCase().includes(tickerLow))
    ).length;

    const raUnitScore = Math.round(wRA.opposing * (20 / 30));   // -20 balanced

    if (highTickerRisks > 0) {
      const score = buy
        ? Math.max(wRA.opposing, highTickerRisks * raUnitScore)
        : Math.min(wRA.supporting, highTickerRisks * Math.abs(raUnitScore));
      add("RiskAnalyzer", buy ? "Opposing" : "Supporting", score,
        `${highTickerRisks} high-severity risk(s) affecting ${ticker}`);
    } else if (riskScore !== null) {
      if (buy) {
        if (riskScore > 75 || riskLevel === "High") {
          add("RiskAnalyzer", "Opposing", raUnitScore, `Portfolio risk score ${riskScore}/100, level: ${riskLevel}`);
        } else if (riskScore < 40 && riskLevel === "Low") {
          add("RiskAnalyzer", "Supporting", wRA.supporting, `Low portfolio risk score ${riskScore}/100`);
        } else {
          add("RiskAnalyzer", "Neutral", 0, `Risk score ${riskScore}/100 — no critical ticker risk`);
        }
      } else {
        if (riskScore > 75 || riskLevel === "High") {
          add("RiskAnalyzer", "Supporting", wRA.supporting, `High portfolio risk score ${riskScore}/100 — supports reducing`);
        } else if (riskScore < 40) {
          const weakReduceScore = Math.round(wRA.opposing * (15 / 30)); // -15 balanced
          add("RiskAnalyzer", "Opposing", weakReduceScore, `Low portfolio risk score ${riskScore}/100 — case for reducing is weak`);
        } else {
          add("RiskAnalyzer", "Neutral", 0, `Risk score ${riskScore}/100`);
        }
      }
    } else {
      add("RiskAnalyzer", "Neutral", 0, "Risk Analyzer present but no score available");
    }
  }

  // ── Opportunity Finder ────────────────────────────────────────────────────
  const opp  = data.opportunityEntry;
  const wOF  = ew.OpportunityFinder;

  if (!opp) {
    add("OpportunityFinder", "Missing", buy ? wOF.missing : 0, "No Opportunity Finder data available");
  } else if (!isModuleFresh(opp, sh["opportunity-finder"])) {
    add("OpportunityFinder", "Stale", buy ? wOF.stale : 0, `Data is ${formatAge(opp)} old (limit ${sh["opportunity-finder"]}h)`);
  } else {
    const or      = opp.result as Record<string, unknown>;
    const opps    = Array.isArray(or?.topOpportunities)
      ? or.topOpportunities as Array<Record<string, unknown>>
      : [];
    const tickerUp = ticker.toUpperCase();
    const oppIdx   = opps.findIndex(o => String(o.ticker ?? "").toUpperCase() === tickerUp);
    const conf     = oppIdx >= 0 ? String(opps[oppIdx].confidence ?? "") : "";

    const ofTopScore    = wOF.supporting;                             // 25 balanced
    const ofOtherScore  = Math.round(wOF.supporting * 0.6);          // 15 balanced
    const ofNeutralScore = Math.round(wOF.supporting * 0.2);         // 5 balanced

    if (buy) {
      if (oppIdx >= 0 && (conf === "High" || conf === "Medium")) {
        const score = oppIdx < 2 ? ofTopScore : ofOtherScore;
        add("OpportunityFinder", "Supporting", score,
          `${ticker} is rank ${oppIdx + 1} opportunity with ${conf} confidence`);
      } else if (oppIdx >= 0) {
        add("OpportunityFinder", "Neutral", ofNeutralScore,
          `${ticker} is in opportunities but confidence is ${conf}`);
      } else {
        add("OpportunityFinder", "Neutral", 0, `${ticker} not listed as a top opportunity`);
      }
    } else {
      if (oppIdx >= 0 && (conf === "High" || conf === "Medium")) {
        add("OpportunityFinder", "Opposing", wOF.opposing,
          `${ticker} is an active ${conf}-confidence opportunity — reducing is premature`);
      } else {
        add("OpportunityFinder", "Neutral", 0, `${ticker} not an active top opportunity`);
      }
    }
  }

  // ── Portfolio Analyzer ────────────────────────────────────────────────────
  const analyzer = data.analyzerEntry;
  const wPA      = ew.PortfolioAnalyzer;

  if (!analyzer) {
    add("PortfolioAnalyzer", "Missing", wPA.missing, "No Portfolio Analyzer data available");
  } else if (!isModuleFresh(analyzer, sh["portfolio-analyzer"])) {
    add("PortfolioAnalyzer", "Stale", wPA.stale, `Data is ${formatAge(analyzer)} old (limit ${sh["portfolio-analyzer"]}h)`);
  } else {
    const ar       = analyzer.result as Record<string, unknown>;
    const comments = Array.isArray(ar?.positionComments)
      ? ar.positionComments as Array<Record<string, unknown>>
      : [];
    const topOpps  = Array.isArray(ar?.topOpportunities)
      ? ar.topOpportunities as Array<Record<string, unknown>>
      : [];
    const tickerLow = ticker.toLowerCase();

    const comment   = comments.find(c => String(c.ticker ?? "").toLowerCase() === tickerLow);
    const inTopOpps = topOpps.some(o => String(o.title ?? "").toLowerCase().includes(tickerLow));

    const paLowAttnScore = Math.round(wPA.supporting * (10 / 15)); // 10 balanced

    if (comment) {
      if (comment.attention === "High") {
        add("PortfolioAnalyzer", buy ? "Opposing" : "Supporting", buy ? wPA.opposing : wPA.supporting,
          `High-attention position comment for ${ticker}`);
      } else if (comment.attention === "Low" && buy) {
        add("PortfolioAnalyzer", "Supporting", paLowAttnScore, `Low-concern position comment — stable holding`);
      } else {
        add("PortfolioAnalyzer", "Neutral", 0, `${comment.attention ?? "Unknown"}-attention position comment`);
      }
    } else if (inTopOpps && buy) {
      add("PortfolioAnalyzer", "Supporting", wPA.supporting,
        `${ticker} identified in Portfolio Analyzer top opportunities`);
    } else {
      add("PortfolioAnalyzer", "Neutral", 0, "No specific position comment for this ticker");
    }
  }

  // ── Market Alerts ─────────────────────────────────────────────────────────
  const alerts = data.alertsEntry;
  const wMA    = ew.MarketAlerts;

  if (!alerts) {
    add("MarketAlerts", "Missing", wMA.missing, "No Market Alerts data available");
  } else if (!isModuleFresh(alerts, sh["market-alerts"])) {
    add("MarketAlerts", "Stale", wMA.stale, `Data is ${formatAge(alerts)} old (limit ${sh["market-alerts"]}h)`);
  } else {
    const alr       = alerts.result as Record<string, unknown>;
    const allAlerts = Array.isArray(alr?.alerts)
      ? alr.alerts as Array<Record<string, unknown>>
      : [];
    const tickerLow = ticker.toLowerCase();

    const highForTicker = allAlerts.filter(a =>
      a.importance === "High" &&
      Array.isArray(a.affectedHoldings) &&
      (a.affectedHoldings as string[]).some(h => h.toLowerCase().includes(tickerLow))
    );

    const maUnitScore   = Math.round(wMA.opposing * (15 / 25));    // -15 balanced
    const maMonitorScore = Math.round(wMA.opposing * (5  / 25));   // -5 balanced

    if (highForTicker.length > 0) {
      const requiresAttention = highForTicker.some(a => a.requiresAttention === true);
      if (requiresAttention) {
        const score = buy
          ? Math.max(wMA.opposing, highForTicker.length * maUnitScore)
          : Math.min(wMA.supporting, highForTicker.length * Math.abs(maUnitScore));
        add("MarketAlerts", buy ? "Opposing" : "Supporting", score,
          `${highForTicker.length} high-importance alert(s) requiring attention affect ${ticker}`);
      } else {
        add("MarketAlerts", "Neutral", buy ? maMonitorScore : Math.abs(maMonitorScore),
          `${highForTicker.length} high-importance alert(s) for ${ticker} (monitoring, no action required)`);
      }
    } else {
      add("MarketAlerts", "Neutral", 0, `No high-importance alerts affecting ${ticker}`);
    }
  }

  // ── Compute summary ───────────────────────────────────────────────────────
  const rawScore      = contributions.reduce((s, c) => s + c.scoreContribution, 0);
  const evidenceScore = Math.max(-100, Math.min(100, rawScore));

  const evidenceBand: EvidenceBand =
    evidenceScore >= policy.bands.strongMinimum   ? "Strong"      :
    evidenceScore >= policy.bands.adequateMinimum ? "Adequate"    :
    evidenceScore >= policy.bands.weakMinimum     ? "Weak"        :
    "Insufficient";

  const supportingModules = contributions.filter(c => c.classification === "Supporting").map(c => c.module);
  const opposingModules   = contributions.filter(c => c.classification === "Opposing").map(c => c.module);
  const neutralModules    = contributions.filter(c => c.classification === "Neutral").map(c => c.module);
  const missingModules    = contributions.filter(c => c.classification === "Missing").map(c => c.module);
  const staleModules      = contributions.filter(c => c.classification === "Stale").map(c => c.module);

  const criticalModules   = new Set(policy.gate.criticalOpposingModules);
  const criticalOpposing  = opposingModules.filter(m => criticalModules.has(m));

  const supportingCount = supportingModules.length;
  const gatePassed =
    supportingCount >= policy.gate.minimumSupportingModules &&
    criticalOpposing.length === 0;

  const gateReasons: string[] = [];
  if (supportingCount < policy.gate.minimumSupportingModules) {
    gateReasons.push(
      `Only ${supportingCount}/${policy.gate.minimumSupportingModules} required Supporting modules ` +
      `(${supportingModules.join(", ") || "none"})`
    );
  }
  if (criticalOpposing.length > 0) {
    gateReasons.push(`Critical Opposing modules: ${criticalOpposing.join(", ")}`);
  }

  return {
    evidenceScore,
    evidenceBand,
    classifications:         contributions,
    supportingModules,
    opposingModules,
    neutralModules,
    missingModules,
    staleModules,
    supportingCount,
    hasCriticalOpposing:     criticalOpposing.length > 0,
    criticalOpposingModules: criticalOpposing,
    gatePassed,
    gateFailureReason:       gateReasons.join("; "),
  };
}

// ---------------------------------------------------------------------------
// ParsedDecision type (Zod output shape, extended)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Apply directional gate + score-based downgrade
// ---------------------------------------------------------------------------

/**
 * For every PrepareToBuy / PrepareToReduce decision:
 *  1. Classify each module directionally from actual data (not from sourceModules).
 *  2. Gate: ≥2 Supporting + no critical Opposing → pass.
 *  3. Score: evidenceScore < REVIEW_THRESHOLD (10) → downgrade to Review.
 *  4. Score: evidenceScore < NOACTION_THRESHOLD (0) → downgrade to NoAction.
 *
 * Returns the (possibly downgraded) decisions and per-decision evidence results.
 */
function applyEvidenceGate(
  decisions:      ParsedDecision[],
  holdingCmKeys:  Map<string, string>,
  opCmKeys:       Map<string, string>,
  allCmEntries:   RepositoryEntry[],
  riskEntry:      RepositoryEntry | undefined,
  analyzerEntry:  RepositoryEntry | undefined,
  alertsEntry:    RepositoryEntry | undefined,
  opportunityEntry: RepositoryEntry | undefined,
  policy:         TradePolicyConfig,
): { decisions: ParsedDecision[]; evidenceMap: Map<number, DirectionalEvidenceResult>; gateLog: string[] } {
  const evidenceMap = new Map<number, DirectionalEvidenceResult>();
  const gateLog: string[] = [];

  const result = decisions.map((d, idx) => {
    if (d.decision !== "PrepareToBuy" && d.decision !== "PrepareToReduce") return d;

    const cmKey   = holdingCmKeys.get(d.ticker) ?? opCmKeys.get(d.ticker);
    const cmEntry = cmKey ? allCmEntries.find(e => e.moduleName === cmKey) : undefined;

    const ev = classifyDecisionEvidence(
      d.decision as "PrepareToBuy" | "PrepareToReduce",
      d.ticker,
      { cmEntry, riskEntry, analyzerEntry, alertsEntry, opportunityEntry },
      policy
    );
    evidenceMap.set(idx, ev);

    // ── 1. Directional gate ───────────────────────────────────────────────
    if (!ev.gatePassed) {
      const note =
        `Multi-source gate failed (${ev.gateFailureReason}). ` +
        `Downgraded from ${d.decision} to Review.`;
      gateLog.push(`[gate] "${d.title}" (${d.ticker || d.company}): ${note}`);
      return {
        ...d,
        decision: "Review" as const,
        reason:   `${d.reason}\n\n[Backend gate] ${note}`,
        missingEvidence: [
          ...d.missingEvidence,
          `${ev.missingModules.length + ev.staleModules.length > 0
            ? `Missing/stale: ${[...ev.missingModules, ...ev.staleModules].join(", ")}. `
            : ""}` +
          `Additional independent analyses required before a trade proposal can be issued.`,
        ],
        targetAllocationPercent:  undefined,
        maximumAllocationPercent: undefined,
        sizingConfidence:         undefined,
        sizingReason:             undefined,
      };
    }

    // ── 2. Score-based downgrade ──────────────────────────────────────────
    if (ev.evidenceScore < policy.downgrade.reviewThreshold) {
      const target = ev.evidenceScore < policy.downgrade.noActionThreshold ? "NoAction" : "Review";
      const note = `Evidence score ${ev.evidenceScore} (${ev.evidenceBand}) is below ` +
        `${ev.evidenceScore < policy.downgrade.noActionThreshold
          ? `${policy.downgrade.noActionThreshold} (NoAction threshold)`
          : `${policy.downgrade.reviewThreshold} (Review threshold)`}. ` +
        `Downgraded from ${d.decision} to ${target}.`;
      gateLog.push(`[evidence-score] "${d.title}" (${d.ticker || d.company}): ${note}`);
      return {
        ...d,
        decision: target as "Review" | "NoAction",
        reason:   `${d.reason}\n\n[Backend evidence] ${note}`,
        missingEvidence: [...d.missingEvidence, note],
        targetAllocationPercent:  undefined,
        maximumAllocationPercent: undefined,
        sizingConfidence:         undefined,
        sizingReason:             undefined,
      };
    }

    return d;
  });

  return { decisions: result, evidenceMap, gateLog };
}

// ---------------------------------------------------------------------------
// Staleness-based confidence downgrade
// ---------------------------------------------------------------------------

function applyStalenessDwngrade(
  decision:    ParsedDecision,
  staleModules: string[]  // from DirectionalEvidenceResult.staleModules
): ParsedDecision {
  if (decision.decision !== "PrepareToBuy" && decision.decision !== "PrepareToReduce") return decision;
  if (staleModules.length === 0) return decision;

  const curRank = CONFIDENCE_RANK[decision.confidence] ?? 2;
  const newRank = Math.max(1, curRank - 1);
  const newConf = RANK_TO_CONFIDENCE[newRank] ?? "Low";

  if (newConf === decision.confidence) return decision;

  const note = `Confidence reduced (${decision.confidence} → ${newConf}) — stale analysis data: ${staleModules.join(", ")}.`;
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

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/** Subject key — no decision type. Used for cross-type status matching. */
function normalizeSubjectKey(subjectType: string, ticker: string, company: string): string {
  const subject = (ticker?.trim() || company?.trim() || "portfolio").toLowerCase().trim();
  return `${subjectType.toLowerCase().trim()}|${subject}`;
}

/** Full key including decision type. */
function normalizeDecisionKey(subjectType: string, ticker: string, company: string, decision: string): string {
  return `${normalizeSubjectKey(subjectType, ticker, company)}|${decision.toLowerCase().trim()}`;
}

// ---------------------------------------------------------------------------
// Decision fingerprint
// ---------------------------------------------------------------------------

/**
 * Deterministic fingerprint of all material fields.
 * Two decisions with identical fingerprints are considered Unchanged.
 * Wording changes (title/reason text) do NOT affect the fingerprint.
 */
function computeDecisionFingerprint(d: {
  decision:              string;
  confidence:            string;
  urgency:               string;
  blockedByEvent:        boolean;
  blockingEvent:         string;
  blockingEventDate:     string;
  readiness:             string;
  targetAllocationPercent?:  number;
  maximumAllocationPercent?: number;
  sizingConfidence?:         string;
  evidenceBand:          string;
  supportingModules:     string[];
  opposingModules:       string[];
}): string {
  return JSON.stringify({
    d:   d.decision,
    c:   d.confidence,
    u:   d.urgency,
    b:   d.blockedByEvent,
    be:  d.blockingEvent  || "",
    bed: d.blockingEventDate || "",
    r:   d.readiness,
    ta:  d.targetAllocationPercent  != null ? Math.round(d.targetAllocationPercent)  : null,
    ma:  d.maximumAllocationPercent != null ? Math.round(d.maximumAllocationPercent) : null,
    sc:  d.sizingConfidence || "",
    eb:  d.evidenceBand,
    sm:  [...d.supportingModules].sort().join(","),
    om:  [...d.opposingModules].sort().join(","),
  });
}

// ---------------------------------------------------------------------------
// Extended status computation (subject-first + fingerprint-aware)
// ---------------------------------------------------------------------------

type DecisionStatus = "New" | "Strengthened" | "Weakened" | "Unchanged";

function computeExtendedStatus(
  subjectKey: string,
  current: {
    decision:     string;
    confidence:   string;
    urgency:      string;
    readiness:    string;
    evidenceBand: string;
    blockedByEvent: boolean;
    fingerprint:  string;
  },
  previousDecisions: DecisionHistoryDecision[]
): DecisionStatus {
  // Match on subject first (ignoring decision type) to detect cross-type changes
  const prevSameSubject = previousDecisions.find(p => p.subjectKey === subjectKey);
  if (!prevSameSubject) return "New";

  const prevStrength = DECISION_STRENGTH[prevSameSubject.decision] ?? 0;
  const curStrength  = DECISION_STRENGTH[current.decision]        ?? 0;

  // Different decision type → strength-ranked comparison
  if (prevSameSubject.decision !== current.decision) {
    if (curStrength > prevStrength) return "Strengthened";
    if (curStrength < prevStrength) return "Weakened";
    // Same strength but different type (e.g. PrepareToReduce ↔ PrepareToBuy) → Weakened (direction changed)
    return "Weakened";
  }

  // Same decision type → fingerprint comparison
  const prevFp = prevSameSubject.fingerprint;
  if (prevFp && prevFp === current.fingerprint) return "Unchanged";

  // Fingerprints differ — determine direction from key material fields
  let improving  = 0;
  let degrading  = 0;

  const cConf = CONFIDENCE_RANK[current.confidence]           ?? 2;
  const pConf = CONFIDENCE_RANK[prevSameSubject.confidence]   ?? 2;
  if (cConf > pConf) improving++; else if (cConf < pConf) degrading++;

  const cUrg = URGENCY_RANK[current.urgency]           ?? 1;
  const pUrg = URGENCY_RANK[prevSameSubject.urgency]   ?? 1;
  if (cUrg > pUrg) improving++; else if (cUrg < pUrg) degrading++;

  const cRdy = READINESS_RANK[current.readiness]         ?? 0;
  const pRdy = READINESS_RANK[prevSameSubject.readiness ?? ""] ?? 0;
  if (pRdy > 0 && cRdy > pRdy) improving++; else if (pRdy > 0 && cRdy < pRdy) degrading++;

  const cEv = EVIDENCE_BAND_RANK[current.evidenceBand]          ?? 0;
  const pEv = EVIDENCE_BAND_RANK[prevSameSubject.evidenceBand ?? ""] ?? 0;
  if (pEv > 0 && cEv > pEv) improving++; else if (pEv > 0 && cEv < pEv) degrading++;

  if (prevSameSubject.blockedByEvent === true  && !current.blockedByEvent) improving++;
  if (prevSameSubject.blockedByEvent === false && current.blockedByEvent)  degrading++;

  if (improving > degrading) return "Strengthened";
  if (degrading > improving) return "Weakened";
  if (improving > 0)         return "Strengthened"; // tie with any signal → Strengthened
  // No historical fingerprint to compare against → treat as Unchanged if signals are silent
  return prevFp ? "Unchanged" : "Unchanged";
}

// ---------------------------------------------------------------------------
// Readiness computation (evidence-aware)
// ---------------------------------------------------------------------------

type ReadinessValue = "WaitingForReevaluation" | "ReadyForReview" | "Informational";

function computeReadiness(
  d: {
    decision:          string;
    confidence:        string;
    blockedByEvent:    boolean;
    blockingEvent:     string;
    blockingEventDate: string;
    sizingReason?:     string;
    targetAllocationPercent?:  number;
    maximumAllocationPercent?: number;
    sizingConfidence?: string;
  },
  policy:   TradePolicyConfig,
  evidence?: DirectionalEvidenceResult
): { readiness: ReadinessValue; readinessReason: string } {
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
      const event = d.blockingEvent;
      const date  = d.blockingEventDate ? ` (${d.blockingEventDate})` : "";
      return {
        readiness: "WaitingForReevaluation",
        readinessReason: event
          ? `Waiting for ${event}${date} — re-evaluate afterwards.`
          : "Blocked by an upcoming event — re-evaluate afterwards.",
      };
    }
    return { readiness: "Informational", readinessReason: "Requires closer manual assessment before a trade decision can be made." };
  }

  if (type === "PrepareToBuy" || type === "PrepareToReduce") {
    if (blocked) {
      const event = d.blockingEvent;
      const date  = d.blockingEventDate ? ` (${d.blockingEventDate})` : "";
      return {
        readiness: "WaitingForReevaluation",
        readinessReason: event
          ? `Waiting for ${event}${date} — trade must be re-evaluated after the event with new price, risk and sizing data.`
          : "Blocked by an upcoming event — trade must be re-evaluated after the event.",
      };
    }

    // Hard safety rule: Low confidence is NEVER ReadyForReview (applies to all profiles)
    if (d.confidence === "Low") {
      return { readiness: "Informational", readinessReason: "Confidence is Low — additional evidence needed." };
    }

    // Policy-level confidence gate (Conservative may require Medium minimum — handled via
    // minimumConfidence setting, but "Medium" is already the hard minimum, so this is
    // future-proofing for a "High" minimum profile)
    if (policy.readyForReview.minimumConfidence === "High" && d.confidence !== "High") {
      return {
        readiness: "Informational",
        readinessReason: `Active policy (${policy.profile}) requires High confidence — current confidence is ${d.confidence}.`,
      };
    }

    // Evidence score gate (from active policy)
    if (evidence) {
      if (evidence.evidenceScore < policy.readyForReview.minimumEvidenceScore) {
        return {
          readiness: "Informational",
          readinessReason:
            `Evidence score ${evidence.evidenceScore} (${evidence.evidenceBand}) is below the ` +
            `ReadyForReview threshold of ${policy.readyForReview.minimumEvidenceScore} ` +
            `(${policy.profile} profile). ` +
            `Supporting: ${evidence.supportingModules.join(", ") || "none"}. ` +
            `Opposing: ${evidence.opposingModules.join(", ") || "none"}.`,
        };
      }
      if (evidence.hasCriticalOpposing) {
        return {
          readiness: "Informational",
          readinessReason: `Unresolved critical opposing evidence from: ${evidence.criticalOpposingModules.join(", ")}. Investigate before actioning.`,
        };
      }
    }

    // Sizing gate (all profiles — hard safety rule)
    const hasValidSizing =
      typeof d.targetAllocationPercent  === "number" && d.targetAllocationPercent  > 0 &&
      typeof d.maximumAllocationPercent === "number" && d.maximumAllocationPercent >= d.targetAllocationPercent &&
      ["High", "Medium", "Low"].includes(d.sizingConfidence ?? "");

    if (!hasValidSizing) {
      return { readiness: "Informational", readinessReason: "Sizing fields are incomplete — manual sizing required before actioning." };
    }

    // Policy-level maximum allocation gate (Conservative)
    if (
      policy.readyForReview.maximumTargetAllocationPercent !== null &&
      typeof d.targetAllocationPercent === "number" &&
      d.targetAllocationPercent > policy.readyForReview.maximumTargetAllocationPercent
    ) {
      return {
        readiness: "Informational",
        readinessReason:
          `Target allocation ${d.targetAllocationPercent}% exceeds the ` +
          `${policy.profile} policy limit of ${policy.readyForReview.maximumTargetAllocationPercent}%. ` +
          `Reduce the target allocation before this proposal can proceed to review.`,
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
6.5. Catalyst Intelligence (qualifying pre-event candidates — HighInterest and CandidateForTradeDecision require explicit decisions)
7. Event Monitor
8. Sector Monitor
9. Market Monitor
10. News Monitor

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
- sourceModules must list only modules that provided material evidence for that specific decision. Use exactly these values with no spaces: PortfolioManager, PortfolioAnalyzer, RiskAnalyzer, MarketAlerts, CompanyMonitor, OpportunityFinder, CatalystIntelligence, EventMonitor, SectorMonitor, MarketMonitor, NewsMonitor.
- Return 3–8 decisions, most important first.
- Every entry in catalystTdeCandidates (from the decision profile) MUST receive an explicit decision evaluation. The decision may be any type — PrepareToBuy, WaitForEvent, Review, Hold, NoAction — but the entry must not be silently omitted. Use subjectType "Opportunity" for Catalyst candidates. Use CatalystIntelligence as a sourceModules entry when Catalyst data was material.
- Return 3–6 readiness drivers.
- Do not create duplicate decisions for the same subject and decision type.
- decisionReadinessScore: integer 0–100 measuring whether evidence is sufficient to make useful decisions — not a prediction of portfolio return.

SIZING GUIDANCE: For every PrepareToBuy and PrepareToReduce decision, include four additional fields to support automated trade sizing. Omit these fields entirely on Hold, Review, WaitForEvent and NoAction decisions.
- targetAllocationPercent (integer 0–100): recommended portfolio weight after the trade.
- maximumAllocationPercent (integer 0–100, must be ≥ targetAllocationPercent): acceptable upper bound.
- sizingConfidence ("High" | "Medium" | "Low"): confidence in the sizing itself.
- sizingReason (string, one sentence maximum): core rationale for this sizing only.

ACCOUNT CONSIDERATIONS: Distinguish precisely: (1) trading/account currency; (2) instrument currency; (3) investor base-currency exposure; (4) underlying company currency exposure. Do not write categorical statements such as "FX neutral". Phase 1 must not select accounts or place orders.

Return JSON only — no markdown, no code fences, no extra text.
Do not include timestamp or analysisDuration — the server sets those.

Return exactly:
{"mainConclusion":{"title":"…","reason":"…"},"executiveSummary":"…","overallDecisionPosture":"ActivelyReview|SelectivePreparation|WaitForEvents|MaintainCurrentPositioning|InsufficientEvidence","decisionReadinessScore":0,"readinessDrivers":[{"factor":"…","impact":"Positive|Negative|Neutral","reason":"…"}],"decisions":[{"rank":1,"subjectType":"Holding|Opportunity|Portfolio","company":"…","ticker":"…","decision":"Hold|Review|WaitForEvent|PrepareToBuy|PrepareToReduce|NoAction","title":"…","reason":"…","supportingEvidence":["…"],"opposingEvidence":["…"],"confidence":"High|Medium|Low","urgency":"Immediate|Days|Weeks|NoUrgency","blockedByEvent":false,"blockingEvent":"","blockingEventDate":"","whatWouldChangeDecision":["…"],"missingEvidence":["…"],"portfolioImpact":"…","accountConsiderations":"…","sourceModules":["PortfolioManager"],"targetAllocationPercent":5,"maximumAllocationPercent":7,"sizingConfidence":"Medium","sizingReason":"…"}],"conflictsResolved":[{"topic":"…","conflict":"…","resolution":"…"}],"nextReviewTriggers":[{"trigger":"…","date":"YYYY-MM-DD or empty string","affectedDecisions":["decision title"]}]}

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

  // Load the active policy profile for this run
  const policy    = getActivePolicyConfig();
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
  const portfolioEntry   = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  const analyzerEntry    = analysisRepository.get<Record<string, unknown>>("portfolio-analyzer");
  const riskEntry        = analysisRepository.get<Record<string, unknown>>("risk-analyzer");
  const alertsEntry      = analysisRepository.get<Record<string, unknown>>("market-alerts");
  const eventEntry       = analysisRepository.get<Record<string, unknown>>("event-monitor");
  // §4: Market, News, Sector are synthesized by Portfolio Analyzer, Risk Analyzer, and
  // Market Alerts. Sending them separately causes information fan-out where the same
  // market fact reaches Trade Decision through 3–5 different module outputs.
  // Remove them from the user prompt; PA/RA/Alerts already represent their implications.
  const opportunityEntry = analysisRepository.get<Record<string, unknown>>("opportunity-finder");

  const allRepoEntries = analysisRepository.getAll();
  const allCmEntries   = allRepoEntries.filter(e => e.moduleName.startsWith("company-monitor:"));
  const cmCandidates   = allCmEntries.map(e => ({
    key:    e.moduleName,
    result: e.result as Record<string, unknown>,
  }));

  // ── Load previous full TDE result for preservation ───────────────────────
  const prevTdeEntry = analysisRepository.get<Record<string, unknown>>("trade-decision-engine");
  const prevFullDecisions: Array<Record<string, unknown>> = Array.isArray(prevTdeEntry?.result?.decisions)
    ? (prevTdeEntry!.result.decisions as Array<Record<string, unknown>>)
    : [];

  const prevDecisionByKey = new Map<string, Record<string, unknown>>();
  for (const d of prevFullDecisions) {
    const nk = normalizeDecisionKey(
      String(d.subjectType ?? ""), String(d.ticker ?? ""),
      String(d.company ?? ""),    String(d.decision ?? "")
    );
    prevDecisionByKey.set(nk, d);
  }

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

  const staleWarnings: string[] = [];
  if (riskEntry     && !isModuleFresh(riskEntry,     policy.stalenessHours["risk-analyzer"]))      staleWarnings.push(`RiskAnalyzer (${formatAge(riskEntry)})`);
  if (analyzerEntry && !isModuleFresh(analyzerEntry, policy.stalenessHours["portfolio-analyzer"]))  staleWarnings.push(`PortfolioAnalyzer (${formatAge(analyzerEntry)})`);
  if (alertsEntry   && !isModuleFresh(alertsEntry,   policy.stalenessHours["market-alerts"]))       staleWarnings.push(`MarketAlerts (${formatAge(alertsEntry)})`);
  if (staleWarnings.length > 0) {
    systemLog.logWarning(MODULE_NAME, `Stale analysis data: ${staleWarnings.join(", ")} — confidence may be downgraded`);
  }

  // ── Portfolio data ───────────────────────────────────────────────────────
  const portfolioResult = portfolioEntry?.result as Record<string, unknown> | undefined;
  const accounts = Array.isArray(portfolioResult?.accounts)
    ? (portfolioResult!.accounts as Array<Record<string, unknown>>)
    : [];

  const baseCurrency       = typeof portfolioResult?.baseCurrency       === "string" ? portfolioResult.baseCurrency       : "Unknown";
  const totalValue         = typeof portfolioResult?.totalValue          === "number" ? portfolioResult.totalValue          : null;
  const totalAvailableCash = typeof portfolioResult?.totalAvailableCash  === "number" ? portfolioResult.totalAvailableCash  : null;

  const allPositions: Array<{
    ticker: string; name: string;
    marketValueBaseCurrency: number; currency: string;
    accountCurrency: string; accountName: string;
    quantity: number; unrealizedPnL: number;
  }> = [];

  for (const acc of accounts) {
    const posArr = Array.isArray(acc.positions) ? acc.positions as Array<Record<string, unknown>> : [];
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
  const totalInvested  = allPositions.reduce((s, p) => s + p.marketValueBaseCurrency, 0);
  const baseForWeights = totalValue ?? totalInvested;
  const cashPct        = baseForWeights > 0 && totalAvailableCash != null
    ? Math.round((totalAvailableCash / baseForWeights) * 1000) / 10
    : null;

  const positionsWithWeights = allPositions
    .map(p => ({
      ...p,
      weightOfTotal:    baseForWeights > 0 ? Math.round((p.marketValueBaseCurrency / baseForWeights) * 1000) / 10 : 0,
      weightOfInvested: totalInvested  > 0 ? Math.round((p.marketValueBaseCurrency / totalInvested)  * 1000) / 10 : 0,
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
        .slice(0, 5).map(o => ({
          rank: o.rank, ticker: o.ticker, company: o.company, sector: o.sector,
          confidence: o.confidence, priority: o.priority, mainCatalyst: o.mainCatalyst,
          hasCompanyMonitor:
            holdingCmKeys.has(String(o.ticker ?? "").toUpperCase()) ||
            opCmKeys.has(String(o.ticker ?? "").toUpperCase()),
        }))
    : [];

  // Catalyst Intelligence → explicit TDE decision candidates (spec §1, §5, §6)
  // Qualifying states: HighInterest and CandidateForTradeDecision only.
  // Tickers already in OF top-5 are deduplicated — OF + Catalyst context covers them.
  // This does NOT introduce automatic buys — TDE independently evaluates each candidate.
  const catalystTdeCandidates = buildCatalystTdeCandidates(
    rawOpportunities,
    getActivePromotions()
  );

  const riskScore     = typeof riskEntry?.result?.riskScore === "number" ? riskEntry.result.riskScore : null;
  const prevRiskScore = typeof riskEntry?.result?.previousRiskScore === "number" ? riskEntry.result.previousRiskScore : null;

  const decisionProfile = {
    generatedAt: nowIso,
    baseCurrency,
    isMockData: portfolioEntry?.result?.isMockData ?? false,
    totalPortfolioValue:     totalValue,
    totalAvailableCash,
    cashPercentage:          cashPct,
    totalInvestedValue:      Math.round(totalInvested),
    cashByCurrency,
    largestHolding: positionsWithWeights[0]
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
    riskScore, previousRiskScore: prevRiskScore,
    riskScoreChange: riskScore != null && prevRiskScore != null ? riskScore - prevRiskScore : null,
    riskLevel:       riskEntry?.result?.overallRiskLevel ?? null,
    portfolioScore:  analyzerEntry?.result?.portfolioScore ?? null,
    portfolioOutlook: analyzerEntry?.result?.overallOutlook ?? null,
    alertLevel:      alertsEntry?.result?.overallAlertLevel ?? null,
    alertHeadline:   alertsEntry?.result?.headline ?? null,
    upcomingHighImportanceEvents: upcomingEvents,
    topOpportunityCandidates,
    catalystTdeCandidates,
    positionsWithCompanyMonitorData:    positionsWithWeights.filter(p =>  p.hasCompanyMonitor).map(p => p.ticker),
    positionsMissingCompanyMonitorData: positionsWithWeights.filter(p => !p.hasCompanyMonitor).map(p => p.ticker),
    moduleDataFreshness: {
      riskAnalyzer:      riskEntry       ? `${Math.round(entryAgeHours(riskEntry))}h old`       : "missing",
      portfolioAnalyzer: analyzerEntry   ? `${Math.round(entryAgeHours(analyzerEntry))}h old`   : "missing",
      marketAlerts:      alertsEntry     ? `${Math.round(entryAgeHours(alertsEntry))}h old`     : "missing",
      opportunityFinder: opportunityEntry ? `${Math.round(entryAgeHours(opportunityEntry))}h old` : "missing",
    },
  };

  // ── Module contexts — §1: compact downstream context layer ──────────────────
  const riskCtx = getRiskAnalyzerAiContext();
  const riskContext = riskCtx ? JSON.stringify(riskCtx) : null;

  const analyzerCtx = getPortfolioAnalyzerAiContext();
  const analyzerContext = analyzerCtx ? JSON.stringify(analyzerCtx) : null;

  const alertsCtx = getMarketAlertsAiContext();
  const alertsContext = alertsCtx ? JSON.stringify(alertsCtx) : null;

  const opportunityCtx = getOpportunityAiContext();
  const opportunityContext = opportunityCtx ? JSON.stringify(opportunityCtx) : null;

  // Filter events to relevant symbols: holdings + current opportunity candidates.
  const relevantEventSymbols = [
    ...allPositions.map(p => p.ticker),
    ...rawOpportunities.map(o => String(o.ticker ?? "").toUpperCase()).filter(Boolean),
  ];
  const eventCtx = getEventAiContext(relevantEventSymbols);
  const eventContext = eventCtx ? JSON.stringify(eventCtx) : null;

  // §4: Market, News, Sector removed from user prompt — their material implications
  // are already represented by Portfolio Analyzer, Risk Analyzer, and Market Alerts.
  // Sending them separately causes information fan-out.

  // Company Monitor context — §1: compact downstream context getter
  const relevantCmEntries = allCmEntries.filter(e => relevantCmKeys.has(e.moduleName));

  const companyContextLines = relevantCmEntries.map(e => {
    const matchedTickers = [
      ...[...holdingCmKeys.entries()].filter(([, key]) => key === e.moduleName).map(([t]) => t),
      ...[...opCmKeys.entries()].filter(([, key]) => key === e.moduleName).map(([t]) => t),
    ];
    const matchLabel = matchedTickers.join("/") || e.moduleName.replace("company-monitor:", "");
    const ctx = getCompanyAiContext(e.moduleName, matchLabel);
    if (!ctx) return null;
    return `COMPANY MONITOR — ${matchLabel} (updated: ${e.updatedAt}, freshness: ${formatAge(e)}):\n${JSON.stringify(ctx)}`;
  }).filter((line): line is string => line !== null).join("\n\n");

  // ── History (for status computation) ─────────────────────────────────────
  const historyEntry = analysisRepository.get<{ entries: DecisionHistoryEntry[] }>(
    "trade-decision-engine-history"
  );
  const previousDecisions: DecisionHistoryDecision[] =
    historyEntry?.result?.entries?.[0]?.decisions ?? [];

  // ── Previous decisions context for user prompt ────────────────────────────
  const prevDecisionsSummary = prevFullDecisions.length > 0
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

  // ── User prompt ───────────────────────────────────────────────────────────
  const addCtx = (label: string, ctx: string | null, sections: string[]) => {
    sections.push(ctx ? `\n${label}:\n${ctx}` : `\n${label}: Not available.`);
  };

  const userPromptSections: string[] = [
    `ANALYSIS DATE: ${nowIso}`,
    `\nBACKEND DECISION PROFILE (server-calculated — treat as highest-priority input):\n${JSON.stringify(decisionProfile)}`,
  ];

  addCtx("RISK ANALYZER (priority 2)",      riskContext,       userPromptSections);
  addCtx("PORTFOLIO ANALYZER (priority 3)", analyzerContext,   userPromptSections);
  addCtx("MARKET ALERTS (priority 4)",      alertsContext,     userPromptSections);

  if (companyContextLines) {
    userPromptSections.push(`\nCOMPANY MONITOR DATA (priority 5 — includes v2 fields):\n${companyContextLines}`);
  } else {
    userPromptSections.push(`\nCOMPANY MONITOR DATA (priority 5): None available. Treat this as missing evidence for every holding.`);
  }

  // Price Context — only relevant symbols: portfolio holdings + current OF candidates
  const relevantPriceSymbols = [...new Set([
    ...allPositions.map(p => p.ticker),
    ...rawOpportunities.map(o => String(o.ticker ?? "").toUpperCase()).filter(Boolean),
  ])];
  // §7: Compact price context — one JSON line per symbol
  const relevantPriceContexts = buildPriceContextBlockCompact(relevantPriceSymbols);
  const priceCtxEntries = Object.entries(relevantPriceContexts);
  if (priceCtxEntries.length > 0) {
    const pcLines = priceCtxEntries.map(([sym, pc]) => `${sym}: ${pc}`).join("\n");
    userPromptSections.push(
      `\nPRICE CONTEXT (priority 5.5 — compact Saxo data, NOT a forecast; fields: state/recent/r5d/r1m/r3m/volatility):\n` +
      `Price Context is supporting context only — it cannot satisfy the ≥2 independent sources requirement.\n` +
      pcLines
    );
  }

  // §4: Market, News, Sector removed — their implications are in PA, RA, Alerts above.
  addCtx("OPPORTUNITY FINDER (priority 6)", opportunityContext, userPromptSections);

  // Catalyst Intelligence — qualitative context for all relevant tickers.
  // Qualifying tickers (HighInterest/CandidateForTradeDecision) are also listed in
  // catalystTdeCandidates inside the decision profile and require explicit decisions.
  // Monitor/Investigate tickers remain non-actionable informational context only.
  const catalystRelevantTickers = [
    ...new Set([
      ...allPositions.map(p => p.ticker),
      ...rawOpportunities.map(o => String(o.ticker ?? "").toUpperCase()).filter(Boolean),
      ...getActivePromotions().map(p => p.ticker.toUpperCase()),
    ]),
  ];
  const catalystContextLines = catalystRelevantTickers
    .map(t => buildCatalystTdeContext(t))
    .filter((ctx): ctx is string => ctx !== null);
  if (catalystContextLines.length > 0) {
    const qualifyingCount = catalystTdeCandidates.length;
    const qualifyingNote = qualifyingCount > 0
      ? `${qualifyingCount} candidate(s) in catalystTdeCandidates require explicit decisions; Monitor/Investigate are non-actionable context`
      : `non-actionable pre-event context; INTENTIONAL_PRE_EVENT_THESIS requires manual approval`;
    userPromptSections.push(
      `\nCATALYST INTELLIGENCE (priority 6.5 — ${qualifyingNote}):\n` +
      catalystContextLines.join("\n\n")
    );
  }

  addCtx("EVENT MONITOR (priority 7)",      eventContext,       userPromptSections);

  if (prevDecisionsSummary) {
    userPromptSections.push(
      `\nPREVIOUS TRADE DECISIONS (from ${prevTdeEntry?.updatedAt ?? "unknown"}):\n` +
      JSON.stringify(prevDecisionsSummary) +
      `\n\nGUIDELINE: Only generate decisions that are new or materially changed. ` +
      `If a previous PrepareToBuy or PrepareToReduce remains valid with unchanged evidence, ` +
      `return it with the same content — the backend will preserve the original recommendation.`
    );
  }

  const catalystCandidateReminder = catalystTdeCandidates.length > 0
    ? ` Every entry in catalystTdeCandidates (${catalystTdeCandidates.map(c => c.ticker).join(", ")}) must receive an explicit decision — WaitForEvent, Review, or NoAction is acceptable, but silent omission is not.`
    : "";
  userPromptSections.push(
    `\nTask: Based on all the above, produce 3–8 cautious decision proposals for the next 1–3 months. ` +
    `Resolve conflicts between modules.` +
    catalystCandidateReminder +
    ` Remember: PrepareToBuy and PrepareToReduce require ≥2 independent analytical sources — the backend verifies this from data, not just sourceModules claims.`
  );

  const userPrompt = userPromptSections.join("\n");

  // ── Retry loop ─────────────────────────────────────────────────────────────
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (routeTimedOut || res.headersSent) break;

    try {
      const { result, debug } = await callAi(
        SYSTEM_PROMPT,
        userPrompt,
        { model: getModel("decision", "trade-decision-engine"), maxTokens: 5000, temperature: 0.1, module: "trade-decision-engine", operation: "analyze", retryNumber: attempt }
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

      // Schema validation — with conservative format normalizer
      const assembled = { ...normalizedResult, timestamp: nowIso, analysisDuration };
      const { normalized: normAssembled, changes: normChanges } = normalizeAiResponse(assembled, RunTradeDecisionEngineResponse);
      if (normChanges.length > 0) req.log.info({ changes: normChanges, attempt }, "TDE: normalizer repaired formatting — no retry needed");
      const parsed = RunTradeDecisionEngineResponse.safeParse(normAssembled);
      if (!parsed.success) {
        const retryReason = classifyRetryReason(parsed.error, normChanges);
        throw new Error(
          `Schema validation failed [${retryReason}]: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        );
      }

      // Executable language guard
      const badDecisions = parsed.data.decisions.filter(hasExecutableLanguage);
      if (badDecisions.length > 0) {
        throw new Error(`Prohibited executable language in: ${badDecisions.map(d => d.title).join("; ")}`);
      }

      // ── Stale WaitForEvent normalization (deterministic repair — no retry) ───
      // When a WaitForEvent's blockingEventDate is in the past, the event has
      // already occurred.  Throwing here causes TDE to fail every attempt until
      // the event context updates — creating an infinite retry loop that wastes
      // 2 full GPT-4o calls per orchestrator cycle, indefinitely.
      //
      // Safe repair: clear the expired blocking constraint and let the evidence
      // gate re-evaluate the decision normally.  No investment facts are invented;
      // only an expired temporal constraint is removed.  The AI will reassess
      // the decision on the next cycle with updated event-monitor context.
      const decisionsForGate = parsed.data.decisions.map(d => {
        if (
          d.decision === "WaitForEvent" &&
          d.blockedByEvent &&
          d.blockingEventDate
        ) {
          const evDate = new Date(d.blockingEventDate);
          if (!isNaN(evDate.getTime()) && evDate < nowDate) {
            systemLog.logInternal(MODULE_NAME,
              `Normalized stale WaitForEvent: "${d.title}" — blocking date ${d.blockingEventDate} has passed; block cleared for this cycle`
            );
            return { ...d, blockedByEvent: false, blockingEvent: "", blockingEventDate: "" };
          }
        }
        return d;
      });

      // ── STEP 1: Directional gate + evidence score downgrade ─────────────
      const { decisions: gatedDecisions, evidenceMap, gateLog } = applyEvidenceGate(
        decisionsForGate as unknown as ParsedDecision[],
        holdingCmKeys, opCmKeys, allCmEntries,
        riskEntry, analyzerEntry, alertsEntry, opportunityEntry,
        policy
      );

      for (const msg of gateLog) {
        systemLog.logInternal(MODULE_NAME, msg);
      }

      // ── Sizing validation (Prepare* decisions that survived the gate) ────
      const missingSizing = gatedDecisions.filter(d => {
        if (d.decision !== "PrepareToBuy" && d.decision !== "PrepareToReduce") return false;
        if (d.blockedByEvent === true) return false;
        const target = d.targetAllocationPercent;
        const max    = d.maximumAllocationPercent;
        const conf   = d.sizingConfidence;
        const reason = (d.sizingReason ?? "").trim();
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

      // Clear stale blocking flags
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
      const sorted    = sortDecisionsByPriority(clearedDecisions);
      const seenKeys  = new Set<string>();
      const deduped   = sorted.filter(d => {
        const k = normalizeDecisionKey(d.subjectType, d.ticker, d.company, d.decision);
        if (seenKeys.has(k)) return false;
        seenKeys.add(k);
        return true;
      });
      const reranked  = deduped.map((d, i) => ({ ...d, rank: i + 1 }));

      // ── STEP 2: Staleness downgrade (uses evidence staleModules) ──────────
      const withStaleness = reranked.map((d, rerankedIdx) => {
        // Find original index in gatedDecisions to look up evidence
        const origIdx = gatedDecisions.findIndex(
          od => od.ticker === d.ticker && od.company === d.company && od.decision === d.decision
        );
        const ev = origIdx >= 0 ? evidenceMap.get(origIdx) : undefined;
        const stale = ev?.staleModules ?? [];
        return {
          ...applyStalenessDwngrade(d as ParsedDecision, stale),
          _origIdx:     rerankedIdx,
          _evidenceKey: origIdx,
        };
      });

      // ── STEP 3: Compute readiness (uses final confidence + evidence) ──────
      type DWithReadiness = (typeof withStaleness)[0] & {
        _readiness:       ReadinessValue;
        _readinessReason: string;
        _normalizedKey:   string;
        _subjectKey:      string;
      };

      const withReadiness: DWithReadiness[] = withStaleness.map(d => {
        const ev  = evidenceMap.get(d._evidenceKey);
        const { readiness, readinessReason } = computeReadiness(
          d as unknown as Parameters<typeof computeReadiness>[0],
          policy,
          ev
        );
        return {
          ...d,
          _readiness:       readiness,
          _readinessReason: readinessReason,
          _normalizedKey:   normalizeDecisionKey(d.subjectType, d.ticker, d.company, d.decision),
          _subjectKey:      normalizeSubjectKey(d.subjectType, d.ticker, d.company),
        };
      });

      // ── STEP 4: Compute fingerprints ──────────────────────────────────────
      type DWithFingerprint = DWithReadiness & { _fingerprint: string; _evidence?: DirectionalEvidenceResult };

      const withFingerprints: DWithFingerprint[] = withReadiness.map(d => {
        const ev = evidenceMap.get(d._evidenceKey);
        const fingerprint = computeDecisionFingerprint({
          decision:            d.decision,
          confidence:          d.confidence,
          urgency:             d.urgency,
          blockedByEvent:      d.blockedByEvent,
          blockingEvent:       d.blockingEvent,
          blockingEventDate:   d.blockingEventDate,
          readiness:           d._readiness,
          targetAllocationPercent:  d.targetAllocationPercent,
          maximumAllocationPercent: d.maximumAllocationPercent,
          sizingConfidence:         d.sizingConfidence,
          evidenceBand:        ev?.evidenceBand ?? "Insufficient",
          supportingModules:   ev?.supportingModules ?? [],
          opposingModules:     ev?.opposingModules   ?? [],
        });
        return { ...d, _fingerprint: fingerprint, _evidence: ev };
      });

      // ── STEP 5: Compute status (subject-first + fingerprint) ──────────────
      type DWithStatus = DWithFingerprint & { _status: DecisionStatus };

      const withStatus: DWithStatus[] = withFingerprints.map(d => {
        const status = computeExtendedStatus(
          d._subjectKey,
          {
            decision:     d.decision,
            confidence:   d.confidence,
            urgency:      d.urgency,
            readiness:    d._readiness,
            evidenceBand: d._evidence?.evidenceBand ?? "Insufficient",
            blockedByEvent: d.blockedByEvent,
            fingerprint:  d._fingerprint,
          },
          previousDecisions
        );
        return { ...d, _status: status };
      });

      // ── Track withdrawn decisions (subject-based, not key-based) ──────────
      const currentSubjectKeys = new Set(withStatus.map(d => d._subjectKey));
      const withdrawnDecisions  = previousDecisions.filter(p => !currentSubjectKeys.has(p.subjectKey));

      // ── Build response decisions (with preservation) ─────────────────────
      const responseDecisions = withStatus.map(d => {
        const {
          _origIdx: _o, _evidenceKey: _ek, _readiness, _readinessReason,
          _normalizedKey: nk, _subjectKey: _sk, _fingerprint: _fp,
          _evidence: _ev, _status: status,
          ...rest
        } = d;

        // Preserve Unchanged Prepare* — carry forward original text, update metadata
        if (
          status === "Unchanged" &&
          (rest.decision === "PrepareToBuy" || rest.decision === "PrepareToReduce")
        ) {
          const prev = prevDecisionByKey.get(nk);
          if (prev) {
            return {
              rank:                   rest.rank,
              subjectType:            rest.subjectType,
              company:                String(prev.company ?? rest.company),
              ticker:                 String(prev.ticker  ?? rest.ticker),
              decision:               rest.decision,
              title:                  String(prev.title   ?? rest.title),
              reason:                 String(prev.reason  ?? rest.reason),
              supportingEvidence:     Array.isArray(prev.supportingEvidence)     ? prev.supportingEvidence     : rest.supportingEvidence,
              opposingEvidence:       Array.isArray(prev.opposingEvidence)       ? prev.opposingEvidence       : rest.opposingEvidence,
              confidence:             rest.confidence,       // may have been downgraded (staleness)
              urgency:                rest.urgency,
              blockedByEvent:         rest.blockedByEvent,
              blockingEvent:          rest.blockingEvent,
              blockingEventDate:      rest.blockingEventDate,
              whatWouldChangeDecision: Array.isArray(prev.whatWouldChangeDecision) ? prev.whatWouldChangeDecision : rest.whatWouldChangeDecision,
              missingEvidence:        rest.missingEvidence,  // may include staleness notes
              portfolioImpact:        String(prev.portfolioImpact       ?? rest.portfolioImpact),
              accountConsiderations:  String(prev.accountConsiderations ?? rest.accountConsiderations),
              sourceModules:          rest.sourceModules,    // updated
              targetAllocationPercent:  prev.targetAllocationPercent  ?? rest.targetAllocationPercent,
              maximumAllocationPercent: prev.maximumAllocationPercent ?? rest.maximumAllocationPercent,
              sizingConfidence:         prev.sizingConfidence         ?? rest.sizingConfidence,
              sizingReason:             String(prev.sizingReason ?? rest.sizingReason ?? ""),
              status,
              readiness:    _readiness,
              readinessReason: _readinessReason,
              lastValidated: nowIso,
            };
          }
        }

        return {
          ...rest,
          status,
          readiness:     _readiness,
          readinessReason: _readinessReason,
          lastValidated: nowIso,
        };
      });

      // ── Evidence debug metadata (in _debug, not in normal UI) ─────────────
      const decisionEvidenceDebug = withStatus
        .filter(d => d._evidence !== undefined)
        .map(d => ({
          rank:       d.rank,
          ticker:     d.ticker || d.company || "portfolio",
          decision:   d.decision,
          evidenceScore:     d._evidence!.evidenceScore,
          evidenceBand:      d._evidence!.evidenceBand,
          supportingModules: d._evidence!.supportingModules,
          opposingModules:   d._evidence!.opposingModules,
          neutralModules:    d._evidence!.neutralModules,
          missingModules:    d._evidence!.missingModules,
          staleModules:      d._evidence!.staleModules,
          gatePassed:        d._evidence!.gatePassed,
          gateFailureReason: d._evidence!.gateFailureReason,
          classifications:   d._evidence!.classifications.map(c => ({
            module: c.module, classification: c.classification, reason: c.reason,
          })),
        }));

      // Internal logging
      for (const ev of decisionEvidenceDebug) {
        systemLog.logInternal(
          MODULE_NAME,
          `[evidence] ${ev.ticker} (${ev.decision}): score=${ev.evidenceScore} ` +
          `band=${ev.evidenceBand} ` +
          `supporting=[${ev.supportingModules.join(",")}] ` +
          `opposing=[${ev.opposingModules.join(",")}]` +
          (ev.staleModules.length > 0 ? ` stale=[${ev.staleModules.join(",")}]` : "")
        );
      }

      const finalData = {
        ...parsed.data,
        decisions:          responseDecisions,
        nextReviewTriggers: filteredTriggers,
        timestamp:          nowIso,
        analysisDuration,
      };

      // ── Save ───────────────────────────────────────────────────────────────
      analysisRepository.save("trade-decision-engine", finalData);

      const existingHistory = historyEntry?.result?.entries ?? [];
      const newHistoryEntry: DecisionHistoryEntry = {
        timestamp:              nowIso,
        overallDecisionPosture: finalData.overallDecisionPosture,
        decisionReadinessScore: finalData.decisionReadinessScore,
        decisions: withStatus.map(d => ({
          subjectKey:    d._subjectKey,
          normalizedKey: d._normalizedKey,
          subjectType:   d.subjectType,
          company:       d.company,
          ticker:        d.ticker,
          decision:      d.decision,
          confidence:    d.confidence,
          urgency:       d.urgency,
          readiness:     d._readiness,
          evidenceScore: d._evidence?.evidenceScore,
          evidenceBand:  d._evidence?.evidenceBand,
          blockedByEvent:    d.blockedByEvent,
          blockingEvent:     d.blockingEvent,
          blockingEventDate: d.blockingEventDate,
          targetAllocationPercent:  d.targetAllocationPercent,
          maximumAllocationPercent: d.maximumAllocationPercent,
          sizingConfidence:         d.sizingConfidence,
          fingerprint:   d._fingerprint,
        })),
      };
      analysisRepository.save("trade-decision-engine-history", {
        entries: [newHistoryEntry, ...existingHistory].slice(0, MAX_HISTORY),
      });

      // ── Outcome tracking (non-blocking) ────────────────────────────────────
      try {
        const profileName = getActivePolicyProfile();
        const portfolioResult = portfolioEntry?.result as Record<string, unknown> | undefined;
        const portfolioVal =
          typeof portfolioResult?.totalValue === "number"
            ? (portfolioResult.totalValue as number)
            : null;

        for (const d of withStatus) {
          if (d.decision !== "PrepareToBuy" && d.decision !== "PrepareToReduce") continue;
          const ev = d._evidence;
          if (!ev) continue;

          // Company Monitor snapshot for outcome record
          const cmKey    = holdingCmKeys.get(d.ticker) ?? opCmKeys.get(d.ticker);
          const cmEntry  = cmKey ? allCmEntries.find(e => e.moduleName === cmKey) : undefined;
          const cmResult = cmEntry?.result as Record<string, unknown> | undefined;
          const cmStrength =
            typeof cmResult?.investmentCaseStrength === "number"
              ? (cmResult.investmentCaseStrength as number)
              : null;
          const cmChange  = cmResult?.investmentCaseChange as Record<string, unknown> | null | undefined;
          const cmSeverity = cmChange ? String(cmChange?.severity ?? "") || null : null;

          const outcomeInput: RecordOutcomeInput = {
            subjectDecisionId: `${(d.subjectType as string) ?? "Opportunity"}:${d.ticker}`,
            ticker:         d.ticker,
            company:        d.company,
            subjectType:    (d.subjectType as "Holding" | "Opportunity" | "Portfolio") ?? "Opportunity",
            decisionType:   d.decision as "PrepareToBuy" | "PrepareToReduce",
            decisionStatus: d._status as "New" | "Strengthened" | "Weakened" | "Unchanged",
            policyProfile:  profileName,
            isReadyForReview: d._readiness === "ReadyForReview",
            fingerprint:    d._fingerprint,

            evidenceScore:  ev.evidenceScore,
            evidenceBand:   ev.evidenceBand,
            confidence:     d.confidence as "High" | "Medium" | "Low",
            urgency:        (d.urgency as "Immediate" | "Days" | "Weeks" | "NoUrgency") ?? "NoUrgency",
            targetAllocationPercent:
              typeof d.targetAllocationPercent === "number" ? d.targetAllocationPercent : null,
            supportingModules: ev.supportingModules,
            opposingModules:   ev.opposingModules,

            companyMonitorStrength:           cmStrength,
            companyMonitorCaseChangeSeverity: cmSeverity,
            portfolioValueAtDecision:         portfolioVal,
          };

          recordDecisionOutcome(outcomeInput, d._fingerprint);
        }
      } catch (outcomeErr) {
        // Outcome tracking errors must never surface to the main TDE response
        systemLog.logInternal(
          MODULE_NAME,
          `Outcome tracking error: ${outcomeErr instanceof Error ? outcomeErr.message : String(outcomeErr)}`
        );
      }

      // ── System log ─────────────────────────────────────────────────────────
      systemLog.logInfo(MODULE_NAME, "Decision analysis completed");
      systemLog.logInternal(MODULE_NAME, `Active policy profile: ${policy.profile}`);
      systemLog.logInternal(
        MODULE_NAME,
        `Posture: ${finalData.overallDecisionPosture} | Readiness: ${finalData.decisionReadinessScore}/100`
      );

      const readyOnes    = responseDecisions.filter(d => d.readiness === "ReadyForReview");
      const waitingOnes  = responseDecisions.filter(d => d.readiness === "WaitingForReevaluation");
      const newOnes      = responseDecisions.filter(d => d.status    === "New");
      const changedOnes  = responseDecisions.filter(d => d.status    === "Strengthened" || d.status === "Weakened");
      const unchangedTrades = responseDecisions.filter(
        d => d.status === "Unchanged" && (d.decision === "PrepareToBuy" || d.decision === "PrepareToReduce")
      );

      if (readyOnes.length > 0) {
        systemLog.logInfo(
          MODULE_NAME,
          `${readyOnes.length} decision(s) ReadyForReview: ${readyOnes.map(d => d.ticker || d.company || "portfolio").join(", ")}`
        );
      }
      if (waitingOnes.length > 0)  systemLog.logInternal(MODULE_NAME, `${waitingOnes.length} WaitingForReevaluation`);
      if (newOnes.length > 0)      systemLog.logInternal(MODULE_NAME, `New: ${newOnes.map(d => d.title).join("; ")}`);
      if (changedOnes.length > 0)  systemLog.logInternal(MODULE_NAME, `Changed: ${changedOnes.map(d => `${d.status} ${d.title}`).join("; ")}`);
      if (unchangedTrades.length > 0) systemLog.logInternal(MODULE_NAME, `Preserved Unchanged: ${unchangedTrades.map(d => d.ticker || d.company || "portfolio").join(", ")}`);
      if (withdrawnDecisions.length > 0) systemLog.logInternal(MODULE_NAME, `Withdrawn (subject absent): ${withdrawnDecisions.map(d => d.ticker || d.company || "portfolio").join(", ")}`);
      if (gateLog.length > 0) systemLog.logInfo(MODULE_NAME, `Gate: ${gateLog.length} decision(s) downgraded`);

      clearTimeout(routeTimeoutHandle);
      res.json({ ...finalData, _debug: debug, _decisionEvidence: decisionEvidenceDebug });
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

  clearTimeout(routeTimeoutHandle);
  if (!res.headersSent) {
    res.status(504).json({
      error: "Trade Decision Engine timed out — analysis took too long",
      _debug: lastDebug,
    });
  }
});

export default router;
