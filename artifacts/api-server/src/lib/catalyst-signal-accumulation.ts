/**
 * Signal Accumulation State — Catalyst Intelligence (spec §10)
 *
 * Deterministic computation over stored signals across time windows.
 * NO AI calls. NO Saxo calls.
 *
 * Source independence (spec §7):
 *   - Groups signals by sourceOriginId into IndependentEvidenceGroups
 *   - independentPositiveGroups counts distinct source origins
 *   - Prevents ten Reuters re-publications from counting as ten positives
 *
 * Windows: 7D, 14D, 30D
 * Each window is CUMULATIVE (30D includes 14D includes 7D).
 */

import type {
  LeadingIndicatorSignal,
  SignalAccumulationState,
  SignalWindowStats,
  IndependentEvidenceGroup,
  SignalMomentum,
  SignalOverallDirection,
  EvidenceConfidence,
  SignalDirection,
} from "./catalyst-types.js";

// ── Window computation ─────────────────────────────────────────────────────────

function isWithinWindow(signal: LeadingIndicatorSignal, windowDays: number, nowIso: string): boolean {
  const now = new Date(nowIso).getTime();
  const signalDate = new Date(signal.availableAt ?? signal.observationDate).getTime();
  const diffDays = (now - signalDate) / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= windowDays;
}

function isMaterial(signal: LeadingIndicatorSignal): boolean {
  return signal.direction !== "Neutral" && signal.freshness !== "Stale";
}

/**
 * Extract the canonical source origin ID from a signal.
 * Falls back to sourceType+source if sourceOriginId not set.
 */
function resolveSourceOriginId(signal: LeadingIndicatorSignal): string {
  if (signal.sourceOriginId) return signal.sourceOriginId;
  // Derive from source name — strip URL to domain
  const src = signal.source ?? "";
  try {
    const url = new URL(src);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return src.toLowerCase().replace(/\s+/g, "-").slice(0, 50);
  }
}

function computeWindowStats(
  signals: LeadingIndicatorSignal[],
  windowDays: number,
  nowIso: string
): SignalWindowStats {
  const windowSignals = signals.filter(s => isWithinWindow(s, windowDays, nowIso));

  let positiveMaterialSignals = 0;
  let negativeMaterialSignals = 0;
  let neutralSignals = 0;

  const positiveOrigins = new Set<string>();
  const negativeOrigins = new Set<string>();

  for (const s of windowSignals) {
    const originId = resolveSourceOriginId(s);
    if (!isMaterial(s)) {
      neutralSignals++;
      continue;
    }
    if (s.direction === "Positive" || s.direction === "StronglyPositive") {
      positiveMaterialSignals++;
      positiveOrigins.add(originId);
    } else if (s.direction === "Negative" || s.direction === "StronglyNegative") {
      negativeMaterialSignals++;
      negativeOrigins.add(originId);
    } else {
      neutralSignals++;
    }
  }

  return {
    positiveMaterialSignals,
    negativeMaterialSignals,
    neutralSignals,
    independentPositiveGroups: positiveOrigins.size,
    independentNegativeGroups: negativeOrigins.size,
  };
}

// ── Evidence grouping ──────────────────────────────────────────────────────────

function buildEvidenceGroups(signals: LeadingIndicatorSignal[]): IndependentEvidenceGroup[] {
  const groupMap = new Map<string, IndependentEvidenceGroup>();

  for (const s of signals) {
    const originId = resolveSourceOriginId(s);
    const existing = groupMap.get(originId);

    const netDir: SignalDirection =
      s.direction === "Positive" || s.direction === "StronglyPositive" ? "Positive"
      : s.direction === "Negative" || s.direction === "StronglyNegative" ? "Negative"
      : "Neutral";

    if (!existing) {
      groupMap.set(originId, {
        groupId: `eg-${originId.replace(/[^a-z0-9]/gi, "-")}`,
        sourceOriginId: originId,
        canonicalSource: s.canonicalSource ?? s.source,
        signalIds: [s.signalId],
        netDirection: netDir,
      });
    } else {
      existing.signalIds.push(s.signalId);
      // Majority direction within group
      const positive = signals.filter(sig => existing.signalIds.includes(sig.signalId) && (sig.direction === "Positive" || sig.direction === "StronglyPositive")).length;
      const negative = signals.filter(sig => existing.signalIds.includes(sig.signalId) && (sig.direction === "Negative" || sig.direction === "StronglyNegative")).length;
      existing.netDirection = positive > negative ? "Positive" : negative > positive ? "Negative" : "Neutral";
    }
  }

  return [...groupMap.values()];
}

// ── Momentum & direction ───────────────────────────────────────────────────────

function computeMomentum(
  window7D: SignalWindowStats,
  window14D: SignalWindowStats,
  window30D: SignalWindowStats
): SignalMomentum {
  // Compare recent (7D) vs broader (14D and 30D) signal quality
  const r7 = window7D.independentPositiveGroups - window7D.independentNegativeGroups;
  const r14 = window14D.independentPositiveGroups - window14D.independentNegativeGroups;
  const r30 = window30D.independentPositiveGroups - window30D.independentNegativeGroups;

  if (r7 > r14 && r14 > r30 && r7 >= 2) return "ACCELERATING";
  if (r7 > r14 && r7 >= 1) return "IMPROVING";
  if (r7 < r14 && r14 < r30 && r7 <= -2) return "DETERIORATING";
  if (r7 < r14 && r7 <= -1) return "WEAKENING";
  return "STABLE";
}

function computeOverallDirection(window30D: SignalWindowStats): SignalOverallDirection {
  const net = window30D.independentPositiveGroups - window30D.independentNegativeGroups;
  if (net >= 4) return "STRONGLY_POSITIVE";
  if (net >= 2) return "POSITIVE";
  if (net <= -4) return "STRONGLY_NEGATIVE";
  if (net <= -2) return "NEGATIVE";

  const total = window30D.positiveMaterialSignals + window30D.negativeMaterialSignals;
  if (total < 2) return "NEUTRAL";
  if (window30D.positiveMaterialSignals > window30D.negativeMaterialSignals * 1.5) return "POSITIVE";
  if (window30D.negativeMaterialSignals > window30D.positiveMaterialSignals * 1.5) return "NEGATIVE";
  return "MIXED";
}

function computeEvidenceConfidence(
  window30D: SignalWindowStats,
  evidenceGroups: IndependentEvidenceGroup[]
): EvidenceConfidence {
  const indepPositive = window30D.independentPositiveGroups;
  const total = window30D.positiveMaterialSignals + window30D.negativeMaterialSignals;

  if (indepPositive >= 3 && total >= 5) return "High";
  if (indepPositive >= 2 && total >= 3) return "Medium";
  return "Low";
}

// ── Driver analysis ────────────────────────────────────────────────────────────

function findDriverTrends(signals: LeadingIndicatorSignal[]): {
  strengthening: string[];
  weakening: string[];
} {
  // Group by driver
  const driverMap = new Map<string, { positive: number; negative: number }>();

  for (const s of signals) {
    if (!isMaterial(s)) continue;
    const driver = s.driver;
    const existing = driverMap.get(driver) ?? { positive: 0, negative: 0 };
    if (s.direction === "Positive" || s.direction === "StronglyPositive") {
      existing.positive++;
    } else if (s.direction === "Negative" || s.direction === "StronglyNegative") {
      existing.negative++;
    }
    driverMap.set(driver, existing);
  }

  const strengthening: string[] = [];
  const weakening: string[] = [];

  for (const [driver, counts] of driverMap) {
    if (counts.positive >= 2 && counts.positive > counts.negative) strengthening.push(driver);
    if (counts.negative >= 2 && counts.negative > counts.positive) weakening.push(driver);
  }

  return { strengthening, weakening };
}

// ── New signals & contradictions ───────────────────────────────────────────────

function findNewSignals(
  signals: LeadingIndicatorSignal[],
  previousSignalIds: string[],
): string[] {
  const prev = new Set(previousSignalIds);
  return signals
    .filter(s => !prev.has(s.signalId) && isMaterial(s))
    .map(s => s.signalId);
}

function findContradictorySignals(
  signals: LeadingIndicatorSignal[],
  overallDirection: SignalOverallDirection
): string[] {
  const isPositive = overallDirection === "POSITIVE" || overallDirection === "STRONGLY_POSITIVE";
  const isNegative = overallDirection === "NEGATIVE" || overallDirection === "STRONGLY_NEGATIVE";

  return signals
    .filter(s => {
      if (isPositive) return s.direction === "Negative" || s.direction === "StronglyNegative";
      if (isNegative) return s.direction === "Positive" || s.direction === "StronglyPositive";
      return false;
    })
    .map(s => s.signalId);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Compute signal accumulation state from the given signals array.
 *
 * @param ticker - Ticker symbol for labeling
 * @param signals - All signals for this ticker (from CatalystFacts or history)
 * @param previousSignalIds - Signal IDs from the previous assessment (for new-signal detection)
 * @param nowIso - ISO timestamp for window computation (default: now)
 */
export function computeSignalAccumulationState(
  ticker: string,
  signals: LeadingIndicatorSignal[],
  previousSignalIds: string[] = [],
  nowIso?: string
): SignalAccumulationState {
  const now = nowIso ?? new Date().toISOString();

  // Build windows
  const window7D  = computeWindowStats(signals, 7,  now);
  const window14D = computeWindowStats(signals, 14, now);
  const window30D = computeWindowStats(signals, 30, now);

  // Evidence groups (all signals, for dedup tracking)
  const evidenceGroups = buildEvidenceGroups(signals);

  // Momentum & direction
  const signalMomentum = computeMomentum(window7D, window14D, window30D);
  const overallDirection = computeOverallDirection(window30D);
  const evidenceConfidence = computeEvidenceConfidence(window30D, evidenceGroups);

  // Driver trends
  const { strengthening, weakening } = findDriverTrends(signals);

  // New signals since previous assessment
  const newSignalsSinceLastAssessment = findNewSignals(signals, previousSignalIds);

  // Contradictory signals vs overall direction
  const contradictorySignals = findContradictorySignals(signals, overallDirection);

  return {
    ticker,
    computedAt: now,
    window7D,
    window14D,
    window30D,
    strengtheningDrivers: strengthening,
    weakeningDrivers: weakening,
    newSignalsSinceLastAssessment,
    contradictorySignals,
    evidenceGroups,
    signalMomentum,
    overallDirection,
    evidenceConfidence,
  };
}

/**
 * Determine whether new material signals warrant a fresh AI analysis.
 * Returns true if the accumulation state has materially changed.
 */
export function hasMaterialAccumulationChange(
  prev: SignalAccumulationState | null,
  current: SignalAccumulationState
): boolean {
  if (!prev) return true;

  // New independent evidence groups
  if (current.window14D.independentPositiveGroups !== prev.window14D.independentPositiveGroups) return true;
  if (current.window14D.independentNegativeGroups !== prev.window14D.independentNegativeGroups) return true;

  // Momentum change
  if (current.signalMomentum !== prev.signalMomentum) return true;

  // Direction change
  if (current.overallDirection !== prev.overallDirection) return true;

  // New signals in 7D window
  if (current.newSignalsSinceLastAssessment.length >= 2) return true;

  return false;
}
