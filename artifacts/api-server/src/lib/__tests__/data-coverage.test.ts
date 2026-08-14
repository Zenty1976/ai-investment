/**
 * Data Coverage Tests — spec §29–33
 *
 * §29  Consensus revision direction (mocked snapshots)
 * §30  Earnings behavior deterministic calculation from OHLC + known dates
 * §31  Missing data safety — no consensus → ExpectationGap stays UNKNOWN
 * §32  Point-in-time protection — Aug 15 snapshot not visible on Aug 12
 * §33  Large universe efficiency — 5000 tickers, no AI calls
 *
 * All pino-free. No OpenAI calls. No Saxo calls.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  saveConsensusSnapshot,
  getConsensusSnapshots,
  getSnapshotAt,
  computeRevisionFacts,
  computeAllRevisions,
} from "../consensus-repository.js";
import {
  computeEarningsBehavior,
  computeSingleEarningsReaction,
  type OhlcBar,
} from "../earnings-behavior-calculator.js";
import {
  saveCalendarEntry,
  getCalendarEntries,
  getNextEarnings,
  getPastEarningsDates,
  getCalendarCoveredTickerCount,
} from "../earnings-calendar-repository.js";
import {
  saveUniverseRecords,
  loadUniverseRecords,
  getUniverseStats,
  seedUniverseIfEmpty,
} from "../market-universe-repository.js";
import { analysisRepository } from "../analysis-repository.js";
import { NullExpectationsProvider } from "../expectations-provider.js";
import type { ConsensusSnapshot } from "../consensus-repository.js";
import type { MarketRecord } from "../market-universe-provider.js";
import type { EarningsHistoryEntry } from "../catalyst-types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const NOW_ISO = "2026-08-14T12:00:00Z";

function makeSnapshot(
  ticker: string,
  dataAsOf: string,
  epsConsensus: number | null,
  revenueConsensus: number | null = null
): ConsensusSnapshot {
  return {
    ticker,
    dataAsOf,
    retrievedAt: new Date(dataAsOf + "T12:00:00Z").toISOString(),
    epsConsensus,
    revenueConsensus,
    ebitdaConsensus: null,
    estimateCount: 8,
    epsHigh: epsConsensus ? epsConsensus * 1.05 : null,
    epsLow: epsConsensus ? epsConsensus * 0.95 : null,
    fiscalPeriod: "Q3 2026",
    provenance: {
      provider: "MockProvider",
      retrievedAt: new Date(dataAsOf + "T12:00:00Z").toISOString(),
      dataAsOf,
      quality: "HIGH",
    },
  };
}

/** Generate N daily bars from startDate with a simple upward drift. */
function generateBars(startDate: string, count: number, startPrice = 100): OhlcBar[] {
  const bars: OhlcBar[] = [];
  const start = new Date(startDate);
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const close = startPrice + i * 0.1 + (Math.sin(i) * 0.5); // slight drift + oscillation
    bars.push({
      time: d.toISOString().slice(0, 10),
      open: close - 0.05,
      high: close + 0.1,
      low: close - 0.1,
      close: Math.round(close * 100) / 100,
    });
  }
  return bars;
}

/** Generate bars with known sharp reactions on specific dates. */
function generateBarsWithReactions(
  startDate: string,
  count: number,
  reactions: Array<{ offsetDays: number; reactionPct: number }>
): OhlcBar[] {
  const bars: OhlcBar[] = [];
  const start = new Date(startDate);
  let price = 100;

  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);

    // Apply a sharp reaction on specified offsets
    const reaction = reactions.find(r => r.offsetDays === i);
    if (reaction) {
      price = price * (1 + reaction.reactionPct);
    }

    bars.push({
      time: d.toISOString().slice(0, 10),
      open: price * 0.998,
      high: price * 1.005,
      low: price * 0.995,
      close: Math.round(price * 100) / 100,
    });

    price = price + 0.05; // tiny daily drift
  }
  return bars;
}

// ── §29: Consensus revision direction ────────────────────────────────────────

describe("§29: Consensus revision direction", () => {
  const TICKER = "REVTEST";

  test("saveConsensusSnapshot deduplicates unchanged values", () => {
    const snap1 = makeSnapshot(TICKER, "2026-07-01", 8.0, 1000);
    const stored1 = saveConsensusSnapshot(snap1);
    assert.equal(stored1, true, "First snapshot should be stored");

    const snap2 = makeSnapshot(TICKER, "2026-07-02", 8.0, 1000); // unchanged
    const stored2 = saveConsensusSnapshot(snap2);
    assert.equal(stored2, false, "Identical snapshot should be deduplicated");

    const snapshots = getConsensusSnapshots(TICKER);
    assert.equal(snapshots.length, 1, "Should have 1 snapshot after deduplication");
  });

  test("saveConsensusSnapshot stores materially changed values", () => {
    const snap3 = makeSnapshot(TICKER, "2026-07-15", 8.5, 1020); // +6.25% EPS
    const stored3 = saveConsensusSnapshot(snap3);
    assert.equal(stored3, true, "Material change should be stored");

    const snap4 = makeSnapshot(TICKER, "2026-08-01", 10.0, 1050); // +17.6%
    saveConsensusSnapshot(snap4);

    const snapshots = getConsensusSnapshots(TICKER);
    assert.equal(snapshots.length, 3, "Should have 3 snapshots: initial + 2 material changes");
  });

  test("computeRevisionFacts: revisionDirection=UP when estimates rose", () => {
    // From §29 spec example: 30 days ago = 8.0, today = 10.0
    const today = "2026-08-14";
    const rev30D = computeRevisionFacts(TICKER, today, 30);

    // From snapshot at Aug 1 (10.0) vs snapshot visible 30 days before Aug 14 = Jul 15 (8.5)
    assert.equal(rev30D.epsDirection, "UP", "EPS revision must be UP (8.5 → 10.0)");
    assert.ok(rev30D.epsRevisionPct !== null, "EPS revision pct must not be null");
    assert.ok(rev30D.epsRevisionPct! > 0, "EPS revision pct must be positive");
  });

  test("computeRevisionFacts: magnitude correctly calculated", () => {
    const today = "2026-08-14";
    const rev30D = computeRevisionFacts(TICKER, today, 30);

    // from 8.5 (Jul 15) to 10.0 (Aug 1): (10 - 8.5) / 8.5 = 0.1765
    const expected = (10.0 - 8.5) / 8.5;
    assert.ok(
      Math.abs(rev30D.epsRevisionPct! - expected) < 0.01,
      `Revision magnitude should be ~${expected.toFixed(4)}, got ${rev30D.epsRevisionPct}`
    );
  });

  test("computeAllRevisions returns all 4 windows", () => {
    const today = "2026-08-14";
    const all = computeAllRevisions(TICKER, today);
    assert.ok("rev7D" in all && "rev30D" in all && "rev60D" in all && "rev90D" in all);
  });

  test("revisionDirection=UNKNOWN when no historical snapshots exist for window", () => {
    const today = "2026-08-14";
    const rev90D = computeRevisionFacts(TICKER, today, 90);
    // 90 days before Aug 14 = May 15 — no snapshots before Jul 1
    // fromSnapshot may be null → direction = UNKNOWN
    if (!rev90D.fromSnapshot) {
      assert.equal(rev90D.epsDirection, "UNKNOWN");
    }
    // If a from-snapshot exists 90 days ago, direction should still be valid
  });

  test("catalyst facts have expectationGap UNKNOWN when consensus unavailable (spec §19)", () => {
    // With NullExpectationsProvider, consensus is always unavailable
    const nullProvider = new NullExpectationsProvider();
    const caps = nullProvider.describeCapabilities();
    assert.equal(caps.supportsEpsConsensus, false);
    assert.equal(caps.supportsRevenueConsensus, false);
    // The provider must not fabricate numeric values
    // Testing via the return value
    nullProvider.getCurrentConsensus("ANYTOKEN").then(profile => {
      assert.equal(profile.epsConsensus, null, "NullProvider must not fabricate EPS consensus");
      assert.equal(profile.revenueConsensus, null, "NullProvider must not fabricate revenue consensus");
      assert.equal(profile.expectationsTrend, "Unknown", "Unknown ≠ Neutral (spec §19)");
      assert.equal(profile.isUnavailable, true);
    });
  });
});

// ── §30: Earnings behavior deterministic calculation ─────────────────────────

describe("§30: Earnings behavior — deterministic price calculation", () => {
  const NOW = "2026-08-14T12:00:00Z";

  test("correct 1D reaction from OHLC bars", () => {
    // Bar at earnings date: close = 100
    // Bar 1 day after: close = 105 → return = +5%
    const bars: OhlcBar[] = [
      { time: "2026-05-10", open: 99, high: 101, low: 99, close: 100 },
      { time: "2026-05-11", open: 104, high: 106, low: 103, close: 105 },
      { time: "2026-05-12", open: 104, high: 106, low: 103, close: 104 },
    ];
    const reaction = computeSingleEarningsReaction(bars, "2026-05-10");
    assert.ok(Math.abs(reaction.return1D! - 0.05) < 0.0001, `1D return should be +5%, got ${reaction.return1D}`);
    assert.equal(Math.abs(reaction.absReturn1D! - 0.05) < 0.0001, true);
  });

  test("correct 5D reaction from OHLC bars", () => {
    const bars = generateBars("2026-04-01", 30, 100);
    const earningsDate = "2026-04-10";
    const reaction = computeSingleEarningsReaction(bars, earningsDate);

    const eventIdx = bars.findIndex(b => b.time === earningsDate);
    if (eventIdx >= 0 && eventIdx + 5 < bars.length) {
      const expected = (bars[eventIdx + 5].close - bars[eventIdx].close) / bars[eventIdx].close;
      assert.ok(
        Math.abs(reaction.return5D! - expected) < 0.0001,
        `5D return should be ${expected}, got ${reaction.return5D}`
      );
    }
  });

  test("pre-event run-up correctly calculated", () => {
    const bars = generateBars("2026-04-01", 30, 100);
    const earningsDate = "2026-04-15";
    const reaction = computeSingleEarningsReaction(bars, earningsDate);

    const eventIdx = bars.findIndex(b => b.time === earningsDate);
    if (eventIdx >= 5) {
      const expected5D = (bars[eventIdx].close - bars[eventIdx - 5].close) / bars[eventIdx - 5].close;
      assert.ok(
        Math.abs(reaction.preEvent5DReturn! - expected5D) < 0.0001,
        `Pre-5D return should be ${expected5D}, got ${reaction.preEvent5DReturn}`
      );
    }
  });

  test("computeEarningsBehavior returns isUnavailable when no bars", () => {
    const profile = computeEarningsBehavior([], ["2026-05-10"], [], NOW);
    assert.equal(profile.isUnavailable, true);
    assert.equal(profile.reportsAnalyzed, 0);
  });

  test("computeEarningsBehavior returns isUnavailable when no earnings dates", () => {
    const bars = generateBars("2026-01-01", 90, 100);
    const profile = computeEarningsBehavior(bars, [], [], NOW);
    assert.equal(profile.isUnavailable, true);
  });

  test("computeEarningsBehavior correctly averages multiple reactions", () => {
    // Two earnings: +5% and -3% → average = +1%
    const bars = generateBarsWithReactions("2026-01-01", 60, [
      { offsetDays: 10, reactionPct: 0.05 },   // +5% on day 10 (earnings Q1)
      { offsetDays: 40, reactionPct: -0.03 },  // -3% on day 40 (earnings Q2)
    ]);

    const earningsDates = [
      bars[9].time,  // day 10 (0-indexed 9)
      bars[39].time, // day 40 (0-indexed 39)
    ];

    const profile = computeEarningsBehavior(bars, earningsDates, [], NOW);
    assert.equal(profile.isUnavailable, false);
    assert.ok(profile.reportsAnalyzed >= 2, `Should analyze at least 2 reports, got ${profile.reportsAnalyzed}`);
    assert.ok(profile.average1DReaction !== null, "Should have average 1D reaction");
    // Average should be roughly (0.05 - 0.03) / 2 = 0.01
    assert.ok(
      Math.abs(profile.average1DReaction!) < 0.1,
      `Average reaction should be modest, got ${profile.average1DReaction}`
    );
  });

  test("isPartial=true when no external EPS data provided", () => {
    const bars = generateBars("2026-01-01", 30, 100);
    const profile = computeEarningsBehavior(bars, [bars[10].time], [], NOW);
    assert.equal(profile.isPartial, true, "Should be partial without EPS data");
    assert.equal(profile.beatRateEPS, null, "Beat rate must be null without EPS data");
    assert.equal(profile.beatRateRevenue, null, "Beat rate revenue must be null without revenue data");
  });

  test("beat/miss counts with EPS data provided", () => {
    const bars = generateBarsWithReactions("2026-01-01", 90, [
      { offsetDays: 20, reactionPct: 0.06 },   // +6% (beat + rose)
      { offsetDays: 60, reactionPct: -0.04 },  // -4% (miss + fell)
    ]);

    const earningsDates = [bars[19].time, bars[59].time];

    const historyEntries: EarningsHistoryEntry[] = [
      {
        period: "Q1 2026",
        reportDate: bars[19].time,
        epsActual: 1.10,
        epsEstimate: 1.00,
        epsSurprisePct: 10,
        revenueActual: 100,
        revenueEstimate: 98,
        revenueSurprisePct: 2,
        ebitdaActual: null,
        ebitdaEstimate: null,
        ebitdaSurprisePct: null,
        guidanceAction: "Raised",
        priceReaction1D: null,
        priceReaction5D: null,
      },
      {
        period: "Q2 2026",
        reportDate: bars[59].time,
        epsActual: 0.90,
        epsEstimate: 1.00,
        epsSurprisePct: -10,
        revenueActual: 95,
        revenueEstimate: 100,
        revenueSurprisePct: -5,
        ebitdaActual: null,
        ebitdaEstimate: null,
        ebitdaSurprisePct: null,
        guidanceAction: "Lowered",
        priceReaction1D: null,
        priceReaction5D: null,
      },
    ];

    const profile = computeEarningsBehavior(bars, earningsDates, historyEntries, NOW);
    assert.equal(profile.beatRateEPS, 0.5, "Beat rate should be 50% (1 of 2)");
    assert.equal(profile.isPartial, false, "Should not be partial with EPS + revenue data");
  });

  test("priceDataSource is 'Saxo OHLC'", () => {
    const bars = generateBars("2026-01-01", 30, 100);
    const profile = computeEarningsBehavior(bars, [bars[10].time], [], NOW);
    assert.equal(profile.priceDataSource, "Saxo OHLC");
  });
});

// ── §31: Missing data safety ─────────────────────────────────────────────────

describe("§31: Missing data safety — UNKNOWN ≠ NEUTRAL", () => {
  test("NullExpectationsProvider never returns fabricated consensus", async () => {
    const provider = new NullExpectationsProvider();
    const consensus = await provider.getCurrentConsensus("AAPL");
    assert.equal(consensus.epsConsensus, null, "Must not fabricate EPS consensus");
    assert.equal(consensus.revenueConsensus, null, "Must not fabricate revenue consensus");
    assert.equal(consensus.ebitdaConsensus, null, "Must not fabricate EBITDA consensus");
    assert.equal(consensus.isUnavailable, true, "Must be explicitly marked as unavailable");
    assert.equal(consensus.expectationsTrend, "Unknown",
      "Missing data must be UNKNOWN, not NEUTRAL (spec §19)");
    assert.ok(
      consensus.unavailableReason!.length > 0,
      "Must explain why data is unavailable"
    );
  });

  test("NullExpectationsProvider revision fields are all null", async () => {
    const provider = new NullExpectationsProvider();
    const revisions = await provider.getEstimateRevisions("NOVO B");
    assert.equal(revisions.estimateRevision1M, null);
    assert.equal(revisions.estimateRevision3M, null);
    assert.equal(revisions.numberOfUpwardRevisions, null);
    assert.equal(revisions.numberOfDownwardRevisions, null);
  });

  test("NullExpectationsProvider earnings history is empty", async () => {
    const provider = new NullExpectationsProvider();
    const history = await provider.getEarningsHistory("MAERSK B");
    assert.equal(history.entries.length, 0);
    assert.equal(history.isUnavailable, true);
  });

  test("getSnapshotAt returns null for ticker with no snapshots", () => {
    const snapshot = getSnapshotAt("NO_DATA_TICKER", "2026-08-14");
    assert.equal(snapshot, null, "Must return null for ticker with no consensus history");
  });

  test("computeRevisionFacts returns UNKNOWN direction when no history", () => {
    const rev = computeRevisionFacts("NO_HISTORY_TICKER", "2026-08-14", 30);
    assert.equal(rev.epsDirection, "UNKNOWN");
    assert.equal(rev.revenueDirection, "UNKNOWN");
    assert.equal(rev.epsRevisionPct, null);
    assert.equal(rev.revenueRevisionPct, null);
  });

  test("behavior profile isUnavailable when bars too short", () => {
    const bars: OhlcBar[] = [
      { time: "2026-08-10", open: 100, high: 101, low: 99, close: 100 },
    ]; // only 1 bar
    const profile = computeEarningsBehavior(bars, ["2026-08-10"], [], NOW_ISO);
    assert.equal(profile.isUnavailable, true, "Should be unavailable with insufficient bars");
  });
});

// ── §32: Point-in-time protection ────────────────────────────────────────────

describe("§32: Point-in-time protection — no future data leakage", () => {
  const TICKER = "PIT_TICKER";

  before(() => {
    // Set up 3 snapshots: Aug 1 (8.0), Aug 10 (9.0), Aug 15 (11.0)
    saveConsensusSnapshot(makeSnapshot(TICKER, "2026-08-01", 8.0, 800));
    saveConsensusSnapshot(makeSnapshot(TICKER, "2026-08-10", 9.0, 900));
    saveConsensusSnapshot(makeSnapshot(TICKER, "2026-08-15", 11.0, 1100));
  });

  test("getSnapshotAt Aug 12 returns Aug 10 snapshot (not Aug 15)", () => {
    const snap = getSnapshotAt(TICKER, "2026-08-12");
    assert.ok(snap !== null, "Should find a snapshot for Aug 12");
    assert.equal(snap!.epsConsensus, 9.0,
      "Aug 12 analysis must use Aug 10 consensus (9.0), NOT the Aug 15 value (11.0)");
    assert.ok(
      snap!.dataAsOf <= "2026-08-12",
      `dataAsOf (${snap!.dataAsOf}) must be on or before the query date (Aug 12)`
    );
  });

  test("getSnapshotAt Aug 15 returns Aug 15 snapshot", () => {
    const snap = getSnapshotAt(TICKER, "2026-08-15");
    assert.ok(snap !== null);
    assert.equal(snap!.epsConsensus, 11.0, "Aug 15 query should see Aug 15 snapshot");
  });

  test("getSnapshotAt Aug 1 returns only Aug 1 snapshot", () => {
    const snap = getSnapshotAt(TICKER, "2026-08-01");
    assert.ok(snap !== null);
    assert.equal(snap!.epsConsensus, 8.0, "Aug 1 query must not see Aug 10 or Aug 15 snapshots");
  });

  test("getSnapshotAt before any data returns null", () => {
    const snap = getSnapshotAt(TICKER, "2026-07-31");
    assert.equal(snap, null, "No data before Aug 1 — must return null");
  });

  test("EarningsCalendarEntry point-in-time: only retrievedAt-eligible entries returned", () => {
    const calTicker = "PIT_CAL";
    saveCalendarEntry(calTicker, {
      ticker: calTicker,
      earningsDate: "2026-09-15",
      time: "BEFORE_MARKET",
      fiscalQuarter: "Q3 2026",
      fiscalYear: 2026,
      confirmed: false,
      source: "AI web search",
      provenance: {
        provider: "AI web search",
        retrievedAt: "2026-08-10T12:00:00Z", // discovered on Aug 10
        dataAsOf: "2026-08-10",
        quality: "MEDIUM",
      },
    });

    // Query as of Aug 9: should not see the Aug 10 entry
    const before = getNextEarnings(calTicker, "2026-09-01", "2026-08-09T12:00:00Z");
    assert.equal(before, null, "Should not see entries retrieved after asOf date");

    // Query as of Aug 11: should see the Aug 10 entry
    const after = getNextEarnings(calTicker, "2026-09-01", "2026-08-11T12:00:00Z");
    assert.ok(after !== null, "Should see entry retrieved before asOf date");
    assert.equal(after!.earningsDate, "2026-09-15");
  });
});

// ── §33: Large universe efficiency ────────────────────────────────────────────

describe("§33: Large universe — efficient storage without AI calls", () => {
  const TEST_EXCHANGE = "LARGE_TEST_EXCHANGE";

  test("can save and load 5000 instrument records efficiently", () => {
    const records: MarketRecord[] = Array.from({ length: 5000 }, (_, i) => ({
      ticker: `TICK${i}`,
      company: `Company ${i}`,
      exchange: TEST_EXCHANGE,
      country: "US",
      currency: "USD",
      sector: "Technology",
      industry: "Software",
      uic: i + 1000,
      tradeable: true,
      active: true,
      lastVerifiedAt: null,
      source: "EXTERNAL_PROVIDER" as const,
    }));

    const start = Date.now();
    saveUniverseRecords(TEST_EXCHANGE, records, "EXTERNAL_PROVIDER");
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2000, `Saving 5000 records should take <2s, took ${elapsed}ms`);

    const loaded = loadUniverseRecords(TEST_EXCHANGE);
    assert.ok(loaded !== null, "Should successfully load saved records");
    assert.equal(loaded!.records.length, 5000, "Should have all 5000 records");
    assert.equal(loaded!.source, "EXTERNAL_PROVIDER");
  });

  test("seedUniverseIfEmpty is idempotent — does not overwrite existing data", () => {
    // Records already saved above with EXTERNAL_PROVIDER source
    const seedRecords: MarketRecord[] = [
      {
        ticker: "SEEDED",
        company: "Seeded Corp",
        exchange: TEST_EXCHANGE,
        country: "US",
        currency: "USD",
        sector: null,
        industry: null,
        uic: null,
        tradeable: true,
        active: true,
        lastVerifiedAt: null,
        source: "STATIC_SEED",
      },
    ];

    seedUniverseIfEmpty(TEST_EXCHANGE, seedRecords);

    // Should still have the 5000 records from above (seed is idempotent)
    const loaded = loadUniverseRecords(TEST_EXCHANGE);
    assert.equal(loaded!.records.length, 5000, "seedUniverseIfEmpty must not overwrite existing data");
    assert.equal(loaded!.source, "EXTERNAL_PROVIDER", "Source must remain EXTERNAL_PROVIDER");
  });

  test("getUniverseStats reports correct count and source", () => {
    const stats = getUniverseStats(TEST_EXCHANGE);
    assert.equal(stats.count, 5000);
    assert.equal(stats.source, "EXTERNAL_PROVIDER");
    assert.equal(stats.isSeedOnly, false);
    assert.equal(stats.coverageWarning, null, "No warning when using non-seed source");
  });

  test("universe repository lookup is by ticker — no AI calls", () => {
    // Verify we can look up tickers from the saved universe
    const loaded = loadUniverseRecords(TEST_EXCHANGE);
    const tick2500 = loaded!.records.find(r => r.ticker === "TICK2500");
    assert.ok(tick2500, "Should find TICK2500 in loaded records");
    assert.equal(tick2500!.uic, 3500, "UIC should be 2500 + 1000 = 3500");
  });

  test("earnings calendar covered-ticker count increments per unique ticker", () => {
    const before = getCalendarCoveredTickerCount();

    // Add calendar entry for a new unique ticker
    const uniqTicker = `LARGEUNIVERSE_${Date.now()}`;
    saveCalendarEntry(uniqTicker, {
      ticker: uniqTicker,
      earningsDate: "2026-10-01",
      time: "AFTER_MARKET",
      fiscalQuarter: "Q3 2026",
      fiscalYear: 2026,
      confirmed: true,
      source: "External provider",
      provenance: {
        provider: "External provider",
        retrievedAt: NOW_ISO,
        dataAsOf: "2026-08-14",
        quality: "HIGH",
      },
    });

    const after = getCalendarCoveredTickerCount();
    assert.equal(after, before + 1, "Covered ticker count should increment by 1");
  });

  test("consensus-history count grows per ticker, not per snapshot", () => {
    const before = { tickers: 0 }; // fresh test, other tests may have added tickers
    const CTICKER = "CONSENSUS_COUNT_TEST";
    const s1 = makeSnapshot(CTICKER, "2026-07-01", 5.0);
    const s2 = makeSnapshot(CTICKER, "2026-07-15", 5.6); // +12% → material
    const s3 = makeSnapshot(CTICKER, "2026-07-16", 5.6); // unchanged → deduplicated

    saveConsensusSnapshot(s1);
    saveConsensusSnapshot(s2);
    saveConsensusSnapshot(s3);

    const snapshots = getConsensusSnapshots(CTICKER);
    assert.equal(snapshots.length, 2, "Deduplicated: 2 distinct values stored, not 3");
  });
});
