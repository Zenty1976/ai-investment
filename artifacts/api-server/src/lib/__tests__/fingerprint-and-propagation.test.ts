/**
 * Tests for spec §10 scenarios A–D:
 *
 * A) Fingerprint stays identical when no material inputs change
 *    → the orchestrator's skip check would fire on the second run
 *
 * B) Only company-monitor:SERV materialVersion bumps when its result changes
 *    → downstream fingerprints for SERV-dependent modules change;
 *    fingerprints for modules only tracking other tickers do NOT change
 *
 * C) Tiny price movement (<3 pp 5D return, no categorical change)
 *    → price-context materialVersion does NOT bump
 *    → downstream fingerprints are stable (no false AI reruns)
 *
 * D) Categorical price-state change (e.g. Neutral → StrongDowntrend)
 *    → price-context materialVersion DOES bump
 *    → downstream fingerprints change (AI rerun is warranted)
 *
 * NOTE: These tests exercise the deterministic fingerprint + materialVersion
 * layer in isolation. The orchestrator itself makes HTTP calls so its
 * full end-to-end flow is not tested here — but all the gates it depends on
 * (computeFingerprint equality, materialVersion propagation, price-context
 * materiality) are covered.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { analysisRepository } from "../analysis-repository.js";
import { computeFingerprint } from "../dependency-fingerprint-service.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal PriceContext fixture. Categorical fields drive materiality. */
function makePriceContext(overrides: {
  priceState?: string;
  recentBehaviorState?: string;
  volatilityState?: string;
  volatilityTrend?: string;
  fiveDayPct?: number;
} = {}): Record<string, unknown> {
  return {
    symbol: "SERV",
    asOf: new Date().toISOString(),
    priceState: overrides.priceState ?? "Neutral",
    recentBehavior: { state: overrides.recentBehaviorState ?? "Stable" },
    volatility: {
      volatilityState: overrides.volatilityState ?? "Normal",
      volatilityTrend: overrides.volatilityTrend ?? "Stable",
      annualizedVolatility: 18,
    },
    returns: { fiveDayPct: overrides.fiveDayPct ?? 0.5 },
    trend: {
      shortTermTrend: "Flat",
      mediumTermTrend: "Flat",
      longTermTrend: "Flat",
      momentumChange: "Neutral",
    },
    structure: { nearHighPct: 5, nearLowPct: 40, rangePosition: 0.7 },
  };
}

/** Minimal company-monitor result fixture */
function makeCmResult(outlook: string): Record<string, unknown> {
  return {
    company: { ticker: "SERV", name: "ServiceNow" },
    outlook,
    fundamentals: { summary: "Solid" },
    analysedAt: new Date().toISOString(),
  };
}

/** Portfolio manager result with SERV as a holding */
function makePortfolioResult(tickers: string[]): Record<string, unknown> {
  return {
    accounts: [
      {
        accountKey: "ACC1",
        positions: tickers.map(sym => ({
          symbol: sym,
          name: sym,
          uic: 12345,
          assetType: "Stock",
          quantity: 100,
          marketValue: 50000,
        })),
      },
    ],
    updatedAt: new Date().toISOString(),
  };
}

// ── Scenario A: Fingerprint stability ────────────────────────────────────────

describe("Scenario A — fingerprint stays stable when nothing changes", () => {
  before(() => {
    // Populate repository with initial state for fingerprint dependencies
    analysisRepository.save("portfolio-manager",   makePortfolioResult(["SERV"]));
    analysisRepository.save("market-monitor",      { summary: "Markets flat", generatedAt: new Date().toISOString() });
    analysisRepository.save("news-monitor",        { headlines: ["Boring day"], generatedAt: new Date().toISOString() });
    analysisRepository.save("event-monitor",       { events: [], generatedAt: new Date().toISOString() });
    analysisRepository.save("sector-monitor",      { sectors: [], generatedAt: new Date().toISOString() });
    analysisRepository.save("risk-analyzer",       { overallRisk: "Low", generatedAt: new Date().toISOString() });
    analysisRepository.save("company-monitor:SERV", makeCmResult("Positive"));
  });

  it("portfolio-analyzer fingerprint is identical on two consecutive reads", () => {
    const tickers = ["SERV"];
    const fp1 = computeFingerprint("portfolio-analyzer", tickers);
    const fp2 = computeFingerprint("portfolio-analyzer", tickers);
    assert.ok(fp1, "fingerprint must be non-null");
    assert.equal(fp1, fp2, "fingerprint must be deterministic and identical when nothing changed");
  });

  it("risk-analyzer fingerprint is identical on two consecutive reads", () => {
    const tickers = ["SERV"];
    const fp1 = computeFingerprint("risk-analyzer", tickers);
    const fp2 = computeFingerprint("risk-analyzer", tickers);
    assert.ok(fp1, "fingerprint must be non-null");
    assert.equal(fp1, fp2);
  });

  it("trade-decision-engine fingerprint is identical on two consecutive reads", () => {
    const tickers = ["SERV"];
    const fp1 = computeFingerprint("trade-decision-engine", tickers);
    const fp2 = computeFingerprint("trade-decision-engine", tickers);
    assert.ok(fp1, "fingerprint must be non-null");
    assert.equal(fp1, fp2);
  });
});

// ── Scenario B: Holding-specific dirty propagation ───────────────────────────

describe("Scenario B — only SERV CM change makes SERV-dependent fingerprints dirty", () => {
  let fpPortfolioBeforeSERV: string | null;
  let fpPortfolioBeforeAAPL: string | null;

  before(() => {
    // Set up two companies: SERV (holding) and AAPL (not a holding)
    analysisRepository.save("portfolio-manager",    makePortfolioResult(["SERV"]));
    analysisRepository.save("market-monitor",       { summary: "Stable" });
    analysisRepository.save("news-monitor",         { headlines: [] });
    analysisRepository.save("event-monitor",        { events: [] });
    analysisRepository.save("sector-monitor",       { sectors: [] });
    analysisRepository.save("risk-analyzer",        { overallRisk: "Low" });
    analysisRepository.save("company-monitor:SERV", makeCmResult("Neutral"));
    analysisRepository.save("company-monitor:AAPL", makeCmResult("Neutral"));

    // Record fingerprints BEFORE the change
    fpPortfolioBeforeSERV = computeFingerprint("portfolio-analyzer", ["SERV"]);
    fpPortfolioBeforeAAPL = computeFingerprint("portfolio-analyzer", ["AAPL"]);
  });

  it("portfolio-analyzer fingerprint for SERV changes when CM:SERV result changes", () => {
    // Simulate a material CM:SERV update (different outlook = different JSON = materialVersion++)
    const entryBefore = analysisRepository.get("company-monitor:SERV");
    const mvBefore = entryBefore?.materialVersion ?? 0;

    analysisRepository.save("company-monitor:SERV", makeCmResult("Strongly Positive — BEAT earnings"));

    const entryAfter = analysisRepository.get("company-monitor:SERV");
    assert.equal(entryAfter!.materialVersion, mvBefore + 1, "CM:SERV materialVersion must increment on result change");

    const fpAfter = computeFingerprint("portfolio-analyzer", ["SERV"]);
    assert.notEqual(fpAfter, fpPortfolioBeforeSERV, "portfolio-analyzer fingerprint must change when CM:SERV materialVersion bumps");
  });

  it("portfolio-analyzer fingerprint for AAPL (non-holding) is unaffected by CM:SERV change", () => {
    // AAPL fingerprint should be the same as before CM:SERV changed
    const fpAaplAfter = computeFingerprint("portfolio-analyzer", ["AAPL"]);
    assert.equal(fpAaplAfter, fpPortfolioBeforeAAPL, "AAPL-scoped fingerprint must not change when only SERV changed");
  });
});

// ── Scenario C: Small price movement — no materialVersion bump ───────────────

describe("Scenario C — tiny price move does not bump price-context materialVersion", () => {
  it("saving price-context with same categorical fields (tiny return shift) keeps materialVersion", () => {
    const key = "price-context:SERV";

    // Initial save
    const ctx1 = makePriceContext({ priceState: "Neutral", fiveDayPct: 0.5 });
    const entry1 = analysisRepository.save(key, ctx1);
    const mv1 = entry1.materialVersion;

    // Tiny return shift (+0.3pp): still Neutral, no categorical change
    const ctx2 = makePriceContext({ priceState: "Neutral", fiveDayPct: 0.8 });
    const entry2 = analysisRepository.save(key, ctx2);
    assert.equal(
      entry2.materialVersion,
      mv1,
      "materialVersion must NOT bump for tiny price shift (same categorical state)"
    );
  });

  it("downstream fingerprint is stable when price-context materialVersion does not change", () => {
    // With portfolio + price context already seeded, compute fingerprint twice
    // after the non-material price update from the previous test
    analysisRepository.save("portfolio-manager",  makePortfolioResult(["SERV"]));
    analysisRepository.save("market-monitor",     { summary: "Stable" });
    analysisRepository.save("news-monitor",       { headlines: [] });
    analysisRepository.save("event-monitor",      { events: [] });
    analysisRepository.save("sector-monitor",     { sectors: [] });
    analysisRepository.save("risk-analyzer",      { overallRisk: "Low" });
    analysisRepository.save("company-monitor:SERV", makeCmResult("Neutral"));

    const fp1 = computeFingerprint("portfolio-analyzer", ["SERV"]);

    // Another tiny price update
    const ctx3 = makePriceContext({ priceState: "Neutral", fiveDayPct: 1.0 });
    analysisRepository.save("price-context:SERV", ctx3);

    const fp2 = computeFingerprint("portfolio-analyzer", ["SERV"]);
    assert.equal(fp1, fp2, "Fingerprint must be stable for non-material price updates");
  });
});

// ── Scenario D: Categorical price change triggers materialVersion bump ────────

describe("Scenario D — categorical price-state change bumps materialVersion and changes downstream fingerprint", () => {
  it("priceState change (Neutral → StrongDowntrend) bumps materialVersion", () => {
    const key = "price-context:SERV";

    // Establish baseline
    const baseline = makePriceContext({ priceState: "Neutral", fiveDayPct: 1.0 });
    const e1 = analysisRepository.save(key, baseline);
    const mvBaseline = e1.materialVersion;

    // Major move: priceState changes to StrongDowntrend
    const crash = makePriceContext({ priceState: "StrongDowntrend", fiveDayPct: -8.5 });
    const e2 = analysisRepository.save(key, crash);
    assert.equal(
      e2.materialVersion,
      mvBaseline + 1,
      "materialVersion must bump when priceState changes categorically"
    );
  });

  it("downstream fingerprint changes after categorical price-state change", () => {
    analysisRepository.save("portfolio-manager",  makePortfolioResult(["SERV"]));
    analysisRepository.save("market-monitor",     { summary: "Sell-off" });
    analysisRepository.save("news-monitor",       { headlines: ["Market crash"] });
    analysisRepository.save("event-monitor",      { events: [] });
    analysisRepository.save("sector-monitor",     { sectors: [] });
    analysisRepository.save("risk-analyzer",      { overallRisk: "Low" });
    analysisRepository.save("company-monitor:SERV", makeCmResult("Neutral"));

    // Neutral price context
    analysisRepository.save("price-context:SERV", makePriceContext({ priceState: "Neutral" }));
    const fpBefore = computeFingerprint("portfolio-analyzer", ["SERV"]);

    // Categorical shift → materialVersion bumps
    analysisRepository.save("price-context:SERV", makePriceContext({ priceState: "StrongDowntrend" }));
    const fpAfter = computeFingerprint("portfolio-analyzer", ["SERV"]);

    assert.notEqual(fpAfter, fpBefore, "Fingerprint must change when price-context materialVersion bumps");
  });

  it("recentBehavior state change also triggers materialVersion bump", () => {
    const key = "price-context:SERV";

    const stable = makePriceContext({ priceState: "Neutral", recentBehaviorState: "Stable" });
    const e1 = analysisRepository.save(key, stable);
    const mv1 = e1.materialVersion;

    const recovering = makePriceContext({ priceState: "Neutral", recentBehaviorState: "Recovering" });
    const e2 = analysisRepository.save(key, recovering);
    assert.equal(
      e2.materialVersion,
      mv1 + 1,
      "materialVersion must bump when recentBehavior.state changes"
    );
  });

  it("large 5D return shift (≥3pp) triggers materialVersion bump even without categorical change", () => {
    const key = "price-context:SERV";

    const before = makePriceContext({ priceState: "Neutral", fiveDayPct: 0.5 });
    const e1 = analysisRepository.save(key, before);
    const mv1 = e1.materialVersion;

    // +4pp shift — above the 3pp threshold
    const after = makePriceContext({ priceState: "Neutral", fiveDayPct: 4.5 });
    const e2 = analysisRepository.save(key, after);
    assert.equal(
      e2.materialVersion,
      mv1 + 1,
      "materialVersion must bump when 5D return shifts ≥3pp"
    );
  });
});
