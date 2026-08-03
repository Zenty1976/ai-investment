/**
 * Portfolio Target Synthesiser
 *
 * Uses a single AI call (JSON mode, no web search) to synthesise an ideal
 * target portfolio from the current snapshot and all available module analyses.
 *
 * Validation and normalisation logic lives in portfolio-target-validation.ts
 * so it can be unit-tested independently of the AI service / pino.
 *
 * Fingerprint logic:
 *   Before every call, the caller computes a deterministic fingerprint of all
 *   material CIO inputs.  If the fingerprint matches the stored result the AI
 *   call is skipped and only deterministic downstream components are recomputed.
 */

import { callAi } from "./ai-service.js";
import type { PortfolioSnapshot } from "../routes/portfolio-manager.js";
import type { TargetPortfolio, PortfolioV2Provenance } from "./portfolio-manager-v2-types.js";
import { ROLE_DEFINITIONS } from "./portfolio-role-config.js";
import {
  validateAndNormaliseTarget,
  type AiTargetPortfolioResponse,
} from "./portfolio-target-validation.js";

// ── Fingerprint helper ────────────────────────────────────────────────────────

/**
 * Deterministic djb2-family hash of a JSON-serialised object.
 * Used to detect whether material CIO inputs have changed since the last run.
 */
export function computeCioFingerprint(data: unknown): string {
  const str = JSON.stringify(data);
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ── Role range table for the system prompt ────────────────────────────────────

const ROLE_RANGE_LINES = Object.values(ROLE_DEFINITIONS)
  .filter((r) => r.role !== "Cash")
  .map((r) => `  - ${r.role} (${r.label}): ${r.typicalMinPercent}–${r.typicalMaxPercent}% per position`)
  .join("\n");

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Chief Investment Officer (CIO) conducting a quarterly target-portfolio review. You have access to full institutional analytical coverage.

Given the current portfolio snapshot and available analysis context, synthesise an ideal target allocation for each holding and high-conviction opportunity candidate.

RULES:
1. The sum of all allocation targetPercent values PLUS cashTargetPercent must equal exactly 100.
2. cashTargetPercent must be between 2 and 40.
3. Each targetPercent must be between 1 and 30.
4. minPercent must be less than or equal to targetPercent. maxPercent must be >= targetPercent.
5. Only include tickers currently held OR explicitly listed in the Opportunity Finder candidates. Do not invent tickers.
6. Role must be one of: CoreHolding, GrowthCore, SpeculativeGrowth, IncomeDividend, Defensive, CyclicalExposure, InternationalDiversifier, SectorPlay, EventDriven. Do NOT use "Cash" as a role.
7. rationale: 1–2 sentences grounded in the analytical evidence provided.
8. keyAssumptions: 3–5 macro or portfolio assumptions behind this target.
9. strategicRationale: 2–3 sentence overview of the overall strategic intent.
10. conviction: "High" | "Medium" | "Low" — how strongly the evidence supports this allocation.
11. allocationStatus: one of "StrategicTarget" | "Provisional" | "Blocked" | "Excluded".
    - StrategicTarget: valid, immediately deployable long-term allocation.
    - Provisional: company may belong in portfolio but key evidence is incomplete.
    - Blocked: a future event or critical condition prevents immediate deployment.
    - Excluded: was considered but must not receive capital at present.
12. reasonForStatus: 1 sentence explaining the chosen allocationStatus.
13. blockingFactors: array of strings listing blocking conditions. REQUIRED when status is "Blocked". MUST be empty ([]) for StrategicTarget. Optional for Provisional.
14. supportingModules: array listing which input modules directly support this allocation. Use only: PortfolioAnalyzer, RiskAnalyzer, OpportunityFinder, CompanyMonitor, TradeDecisionEngine, SectorMonitor, MarketAlerts, MarketMonitor.

PORTFOLIO ROLE ALLOCATION RANGES (stay within these governance ranges):
${ROLE_RANGE_LINES}

CAPITAL DEPLOYMENT RULES:
- Only mark as StrategicTarget when: Trade Decision is ReadyForReview (or no TDE data), Company Monitor shows Buy/Strong Buy, no critical blocking factor.
- Mark as Blocked when: Trade Decision is blocked by event, or an earnings/catalytic event is imminent and the decision is uncertain.
- Mark as Provisional when: Company Monitor is absent or stale, or evidence is incomplete.

Do not include timestamp fields — the server handles those.
Return JSON only — no markdown, no code fences.

Return exactly this structure:
{"cashTargetPercent":10,"strategicRationale":"...","keyAssumptions":["..."],"allocations":[{"ticker":"AAPL","company":"Apple Inc","role":"CoreHolding","targetPercent":12,"minPercent":8,"maxPercent":18,"rationale":"...","conviction":"High","allocationStatus":"StrategicTarget","reasonForStatus":"...","blockingFactors":[],"supportingModules":["CompanyMonitor","TradeDecisionEngine"]}]}`;

// ── Context container ─────────────────────────────────────────────────────────

export interface CioInputContext {
  portfolioAnalyzer: string | null;
  risk: string | null;
  opportunities: string | null;
  companyMonitor: string | null;
  tradeDecision: string | null;
  sectorMonitor: string | null;
  marketAlerts: string | null;
  marketMonitor: string | null;
}

// ── User prompt builder ───────────────────────────────────────────────────────

function buildUserPrompt(
  snapshot: PortfolioSnapshot,
  ctx: CioInputContext
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

  if (ctx.portfolioAnalyzer) {
    blocks.push("", "Portfolio Analyzer conclusions (primary analytical baseline):");
    blocks.push(ctx.portfolioAnalyzer);
  }

  if (ctx.risk) {
    blocks.push("", "Risk Analyzer summary (factor into allocation sizing and role decisions):");
    blocks.push(ctx.risk);
  }

  if (ctx.companyMonitor) {
    blocks.push("", "Company Monitor analyses (use investmentView, investmentCaseStrength, thesis statuses, confidence, catalysts, risks for each company):");
    blocks.push(ctx.companyMonitor);
  }

  if (ctx.tradeDecision) {
    blocks.push("", "Trade Decision Engine (use decisionType, readiness, blockedByEvent, evidenceBand, targetAllocationPercent as concrete deployment signals):");
    blocks.push(ctx.tradeDecision);
  }

  if (ctx.sectorMonitor) {
    blocks.push("", "Sector Monitor (use for sector attractiveness and weighting decisions):");
    blocks.push(ctx.sectorMonitor);
  }

  if (ctx.marketAlerts) {
    blocks.push("", "Market Alerts (factor into Blocked/Provisional decisions where alerts affect holdings):");
    blocks.push(ctx.marketAlerts);
  }

  if (ctx.marketMonitor) {
    blocks.push("", "Market Monitor (broad risk posture and cash-target context):");
    blocks.push(ctx.marketMonitor);
  }

  if (ctx.opportunities) {
    blocks.push("", "Opportunity Finder top candidates (may be added to target if they improve portfolio — ONLY use tickers from this list for new positions):");
    blocks.push(ctx.opportunities);
  }

  blocks.push(
    "",
    "Synthesise the ideal target portfolio. Allocations must sum to exactly 100 including cash.",
    "Only include tickers from the portfolio or Opportunity Finder list above.",
    "Respect role allocation ranges and capital deployment rules listed in the system instructions.",
    "Set allocationStatus carefully: only StrategicTarget allocations will receive immediate capital deployment."
  );

  return blocks.join("\n");
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function synthesiseTargetPortfolio(
  snapshot: PortfolioSnapshot,
  ctx: CioInputContext,
  allowedTickers: Set<string>,
  suppliedModules: Set<string>
): Promise<TargetPortfolio> {
  const { result: raw } = await callAi<AiTargetPortfolioResponse>(
    SYSTEM_PROMPT,
    buildUserPrompt(snapshot, ctx),
    { model: "gpt-4o", maxTokens: 2500, temperature: 0.2 }
  );

  // Validate and normalise — throws on any invariant violation
  const { allocations, cashTargetPercent } = validateAndNormaliseTarget(
    raw, allowedTickers, suppliedModules
  );

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
