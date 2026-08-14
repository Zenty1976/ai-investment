/**
 * Emerging Setup Detection — Catalyst Intelligence PATH B (spec §11)
 *
 * Deterministic scoring: NO AI calls, NO Saxo calls.
 *
 * An "emerging setup" is a situation where multiple company drivers
 * are improving independently, without a specific known catalyst event
 * being on the calendar. This is PATH B discovery.
 *
 * Scoring factors:
 *   1. Signal accumulation — independent positive evidence groups
 *   2. Momentum — is the signal trend accelerating?
 *   3. Driver breadth — how many distinct drivers are improving?
 *   4. Price consistency — stock stabilizing after weakness (ideal entry)
 *   5. Evidence confidence — how independent are the sources?
 *   6. Contra-indicators — anything pointing the other way?
 *
 * EmergingSetupState thresholds (approximate):
 *   NONE          — <2 independent positive groups in 14D
 *   EARLY         — 2 independent groups, 1+ strengthening driver
 *   DEVELOPING    — 3+ independent groups, 2+ drivers, improving momentum
 *   STRONG        — 4+ independent groups, 3+ drivers, high confidence
 *   URGENT_REVIEW — STRONG + momentum ACCELERATING or confluence of timing
 */

import type {
  SignalAccumulationState,
  EmergingSetup,
  EmergingSetupState,
  EvidenceConfidence,
} from "./catalyst-types.js";

// ── Types for inputs ───────────────────────────────────────────────────────────

export interface EmergingSetupInputs {
  signalAccumulation: SignalAccumulationState;
  /** 5-day price return (null if unavailable). */
  momentum5D: number | null;
  /** 30-day price return (null if unavailable). */
  momentum30D: number | null;
  /** 90-day price return (null if unavailable). */
  momentum90D: number | null;
  /** Company Monitor overall status. */
  cmStatus: string | null;
  /** Sector Monitor direction. */
  sectorDirection: string | null;
  /** Whether this ticker already has a known upcoming event (PATH A). */
  hasKnownUpcomingEvent: boolean;
}

// ── Scoring logic ──────────────────────────────────────────────────────────────

interface ScoreBreakdown {
  independentGroupScore: number;   // 0–4
  momentumScore: number;           // 0–2
  driverBreadthScore: number;      // 0–3
  priceConsistencyScore: number;   // 0–2
  contradictionPenalty: number;    // negative
  total: number;
  reasons: string[];
  keyDrivers: string[];
  priceSetupConsistent: boolean;
}

function scorePriceConsistency(inputs: EmergingSetupInputs): {
  score: number;
  consistent: boolean;
  reason: string | null;
} {
  const { momentum5D, momentum30D, momentum90D } = inputs;
  if (momentum5D === null && momentum30D === null) {
    return { score: 0, consistent: false, reason: null };
  }

  // Ideal setup: stock was weak over 30-90D but stabilizing/recovering in 5D
  const wasWeak = (momentum90D !== null && momentum90D < -10) ||
                  (momentum30D !== null && momentum30D < -5);
  const isStabilizing = (momentum5D !== null && momentum5D > -2 && momentum5D < 8);
  const isRecovering = (momentum5D !== null && momentum5D >= 3 && momentum5D <= 15);

  if (wasWeak && isRecovering) {
    return { score: 2, consistent: true, reason: "Stock recovering from weakness — good entry timing" };
  }
  if (wasWeak && isStabilizing) {
    return { score: 1, consistent: true, reason: "Stock stabilizing after prior weakness" };
  }
  if (momentum30D !== null && momentum30D > 30) {
    return { score: -1, consistent: false, reason: "Stock already up >30% in 30D — risk of being priced in" };
  }
  // Flat/neutral is acceptable
  if (isStabilizing) {
    return { score: 1, consistent: true, reason: "Price action neutral — entry timing acceptable" };
  }
  return { score: 0, consistent: false, reason: null };
}

function computeScore(inputs: EmergingSetupInputs): ScoreBreakdown {
  const { signalAccumulation, sectorDirection } = inputs;
  const acc = signalAccumulation;

  const reasons: string[] = [];
  const keyDrivers = [...acc.strengtheningDrivers];

  // 1. Independent evidence groups (14D window — recency matters)
  const indepPositive = acc.window14D.independentPositiveGroups;
  let independentGroupScore = Math.min(indepPositive, 4);

  if (indepPositive === 0) reasons.push("No independent positive evidence groups in 14D");
  else if (indepPositive === 1) reasons.push("1 independent positive evidence group in 14D");
  else if (indepPositive >= 2) reasons.push(`${indepPositive} independent positive evidence groups in 14D`);

  // 2. Momentum
  let momentumScore = 0;
  if (acc.signalMomentum === "ACCELERATING") {
    momentumScore = 2;
    reasons.push("Signal momentum ACCELERATING");
  } else if (acc.signalMomentum === "IMPROVING") {
    momentumScore = 1;
    reasons.push("Signal momentum improving");
  } else if (acc.signalMomentum === "DETERIORATING" || acc.signalMomentum === "WEAKENING") {
    momentumScore = -1;
    reasons.push("Signal momentum weakening");
  }

  // 3. Driver breadth
  const driverCount = acc.strengtheningDrivers.length;
  let driverBreadthScore = Math.min(driverCount, 3);
  if (driverCount >= 2) reasons.push(`${driverCount} distinct business drivers improving`);

  // 4. Price setup
  const { score: priceScore, consistent: priceConsistent, reason: priceReason } =
    scorePriceConsistency(inputs);
  if (priceReason) reasons.push(priceReason);

  // 5. Contra-indicators penalty
  let contradictionPenalty = 0;
  if (acc.weakeningDrivers.length >= 2) {
    contradictionPenalty = -1;
    reasons.push(`${acc.weakeningDrivers.length} drivers weakening`);
  }
  if (acc.window14D.independentNegativeGroups >= acc.window14D.independentPositiveGroups) {
    contradictionPenalty -= 1;
    reasons.push("Negative evidence groups ≥ positive groups");
  }

  // 6. Sector tailwind bonus
  if (sectorDirection === "Bullish" || sectorDirection === "StronglyBullish") {
    reasons.push("Sector tailwind supporting setup");
    independentGroupScore = Math.min(independentGroupScore + 0.5, 4);
  }

  const total = independentGroupScore + momentumScore + driverBreadthScore +
                priceScore + contradictionPenalty;

  return {
    independentGroupScore,
    momentumScore,
    driverBreadthScore,
    priceConsistencyScore: priceScore,
    contradictionPenalty,
    total,
    reasons,
    keyDrivers,
    priceSetupConsistent: priceConsistent,
  };
}

function classifyState(score: ScoreBreakdown, inputs: EmergingSetupInputs): EmergingSetupState {
  const { total, momentumScore } = score;
  const { hasKnownUpcomingEvent } = inputs;

  // PATH A trumps PATH B — if there's a known event, PATH B doesn't trigger standalone
  if (hasKnownUpcomingEvent) return "NONE";

  if (total >= 7 && momentumScore >= 1) return "URGENT_REVIEW";
  if (total >= 5) return "STRONG";
  if (total >= 3 && score.independentGroupScore >= 2) return "DEVELOPING";
  if (total >= 1.5 && score.independentGroupScore >= 1) return "EARLY";
  return "NONE";
}

function classifyConfidence(score: ScoreBreakdown): EvidenceConfidence {
  if (score.independentGroupScore >= 3 && score.driverBreadthScore >= 2) return "High";
  if (score.independentGroupScore >= 2) return "Medium";
  return "Low";
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Detect and score an emerging setup (PATH B) from signal accumulation + price data.
 *
 * Pure function — deterministic given the same inputs.
 * Use this ONLY when there is no known upcoming scheduled event (PATH A).
 * If PATH A applies, don't run PATH B — the known event IS the catalyst.
 */
export function detectEmergingSetup(inputs: EmergingSetupInputs): EmergingSetup {
  const now = new Date().toISOString();
  const score = computeScore(inputs);
  const state = classifyState(score, inputs);
  const confidence = classifyConfidence(score);

  return {
    state,
    reasons: score.reasons,
    keyDrivers: score.keyDrivers,
    priceSetupConsistent: score.priceSetupConsistent,
    evidenceConfidence: confidence,
    computedAt: now,
  };
}

/**
 * Whether this emerging setup is strong enough to warrant deep AI analysis.
 * Must be DEVELOPING, STRONG, or URGENT_REVIEW.
 */
export function emergingSetupWarrantsAnalysis(setup: EmergingSetup): boolean {
  return setup.state === "DEVELOPING" ||
         setup.state === "STRONG" ||
         setup.state === "URGENT_REVIEW";
}

/** Human-readable label for UI display. */
export function emergingSetupLabel(state: EmergingSetupState): string {
  switch (state) {
    case "NONE": return "No Setup";
    case "EARLY": return "Early Signals";
    case "DEVELOPING": return "Developing";
    case "STRONG": return "Strong Setup";
    case "URGENT_REVIEW": return "Urgent Review";
  }
}

/** Badge color class for UI. */
export function emergingSetupColorClass(state: EmergingSetupState): string {
  switch (state) {
    case "NONE": return "text-muted-foreground";
    case "EARLY": return "text-blue-500";
    case "DEVELOPING": return "text-yellow-500";
    case "STRONG": return "text-orange-500";
    case "URGENT_REVIEW": return "text-red-500";
  }
}
