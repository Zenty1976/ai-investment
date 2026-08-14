/**
 * Catalyst Candidate Lifecycle (Part 3, spec §2)
 *
 * Defines the lifecycle state machine for a Catalyst candidate.
 * States are DERIVED from CatalystState fields — not stored separately
 * (avoids sync bugs). The pipeline uses this to decide what action to take.
 *
 * Lifecycle:
 *   DISCOVERED          → ticker exists in universe, never screened
 *   SCREENED_OUT        → screening ran, not eligible
 *   WATCHING            → eligible (BasicMonitor), waiting for signal
 *   RESEARCH_REQUIRED   → eligible (DeepAnalysis/SignalAssessment), no prior analysis
 *   ANALYSIS_REQUIRED   → eligible, has prior analysis that is now stale
 *   DEFERRED            → analysis warranted but over budget this cycle
 *   MONITOR             → analysis ran, low interest, analysis is fresh
 *   INVESTIGATE         → analysis ran, Investigate state, analysis is fresh
 *   HIGH_INTEREST       → analysis ran, HighInterest/CandidateForTradeDecision, fresh
 *   PROMOTED            → promoted to Opportunity Finder
 *   STALE               → event passed, needs post-event reassessment
 *   FAILED              → too many consecutive failures — quarantined
 */

import type { CatalystState } from "./catalyst-types.js";
import {
  CATALYST_MAX_CONSECUTIVE_FAILURES,
  isCatalystAnalysisStale,
  DEFAULT_CATALYST_FRESHNESS,
} from "./catalyst-config.js";

// ── Lifecycle state type ──────────────────────────────────────────────────────

export type CatalystLifecycleState =
  | "DISCOVERED"
  | "SCREENED_OUT"
  | "WATCHING"
  | "RESEARCH_REQUIRED"    // first-time deep analysis needed (no prior analysis)
  | "ANALYSIS_REQUIRED"    // has prior analysis but it is stale — needs refresh
  | "DEFERRED"             // warranted analysis, deferred due to budget this cycle
  | "MONITOR"              // fresh analysis, low interest
  | "INVESTIGATE"          // fresh analysis, investigate-level interest
  | "HIGH_INTEREST"        // fresh analysis, high interest / candidate for trade
  | "PROMOTED"             // sent to Opportunity Finder
  | "STALE"               // event passed, post-event reassessment needed
  | "FAILED";             // too many consecutive failures — quarantined

// Type augmentation for Part 3 fields (avoids circular import)
interface CatalystStateWithPart3 {
  postEventAssessmentRequired?: boolean;
  failureCount?: number;
  retryEligibleAt?: string | null;
  deferredUntil?: string | null;
  deferredReason?: string | null;
}

// ── Lifecycle derivation (pure function) ──────────────────────────────────────

/**
 * Derive the current lifecycle state from a CatalystState record.
 *
 * This is a deterministic function that uses the current time for staleness
 * and deferral checks. Pass `nowIso` for deterministic test control.
 *
 * The canonical lifecycle value is always derived — never stored independently.
 */
export function deriveLifecycleState(
  state: CatalystState,
  nowIso?: string
): CatalystLifecycleState {
  const nowMs = nowIso ? new Date(nowIso).getTime() : Date.now();

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

  // STALE: event passed and needs post-event reassessment (highest urgency)
  if ((state as CatalystStateWithPart3).postEventAssessmentRequired) {
    return "STALE";
  }

  // DEFERRED: over budget this cycle — will be reconsidered next cycle
  const deferredUntil = (state as CatalystStateWithPart3).deferredUntil;
  if (deferredUntil && new Date(deferredUntil).getTime() > nowMs) {
    return "DEFERRED";
  }

  // Eligible candidates — check analysis status
  const opportunityState = state.analysis?.opportunityState;

  if (opportunityState) {
    // Has a prior analysis — check if it is stale
    const isStale = isCatalystAnalysisStale(
      state.lastAnalysedAt ?? null,
      state.facts?.event?.daysUntilEvent ?? null,
      DEFAULT_CATALYST_FRESHNESS,
      nowMs
    );

    if (isStale) {
      // Stale analysis needs a refresh
      return "ANALYSIS_REQUIRED";
    }

    // Fresh analysis — derive from opportunity state
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

  // Eligible, no prior analysis — needs initial deep research
  if (
    state.screening.screeningLevel === "DeepAnalysis" ||
    state.screening.screeningLevel === "SignalAssessment"
  ) {
    return "RESEARCH_REQUIRED";
  }

  // BasicMonitor or watching for signals (PATH B emerging setup)
  return "WATCHING";
}

// ── Eligibility checks ────────────────────────────────────────────────────────

/**
 * Whether this candidate should be considered for automatic deep analysis.
 * Used by the pipeline to build the analysis queue.
 *
 * Returns true for any lifecycle state that warrants AI analysis.
 * Backoff and deferral are checked separately (isInBackoff / DEFERRED state).
 */
export function isEligibleForAutoAnalysis(state: CatalystState, nowIso?: string): boolean {
  const lifecycle = deriveLifecycleState(state, nowIso);
  return (
    lifecycle === "RESEARCH_REQUIRED" ||
    lifecycle === "ANALYSIS_REQUIRED" ||  // stale — needs refresh
    lifecycle === "MONITOR" ||
    lifecycle === "INVESTIGATE" ||
    lifecycle === "HIGH_INTEREST" ||      // re-analyze if stale
    lifecycle === "WATCHING" ||           // PATH B emerging setup
    lifecycle === "STALE"                 // post-event reassessment required
  );
}

/**
 * Whether this candidate needs post-event reassessment.
 */
export function needsPostEventReassessment(state: CatalystState): boolean {
  return !!(state as CatalystStateWithPart3).postEventAssessmentRequired;
}

/**
 * Whether this candidate is in backoff (failed recently, not yet eligible to retry).
 */
export function isInBackoff(state: CatalystState, nowIso: string): boolean {
  const retryEligibleAt = (state as CatalystStateWithPart3).retryEligibleAt;
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
    case "ANALYSIS_REQUIRED": return "Analysis Required";
    case "DEFERRED":          return "Deferred";
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
    case "ANALYSIS_REQUIRED": return "yellow";
    case "MONITOR":           return "gray";
    case "WATCHING":          return "gray";
    case "DISCOVERED":        return "gray";
    case "DEFERRED":          return "orange";
    case "STALE":             return "orange";
    case "SCREENED_OUT":      return "gray";
    case "FAILED":            return "red";
  }
}
