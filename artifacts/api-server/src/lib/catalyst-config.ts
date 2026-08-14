/**
 * Catalyst Intelligence — Centralized Configuration (Part 3)
 *
 * Single source of truth for all budget limits and freshness rules.
 * No magic numbers scattered across route files.
 *
 * BUDGET LIMITS: apply per orchestrator cycle (12h interval by default).
 * FRESHNESS_MS: apply per ticker per module.
 */

// ── Per-cycle cost budgets ────────────────────────────────────────────────────

export interface CatalystBudgetConfig {
  /** Max tickers that get proactive event discovery via web search. */
  maxProactiveDiscoveriesPerCycle: number;
  /** Max new Driver Profiles generated in one cycle. */
  maxDriverProfilesPerCycle: number;
  /** Max tickers that get driver-directed signal research in one cycle. */
  maxDriverResearchPerCycle: number;
  /** Max tickers that get deep AI analysis in one cycle. */
  maxDeepAnalysesPerCycle: number;
  /** Max candidates considered for prioritized analysis queue. */
  analysisCandidateQueueSize: number;
}

/** Default per-cycle budget. Conservative — bias toward cost control. */
export const DEFAULT_CATALYST_BUDGET: CatalystBudgetConfig = {
  maxProactiveDiscoveriesPerCycle: 5,
  maxDriverProfilesPerCycle: 3,
  maxDriverResearchPerCycle: 5,
  maxDeepAnalysesPerCycle: 3,
  analysisCandidateQueueSize: 50,
};

// ── Freshness rules (milliseconds) ───────────────────────────────────────────

export interface CatalystFreshnessConfig {
  /** How long market universe entries stay valid before re-validation. */
  marketUniverseMs: number;
  /** How long a Driver Profile is considered fresh. */
  driverProfileMs: number;
  /** Minimum gap between proactive event discoveries per ticker. */
  eventDiscoveryMs: number;
  /** Minimum gap between driver-directed signal research runs per ticker. */
  signalResearchMs: number;
  /**
   * How fresh price context must be for an active (DeepAnalysis) candidate.
   * Uses the general price-context service — this is just the "stale" threshold.
   */
  priceContextActiveMs: number;
  /**
   * Minimum gap between deep AI analysis runs for the same candidate
   * (when fingerprint is unchanged). Force=true bypasses this.
   */
  deepAnalysisMs: number;
  /**
   * How long a CatalystState entry stays valid before the next screen
   * must run regardless of fingerprint.
   */
  screeningMs: number;
  /** Minimum backoff before a failed candidate is retried (base — squared by failureCount). */
  failureBackoffBaseMs: number;
  /** Maximum backoff for a failed candidate. */
  failureBackoffMaxMs: number;
}

/** Default freshness rules. */
export const DEFAULT_CATALYST_FRESHNESS: CatalystFreshnessConfig = {
  marketUniverseMs:      7  * 24 * 3_600_000,  // 7 days
  driverProfileMs:       7  * 24 * 3_600_000,  // 7 days
  eventDiscoveryMs:      48 * 3_600_000,        // 48 hours
  signalResearchMs:      24 * 3_600_000,        // 24 hours
  priceContextActiveMs:   4 * 3_600_000,        //  4 hours
  deepAnalysisMs:        12 * 3_600_000,        // 12 hours
  screeningMs:           12 * 3_600_000,        // 12 hours (matches orchestrator interval)
  failureBackoffBaseMs:  30 * 60_000,           // 30 min base
  failureBackoffMaxMs:   24 * 3_600_000,        // 24 hours max
};

// ── Failure isolation ─────────────────────────────────────────────────────────

/** After this many consecutive failures, the candidate enters FAILED state. */
export const CATALYST_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Compute retry backoff: `failureCount^2 * base`, capped at max.
 * Examples (base=30m): 1→30m, 2→2h, 3→4.5h → capped at 24h.
 */
export function computeRetryBackoff(
  failureCount: number,
  config: Pick<CatalystFreshnessConfig, "failureBackoffBaseMs" | "failureBackoffMaxMs"> = DEFAULT_CATALYST_FRESHNESS
): number {
  const backoff = Math.pow(failureCount, 2) * config.failureBackoffBaseMs;
  return Math.min(backoff, config.failureBackoffMaxMs);
}

// ── Dynamic depth rules ───────────────────────────────────────────────────────

/**
 * Whether this candidate's analysis is considered stale and should be refreshed.
 * Used to trigger analysis for candidates approaching their event.
 */
export function isCatalystAnalysisStale(
  lastAnalysedAtIso: string | null,
  daysUntilEvent: number | null,
  freshness: Pick<CatalystFreshnessConfig, "deepAnalysisMs"> = DEFAULT_CATALYST_FRESHNESS,
  /** Override current time (ms since epoch) — used for deterministic testing. */
  nowMs?: number
): boolean {
  if (!lastAnalysedAtIso) return true;
  const now = nowMs ?? Date.now();
  const ageMs = now - new Date(lastAnalysedAtIso).getTime();

  // Event approaching (< 3 days): always refresh if > 4h old
  if (daysUntilEvent !== null && daysUntilEvent <= 3) {
    return ageMs > 4 * 3_600_000;
  }
  // Event this week (3-7 days): refresh if > 12h old (default)
  if (daysUntilEvent !== null && daysUntilEvent <= 7) {
    return ageMs > freshness.deepAnalysisMs;
  }
  // Event further out / PATH B: refresh if > 24h old
  return ageMs > 24 * 3_600_000;
}

// ── Priority scoring ──────────────────────────────────────────────────────────

export interface PriorityScoringInputs {
  daysUntilEvent: number | null;
  eventType: string | null;
  preliminaryState: string | null;
  priceAsymmetry: string | null;
  inPortfolio: boolean;
  signalCount?: number;
  lastAnalysedAt?: string | null;
}

/** High-impact event types for prioritization. */
const HIGH_IMPACT_EVENT_TYPES = new Set([
  "Earnings", "ClinicalReadout", "RegulatoryDecision", "InvestorDay",
  "CapitalMarketsDay", "GuidanceUpdate",
]);

const MEDIUM_IMPACT_EVENT_TYPES = new Set([
  "ProductLaunch", "CompanyMeeting", "Other",
]);

/**
 * Compute a 0-100 priority score for a candidate.
 * Higher = should be analyzed sooner.
 *
 * Weights:
 *   - Proximity (30): event in 0d=30, 7d=20, 14d=10, 30d=0
 *   - Impact (25): high-impact event
 *   - Preliminary state (20): HighInterest/Investigate rank higher
 *   - Price attractiveness (15): VeryAttractive/Attractive
 *   - Portfolio bonus (10): portfolio holdings get priority
 */
export function computePriorityScore(inputs: PriorityScoringInputs): number {
  let score = 0;

  // Proximity component (0-30)
  const days = inputs.daysUntilEvent;
  if (days === null) {
    score += 5; // PATH B: modest baseline
  } else if (days <= 0) {
    score += 30;
  } else if (days <= 3) {
    score += 28;
  } else if (days <= 7) {
    score += 22;
  } else if (days <= 14) {
    score += 15;
  } else if (days <= 21) {
    score += 8;
  } else if (days <= 30) {
    score += 4;
  }

  // Event impact component (0-25)
  const et = inputs.eventType;
  if (et && HIGH_IMPACT_EVENT_TYPES.has(et)) {
    score += 25;
  } else if (et && MEDIUM_IMPACT_EVENT_TYPES.has(et)) {
    score += 12;
  }

  // Preliminary state component (0-20)
  switch (inputs.preliminaryState) {
    case "CandidateForTradeDecision": score += 20; break;
    case "HighInterest":              score += 18; break;
    case "Investigate":               score += 12; break;
    case "Monitor":                   score +=  5; break;
    default:                          break;
  }

  // Price attractiveness component (0-15)
  switch (inputs.priceAsymmetry) {
    case "VeryAttractive": score += 15; break;
    case "Attractive":     score += 10; break;
    case "Neutral":        score +=  3; break;
    case "Weak":           score +=  0; break;
    case "Poor":           score +=  0; break;
    default:               break;
  }

  // Portfolio bonus (0-10)
  if (inputs.inPortfolio) score += 10;

  return Math.min(100, Math.max(0, score));
}
