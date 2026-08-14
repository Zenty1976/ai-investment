/**
 * Catalyst Screening Engine — Deterministic Multi-Stage Funnel
 *
 * Answers: "Is this company worth deep pre-earnings analysis right now?"
 *
 * All logic is deterministic. Zero AI calls. Zero Saxo calls.
 * The screening function is pure (accepts all inputs as parameters)
 * so it can be unit-tested without any repository or network access.
 *
 * Pipeline:
 *   1. Event eligibility  — Is there an upcoming event in range?
 *   2. Data availability  — Do we have enough price/company data?
 *   3. Company quality    — Is the company investable at all?
 *   4. Price asymmetry    — Has the market already moved?
 *   5. Signal relevance   — Do we have any meaningful leading indicators?
 *   6. Level assignment   — What depth of analysis is warranted?
 */

import { createHash } from "node:crypto";
import type {
  CatalystFacts,
  CatalystScreeningResult,
  CatalystScreeningConfig,
  PriceAsymmetry,
  PreEventOpportunityState,
  EvidenceConfidence,
  LeadingIndicatorSignal,
  SourceQualityCategory,
} from "./catalyst-types.js";
import { DEFAULT_CATALYST_SCREENING_CONFIG } from "./catalyst-types.js";

// ── Evidence confidence (deterministic) ────────────────────────────────────────

const HIGH_QUALITY_CATEGORIES: SourceQualityCategory[] = [
  "DirectCompany", "RegulatoryFiling", "OfficialStatistics",
  "IndustryData", "ReliableReporting", "AnalystData",
];

/**
 * Compute evidence confidence from a signals array.
 *
 * Key principle: ten repetitions of the same Reuters story should not produce
 * High confidence. Confidence requires INDEPENDENT sources of DIFFERENT TYPES.
 *
 * Exported for testing.
 */
export function computeEvidenceConfidence(
  signals: LeadingIndicatorSignal[]
): EvidenceConfidence {
  if (signals.length === 0) return "Low";

  // Deduplicate by source+sourceType pair to detect echo chambers
  const sourcePairs = new Set<string>();
  for (const s of signals) {
    sourcePairs.add(`${s.sourceType}|${s.source.toLowerCase().trim().slice(0, 40)}`);
  }
  const independentSourceCount = sourcePairs.size;

  // Detect full echo chambers: all signals from a single source name
  const uniqueSourceNames = new Set(signals.map(s => s.source.toLowerCase().trim().slice(0, 30)));
  if (uniqueSourceNames.size === 1 && signals.length > 1) {
    return "Low"; // echo chamber — same story repeated
  }

  // Count signals with genuinely high-quality, non-secondary sources
  const highQualitySignals = signals.filter(s => HIGH_QUALITY_CATEGORIES.includes(s.sourceQuality));
  const highQualityIndependent = new Set(
    highQualitySignals.map(s => `${s.sourceType}|${s.source.toLowerCase().trim().slice(0, 40)}`)
  );

  // Require multiple independent quality sources for High confidence
  if (highQualityIndependent.size >= 3 && independentSourceCount >= 3) return "High";
  if (independentSourceCount >= 2 && highQualitySignals.length >= 1)    return "Medium";
  return "Low";
}

// ── Preliminary state determination ────────────────────────────────────────────

/**
 * Determine the preliminary opportunity state from deterministic inputs.
 *
 * This is the SCREENING output, not the final analysis output.
 * The AI deep analysis (Part 2) can override this based on richer signals.
 *
 * Rules applied in order (most restrictive wins):
 *   R1. Negative investment view → NotInteresting
 *   R2. Weakening earnings trend + Poor/Weak asymmetry → NotInteresting
 *   R3. Strong converging positive signals → HighInterest
 *   R4. Positive signals with good asymmetry → Investigate
 *   R5. Default → Monitor
 */
export function determinePreliminaryState(
  investmentView: string | null,
  earningsGuidanceTrend: "Improving" | "Stable" | "Weakening" | null,
  priceAsymmetry: PriceAsymmetry,
  relevantSignalCount: number,
  evidenceConfidence: EvidenceConfidence
): PreEventOpportunityState {
  // R1: Negative company view — no point analyzing
  const negativeViews = ["Sell", "Strong Sell", "Reduce", "Negative", "Underperform"];
  if (investmentView && negativeViews.some(v => investmentView.includes(v))) {
    return "NotInteresting";
  }

  // R2: Structural deterioration (weakening + bad asymmetry)
  if (earningsGuidanceTrend === "Weakening" &&
      (priceAsymmetry === "Poor" || priceAsymmetry === "Weak")) {
    return "NotInteresting";
  }

  // R3: Strong converging positive signals — multiple independent high-quality signals
  const positiveViews = ["Buy", "Strong Buy", "Outperform", "Overweight", "Positive"];
  const isPositiveView = investmentView
    ? positiveViews.some(v => investmentView.includes(v))
    : false;
  const isGoodAsymmetry = priceAsymmetry === "VeryAttractive" || priceAsymmetry === "Attractive";
  const isImprovingTrend = earningsGuidanceTrend === "Improving";

  if (isGoodAsymmetry && isImprovingTrend && evidenceConfidence === "High") {
    return "HighInterest";
  }
  if (isGoodAsymmetry && isImprovingTrend && isPositiveView) {
    return "HighInterest";
  }

  // R4: Positive signals with reasonable asymmetry
  const hasReasonableAsymmetry =
    priceAsymmetry === "VeryAttractive" ||
    priceAsymmetry === "Attractive"     ||
    priceAsymmetry === "Neutral";

  if (hasReasonableAsymmetry && (isImprovingTrend || (isPositiveView && relevantSignalCount > 0))) {
    return "Investigate";
  }

  // R5: Poor asymmetry with positive view — market has already moved, still worth watching
  if (isPositiveView && (priceAsymmetry === "Weak" || priceAsymmetry === "Neutral")) {
    return "Monitor";
  }

  // R5: Default — eligible, keep watching
  return "Monitor";
}

// ── Material fingerprint ───────────────────────────────────────────────────────

/**
 * Compute a deterministic material fingerprint for a CatalystFacts object.
 *
 * The fingerprint captures DECISION-RELEVANT structured facts only.
 * Excluded: timestamps, prose, raw prices, minor daily noise.
 *
 * Changed fingerprint → new AI analysis warranted.
 * Same fingerprint → skip AI call (no material change).
 *
 * Returns a 12-character hex prefix of SHA-256 (sufficient for collision resistance
 * at the scale of a personal portfolio).
 */
export function computeCatalystFingerprint(facts: CatalystFacts): string {
  const pa = facts.price.priceAsymmetryFacts;

  const key = {
    // Event context (binned daysUntilEvent to 7-day buckets)
    eventDate:   facts.event.eventDate,
    daysBucket:  Math.floor(facts.event.daysUntilEvent / 7) * 7,
    eventType:   facts.event.eventType,

    // Price behavior (high-level categories — excludes minor daily noise)
    priceState:       facts.price.priceState,
    shortTermTrend:   facts.price.shortTermTrend,
    mediumTermTrend:  facts.price.mediumTermTrend,
    longTermTrend:    facts.price.longTermTrend,
    runupPattern:     pa.runupPattern,
    priceAsymmetry:   pa.asymmetry,

    // Binned returns (nearest 5%) — absorbs daily noise, captures directional shifts
    momentum30DBin: pa.momentum30D !== null ? Math.round(pa.momentum30D / 5) * 5 : null,
    momentum90DBin: pa.momentum90D !== null ? Math.round(pa.momentum90D / 5) * 5 : null,

    // Company-level state
    investmentView:         facts.company.investmentView,
    investmentCaseStrength: facts.company.investmentCaseStrength,
    earningsGuidanceTrend:  facts.company.earningsGuidanceTrend,

    // Signal fingerprint (sorted directions — order-independent)
    signalCount:      facts.signals.length,
    signalDirections: facts.signals
      .filter(s => s.direction !== "Neutral")
      .map(s => s.direction)
      .sort()
      .join(","),
    signalDrivers: facts.signals
      .map(s => s.driver)
      .sort()
      .slice(0, 5)  // cap for stability
      .join(","),
  };

  return createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 12);
}

// ── Screening inputs ───────────────────────────────────────────────────────────

export interface CatalystScreeningInputs {
  ticker: string;
  company: string;
  daysUntilEvent: number | null;
  priceAsymmetry: PriceAsymmetry;
  investmentView: string | null;
  earningsGuidanceTrend: "Improving" | "Stable" | "Weakening" | null;
  relevantSignalCount: number;
  signals: LeadingIndicatorSignal[];
  hasPriceContext: boolean;
  hasCompanyMonitor: boolean;
  facts: CatalystFacts;
  config?: CatalystScreeningConfig;
  screenedAt: string;
}

// ── Main screening function (pure — testable without repository) ───────────────

/**
 * Run the deterministic screening funnel for a single company.
 *
 * This is the ONLY public API of this module. All other functions are
 * exported separately for unit testing only.
 *
 * The function is PURE: it reads nothing from the global repository.
 * All data must be passed in via `inputs`.
 */
export function screenCatalystCandidate(
  inputs: CatalystScreeningInputs
): CatalystScreeningResult {
  const {
    ticker, company, daysUntilEvent, priceAsymmetry,
    investmentView, earningsGuidanceTrend,
    relevantSignalCount, signals, hasPriceContext,
    hasCompanyMonitor, facts, screenedAt,
  } = inputs;

  const config = inputs.config ?? DEFAULT_CATALYST_SCREENING_CONFIG;
  const reasons: string[] = [];
  const fingerprint = computeCatalystFingerprint(facts);

  // ── Stage 1: Event eligibility ─────────────────────────────────────────────
  if (daysUntilEvent === null) {
    return {
      ticker, company,
      eligible: false,
      screeningLevel: "Excluded",
      daysUntilEvent: null,
      preliminaryState: "NotInteresting",
      priceAsymmetry,
      screeningReasons: ["No upcoming catalyst event found within screening horizon"],
      exclusionReason: "NoUpcomingEvent",
      materialFingerprint: fingerprint,
      screenedAt,
    };
  }

  if (daysUntilEvent > config.maxDaysUntilEvent) {
    return {
      ticker, company,
      eligible: false,
      screeningLevel: "Excluded",
      daysUntilEvent,
      preliminaryState: "NotInteresting",
      priceAsymmetry,
      screeningReasons: [
        `Event is ${daysUntilEvent} days away — outside the ${config.maxDaysUntilEvent}-day screening window`,
      ],
      exclusionReason: "EventTooFar",
      materialFingerprint: fingerprint,
      screenedAt,
    };
  }

  if (daysUntilEvent < config.minDaysUntilEvent) {
    return {
      ticker, company,
      eligible: false,
      screeningLevel: "Excluded",
      daysUntilEvent,
      preliminaryState: "NotInteresting",
      priceAsymmetry,
      screeningReasons: [
        `Event is ${daysUntilEvent} day(s) away — too close to act on a pre-event thesis`,
      ],
      exclusionReason: "EventTooClose",
      materialFingerprint: fingerprint,
      screenedAt,
    };
  }

  // Event is within range — company is eligible for screening
  reasons.push(`Upcoming event in ${daysUntilEvent} days`);

  // ── Stage 2: Data availability ─────────────────────────────────────────────
  if (!hasPriceContext) {
    reasons.push("Price context unavailable — limited screening only");
  } else {
    reasons.push(`Price asymmetry: ${priceAsymmetry}`);
  }

  if (!hasCompanyMonitor) {
    reasons.push("Company Monitor entry unavailable — minimal context");
  } else if (investmentView) {
    reasons.push(`Investment view: ${investmentView}`);
  }

  // ── Stage 3: Company quality guard ─────────────────────────────────────────
  const negativeViews = ["Sell", "Strong Sell", "Reduce", "Negative", "Underperform"];
  const isNegativeView = investmentView
    ? negativeViews.some(v => investmentView.includes(v))
    : false;

  if (isNegativeView && hasPriceContext) {
    reasons.push(`Negative investment view (${investmentView}) — fundamentally unattractive`);
  }

  // ── Stage 4: Earnings trend ────────────────────────────────────────────────
  if (earningsGuidanceTrend) {
    reasons.push(`Earnings/guidance trend: ${earningsGuidanceTrend}`);
  }

  // ── Stage 5: Signals ───────────────────────────────────────────────────────
  const evidenceConfidence = computeEvidenceConfidence(signals);
  if (relevantSignalCount > 0) {
    reasons.push(
      `${relevantSignalCount} relevant signal(s) — evidence confidence: ${evidenceConfidence}`
    );
  } else {
    reasons.push("No leading indicator signals found in current data");
  }

  // ── Stage 6: Preliminary state ─────────────────────────────────────────────
  const preliminaryState = determinePreliminaryState(
    investmentView,
    earningsGuidanceTrend,
    priceAsymmetry,
    relevantSignalCount,
    evidenceConfidence
  );

  // ── Stage 7: Analysis level assignment ─────────────────────────────────────
  let screeningLevel: CatalystScreeningResult["screeningLevel"] = "BasicMonitor";

  if (!hasPriceContext || !hasCompanyMonitor) {
    screeningLevel = "BasicMonitor";
    reasons.push("BasicMonitor: insufficient data for deeper screening");
  } else if (daysUntilEvent <= config.deepAnalysisDaysThreshold) {
    screeningLevel = "DeepAnalysis";
    reasons.push(`DeepAnalysis: ${daysUntilEvent} days ≤ ${config.deepAnalysisDaysThreshold}-day threshold`);
  } else if (daysUntilEvent <= config.signalAssessmentDaysThreshold) {
    screeningLevel = "SignalAssessment";
    reasons.push(`SignalAssessment: ${daysUntilEvent} days ≤ ${config.signalAssessmentDaysThreshold}-day threshold`);
  } else {
    screeningLevel = "BasicMonitor";
    reasons.push(`BasicMonitor: ${daysUntilEvent} days — event not yet close enough for deep analysis`);
  }

  return {
    ticker, company,
    eligible: true,
    screeningLevel,
    daysUntilEvent,
    preliminaryState,
    priceAsymmetry,
    screeningReasons: reasons,
    exclusionReason: null,
    materialFingerprint: fingerprint,
    screenedAt,
  };
}
