/**
 * Portfolio Replacement Detector
 *
 * Identifies holdings that could be replaced by Opportunity Finder candidates
 * with materially stronger analytical evidence.
 *
 * Comparisons are grounded in comparable structured evidence:
 *
 * For the held company (from Company Monitor + Trade Decision):
 *   - investmentCaseStrength  (0–100) — primary score
 *   - investmentView.rating   — directional view
 *   - investmentCaseChange    — strengthening / weakening trend
 *   - thesis point statuses   — how many are Weakened or Invalidated
 *   - TDE direction + evidenceBand — if PrepareToReduce with Strong evidence, heavier penalty
 *
 * For the candidate (from Opportunity Finder + Company Monitor + Trade Decision):
 *   - OF overallScore         — primary score
 *   - CM investmentCaseStrength if available — corroborating evidence
 *   - TDE evidenceBand for PrepareToBuy — buying support
 *   - Portfolio fit and diversification benefit
 *
 * If Company Monitor is missing for the holding → mark comparison as Provisional.
 * If Trade Decision blocks the candidate → exclude from replacements.
 *
 * No AI calls — purely deterministic.
 */

import type { PortfolioSnapshot } from "../routes/portfolio-manager.js";
import type { ReplacementOpportunity } from "./portfolio-manager-v2-types.js";

// ── External context shapes ───────────────────────────────────────────────────

export interface OpportunityCandidate {
  ticker: string;
  company: string;
  overallScore: number;
  priority?: string;
  investmentThesis?: string[];
  mainCatalyst?: string;
  sector?: string;
}

export interface CmReplacementData {
  investmentCaseStrength?: number;   // 0–100
  investmentViewRating?: string;     // "Strong Buy" | "Buy" | "Watch" | "Avoid" | "Strong Avoid"
  investmentCaseChange?: {
    changed: boolean;
    severity?: string;               // "None" | "Low" | "Medium" | "High"
  };
  thesisPointStatuses?: Array<{ status: string }>;
}

export interface TdeReplacementData {
  decision?: string;          // "PrepareToBuy" | "PrepareToReduce" | "Review" | "NoAction" | "Hold"
  evidenceBand?: string;      // "Strong" | "Adequate" | "Weak"
  readiness?: string;
  blockedByEvent?: boolean;
}

// ── Score helpers ─────────────────────────────────────────────────────────────

const VIEW_SCORE: Record<string, number> = {
  "Strong Buy":   90,
  "Buy":          75,
  "Watch":        50,
  "Avoid":        25,
  "Strong Avoid": 10,
};

const EVIDENCE_BONUS: Record<string, number> = {
  Strong:   10,
  Adequate:  5,
  Weak:      0,
};

const SCORE_DELTA_THRESHOLD = 20;

/**
 * Compute a composite holding quality score (0–100) from CM + TDE data.
 * Returns { score, hasCmData }.
 */
function holdingQualityScore(
  cm: CmReplacementData | undefined,
  tde: TdeReplacementData | undefined
): { score: number; hasCmData: boolean } {
  if (!cm) {
    // No CM data — use a neutral default; caller marks comparison as Provisional
    return { score: 50, hasCmData: false };
  }

  let score = cm.investmentCaseStrength ?? 50;

  // Adjust for investment view
  const viewScore = cm.investmentViewRating ? VIEW_SCORE[cm.investmentViewRating] ?? 50 : 50;
  score = score * 0.6 + viewScore * 0.4;

  // Penalise for weakening or high-severity change
  if (cm.investmentCaseChange?.changed) {
    const severity = cm.investmentCaseChange.severity ?? "Low";
    const penalty = severity === "High" ? 15 : severity === "Medium" ? 8 : 3;
    score -= penalty;
  }

  // Penalise for weakened/invalidated thesis points
  if (Array.isArray(cm.thesisPointStatuses)) {
    const weak = cm.thesisPointStatuses.filter(
      (t) => t.status === "Weakened" || t.status === "Invalidated"
    ).length;
    score -= weak * 6;
  }

  // Penalise when TDE recommends reduction with strong evidence
  if (tde?.decision === "PrepareToReduce") {
    const penalty = tde.evidenceBand === "Strong" ? 20 : tde.evidenceBand === "Adequate" ? 12 : 6;
    score -= penalty;
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), hasCmData: true };
}

/**
 * Compute a composite candidate quality score (0–100) from OF + CM + TDE.
 */
function candidateQualityScore(
  of: OpportunityCandidate,
  cm: CmReplacementData | undefined,
  tde: TdeReplacementData | undefined
): number {
  let score = of.overallScore;

  // Corroborate with CM
  if (cm?.investmentCaseStrength != null) {
    score = score * 0.5 + cm.investmentCaseStrength * 0.5;
  }

  // Boost when TDE supports buying with strong evidence
  if (tde?.decision === "PrepareToBuy") {
    score += EVIDENCE_BONUS[tde.evidenceBand ?? "Weak"] ?? 0;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function detectReplacements(
  snapshot: PortfolioSnapshot,
  opportunityCandidates: OpportunityCandidate[],
  companyMonitorByTicker: Map<string, CmReplacementData>,
  tdeByTicker: Map<string, TdeReplacementData>
): ReplacementOpportunity[] {
  const allPositions = snapshot.accounts.flatMap((a) => a.positions);
  const totalValue   = snapshot.totalValue ?? 0;

  if (allPositions.length === 0 || opportunityCandidates.length === 0) return [];

  // Build set of held tickers
  const heldTickers = new Set(
    allPositions.map((p) => p.symbol.toUpperCase().trim())
  );

  // Exclude candidates that are event-blocked or have a Reduce decision with strong evidence
  const eligibleCandidates = opportunityCandidates.filter((c) => {
    const t   = c.ticker.toUpperCase().trim();
    const tde = tdeByTicker.get(t);
    if (!tde) return true; // no TDE data → eligible
    if (tde.blockedByEvent) return false;
    if (tde.decision === "PrepareToReduce" && tde.evidenceBand === "Strong") return false;
    return true;
  });

  // Filter to non-held candidates
  const notHeld = eligibleCandidates.filter(
    (c) => !heldTickers.has(c.ticker.toUpperCase().trim())
  );

  if (notHeld.length === 0) return [];

  // Build position map: ticker → (value, name)
  const positionMap = new Map<string, { value: number; name: string }>();
  for (const pos of allPositions) {
    const t = pos.symbol.toUpperCase().trim();
    const existing = positionMap.get(t);
    positionMap.set(t, {
      value: (existing?.value ?? 0) + pos.marketValueBaseCurrency,
      name: existing?.name ?? pos.name,
    });
  }

  const replacements: ReplacementOpportunity[] = [];

  for (const [holdingTicker, { value, name }] of positionMap) {
    const holdingCm  = companyMonitorByTicker.get(holdingTicker);
    const holdingTde = tdeByTicker.get(holdingTicker);
    const { score: holdingScore, hasCmData } = holdingQualityScore(holdingCm, holdingTde);
    const currentPct = totalValue > 0 ? (value / totalValue) * 100 : 0;

    for (const candidate of notHeld) {
      const candTicker = candidate.ticker.toUpperCase().trim();
      const candCm     = companyMonitorByTicker.get(candTicker);
      const candTde    = tdeByTicker.get(candTicker);
      const candScore  = candidateQualityScore(candidate, candCm, candTde);
      const delta      = candScore - holdingScore;

      if (delta < SCORE_DELTA_THRESHOLD) continue;

      const priority: "High" | "Medium" | "Low" =
        delta >= 35 ? "High" : delta >= 27 ? "Medium" : "Low";

      const isProvisional = !hasCmData; // if holding has no CM data, comparison is indicative only

      // Build rationale from available evidence
      const holdingViewHint = holdingCm?.investmentViewRating
        ? ` (${holdingCm.investmentViewRating})`
        : "";
      const candViewHint = candCm?.investmentViewRating
        ? ` (${candCm.investmentViewRating})`
        : "";
      const tdeHint = holdingTde?.decision === "PrepareToReduce"
        ? ` TDE recommends reducing ${holdingTicker}.`
        : candTde?.decision === "PrepareToBuy"
        ? ` TDE supports opening ${candTicker}.`
        : "";
      const provisionalNote = isProvisional ? " [Provisional — missing Company Monitor for holding]" : "";
      const catalystHint = candidate.mainCatalyst ? ` Catalyst: ${candidate.mainCatalyst}.` : "";
      const thesisHint = candidate.investmentThesis?.[0] ? ` ${candidate.investmentThesis[0]}.` : "";

      const rationale =
        `${holdingTicker}${holdingViewHint} scores ${holdingScore}; ` +
        `${candTicker}${candViewHint} scores ${candScore} (+${delta}).` +
        tdeHint + catalystHint + thesisHint + provisionalNote;

      replacements.push({
        holdingTicker,
        holdingCompany:         name,
        holdingCurrentPercent:  Math.round(currentPct * 10) / 10,
        holdingScore,
        holdingCaseStrength:    holdingCm?.investmentCaseStrength,
        holdingInvestmentView:  holdingCm?.investmentViewRating,
        holdingThesisDirection: holdingCm?.investmentCaseChange?.changed
          ? holdingCm.investmentCaseChange.severity
          : undefined,
        candidateTicker:        candTicker,
        candidateCompany:       candidate.company,
        candidateOverallScore:  candidate.overallScore,
        candidateCaseStrength:  candCm?.investmentCaseStrength,
        candidateInvestmentView: candCm?.investmentViewRating,
        scoreDelta:              delta,
        rationale,
        priority,
        isProvisional,
      });
    }
  }

  // Sort: non-provisional high-delta first
  replacements.sort((a, b) => {
    if (a.isProvisional !== b.isProvisional) return a.isProvisional ? 1 : -1;
    const pOrder = { High: 0, Medium: 1, Low: 2 };
    const pDiff = pOrder[a.priority] - pOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return b.scoreDelta - a.scoreDelta;
  });

  return replacements.slice(0, 10);
}
