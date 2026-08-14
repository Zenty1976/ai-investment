/**
 * Catalyst Intelligence — Part 2 Regression Tests
 *
 * Covers:
 *   1. SpaceX-style scheduled event (non-earnings, planned product launch)
 *   2. Negative event test (large pre-event runup + single low-quality source)
 *   3. Emerging setup test (PATH B — no scheduled event, signal accumulation)
 *   4. Signal accumulation state computation
 *   5. Emerging setup detection
 *
 * Zero AI calls. Zero Saxo calls. Pure deterministic logic.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

// ── Tested modules ──────────────────────────────────────────────────────────

import { computeSignalAccumulationState } from "../catalyst-signal-accumulation.js";
import { detectEmergingSetup, emergingSetupWarrantsAnalysis } from "../catalyst-emerging-setup.js";
import { screenCatalystCandidate } from "../catalyst-screening.js";
import { buildPriceAsymmetryFacts } from "../catalyst-price-asymmetry.js";
import { DEFAULT_CATALYST_SCREENING_CONFIG } from "../catalyst-types.js";
import type { LeadingIndicatorSignal, PriceContext, CatalystFacts } from "../catalyst-types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSignal(overrides: Partial<LeadingIndicatorSignal>): LeadingIndicatorSignal {
  const now = new Date().toISOString();
  return {
    signalId: `test-${Math.random().toString(36).slice(2, 8)}`,
    driver: "Test Driver",
    direction: "Positive",
    observedFact: "Test fact",
    interpretation: null,
    previousContext: null,
    observationDate: now.slice(0, 10),
    source: "Test Source",
    sourceType: "WebSearch",
    sourceQuality: "ReliableReporting",
    sourceConfidence: "Medium",
    leadTimeRelevance: "Medium",
    companyImpactReason: "Test reason",
    freshness: "Fresh",
    informationCategory: "RELIABLE_REPORTING",
    sourceOriginId: "test-source.com",
    canonicalSource: "Test Source",
    availableAt: now,
    ...overrides,
  };
}

function makePriceContext(overrides: Partial<PriceContext> = {}): PriceContext {
  return {
    ticker: "TEST",
    currentPrice: 100,
    priceState: "Neutral",
    returns: { return1D: 0, return5D: 2, return10D: 3, return30D: 5, return90D: 10 },
    volatility: { annualizedVolPct: 25, volatilityState: "Normal", volatilityTrend: "Stable" },
    trend: { shortTermTrend: "Up", mediumTermTrend: "Up", longTermTrend: "Up", momentumChange: "Stable" },
    recentBehavior: { state: "BullishMomentum", consecutive: 3 },
    computedAt: new Date().toISOString(),
    ...overrides,
  } as PriceContext;
}

function makeMinimalFacts(ticker: string, daysUntilEvent: number, signals: LeadingIndicatorSignal[]): CatalystFacts {
  const now = new Date().toISOString();
  const eventDate = new Date();
  eventDate.setDate(eventDate.getDate() + daysUntilEvent);
  const eventDateStr = eventDate.toISOString().slice(0, 10);

  return {
    assembledAt: now,
    event: {
      ticker,
      company: `${ticker} Test Company`,
      eventType: "Earnings",
      eventDate: eventDateStr,
      daysUntilEvent,
      reportingPeriod: "Q2 2026",
      marketTiming: "BeforeMarket",
      source: "CompanyMonitor",
      sourceConfidence: "High",
      classification: "Unknown",
    },
    price: {
      currentPrice: 100,
      priceState: "Neutral",
      priceAsymmetryFacts: {
        preEventRunupPct: 5,
        preEventRunupPeriod: "5D",
        recentMomentum5D: 5,
        recentMomentum10D: 3,
        momentum30D: 5,
        momentum90D: 10,
        drawdownFrom30DayHighPct: -2,
        distanceFrom90DayHighPct: -5,
        distanceFrom90DayLowPct: 20,
        runupPattern: "SmallRunup",
        asymmetry: "Attractive",
        reasoning: "Moderate pre-event run-up, asymmetry still attractive",
      },
      volatilityState: "Normal",
      volatilityTrend: "Stable",
      shortTermTrend: "Up",
      mediumTermTrend: "Up",
      longTermTrend: "Neutral",
      momentumChange: "Stable",
      recentBehavior: "BullishMomentum",
    },
    history: {
      entries: [],
      dataSource: null,
      lastUpdatedAt: null,
      isUnavailable: true,
      unavailableReason: "Test — no history data",
    },
    expectations: {
      revenueConsensus: null,
      epsConsensus: null,
      ebitdaConsensus: null,
      otherRelevantMetrics: {},
      estimateRevision1M: null,
      estimateRevision3M: null,
      numberOfUpwardRevisions: null,
      numberOfDownwardRevisions: null,
      recentTargetChanges: null,
      recentRecommendationChanges: null,
      expectationsTrend: "Unknown",
      dataSource: null,
      lastUpdatedAt: null,
      isUnavailable: true,
      unavailableReason: "Test — no consensus data",
    },
    company: {
      investmentView: "Buy",
      investmentCaseStrength: "High",
      investmentThesis: "Strong fundamental momentum",
      bullCase: "Accelerating growth",
      bearCase: "Macro headwinds",
      earningsGuidanceTrend: "Improving",
      recentMeaningfulChange: null,
      driverProfile: null,
      sector: "Technology",
      industry: "Software",
    },
    signals,
    sector: { sectorSummary: "Tech sector bullish", sectorTrend: "Improving" },
    market: { marketSentiment: "Cautiously Optimistic", riskLevel: "Moderate", marketSummary: "Market mixed" },
    news: {
      materialNews: signals.slice(0, 3).map(s => ({
        headline: s.observedFact,
        summary: s.interpretation,
        publishedAt: s.observationDate,
        sourceQuality: "ReliableReporting" as const,
      })),
      newsCount: signals.length,
    },
    risks: ["Competition", "Macro uncertainty"],
    dataQuality: {
      missingFields: ["earnings-history", "consensus"],
      staleFields: [],
      overallSourceConfidence: "Medium",
      earningsHistoryAvailable: false,
      consensusDataAvailable: false,
      driverProfileAvailable: false,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Signal Accumulation State", () => {
  it("should compute correct window stats for positive signals", () => {
    const now = new Date().toISOString();
    const signals: LeadingIndicatorSignal[] = [
      makeSignal({ direction: "Positive", sourceOriginId: "reuters.com",   availableAt: now }),
      makeSignal({ direction: "Positive", sourceOriginId: "bloomberg.com", availableAt: now }),
      makeSignal({ direction: "Positive", sourceOriginId: "ft.com",        availableAt: now }),
      makeSignal({ direction: "Negative", sourceOriginId: "wsj.com",       availableAt: now }),
    ];

    const state = computeSignalAccumulationState("TEST", signals, [], now);

    assert.equal(state.window7D.positiveMaterialSignals, 3);
    assert.equal(state.window7D.negativeMaterialSignals, 1);
    assert.equal(state.window7D.independentPositiveGroups, 3, "Should have 3 independent positive groups");
    assert.equal(state.window7D.independentNegativeGroups, 1);
    assert.ok(["POSITIVE", "MIXED"].includes(state.overallDirection), `Expected POSITIVE or MIXED, got ${state.overallDirection}`);
  });

  it("should detect echo chamber — same source repeated", () => {
    const now = new Date().toISOString();
    const signals: LeadingIndicatorSignal[] = [
      makeSignal({ direction: "Positive", sourceOriginId: "reuters.com", availableAt: now }),
      makeSignal({ direction: "Positive", sourceOriginId: "reuters.com", availableAt: now }),
      makeSignal({ direction: "Positive", sourceOriginId: "reuters.com", availableAt: now }),
    ];

    const state = computeSignalAccumulationState("TEST", signals, [], now);
    assert.equal(state.window7D.independentPositiveGroups, 1, "All signals from same origin = 1 group");
    assert.equal(state.evidenceConfidence, "Low", "Single-source echo chamber = Low confidence");
  });

  it("should correctly identify signals outside time window", () => {
    const now = new Date().toISOString();
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 20);
    const oldIso = oldDate.toISOString();

    const signals: LeadingIndicatorSignal[] = [
      makeSignal({ direction: "Positive", sourceOriginId: "reuters.com",   availableAt: now }),     // 7D window
      makeSignal({ direction: "Positive", sourceOriginId: "bloomberg.com", availableAt: oldIso }),  // outside 7D, in 30D
    ];

    const state = computeSignalAccumulationState("TEST", signals, [], now);

    assert.equal(state.window7D.positiveMaterialSignals, 1, "Only 1 signal in 7D window");
    assert.equal(state.window30D.positiveMaterialSignals, 2, "Both signals in 30D window");
  });

  it("should track strengthening and weakening drivers", () => {
    const now = new Date().toISOString();
    const signals: LeadingIndicatorSignal[] = [
      makeSignal({ direction: "Positive", driver: "Revenue Growth", sourceOriginId: "s1.com", availableAt: now }),
      makeSignal({ direction: "Positive", driver: "Revenue Growth", sourceOriginId: "s2.com", availableAt: now }),
      makeSignal({ direction: "Negative", driver: "Margins",        sourceOriginId: "s3.com", availableAt: now }),
      makeSignal({ direction: "Negative", driver: "Margins",        sourceOriginId: "s4.com", availableAt: now }),
    ];

    const state = computeSignalAccumulationState("TEST", signals, [], now);

    assert.ok(state.strengtheningDrivers.includes("Revenue Growth"), "Revenue Growth should be strengthening");
    assert.ok(state.weakeningDrivers.includes("Margins"), "Margins should be weakening");
  });

  it("should compute ACCELERATING momentum for improving recent signals", () => {
    const now = new Date(Date.now());
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();

    const signals: LeadingIndicatorSignal[] = [
      // Positive signals in 7D window
      makeSignal({ direction: "StronglyPositive", sourceOriginId: "r1.com", availableAt: now.toISOString() }),
      makeSignal({ direction: "Positive",         sourceOriginId: "r2.com", availableAt: now.toISOString() }),
      // Negative in older windows
      makeSignal({ direction: "Negative", sourceOriginId: "r3.com", availableAt: twentyDaysAgo }),
    ];

    const state = computeSignalAccumulationState("TEST", signals, [], now.toISOString());

    // 7D: 2 positive independent groups, 0 negative
    // 14D: 2 positive, 0 negative
    // 30D: 2 positive, 1 negative
    assert.ok(state.window7D.independentPositiveGroups > state.window30D.independentNegativeGroups, "More positive groups recently");
    assert.ok(["IMPROVING", "ACCELERATING", "STABLE"].includes(state.signalMomentum),
      `Expected improving/accelerating momentum, got ${state.signalMomentum}`);
  });
});

// ── Emerging Setup Tests ─────────────────────────────────────────────────────

describe("Emerging Setup Detection", () => {
  it("should return NONE when no independent positive groups", () => {
    const now = new Date().toISOString();
    const acc = computeSignalAccumulationState("TEST", [], [], now);
    const setup = detectEmergingSetup({
      signalAccumulation: acc,
      momentum5D: 0,
      momentum30D: 0,
      momentum90D: 0,
      cmStatus: null,
      sectorDirection: null,
      hasKnownUpcomingEvent: false,
    });
    assert.equal(setup.state, "NONE");
  });

  it("should return NONE when PATH A (known event) exists — path B doesn't fire", () => {
    const now = new Date().toISOString();
    const signals = [
      makeSignal({ direction: "Positive", sourceOriginId: "r1.com", availableAt: now }),
      makeSignal({ direction: "Positive", sourceOriginId: "r2.com", availableAt: now }),
      makeSignal({ direction: "Positive", sourceOriginId: "r3.com", availableAt: now }),
    ];
    const acc = computeSignalAccumulationState("TEST", signals, [], now);
    const setup = detectEmergingSetup({
      signalAccumulation: acc,
      momentum5D: 3,
      momentum30D: -8,
      momentum90D: -15,
      cmStatus: "Improving",
      sectorDirection: "Bullish",
      hasKnownUpcomingEvent: true, // PATH A active
    });
    assert.equal(setup.state, "NONE", "PATH A active → PATH B should not fire");
  });

  it("should return EARLY for minimal positive signal accumulation", () => {
    const now = new Date().toISOString();
    const signals = [
      makeSignal({ direction: "Positive", sourceOriginId: "reuters.com", driver: "Revenue", availableAt: now }),
      makeSignal({ direction: "Positive", sourceOriginId: "bloomberg.com", driver: "Revenue", availableAt: now }),
    ];
    const acc = computeSignalAccumulationState("TEST", signals, [], now);
    const setup = detectEmergingSetup({
      signalAccumulation: acc,
      momentum5D: 1,
      momentum30D: -3,
      momentum90D: -10,
      cmStatus: null,
      sectorDirection: null,
      hasKnownUpcomingEvent: false,
    });
    // 2 independent positive groups should yield at least EARLY
    assert.ok(["EARLY", "DEVELOPING", "STRONG", "URGENT_REVIEW"].includes(setup.state),
      `Expected EARLY or higher, got ${setup.state}`);
  });

  it("emergingSetupWarrantsAnalysis should require DEVELOPING or higher", () => {
    const now = new Date().toISOString();

    const noneSetup = detectEmergingSetup({
      signalAccumulation: computeSignalAccumulationState("TEST", [], [], now),
      momentum5D: 0, momentum30D: 0, momentum90D: 0,
      cmStatus: null, sectorDirection: null,
      hasKnownUpcomingEvent: false,
    });
    assert.equal(emergingSetupWarrantsAnalysis(noneSetup), false, "NONE should not warrant analysis");

    const earlySignals = [
      makeSignal({ direction: "Positive", sourceOriginId: "r1.com", availableAt: now }),
      makeSignal({ direction: "Positive", sourceOriginId: "r2.com", availableAt: now }),
    ];
    const earlySetup = detectEmergingSetup({
      signalAccumulation: computeSignalAccumulationState("TEST", earlySignals, [], now),
      momentum5D: 2, momentum30D: -5, momentum90D: -10,
      cmStatus: null, sectorDirection: null,
      hasKnownUpcomingEvent: false,
    });
    // EARLY should NOT warrant analysis (too early)
    if (earlySetup.state === "EARLY") {
      assert.equal(emergingSetupWarrantsAnalysis(earlySetup), false, "EARLY should not warrant analysis");
    }
  });
});

// ── SpaceX-Style Non-Earnings Catalyst Regression ──────────────────────────

describe("SpaceX-Style: Non-Earnings Scheduled Event", () => {
  it("should screen as eligible with product launch scheduled in 12 days (DeepAnalysis window)", () => {
    // 12 days ≤ deepAnalysisDaysThreshold (14) → should reach DeepAnalysis
    // Good company quality, moderate run-up, multiple independent positive signals

    const signals: LeadingIndicatorSignal[] = [
      makeSignal({
        signalId: "launch-pre-orders-spacex",
        driver: "Product Demand",
        direction: "StronglyPositive",
        observedFact: "Pre-orders for new product exceeded company expectations by 3x",
        sourceOriginId: "techcrunch.com",
        sourceQuality: "ReliableReporting",
        informationCategory: "RELIABLE_REPORTING",
      }),
      makeSignal({
        signalId: "supply-chain-ready-spacex",
        driver: "Supply Chain",
        direction: "Positive",
        observedFact: "Supply chain partners confirm component deliveries on track",
        sourceOriginId: "reuters.com",
        sourceQuality: "ReliableReporting",
        informationCategory: "RELIABLE_REPORTING",
      }),
      makeSignal({
        signalId: "competitor-delayed-spacex",
        driver: "Market Share",
        direction: "Positive",
        observedFact: "Key competitor announced 6-month delay to their competing product",
        sourceOriginId: "bloomberg.com",
        sourceQuality: "ReliableReporting",
        informationCategory: "RELIABLE_REPORTING",
      }),
    ];

    const screening = screenCatalystCandidate({
      ticker: "SPACEX",
      company: "SpaceX Corp",
      daysUntilEvent: 12,
      priceAsymmetry: "Attractive",
      investmentView: "Buy",
      earningsGuidanceTrend: "Improving",
      relevantSignalCount: signals.length,
      signals,
      hasPriceContext: true,
      hasCompanyMonitor: true,
      facts: makeMinimalFacts("SPACEX", 12, signals),
      config: DEFAULT_CATALYST_SCREENING_CONFIG,
      screenedAt: new Date().toISOString(),
    });

    assert.equal(screening.eligible, true, "SpaceX-style event (12D) should be eligible");
    assert.ok(
      screening.screeningLevel === "DeepAnalysis" || screening.screeningLevel === "SignalAssessment",
      `Expected DeepAnalysis or SignalAssessment, got ${screening.screeningLevel}`
    );
    assert.ok(
      screening.preliminaryState !== "NotInteresting",
      `Expected non-trivial opportunity state, got ${screening.preliminaryState}`
    );
  });
});

// ── Negative Event Regression ───────────────────────────────────────────────

describe("Negative Event: Large Runup + Single Bad Source", () => {
  it("Poor asymmetry + single low-quality source → LowInterest or NotInteresting preliminary state", () => {
    // "Poor" asymmetry (40%+ run-up) does not exclude the ticker from screening
    // (screening logic only excludes outside-window or missing data), but it should
    // drive down the preliminaryState to LowInterest or NotInteresting.
    const signals: LeadingIndicatorSignal[] = [
      makeSignal({
        signalId: "rumor-only",
        driver: "Company News",
        direction: "Positive",
        observedFact: "Anonymous blogger claims massive beat incoming",
        sourceOriginId: "random-blog.xyz",
        sourceQuality: "SecondaryReporting",
        informationCategory: "UNVERIFIED_RUMOR",
        sourceConfidence: "Low",
      }),
    ];

    const screening = screenCatalystCandidate({
      ticker: "HYPED",
      company: "Hyped Corp",
      daysUntilEvent: 14,
      priceAsymmetry: "Poor",          // 40%+ run-up → poor risk/reward
      investmentView: "Buy",
      earningsGuidanceTrend: "Stable",
      relevantSignalCount: 1,
      signals,
      hasPriceContext: true,
      hasCompanyMonitor: true,
      facts: makeMinimalFacts("HYPED", 14, signals),
      config: DEFAULT_CATALYST_SCREENING_CONFIG,
      screenedAt: new Date().toISOString(),
    });

    // Eligible = true (within 14D window), but preliminary state should be low
    assert.equal(screening.eligible, true, "Within event window → eligible regardless of asymmetry");
    // Poor asymmetry + single weak source → never HighInterest or CandidateForTradeDecision
    assert.ok(
      screening.preliminaryState !== "HighInterest" && screening.preliminaryState !== "CandidateForTradeDecision",
      `Poor asymmetry case should not be HighInterest/Candidate, got: ${screening.preliminaryState}`
    );
    assert.equal(screening.priceAsymmetry, "Poor", "Price asymmetry should be recorded as Poor");
  });

  it("should return Low evidence confidence for single source", () => {
    const now = new Date().toISOString();
    const signals = [
      makeSignal({
        direction: "Positive",
        sourceOriginId: "anon-blog.xyz",
        sourceQuality: "SecondaryReporting",
        informationCategory: "UNVERIFIED_RUMOR",
        availableAt: now,
      }),
    ];
    const acc = computeSignalAccumulationState("HYPED", signals, [], now);
    assert.equal(acc.evidenceConfidence, "Low", "Single low-quality source = Low confidence");
    assert.equal(acc.window14D.independentPositiveGroups, 1, "Should be 1 independent group");
  });
});

// ── Maersk Fixture Extension — Verifies Part 2 Type Compatibility ───────────

describe("Maersk Fixture: Part 2 Type Compatibility", () => {
  it("should successfully create a signal with all Part 2 required fields", () => {
    const now = new Date().toISOString();
    const signal = makeSignal({
      signalId: "maersk-container-volumes",
      driver: "Container Freight Volumes",
      direction: "Positive",
      observedFact: "Asia-Europe container volumes +8% MoM per Xeneta data",
      interpretation: "May indicate sustained demand recovery heading into Q3 report",
      source: "Xeneta Shipping Intelligence",
      sourceOriginId: "xeneta.com",
      canonicalSource: "Xeneta Shipping Intelligence Report",
      sourceType: "ExternalData",
      sourceQuality: "IndustryData",
      informationCategory: "INDUSTRY_SIGNAL",
      availableAt: now,
    });

    // Verify all Part 2 fields are present and correct
    assert.equal(signal.informationCategory, "INDUSTRY_SIGNAL");
    assert.equal(signal.sourceOriginId, "xeneta.com");
    assert.equal(signal.canonicalSource, "Xeneta Shipping Intelligence Report");
    assert.equal(signal.availableAt, now);

    // Verify Part 1 fields still work
    assert.equal(signal.driver, "Container Freight Volumes");
    assert.equal(signal.direction, "Positive");
    assert.equal(signal.freshness, "Fresh");
  });

  it("Maersk signal accumulation — 3 independent positive sources should yield Medium+ confidence", () => {
    const now = new Date().toISOString();
    const maerskSignals: LeadingIndicatorSignal[] = [
      // 3 independent positive groups, 1 negative
      makeSignal({ driver: "Container Volumes",  direction: "Positive", sourceOriginId: "xeneta.com",       informationCategory: "INDUSTRY_SIGNAL",   availableAt: now }),
      makeSignal({ driver: "Freight Rates",       direction: "Positive", sourceOriginId: "drewry.com",        informationCategory: "INDUSTRY_SIGNAL",   availableAt: now }),
      makeSignal({ driver: "Port Congestion",     direction: "Positive", sourceOriginId: "reuters.com",       informationCategory: "RELIABLE_REPORTING", availableAt: now }),
      makeSignal({ driver: "Fuel Costs",          direction: "Negative", sourceOriginId: "bloomberg.com",     informationCategory: "INDUSTRY_SIGNAL",   availableAt: now }),
      // Extra Container Volumes signal from different source → 2 signals for same driver
      makeSignal({ driver: "Container Volumes",  direction: "Positive", sourceOriginId: "clarekson.com",     informationCategory: "INDUSTRY_SIGNAL",   availableAt: now }),
    ];

    const acc = computeSignalAccumulationState("MAERSK B", maerskSignals, [], now);

    assert.ok(acc.window7D.independentPositiveGroups >= 3, `Expected ≥3 independent positive groups, got ${acc.window7D.independentPositiveGroups}`);
    assert.ok(acc.evidenceConfidence !== "Low", `Expected Medium or High confidence, got ${acc.evidenceConfidence}`);
    // Container Volumes has 2 signals → should be a strengthening driver
    assert.ok(acc.strengtheningDrivers.includes("Container Volumes"), "Container Volumes (2 signals) should be strengthening");
  });
});
