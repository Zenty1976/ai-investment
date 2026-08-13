/**
 * Risk Intelligence Engine — unit tests
 *
 * Uses Node.js built-in test runner (node:test).
 * Run via: pnpm --filter @workspace/api-server test
 *
 * Imports only from risk-facts.ts (types + pure fingerprint function) to
 * avoid pulling in price-context-service → saxo-store → pino which cannot
 * be bundled by esbuild in ESM mode.
 *
 * Invariants tested:
 *  Fingerprint stability:
 *   1.  Same RiskFacts → same fingerprint (idempotent)
 *   2.  Timestamp / computedAt change → fingerprint unchanged (excluded)
 *
 *  Price-state regime changes (all must change fingerprint → trigger new AI call):
 *   3.  priceState change (Flat → StrongDowntrend)
 *   4.  priceState change (Flat → Uptrend) — non-extreme, must still fire
 *   5.  volatilityState change (Low → Elevated)
 *   6.  volatilityState change (Normal → High)
 *   7.  recentBehaviorState appears (null → Stabilizing)
 *   8.  recentBehaviorState changes (Stabilizing → FallingFast)
 *   9.  StrongUptrend position appears
 *  10.  risingHoldings appears (recentBehavior "Rising")
 *  11.  stabilizingFromDowntrendHoldings changes
 *
 *  Other material changes:
 *  12.  Event enters 7-day window → fingerprint changes
 *  13.  Thesis becomes Invalidated → fingerprint changes
 *  14.  Thesis becomes Weakened → fingerprint changes
 *  15.  Portfolio composition changes (new ticker replaces one)
 *  16.  Number of holdings changes
 *
 *  Banding / noise suppression:
 *  17.  cashPct changes by 1% (within 5% band) → fingerprint unchanged
 *  18.  cashPct changes by 6% (crosses 5% band) → fingerprint changes
 *  19.  largestPositionPct changes by 1% (within 2% band) → fingerprint unchanged
 *  20.  largestPositionPct changes by 3% (crosses 2% band) → fingerprint changes
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeRiskFactsFingerprint,
  type RiskFacts,
  type PositionFact,
  type PositionPriceSnapshot,
} from "../risk-facts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const BASE_POSITION: PositionFact = {
  ticker: "AAPL",
  name: "Apple Inc",
  portfolioWeightPct: 40,
  investedWeightPct: 44,
  currency: "USD",
  sector: "Technology",
  marketValueBase: 40000,
};

const BASE_POSITION_2: PositionFact = {
  ticker: "MSFT",
  name: "Microsoft",
  portfolioWeightPct: 50,
  investedWeightPct: 56,
  currency: "USD",
  sector: "Technology",
  marketValueBase: 50000,
};

const BASE_PRICE_SNAP: PositionPriceSnapshot = {
  priceState: "Flat",
  volatilityState: "Normal",
  recentBehaviorState: null,
};

function baseRiskFacts(overrides: Partial<RiskFacts> = {}): RiskFacts {
  return {
    baseCurrency: "USD",
    portfolioValue: 100000,
    cashPct: 10,
    numberOfHoldings: 2,
    concentration: {
      topPositions: [BASE_POSITION, BASE_POSITION_2],
      largestPositionTicker: "MSFT",
      largestPositionPct: 56,
      top3Pct: 100,
      top5Pct: 100,
      top3Tickers: ["MSFT", "AAPL"],
      positionsAbove20Pct: ["MSFT", "AAPL"],
      positionsAbove30Pct: ["MSFT", "AAPL"],
    },
    sectors: {
      exposures: [{ name: "Technology", pct: 90 }],
      largestSectorPct: 90,
      largestSectorName: "Technology",
    },
    currencies: {
      exposures: [{ currency: "USD", pct: 90 }],
    },
    priceRisk: {
      highVolatilityPct: 0,
      highVolatilityHoldings: [],
      strongDowntrendPct: 0,
      strongDowntrendHoldings: [],
      strongUptrendPct: 0,
      strongUptrendHoldings: [],
      fallingFastHoldings: [],
      risingHoldings: [],
      stabilizingFromDowntrendHoldings: [],
      missingPriceContext: [],
      perPositionState: {
        AAPL: { ...BASE_PRICE_SNAP },
        MSFT: { priceState: "Uptrend", volatilityState: "Low", recentBehaviorState: null },
      },
    },
    eventRisk: {
      eventsNext3Days: [],
      eventsNext7Days: [],
      portfolioPctWithEventNext3Days: 0,
      portfolioPctWithEventNext7Days: 0,
    },
    companyRisk: {
      invalidatedTheses: [],
      weakenedTheses: [],
      strengthenedTheses: [],
      lowCaseStrength: [],
      avoidViewHoldings: [],
      viewDistribution: { Buy: 2 },
    },
    portfolioRiskFlags: [],
    computedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

/** Deep-clone so mutations don't bleed between tests. */
function clone(facts: RiskFacts): RiskFacts {
  return JSON.parse(JSON.stringify(facts)) as RiskFacts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint — stability
// ─────────────────────────────────────────────────────────────────────────────

describe("computeRiskFactsFingerprint — stability", () => {
  it("1. Same RiskFacts → same fingerprint (idempotent)", () => {
    const fp1 = computeRiskFactsFingerprint(baseRiskFacts());
    const fp2 = computeRiskFactsFingerprint(baseRiskFacts());
    assert.equal(fp1, fp2, "Two calls with identical data must produce the same fingerprint");
  });

  it("2. computedAt change does not affect fingerprint", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    b.computedAt = "2099-01-01T00:00:00.000Z";
    assert.equal(
      computeRiskFactsFingerprint(a),
      computeRiskFactsFingerprint(b),
      "Timestamp is excluded from the fingerprint"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint — price-state regime changes
// ─────────────────────────────────────────────────────────────────────────────

describe("computeRiskFactsFingerprint — price-state regime changes trigger AI call", () => {
  it("3. priceState Flat → StrongDowntrend changes fingerprint", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    b.priceRisk.perPositionState["AAPL"]!.priceState = "StrongDowntrend";
    b.priceRisk.strongDowntrendHoldings = ["AAPL"];
    b.priceRisk.strongDowntrendPct = 44;
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });

  it("4. priceState Flat → Uptrend changes fingerprint (non-extreme state)", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    b.priceRisk.perPositionState["AAPL"]!.priceState = "Uptrend";
    assert.notEqual(
      computeRiskFactsFingerprint(a),
      computeRiskFactsFingerprint(b),
      "A non-extreme priceState change must still change the fingerprint"
    );
  });

  it("5. volatilityState Low → Elevated changes fingerprint", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    b.priceRisk.perPositionState["MSFT"]!.volatilityState = "Elevated";
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });

  it("6. volatilityState Normal → High changes fingerprint", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    b.priceRisk.perPositionState["AAPL"]!.volatilityState = "High";
    b.priceRisk.highVolatilityHoldings = ["AAPL"];
    b.priceRisk.highVolatilityPct = 44;
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });

  it("7. recentBehaviorState appears (null → Stabilizing) changes fingerprint", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    b.priceRisk.perPositionState["AAPL"]!.recentBehaviorState = "Stabilizing";
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });

  it("8. recentBehaviorState changes (Stabilizing → FallingFast) changes fingerprint", () => {
    const a = baseRiskFacts();
    a.priceRisk.perPositionState["AAPL"]!.recentBehaviorState = "Stabilizing";
    const b = clone(a);
    b.priceRisk.perPositionState["AAPL"]!.recentBehaviorState = "FallingFast";
    b.priceRisk.fallingFastHoldings = ["AAPL"];
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });

  it("9. StrongUptrend position appears — fingerprint changes", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    b.priceRisk.perPositionState["AAPL"]!.priceState = "StrongUptrend";
    b.priceRisk.strongUptrendHoldings = ["AAPL"];
    b.priceRisk.strongUptrendPct = 44;
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });

  it("10. risingHoldings appears (recentBehavior Rising) — fingerprint changes", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    b.priceRisk.perPositionState["MSFT"]!.recentBehaviorState = "Rising";
    b.priceRisk.risingHoldings = ["MSFT"];
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });

  it("11. stabilizingFromDowntrendHoldings changes — fingerprint changes", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    // AAPL moves to Downtrend + Stabilizing behavior
    b.priceRisk.perPositionState["AAPL"]!.priceState = "Downtrend";
    b.priceRisk.perPositionState["AAPL"]!.recentBehaviorState = "Stabilizing";
    b.priceRisk.stabilizingFromDowntrendHoldings = ["AAPL"];
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint — other material changes
// ─────────────────────────────────────────────────────────────────────────────

describe("computeRiskFactsFingerprint — other material changes", () => {
  it("12. Event enters 7-day window → fingerprint changes", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    b.eventRisk.eventsNext7Days = [
      {
        title: "AAPL Earnings Release",
        date: "2026-08-18",
        importance: "High",
        affectedHoldings: ["AAPL"],
      },
    ];
    b.eventRisk.portfolioPctWithEventNext7Days = 44;
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });

  it("13. Thesis becomes Invalidated → fingerprint changes", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    b.companyRisk.invalidatedTheses = [{ ticker: "AAPL", thesisId: "growth-path" }];
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });

  it("14. Thesis becomes Weakened → fingerprint changes", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    b.companyRisk.weakenedTheses = [{ ticker: "MSFT", thesisId: "moat" }];
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });

  it("15. Portfolio composition changes (new ticker replaces one) → fingerprint changes", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    b.concentration.topPositions[1] = {
      ...BASE_POSITION_2,
      ticker: "NVDA",
      name: "NVIDIA",
    };
    delete b.priceRisk.perPositionState["MSFT"];
    b.priceRisk.perPositionState["NVDA"] = {
      priceState: "Uptrend",
      volatilityState: "Low",
      recentBehaviorState: null,
    };
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });

  it("16. Number of holdings changes → fingerprint changes", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    b.numberOfHoldings = 3;
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });

  it("17b. Company view rating changes Buy → Avoid → fingerprint changes", () => {
    const a = baseRiskFacts(); // viewDistribution: { Buy: 2 }, no avoidView
    const b = clone(a);
    b.companyRisk.viewDistribution = { Buy: 1, Avoid: 1 };
    b.companyRisk.avoidViewHoldings = [{ ticker: "AAPL", view: "Avoid" }];
    assert.notEqual(
      computeRiskFactsFingerprint(a),
      computeRiskFactsFingerprint(b),
      "A holding changing to Avoid must change the fingerprint"
    );
  });

  it("17c. avoidViewHoldings appears (Strong Avoid) → fingerprint changes", () => {
    const a = baseRiskFacts();
    const b = clone(a);
    b.companyRisk.avoidViewHoldings = [{ ticker: "MSFT", view: "Strong Avoid" }];
    b.companyRisk.viewDistribution = { Buy: 1, "Strong Avoid": 1 };
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });

  it("17d. Currency exposure changes materially → fingerprint changes", () => {
    const a = baseRiskFacts(); // USD 90%
    const b = clone(a);
    // Add EUR exposure — bands to 10%
    b.currencies.exposures = [
      { currency: "USD", pct: 80 },
      { currency: "EUR", pct: 10 },
    ];
    assert.notEqual(
      computeRiskFactsFingerprint(a),
      computeRiskFactsFingerprint(b),
      "A new currency exposure crossing a 5% band must change the fingerprint"
    );
  });

  it("17e. Currency exposure change within 5% band → fingerprint unchanged", () => {
    // band(90,5)=90, band(92,5)=90 → same
    const a = baseRiskFacts(); // USD pct = 90 → bands to 90
    const b = clone(a);
    b.currencies.exposures = [{ currency: "USD", pct: 92 }]; // still bands to 90
    assert.equal(
      computeRiskFactsFingerprint(a),
      computeRiskFactsFingerprint(b),
      "A 2% currency shift within a 5% band must not trigger a new AI call"
    );
  });

  it("17f. Non-leading sector exposure shift crosses band → fingerprint changes", () => {
    const a = baseRiskFacts(); // Technology 90%
    const b = clone(a);
    // Add Healthcare sector (was absent, now 10%)
    b.sectors.exposures = [
      { name: "Technology", pct: 80 },
      { name: "Healthcare", pct: 10 },
    ];
    assert.notEqual(
      computeRiskFactsFingerprint(a),
      computeRiskFactsFingerprint(b),
      "A new sector appearing in the portfolio must change the fingerprint"
    );
  });

  it("17g. Event affected holdings change → fingerprint changes", () => {
    const a = baseRiskFacts();
    a.eventRisk.eventsNext7Days = [
      { title: "AAPL Earnings", date: "2026-08-18", importance: "High", affectedHoldings: ["AAPL"] },
    ];
    const b = clone(a);
    // MSFT now also affected by same event
    b.eventRisk.eventsNext7Days = [
      { title: "AAPL Earnings", date: "2026-08-18", importance: "High", affectedHoldings: ["AAPL", "MSFT"] },
    ];
    assert.notEqual(
      computeRiskFactsFingerprint(a),
      computeRiskFactsFingerprint(b),
      "A change in which holdings are affected by an event must change the fingerprint"
    );
  });

  it("17h. Event importance changes (Medium → High) → fingerprint changes", () => {
    const a = baseRiskFacts();
    a.eventRisk.eventsNext7Days = [
      { title: "Fed Meeting", date: "2026-08-19", importance: "Medium", affectedHoldings: [] },
    ];
    const b = clone(a);
    b.eventRisk.eventsNext7Days = [
      { title: "Fed Meeting", date: "2026-08-19", importance: "High", affectedHoldings: [] },
    ];
    assert.notEqual(
      computeRiskFactsFingerprint(a),
      computeRiskFactsFingerprint(b),
      "An event becoming more important must change the fingerprint"
    );
  });

  it("17i. Individual position weight shifts materially → fingerprint changes", () => {
    // band(44,2)=44, band(50,2)=50 → different
    const a = baseRiskFacts(); // AAPL investedWeightPct = 44
    const b = clone(a);
    b.concentration.topPositions[0] = { ...b.concentration.topPositions[0]!, investedWeightPct: 50 };
    assert.notEqual(
      computeRiskFactsFingerprint(a),
      computeRiskFactsFingerprint(b),
      "A 6% shift in a position's weight must change the fingerprint"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint — banding / noise suppression
// ─────────────────────────────────────────────────────────────────────────────

describe("computeRiskFactsFingerprint — banding suppresses insignificant movements", () => {
  it("17. cashPct changes by 1% (within 5% band) → fingerprint unchanged", () => {
    const a = baseRiskFacts();           // cashPct = 10 → bands to 10
    const b = clone(a);
    b.cashPct = 11;                      // still bands to 10
    assert.equal(
      computeRiskFactsFingerprint(a),
      computeRiskFactsFingerprint(b),
      "A 1% cash change within the 5% band must not trigger a new AI call"
    );
  });

  it("18. cashPct changes by 6% (crosses 5% band boundary) → fingerprint changes", () => {
    const a = baseRiskFacts();           // cashPct = 10 → bands to 10
    const b = clone(a);
    b.cashPct = 16;                      // bands to 15 → different
    assert.notEqual(
      computeRiskFactsFingerprint(a),
      computeRiskFactsFingerprint(b),
      "A 6% cash change crossing the band boundary must trigger a new AI call"
    );
  });

  it("19. largestPositionPct changes by 1% (within 2% band) → fingerprint unchanged", () => {
    // band(56,2) = round(28)*2 = 56; band(55,2) = round(27.5)*2 = 28*2 = 56 → same
    const a = baseRiskFacts();           // largestPositionPct = 56 → bands to 56
    const b = clone(a);
    b.concentration.largestPositionPct = 55; // still bands to 56
    assert.equal(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });

  it("20. largestPositionPct changes by 2% (crosses 2% band) → fingerprint changes", () => {
    // band(56,2) = 56; band(58,2) = round(29)*2 = 58 → different
    const a = baseRiskFacts();           // largestPositionPct = 56 → bands to 56
    const b = clone(a);
    b.concentration.largestPositionPct = 58; // bands to 58 → different
    assert.notEqual(computeRiskFactsFingerprint(a), computeRiskFactsFingerprint(b));
  });
});
