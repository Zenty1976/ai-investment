/**
 * Portfolio Intelligence Engine — unit tests
 *
 * Uses Node.js built-in test runner (node:test).
 * Run via: node run-tests.mjs in artifacts/api-server/
 *
 * Imports ONLY from portfolio-facts.ts (types + pure fingerprint function)
 * to avoid pulling in portfolio-intelligence-engine.ts → price-context-service
 * → saxo-store → pino, which cannot be bundled by esbuild in ESM mode.
 *
 * Invariants tested:
 *
 *  Fingerprint stability:
 *   1.  Same PortfolioFacts + versions → same fingerprint (idempotent)
 *   2.  computedAt is NOT a field in PortfolioFacts — fingerprint is always
 *       pure from the facts themselves (no timestamp drift)
 *
 *  Market / sector version changes:
 *   3.  marketMaterialVersion bump → fingerprint changes
 *   4.  sectorMaterialVersion bump → fingerprint changes
 *
 *  Composition changes:
 *   5.  New ticker added → fingerprint changes
 *   6.  holdingCount changes → fingerprint changes
 *
 *  Allocation shifts:
 *   7.  Top-position weight shifts by 1% within 2% band → fingerprint unchanged
 *   8.  Top-position weight shifts by 3% crossing band → fingerprint changes
 *   9.  New sector exposure appears → fingerprint changes
 *  10.  Sector shift within 5% band → fingerprint unchanged
 *  11.  Currency exposure change crosses 5% band → fingerprint changes
 *
 *  Performance bands:
 *  12.  Portfolio 1D return changes within 3% band → fingerprint unchanged
 *  13.  Portfolio 1D return crosses 3% band → fingerprint changes
 *  14.  Portfolio 5D return crosses 5% band → fingerprint changes
 *
 *  Price-state changes (per-position):
 *  15.  priceState change for a holding (Flat → Downtrend) → fingerprint changes
 *  16.  volatilityState change (Normal → High) → fingerprint changes
 *  17.  recentBehaviorState appears (null → FallingFast) → fingerprint changes
 *
 *  Company state signals:
 *  18.  Holding becomes Invalidated → fingerprint changes
 *  19.  Holding becomes Strengthened → fingerprint changes
 *  20.  Holding becomes Weakened → fingerprint changes
 *  21.  View changes from Buy to Avoid → fingerprint changes (avoidView + viewDistribution)
 *
 *  Events:
 *  22.  New event enters 7-day window → fingerprint changes
 *  23.  Event importance changes (Medium → High) → fingerprint changes
 *  24.  Event affected holdings change → fingerprint changes
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computePortfolioFactsFingerprint,
  type PortfolioFacts,
  type HoldingPerformance,
} from "../portfolio-facts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const BASE_HOLDING: HoldingPerformance = {
  ticker: "AAPL",
  investedWeightPct: 44,
  return1D: 1.2,
  return5D: 3.5,
  return1M: -2.1,
  contribution1DPct: 0.53,
};

const BASE_HOLDING_2: HoldingPerformance = {
  ticker: "MSFT",
  investedWeightPct: 56,
  return1D: -0.8,
  return5D: 2.1,
  return1M: 4.3,
  contribution1DPct: -0.45,
};

function basePortfolioFacts(overrides: Partial<PortfolioFacts> = {}): PortfolioFacts {
  return {
    portfolio: {
      totalValue: 100000,
      cashPct: 10,
      holdingCount: 2,
      baseCurrency: "USD",
    },
    performance: {
      perHolding: [BASE_HOLDING, BASE_HOLDING_2],
      topContributors: [BASE_HOLDING],
      topDetractors: [BASE_HOLDING_2],
      portfolioReturn1D: 0.08,
      portfolioReturn5D: 2.8,
      portfolioReturn1M: 1.2,
    },
    allocation: {
      topPositions: [
        { ticker: "MSFT", investedWeightPct: 56, sector: "Technology" },
        { ticker: "AAPL", investedWeightPct: 44, sector: "Technology" },
      ],
      sectorExposure: [{ name: "Technology", pct: 90 }],
      currencyExposure: [{ currency: "USD", pct: 90 }],
      largestPositionTicker: "MSFT",
      largestPositionPct: 56,
      top3Pct: 100,
      top3Tickers: ["MSFT", "AAPL"],
    },
    priceBehavior: {
      strongUptrendPct: 0,
      strongUptrendHoldings: [],
      strongDowntrendPct: 0,
      strongDowntrendHoldings: [],
      highVolatilityPct: 0,
      highVolatilityHoldings: [],
      fallingFastHoldings: [],
      risingHoldings: [],
      stabilizingFromDowntrendHoldings: [],
      perPositionState: {
        AAPL: { priceState: "Flat", volatilityState: "Normal", recentBehaviorState: null },
        MSFT: { priceState: "Uptrend", volatilityState: "Low", recentBehaviorState: null },
      },
    },
    companyState: {
      strengthenedHoldings: [],
      weakenedHoldings: [],
      invalidatedHoldings: [],
      lowCaseStrength: [],
      viewDistribution: { Buy: 2 },
      avoidViewHoldings: [],
    },
    events: {
      upcomingHoldingEvents: [],
    },
    notableFacts: [],
    ...overrides,
  };
}

function clone(facts: PortfolioFacts): PortfolioFacts {
  return JSON.parse(JSON.stringify(facts)) as PortfolioFacts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint — stability
// ─────────────────────────────────────────────────────────────────────────────

describe("computePortfolioFactsFingerprint — stability", () => {
  it("1. Same facts + versions → same fingerprint (idempotent)", () => {
    const fp1 = computePortfolioFactsFingerprint(basePortfolioFacts(), 1, 2);
    const fp2 = computePortfolioFactsFingerprint(basePortfolioFacts(), 1, 2);
    assert.equal(fp1, fp2, "Two calls with identical data must produce the same fingerprint");
  });

  it("2. Fingerprint is a 16-char hex string", () => {
    const fp = computePortfolioFactsFingerprint(basePortfolioFacts(), 0, 0);
    assert.match(fp, /^[0-9a-f]{16}$/, "Fingerprint must be 16-char lowercase hex");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint — market / sector version changes
// ─────────────────────────────────────────────────────────────────────────────

describe("computePortfolioFactsFingerprint — market/sector regime changes", () => {
  it("3. marketMaterialVersion bump → fingerprint changes", () => {
    const a = computePortfolioFactsFingerprint(basePortfolioFacts(), 1, 2);
    const b = computePortfolioFactsFingerprint(basePortfolioFacts(), 2, 2);
    assert.notEqual(a, b, "Market version bump must change the fingerprint");
  });

  it("4. sectorMaterialVersion bump → fingerprint changes", () => {
    const a = computePortfolioFactsFingerprint(basePortfolioFacts(), 1, 2);
    const b = computePortfolioFactsFingerprint(basePortfolioFacts(), 1, 3);
    assert.notEqual(a, b, "Sector version bump must change the fingerprint");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint — composition changes
// ─────────────────────────────────────────────────────────────────────────────

describe("computePortfolioFactsFingerprint — composition changes", () => {
  it("5. New ticker added to topPositions → fingerprint changes", () => {
    const a = basePortfolioFacts();
    const b = clone(a);
    b.allocation.topPositions.push({ ticker: "NVDA", investedWeightPct: 10, sector: "Technology" });
    b.priceBehavior.perPositionState["NVDA"] = {
      priceState: "StrongUptrend",
      volatilityState: "High",
      recentBehaviorState: null,
    };
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });

  it("6. holdingCount changes → fingerprint changes", () => {
    const a = basePortfolioFacts();
    const b = clone(a);
    b.portfolio.holdingCount = 3;
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint — allocation banding
// ─────────────────────────────────────────────────────────────────────────────

describe("computePortfolioFactsFingerprint — allocation banding", () => {
  it("7. Position weight shifts by 1% within 2% band → fingerprint unchanged", () => {
    // band(56,2) = 56, band(55,2) = 56 → same
    const a = basePortfolioFacts();
    const b = clone(a);
    b.allocation.topPositions[0]!.investedWeightPct = 55;
    assert.equal(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2),
      "A 1% position-weight change within the 2% band must not trigger a new AI call"
    );
  });

  it("8. Position weight shifts by 3% crossing band → fingerprint changes", () => {
    // band(56,2)=56, band(59,2)=60 → different
    const a = basePortfolioFacts();
    const b = clone(a);
    b.allocation.topPositions[0]!.investedWeightPct = 59;
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });

  it("9. New sector exposure appears → fingerprint changes", () => {
    const a = basePortfolioFacts();
    const b = clone(a);
    b.allocation.sectorExposure = [
      { name: "Technology", pct: 80 },
      { name: "Healthcare", pct: 10 },
    ];
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });

  it("10. Sector shift within 5% band → fingerprint unchanged", () => {
    // band(90,5)=90, band(92,5)=90 → same
    const a = basePortfolioFacts();
    const b = clone(a);
    b.allocation.sectorExposure = [{ name: "Technology", pct: 92 }];
    assert.equal(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2),
      "A 2% sector shift within the 5% band must not trigger a new AI call"
    );
  });

  it("11. Currency exposure crosses 5% band → fingerprint changes", () => {
    const a = basePortfolioFacts();
    const b = clone(a);
    b.allocation.currencyExposure = [
      { currency: "USD", pct: 80 },
      { currency: "EUR", pct: 10 },
    ];
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint — performance bands
// ─────────────────────────────────────────────────────────────────────────────

describe("computePortfolioFactsFingerprint — performance banding", () => {
  it("12. Portfolio 1D return changes within 3% band → fingerprint unchanged", () => {
    // band(0.08,3)=round(0.027)*3=0; band(1.4,3)=round(0.467)*3=0 → same
    // Note: 1.5/3=0.5 rounds UP to 1 → bands to 3, so 1.5 is a different band boundary.
    const a = basePortfolioFacts();
    const b = clone(a);
    b.performance.portfolioReturn1D = 1.4;
    assert.equal(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2),
      "Small daily return fluctuation within 3% band must not trigger a new AI call"
    );
  });

  it("13. Portfolio 1D return crosses 3% band → fingerprint changes", () => {
    // band(0.08,3)=0, band(3.5,3)=3 → different
    const a = basePortfolioFacts();
    const b = clone(a);
    b.performance.portfolioReturn1D = 3.5;
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2),
      "A 3%+ daily return move must trigger a new AI call"
    );
  });

  it("14. Portfolio 5D return crosses 5% band → fingerprint changes", () => {
    // band(2.8,5)=5; band(8.5,5)=10 → different
    const a = basePortfolioFacts();
    const b = clone(a);
    b.performance.portfolioReturn5D = 8.5;
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint — price-state changes
// ─────────────────────────────────────────────────────────────────────────────

describe("computePortfolioFactsFingerprint — per-position price-state changes", () => {
  it("15. priceState changes Flat → Downtrend for a holding → fingerprint changes", () => {
    const a = basePortfolioFacts();
    const b = clone(a);
    b.priceBehavior.perPositionState["AAPL"]!.priceState = "Downtrend";
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });

  it("16. volatilityState changes Normal → High → fingerprint changes", () => {
    const a = basePortfolioFacts();
    const b = clone(a);
    b.priceBehavior.perPositionState["AAPL"]!.volatilityState = "High";
    b.priceBehavior.highVolatilityHoldings = ["AAPL"];
    b.priceBehavior.highVolatilityPct = 44;
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });

  it("17. recentBehaviorState appears (null → FallingFast) → fingerprint changes", () => {
    const a = basePortfolioFacts();
    const b = clone(a);
    b.priceBehavior.perPositionState["MSFT"]!.recentBehaviorState = "FallingFast";
    b.priceBehavior.fallingFastHoldings = ["MSFT"];
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint — company state signals
// ─────────────────────────────────────────────────────────────────────────────

describe("computePortfolioFactsFingerprint — company state signals", () => {
  it("18. Holding becomes Invalidated → fingerprint changes", () => {
    const a = basePortfolioFacts();
    const b = clone(a);
    b.companyState.invalidatedHoldings = ["AAPL"];
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });

  it("19. Holding becomes Strengthened → fingerprint changes", () => {
    const a = basePortfolioFacts();
    const b = clone(a);
    b.companyState.strengthenedHoldings = ["MSFT"];
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });

  it("20. Holding becomes Weakened → fingerprint changes", () => {
    const a = basePortfolioFacts();
    const b = clone(a);
    b.companyState.weakenedHoldings = ["AAPL"];
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });

  it("21. View changes Buy → Avoid (avoidView + viewDistribution) → fingerprint changes", () => {
    const a = basePortfolioFacts();
    const b = clone(a);
    b.companyState.avoidViewHoldings = [{ ticker: "AAPL", view: "Avoid" }];
    b.companyState.viewDistribution = { Buy: 1, Avoid: 1 };
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2),
      "A holding becoming Avoid-rated must change the fingerprint"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint — event changes
// ─────────────────────────────────────────────────────────────────────────────

describe("computePortfolioFactsFingerprint — event changes", () => {
  it("22. New event enters 7-day window → fingerprint changes", () => {
    const a = basePortfolioFacts();
    const b = clone(a);
    b.events.upcomingHoldingEvents = [
      { title: "AAPL Earnings", date: "2026-08-18", importance: "High", affectedHoldings: ["AAPL"] },
    ];
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });

  it("23. Event importance changes Medium → High → fingerprint changes", () => {
    const a = basePortfolioFacts();
    a.events.upcomingHoldingEvents = [
      { title: "Fed Meeting", date: "2026-08-20", importance: "Medium", affectedHoldings: [] },
    ];
    const b = clone(a);
    b.events.upcomingHoldingEvents[0]!.importance = "High";
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });

  it("24. Event affected holdings change → fingerprint changes", () => {
    const a = basePortfolioFacts();
    a.events.upcomingHoldingEvents = [
      { title: "Earnings", date: "2026-08-19", importance: "High", affectedHoldings: ["AAPL"] },
    ];
    const b = clone(a);
    b.events.upcomingHoldingEvents[0]!.affectedHoldings = ["AAPL", "MSFT"];
    assert.notEqual(
      computePortfolioFactsFingerprint(a, 1, 2),
      computePortfolioFactsFingerprint(b, 1, 2)
    );
  });
});
