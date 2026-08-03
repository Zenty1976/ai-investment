/**
 * Tests for portfolio-replacement-detector.ts
 *
 * Invariants exercised:
 * 1. Missing Company Monitor for candidate → isProvisional = true,
 *    provisionalReasons includes "Missing Company Monitor for candidate"
 * 2. Missing Company Monitor for holding → isProvisional = true,
 *    provisionalReasons includes "Missing Company Monitor for holding"
 * 3. Missing Trade Decision for candidate → isProvisional = true,
 *    provisionalReasons includes "Missing Trade Decision validation"
 * 4. Candidate with TDE not ReadyForReview → isProvisional = true,
 *    provisionalReasons includes "not ReadyForReview"
 * 5. Candidate with all evidence present and ReadyForReview → isProvisional = false,
 *    provisionalReasons is empty
 * 6. Event-blocked candidate is excluded entirely (not even provisional)
 * 7. Score delta below threshold (20) → no replacement emitted
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectReplacements } from "../portfolio-replacement-detector.js";
import type { PortfolioSnapshot } from "../../routes/portfolio-manager.js";
import type {
  OpportunityCandidate,
  CmReplacementData,
  TdeReplacementData,
} from "../portfolio-replacement-detector.js";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeSnapshot(positions: Array<{ symbol: string; marketValueBaseCurrency: number }>): PortfolioSnapshot {
  const totalValue = positions.reduce((s, p) => s + p.marketValueBaseCurrency, 0) + 50_000;
  return {
    updatedAt: "2026-01-01T00:00:00.000Z",
    environment: "sim",
    baseCurrency: "DKK",
    totalValue,
    totalAvailableCash: 50_000,
    totalUnrealizedProfitLoss: 0,
    isMockData: true,
    accounts: [{
      accountKey: "ACC1",
      accountId: "ACC1",
      accountName: "Test",
      accountType: "Normal",
      currency: "DKK",
      availableCash: 50_000,
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
        quantity: 10,
        direction: "Buy",
        averageOpenPrice: p.marketValueBaseCurrency / 10,
        currentPrice:     p.marketValueBaseCurrency / 10,
        marketValue: p.marketValueBaseCurrency,
        marketValueBaseCurrency: p.marketValueBaseCurrency,
        profitLoss: 0,
        dayChangePercent: 0,
        priceDelayMinutes: 0,
        isMarketOpen: true,
      })),
    }],
  };
}

const WEAK_HOLDING_CM: CmReplacementData = {
  investmentCaseStrength: 35,
  investmentViewRating: "Watch",
  investmentCaseChange: { changed: true, severity: "High" },
  thesisPointStatuses: [{ status: "Weakened" }, { status: "Weakened" }],
};

const STRONG_CANDIDATE_OF: OpportunityCandidate = {
  ticker: "NVDA",
  company: "Nvidia",
  overallScore: 85,
  priority: "High",
};

const STRONG_CANDIDATE_CM: CmReplacementData = {
  investmentCaseStrength: 80,
  investmentViewRating: "Buy",
  investmentCaseChange: { changed: false },
};

const READY_CANDIDATE_TDE: TdeReplacementData = {
  decision: "PrepareToBuy",
  evidenceBand: "Strong",
  readiness: "ReadyForReview",
  blockedByEvent: false,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("detectReplacements — provisional when CM missing", () => {
  it("marks replacement provisional when candidate Company Monitor is missing", () => {
    const snapshot = makeSnapshot([{ symbol: "AAPL", marketValueBaseCurrency: 200_000 }]);
    const cmByTicker = new Map<string, CmReplacementData>([["AAPL", WEAK_HOLDING_CM]]);
    // NVDA intentionally has no CM entry
    const tdeByTicker = new Map<string, TdeReplacementData>([["NVDA", READY_CANDIDATE_TDE]]);

    const results = detectReplacements(snapshot, [STRONG_CANDIDATE_OF], cmByTicker, tdeByTicker);

    assert.ok(results.length > 0, "Expected at least one replacement");
    const r = results[0];
    assert.equal(r.candidateTicker, "NVDA");
    assert.equal(r.isProvisional, true, "Should be provisional when candidate CM is missing");
    assert.ok(
      r.provisionalReasons.some((reason) => /missing company monitor for candidate/i.test(reason)),
      `Expected "Missing Company Monitor for candidate" in provisionalReasons, got: ${JSON.stringify(r.provisionalReasons)}`
    );
  });

  it("marks replacement provisional when holding Company Monitor is missing", () => {
    const snapshot = makeSnapshot([{ symbol: "AAPL", marketValueBaseCurrency: 200_000 }]);
    // AAPL intentionally has no CM entry
    const cmByTicker = new Map<string, CmReplacementData>([["NVDA", STRONG_CANDIDATE_CM]]);
    const tdeByTicker = new Map<string, TdeReplacementData>([["NVDA", READY_CANDIDATE_TDE]]);

    // Use a very high-scoring candidate to ensure delta > threshold despite no holding CM
    const candidate: OpportunityCandidate = { ...STRONG_CANDIDATE_OF, overallScore: 90 };

    const results = detectReplacements(snapshot, [candidate], cmByTicker, tdeByTicker);

    assert.ok(results.length > 0, "Expected at least one replacement (holding neutral score = 50)");
    const r = results[0];
    assert.equal(r.isProvisional, true, "Should be provisional when holding CM is missing");
    assert.ok(
      r.provisionalReasons.some((reason) => /missing company monitor for holding/i.test(reason)),
      `Expected "Missing Company Monitor for holding" in provisionalReasons, got: ${JSON.stringify(r.provisionalReasons)}`
    );
  });
});

describe("detectReplacements — provisional when TDE missing or not ready", () => {
  it("marks replacement provisional when candidate Trade Decision is missing", () => {
    const snapshot = makeSnapshot([{ symbol: "AAPL", marketValueBaseCurrency: 200_000 }]);
    const cmByTicker = new Map<string, CmReplacementData>([
      ["AAPL", WEAK_HOLDING_CM],
      ["NVDA", STRONG_CANDIDATE_CM],
    ]);
    // No TDE for NVDA
    const tdeByTicker = new Map<string, TdeReplacementData>();

    const results = detectReplacements(snapshot, [STRONG_CANDIDATE_OF], cmByTicker, tdeByTicker);

    assert.ok(results.length > 0, "Expected at least one replacement");
    const r = results[0];
    assert.equal(r.isProvisional, true, "Should be provisional when candidate TDE is missing");
    assert.ok(
      r.provisionalReasons.some((reason) => /missing trade decision/i.test(reason)),
      `Expected "Missing Trade Decision" in provisionalReasons, got: ${JSON.stringify(r.provisionalReasons)}`
    );
  });

  it("marks replacement provisional when candidate TDE readiness is not ReadyForReview", () => {
    const snapshot = makeSnapshot([{ symbol: "AAPL", marketValueBaseCurrency: 200_000 }]);
    const cmByTicker = new Map<string, CmReplacementData>([
      ["AAPL", WEAK_HOLDING_CM],
      ["NVDA", STRONG_CANDIDATE_CM],
    ]);
    const tdeByTicker = new Map<string, TdeReplacementData>([
      ["NVDA", { ...READY_CANDIDATE_TDE, readiness: "WaitingForReevaluation" }],
    ]);

    const results = detectReplacements(snapshot, [STRONG_CANDIDATE_OF], cmByTicker, tdeByTicker);

    assert.ok(results.length > 0, "Expected at least one replacement");
    const r = results[0];
    assert.equal(r.isProvisional, true, "Should be provisional when candidate is not ReadyForReview");
    assert.ok(
      r.provisionalReasons.some((reason) => /not readyforreview/i.test(reason)),
      `Expected "not ReadyForReview" in provisionalReasons, got: ${JSON.stringify(r.provisionalReasons)}`
    );
  });
});

describe("detectReplacements — fully validated replacement", () => {
  it("marks replacement NOT provisional when all evidence is present and candidate is ReadyForReview", () => {
    const snapshot = makeSnapshot([{ symbol: "AAPL", marketValueBaseCurrency: 200_000 }]);
    const cmByTicker = new Map<string, CmReplacementData>([
      ["AAPL", WEAK_HOLDING_CM],
      ["NVDA", STRONG_CANDIDATE_CM],
    ]);
    const tdeByTicker = new Map<string, TdeReplacementData>([
      ["NVDA", READY_CANDIDATE_TDE],
    ]);

    const results = detectReplacements(snapshot, [STRONG_CANDIDATE_OF], cmByTicker, tdeByTicker);

    assert.ok(results.length > 0, "Expected at least one replacement");
    const r = results[0];
    assert.equal(r.isProvisional, false, "Should NOT be provisional when all evidence is present");
    assert.deepEqual(r.provisionalReasons, [], "provisionalReasons should be empty when not provisional");
  });
});

describe("detectReplacements — blocked candidates excluded", () => {
  it("event-blocked candidate does not appear in results (not even provisional)", () => {
    const snapshot = makeSnapshot([{ symbol: "AAPL", marketValueBaseCurrency: 200_000 }]);
    const cmByTicker = new Map<string, CmReplacementData>([
      ["AAPL", WEAK_HOLDING_CM],
      ["NVDA", STRONG_CANDIDATE_CM],
    ]);
    const tdeByTicker = new Map<string, TdeReplacementData>([
      ["NVDA", { ...READY_CANDIDATE_TDE, blockedByEvent: true }],
    ]);

    const results = detectReplacements(snapshot, [STRONG_CANDIDATE_OF], cmByTicker, tdeByTicker);

    const nvda = results.find((r) => r.candidateTicker === "NVDA");
    assert.equal(nvda, undefined, "Event-blocked candidate must not appear in results at all");
  });
});

describe("detectReplacements — score delta threshold", () => {
  it("replacement is not emitted when score delta is below threshold (20)", () => {
    const snapshot = makeSnapshot([{ symbol: "AAPL", marketValueBaseCurrency: 200_000 }]);
    // AAPL holding score with good CM ≈ 78; candidate with score 88 → delta ≈ 10, below 20
    const goodHoldingCm: CmReplacementData = {
      investmentCaseStrength: 80,
      investmentViewRating: "Buy",
    };
    const mediocreCandidate: OpportunityCandidate = {
      ticker: "NVDA",
      company: "Nvidia",
      overallScore: 68,  // below the holding score of ~78
    };

    const cmByTicker = new Map([["AAPL", goodHoldingCm]]);
    const tdeByTicker = new Map<string, TdeReplacementData>();

    const results = detectReplacements(snapshot, [mediocreCandidate], cmByTicker, tdeByTicker);
    assert.equal(results.length, 0, "No replacement should be emitted when delta < threshold");
  });
});
