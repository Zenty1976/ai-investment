/**
 * Tests for portfolio-capital-allocation-engine.ts
 *
 * Key invariants exercised:
 * 1. When deployable cash > aggregate gap value, total deployment is capped at
 *    the aggregate gap — excess cash stays as residual.
 * 2. Each item's suggestedAmountBase never exceeds its own position gap value.
 * 3. Empty or zero-value portfolios return safe zero-deployment plans.
 * 4. Gap-free portfolios (all positions at or above target) return no items.
 * 5. TargetPortfolio must never be mutated by computeCapitalAllocation.
 * 6. Excluded allocations are returned in excludedItems, NOT in provisionalItems.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCapitalAllocation } from "../portfolio-capital-allocation-engine.js";
import type { PortfolioSnapshot } from "../../routes/portfolio-manager.js";
import type {
  TargetPortfolio,
  TargetAllocation,
  LegacyTargetPortfolio,
} from "../portfolio-manager-v2-types.js";

// ── Minimal fixture helpers ──────────────────────────────────────────────────

function makeSnapshot(
  totalValue: number,
  availableCash: number,
  positions: Array<{ symbol: string; marketValueBaseCurrency: number }>
): PortfolioSnapshot {
  return {
    updatedAt: "2026-01-01T00:00:00.000Z",
    environment: "sim",
    baseCurrency: "DKK",
    totalValue,
    totalAvailableCash: availableCash,
    totalUnrealizedProfitLoss: 0,
    isMockData: true,
    accounts: [
      {
        accountKey: "ACC1",
        accountId: "ACC1",
        accountName: "Test Account",
        accountType: "Normal",
        currency: "DKK",
        availableCash,
        accountValue: totalValue,
        unrealizedProfitLoss: 0,
        positions: positions.map((p, i) => ({
          id: `pos-${i}`,
          name: p.symbol,
          symbol: p.symbol,
          assetType: "Stock",
          exchange: "NASDAQ",
          currency: "DKK",
          accountKey: "ACC1",
          quantity: 100,
          direction: "Buy",
          averageOpenPrice: p.marketValueBaseCurrency / 100,
          currentPrice: p.marketValueBaseCurrency / 100,
          marketValue: p.marketValueBaseCurrency,
          marketValueBaseCurrency: p.marketValueBaseCurrency,
          profitLoss: 0,
          dayChangePercent: 0,
          priceDelayMinutes: 0,
          isMarketOpen: true,
        })),
      },
    ],
  };
}

function makeTarget(
  cashTargetPercent: number,
  allocations: Array<{ ticker: string; targetPercent: number; allocationStatus?: TargetAllocation["allocationStatus"] }>
): TargetPortfolio {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    totalEquityTargetPercent: 100 - cashTargetPercent,
    cashTargetPercent,
    strategicRationale: "Test target",
    keyAssumptions: [],
    allocations: allocations.map((a) => ({
      ticker: a.ticker,
      company: a.ticker,
      role: "CoreHolding",
      targetPercent: a.targetPercent,
      minPercent: 0,
      maxPercent: 50,
      rationale: "Test",
      // Default to StrategicTarget in fixtures — mirrors what strict validation
      // now enforces. Tests that exercise missing-status behaviour set
      // allocationStatus: undefined explicitly on individual TargetPortfolio objects.
      allocationStatus: a.allocationStatus ?? "StrategicTarget",
    })),
  };
}

// ── Existing tests ────────────────────────────────────────────────────────────

describe("portfolio capital allocation engine", () => {
  it("caps total deployment at aggregate gap value when cash exceeds all gaps", () => {
    const snapshot = makeSnapshot(1_000_000, 500_000, [
      { symbol: "AAPL", marketValueBaseCurrency: 100_000 },
    ]);
    const target = makeTarget(10, [
      { ticker: "AAPL", targetPercent: 15 },
      { ticker: "MSFT", targetPercent: 10 },
    ]);

    const plan = computeCapitalAllocation(snapshot, target);

    const aaplGap = 50_000;
    const msftGap = 100_000;
    const aggregateGap = aaplGap + msftGap;

    assert.ok(
      plan.totalSuggestedDeploymentBase <= aggregateGap + 1,
      `totalSuggestedDeploymentBase (${plan.totalSuggestedDeploymentBase}) must be ≤ aggregate gap (${aggregateGap})`
    );
    assert.ok(plan.totalSuggestedDeploymentBase > 0);
    assert.ok(plan.residualCashAfterDeploymentBase >= 500_000 - aggregateGap - 100);
  });

  it("caps each item at its own position gap value", () => {
    const snapshot = makeSnapshot(1_000_000, 200_000, [
      { symbol: "AAPL", marketValueBaseCurrency: 800_000 },
    ]);
    const target = makeTarget(5, [
      { ticker: "AAPL", targetPercent: 85 },
      { ticker: "MSFT", targetPercent: 10 },
    ]);

    const plan = computeCapitalAllocation(snapshot, target);

    for (const item of plan.items) {
      const gapValueBase = (item.gapPercent / 100) * 1_000_000;
      assert.ok(
        item.suggestedAmountBase <= gapValueBase + 1,
        `${item.ticker} suggestedAmountBase (${item.suggestedAmountBase}) must be ≤ gap value (${gapValueBase})`
      );
    }
  });

  it("returns zero deployment when no cash is deployable (cash at floor)", () => {
    const snapshot = makeSnapshot(1_000_000, 100_000, [
      { symbol: "AAPL", marketValueBaseCurrency: 900_000 },
    ]);
    const target = makeTarget(10, [{ ticker: "AAPL", targetPercent: 90 }]);

    const plan = computeCapitalAllocation(snapshot, target);
    assert.equal(plan.deployableCashBase, 0);
    assert.equal(plan.totalSuggestedDeploymentBase, 0);
    assert.deepEqual(plan.items, []);
  });

  it("returns no items when all positions are at or above their target", () => {
    const snapshot = makeSnapshot(1_000_000, 100_000, [
      { symbol: "AAPL", marketValueBaseCurrency: 500_000 },
      { symbol: "MSFT", marketValueBaseCurrency: 400_000 },
    ]);
    const target = makeTarget(10, [
      { ticker: "AAPL", targetPercent: 45 },
      { ticker: "MSFT", targetPercent: 40 },
    ]);

    const plan = computeCapitalAllocation(snapshot, target);
    assert.deepEqual(plan.items, []);
    assert.equal(plan.totalSuggestedDeploymentBase, 0);
  });

  it("returns zero-deployment plan for empty portfolio", () => {
    const snapshot = makeSnapshot(0, 0, []);
    const target = makeTarget(10, [{ ticker: "AAPL", targetPercent: 90 }]);

    const plan = computeCapitalAllocation(snapshot, target);
    assert.equal(plan.deployableCashBase, 0);
    assert.equal(plan.totalSuggestedDeploymentBase, 0);
    assert.deepEqual(plan.items, []);
  });

  it("proportional allocation distributes across multiple gaps", () => {
    const snapshot = makeSnapshot(1_000_000, 300_000, [
      { symbol: "AAPL", marketValueBaseCurrency: 350_000 },
      { symbol: "MSFT", marketValueBaseCurrency: 350_000 },
    ]);
    const target = makeTarget(10, [
      { ticker: "AAPL", targetPercent: 45 },
      { ticker: "MSFT", targetPercent: 45 },
    ]);

    const plan = computeCapitalAllocation(snapshot, target);
    assert.equal(plan.items.length, 2);
    const [a, b] = plan.items.sort((x, y) => x.ticker.localeCompare(y.ticker));
    assert.ok(
      Math.abs(a.suggestedAmountBase - b.suggestedAmountBase) <= 100,
      "Equal gaps should produce approximately equal deployment amounts"
    );
  });
});

// ── Immutability guarantee ─────────────────────────────────────────────────────

describe("portfolio capital allocation engine — immutability", () => {
  it("does NOT mutate the supplied TargetPortfolio or its allocations", () => {
    // Set up a portfolio where AAPL is StrategicTarget but TDE says it's blocked.
    // Before the fix, computeCapitalAllocation wrote alloc.allocationStatus = "Blocked".
    const snapshot = makeSnapshot(1_000_000, 300_000, [
      { symbol: "MSFT", marketValueBaseCurrency: 700_000 },
    ]);
    const target = makeTarget(10, [
      { ticker: "AAPL", targetPercent: 20, allocationStatus: "StrategicTarget" },
      { ticker: "MSFT", targetPercent: 70 },
    ]);

    // Deep-clone the original allocation statuses before the call
    const originalStatuses = target.allocations.map((a) => ({
      ticker: a.ticker,
      allocationStatus: a.allocationStatus,
    }));
    const originalAllocRef = target.allocations[0]; // reference to the first alloc object

    // Call with a TDE entry that says AAPL is blocked
    const tde = new Map([
      ["AAPL", { readiness: "WaitingForReevaluation", blockedByEvent: false }],
    ]);

    computeCapitalAllocation(snapshot, target, tde);

    // The TargetPortfolio object must be unchanged
    for (let i = 0; i < originalStatuses.length; i++) {
      assert.equal(
        target.allocations[i].allocationStatus,
        originalStatuses[i].allocationStatus,
        `Allocation ${originalStatuses[i].ticker} was mutated: ` +
        `original "${originalStatuses[i].allocationStatus}" → now "${target.allocations[i].allocationStatus}"`
      );
    }

    // The object reference must be the same (no copy was created)
    assert.strictEqual(target.allocations[0], originalAllocRef, "Allocation object reference changed");
  });

  it("TDE override produces the correct effectiveStatus in the output without touching the source", () => {
    const snapshot = makeSnapshot(1_000_000, 300_000, [
      { symbol: "MSFT", marketValueBaseCurrency: 700_000 },
    ]);
    const target = makeTarget(10, [
      { ticker: "AAPL", targetPercent: 20, allocationStatus: "StrategicTarget" },
    ]);

    const tde = new Map([
      ["AAPL", { readiness: "WaitingForReevaluation", blockedByEvent: false }],
    ]);

    const plan = computeCapitalAllocation(snapshot, target, tde);

    // Should appear in provisionalItems (WaitingForReevaluation → Provisional)
    assert.equal(plan.provisionalItems.length, 1);
    assert.equal(plan.provisionalItems[0].ticker, "AAPL");
    assert.equal(plan.provisionalItems[0].allocationStatus, "Provisional");

    // Source alloc must remain StrategicTarget
    assert.equal(target.allocations[0].allocationStatus, "StrategicTarget");
  });
});

// ── Excluded allocations ──────────────────────────────────────────────────────

describe("portfolio capital allocation engine — Excluded allocations", () => {
  it("Excluded allocations appear in excludedItems, NOT in provisionalItems", () => {
    const snapshot = makeSnapshot(1_000_000, 300_000, [
      { symbol: "MSFT", marketValueBaseCurrency: 700_000 },
    ]);
    const target = makeTarget(10, [
      { ticker: "AAPL", targetPercent: 20, allocationStatus: "Excluded" },
    ]);

    const plan = computeCapitalAllocation(snapshot, target);

    assert.equal(plan.provisionalItems.length, 0, "Excluded must not appear in provisionalItems");
    assert.equal(plan.excludedItems.length, 1, "Excluded must appear in excludedItems");
    assert.equal(plan.excludedItems[0].ticker, "AAPL");
    assert.equal(plan.excludedItems[0].allocationStatus, "Excluded");
    assert.equal(plan.excludedItems[0].suggestedAmountBase, 0, "No capital suggested for Excluded");
  });

  it("Excluded allocations do not contribute to deployment suggestions", () => {
    const snapshot = makeSnapshot(1_000_000, 400_000, [
      { symbol: "MSFT", marketValueBaseCurrency: 600_000 },
    ]);
    const target = makeTarget(10, [
      { ticker: "AAPL", targetPercent: 20, allocationStatus: "Excluded" },
      { ticker: "MSFT", targetPercent: 70, allocationStatus: "StrategicTarget" },
    ]);

    const plan = computeCapitalAllocation(snapshot, target);

    // Only MSFT (StrategicTarget, underweight) should be in actionableItems
    assert.equal(plan.actionableItems.length, 1);
    assert.equal(plan.actionableItems[0].ticker, "MSFT");

    // AAPL must not appear anywhere except excludedItems
    const aapl = [
      ...plan.actionableItems,
      ...plan.blockedItems,
      ...plan.provisionalItems,
    ].find((i) => i.ticker === "AAPL");
    assert.equal(aapl, undefined, "AAPL should not appear in actionable/blocked/provisional");
  });
});

// ── Missing allocationStatus — never actionable ───────────────────────────────

describe("portfolio capital allocation engine — missing allocationStatus", () => {
  it("a missing allocationStatus cannot create an actionable capital-allocation item", () => {
    // Simulates a stored target from before strict validation was added.
    // The allocation has no allocationStatus field (undefined).
    const snapshot = makeSnapshot(1_000_000, 400_000, [
      { symbol: "MSFT", marketValueBaseCurrency: 600_000 },
    ]);

    // Build a pre-v2.1 legacy target where AAPL has no allocationStatus.
    // LegacyTargetPortfolio is the correct type for this scenario — it represents
    // stored targets generated before strict validation was enforced.
    const targetWithMissing: LegacyTargetPortfolio = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      totalEquityTargetPercent: 90,
      cashTargetPercent: 10,
      strategicRationale: "Old target without allocationStatus",
      keyAssumptions: [],
      allocations: [
        {
          ticker: "AAPL",
          company: "Apple",
          role: "CoreHolding",
          targetPercent: 20,
          minPercent: 0,
          maxPercent: 50,
          rationale: "Old target",
          // allocationStatus intentionally absent — simulates pre-v2.1 stored target
        },
        {
          ticker: "MSFT",
          company: "Microsoft",
          role: "CoreHolding",
          targetPercent: 70,
          minPercent: 0,
          maxPercent: 80,
          rationale: "Core holding",
          allocationStatus: "StrategicTarget",
        },
      ],
    };

    const plan = computeCapitalAllocation(snapshot, targetWithMissing);

    // AAPL must NOT appear in actionableItems — missing status is not StrategicTarget
    const aaplActionable = plan.actionableItems.find((i) => i.ticker === "AAPL");
    assert.equal(
      aaplActionable,
      undefined,
      "Allocation with missing allocationStatus must never become actionable"
    );

    // AAPL should appear in provisionalItems (the safe fallback) with zero suggested amount
    const aaplProvisional = plan.provisionalItems.find((i) => i.ticker === "AAPL");
    assert.ok(aaplProvisional, "Allocation with missing allocationStatus should be in provisionalItems");
    assert.equal(
      aaplProvisional!.suggestedAmountBase,
      0,
      "No capital must be suggested for an allocation with missing status"
    );
  });

  it("missing allocationStatus blocking reason mentions regeneration", () => {
    const snapshot = makeSnapshot(1_000_000, 400_000, [
      { symbol: "MSFT", marketValueBaseCurrency: 600_000 },
    ]);
    const targetWithMissing: LegacyTargetPortfolio = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      totalEquityTargetPercent: 90,
      cashTargetPercent: 10,
      strategicRationale: "Old target",
      keyAssumptions: [],
      allocations: [{
        ticker: "AAPL",
        company: "Apple",
        role: "CoreHolding",
        targetPercent: 20,
        minPercent: 0,
        maxPercent: 50,
        rationale: "Old",
        // allocationStatus absent — simulates pre-v2.1 stored target
      }],
    };

    const plan = computeCapitalAllocation(snapshot, targetWithMissing);
    const aaplProvisional = plan.provisionalItems.find((i) => i.ticker === "AAPL");
    assert.ok(aaplProvisional, "AAPL must be in provisionalItems");
    assert.ok(
      /regenerat/i.test(aaplProvisional!.blockingReason ?? ""),
      `blockingReason should mention regeneration; got: "${aaplProvisional!.blockingReason}"`
    );
  });
});
