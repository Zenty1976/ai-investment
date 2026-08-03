/**
 * Tests for portfolio-capital-allocation-engine.ts
 *
 * Key invariants exercised:
 * 1. When deployable cash > aggregate gap value, total deployment is capped at
 *    the aggregate gap — excess cash stays as residual.
 * 2. Each item's suggestedAmountBase never exceeds its own position gap value.
 * 3. Empty or zero-value portfolios return safe zero-deployment plans.
 * 4. Gap-free portfolios (all positions at or above target) return no items.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCapitalAllocation } from "../portfolio-capital-allocation-engine.js";
import type { PortfolioSnapshot } from "../../routes/portfolio-manager.js";
import type { TargetPortfolio } from "../portfolio-manager-v2-types.js";

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
  allocations: Array<{ ticker: string; targetPercent: number }>
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
    })),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("portfolio capital allocation engine", () => {
  it("caps total deployment at aggregate gap value when cash exceeds all gaps", () => {
    // Portfolio: totalValue 1,000,000 DKK
    //   AAPL: 100,000 (10%)
    //   Cash: 500,000 (50%) — very high
    // Target: AAPL 15% (gap 5% = 50,000), MSFT 10% (gap 10% = 100,000)
    // cashTargetPercent 10% → floor 100,000 → deployable = 400,000
    // Aggregate gaps = 150,000 → should only deploy 150,000, not 400,000
    const snapshot = makeSnapshot(1_000_000, 500_000, [
      { symbol: "AAPL", marketValueBaseCurrency: 100_000 },
    ]);
    const target = makeTarget(10, [
      { ticker: "AAPL", targetPercent: 15 },
      { ticker: "MSFT", targetPercent: 10 },
    ]);

    const plan = computeCapitalAllocation(snapshot, target);

    // Total suggested must not exceed the sum of position gaps in DKK
    const aaplGap = 50_000;   // 5% of 1,000,000
    const msftGap = 100_000;  // 10% of 1,000,000 (missing position)
    const aggregateGap = aaplGap + msftGap; // 150,000

    assert.ok(
      plan.totalSuggestedDeploymentBase <= aggregateGap + 1,
      `totalSuggestedDeploymentBase (${plan.totalSuggestedDeploymentBase}) must be ≤ aggregate gap (${aggregateGap})`
    );
    assert.ok(
      plan.totalSuggestedDeploymentBase > 0,
      "totalSuggestedDeploymentBase must be > 0 when there are gaps"
    );
    // Residual cash should be high (most of the excess stays)
    assert.ok(
      plan.residualCashAfterDeploymentBase >= 500_000 - aggregateGap - 100,
      "residual cash should reflect excess above aggregate gaps"
    );
  });

  it("caps each item at its own position gap value", () => {
    // Portfolio: totalValue 1,000,000
    //   AAPL: 800,000 (80%)
    //   Cash: 200,000 (20%)
    // Target: AAPL 85% (gap 5% = 50,000), MSFT 10% (gap 10% = 100,000)
    // cashTarget 5% → floor 50,000 → deployable = 150,000
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
    // availableCash == cashFloor exactly → deployable = 0
    const snapshot = makeSnapshot(1_000_000, 100_000, [
      { symbol: "AAPL", marketValueBaseCurrency: 900_000 },
    ]);
    const target = makeTarget(10, [
      { ticker: "AAPL", targetPercent: 90 },
    ]);

    const plan = computeCapitalAllocation(snapshot, target);
    assert.equal(plan.deployableCashBase, 0);
    assert.equal(plan.totalSuggestedDeploymentBase, 0);
    assert.deepEqual(plan.items, []);
  });

  it("returns no items when all positions are at or above their target", () => {
    // AAPL at 50%, target 45% — overweight, no gap
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
    // Two equal gaps: AAPL 10%, MSFT 10% — each should get ~50% of deployable
    const snapshot = makeSnapshot(1_000_000, 300_000, [
      { symbol: "AAPL", marketValueBaseCurrency: 350_000 },
      { symbol: "MSFT", marketValueBaseCurrency: 350_000 },
    ]);
    const target = makeTarget(10, [
      { ticker: "AAPL", targetPercent: 45 },  // gap 10%
      { ticker: "MSFT", targetPercent: 45 },  // gap 10%
    ]);

    const plan = computeCapitalAllocation(snapshot, target);
    assert.equal(plan.items.length, 2);
    // Both gaps equal → each item should be within 10% of each other
    const [a, b] = plan.items.sort((x, y) => x.ticker.localeCompare(y.ticker));
    assert.ok(
      Math.abs(a.suggestedAmountBase - b.suggestedAmountBase) <= 100,
      "Equal gaps should produce approximately equal deployment amounts"
    );
  });
});
