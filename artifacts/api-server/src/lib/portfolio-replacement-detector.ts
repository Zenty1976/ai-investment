/**
 * Portfolio Replacement Detector
 *
 * Identifies holdings that could be replaced by higher-scoring
 * Opportunity Finder candidates.
 *
 * Criteria:
 * - candidateOverallScore − holdingScore >= 15 (the score-delta threshold)
 * - The candidate is not already held in the portfolio.
 * - The holding is not the only position.
 *
 * holdingScore is inferred from the Portfolio Analyzer attention level:
 *   High attention → score 30 (struggling / needs watching)
 *   Medium attention → score 55
 *   Low attention → score 75 (stable)
 * When no analyzer data is present, holdingScore defaults to 50.
 *
 * No AI calls — purely deterministic.
 */

import type { PortfolioSnapshot } from "../routes/portfolio-manager.js";
import type { ReplacementOpportunity } from "./portfolio-manager-v2-types.js";

// ── External context shapes (minimal — only fields we read) ───────────────────

interface OpportunityCandidate {
  ticker: string;
  company: string;
  overallScore: number;
  priority?: string;
  investmentThesis?: string[];
  mainCatalyst?: string;
}

interface PositionAttention {
  ticker: string;
  attention: "High" | "Medium" | "Low";
  summary?: string;
}

const ATTENTION_SCORE: Record<"High" | "Medium" | "Low", number> = {
  High:   30,
  Medium: 55,
  Low:    75,
};

const SCORE_DELTA_THRESHOLD = 15;

// ── Main entry point ──────────────────────────────────────────────────────────

export function detectReplacements(
  snapshot: PortfolioSnapshot,
  opportunityCandidates: OpportunityCandidate[],
  positionAttentions: PositionAttention[]
): ReplacementOpportunity[] {
  const allPositions = snapshot.accounts.flatMap((a) => a.positions);
  const totalValue   = snapshot.totalValue ?? 0;

  if (allPositions.length === 0 || opportunityCandidates.length === 0) return [];

  // Build set of held tickers for fast lookup
  const heldTickers = new Set(
    allPositions.map((p) => p.symbol.toUpperCase().trim())
  );

  // Build attention map
  const attentionMap = new Map<string, "High" | "Medium" | "Low">();
  for (const a of positionAttentions) {
    attentionMap.set(a.ticker.toUpperCase().trim(), a.attention);
  }

  // Filter candidates to non-held ones only
  const notHeldCandidates = opportunityCandidates.filter(
    (c) => !heldTickers.has(c.ticker.toUpperCase().trim())
  );

  const replacements: ReplacementOpportunity[] = [];

  for (const pos of allPositions) {
    const holdingTicker  = pos.symbol.toUpperCase().trim();
    const attention      = attentionMap.get(holdingTicker) ?? "Medium";
    const holdingScore   = ATTENTION_SCORE[attention];
    const currentPct     = totalValue > 0 ? (pos.marketValueBaseCurrency / totalValue) * 100 : 0;

    for (const candidate of notHeldCandidates) {
      const delta = candidate.overallScore - holdingScore;
      if (delta < SCORE_DELTA_THRESHOLD) continue;

      const priority: "High" | "Medium" | "Low" =
        delta >= 35 ? "High" : delta >= 25 ? "Medium" : "Low";

      const catalystHint = candidate.mainCatalyst
        ? ` Candidate catalyst: ${candidate.mainCatalyst}.`
        : "";
      const thesisHint   = candidate.investmentThesis?.[0]
        ? ` ${candidate.investmentThesis[0]}.`
        : "";

      replacements.push({
        holdingTicker,
        holdingCompany:          pos.name,
        holdingCurrentPercent:   Math.round(currentPct * 10) / 10,
        holdingScore,
        candidateTicker:         candidate.ticker.toUpperCase(),
        candidateCompany:        candidate.company,
        candidateOverallScore:   candidate.overallScore,
        scoreDelta:              delta,
        rationale:
          `${holdingTicker} has ${attention} attention (score ${holdingScore}), while ${candidate.ticker} scores ${candidate.overallScore} (+${delta}).${catalystHint}${thesisHint}`,
        priority,
      });
    }
  }

  // Sort by score delta descending, then priority
  replacements.sort((a, b) => {
    const priorityOrder = { High: 0, Medium: 1, Low: 2 };
    const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return b.scoreDelta - a.scoreDelta;
  });

  // Cap at 10 replacements to avoid noise
  return replacements.slice(0, 10);
}
