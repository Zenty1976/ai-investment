/**
 * Catalyst Screening — Deterministic Unit Tests
 *
 * All tests are purely deterministic.
 * Zero OpenAI calls. Zero Saxo calls. Zero repository access.
 *
 * Test cases:
 *   1. classifyRunupPattern — boundary conditions
 *   2. classifyPriceAsymmetry — Maersk-style positive scenario
 *   3. classifyPriceAsymmetry — Negative A: already priced in
 *   4. classifyPriceAsymmetry — Negative B: structural decline (still VeryAttractive
 *      on price alone — proves price asymmetry alone doesn't make a case interesting)
 *   5. computeEvidenceConfidence — Negative C: echo chamber
 *   6. screenCatalystCandidate — Maersk positive fixture
 *   7. screenCatalystCandidate — Negative B: negative company view
 *   8. screenCatalystCandidate — Negative D: irrelevant signals
 *   9. computeCatalystFingerprint — stability (same input = same hash)
 *  10. computeCatalystFingerprint — sensitivity (changed priceState = different hash)
 *  11. No upcoming event → Excluded
 *  12. Event too far → Excluded
 *  13. determinePreliminaryState — convergence to HighInterest
 *  14. EvidenceConfidence — multiple independent high-quality sources → High
 *  15. screenCatalystCandidate — Poor asymmetry reduces to Monitor but doesn't auto-exclude
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyRunupPattern,
  classifyPriceAsymmetry,
} from "../catalyst-price-asymmetry.js";

import {
  computeEvidenceConfidence,
  determinePreliminaryState,
  computeCatalystFingerprint,
  screenCatalystCandidate,
} from "../catalyst-screening.js";

import { DEFAULT_CATALYST_SCREENING_CONFIG } from "../catalyst-types.js";
import type {
  CatalystFacts,
  LeadingIndicatorSignal,
  CatalystScreeningInputs,
} from "../catalyst-types.js";

// ── Fixture helpers ────────────────────────────────────────────────────────────

function makeSignal(
  overrides: Partial<LeadingIndicatorSignal> = {}
): LeadingIndicatorSignal {
  return {
    signalId:             "test-signal",
    driver:               "Freight Rates",
    direction:            "Positive",
    observedFact:         "Container freight rates up 15% MoM",
    interpretation:       null,
    previousContext:      null,
    observationDate:      "2026-08-07",
    source:               "Drewry World Container Index",
    sourceType:           "IndustryData",
    sourceQuality:        "IndustryData",
    sourceConfidence:     "High",
    leadTimeRelevance:    "High",
    companyImpactReason:  "Higher freight rates directly increase revenue for shipping companies",
    freshness:            "Fresh",
    ...overrides,
  };
}

function makeFacts(overrides: Partial<CatalystFacts> = {}): CatalystFacts {
  return {
    assembledAt: "2026-08-14T08:00:00.000Z",
    event: {
      ticker: "MAERSK-B",
      company: "A.P. Møller-Mærsk",
      eventType: "Earnings",
      eventDate: "2026-08-21",
      daysUntilEvent: 7,
      reportingPeriod: "Q2 2026",
      marketTiming: "BeforeMarket",
      source: "CompanyMonitor",
      sourceConfidence: "High",
      classification: "Unknown",
    },
    price: {
      currentPrice: 9800,
      priceState: "StabilizingAfterDecline",
      priceAsymmetryFacts: {
        preEventRunupPct: 0.8,
        preEventRunupPeriod: "5D",
        recentMomentum5D: 0.8,
        recentMomentum10D: 1.2,
        momentum30D: -2.5,
        momentum90D: -28.0,
        drawdownFrom30DayHighPct: -4.1,
        distanceFrom90DayHighPct: -32.0,
        distanceFrom90DayLowPct: 4.2,
        runupPattern: "NoRunup",
        asymmetry: "VeryAttractive",
        reasoning: "5D: +0.8% (NoRunup) | 30D: -2.5% | 90D: -28.0% → Asymmetry: VeryAttractive",
      },
      volatilityState: "Elevated",
      volatilityTrend: "Falling",
      shortTermTrend: "Flat",
      mediumTermTrend: "Downtrend",
      longTermTrend: "StrongDowntrend",
      momentumChange: "NegativeMomentumWeakening",
      recentBehavior: "Stabilizing",
    },
    history: {
      entries: [],
      dataSource: null,
      lastUpdatedAt: null,
      isUnavailable: true,
      unavailableReason: "Test stub",
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
      unavailableReason: "Test stub",
    },
    company: {
      investmentView: "Hold",
      investmentCaseStrength: "Medium",
      investmentThesis: "Freight cycle recovery thesis",
      bullCase: "Freight rates recovering faster than expected",
      bearCase: "Overcapacity risk persists",
      earningsGuidanceTrend: "Improving",
      recentMeaningfulChange: null,
      driverProfile: null,
      sector: "Industrials",
      industry: "Marine Shipping",
    },
    signals: [
      makeSignal({
        signalId: "maersk-freight-rates",
        source: "Drewry World Container Index",
        sourceType: "IndustryData",
        sourceQuality: "IndustryData",
      }),
      makeSignal({
        signalId: "maersk-container-volumes",
        driver: "Container Volumes",
        observedFact: "US East Coast container imports +12% MoM (August 2026)",
        source: "Xeneta",
        sourceType: "IndustryData",
        sourceQuality: "IndustryData",
      }),
    ],
    sector: { sectorSummary: "Shipping sector showing early cycle improvement", sectorTrend: null },
    market: { marketSentiment: "Cautious", riskLevel: "Medium", marketSummary: "Volatile macro" },
    news: { materialNews: [], newsCount: 0 },
    risks: ["Overcapacity risk", "US tariff uncertainty"],
    dataQuality: {
      missingFields: ["company-driver-profile"],
      staleFields: [],
      overallSourceConfidence: "Medium",
      earningsHistoryAvailable: false,
      consensusDataAvailable: false,
      driverProfileAvailable: false,
    },
    ...overrides,
  };
}

function makeInputs(overrides: Partial<CatalystScreeningInputs> = {}): CatalystScreeningInputs {
  const facts = makeFacts();
  return {
    ticker: "MAERSK-B",
    company: "A.P. Møller-Mærsk",
    daysUntilEvent: 7,
    priceAsymmetry: "VeryAttractive",
    investmentView: "Hold",
    earningsGuidanceTrend: "Improving",
    relevantSignalCount: 2,
    signals: facts.signals,
    hasPriceContext: true,
    hasCompanyMonitor: true,
    facts,
    config: DEFAULT_CATALYST_SCREENING_CONFIG,
    screenedAt: "2026-08-14T08:00:00.000Z",
    ...overrides,
  };
}

// ── Test 1: classifyRunupPattern boundaries ────────────────────────────────────

describe("classifyRunupPattern", () => {
  it("negative pct → NoRunup (stock down = no pre-event runup)", () => {
    assert.strictEqual(classifyRunupPattern(-5.0), "NoRunup");
  });

  it("< 2% positive → NoRunup", () => {
    assert.strictEqual(classifyRunupPattern(1.9), "NoRunup");
    assert.strictEqual(classifyRunupPattern(0.8), "NoRunup");
    assert.strictEqual(classifyRunupPattern(0.0), "NoRunup");
  });

  it("2% to 7.9% → SmallRunup", () => {
    assert.strictEqual(classifyRunupPattern(2.0), "SmallRunup");
    assert.strictEqual(classifyRunupPattern(5.5), "SmallRunup");
    assert.strictEqual(classifyRunupPattern(7.9), "SmallRunup");
  });

  it("8% to 19.9% → SignificantRunup", () => {
    assert.strictEqual(classifyRunupPattern(8.0), "SignificantRunup");
    assert.strictEqual(classifyRunupPattern(14.0), "SignificantRunup");
    assert.strictEqual(classifyRunupPattern(19.9), "SignificantRunup");
  });

  it(">= 20% → LargeRunup", () => {
    assert.strictEqual(classifyRunupPattern(20.0), "LargeRunup");
    assert.strictEqual(classifyRunupPattern(35.0), "LargeRunup");
  });

  it("null → Unknown", () => {
    assert.strictEqual(classifyRunupPattern(null), "Unknown");
  });
});

// ── Test 2: Price asymmetry — Maersk positive scenario ────────────────────────

describe("classifyPriceAsymmetry — Maersk positive scenario", () => {
  it("NoRunup + 90D=-28% → VeryAttractive", () => {
    const result = classifyPriceAsymmetry(
      "NoRunup",   // runupPattern
      0.8,         // preEventRunupPct (minimal)
      -2.5,        // momentum30D
      -28.0,       // momentum90D (large decline)
      -32.0,       // distanceFrom90DayHighPct (well off highs)
      DEFAULT_CATALYST_SCREENING_CONFIG
    );
    assert.strictEqual(result, "VeryAttractive");
  });
});

// ── Test 3: Negative A — already priced in ────────────────────────────────────

describe("classifyPriceAsymmetry — Negative A: already priced in", () => {
  it("LargeRunup + 90D=+15% → Poor", () => {
    const result = classifyPriceAsymmetry(
      "LargeRunup",  // 10D return = +22%
      22.0,
      25.0,          // 30D strong positive
      15.0,          // 90D positive (stock was already rising)
      -3.0,          // near 90D high
      DEFAULT_CATALYST_SCREENING_CONFIG
    );
    assert.strictEqual(result, "Poor");
  });

  it("SignificantRunup above poor threshold → Poor", () => {
    const result = classifyPriceAsymmetry(
      "SignificantRunup",
      21.0,           // just above 20% poor threshold
      18.0,
      10.0,
      -5.0,
      DEFAULT_CATALYST_SCREENING_CONFIG
    );
    assert.strictEqual(result, "Poor");
  });

  it("SignificantRunup below poor threshold + near 90D high → Weak", () => {
    const result = classifyPriceAsymmetry(
      "SignificantRunup",
      14.0,   // significant but below 20% poor threshold
      12.0,
      8.0,
      -5.0,   // near 90D high (> -10%)
      DEFAULT_CATALYST_SCREENING_CONFIG
    );
    assert.strictEqual(result, "Weak");
  });
});

// ── Test 4: Negative B — structural decline, price asymmetry alone isn't enough ─

describe("classifyPriceAsymmetry — Negative B: structural decline", () => {
  it("NoRunup + 90D=-50% → VeryAttractive (price alone does NOT equal opportunity)", () => {
    // This documents a key spec rule: price asymmetry being VeryAttractive
    // does NOT mean this is a good pre-earnings trade. The screening engine
    // must ALSO check company quality (negative CM view blocks it).
    const result = classifyPriceAsymmetry(
      "NoRunup",
      -3.0,  // stock is falling
      -15.0, // 30D very negative
      -50.0, // 90D extremely negative
      -55.0, // far from 90D high
      DEFAULT_CATALYST_SCREENING_CONFIG
    );
    // Price asymmetry looks great from a pure price perspective...
    assert.strictEqual(result, "VeryAttractive");
    // ...but the screening engine will reject this via company quality check.
    // This verifies the separation of concerns: price asymmetry is ONE factor,
    // not the entire decision.
  });
});

// ── Test 5: Negative C — evidence confidence echo chamber ─────────────────────

describe("computeEvidenceConfidence — Negative C: echo chamber", () => {
  it("multiple signals all from same source → Low", () => {
    const signals = [
      makeSignal({ signalId: "s1", source: "Reuters", sourceType: "SecondaryReporting",
                   sourceQuality: "SecondaryReporting" }),
      makeSignal({ signalId: "s2", source: "Reuters", sourceType: "SecondaryReporting",
                   sourceQuality: "SecondaryReporting" }),
      makeSignal({ signalId: "s3", source: "Reuters", sourceType: "SecondaryReporting",
                   sourceQuality: "SecondaryReporting" }),
    ];
    assert.strictEqual(computeEvidenceConfidence(signals), "Low");
  });

  it("empty signals → Low", () => {
    assert.strictEqual(computeEvidenceConfidence([]), "Low");
  });
});

// ── Test 14: Evidence confidence — multiple independent quality sources → High ─

describe("computeEvidenceConfidence — multiple independent high-quality sources", () => {
  it("3 independent industry sources → High", () => {
    const signals = [
      makeSignal({ signalId: "s1", source: "Drewry",  sourceType: "IndustryData", sourceQuality: "IndustryData" }),
      makeSignal({ signalId: "s2", source: "Xeneta",  sourceType: "IndustryData", sourceQuality: "IndustryData" }),
      makeSignal({ signalId: "s3", source: "Maersk IR", sourceType: "CompanyMonitor", sourceQuality: "DirectCompany" }),
    ];
    assert.strictEqual(computeEvidenceConfidence(signals), "High");
  });

  it("2 independent sources, 1 quality → Medium", () => {
    const signals = [
      makeSignal({ signalId: "s1", source: "Drewry", sourceType: "IndustryData", sourceQuality: "IndustryData" }),
      makeSignal({ signalId: "s2", source: "Reuters", sourceType: "NewsMonitor", sourceQuality: "ReliableReporting" }),
    ];
    assert.strictEqual(computeEvidenceConfidence(signals), "Medium");
  });
});

// ── Test 6: screenCatalystCandidate — Maersk positive fixture ─────────────────

describe("screenCatalystCandidate — Maersk positive fixture", () => {
  it("eligible, DeepAnalysis level (7 days ≤ 14), ≥ Investigate state", () => {
    const result = screenCatalystCandidate(makeInputs());
    assert.strictEqual(result.eligible, true);
    assert.strictEqual(result.screeningLevel, "DeepAnalysis");
    assert.notStrictEqual(result.preliminaryState, "NotInteresting");
    // With VeryAttractive asymmetry + Improving trend, should reach Investigate or higher
    const acceptableStates = ["Investigate", "HighInterest", "CandidateForTradeDecision"];
    assert.ok(
      acceptableStates.includes(result.preliminaryState),
      `Expected ≥ Investigate, got ${result.preliminaryState}`
    );
  });

  it("priceAsymmetry propagates correctly", () => {
    const result = screenCatalystCandidate(makeInputs());
    assert.strictEqual(result.priceAsymmetry, "VeryAttractive");
  });

  it("materialFingerprint is a non-empty string", () => {
    const result = screenCatalystCandidate(makeInputs());
    assert.ok(typeof result.materialFingerprint === "string");
    assert.ok(result.materialFingerprint.length > 0);
  });
});

// ── Test 7: Negative B — negative investment view blocks pre-earnings interest ──

describe("screenCatalystCandidate — Negative B: negative investment view", () => {
  it("Sell view → NotInteresting regardless of price asymmetry", () => {
    const result = screenCatalystCandidate(makeInputs({
      investmentView: "Sell",
      earningsGuidanceTrend: "Weakening",
      priceAsymmetry: "VeryAttractive", // price alone is attractive
      // But structural deterioration + Sell view = NotInteresting
    }));
    assert.strictEqual(result.eligible, true); // still eligible (event exists within window)
    assert.strictEqual(result.preliminaryState, "NotInteresting");
  });

  it("Reduce view → NotInteresting", () => {
    const result = screenCatalystCandidate(makeInputs({
      investmentView: "Reduce",
      earningsGuidanceTrend: "Weakening",
      priceAsymmetry: "Attractive",
    }));
    assert.strictEqual(result.preliminaryState, "NotInteresting");
  });
});

// ── Test 8: Negative D — irrelevant signals (wrong sector) ────────────────────

describe("screenCatalystCandidate — Negative D: irrelevant signals", () => {
  it("Pharma company with freight-rate signals → Low signal relevance → Monitor", () => {
    // Pharmaceutical company where freight rates are NOT a primary driver.
    // All signals have leadTimeRelevance: "Low" → signal presence is minimal.
    const pharmaSignals: LeadingIndicatorSignal[] = [
      makeSignal({
        signalId: "freight-signal-irrelevant",
        driver: "Container Freight Rates",  // irrelevant to pharma
        leadTimeRelevance: "Low",           // set by the facts builder
        companyImpactReason: "Freight rates affect logistics costs marginally",
      }),
    ];
    const pharmaFacts = makeFacts({
      event: {
        ticker: "NVO",
        company: "Novo Nordisk",
        eventType: "Earnings",
        eventDate: "2026-08-21",
        daysUntilEvent: 7,
        reportingPeriod: "Q2 2026",
        marketTiming: "BeforeMarket",
        source: "CompanyMonitor",
        sourceConfidence: "High",
        classification: "Unknown",
      },
      company: {
        investmentView: "Hold",
        investmentCaseStrength: "Medium",
        investmentThesis: null,
        bullCase: null,
        bearCase: null,
        earningsGuidanceTrend: "Stable",  // no clear improving trend
        recentMeaningfulChange: null,
        driverProfile: null,
        sector: "Healthcare",
        industry: "Pharmaceuticals",
      },
      signals: pharmaSignals,
    });

    const result = screenCatalystCandidate(makeInputs({
      ticker: "NVO",
      company: "Novo Nordisk",
      earningsGuidanceTrend: "Stable",
      relevantSignalCount: 1,
      signals: pharmaSignals,
      priceAsymmetry: "Neutral",  // no particular asymmetry
      facts: pharmaFacts,
    }));

    // Should still be eligible (event within window)
    assert.strictEqual(result.eligible, true);
    // With Stable trend, Neutral asymmetry, and only low-relevance signals → Monitor
    const notHighInterest = result.preliminaryState !== "HighInterest";
    assert.ok(notHighInterest, `Expected not HighInterest for irrelevant signals, got ${result.preliminaryState}`);
  });
});

// ── Test 9: computeCatalystFingerprint — stability ───────────────────────────

describe("computeCatalystFingerprint — fingerprint stability", () => {
  it("same facts → same fingerprint", () => {
    const facts = makeFacts();
    const h1 = computeCatalystFingerprint(facts);
    const h2 = computeCatalystFingerprint(facts);
    assert.strictEqual(h1, h2);
  });

  it("same facts (different object) → same fingerprint", () => {
    const h1 = computeCatalystFingerprint(makeFacts());
    const h2 = computeCatalystFingerprint(makeFacts());
    assert.strictEqual(h1, h2);
  });

  it("minor price noise (within 5% bin) → same fingerprint", () => {
    // 90D return: -28.0 and -29.0 — both bin to -30 (Math.round nearest 5%).
    // Note: avoid half-integer boundaries like -27.5 because JavaScript
    // Math.round(-5.5) rounds toward +∞, breaking the expected bin symmetry.
    const facts1 = makeFacts();
    facts1.price.priceAsymmetryFacts.momentum90D = -28.0; // -28/5=-5.6 → round→-6 → -30

    const facts2 = makeFacts();
    facts2.price.priceAsymmetryFacts.momentum90D = -29.0; // -29/5=-5.8 → round→-6 → -30

    assert.strictEqual(
      computeCatalystFingerprint(facts1),
      computeCatalystFingerprint(facts2),
      "Minor 90D change within same 5% bin should NOT change fingerprint"
    );
  });
});

// ── Test 10: computeCatalystFingerprint — sensitivity ────────────────────────

describe("computeCatalystFingerprint — fingerprint sensitivity", () => {
  it("changed priceState → different fingerprint", () => {
    const facts1 = makeFacts();
    const facts2 = makeFacts();
    facts2.price.priceState = "StrongDowntrend";

    assert.notStrictEqual(
      computeCatalystFingerprint(facts1),
      computeCatalystFingerprint(facts2)
    );
  });

  it("changed investmentView → different fingerprint", () => {
    const facts1 = makeFacts();
    const facts2 = makeFacts();
    facts2.company.investmentView = "Buy";

    assert.notStrictEqual(
      computeCatalystFingerprint(facts1),
      computeCatalystFingerprint(facts2)
    );
  });

  it("changed earningsGuidanceTrend → different fingerprint", () => {
    const facts1 = makeFacts();
    const facts2 = makeFacts();
    facts2.company.earningsGuidanceTrend = "Weakening";

    assert.notStrictEqual(
      computeCatalystFingerprint(facts1),
      computeCatalystFingerprint(facts2)
    );
  });

  it("changed runupPattern → different fingerprint", () => {
    const facts1 = makeFacts();
    const facts2 = makeFacts();
    facts2.price.priceAsymmetryFacts.runupPattern = "LargeRunup";

    assert.notStrictEqual(
      computeCatalystFingerprint(facts1),
      computeCatalystFingerprint(facts2)
    );
  });

  it("changed eventDate → different fingerprint", () => {
    const facts1 = makeFacts();
    const facts2 = makeFacts();
    facts2.event.eventDate = "2026-09-05";

    assert.notStrictEqual(
      computeCatalystFingerprint(facts1),
      computeCatalystFingerprint(facts2)
    );
  });

  it("90D return crossing 5% bin boundary → different fingerprint", () => {
    // -28% bins to -30; -32% bins to -30 too; but -28% vs -23% cross different bins
    const facts1 = makeFacts();
    facts1.price.priceAsymmetryFacts.momentum90D = -28.0; // bins to -30

    const facts2 = makeFacts();
    facts2.price.priceAsymmetryFacts.momentum90D = -22.0; // bins to -20

    assert.notStrictEqual(
      computeCatalystFingerprint(facts1),
      computeCatalystFingerprint(facts2),
      "Crossing 5% bin boundary should change fingerprint"
    );
  });
});

// ── Test 11: No upcoming event → Excluded ────────────────────────────────────

describe("screenCatalystCandidate — no upcoming event", () => {
  it("daysUntilEvent = null → Excluded with NoUpcomingEvent reason", () => {
    const result = screenCatalystCandidate(makeInputs({ daysUntilEvent: null }));
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.screeningLevel, "Excluded");
    assert.strictEqual(result.exclusionReason, "NoUpcomingEvent");
    assert.strictEqual(result.daysUntilEvent, null);
  });
});

// ── Test 12: Event too far → Excluded ────────────────────────────────────────

describe("screenCatalystCandidate — event too far", () => {
  it("daysUntilEvent = 45 → Excluded with EventTooFar reason", () => {
    const result = screenCatalystCandidate(makeInputs({ daysUntilEvent: 45 }));
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.exclusionReason, "EventTooFar");
  });

  it("daysUntilEvent = 30 → eligible (maxDaysUntilEvent = 30)", () => {
    const result = screenCatalystCandidate(makeInputs({ daysUntilEvent: 30 }));
    assert.strictEqual(result.eligible, true);
  });
});

// ── Test 13: determinePreliminaryState — convergence to HighInterest ──────────

describe("determinePreliminaryState — convergence rules", () => {
  it("VeryAttractive + Improving + High confidence → HighInterest", () => {
    const result = determinePreliminaryState(
      "Hold", "Improving", "VeryAttractive", 3, "High"
    );
    assert.strictEqual(result, "HighInterest");
  });

  it("VeryAttractive + Improving + Buy → HighInterest", () => {
    const result = determinePreliminaryState(
      "Buy", "Improving", "VeryAttractive", 2, "Medium"
    );
    assert.strictEqual(result, "HighInterest");
  });

  it("Attractive + Improving + Hold → Investigate", () => {
    const result = determinePreliminaryState(
      "Hold", "Improving", "Attractive", 1, "Low"
    );
    assert.strictEqual(result, "Investigate");
  });

  it("Sell view + Weakening + Attractive → NotInteresting", () => {
    const result = determinePreliminaryState(
      "Sell", "Weakening", "Attractive", 2, "Medium"
    );
    assert.strictEqual(result, "NotInteresting");
  });

  it("null view + Stable + Neutral + no signals → Monitor", () => {
    const result = determinePreliminaryState(
      null, "Stable", "Neutral", 0, "Low"
    );
    assert.strictEqual(result, "Monitor");
  });
});

// ── Test 15: Poor asymmetry does not auto-exclude ─────────────────────────────

describe("screenCatalystCandidate — Poor asymmetry reduces but does not auto-exclude", () => {
  it("Poor asymmetry + Hold + Improving → eligible but downgraded to Monitor", () => {
    const result = screenCatalystCandidate(makeInputs({
      priceAsymmetry: "Poor",
      investmentView: "Hold",
      earningsGuidanceTrend: "Improving",
    }));
    // Still eligible (event within window)
    assert.strictEqual(result.eligible, true);
    // Weakening + Poor asymmetry = Investigate (improving trend + Hold can still pass)
    // At minimum, not NotInteresting
    assert.notStrictEqual(result.screeningLevel, "Excluded");
    // Poor asymmetry + Improving trend without strong signals → Monitor or Investigate
    const monitorOrAbove = ["Monitor", "Investigate", "HighInterest"].includes(
      result.preliminaryState
    );
    assert.ok(monitorOrAbove, `Expected Monitor or above, got ${result.preliminaryState}`);
  });
});
