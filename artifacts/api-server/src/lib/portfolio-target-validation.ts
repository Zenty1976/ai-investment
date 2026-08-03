/**
 * Portfolio Target Validation
 *
 * Pure validation and normalisation logic for AI-synthesised target portfolios.
 * Extracted into its own file so it can be unit-tested without pulling in the
 * AI service (which transitively imports pino and other server-only modules).
 *
 * No imports from ai-service, logger, or any server runtime module.
 *
 * ## Normalisation algorithm
 *
 * Role bounds are enforced on the FINAL output, not just as a pre-processing
 * hint. The algorithm is a four-pass approach:
 *
 * Pass 1 — initial clamp: reduce every targetPercent to its role's [min, max].
 * Pass 2 — scale to equity budget: proportionally rescale the clamped values
 *           to fill (100 – cashTarget)%.
 * Pass 3 — post-scale re-clamp: rescaling may have pushed some values back
 *           above their role max or below their role min. Clamp again.
 * Pass 4 — cash adjustment: after pass-3 clamping the equity sum may differ
 *           from the equity budget. Adjust cashTargetPercent to compensate so
 *           equity + cash == 100. If the required cash would exceed CASH_HARD_MAX
 *           (40%), the allocation set is infeasible — throw to allow caller to retry.
 */

import type {
  TargetAllocation,
  PortfolioRole,
  AllocationStatus,
  Conviction,
  SupportingModule,
} from "./portfolio-manager-v2-types.js";
import { ROLE_DEFINITIONS } from "./portfolio-role-config.js";

// Cash cannot fall below 2% or exceed 40%
const CASH_HARD_MIN = 2;
const CASH_HARD_MAX = 40;

// ── Shared AI response shape (exported for tests and synthesiser) ─────────────

export interface AiTargetAllocationRaw {
  ticker: string;
  company: string;
  role: string;
  targetPercent: number;
  minPercent: number;
  maxPercent: number;
  rationale: string;
  // New structured fields (optional — AI may not return all on every run)
  conviction?: string;
  allocationStatus?: string;
  reasonForStatus?: string;
  blockingFactors?: string[];
  supportingModules?: string[];
}

export interface AiTargetPortfolioResponse {
  cashTargetPercent: number;
  strategicRationale: string;
  keyAssumptions: string[];
  allocations: AiTargetAllocationRaw[];
}

// ── Valid roles ───────────────────────────────────────────────────────────────

const VALID_ROLES = new Set<PortfolioRole>([
  "Cash", "CoreHolding", "GrowthCore", "SpeculativeGrowth", "IncomeDividend",
  "Defensive", "CyclicalExposure", "InternationalDiversifier", "SectorPlay", "EventDriven",
]);

/**
 * Validates a role string.
 * Throws on unknown roles — silently converting to CoreHolding would materially
 * alter the allowed allocation range without the CIO's knowledge.
 */
export function sanitiseRole(raw: string): PortfolioRole {
  if (VALID_ROLES.has(raw as PortfolioRole)) return raw as PortfolioRole;
  throw new Error(
    `Target synthesiser: unknown role "${raw}". Must be one of: ${[...VALID_ROLES].join(", ")}. ` +
    `The AI must return a valid role — silently converting to CoreHolding would alter the allowed allocation range.`
  );
}

// ── Conviction sanitiser ──────────────────────────────────────────────────────

const VALID_CONVICTIONS = new Set<Conviction>(["High", "Medium", "Low"]);

function sanitiseConviction(raw: string | undefined): Conviction {
  if (raw && VALID_CONVICTIONS.has(raw as Conviction)) return raw as Conviction;
  return "Medium"; // default when not supplied
}

// ── AllocationStatus sanitiser ────────────────────────────────────────────────

const VALID_STATUSES = new Set<AllocationStatus>([
  "StrategicTarget", "Provisional", "Blocked", "Excluded",
]);

function sanitiseStatus(raw: string | undefined): AllocationStatus {
  if (raw && VALID_STATUSES.has(raw as AllocationStatus)) return raw as AllocationStatus;
  return "StrategicTarget"; // default when not supplied
}

// ── SupportingModule sanitiser ────────────────────────────────────────────────

const VALID_MODULES = new Set<SupportingModule>([
  "PortfolioAnalyzer", "RiskAnalyzer", "OpportunityFinder", "CompanyMonitor",
  "TradeDecisionEngine", "SectorMonitor", "MarketAlerts", "MarketMonitor",
]);

function sanitiseSupportingModules(
  raw: string[] | undefined,
  suppliedModules: Set<string>
): SupportingModule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => VALID_MODULES.has(m as SupportingModule))
    .filter((m) => suppliedModules.size === 0 || suppliedModules.has(m)) as SupportingModule[];
}

// ── Main validation function ──────────────────────────────────────────────────

/**
 * Validates and normalises an AI target-portfolio response.
 *
 * Returns allocations whose every `targetPercent` is strictly within the role's
 * [typicalMinPercent, typicalMaxPercent] bounds, and a `cashTargetPercent` such
 * that (equity sum + cash) == 100.
 *
 * Throws if:
 * - cashTargetPercent is missing / non-numeric
 * - allocations array is empty
 * - all allocations have non-numeric targetPercent (filtered out)
 * - any ticker is not in the allowedTickers set
 * - any allocation uses role "Cash"
 * - any ticker is duplicated
 * - any role is not a known PortfolioRole
 * - a Blocked allocation has no blockingFactors
 * - a StrategicTarget allocation has a critical blocking factor with no explanation
 * - equity sum after normalisation is zero
 * - the allocation set is infeasible
 *
 * @param raw              Parsed AI JSON response
 * @param allowedTickers   Set of uppercase tickers the AI is permitted to include
 * @param suppliedModules  Set of module names actually provided as context (for supportingModules validation)
 */
export function validateAndNormaliseTarget(
  raw: AiTargetPortfolioResponse,
  allowedTickers: Set<string>,
  suppliedModules: Set<string> = new Set()
): { allocations: TargetAllocation[]; cashTargetPercent: number } {
  // ── 1. Cash must be in range ──────────────────────────────────────────────
  if (typeof raw.cashTargetPercent !== "number" || !isFinite(raw.cashTargetPercent)) {
    throw new Error("Target synthesiser: cashTargetPercent is missing or not a number");
  }
  const cashTargetPercent = Math.max(CASH_HARD_MIN, Math.min(CASH_HARD_MAX, raw.cashTargetPercent));

  // ── 2. Allocations must exist ─────────────────────────────────────────────
  if (!Array.isArray(raw.allocations) || raw.allocations.length === 0) {
    throw new Error("Target synthesiser: AI returned empty allocations array");
  }

  // ── 3. Filter to valid tickers with numeric targetPercent ─────────────────
  const filtered = raw.allocations.filter((a) => {
    if (!a.ticker || typeof a.ticker !== "string") return false;
    if (typeof a.targetPercent !== "number" || !isFinite(a.targetPercent)) return false;
    return true;
  });

  if (filtered.length === 0) {
    throw new Error("Target synthesiser: no allocations survived basic field validation");
  }

  // ── 4. Reject tickers not in the allowed set ──────────────────────────────
  const unknown = filtered
    .map((a) => a.ticker.toUpperCase().trim())
    .filter((t) => !allowedTickers.has(t));
  if (unknown.length > 0) {
    throw new Error(
      `Target synthesiser: AI returned tickers not in allowed set: ${unknown.join(", ")}`
    );
  }

  // ── 4b. Reject 'Cash' as a ticker-level role ─────────────────────────────
  const cashRoleAllocations = filtered.filter(
    (a) => String(a.role ?? "").trim() === "Cash"
  );
  if (cashRoleAllocations.length > 0) {
    const tickers = cashRoleAllocations.map((a) => a.ticker.toUpperCase().trim()).join(", ");
    throw new Error(
      `Target synthesiser: allocation(s) ${tickers} use role "Cash". ` +
      `Cash must only be set via cashTargetPercent, not as a ticker-level allocation.`
    );
  }

  // ── 4c. Reject duplicate tickers ─────────────────────────────────────────
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const a of filtered) {
    const t = a.ticker.toUpperCase().trim();
    if (seen.has(t)) duplicates.push(t);
    seen.add(t);
  }
  if (duplicates.length > 0) {
    throw new Error(
      `Target synthesiser: AI returned duplicate tickers: ${[...new Set(duplicates)].join(", ")}. ` +
      `Each ticker may appear at most once in the target portfolio.`
    );
  }

  // ── 5. Pass 1 — validate roles and initial clamp ──────────────────────────
  // sanitiseRole throws on unknown roles — caller should retry rather than
  // silently accepting a wrong allocation range.
  const allocations: TargetAllocation[] = filtered.map((a) => {
    const role    = sanitiseRole(String(a.role ?? ""));
    const roleDef = ROLE_DEFINITIONS[role];

    const target = Math.max(
      roleDef.typicalMinPercent,
      Math.min(roleDef.typicalMaxPercent, a.targetPercent)
    );

    const rawMin = typeof a.minPercent === "number" && isFinite(a.minPercent)
      ? a.minPercent : Math.max(0, target - 5);
    const rawMax = typeof a.maxPercent === "number" && isFinite(a.maxPercent)
      ? a.maxPercent : target + 5;
    const min = Math.max(roleDef.typicalMinPercent, Math.min(rawMin, target));
    const max = Math.min(roleDef.typicalMaxPercent, Math.max(rawMax, target));

    const allocationStatus = sanitiseStatus(a.allocationStatus);
    const conviction       = sanitiseConviction(a.conviction);
    const blockingFactors  = Array.isArray(a.blockingFactors)
      ? a.blockingFactors.map(String).filter((s) => s.trim().length > 0)
      : [];
    const supportingModules = sanitiseSupportingModules(a.supportingModules, suppliedModules);

    return {
      ticker:         a.ticker.toUpperCase().trim(),
      company:        String(a.company ?? a.ticker),
      role,
      targetPercent:  target,
      minPercent:     min,
      maxPercent:     max,
      rationale:      String(a.rationale ?? ""),
      conviction,
      allocationStatus,
      reasonForStatus: a.reasonForStatus ? String(a.reasonForStatus) : undefined,
      blockingFactors,
      supportingModules,
    };
  });

  // ── 5b. AllocationStatus consistency checks ───────────────────────────────
  for (const a of allocations) {
    if (a.allocationStatus === "Blocked" && (!a.blockingFactors || a.blockingFactors.length === 0)) {
      throw new Error(
        `Target synthesiser: allocation ${a.ticker} has status "Blocked" but no blockingFactors. ` +
        `Blocked allocations must explain what prevents deployment.`
      );
    }
    if (a.allocationStatus === "StrategicTarget" && a.blockingFactors && a.blockingFactors.length > 0) {
      throw new Error(
        `Target synthesiser: allocation ${a.ticker} has status "StrategicTarget" but lists blocking factors: ` +
        `[${a.blockingFactors.join(", ")}]. ` +
        `A StrategicTarget must not have critical blocking factors — use Blocked or Provisional.`
      );
    }
  }

  // ── 6. Pass 2 — scale to equity budget ───────────────────────────────────
  const equityBudget = 100 - cashTargetPercent;
  const preScaleSum  = allocations.reduce((s, a) => s + a.targetPercent, 0);

  if (preScaleSum < 0.01) {
    throw new Error(
      "Target synthesiser: equity allocation sum is zero after filtering; cannot produce a valid target"
    );
  }

  const scale = equityBudget / preScaleSum;
  for (const a of allocations) {
    a.targetPercent = a.targetPercent * scale;
    a.minPercent    = a.minPercent    * scale;
    a.maxPercent    = a.maxPercent    * scale;
  }

  // ── 7. Pass 3 — post-scale re-clamp to role bounds ────────────────────────
  for (const a of allocations) {
    const roleDef   = ROLE_DEFINITIONS[a.role];
    a.targetPercent = Math.max(roleDef.typicalMinPercent, Math.min(roleDef.typicalMaxPercent, a.targetPercent));
    a.minPercent    = Math.max(roleDef.typicalMinPercent, Math.min(a.minPercent, a.targetPercent));
    a.maxPercent    = Math.min(roleDef.typicalMaxPercent, Math.max(a.maxPercent, a.targetPercent));
  }

  // ── 8. Pass 4 — adjust cash to absorb equity deviation ───────────────────
  const equityTotal = allocations.reduce((s, a) => s + a.targetPercent, 0);
  const requiredCash = 100 - equityTotal;

  if (requiredCash > CASH_HARD_MAX) {
    throw new Error(
      `Target synthesiser: allocations are infeasible — ${allocations.length} position(s) ` +
      `fill only ${equityTotal.toFixed(1)}% equity at their role maxes ` +
      `(maximum cash is ${CASH_HARD_MAX}%). ` +
      `The AI must return more or larger allocations to fill the equity budget.`
    );
  }

  const finalCashPercent = Math.max(CASH_HARD_MIN, requiredCash);

  // ── 9. Round final values ─────────────────────────────────────────────────
  for (const a of allocations) {
    a.targetPercent = Math.round(a.targetPercent * 10) / 10;
    a.minPercent    = Math.round(a.minPercent    * 10) / 10;
    a.maxPercent    = Math.round(a.maxPercent    * 10) / 10;
  }
  const finalCashRounded = Math.round(finalCashPercent * 10) / 10;

  // ── 10. Final sum guard ───────────────────────────────────────────────────
  const finalEquitySum = allocations.reduce((s, a) => s + a.targetPercent, 0);
  const finalTotal     = finalEquitySum + finalCashRounded;
  if (Math.abs(finalTotal - 100) > 2) {
    throw new Error(
      `Target synthesiser: total ${finalTotal.toFixed(1)}% deviates from 100% after normalisation`
    );
  }

  return { allocations, cashTargetPercent: finalCashRounded };
}
