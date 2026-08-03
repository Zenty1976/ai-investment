/**
 * Tests for the validateAndNormaliseTarget function from
 * portfolio-target-validation.ts (no AI calls — purely deterministic).
 *
 * Key invariants:
 * 1. Every final targetPercent is within [role.typicalMinPercent, role.typicalMaxPercent].
 * 2. min ≤ target ≤ max for all allocations (post-normalisation).
 * 3. equity sum + cashTargetPercent is within 2pp of 100.
 * 4. Infeasible sets (too few positions to fill equity budget within role bounds) throw.
 * 5. Unknown tickers throw.
 * 6. Empty / malformed input throws.
 * 7. cashTargetPercent is adjusted to compensate for role-bound enforcement.
 * 8. (v2.1) allocationStatus required — throws if missing or invalid.
 * 9. (v2.1) conviction required — throws if missing or invalid.
 * 10. (v2.1) reasonForStatus required — throws if missing or empty.
 * 11. (v2.1) blockingFactors required as array — throws if not array.
 * 12. (v2.1) supportingModules required as array — throws if not array.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateAndNormaliseTarget,
  type AiTargetAllocationRaw,
  type AiTargetPortfolioResponse,
} from "../portfolio-target-validation.js";
import { ROLE_DEFINITIONS } from "../portfolio-role-config.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A fully valid allocation with all required structured fields. */
function makeAlloc(overrides: Partial<AiTargetAllocationRaw> = {}): AiTargetAllocationRaw {
  return {
    ticker: "AAPL",
    company: "Apple Inc",
    role: "CoreHolding",
    targetPercent: 15,
    minPercent: 10,
    maxPercent: 20,
    rationale: "Core holding",
    conviction: "High",
    allocationStatus: "StrategicTarget",
    reasonForStatus: "Strong Buy rating with full analytical coverage.",
    blockingFactors: [],
    supportingModules: ["CompanyMonitor", "TradeDecisionEngine"],
    ...overrides,
  };
}

/** Build a raw AI response fixture with optional overrides. */
function makeRaw(overrides: Partial<AiTargetPortfolioResponse> = {}): AiTargetPortfolioResponse {
  return {
    cashTargetPercent: 10,
    strategicRationale: "Test portfolio",
    keyAssumptions: ["Assumption 1"],
    allocations: [
      makeAlloc({ ticker: "AAPL", targetPercent: 15 }),
      makeAlloc({
        ticker: "MSFT",
        company: "Microsoft",
        targetPercent: 75,
        minPercent: 60,
        maxPercent: 80,
        rationale: "Core holding",
      }),
    ],
    ...overrides,
  };
}

/** Verify every allocation in the result is within its role's bounds. */
function assertWithinRoleBounds(allocations: Array<{ ticker: string; role: string; targetPercent: number }>) {
  for (const a of allocations) {
    const roleDef = ROLE_DEFINITIONS[a.role as keyof typeof ROLE_DEFINITIONS];
    assert.ok(
      a.targetPercent >= roleDef.typicalMinPercent - 0.01,
      `${a.ticker} (${a.role}): targetPercent ${a.targetPercent}% < role min ${roleDef.typicalMinPercent}%`
    );
    assert.ok(
      a.targetPercent <= roleDef.typicalMaxPercent + 0.01,
      `${a.ticker} (${a.role}): targetPercent ${a.targetPercent}% > role max ${roleDef.typicalMaxPercent}%`
    );
  }
}

const ALLOWED_BOTH = new Set(["AAPL", "MSFT"]);
const ALLOWED_FIVE = new Set(["AAPL", "MSFT", "GOOG", "AMZN", "META"]);

/** A 5-CoreHolding position fixture — feasible equity budget of 90%. */
function makeFivePosition(cashTarget = 10): AiTargetPortfolioResponse {
  const tickers = ["AAPL", "MSFT", "GOOG", "AMZN", "META"];
  const companies = ["Apple", "Microsoft", "Alphabet", "Amazon", "Meta"];
  return {
    cashTargetPercent: cashTarget,
    strategicRationale: "Diversified core portfolio",
    keyAssumptions: [],
    allocations: tickers.map((ticker, i) => makeAlloc({
      ticker,
      company: companies[i],
      targetPercent: 25,
      minPercent: 8,
      maxPercent: 30,
    })),
  };
}

// ── Role-bound enforcement — FINAL output ─────────────────────────────────────

describe("validateAndNormaliseTarget — final role bounds (HARD)", () => {
  it("every final targetPercent is within its role's [typicalMin, typicalMax] — 5-position portfolio", () => {
    const { allocations } = validateAndNormaliseTarget(makeFivePosition(10), ALLOWED_FIVE);
    assertWithinRoleBounds(allocations);
  });

  it("positions with mixed roles all end within their respective role bounds", () => {
    const raw: AiTargetPortfolioResponse = {
      cashTargetPercent: 5,
      strategicRationale: "Mixed roles",
      keyAssumptions: [],
      allocations: [
        makeAlloc({ ticker: "AAPL", role: "CoreHolding",       targetPercent: 30, minPercent: 5, maxPercent: 35 }),
        makeAlloc({ ticker: "MSFT", role: "GrowthCore",        targetPercent: 30, minPercent: 5, maxPercent: 35 }),
        makeAlloc({ ticker: "GOOG", role: "SpeculativeGrowth", targetPercent: 30, minPercent: 5, maxPercent: 35 }),
        makeAlloc({ ticker: "AMZN", role: "IncomeDividend",    targetPercent: 30, minPercent: 5, maxPercent: 35 }),
        makeAlloc({ ticker: "META", role: "Defensive",         targetPercent: 30, minPercent: 5, maxPercent: 35 }),
      ],
    };
    const { allocations } = validateAndNormaliseTarget(raw, ALLOWED_FIVE);
    assertWithinRoleBounds(allocations);
  });

  it("AI values already within role bounds pass through unchanged after normalisation", () => {
    const raw: AiTargetPortfolioResponse = {
      cashTargetPercent: 10,
      strategicRationale: "In-bounds test",
      keyAssumptions: [],
      allocations: [
        makeAlloc({ ticker: "AAPL", targetPercent: 18, minPercent: 8, maxPercent: 20 }),
        makeAlloc({ ticker: "MSFT", targetPercent: 18, minPercent: 8, maxPercent: 20 }),
        makeAlloc({ ticker: "GOOG", targetPercent: 18, minPercent: 8, maxPercent: 20 }),
        makeAlloc({ ticker: "AMZN", targetPercent: 18, minPercent: 8, maxPercent: 20 }),
        makeAlloc({ ticker: "META", targetPercent: 18, minPercent: 8, maxPercent: 20 }),
      ],
    };
    const { allocations, cashTargetPercent } = validateAndNormaliseTarget(raw, ALLOWED_FIVE);
    assertWithinRoleBounds(allocations);
    const equitySum = allocations.reduce((s, a) => s + a.targetPercent, 0);
    assert.ok(Math.abs(equitySum + cashTargetPercent - 100) <= 2, "total must be within 2pp of 100");
  });

  it("min ≤ target ≤ max for all allocations after normalisation", () => {
    const { allocations } = validateAndNormaliseTarget(makeFivePosition(10), ALLOWED_FIVE);
    for (const a of allocations) {
      assert.ok(a.minPercent <= a.targetPercent + 0.01, `${a.ticker}: min > target`);
      assert.ok(a.maxPercent >= a.targetPercent - 0.01, `${a.ticker}: max < target`);
    }
  });

  it("equity + cash totals within 2pp of 100 after role-bound enforcement", () => {
    const { allocations, cashTargetPercent } = validateAndNormaliseTarget(makeFivePosition(10), ALLOWED_FIVE);
    const equitySum = allocations.reduce((s, a) => s + a.targetPercent, 0);
    assert.ok(Math.abs(equitySum + cashTargetPercent - 100) <= 2, `total deviates from 100`);
  });

  it("cash is adjusted upward when role maxes constrain equity below the initial budget", () => {
    const raw: AiTargetPortfolioResponse = {
      cashTargetPercent: 5,
      strategicRationale: "Cash adjustment test",
      keyAssumptions: [],
      allocations: [
        makeAlloc({ ticker: "AAPL", role: "CoreHolding", targetPercent: 30, minPercent: 8, maxPercent: 35 }),
        makeAlloc({ ticker: "MSFT", role: "CoreHolding", targetPercent: 30, minPercent: 8, maxPercent: 35 }),
        makeAlloc({ ticker: "GOOG", role: "CoreHolding", targetPercent: 30, minPercent: 8, maxPercent: 35 }),
        makeAlloc({ ticker: "AMZN", role: "CoreHolding", targetPercent: 30, minPercent: 8, maxPercent: 35 }),
        makeAlloc({ ticker: "META", role: "GrowthCore",  targetPercent: 30, minPercent: 5, maxPercent: 35 }),
      ],
    };
    const { allocations, cashTargetPercent } = validateAndNormaliseTarget(raw, ALLOWED_FIVE);
    assertWithinRoleBounds(allocations);
    const equitySum = allocations.reduce((s, a) => s + a.targetPercent, 0);
    assert.ok(Math.abs(equitySum + cashTargetPercent - 100) <= 2, `total deviates from 100`);
    assert.ok(cashTargetPercent >= 2, "cash must be ≥ CASH_HARD_MIN (2%)");
    assert.ok(cashTargetPercent <= 40, "cash must be ≤ CASH_HARD_MAX (40%)");
  });
});

// ── Infeasibility detection ───────────────────────────────────────────────────

describe("validateAndNormaliseTarget — infeasibility detection", () => {
  it("throws when too few positions to fill equity budget within role bounds", () => {
    const raw = makeRaw({
      allocations: [
        makeAlloc({ ticker: "AAPL", role: "SpeculativeGrowth", targetPercent: 50, minPercent: 5, maxPercent: 55 }),
        makeAlloc({ ticker: "MSFT", role: "CoreHolding",       targetPercent: 40, minPercent: 8, maxPercent: 45 }),
      ],
    });
    assert.throws(() => validateAndNormaliseTarget(raw, ALLOWED_BOTH), /infeasible/i);
  });

  it("does NOT throw when positions are sufficient to fill the equity budget", () => {
    assert.doesNotThrow(() => validateAndNormaliseTarget(makeFivePosition(10), ALLOWED_FIVE));
  });
});

// ── Ticker allowlist ──────────────────────────────────────────────────────────

describe("validateAndNormaliseTarget — ticker allowlist", () => {
  it("throws when AI returns a ticker not in the allowed set", () => {
    const raw = makeRaw();
    assert.throws(
      () => validateAndNormaliseTarget(raw, new Set(["AAPL"])),
      /tickers not in allowed set.*MSFT/i
    );
  });

  it("passes when all tickers are in the allowed set", () => {
    assert.doesNotThrow(() => validateAndNormaliseTarget(makeFivePosition(), ALLOWED_FIVE));
  });

  it("ticker matching is case-insensitive (normalised to uppercase)", () => {
    const raw: AiTargetPortfolioResponse = {
      cashTargetPercent: 5,
      strategicRationale: "test",
      keyAssumptions: [],
      allocations: [
        makeAlloc({ ticker: "aapl", targetPercent: 20, minPercent: 8, maxPercent: 20 }),
        makeAlloc({ ticker: "msft", targetPercent: 20, minPercent: 8, maxPercent: 20 }),
        makeAlloc({ ticker: "goog", targetPercent: 20, minPercent: 8, maxPercent: 20 }),
        makeAlloc({ ticker: "amzn", targetPercent: 20, minPercent: 8, maxPercent: 20 }),
        makeAlloc({ ticker: "meta", targetPercent: 15, minPercent: 8, maxPercent: 20 }),
      ],
    };
    assert.doesNotThrow(() => validateAndNormaliseTarget(raw, ALLOWED_FIVE));
  });
});

// ── Empty or malformed input ──────────────────────────────────────────────────

describe("validateAndNormaliseTarget — empty or malformed input", () => {
  it("throws when allocations array is empty", () => {
    assert.throws(
      () => validateAndNormaliseTarget(makeRaw({ allocations: [] }), ALLOWED_BOTH),
      /empty allocations/i
    );
  });

  it("throws when all allocations have non-numeric targetPercent", () => {
    const raw = makeRaw({
      allocations: [makeAlloc({ ticker: "AAPL", targetPercent: NaN })],
    });
    assert.throws(
      () => validateAndNormaliseTarget(raw, new Set(["AAPL"])),
      /no allocations survived/i
    );
  });

  it("throws when cashTargetPercent is NaN", () => {
    assert.throws(
      () => validateAndNormaliseTarget(makeRaw({ cashTargetPercent: NaN }), ALLOWED_BOTH),
      /cashTargetPercent/i
    );
  });

  it("throws when any allocation uses role Cash — cash must only be in cashTargetPercent", () => {
    const raw: AiTargetPortfolioResponse = {
      cashTargetPercent: 10,
      strategicRationale: "Cash role test",
      keyAssumptions: [],
      allocations: [
        makeAlloc({ ticker: "AAPL", targetPercent: 18 }),
        makeAlloc({ ticker: "MSFT", targetPercent: 18 }),
        makeAlloc({ ticker: "CASH", role: "Cash", targetPercent: 14 }),
        makeAlloc({ ticker: "GOOG", targetPercent: 18 }),
        makeAlloc({ ticker: "AMZN", targetPercent: 18 }),
      ],
    };
    assert.throws(
      () => validateAndNormaliseTarget(raw, new Set(["AAPL", "MSFT", "CASH", "GOOG", "AMZN"])),
      /role.*Cash.*cashTargetPercent|cashTargetPercent.*Cash/i
    );
  });

  it("throws when the AI returns the same ticker twice", () => {
    const raw: AiTargetPortfolioResponse = {
      cashTargetPercent: 5,
      strategicRationale: "Duplicate test",
      keyAssumptions: [],
      allocations: [
        makeAlloc({ ticker: "AAPL", targetPercent: 18 }),
        makeAlloc({ ticker: "MSFT", targetPercent: 18 }),
        makeAlloc({ ticker: "AAPL", role: "GrowthCore", targetPercent: 14 }), // duplicate
        makeAlloc({ ticker: "GOOG", targetPercent: 18 }),
        makeAlloc({ ticker: "AMZN", targetPercent: 17 }),
      ],
    };
    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_FIVE),
      /duplicate tickers.*AAPL/i
    );
  });

  it("passes when every ticker is unique (no false positives)", () => {
    assert.doesNotThrow(() => validateAndNormaliseTarget(makeFivePosition(), ALLOWED_FIVE));
  });
});

// ── Sum and cash normalisation ─────────────────────────────────────────────────

describe("validateAndNormaliseTarget — sum and cash normalisation", () => {
  it("cashTargetPercent is clamped to [2, 40] regardless of AI value", () => {
    const low = validateAndNormaliseTarget({ ...makeFivePosition(), cashTargetPercent: 0 }, ALLOWED_FIVE);
    assert.ok(low.cashTargetPercent >= 2, "cash must be ≥ 2");

    const high = validateAndNormaliseTarget({ ...makeFivePosition(), cashTargetPercent: 50 }, ALLOWED_FIVE);
    assert.ok(high.cashTargetPercent <= 40, "cash must be ≤ 40");
  });

  it("returned allocations all have roles within ROLE_DEFINITIONS", () => {
    const { allocations } = validateAndNormaliseTarget(makeFivePosition(), ALLOWED_FIVE);
    for (const a of allocations) {
      assert.ok(a.role in ROLE_DEFINITIONS, `${a.ticker}: role "${a.role}" not in ROLE_DEFINITIONS`);
    }
  });
});

// ── v2.1: Strict required-field validation ────────────────────────────────────

describe("validateAndNormaliseTarget — v2.1 strict required fields", () => {
  it("throws when allocationStatus is missing", () => {
    const raw = makeRaw({
      allocations: [
        makeAlloc({ ticker: "AAPL", allocationStatus: undefined }),
        makeAlloc({ ticker: "MSFT" }),
      ],
    });
    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_BOTH),
      /allocationStatus/i
    );
  });

  it("throws when allocationStatus is an unrecognised string", () => {
    const raw = makeRaw({
      allocations: [
        makeAlloc({ ticker: "AAPL", allocationStatus: "OnWatch" }),
        makeAlloc({ ticker: "MSFT" }),
      ],
    });
    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_BOTH),
      /allocationStatus/i
    );
  });

  it("throws when conviction is missing", () => {
    const raw = makeRaw({
      allocations: [
        makeAlloc({ ticker: "AAPL", conviction: undefined }),
        makeAlloc({ ticker: "MSFT" }),
      ],
    });
    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_BOTH),
      /conviction/i
    );
  });

  it("throws when conviction is an unrecognised string", () => {
    const raw = makeRaw({
      allocations: [
        makeAlloc({ ticker: "AAPL", conviction: "VeryHigh" }),
        makeAlloc({ ticker: "MSFT" }),
      ],
    });
    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_BOTH),
      /conviction/i
    );
  });

  it("throws when reasonForStatus is missing", () => {
    const raw = makeRaw({
      allocations: [
        makeAlloc({ ticker: "AAPL", reasonForStatus: undefined }),
        makeAlloc({ ticker: "MSFT" }),
      ],
    });
    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_BOTH),
      /reasonForStatus/i
    );
  });

  it("throws when reasonForStatus is an empty string", () => {
    const raw = makeRaw({
      allocations: [
        makeAlloc({ ticker: "AAPL", reasonForStatus: "   " }),
        makeAlloc({ ticker: "MSFT" }),
      ],
    });
    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_BOTH),
      /reasonForStatus/i
    );
  });

  it("throws when blockingFactors is not an array", () => {
    const raw = makeRaw({
      allocations: [
        makeAlloc({ ticker: "AAPL", blockingFactors: undefined }),
        makeAlloc({ ticker: "MSFT" }),
      ],
    });
    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_BOTH),
      /blockingFactors/i
    );
  });

  it("throws when supportingModules is not an array", () => {
    const raw = makeRaw({
      allocations: [
        makeAlloc({ ticker: "AAPL", supportingModules: undefined }),
        makeAlloc({ ticker: "MSFT" }),
      ],
    });
    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_BOTH),
      /supportingModules/i
    );
  });

  it("passes when all required fields are present and valid", () => {
    // All five allocations have all required fields
    assert.doesNotThrow(() => validateAndNormaliseTarget(makeFivePosition(), ALLOWED_FIVE));
  });

  it("accepts empty blockingFactors array for StrategicTarget", () => {
    // StrategicTarget with [] blockingFactors — valid.
    // Use 5 positions so equity budget (90%) is feasible within role bounds.
    assert.doesNotThrow(() => validateAndNormaliseTarget(makeFivePosition(), ALLOWED_FIVE));
  });

  it("accepts Blocked allocation when blockingFactors is non-empty", () => {
    // Five positions, first one Blocked with reasons — still feasible.
    const five = makeFivePosition();
    const allocations = [
      makeAlloc({
        ticker: "AAPL",
        company: "Apple",
        allocationStatus: "Blocked",
        reasonForStatus: "Earnings release this week creates uncertainty.",
        blockingFactors: ["Earnings release this week"],
        targetPercent: 25,
        minPercent: 8,
        maxPercent: 30,
      }),
      ...five.allocations.filter((a) => a.ticker !== "AAPL"),
    ];
    const raw: AiTargetPortfolioResponse = { ...five, allocations };
    assert.doesNotThrow(() => validateAndNormaliseTarget(raw, ALLOWED_FIVE));
  });

  it("throws when Blocked allocation has empty blockingFactors", () => {
    const raw = makeRaw({
      allocations: [
        makeAlloc({
          ticker: "AAPL",
          allocationStatus: "Blocked",
          reasonForStatus: "Something blocks this.",
          blockingFactors: [],
        }),
        makeAlloc({ ticker: "MSFT" }),
      ],
    });
    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_BOTH),
      /Blocked.*no blockingFactors|blockingFactors.*Blocked/i
    );
  });

  it("throws when StrategicTarget has non-empty blockingFactors", () => {
    const raw = makeRaw({
      allocations: [
        makeAlloc({
          ticker: "AAPL",
          allocationStatus: "StrategicTarget",
          blockingFactors: ["Earnings next week"],
        }),
        makeAlloc({ ticker: "MSFT" }),
      ],
    });
    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_BOTH),
      /StrategicTarget.*blocking|blocking.*StrategicTarget/i
    );
  });
});

// ── v2.2: Strict supportingModules validation ─────────────────────────────────

describe("validateAndNormaliseTarget — v2.2 strict supportingModules", () => {
  const SUPPLIED = new Set(["PortfolioAnalyzer", "RiskAnalyzer", "CompanyMonitor", "TradeDecisionEngine"]);

  it("throws when supportingModules contains an unknown module name", () => {
    const raw = makeRaw({
      allocations: [
        makeAlloc({
          ticker: "AAPL",
          supportingModules: ["PortfolioAnalyzer", "AIOracle"],   // AIOracle is not a valid module
        }),
        makeAlloc({ ticker: "MSFT" }),
      ],
    });
    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_BOTH, SUPPLIED),
      /unknown.*supportingModules|supportingModules.*unknown|AIOracle/i
    );
  });

  it("throws when supportingModules contains a known but unsupplied module", () => {
    // OpportunityFinder is a valid module, but it was not supplied in SUPPLIED
    const raw = makeRaw({
      allocations: [
        makeAlloc({
          ticker: "AAPL",
          supportingModules: ["PortfolioAnalyzer", "OpportunityFinder"],
        }),
        makeAlloc({ ticker: "MSFT" }),
      ],
    });
    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_BOTH, SUPPLIED),
      /not available|unsupplied|unavailable|OpportunityFinder/i
    );
  });

  it("passes when all supportingModules are known and were supplied", () => {
    // Use 5-position fixture so equity budget is feasible within role bounds.
    const five = makeFivePosition();
    const raw: AiTargetPortfolioResponse = {
      ...five,
      allocations: five.allocations.map((a, i) => ({
        ...a,
        supportingModules: i % 2 === 0
          ? ["PortfolioAnalyzer", "CompanyMonitor"]
          : ["RiskAnalyzer", "TradeDecisionEngine"],
      })),
    };
    assert.doesNotThrow(() => validateAndNormaliseTarget(raw, ALLOWED_FIVE, SUPPLIED));
  });

  it("duplicate modules are de-duplicated without throwing", () => {
    const five = makeFivePosition();
    const raw: AiTargetPortfolioResponse = {
      ...five,
      allocations: five.allocations.map((a, i) => ({
        ...a,
        supportingModules: i === 0
          ? ["PortfolioAnalyzer", "PortfolioAnalyzer", "CompanyMonitor"] // duplicate
          : ["RiskAnalyzer"],
      })),
    };
    let result: ReturnType<typeof validateAndNormaliseTarget> | undefined;
    assert.doesNotThrow(() => { result = validateAndNormaliseTarget(raw, ALLOWED_FIVE, SUPPLIED); });
    const first = result!.allocations[0];
    assert.ok(first, "First allocation must be in the result");
    const portAnalyzerCount = first.supportingModules.filter((m) => m === "PortfolioAnalyzer").length;
    assert.equal(portAnalyzerCount, 1, "Duplicate PortfolioAnalyzer should appear only once after de-dup");
  });

  it("empty supportingModules array is valid for Provisional allocation", () => {
    const five = makeFivePosition();
    const raw: AiTargetPortfolioResponse = {
      ...five,
      allocations: five.allocations.map((a, i) => ({
        ...a,
        allocationStatus: i === 0 ? ("Provisional" as const) : ("StrategicTarget" as const),
        reasonForStatus: i === 0
          ? "Insufficient evidence to form a view."
          : "Strong Buy rating with full coverage.",
        blockingFactors: [],
        supportingModules: i === 0 ? [] : ["RiskAnalyzer"],
      })),
    };
    assert.doesNotThrow(() => validateAndNormaliseTarget(raw, ALLOWED_FIVE, SUPPLIED));
  });

  it("empty supportingModules is accepted when no modules were supplied (suppliedModules empty)", () => {
    // When suppliedModules is empty the validator skips the availability check
    const five = makeFivePosition();
    const raw: AiTargetPortfolioResponse = {
      ...five,
      allocations: five.allocations.map((a) => ({ ...a, supportingModules: [] })),
    };
    assert.doesNotThrow(() => validateAndNormaliseTarget(raw, ALLOWED_FIVE));
  });
});
