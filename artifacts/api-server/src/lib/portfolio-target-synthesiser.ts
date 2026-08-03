/**
 * Portfolio Target Synthesiser
 *
 * Uses a single AI call (JSON mode, no web search) to synthesise an ideal
 * target portfolio from the current snapshot and available module analyses.
 *
 * Validation and normalisation logic lives in portfolio-target-validation.ts
 * so it can be unit-tested independently of the AI service / pino.
 */

import { callAi } from "./ai-service.js";
import type { PortfolioSnapshot } from "../routes/portfolio-manager.js";
import type { TargetPortfolio } from "./portfolio-manager-v2-types.js";
import { ROLE_DEFINITIONS } from "./portfolio-role-config.js";
import {
  validateAndNormaliseTarget,
  type AiTargetPortfolioResponse,
} from "./portfolio-target-validation.js";

// ── Role range table for the system prompt ────────────────────────────────────

const ROLE_RANGE_LINES = Object.values(ROLE_DEFINITIONS)
  .filter((r) => r.role !== "Cash")
  .map((r) => `  - ${r.role} (${r.label}): ${r.typicalMinPercent}–${r.typicalMaxPercent}% per position`)
  .join("\n");

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Chief Investment Officer (CIO) conducting a quarterly target-portfolio review.

Given the current portfolio snapshot and available analysis context, synthesise an ideal target allocation for each holding.

RULES:
1. The sum of all allocation targetPercent values PLUS cashTargetPercent must equal exactly 100.
2. cashTargetPercent must be between 2 and 40.
3. Each targetPercent must be between 1 and 30.
4. minPercent must be less than or equal to targetPercent.
5. maxPercent must be greater than or equal to targetPercent.
6. Only include tickers that are either currently held or explicitly listed in the Opportunity Finder candidates section below. Do not invent tickers.
7. Role must be one of: Cash, CoreHolding, GrowthCore, SpeculativeGrowth, IncomeDividend, Defensive, CyclicalExposure, InternationalDiversifier, SectorPlay, EventDriven.
8. rationale must be 1–2 sentences explaining why this allocation and role fit the overall strategy.
9. keyAssumptions: 3–5 bullet points about the macro or portfolio assumptions behind this target.
10. strategicRationale: 2–3 sentence overview of the target portfolio's overall intent.

PORTFOLIO ROLE ALLOCATION RANGES (stay within these ranges unless there is a strong analytical reason):
${ROLE_RANGE_LINES}

Do not include timestamp fields — the server handles those.
Return JSON only — no markdown, no code fences.

Return exactly this structure:
{"cashTargetPercent":10,"strategicRationale":"...","keyAssumptions":["...","..."],"allocations":[{"ticker":"AAPL","company":"Apple Inc","role":"CoreHolding","targetPercent":12,"minPercent":8,"maxPercent":18,"rationale":"..."}]}`;

// ── User prompt builder ───────────────────────────────────────────────────────

function buildUserPrompt(
  snapshot: PortfolioSnapshot,
  portfolioAnalyzerContext: string | null,
  riskContext: string | null,
  opportunityContext: string | null
): string {
  const allPositions = snapshot.accounts.flatMap((a) => a.positions);
  const totalValue = snapshot.totalValue ?? 0;

  const positionLines = allPositions.map((p) => {
    const pct = totalValue > 0 ? ((p.marketValueBaseCurrency / totalValue) * 100).toFixed(1) : "0.0";
    return `  ${p.symbol} (${p.name}): ${p.quantity} shares, market value ${pct}% of portfolio, P&L ${p.profitLoss.toFixed(0)} ${p.currency}`;
  });

  const cashPct = totalValue > 0 && snapshot.totalAvailableCash !== null
    ? ((snapshot.totalAvailableCash / totalValue) * 100).toFixed(1)
    : "unknown";

  const blocks: string[] = [
    `Current portfolio (${snapshot.baseCurrency} base, total value: ${totalValue.toLocaleString()}):`,
    `  Cash: ${cashPct}% of portfolio`,
    ...positionLines,
  ];

  if (portfolioAnalyzerContext) {
    blocks.push("", "Portfolio Analyzer conclusions (use as primary analytical baseline):");
    blocks.push(portfolioAnalyzerContext);
  }

  if (riskContext) {
    blocks.push("", "Risk Analyzer summary (factor in risk profile when setting allocations):");
    blocks.push(riskContext);
  }

  if (opportunityContext) {
    blocks.push("", "Opportunity Finder top candidates (may be included in target if they strengthen the portfolio — only use tickers from this list):");
    blocks.push(opportunityContext);
  }

  blocks.push(
    "",
    "Synthesise the ideal target portfolio. Allocations must sum to exactly 100 including cash.",
    "Only include tickers from the portfolio or Opportunity Finder list above.",
    "Respect the role allocation ranges listed in the system instructions."
  );

  return blocks.join("\n");
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function synthesiseTargetPortfolio(
  snapshot: PortfolioSnapshot,
  portfolioAnalyzerContext: string | null,
  riskContext: string | null,
  opportunityContext: string | null,
  allowedTickers: Set<string>
): Promise<TargetPortfolio> {
  const { result: raw } = await callAi<AiTargetPortfolioResponse>(
    SYSTEM_PROMPT,
    buildUserPrompt(snapshot, portfolioAnalyzerContext, riskContext, opportunityContext),
    { model: "gpt-4o", maxTokens: 2000, temperature: 0.2 }
  );

  // Validate and normalise — throws on any invariant violation
  const { allocations, cashTargetPercent } = validateAndNormaliseTarget(raw, allowedTickers);

  const totalEquityTargetPercent = allocations.reduce((s, a) => s + a.targetPercent, 0);

  if (typeof raw.strategicRationale !== "string" || raw.strategicRationale.trim().length === 0) {
    throw new Error("Target synthesiser: AI returned empty strategicRationale");
  }

  return {
    generatedAt: new Date().toISOString(),
    totalEquityTargetPercent: Math.round(totalEquityTargetPercent * 10) / 10,
    cashTargetPercent,
    allocations,
    strategicRationale: raw.strategicRationale.trim(),
    keyAssumptions: Array.isArray(raw.keyAssumptions)
      ? raw.keyAssumptions.map(String).filter((s) => s.trim().length > 0)
      : [],
  };
}
