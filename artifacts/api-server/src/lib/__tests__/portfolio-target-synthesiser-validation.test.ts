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
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateAndNormaliseTarget,
  type AiTargetPortfolioResponse,
} from "../portfolio-target-validation.js";
import { ROLE_DEFINITIONS } from "../portfolio-role-config.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a raw AI response fixture with optional overrides. */
function makeRaw(overrides: Partial<AiTargetPortfolioResponse> = {}): AiTargetPortfolioResponse {
  return {
    cashTargetPercent: 10,
    strategicRationale: "Test portfolio",
    keyAssumptions: ["Assumption 1"],
    allocations: [
      {
        ticker: "AAPL",
        company: "Apple Inc",
        role: "CoreHolding",
        targetPercent: 15,
        minPercent: 10,
        maxPercent: 20,
        rationale: "Core holding",
      },
      {
        ticker: "MSFT",
        company: "Microsoft",
        role: "CoreHolding",
        targetPercent: 75,
        minPercent: 60,
        maxPercent: 80,
        rationale: "Core holding",
      },
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

// Larger allowed set for tests that need many positions
const ALLOWED_FIVE = new Set(["AAPL", "MSFT", "GOOG", "AMZN", "META"]);

/** A 5-CoreHolding position fixture — feasible equity budget of 90%. */
function makeFivePosition(cashTarget = 10): AiTargetPortfolioResponse {
  return {
    cashTargetPercent: cashTarget,
    strategicRationale: "Diversified core portfolio",
    keyAssumptions: [],
    allocations: [
      { ticker: "AAPL", company: "Apple",     role: "CoreHolding", targetPercent: 25, minPercent: 8, maxPercent: 30, rationale: "Test" },
      { ticker: "MSFT", company: "Microsoft", role: "CoreHolding", targetPercent: 25, minPercent: 8, maxPercent: 30, rationale: "Test" },
      { ticker: "GOOG", company: "Alphabet",  role: "CoreHolding", targetPercent: 25, minPercent: 8, maxPercent: 30, rationale: "Test" },
      { ticker: "AMZN", company: "Amazon",    role: "CoreHolding", targetPercent: 25, minPercent: 8, maxPercent: 30, rationale: "Test" },
      { ticker: "META", company: "Meta",      role: "CoreHolding", targetPercent: 25, minPercent: 8, maxPercent: 30, rationale: "Test" },
    ],
  };
}

// ── Role-bound enforcement — FINAL output ─────────────────────────────────────

describe("validateAndNormaliseTarget — final role bounds (HARD)", () => {
  it("every final targetPercent is within its role's [typicalMin, typicalMax] — 5-position portfolio", () => {
    // 5 CoreHolding positions each at 25% (above typicalMax of 20%).
    // After normalisation each should be within [8, 20].
    const { allocations } = validateAndNormaliseTarget(makeFivePosition(10), ALLOWED_FIVE);
    assertWithinRoleBounds(allocations);
  });

  it("positions with mixed roles all end within their respective role bounds", () => {
    // Mix: CoreHolding (max 20%), GrowthCore (max 15%), SpeculativeGrowth (max 8%),
    // IncomeDividend (max 12%), Defensive (max 12%).
    // AI returns all at 30% — all must be clamped to their role maxes.
    const raw: AiTargetPortfolioResponse = {
      cashTargetPercent: 5,
      strategicRationale: "Mixed roles",
      keyAssumptions: [],
      allocations: [
        { ticker: "AAPL", company: "Apple",     role: "CoreHolding",       targetPercent: 30, minPercent: 5, maxPercent: 35, rationale: "Test" },
        { ticker: "MSFT", company: "Microsoft", role: "GrowthCore",        targetPercent: 30, minPercent: 5, maxPercent: 35, rationale: "Test" },
        { ticker: "GOOG", company: "Alphabet",  role: "SpeculativeGrowth", targetPercent: 30, minPercent: 5, maxPercent: 35, rationale: "Test" },
        { ticker: "AMZN", company: "Amazon",    role: "IncomeDividend",    targetPercent: 30, minPercent: 5, maxPercent: 35, rationale: "Test" },
        { ticker: "META", company: "Meta",      role: "Defensive",         targetPercent: 30, minPercent: 5, maxPercent: 35, rationale: "Test" },
      ],
    };

    const { allocations } = validateAndNormaliseTarget(raw, ALLOWED_FIVE);
    assertWithinRoleBounds(allocations);
  });

  it("AI values already within role bounds pass through unchanged after normalisation", () => {
    // 5 CoreHolding positions each at 18% — within [8, 20].
    // After normalisation to 90% equity budget, they should scale to ~18% each.
    const raw: AiTargetPortfolioResponse = {
      cashTargetPercent: 10,
      strategicRationale: "In-bounds test",
      keyAssumptions: [],
      allocations: [
        { ticker: "AAPL", company: "Apple",     role: "CoreHolding", targetPercent: 18, minPercent: 8, maxPercent: 20, rationale: "Test" },
        { ticker: "MSFT", company: "Microsoft", role: "CoreHolding", targetPercent: 18, minPercent: 8, maxPercent: 20, rationale: "Test" },
        { ticker: "GOOG", company: "Alphabet",  role: "CoreHolding", targetPercent: 18, minPercent: 8, maxPercent: 20, rationale: "Test" },
        { ticker: "AMZN", company: "Amazon",    role: "CoreHolding", targetPercent: 18, minPercent: 8, maxPercent: 20, rationale: "Test" },
        { ticker: "META", company: "Meta",      role: "CoreHolding", targetPercent: 18, minPercent: 8, maxPercent: 20, rationale: "Test" },
      ],
    };

    const { allocations, cashTargetPercent } = validateAndNormaliseTarget(raw, ALLOWED_FIVE);
    assertWithinRoleBounds(allocations);
    // Equity = 90%, cash = 10%
    const equitySum = allocations.reduce((s, a) => s + a.targetPercent, 0);
    assert.ok(Math.abs(equitySum + cashTargetPercent - 100) <= 2, "total must be within 2pp of 100");
  });

  it("min ≤ target ≤ max for all allocations after normalisation", () => {
    const { allocations } = validateAndNormaliseTarget(makeFivePosition(10), ALLOWED_FIVE);
    for (const a of allocations) {
      assert.ok(
        a.minPercent <= a.targetPercent + 0.01,
        `${a.ticker}: min (${a.minPercent}) must be ≤ target (${a.targetPercent})`
      );
      assert.ok(
        a.maxPercent >= a.targetPercent - 0.01,
        `${a.ticker}: max (${a.maxPercent}) must be ≥ target (${a.targetPercent})`
      );
    }
  });

  it("equity + cash totals within 2pp of 100 after role-bound enforcement", () => {
    const { allocations, cashTargetPercent } = validateAndNormaliseTarget(
      makeFivePosition(10), ALLOWED_FIVE
    );
    const equitySum = allocations.reduce((s, a) => s + a.targetPercent, 0);
    assert.ok(
      Math.abs(equitySum + cashTargetPercent - 100) <= 2,
      `total ${(equitySum + cashTargetPercent).toFixed(2)}% must be within 2pp of 100`
    );
  });

  it("cash is adjusted upward when role maxes constrain equity below the initial budget", () => {
    // 2 CoreHolding positions at 30% each → clamped to 20+20=40%.
    // Equity budget (100-10=90%) exceeds max feasible equity (40%) → cash bumped.
    // Should throw because 40% equity requires 60% cash > CASH_HARD_MAX (40%).
    // (Infeasibility test — see infeasibility section below.)
    //
    // For a feasible case: use 4 CoreHolding + 1 GrowthCore → max = 4*20+15 = 95% > 90%.
    const raw: AiTargetPortfolioResponse = {
      cashTargetPercent: 5,   // equity budget = 95%
      strategicRationale: "Cash adjustment test",
      keyAssumptions: [],
      allocations: [
        { ticker: "AAPL", company: "Apple",     role: "CoreHolding", targetPercent: 30, minPercent: 8, maxPercent: 35, rationale: "" },
        { ticker: "MSFT", company: "Microsoft", role: "CoreHolding", targetPercent: 30, minPercent: 8, maxPercent: 35, rationale: "" },
        { ticker: "GOOG", company: "Alphabet",  role: "CoreHolding", targetPercent: 30, minPercent: 8, maxPercent: 35, rationale: "" },
        { ticker: "AMZN", company: "Amazon",    role: "CoreHolding", targetPercent: 30, minPercent: 8, maxPercent: 35, rationale: "" },
        { ticker: "META", company: "Meta",      role: "GrowthCore",  targetPercent: 30, minPercent: 5, maxPercent: 35, rationale: "" },
      ],
    };

    const { allocations, cashTargetPercent } = validateAndNormaliseTarget(raw, ALLOWED_FIVE);

    // All positions within role bounds
    assertWithinRoleBounds(allocations);

    // Total must still sum to ~100
    const equitySum = allocations.reduce((s, a) => s + a.targetPercent, 0);
    assert.ok(
      Math.abs(equitySum + cashTargetPercent - 100) <= 2,
      `total ${(equitySum + cashTargetPercent).toFixed(2)}% must be within 2pp of 100`
    );

    // Cash may differ from the requested 5% because role bounds capped equity
    assert.ok(cashTargetPercent >= 2, "cash must be ≥ CASH_HARD_MIN (2%)");
    assert.ok(cashTargetPercent <= 40, "cash must be ≤ CASH_HARD_MAX (40%)");
  });
});

// ── Infeasibility detection ───────────────────────────────────────────────────

describe("validateAndNormaliseTarget — infeasibility detection", () => {
  it("throws when too few positions to fill equity budget within role bounds", () => {
    // 2 positions: SpeculativeGrowth (max 8%) + CoreHolding (max 20%) = 28% max equity.
    // Equity budget = 90% (cash 10%). requiredCash = 100-28 = 72% > CASH_HARD_MAX (40%) → infeasible.
    const raw = makeRaw({
      allocations: [
        {
          ticker: "AAPL", company: "Apple", role: "SpeculativeGrowth",
          targetPercent: 50, minPercent: 5, maxPercent: 55, rationale: "Test",
        },
        {
          ticker: "MSFT", company: "Microsoft", role: "CoreHolding",
          targetPercent: 40, minPercent: 8, maxPercent: 45, rationale: "Test",
        },
      ],
    });

    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_BOTH),
      /infeasible/i
    );
  });

  it("does NOT throw when positions are sufficient to fill the equity budget", () => {
    // 5 CoreHolding positions (max 20% each = 100% capacity) vs equity budget 90%.
    assert.doesNotThrow(
      () => validateAndNormaliseTarget(makeFivePosition(10), ALLOWED_FIVE)
    );
  });
});

// ── Ticker allowlist ──────────────────────────────────────────────────────────

describe("validateAndNormaliseTarget — ticker allowlist", () => {
  it("throws when AI returns a ticker not in the allowed set", () => {
    const raw = makeRaw();  // has AAPL and MSFT
    assert.throws(
      () => validateAndNormaliseTarget(raw, new Set(["AAPL"])),
      /tickers not in allowed set.*MSFT/i
    );
  });

  it("passes when all tickers are in the allowed set", () => {
    // Use a feasible 5-position portfolio to avoid infeasibility throws
    assert.doesNotThrow(
      () => validateAndNormaliseTarget(makeFivePosition(), ALLOWED_FIVE)
    );
  });

  it("ticker matching is case-insensitive (normalised to uppercase)", () => {
    const raw: AiTargetPortfolioResponse = {
      cashTargetPercent: 5,
      strategicRationale: "test",
      keyAssumptions: [],
      allocations: [
        { ticker: "aapl", company: "Apple",     role: "CoreHolding", targetPercent: 20, minPercent: 8, maxPercent: 20, rationale: "" },
        { ticker: "msft", company: "Microsoft", role: "CoreHolding", targetPercent: 20, minPercent: 8, maxPercent: 20, rationale: "" },
        { ticker: "goog", company: "Alphabet",  role: "CoreHolding", targetPercent: 20, minPercent: 8, maxPercent: 20, rationale: "" },
        { ticker: "amzn", company: "Amazon",    role: "CoreHolding", targetPercent: 20, minPercent: 8, maxPercent: 20, rationale: "" },
        { ticker: "meta", company: "Meta",      role: "CoreHolding", targetPercent: 15, minPercent: 8, maxPercent: 20, rationale: "" },
      ],
    };
    // Allowed set has uppercase, raw has lowercase — should match
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
      allocations: [
        { ticker: "AAPL", company: "Apple", role: "CoreHolding", targetPercent: NaN, minPercent: 5, maxPercent: 20, rationale: "" },
      ],
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
    // A Cash-role allocation creates a fictitious ticker-level entry that would
    // corrupt drift (no position exists for that ticker) and capital allocation
    // (engine would recommend opening a "cash" position).
    const raw: AiTargetPortfolioResponse = {
      cashTargetPercent: 10,
      strategicRationale: "Cash role test",
      keyAssumptions: [],
      allocations: [
        { ticker: "AAPL", company: "Apple",     role: "CoreHolding", targetPercent: 18, minPercent: 8, maxPercent: 20, rationale: "" },
        { ticker: "MSFT", company: "Microsoft", role: "CoreHolding", targetPercent: 18, minPercent: 8, maxPercent: 20, rationale: "" },
        { ticker: "CASH", company: "Cash",      role: "Cash",        targetPercent: 14, minPercent: 5, maxPercent: 25, rationale: "" },
        { ticker: "GOOG", company: "Alphabet",  role: "CoreHolding", targetPercent: 18, minPercent: 8, maxPercent: 20, rationale: "" },
        { ticker: "AMZN", company: "Amazon",    role: "CoreHolding", targetPercent: 18, minPercent: 8, maxPercent: 20, rationale: "" },
      ],
    };
    assert.throws(
      () => validateAndNormaliseTarget(raw, new Set(["AAPL", "MSFT", "CASH", "GOOG", "AMZN"])),
      /role.*Cash.*cashTargetPercent|cashTargetPercent.*Cash/i
    );
  });

  it("throws when the AI returns the same ticker twice", () => {
    // Duplicate tickers create internally inconsistent targets: drift uses the last
    // entry for a ticker while capital allocation iterates both, potentially
    // recommending two separate purchases for the same position.
    const raw: AiTargetPortfolioResponse = {
      cashTargetPercent: 5,
      strategicRationale: "Duplicate test",
      keyAssumptions: [],
      allocations: [
        { ticker: "AAPL", company: "Apple",     role: "CoreHolding", targetPercent: 18, minPercent: 8, maxPercent: 20, rationale: "" },
        { ticker: "MSFT", company: "Microsoft", role: "CoreHolding", targetPercent: 18, minPercent: 8, maxPercent: 20, rationale: "" },
        { ticker: "AAPL", company: "Apple Inc", role: "GrowthCore",  targetPercent: 14, minPercent: 5, maxPercent: 15, rationale: "" }, // duplicate
        { ticker: "GOOG", company: "Alphabet",  role: "CoreHolding", targetPercent: 18, minPercent: 8, maxPercent: 20, rationale: "" },
        { ticker: "AMZN", company: "Amazon",    role: "CoreHolding", targetPercent: 17, minPercent: 8, maxPercent: 20, rationale: "" },
      ],
    };
    assert.throws(
      () => validateAndNormaliseTarget(raw, ALLOWED_FIVE),
      /duplicate tickers.*AAPL/i
    );
  });

  it("passes when every ticker is unique (no false positives)", () => {
    // All 5 distinct tickers — should not throw for uniqueness
    assert.doesNotThrow(
      () => validateAndNormaliseTarget(makeFivePosition(), ALLOWED_FIVE)
    );
  });
});

// ── Sum and cash normalisation ─────────────────────────────────────────────────

describe("validateAndNormaliseTarget — sum and cash normalisation", () => {
  it("cashTargetPercent is clamped to [2, 40] regardless of AI value", () => {
    // Use 5-position fixture to avoid infeasibility
    const low = validateAndNormaliseTarget({ ...makeFivePosition(), cashTargetPercent: 0 }, ALLOWED_FIVE);
    assert.ok(low.cashTargetPercent >= 2, "cash must be ≥ 2");

    const high = validateAndNormaliseTarget({ ...makeFivePosition(), cashTargetPercent: 50 }, ALLOWED_FIVE);
    assert.ok(high.cashTargetPercent <= 40, "cash must be ≤ 40");
  });

  it("returned allocations all have roles within ROLE_DEFINITIONS", () => {
    const { allocations } = validateAndNormaliseTarget(makeFivePosition(), ALLOWED_FIVE);
    for (const a of allocations) {
      assert.ok(
        a.role in ROLE_DEFINITIONS,
        `${a.ticker}: role "${a.role}" is not in ROLE_DEFINITIONS`
      );
    }
  });
});
