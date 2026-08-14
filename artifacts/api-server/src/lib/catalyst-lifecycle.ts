/**
 * Catalyst Candidate Lifecycle (Part 3, spec §3)
 *
 * Defines the lifecycle state machine for a Catalyst candidate.
 * States are DERIVED from CatalystState fields — not stored separately
 * (avoids sync bugs). The pipeline uses this to decide what action to take.
 *
 * Lifecycle:
 *   DISCOVERED          → ticker exists in universe, never screened
 *   SCREENED_OUT        → screening ran, not eligible
 *   WATCHING            → eligible (BasicMonitor), waiting for signal
 *   RESEARCH_REQUIRED   → eligible (DeepAnalysis) but not yet analyzed
 *   MONITOR             → analysis ran, low interest
 *   INVESTIGATE         → analysis ran, Investigate state
 *   HIGH_INTEREST       → analysis ran, HighInterest/CandidateForTradeDecision
 *   PROMOTED            → promoted to Opportunity Finder
 *   STALE               → event passed, needs post-event reassessment
 *   FAILED              → too many consecutive failures — quarantined
 */

import type { CatalystState } from "./catalyst-types.js";
import { CATALYST_MAX_CONSECUTIVE_FAILURES } from "./catalyst-config.js";

// ── Lifecycle state type ──────────────────────────────────────────────────────

export type CatalystLifecycleState =
  | "DISCOVERED"
  | "SCREENED_OUT"
  | "WATCHING"
  | "RESEARCH_REQUIRED"
  | "MONITOR"
  | "INVESTIGATE"
  | "HIGH_INTEREST"
  | "PROMOTED"
  | "STALE"
  | "FAILED";

// ── Lifecycle derivation (pure function) ──────────────────────────────────────

/**
 * Derive the current lifecycle state from a CatalystState record.
 *
 * This is a pure deterministic function — the result can be cached but
 * the canonical value is always derived, never stored independently.
 */
export function deriveLifecycleState(state: CatalystState): CatalystLifecycleState {
  // FAILED: too many consecutive errors — quarantine
  if ((state.failureCount ?? 0) >= CATALYST_MAX_CONSECUTIVE_FAILURES) {
    return "FAILED";
  }

  // PROMOTED: already sent to Opportunity Finder
  if (state.promotedAt) {
    return "PROMOTED";
  }

  // Not yet screened
  if (!state.screening) {
    return "DISCOVERED";
  }

  // Screening ran but excluded
  if (!state.screening.eligible) {
    return "SCREENED_OUT";
  }

  // STALE: event passed and needs post-event reassessment
  if ((state as CatalystStateWithPart3).postEventAssessmentRequired) {
    return "STALE";
  }

  // Has analysis result — derive from opportunity state
  const opportunityState = state.analysis?.opportunityState;
  if (opportunityState) {
    switch (opportunityState) {
      case "HighInterest":
      case "CandidateForTradeDecision":
        return "HIGH_INTEREST";
      case "Investigate":
        return "INVESTIGATE";
      case "Monitor":
        return "MONITOR";
      case "NotInteresting":
        return "SCREENED_OUT";
    }
  }

  // Eligible, DeepAnalysis level, no analysis yet → needs research
  if (state.screening.screeningLevel === "DeepAnalysis" || state.screening.screeningLevel === "SignalAssessment") {
    return "RESEARCH_REQUIRED";
  }

  // BasicMonitor or watching for signals
  return "WATCHING";
}

// Type augmentation for Part 3 fields (avoids circular import)
interface CatalystStateWithPart3 {
  postEventAssessmentRequired?: boolean;
  failureCount?: number;
}

// ── Eligibility checks ────────────────────────────────────────────────────────

/**
 * Whether this candidate should be considered for automatic deep analysis.
 * Used by the pipeline to build the analysis queue.
 */
export function isEligibleForAutoAnalysis(state: CatalystState): boolean {
  const lifecycle = deriveLifecycleState(state);
  return (
    lifecycle === "RESEARCH_REQUIRED" ||
    lifecycle === "MONITOR" ||
    lifecycle === "INVESTIGATE" ||
    lifecycle === "HIGH_INTEREST" ||  // re-analyze if stale
    lifecycle === "WATCHING"          // PATH B emerging setup
  );
}

/**
 * Whether this candidate is eligible for post-event reassessment.
 */
export function needsPostEventReassessment(state: CatalystState): boolean {
  return !!(state as CatalystStateWithPart3).postEventAssessmentRequired;
}

/**
 * Whether this candidate is in backoff (failed recently, not yet eligible to retry).
 */
export function isInBackoff(state: CatalystState, nowIso: string): boolean {
  const retryEligibleAt = (state as CatalystStateWithPart3 & { retryEligibleAt?: string | null }).retryEligibleAt;
  if (!retryEligibleAt) return false;
  return new Date(retryEligibleAt).getTime() > new Date(nowIso).getTime();
}

// ── Lifecycle display helpers ─────────────────────────────────────────────────

/** Human-readable label for the lifecycle state. */
export function lifecycleStateLabel(state: CatalystLifecycleState): string {
  switch (state) {
    case "DISCOVERED":        return "Discovered";
    case "SCREENED_OUT":      return "Screened Out";
    case "WATCHING":          return "Watching";
    case "RESEARCH_REQUIRED": return "Research Required";
    case "MONITOR":           return "Monitor";
    case "INVESTIGATE":       return "Investigate";
    case "HIGH_INTEREST":     return "High Interest";
    case "PROMOTED":          return "Promoted";
    case "STALE":             return "Stale (Post-Event)";
    case "FAILED":            return "Failed";
  }
}

/** CSS-style badge color for the lifecycle state (used by the UI). */
export function lifecycleStateBadgeColor(state: CatalystLifecycleState): string {
  switch (state) {
    case "HIGH_INTEREST":     return "green";
    case "INVESTIGATE":       return "blue";
    case "PROMOTED":          return "purple";
    case "RESEARCH_REQUIRED": return "yellow";
    case "MONITOR":           return "gray";
    case "WATCHING":          return "gray";
    case "DISCOVERED":        return "gray";
    case "STALE":             return "orange";
    case "SCREENED_OUT":      return "gray";
    case "FAILED":            return "red";
  }
}
