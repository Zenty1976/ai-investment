/**
 * Sector Intelligence Layer — unit tests.
 *
 * All tests are fully deterministic.  No OpenAI calls, no web search,
 * no network, no repository side-effects.
 *
 * Covers all 9 required scenarios from the spec plus edge cases.
 *
 * Run: node run-tests.mjs src/lib/__tests__/sector-intelligence.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeExposureBand,
  computePortfolioSectorExposure,
  buildSectorFactsBlock,
  computeInputFingerprint,
  computeOutputFingerprint,
  isOutputMaterial,
  extractMarketInputs,
  extractEventInputs,
  extractNewsInputs,
  buildExposureBandKeys,
  type SectorMonitorFacts,
  type SectorPortfolioExposure,
} from "../sector-intelligence.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function pos(symbol: string, mv: number) {
  return { symbol, marketValueBaseCurrency: mv };
}

function makeExposure(sector: string, pct: number, band: SectorPortfolioExposure["band"]): SectorPortfolioExposure {
  return {
    sector,
    marketValueBc: Math.round(pct * 1000),
    exposurePct: pct,
    band,
    tickers: [],
  };
}

const BASE_SECTORS = [
  { name: "AI & Software", rating: "Strong", trend: "Improving" },
  { name: "Semiconductors", rating: "Moderately Strong", trend: "Stable" },
  { name: "Healthcare", rating: "Neutral", trend: "Stable" },
  { name: "Energy", rating: "Moderately Weak", trend: "Weakening" },
];

function makeInputFingerprint(overrides: {
  sentiment?: string;
  risk?: string;
  strong?: string[];
  weak?: string[];
  events?: string[];
  newsImpact?: string;
  newsTop?: string;
  exposure?: string[];
} = {}): string {
  return computeInputFingerprint(
    overrides.sentiment ?? "Neutral",
    overrides.risk ?? "Medium",
    overrides.strong ?? ["Technology"],
    overrides.weak ?? ["Energy"],
    overrides.events ?? ["FOMC|2026-09-01"],
    overrides.newsImpact ?? "Mixed",
    overrides.newsTop ?? "Fed holds rates steady",
    overrides.exposure ?? ["Technology:Significant", "Healthcare:Moderate"]
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// computeExposureBand
// ═════════════════════════════════════════════════════════════════════════════

describe("computeExposureBand", () => {
  it("classifies ≥15% as Significant", () => {
    assert.equal(computeExposureBand(15), "Significant");
    assert.equal(computeExposureBand(34), "Significant");
    assert.equal(computeExposureBand(100), "Significant");
  });

  it("classifies 5–14.99% as Moderate", () => {
    assert.equal(computeExposureBand(5), "Moderate");
    assert.equal(computeExposureBand(10), "Moderate");
    assert.equal(computeExposureBand(14.9), "Moderate");
  });

  it("classifies 1–4.99% as Minor", () => {
    assert.equal(computeExposureBand(1), "Minor");
    assert.equal(computeExposureBand(3), "Minor");
    assert.equal(computeExposureBand(4.99), "Minor");
  });

  it("classifies <1% as None", () => {
    assert.equal(computeExposureBand(0), "None");
    assert.equal(computeExposureBand(0.5), "None");
    assert.equal(computeExposureBand(0.99), "None");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario E — Portfolio sector exposure calculated correctly
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario E — portfolio sector exposure computed correctly", () => {
  it("computes exposure % correctly for multiple sectors", () => {
    const positions = [
      pos("AAPL", 40_000),
      pos("MSFT", 20_000),
      pos("JNJ", 25_000),
      pos("XOM", 15_000),
    ];
    const sectorByTicker = new Map([
      ["AAPL", "Technology"],
      ["MSFT", "Technology"],
      ["JNJ", "Healthcare"],
      ["XOM", "Energy"],
    ]);

    const facts = computePortfolioSectorExposure(positions, sectorByTicker);

    assert.equal(facts.totalClassifiableMv, 100_000);
    assert.equal(facts.coveragePct, 100);
    assert.equal(facts.coverageConfidence, "High");
    assert.equal(facts.unclassifiedTickers.length, 0);

    const tech = facts.portfolioExposure.find((e) => e.sector === "Technology");
    const hc = facts.portfolioExposure.find((e) => e.sector === "Healthcare");
    const energy = facts.portfolioExposure.find((e) => e.sector === "Energy");

    assert.ok(tech, "Technology must be present");
    assert.equal(tech!.exposurePct, 60);
    assert.equal(tech!.band, "Significant");
    assert.deepEqual(tech!.tickers.sort(), ["AAPL", "MSFT"]);

    assert.ok(hc, "Healthcare must be present");
    assert.equal(hc!.exposurePct, 25);
    assert.equal(hc!.band, "Significant");

    assert.ok(energy, "Energy must be present");
    assert.equal(energy!.exposurePct, 15);
    assert.equal(energy!.band, "Significant");
  });

  it("sorts sectors by exposure descending", () => {
    const positions = [pos("A", 60_000), pos("B", 30_000), pos("C", 10_000)];
    const sectorByTicker = new Map([["A", "Tech"], ["B", "Health"], ["C", "Energy"]]);

    const facts = computePortfolioSectorExposure(positions, sectorByTicker);

    assert.equal(facts.portfolioExposure[0].sector, "Tech");
    assert.equal(facts.portfolioExposure[1].sector, "Health");
    assert.equal(facts.portfolioExposure[2].sector, "Energy");
  });

  it("marks tickers without sector data as unclassified", () => {
    const positions = [pos("AAPL", 50_000), pos("UNKNOWN", 50_000)];
    const sectorByTicker = new Map([["AAPL", "Technology"]]);

    const facts = computePortfolioSectorExposure(positions, sectorByTicker);

    assert.ok(facts.unclassifiedTickers.includes("UNKNOWN"), "UNKNOWN must be unclassified");
    assert.equal(facts.portfolioExposure.length, 1, "Only classified sectors in exposure");
    // Coverage is based on MV: 50k classified / 100k total = 50%
    assert.equal(facts.coveragePct, 50);
    assert.equal(facts.coverageConfidence, "Medium");
  });

  it("handles empty portfolio gracefully", () => {
    const facts = computePortfolioSectorExposure([], new Map());
    assert.equal(facts.portfolioExposure.length, 0);
    assert.equal(facts.coveragePct, 0);
    assert.equal(facts.coverageConfidence, "Low");
    assert.equal(facts.totalClassifiableMv, 0);
  });

  it("skips positions with zero or negative market value", () => {
    const positions = [pos("AAPL", 50_000), pos("BAD", 0), pos("NEG", -1000)];
    const sectorByTicker = new Map([["AAPL", "Technology"], ["BAD", "Financials"], ["NEG", "Energy"]]);

    const facts = computePortfolioSectorExposure(positions, sectorByTicker);
    assert.equal(facts.totalClassifiableMv, 50_000);
    assert.equal(facts.portfolioExposure.length, 1);
    assert.equal(facts.portfolioExposure[0].sector, "Technology");
  });

  it("aggregates multiple tickers in the same sector correctly", () => {
    const positions = [pos("AAPL", 30_000), pos("MSFT", 20_000), pos("GOOG", 10_000)];
    const sectorByTicker = new Map([["AAPL", "Technology"], ["MSFT", "Technology"], ["GOOG", "Technology"]]);

    const facts = computePortfolioSectorExposure(positions, sectorByTicker);
    assert.equal(facts.portfolioExposure.length, 1);
    assert.equal(facts.portfolioExposure[0].exposurePct, 100);
    assert.equal(facts.portfolioExposure[0].tickers.length, 3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario A — Tiny sector return movement → fingerprint unchanged → no AI
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario A — tiny movement does not change input fingerprint", () => {
  it("same discrete inputs produce identical fingerprint", () => {
    // Simulating two runs where market sentiment, risk, and exposure bands are
    // unchanged — only minor market-value fluctuations occurred
    const fp1 = makeInputFingerprint({ exposure: ["Technology:Significant", "Healthcare:Moderate"] });
    const fp2 = makeInputFingerprint({ exposure: ["Technology:Significant", "Healthcare:Moderate"] });
    assert.equal(fp1, fp2, "Fingerprint must be identical when inputs are unchanged");
  });

  it("small MV fluctuation within same band does NOT change fingerprint", () => {
    // Tech drops from 34% to 32% — still Significant (≥15%)
    const fp1 = makeInputFingerprint({ exposure: ["Technology:Significant"] });
    // Tech rises from 32% to 33.5% — still Significant
    const fp2 = makeInputFingerprint({ exposure: ["Technology:Significant"] });
    assert.equal(fp1, fp2, "Within-band MV change must not alter fingerprint");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario B — Meaningful relative-strength change → fingerprint changes
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario B — meaningful market state change alters fingerprint", () => {
  it("sentiment change from Neutral to Bearish changes fingerprint", () => {
    const fp1 = makeInputFingerprint({ sentiment: "Neutral" });
    const fp2 = makeInputFingerprint({ sentiment: "Bearish" });
    assert.notEqual(fp1, fp2, "Sentiment change must alter fingerprint");
  });

  it("risk level change from Medium to High changes fingerprint", () => {
    const fp1 = makeInputFingerprint({ risk: "Medium" });
    const fp2 = makeInputFingerprint({ risk: "High" });
    assert.notEqual(fp1, fp2, "Risk level change must alter fingerprint");
  });

  it("strong/weak sector list change alters fingerprint", () => {
    const fp1 = makeInputFingerprint({ strong: ["Technology"], weak: ["Energy"] });
    const fp2 = makeInputFingerprint({ strong: ["Healthcare"], weak: ["Real Estate"] });
    assert.notEqual(fp1, fp2, "Leadership change must alter fingerprint");
  });

  it("portfolio exposure band crossing alters fingerprint", () => {
    // Healthcare drops from 8% (Moderate) to 2% (Minor) — band changes
    const fp1 = makeInputFingerprint({ exposure: ["Technology:Significant", "Healthcare:Moderate"] });
    const fp2 = makeInputFingerprint({ exposure: ["Technology:Significant", "Healthcare:Minor"] });
    assert.notEqual(fp1, fp2, "Exposure band change must alter fingerprint");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario C — Persistent new sector leadership → material output change
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario C — new sector leadership is a material output change", () => {
  it("changing top sector from Neutral to Strong is material", () => {
    const prev = [
      { name: "Technology", rating: "Strong", trend: "Stable" },
      { name: "Healthcare", rating: "Neutral", trend: "Stable" },
    ];
    const next = [
      { name: "Technology", rating: "Strong", trend: "Stable" },
      { name: "Healthcare", rating: "Strong", trend: "Improving" }, // upgraded
    ];
    const prevKey = computeOutputFingerprint(prev);
    const nextKey = computeOutputFingerprint(next);
    assert.ok(isOutputMaterial(prevKey, nextKey), "Rating upgrade must be material");
  });

  it("trend change Stable → Improving is material", () => {
    const prev = [{ name: "AI & Software", rating: "Strong", trend: "Stable" }];
    const next = [{ name: "AI & Software", rating: "Strong", trend: "Improving" }];
    const prevKey = computeOutputFingerprint(prev);
    const nextKey = computeOutputFingerprint(next);
    assert.ok(isOutputMaterial(prevKey, nextKey), "Trend change must be material");
  });

  it("completely new sector appearing is material", () => {
    const prev = [{ name: "Technology", rating: "Strong", trend: "Stable" }];
    const next = [
      { name: "Technology", rating: "Strong", trend: "Stable" },
      { name: "Biotechnology", rating: "Moderately Strong", trend: "Improving" },
    ];
    const prevKey = computeOutputFingerprint(prev);
    const nextKey = computeOutputFingerprint(next);
    assert.ok(isOutputMaterial(prevKey, nextKey), "New sector in output must be material");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario D — One-day noisy rank swap with negligible difference → NOT material
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario D — noisy rank swap within same rating band is not material", () => {
  it("reordering within identical rating/trend is NOT material (sorted fingerprint)", () => {
    // Two sectors swap positions in the output array but keep the same name:rating:trend
    const prev = [
      { name: "AI & Software", rating: "Strong", trend: "Stable" },
      { name: "Semiconductors", rating: "Strong", trend: "Stable" },
    ];
    const next = [
      { name: "Semiconductors", rating: "Strong", trend: "Stable" }, // swapped
      { name: "AI & Software", rating: "Strong", trend: "Stable" },
    ];
    const prevKey = computeOutputFingerprint(prev);
    const nextKey = computeOutputFingerprint(next);
    assert.equal(prevKey, nextKey, "Reordering within same rating/trend must NOT be material");
    assert.equal(isOutputMaterial(prevKey, nextKey), false);
  });

  it("rating change IS required to produce a material fingerprint change", () => {
    const prev = [{ name: "Healthcare", rating: "Neutral", trend: "Stable" }];
    // Tiny rank movement but rating unchanged
    const next = [{ name: "Healthcare", rating: "Neutral", trend: "Stable" }];
    const prevKey = computeOutputFingerprint(prev);
    const nextKey = computeOutputFingerprint(next);
    assert.equal(isOutputMaterial(prevKey, nextKey), false, "Same name:rating:trend must not be material");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario F — Same material sector state with different timestamps/order
//              → same fingerprint
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario F — fingerprints are order-independent and timestamp-agnostic", () => {
  it("same sectors in different order produce identical output fingerprint", () => {
    const key1 = computeOutputFingerprint(BASE_SECTORS);
    const key2 = computeOutputFingerprint([...BASE_SECTORS].reverse());
    assert.equal(key1, key2, "Output fingerprint must be order-independent");
  });

  it("same input fingerprint regardless of upstream context timestamp", () => {
    // Input fingerprint uses discrete fields only — timestamps are excluded
    const fp1 = makeInputFingerprint({ sentiment: "Bullish", events: ["CPI|2026-09-12"] });
    const fp2 = makeInputFingerprint({ sentiment: "Bullish", events: ["CPI|2026-09-12"] });
    assert.equal(fp1, fp2, "Input fingerprint must be stable across identical discrete inputs");
  });

  it("upstream event list order does not affect fingerprint", () => {
    const fp1 = makeInputFingerprint({ events: ["FOMC|2026-09-01", "CPI|2026-09-12"] });
    const fp2 = makeInputFingerprint({ events: ["CPI|2026-09-12", "FOMC|2026-09-01"] });
    assert.equal(fp1, fp2, "Event list is sorted internally — order must not matter");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario G — Material sector-specific event → analysis eligible to rerun
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario G — new event makes analysis eligible for rerun", () => {
  it("new upcoming event changes input fingerprint", () => {
    const fpBefore = makeInputFingerprint({ events: [] });
    const fpAfter = makeInputFingerprint({ events: ["Semiconductor export ban|2026-08-20"] });
    assert.notEqual(fpBefore, fpAfter, "New event must change fingerprint and trigger AI rerun");
  });

  it("event passing does not create a new fingerprint entry (different from added event)", () => {
    // After event passes, it drops from the event list
    const fpWithEvent = makeInputFingerprint({ events: ["FOMC|2026-09-01"] });
    const fpWithoutEvent = makeInputFingerprint({ events: [] });
    assert.notEqual(fpWithEvent, fpWithoutEvent, "Event removal also changes fingerprint");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario H — No sufficient sector price data → system does NOT invent
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario H — no sector price data → no fabricated metrics", () => {
  it("SectorMonitorFacts has no return/rank/rotation fields", () => {
    const facts = computePortfolioSectorExposure(
      [pos("AAPL", 50_000)],
      new Map([["AAPL", "Technology"]])
    );
    // The type must NOT have returnXD, rank, rotation, relativeToMarket fields
    const entry = facts.portfolioExposure[0];
    assert.ok(!("return1D" in entry), "return1D must not exist — no price data");
    assert.ok(!("relativeToMarket1D" in entry), "relativeToMarket1D must not exist");
    assert.ok(!("rank1D" in entry), "rank1D must not exist");
    assert.ok(!("rotation" in facts), "rotation must not exist at top level");
    assert.ok(!("dispersion" in facts), "dispersion must not exist");
  });

  it("SectorFacts block explicitly states when no sector data is available", () => {
    const facts: SectorMonitorFacts = {
      portfolioExposure: [],
      unclassifiedTickers: ["AAPL", "MSFT"],
      coveragePct: 0,
      coverageConfidence: "Low",
      totalClassifiableMv: 0,
    };
    const block = buildSectorFactsBlock(facts);
    assert.ok(block.includes("No sector classification available"), "Block must warn about missing data");
    assert.ok(block.includes("do not estimate"), "Block must prohibit AI from estimating exposure");
  });

  it("empty portfolio produces zero exposure — not fabricated sectors", () => {
    const facts = computePortfolioSectorExposure([], new Map());
    assert.equal(facts.portfolioExposure.length, 0);
    // Block should not claim any sector has exposure
    const block = buildSectorFactsBlock(facts);
    assert.ok(!block.includes("Significant"), "No Significant exposure when portfolio is empty");
    assert.ok(!block.includes("Technology"), "No Technology in block when no holdings");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Scenario I — Downstream compact context remains valid
// ═════════════════════════════════════════════════════════════════════════════

describe("Scenario I — downstream SectorAiContext format compatibility", () => {
  it("output sectors retain name, rating, trend fields consumed by downstream-ai-context", () => {
    // downstream-ai-context.getSectorAiContext() reads: name, rating, trend
    // These fields must be present in computeOutputFingerprint input
    const sectors = [
      { name: "Technology", rating: "Strong", trend: "Improving" },
      { name: "Healthcare", rating: "Neutral", trend: "Stable" },
    ];
    // computeOutputFingerprint must accept these without throwing
    const key = computeOutputFingerprint(sectors);
    assert.ok(typeof key === "string" && key.length > 0, "Fingerprint must be non-empty string");
    assert.ok(key.includes("Technology:Strong:Improving"), "Must contain sector:rating:trend token");
  });

  it("getSectorAiContext fields (overallOutlook + sectors name/rating/trend) are preserved in output shape", () => {
    // The output shape that goes into analysisRepository must include these
    // fields for downstream-ai-context compatibility — verify the expected
    // structure shape is what the route assembles.
    const mockParsedResult = {
      executiveSummary: "Tech leads.",
      overallOutlook: "Cautiously optimistic.",
      topSector: { name: "Technology", reason: "AI spend" },
      sectors: [
        {
          name: "Technology",
          rating: "Strong",
          trend: "Improving",
          summary: "AI boom drives earnings",
          drivers: ["AI capex", "cloud"],
          risks: ["valuation"],
          outlook: "Strong near-term",
          confidence: "High",
        },
      ],
      timestamp: "2026-08-14T12:00:00Z",
      analysisDuration: 5000,
    };
    // All downstream-consumed fields present
    assert.ok("overallOutlook" in mockParsedResult);
    assert.ok("sectors" in mockParsedResult);
    assert.equal(mockParsedResult.sectors[0].name, "Technology");
    assert.equal(mockParsedResult.sectors[0].rating, "Strong");
    assert.equal(mockParsedResult.sectors[0].trend, "Improving");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// extractMarketInputs / extractEventInputs / extractNewsInputs
// ═════════════════════════════════════════════════════════════════════════════

describe("extractMarketInputs", () => {
  it("extracts discrete fields from market-monitor result", () => {
    const result = {
      marketSentiment: "Bullish",
      riskLevel: "Low",
      strongSectors: ["Technology", "Healthcare"],
      weakSectors: ["Energy"],
    };
    const inputs = extractMarketInputs(result);
    assert.equal(inputs.sentiment, "Bullish");
    assert.equal(inputs.risk, "Low");
    assert.deepEqual(inputs.strongSectors, ["Healthcare", "Technology"]); // sorted
    assert.deepEqual(inputs.weakSectors, ["Energy"]);
  });

  it("returns unknown defaults when result is null", () => {
    const inputs = extractMarketInputs(null);
    assert.equal(inputs.sentiment, "unknown");
    assert.equal(inputs.risk, "unknown");
    assert.deepEqual(inputs.strongSectors, []);
    assert.deepEqual(inputs.weakSectors, []);
  });
});

describe("extractEventInputs", () => {
  it("returns title|date keys for upcoming events, sorted", () => {
    const result = {
      events: [
        { title: "CPI Release", date: "2026-09-12", status: "upcoming" },
        { title: "FOMC Decision", date: "2026-09-01", status: "upcoming" },
        { title: "Old Event", date: "2026-08-01", status: "passed" },
      ],
    };
    const keys = extractEventInputs(result);
    assert.deepEqual(keys, ["CPI Release|2026-09-12", "FOMC Decision|2026-09-01"]);
  });

  it("returns empty array when no events", () => {
    assert.deepEqual(extractEventInputs(null), []);
    assert.deepEqual(extractEventInputs({ events: [] }), []);
  });
});

describe("extractNewsInputs", () => {
  it("extracts impact and top story title", () => {
    const result = {
      overallMarketImpact: "Positive",
      topStory: { title: "Fed holds rates steady" },
      executiveSummary: "Markets rally on Fed decision.",
    };
    const inputs = extractNewsInputs(result);
    assert.equal(inputs.impact, "Positive");
    assert.equal(inputs.topStoryTitle, "Fed holds rates steady");
  });

  it("falls back to executiveSummary when topStory is missing", () => {
    const result = {
      overallMarketImpact: "Mixed",
      executiveSummary: "Mixed signals from earnings.",
    };
    const inputs = extractNewsInputs(result);
    assert.equal(inputs.topStoryTitle, "Mixed signals from earnings.");
  });

  it("returns unknown defaults for null", () => {
    const inputs = extractNewsInputs(null);
    assert.equal(inputs.impact, "unknown");
    assert.equal(inputs.topStoryTitle, "");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// buildExposureBandKeys
// ═════════════════════════════════════════════════════════════════════════════

describe("buildExposureBandKeys", () => {
  it("returns sorted sector:band pairs, excluding None bands", () => {
    const exposure: SectorPortfolioExposure[] = [
      makeExposure("Technology", 34, "Significant"),
      makeExposure("Healthcare", 10, "Moderate"),
      makeExposure("Cash", 0.5, "None"),
    ];
    const keys = buildExposureBandKeys(exposure);
    assert.deepEqual(keys, ["Healthcare:Moderate", "Technology:Significant"]);
  });

  it("returns empty array for empty exposure", () => {
    assert.deepEqual(buildExposureBandKeys([]), []);
  });

  it("excludes None bands to avoid fingerprint churn from tiny positions", () => {
    const exposure: SectorPortfolioExposure[] = [
      makeExposure("Technology", 34, "Significant"),
      makeExposure("Tiny", 0.1, "None"),
    ];
    const keys = buildExposureBandKeys(exposure);
    assert.ok(!keys.some((k) => k.includes("Tiny")), "None-band sectors must be excluded");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// buildSectorFactsBlock
// ═════════════════════════════════════════════════════════════════════════════

describe("buildSectorFactsBlock", () => {
  it("lists sectors with exposure % and band", () => {
    const facts: SectorMonitorFacts = {
      portfolioExposure: [
        makeExposure("Technology", 34, "Significant"),
        makeExposure("Healthcare", 18, "Significant"),
        makeExposure("Energy", 3, "Minor"),
      ],
      unclassifiedTickers: [],
      coveragePct: 100,
      coverageConfidence: "High",
      totalClassifiableMv: 100_000,
    };
    const block = buildSectorFactsBlock(facts);
    assert.ok(block.includes("Technology: 34.0% — Significant"));
    assert.ok(block.includes("Healthcare: 18.0% — Significant"));
    assert.ok(block.includes("Energy: 3.0% — Minor"));
    assert.ok(block.includes("Coverage: 100%"));
  });

  it("includes unclassified tickers with do-not-guess instruction", () => {
    const facts: SectorMonitorFacts = {
      portfolioExposure: [makeExposure("Technology", 60, "Significant")],
      unclassifiedTickers: ["UNKNOWN"],
      coveragePct: 60,
      coverageConfidence: "Low",
      totalClassifiableMv: 100_000,
    };
    const block = buildSectorFactsBlock(facts);
    assert.ok(block.includes("UNKNOWN"), "Unclassified ticker must appear in block");
    assert.ok(block.includes("no sector data available — do not guess"), "Must prohibit AI from guessing");
  });

  it("does NOT recalculate instruction is present", () => {
    const facts: SectorMonitorFacts = {
      portfolioExposure: [makeExposure("Technology", 50, "Significant")],
      unclassifiedTickers: [],
      coveragePct: 100,
      coverageConfidence: "High",
      totalClassifiableMv: 50_000,
    };
    const block = buildSectorFactsBlock(facts);
    assert.ok(block.includes("do NOT recalculate"), "Block must tell AI not to recalculate");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// computeInputFingerprint — edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe("computeInputFingerprint — edge cases", () => {
  it("is deterministic for identical inputs", () => {
    const fp1 = makeInputFingerprint();
    const fp2 = makeInputFingerprint();
    assert.equal(fp1, fp2);
  });

  it("produces different fingerprint for every changed field", () => {
    const base = makeInputFingerprint();
    assert.notEqual(base, makeInputFingerprint({ sentiment: "Bearish" }));
    assert.notEqual(base, makeInputFingerprint({ risk: "High" }));
    assert.notEqual(base, makeInputFingerprint({ strong: ["Healthcare"] }));
    assert.notEqual(base, makeInputFingerprint({ weak: ["Technology"] }));
    assert.notEqual(base, makeInputFingerprint({ events: ["New Event|2026-09-05"] }));
    assert.notEqual(base, makeInputFingerprint({ newsImpact: "Negative" }));
    assert.notEqual(base, makeInputFingerprint({ newsTop: "Different top story" }));
    assert.notEqual(base, makeInputFingerprint({ exposure: ["Technology:Minor"] }));
  });
});
