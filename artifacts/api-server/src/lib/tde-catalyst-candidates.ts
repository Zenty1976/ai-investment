/**
 * TDE Catalyst Candidate Collection (spec §1, §5, §6)
 *
 * Pure, pino-free helper that lifts active Catalyst HighInterest /
 * CandidateForTradeDecision promotions into explicit Trade Decision
 * Engine decision candidates — complementing the Opportunity Finder
 * top-5 without forcing them into OF's output.
 *
 * Key rules:
 *  - Only HighInterest and CandidateForTradeDecision qualify (§6).
 *  - Tickers already present in OF topOpportunities are deduplicated
 *    out — OF + Catalyst context are merged for those tickers (§5).
 *  - Capped at CATALYST_TDE_CANDIDATE_CAP to control token cost (§6).
 *  - Does NOT constitute an automatic buy recommendation (§3).
 */

import type {
  CatalystPromotion,
  CatalystDirection,
  TriggerType,
  PreEventOpportunityState,
  EvidenceConfidence,
  PriceAsymmetry,
} from "./catalyst-types.js";

/** Max catalyst-only TDE candidates (cost control). */
export const CATALYST_TDE_CANDIDATE_CAP = 5;

/** States that qualify a promotion for TDE decision evaluation. */
export const TDE_QUALIFYING_STATES: ReadonlySet<PreEventOpportunityState> = new Set([
  "HighInterest",
  "CandidateForTradeDecision",
]);

export interface CatalystTdeCandidate {
  ticker: string;
  company: string;
  /** Always "CatalystIntelligence" — distinguishes from OF candidates. */
  source: "CatalystIntelligence";
  triggerType: TriggerType;
  eventDate: string | null;
  catalystDirection: CatalystDirection;
  opportunityState: PreEventOpportunityState;
  evidenceConfidence: EvidenceConfidence;
  priceAsymmetry: PriceAsymmetry;
  thesis: string;
}

/**
 * Build the list of Catalyst promotions that should become explicit TDE
 * decision candidates (not just non-actionable context).
 *
 * @param ofTopOpportunities  Array of OF output objects with a `ticker` field.
 *                            Used for deduplication only — shape is intentionally
 *                            loose so the route can pass its raw slice directly.
 * @param activePromotions    Result of getActivePromotions() from catalyst-promotion.
 */
export function buildCatalystTdeCandidates(
  ofTopOpportunities: ReadonlyArray<{ ticker?: unknown }>,
  activePromotions: ReadonlyArray<CatalystPromotion>
): CatalystTdeCandidate[] {
  // Build a set of tickers already covered by OF (case-insensitive)
  const ofTickerSet = new Set(
    ofTopOpportunities.map(o => String(o.ticker ?? "").toUpperCase())
  );

  return activePromotions
    .filter(p => TDE_QUALIFYING_STATES.has(p.opportunityState))   // qualifying states only
    .filter(p => !ofTickerSet.has(p.ticker.toUpperCase()))         // deduplicate vs OF
    .slice(0, CATALYST_TDE_CANDIDATE_CAP)                          // cost cap
    .map(p => ({
      ticker:              p.ticker,
      company:             p.company,
      source:              "CatalystIntelligence" as const,
      triggerType:         p.triggerType,
      eventDate:           p.eventDate,
      catalystDirection:   p.catalystDirection,
      opportunityState:    p.opportunityState,
      evidenceConfidence:  p.evidenceConfidence,
      priceAsymmetry:      p.priceAsymmetry,
      thesis:              p.thesis,
    }));
}
