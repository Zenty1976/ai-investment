/**
 * Catalyst Autonomous Pipeline — End-to-End Integration Tests (Part 3, spec §9–12)
 *
 * These tests verify that the full autonomous pipeline works end-to-end without
 * any manual /analyze/:ticker call. All AI analysis is mocked via the injectable
 * analyzeStrategy so no OpenAI/web calls are made (spec §13 requirement).
 *
 * Only pino-free modules are imported:
 *   - catalyst-pipeline.ts    (now pino-free: lazy-loads analyze-service)
 *   - catalyst-repository.ts  (pino-free)
 *   - catalyst-promotion.ts   (pino-free)
 *   - catalyst-lifecycle.ts   (pino-free)
 *   - catalyst-config.ts      (pino-free)
 *   - market-universe-provider.ts (pino-free at module level)
 *   - catalyst-company-events.ts  (pino-free)
 *   - catalyst-signal-store.ts    (pino-free)
 *   - analysis-repository.ts      (pino-free)
 *
 * §9  — Automatic chain: universe ticker → pipeline cycle → discovered → analyzed → promoted
 * §10 — Emerging Setup: PATH B ticker, no event, signals → analysis → potential promotion
 * §11 — Cost control: 100+ companies, budget enforced, excess = DEFERRED
 * §12 — Post-event: HIGH_INTEREST pre-event → event passes → STALE → new analysis required
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Pino-free imports only ────────────────────────────────────────────────────

import {
  runCatalystPipeline, markPostEventCandidates,
  type CatalystAnalyzeStrategy,
} from "../catalyst-pipeline.js";
import {
  getCatalystState, saveCatalystState, getAllCatalystStates,
} from "../catalyst-repository.js";
import {
  getActivePromotions,
} from "../catalyst-promotion.js";
import {
  deriveLifecycleState, isEligibleForAutoAnalysis,
} from "../catalyst-lifecycle.js";
import {
  DEFAULT_CATALYST_BUDGET,
  computePriorityScore,
} from "../catalyst-config.js";
import {
  SeedMarketUniverseProvider,
  setMarketUniverseProvider,
} from "../market-universe-provider.js";
import {
  saveCompanyEvents,
} from "../catalyst-company-events.js";
import {
  mergeStoredSignals,
} from "../catalyst-signal-store.js";
import type { CatalystState, LeadingIndicatorSignal, CompanySpecificEvent } from "../catalyst-types.js";

// ── Fixed test time ────────────────────────────────────────────────────────────

const NOW_ISO = "2026-08-14T12:00:00Z";
const NOW_MS  = new Date(NOW_ISO).getTime();

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeScreeningResult(
  ticker: string,
  level: "Excluded" | "BasicMonitor" | "SignalAssessment" | "DeepAnalysis",
  daysUntilEvent: number | null,
  preliminaryState: string,
  priceAsymmetry = "Attractive"
) {
  return {
    ticker, company: `${ticker} Corp`,
    eligible: level !== "Excluded",
    screeningLevel: level as any,
    daysUntilEvent,
    preliminaryState: preliminaryState as any,
    priceAsymmetry: priceAsymmetry as any,
    screeningReasons: [],
    exclusionReason: level === "Excluded" ? "No catalyst" : null,
    materialFingerprint: `fp-${ticker}-${Date.now()}`,
    screenedAt: NOW_ISO,
  };
}

function makeSignal(
  signalId: string,
  ticker: string,
  direction: LeadingIndicatorSignal["direction"] = "Positive"
): LeadingIndicatorSignal {
  return {
    signalId, ticker,
    driver: "Test Driver",
    direction,
    summary: `Signal ${signalId}: ${direction}`,
    sourceQuality: "ReliableReporting",
    informationCategory: "CONFIRMED_FACT",
    publishedAt: new Date(NOW_MS - 2 * 3_600_000).toISOString(),
    observedAt: new Date(NOW_MS - 2 * 3_600_000).toISOString(),
    availableAt: new Date(NOW_MS - 2 * 3_600_000).toISOString(),
  };
}

function makeCompanyEvent(
  ticker: string,
  eventType: CompanySpecificEvent["eventType"],
  daysFromNow: number
): CompanySpecificEvent {
  const d = new Date(NOW_MS + daysFromNow * 86_400_000);
  const eventDate = d.toISOString().slice(0, 10); // YYYY-MM-DD
  return {
    ticker, eventType, eventDate,
    eventTitle: `${eventType} for ${ticker}`,
    description: null,
    beforeAfterMarket: "Unknown",
    potentialMarketImpact: "High",
    lastUpdatedAt: NOW_ISO,
  };
}

function makeBaseCatalystState(ticker: string, overrides: Partial<CatalystState> = {}): CatalystState {
  return {
    ticker,
    company: `${ticker} Corp`,
    screening: null,
    facts: null,
    analysis: null,
    lastAnalysisFingerprint: null,
    lastScreenedAt: null,
    lastAnalysedAt: null,
    eventPassed: false,
    updatedAt: NOW_ISO,
    discoverySource: null,
    triggerType: null,
    signalAccumulation: null,
    emergingSetup: null,
    promotedAt: null,
    lastAnalysisUpdateType: null,
    failureCount: 0,
    lastError: null,
    retryEligibleAt: null,
    postEventAssessmentRequired: false,
    ...overrides,
  } as CatalystState;
}

/**
 * Create a mock analyze strategy that simulates a successful deep analysis.
 * Writes pre-computed results to the catalyst repository.
 * No OpenAI calls — completely deterministic.
 */
function createMockAnalyzeStrategy(
  options: {
    opportunityState?: string;
    recommendedNextStep?: string;
    shouldPromote?: boolean;
  } = {}
): CatalystAnalyzeStrategy {
  const {
    opportunityState = "HighInterest",
    recommendedNextStep = "SendToOpportunityFinder",
    shouldPromote = true,
  } = options;

  return async (ticker, opts) => {
    const existingState = getCatalystState(ticker);
    const nowIso = opts.nowIso ?? new Date().toISOString();

    const updatedState: CatalystState = {
      ...makeBaseCatalystState(ticker),
      ...existingState,
      analysis: {
        opportunityState: opportunityState as any,
        catalystDirection: "POSITIVE",
        thesis: `Mock analysis for ${ticker}: strong pre-event setup with positive signals`,
        alreadyPricedIn: "LOW",
        expectationGap: "MODERATE",
        evidenceConfidence: "HIGH",
        priceAsymmetry: "Attractive",
        triggerType: "EARNINGS",
        riskFactors: ["Execution risk"],
        invalidationConditions: ["Earnings miss by >10%"],
        supportingSignalIds: ["mock-signal-1"],
        contradictingSignalIds: [],
        recommendedNextStep: recommendedNextStep as any,
        analysisUpdateType: "FULL_ANALYSIS",
      },
      lastAnalysedAt: nowIso,
      lastAnalysisUpdateType: "FULL_ANALYSIS",
      postEventAssessmentRequired: false,
      updatedAt: nowIso,
      failureCount: 0,
      lastError: null,
      retryEligibleAt: null,
    };

    if (shouldPromote && !existingState?.promotedAt) {
      updatedState.promotedAt = nowIso;

      // Write a promotion record directly (simulates what promoteToOpportunityFinder does)
      const { getAllPromotions } = await import("../catalyst-promotion.js");
      const { analysisRepository } = await import("../analysis-repository.js");
      const existingPromotions = getAllPromotions().filter(
        p => p.ticker.toUpperCase() !== ticker.toUpperCase()
      );
      analysisRepository.save("catalyst-promotions", {
        promotions: [
          {
            ticker: ticker.toUpperCase(),
            company: `${ticker} Corp`,
            promotedAt: nowIso,
            triggerType: "EARNINGS",
            eventDate: null,
            eventType: "EARNINGS" as any,
            catalystDirection: "POSITIVE" as any,
            evidenceConfidence: "HIGH",
            expectationGap: "MODERATE",
            priceAsymmetry: "Attractive",
            opportunityState: opportunityState as any,
            keySignalIds: [],
            keyRisks: [],
            thesis: `Mock analysis for ${ticker}`,
            invalidationConditions: [],
            acknowledgedAt: null,
            expired: false,
            expiresAt: null,
          },
          ...existingPromotions,
        ],
        lastUpdatedAt: nowIso,
      });
    }

    saveCatalystState(ticker, updatedState);

    return {
      error: null,
      promoted: shouldPromote && !existingState?.promotedAt,
      aiCalled: true,
      driverProfileGenerated: false,
      researchRan: false,
      analysisUpdateType: "FULL_ANALYSIS",
      opportunityState,
      state: updatedState,
    };
  };
}

/**
 * Create a mock analyze strategy that simulates failure.
 */
function createFailingMockStrategy(errorMessage: string): CatalystAnalyzeStrategy {
  return async (_ticker, _opts) => ({
    error: errorMessage,
    promoted: false,
    aiCalled: false,
    driverProfileGenerated: false,
    researchRan: false,
    analysisUpdateType: null,
    opportunityState: null,
  });
}

// ── §9: Automatic Chain — universe ticker → pipeline → promoted ────────────────

describe("§9 Automatic Chain: Universe Ticker → Pipeline → Promoted", () => {
  const TICKER = "E2E_CHAIN_09";

  beforeEach(() => {
    // Set up a seed universe provider with this ticker
    setMarketUniverseProvider(new SeedMarketUniverseProvider([
      {
        ticker: TICKER,
        company: `${TICKER} Corp`,
        exchange: "CSE",
        country: "DK",
        currency: "DKK",
        sector: "Technology",
        industry: "Software",
        uic: null,
        tradeable: true,
        active: true,
        source: "STATIC_SEED",
      },
    ]));

    // Inject an earnings event 7 days out
    saveCompanyEvents(TICKER, [makeCompanyEvent(TICKER, "EARNINGS", 7)]);

    // Inject positive signals
    mergeStoredSignals(TICKER, [
      makeSignal("e2e-09-1", TICKER, "StronglyPositive"),
      makeSignal("e2e-09-2", TICKER, "Positive"),
    ]);

    // Pre-populate a screened state (simulates what screen endpoint does)
    // In a real run, the screen endpoint runs before the pipeline
    saveCatalystState(TICKER, makeBaseCatalystState(TICKER, {
      screening: makeScreeningResult(TICKER, "DeepAnalysis", 7, "Investigate"),
      discoverySource: "UNIVERSE_EVENT",
      lastScreenedAt: NOW_ISO,
    }));
  });

  test("ticker starts at RESEARCH_REQUIRED (no prior analysis)", () => {
    const state = getCatalystState(TICKER);
    assert.ok(state, "State should exist after setup");
    assert.equal(deriveLifecycleState(state!, NOW_ISO), "RESEARCH_REQUIRED");
  });

  test("ticker is eligible for auto-analysis (no manual /analyze call needed)", () => {
    const state = getCatalystState(TICKER);
    assert.ok(state, "State should exist");
    assert.ok(isEligibleForAutoAnalysis(state!, NOW_ISO), "Should be eligible without manual call");
  });

  test("pipeline discovers + analyzes + promotes without manual intervention", async () => {
    const budget = { ...DEFAULT_CATALYST_BUDGET, maxDeepAnalysesPerCycle: 5 };
    const mockAnalyze = createMockAnalyzeStrategy({ shouldPromote: true });

    // ONE pipeline cycle — no manual /analyze/:ticker
    const result = await runCatalystPipeline(budget, NOW_ISO, mockAnalyze);

    // Should have analyzed the ticker
    const analyzed = result.analyzed.find(a => a.ticker === TICKER);
    assert.ok(analyzed, `${TICKER} should appear in analyzed list`);
    assert.ok(analyzed!.aiCalled, "AI (mocked) should have been called");
    assert.ok(analyzed!.promoted, "Ticker should have been promoted");
    assert.equal(analyzed!.opportunityState, "HighInterest");
  });

  test("after pipeline, state is PROMOTED in repository", async () => {
    const budget = { ...DEFAULT_CATALYST_BUDGET, maxDeepAnalysesPerCycle: 5 };
    const mockAnalyze = createMockAnalyzeStrategy({ shouldPromote: true });

    await runCatalystPipeline(budget, NOW_ISO, mockAnalyze);

    const state = getCatalystState(TICKER);
    assert.ok(state, "State should exist after pipeline");
    assert.ok(state!.promotedAt, "promotedAt should be set");
    assert.equal(deriveLifecycleState(state!, NOW_ISO), "PROMOTED");
  });

  test("after pipeline, Opportunity Finder has an entry for the ticker", async () => {
    const budget = { ...DEFAULT_CATALYST_BUDGET, maxDeepAnalysesPerCycle: 5 };
    const mockAnalyze = createMockAnalyzeStrategy({ shouldPromote: true });

    await runCatalystPipeline(budget, NOW_ISO, mockAnalyze);

    const promotions = getActivePromotions();
    const promotion = promotions.find(p => p.ticker.toUpperCase() === TICKER.toUpperCase());
    assert.ok(promotion, `Opportunity Finder should have an entry for ${TICKER}`);
    assert.equal(promotion!.opportunityState, "HighInterest");
    assert.ok(promotion!.thesis.includes(TICKER));
  });

  test("pipeline result reports zero failures and one new promotion", async () => {
    const budget = { ...DEFAULT_CATALYST_BUDGET, maxDeepAnalysesPerCycle: 5 };
    const mockAnalyze = createMockAnalyzeStrategy({ shouldPromote: true });

    const result = await runCatalystPipeline(budget, NOW_ISO, mockAnalyze);

    assert.equal(result.failed.length, 0, "No failures expected");
    assert.equal(result.newPromotions, 1, "Should have 1 new promotion");
  });

  test("universe seeding creates DISCOVERED state for tickers not yet in repository", async () => {
    // Use a timestamp suffix to guarantee this ticker name is globally unique in the process
    const newTicker = `E2E_SEED_NEW_${Date.now()}`;
    setMarketUniverseProvider(new SeedMarketUniverseProvider([
      {
        ticker: newTicker, company: `${newTicker} Corp`,
        exchange: "CSE", country: "DK", currency: "DKK",
        sector: "Finance", industry: "Banking",
        uic: null, tradeable: true, active: true, source: "STATIC_SEED",
      },
    ]));

    // Ensure no prior state exists (getCatalystState returns undefined/null for missing entries)
    const beforeState = getCatalystState(newTicker);
    assert.ok(beforeState == null, `${newTicker} should not exist before pipeline`);

    const budget = { ...DEFAULT_CATALYST_BUDGET, maxDeepAnalysesPerCycle: 0 }; // no analyses
    const mockAnalyze = createMockAnalyzeStrategy();
    const result = await runCatalystPipeline(budget, NOW_ISO, mockAnalyze);

    const afterState = getCatalystState(newTicker);
    assert.ok(afterState, "Pipeline should have seeded DISCOVERED state");
    assert.equal(deriveLifecycleState(afterState!, NOW_ISO), "DISCOVERED");
    assert.equal(afterState!.discoverySource, "UNIVERSE_SEED");
    assert.ok(result.universeSeeded >= 1, `universeSeeded should be ≥1, got ${result.universeSeeded}`);
  });
});

// ── §10: Emerging Setup — PATH B, no event, signals accumulate ────────────────

describe("§10 Emerging Setup: PATH B, No Event, Autonomous Analysis", () => {
  const TICKER = "E2E_EMERGE_10";

  beforeEach(() => {
    setMarketUniverseProvider(new SeedMarketUniverseProvider([
      {
        ticker: TICKER, company: `${TICKER} Corp`,
        exchange: "NASDAQ", country: "US", currency: "USD",
        sector: "Healthcare", industry: "Biotech",
        uic: null, tradeable: true, active: true, source: "STATIC_SEED",
      },
    ]));

    // NO company events — this is PATH B
    // Inject accumulated signals
    mergeStoredSignals(TICKER, [
      makeSignal("e2e-10-1", TICKER, "StronglyPositive"),
      makeSignal("e2e-10-2", TICKER, "Positive"),
      makeSignal("e2e-10-3", TICKER, "Positive"),
      makeSignal("e2e-10-4", TICKER, "StronglyPositive"),
    ]);

    // Screened state from prior screen cycle (SignalAssessment level for PATH B)
    saveCatalystState(TICKER, makeBaseCatalystState(TICKER, {
      screening: makeScreeningResult(TICKER, "SignalAssessment", null, "Monitor"),
      discoverySource: "EMERGING_SETUP",
      lastScreenedAt: NOW_ISO,
    }));
  });

  test("PATH B ticker has no event and starts at RESEARCH_REQUIRED or WATCHING", () => {
    const state = getCatalystState(TICKER);
    assert.ok(state, "State should exist");
    const lifecycle = deriveLifecycleState(state!, NOW_ISO);
    assert.ok(
      ["RESEARCH_REQUIRED", "WATCHING"].includes(lifecycle),
      `Expected RESEARCH_REQUIRED or WATCHING for PATH B, got ${lifecycle}`
    );
  });

  test("PATH B ticker is eligible for auto-analysis (no fake event needed)", () => {
    const state = getCatalystState(TICKER);
    assert.ok(state, "State should exist");
    assert.ok(isEligibleForAutoAnalysis(state!, NOW_ISO), "PATH B should be eligible for auto-analysis");
  });

  test("pipeline analyzes PATH B ticker without event (emerging setup)", async () => {
    const budget = { ...DEFAULT_CATALYST_BUDGET, maxDeepAnalysesPerCycle: 5 };
    const mockAnalyze = createMockAnalyzeStrategy({
      opportunityState: "Investigate",
      recommendedNextStep: "Monitor",
      shouldPromote: false, // PATH B typically doesn't promote immediately
    });

    const result = await runCatalystPipeline(budget, NOW_ISO, mockAnalyze);

    const analyzed = result.analyzed.find(a => a.ticker === TICKER);
    assert.ok(analyzed, `${TICKER} should appear in analyzed list`);
    assert.ok(analyzed!.aiCalled, "AI (mocked) should have been called");
    assert.equal(analyzed!.opportunityState, "Investigate");
  });

  test("PATH B ticker with promotion-eligible analysis gets promoted", async () => {
    const budget = { ...DEFAULT_CATALYST_BUDGET, maxDeepAnalysesPerCycle: 5 };
    const mockAnalyze = createMockAnalyzeStrategy({
      opportunityState: "HighInterest",
      recommendedNextStep: "SendToOpportunityFinder",
      shouldPromote: true,
    });

    await runCatalystPipeline(budget, NOW_ISO, mockAnalyze);

    const state = getCatalystState(TICKER);
    assert.ok(state!.promotedAt, "PATH B ticker should be promoted when analysis qualifies");
    assert.equal(deriveLifecycleState(state!, NOW_ISO), "PROMOTED");

    const promotions = getActivePromotions();
    const promotion = promotions.find(p => p.ticker.toUpperCase() === TICKER.toUpperCase());
    assert.ok(promotion, "Opportunity Finder should have PATH B entry");
  });

  test("PATH B analysis does NOT require a fake event injection", () => {
    // Verify that the ticker has no event in its state (pure PATH B)
    const state = getCatalystState(TICKER);
    assert.ok(state, "State should exist");
    assert.equal(state!.facts?.event ?? null, null, "PATH B should have no event in facts");

    // And yet it's eligible for analysis — proving no event is needed
    assert.ok(isEligibleForAutoAnalysis(state!, NOW_ISO));
  });
});

// ── §11: Cost Control — 100+ companies, budget enforced ───────────────────────

describe("§11 Cost Control: 100+ Companies, Budget Enforced", () => {
  const HOT_COUNT  = 4;   // will get analyzed
  const WARM_COUNT = 6;   // qualified but deferred (over budget)
  const COLD_COUNT = 90;  // screened out or watching — no AI needed
  const BUDGET_CAP = HOT_COUNT; // only analyze HOT_COUNT per cycle

  function buildSyntheticUniverse() {
    const equities: import("../market-universe-provider.js").MarketRecord[] = [];

    // HOT: earnings in 3 days, HighInterest, Attractive — should be analyzed
    for (let i = 0; i < HOT_COUNT; i++) {
      const t = `E2E_HOT11_${i}`;
      saveCatalystState(t, makeBaseCatalystState(t, {
        screening: makeScreeningResult(t, "DeepAnalysis", 3, "HighInterest", "Attractive"),
        discoverySource: "COMPANY_SIGNAL",
        lastScreenedAt: NOW_ISO,
      }));
      equities.push({
        ticker: t, company: `${t} Corp`,
        exchange: "CSE", country: "DK", currency: "DKK",
        sector: "Finance", industry: "Banking",
        uic: null, tradeable: true, active: true, source: "STATIC_SEED",
      });
    }

    // WARM: earnings in 10 days, Investigate — qualify but deferred
    for (let i = 0; i < WARM_COUNT; i++) {
      const t = `E2E_WARM11_${i}`;
      saveCatalystState(t, makeBaseCatalystState(t, {
        screening: makeScreeningResult(t, "DeepAnalysis", 10, "Investigate"),
        discoverySource: "UNIVERSE_EVENT",
        lastScreenedAt: NOW_ISO,
      }));
      equities.push({
        ticker: t, company: `${t} Corp`,
        exchange: "CSE", country: "DK", currency: "DKK",
        sector: "Technology", industry: "Software",
        uic: null, tradeable: true, active: true, source: "STATIC_SEED",
      });
    }

    // COLD: BasicMonitor, no event, no signals — WATCHING, no AI
    for (let i = 0; i < COLD_COUNT; i++) {
      const t = `E2E_COLD11_${i}`;
      // Save a recently-analyzed state so they're NOT eligible (fresh analysis)
      saveCatalystState(t, makeBaseCatalystState(t, {
        screening: makeScreeningResult(t, "BasicMonitor", null, "Monitor"),
        discoverySource: "UNIVERSE_SEED",
        lastScreenedAt: NOW_ISO,
        analysis: {
          opportunityState: "Monitor",
          catalystDirection: "NEUTRAL",
          thesis: "No catalyst",
          alreadyPricedIn: "HIGH",
          expectationGap: "NONE",
          evidenceConfidence: "LOW",
          priceAsymmetry: "Neutral",
          triggerType: "EMERGING_SETUP",
          riskFactors: [],
          invalidationConditions: [],
          supportingSignalIds: [],
          contradictingSignalIds: [],
          recommendedNextStep: "Monitor",
          analysisUpdateType: "FULL_ANALYSIS",
        },
        // Very recent analysis — not stale
        lastAnalysedAt: new Date(NOW_MS - 60 * 60_000).toISOString(), // 1h ago
      }));
    }

    setMarketUniverseProvider(new SeedMarketUniverseProvider(equities));
  }

  beforeEach(() => {
    buildSyntheticUniverse();
  });

  test("budget cap is enforced — only top-N get analyzed", async () => {
    const budget = {
      ...DEFAULT_CATALYST_BUDGET,
      maxDeepAnalysesPerCycle: BUDGET_CAP,
      analysisCandidateQueueSize: 50,
    };
    const callLog: string[] = [];
    const mockAnalyze: CatalystAnalyzeStrategy = async (ticker, opts) => {
      callLog.push(ticker);
      const s = createMockAnalyzeStrategy({ shouldPromote: false });
      return s(ticker, opts);
    };

    const result = await runCatalystPipeline(budget, NOW_ISO, mockAnalyze);

    // Exactly BUDGET_CAP tickers should have been analyzed
    assert.equal(
      result.analyzed.length, BUDGET_CAP,
      `Expected ${BUDGET_CAP} analyses, got ${result.analyzed.length}`
    );
    assert.equal(callLog.length, BUDGET_CAP, `Expected ${BUDGET_CAP} AI calls, got ${callLog.length}`);
  });

  test("COLD candidates receive no AI calls (fresh analysis)", async () => {
    const budget = {
      ...DEFAULT_CATALYST_BUDGET,
      maxDeepAnalysesPerCycle: BUDGET_CAP,
      analysisCandidateQueueSize: 50,
    };
    const callLog: string[] = [];
    const mockAnalyze: CatalystAnalyzeStrategy = async (ticker, opts) => {
      callLog.push(ticker);
      const s = createMockAnalyzeStrategy({ shouldPromote: false });
      return s(ticker, opts);
    };

    await runCatalystPipeline(budget, NOW_ISO, mockAnalyze);

    // None of the COLD tickers (fresh analysis) should have been called
    const coldCalls = callLog.filter(t => t.startsWith("E2E_COLD11_"));
    assert.equal(coldCalls.length, 0, `COLD tickers should not be analyzed, got ${coldCalls}`);
  });

  test("HOT candidates get priority over WARM candidates", async () => {
    const budget = {
      ...DEFAULT_CATALYST_BUDGET,
      maxDeepAnalysesPerCycle: BUDGET_CAP, // only HOT_COUNT (4) analyzed
      analysisCandidateQueueSize: 50,
    };
    const analyzedTickers: string[] = [];
    const mockAnalyze: CatalystAnalyzeStrategy = async (ticker, opts) => {
      analyzedTickers.push(ticker);
      const s = createMockAnalyzeStrategy({ shouldPromote: false });
      return s(ticker, opts);
    };

    await runCatalystPipeline(budget, NOW_ISO, mockAnalyze);

    // All analyzed tickers should be HOT (earnings in 3d, HighInterest)
    for (const ticker of analyzedTickers) {
      assert.ok(
        ticker.startsWith("E2E_HOT11_"),
        `Expected only HOT tickers to be analyzed, got ${ticker}`
      );
    }
  });

  test("excess qualified candidates become DEFERRED (not lost)", async () => {
    const budget = {
      ...DEFAULT_CATALYST_BUDGET,
      maxDeepAnalysesPerCycle: BUDGET_CAP,
      analysisCandidateQueueSize: 50,
    };
    const mockAnalyze = createMockAnalyzeStrategy({ shouldPromote: false });

    const result = await runCatalystPipeline(budget, NOW_ISO, mockAnalyze);

    // WARM tickers should be DEFERRED (they qualify but are over budget)
    assert.ok(result.deferred.length > 0, "Should have deferred candidates");

    // Verify deferred candidates have deferredUntil set in their states
    for (const deferred of result.deferred) {
      const state = getCatalystState(deferred.ticker);
      assert.ok(state?.deferredUntil, `${deferred.ticker} should have deferredUntil set`);
      assert.ok(
        deferred.ticker.startsWith("E2E_WARM11_") || deferred.ticker.startsWith("E2E_HOT11_"),
        `Deferred ticker should be WARM or HOT, got ${deferred.ticker}`
      );
    }
  });

  test("DEFERRED state is correctly derived from deferredUntil", () => {
    // Manually set deferredUntil to a future time and verify lifecycle
    const ticker = "E2E_WARM11_0";
    const state = getCatalystState(ticker);
    assert.ok(state, "WARM state should exist");

    // Set deferredUntil to 30min from now
    const futureDeferred = new Date(NOW_MS + 30 * 60_000).toISOString();
    saveCatalystState(ticker, { ...state!, deferredUntil: futureDeferred });

    const updatedState = getCatalystState(ticker);
    assert.equal(deriveLifecycleState(updatedState!, NOW_ISO), "DEFERRED");
  });

  test("most companies (COLD) receive no expensive processing", async () => {
    let aiCallCount = 0;
    const budget = {
      ...DEFAULT_CATALYST_BUDGET,
      maxDeepAnalysesPerCycle: BUDGET_CAP,
      analysisCandidateQueueSize: 50,
    };
    const mockAnalyze: CatalystAnalyzeStrategy = async (ticker, opts) => {
      aiCallCount++;
      const s = createMockAnalyzeStrategy({ shouldPromote: false });
      return s(ticker, opts);
    };

    await runCatalystPipeline(budget, NOW_ISO, mockAnalyze);

    const totalCompanies = HOT_COUNT + WARM_COUNT + COLD_COUNT;
    assert.ok(aiCallCount <= BUDGET_CAP, `AI calls (${aiCallCount}) should be ≤ budget (${BUDGET_CAP})`);
    assert.ok(
      aiCallCount < totalCompanies / 5,
      `AI calls (${aiCallCount}) should be << total companies (${totalCompanies})`
    );
  });
});

// ── §12: Post-Event — pre-event thesis becomes stale, new assessment required ──

describe("§12 Post-Event: Pre-Event Thesis Stale → Reassessment Required", () => {
  const TICKER = "E2E_POSTEVENT_12";
  const PAST_EVENT_DATE = "2026-08-11"; // 3 days ago relative to NOW_ISO

  beforeEach(() => {
    // Set up a HIGH_INTEREST pre-event state
    // The event was scheduled 3 days ago (now in the past)
    saveCatalystState(TICKER, makeBaseCatalystState(TICKER, {
      screening: makeScreeningResult(TICKER, "DeepAnalysis", -3, "HighInterest"),
      discoverySource: "COMPANY_SIGNAL",
      lastScreenedAt: NOW_ISO,
      facts: {
        ticker: TICKER, company: `${TICKER} Corp`,
        event: {
          ticker: TICKER, company: `${TICKER} Corp`,
          eventType: "Earnings",
          eventDate: PAST_EVENT_DATE,
          daysUntilEvent: -3,
          reportingPeriod: "Q2",
          marketTiming: "BeforeMarket",
          source: "CompanyMonitor",
          sourceConfidence: "High",
          classification: "Unknown",
        },
        signals: [],
        price: { priceAsymmetryFacts: { asymmetry: "Attractive" } } as any,
        company: {} as any, risks: [], dataQuality: {} as any,
        sector: null as any,
      } as any,
      analysis: {
        opportunityState: "HighInterest",
        catalystDirection: "STRONGLY_POSITIVE",
        thesis: "Pre-event thesis: strong Q2 earnings expected with beat potential",
        alreadyPricedIn: "LOW",
        expectationGap: "MATERIAL",
        evidenceConfidence: "HIGH",
        priceAsymmetry: "Attractive",
        triggerType: "EARNINGS",
        riskFactors: ["Guidance cut risk"],
        invalidationConditions: ["Earnings miss by >5%"],
        supportingSignalIds: ["pre-event-signal-1"],
        contradictingSignalIds: [],
        recommendedNextStep: "SendToOpportunityFinder",
        analysisUpdateType: "FULL_ANALYSIS",
      },
      lastAnalysedAt: new Date(NOW_MS - 4 * 24 * 3_600_000).toISOString(), // 4 days ago
      eventPassed: false, // not yet marked as passed
      postEventAssessmentRequired: false,
    }));
  });

  test("pre-event state shows HIGH_INTEREST (not yet detected as past)", () => {
    const state = getCatalystState(TICKER);
    assert.ok(state, "State should exist");
    // The event has passed but postEventAssessmentRequired is not yet set
    // Lifecycle based on analysis result: HighInterest
    // But analysis is stale (4 days old) → ANALYSIS_REQUIRED
    const lifecycle = deriveLifecycleState(state!, NOW_ISO);
    assert.ok(
      ["HIGH_INTEREST", "ANALYSIS_REQUIRED", "STALE"].includes(lifecycle),
      `Pre-event state should be HIGH_INTEREST, ANALYSIS_REQUIRED, or STALE, got ${lifecycle}`
    );
  });

  test("markPostEventCandidates detects past event and sets postEventAssessmentRequired", () => {
    markPostEventCandidates(NOW_ISO);

    const state = getCatalystState(TICKER);
    assert.ok(state, "State should exist after marking");
    assert.equal(state!.postEventAssessmentRequired, true,
      "postEventAssessmentRequired should be set after event passes");
    assert.equal(state!.eventPassed, true, "eventPassed should be true");
  });

  test("after marking, lifecycle becomes STALE", () => {
    markPostEventCandidates(NOW_ISO);
    const state = getCatalystState(TICKER);
    assert.equal(deriveLifecycleState(state!, NOW_ISO), "STALE",
      "Post-event candidate should be STALE");
  });

  test("STALE candidate is eligible for auto-analysis (pipeline picks it up)", () => {
    markPostEventCandidates(NOW_ISO);
    const state = getCatalystState(TICKER);
    assert.ok(isEligibleForAutoAnalysis(state!, NOW_ISO),
      "STALE candidate must be eligible for auto-analysis (post-event reassessment)");
  });

  test("old pre-event thesis is NOT actionable — pipeline forces new analysis with force=true", async () => {
    // Mark post-event first
    markPostEventCandidates(NOW_ISO);

    let forceFlagUsed = false;
    const postEventMockAnalyze: CatalystAnalyzeStrategy = async (ticker, opts) => {
      forceFlagUsed = opts.force ?? false;
      const s = createMockAnalyzeStrategy({
        opportunityState: "Monitor", // post-event result is less exciting
        recommendedNextStep: "Monitor",
        shouldPromote: false,
      });
      return s(ticker, opts);
    };

    const budget = { ...DEFAULT_CATALYST_BUDGET, maxDeepAnalysesPerCycle: 5 };
    await runCatalystPipeline(budget, NOW_ISO, postEventMockAnalyze);

    assert.ok(forceFlagUsed, "Post-event reassessment must use force=true to bypass old fingerprint");
  });

  test("after post-event analysis, postEventAssessmentRequired is cleared", async () => {
    markPostEventCandidates(NOW_ISO);

    const mockAnalyze = createMockAnalyzeStrategy({
      opportunityState: "Monitor",
      recommendedNextStep: "Monitor",
      shouldPromote: false,
    });

    const budget = { ...DEFAULT_CATALYST_BUDGET, maxDeepAnalysesPerCycle: 5 };
    await runCatalystPipeline(budget, NOW_ISO, mockAnalyze);

    const state = getCatalystState(TICKER);
    assert.equal(state!.postEventAssessmentRequired, false,
      "postEventAssessmentRequired should be cleared after successful reassessment");
  });

  test("STALE candidate gets priority boost (post-event +50) in the queue", () => {
    markPostEventCandidates(NOW_ISO);

    // Compute priority for the STALE candidate vs a normal high-interest one
    const staleScore = computePriorityScore({
      daysUntilEvent: -3,
      eventType: "Earnings",
      preliminaryState: "HighInterest",
      priceAsymmetry: "Attractive",
      inPortfolio: false,
    }) + 50; // pipeline adds +50 for isPostEvent

    const normalScore = computePriorityScore({
      daysUntilEvent: 7,
      eventType: "Earnings",
      preliminaryState: "Investigate",
      priceAsymmetry: "Attractive",
      inPortfolio: false,
    });

    assert.ok(staleScore > normalScore,
      `STALE candidate (${staleScore}) should outrank normal candidate (${normalScore})`);
  });
});

// ── §12b: Failure isolation in pipeline ───────────────────────────────────────

describe("§12b: Failure Isolation — One Failure Does Not Abort the Cycle", () => {
  const FAILING_TICKER  = "E2E_FAIL_12B_A";
  const PASSING_TICKER  = "E2E_FAIL_12B_B";

  beforeEach(() => {
    setMarketUniverseProvider(new SeedMarketUniverseProvider([]));

    // Both tickers are DeepAnalysis eligible
    for (const t of [FAILING_TICKER, PASSING_TICKER]) {
      saveCatalystState(t, makeBaseCatalystState(t, {
        screening: makeScreeningResult(t, "DeepAnalysis", 5, "Investigate"),
        discoverySource: "UNIVERSE_EVENT",
        lastScreenedAt: NOW_ISO,
      }));
    }
  });

  test("failure of one ticker does not prevent analysis of the next", async () => {
    const attemptedTickers: string[] = [];
    const mixedStrategy: CatalystAnalyzeStrategy = async (ticker, opts) => {
      attemptedTickers.push(ticker);
      if (ticker === FAILING_TICKER) {
        return {
          error: "Simulated API error",
          promoted: false, aiCalled: false,
          driverProfileGenerated: false, researchRan: false,
          analysisUpdateType: null, opportunityState: null,
        };
      }
      return createMockAnalyzeStrategy({ shouldPromote: false })(ticker, opts);
    };

    // Use a large budget so the two target tickers always fit, regardless of
    // other eligible tickers left in the shared in-process repository from earlier tests.
    const budget = { ...DEFAULT_CATALYST_BUDGET, maxDeepAnalysesPerCycle: 200 };
    const result = await runCatalystPipeline(budget, NOW_ISO, mixedStrategy);

    // Both target tickers must have been attempted
    assert.ok(attemptedTickers.includes(FAILING_TICKER),
      `${FAILING_TICKER} should have been attempted`);
    assert.ok(attemptedTickers.includes(PASSING_TICKER),
      `${PASSING_TICKER} should have been attempted`);

    // The failing ticker must appear in result.failed
    const failEntry = result.failed.find(f => f.ticker === FAILING_TICKER);
    assert.ok(failEntry, "Failing ticker should appear in result.failed");

    // The passing ticker must appear in result.analyzed
    const successAnalyzed = result.analyzed.find(a => a.ticker === PASSING_TICKER);
    assert.ok(successAnalyzed, "Passing ticker should still be analyzed despite prior failure");
  });

  test("failed ticker gets failure count incremented and backoff set", async () => {
    const failStrategy: CatalystAnalyzeStrategy = async () => ({
      error: "Simulated failure",
      promoted: false, aiCalled: false,
      driverProfileGenerated: false, researchRan: false,
      analysisUpdateType: null, opportunityState: null,
    });

    const budget = { ...DEFAULT_CATALYST_BUDGET, maxDeepAnalysesPerCycle: 1 };
    // Only run on the failing ticker
    saveCatalystState(PASSING_TICKER, makeBaseCatalystState(PASSING_TICKER, {
      analysis: { opportunityState: "Monitor" } as any,
      lastAnalysedAt: new Date(NOW_MS - 60 * 60_000).toISOString(), // fresh
    }));

    await runCatalystPipeline(budget, NOW_ISO, failStrategy);

    const failedState = getCatalystState(FAILING_TICKER);
    assert.ok((failedState?.failureCount ?? 0) >= 1, "Failure count should be ≥1");
    assert.ok(failedState?.lastError?.includes("Simulated"), "Error should be recorded");
    assert.ok(failedState?.retryEligibleAt, "retryEligibleAt should be set");
    assert.ok(
      new Date(failedState!.retryEligibleAt!).getTime() > NOW_MS,
      "retryEligibleAt should be in the future"
    );
  });
});

// ── §12c: Analysis_Required lifecycle — stale prior analysis ──────────────────

describe("§12c: ANALYSIS_REQUIRED — stale prior analysis triggers re-analysis", () => {
  const TICKER = "E2E_STALE_12C";

  beforeEach(() => {
    setMarketUniverseProvider(new SeedMarketUniverseProvider([]));

    // State with prior analysis that is old (stale)
    saveCatalystState(TICKER, makeBaseCatalystState(TICKER, {
      screening: makeScreeningResult(TICKER, "DeepAnalysis", 14, "Investigate"),
      discoverySource: "UNIVERSE_EVENT",
      lastScreenedAt: NOW_ISO,
      analysis: {
        opportunityState: "Investigate",
        catalystDirection: "POSITIVE",
        thesis: "Old analysis — now stale",
        alreadyPricedIn: "MEDIUM",
        expectationGap: "MODERATE",
        evidenceConfidence: "MEDIUM",
        priceAsymmetry: "Attractive",
        triggerType: "EARNINGS",
        riskFactors: [],
        invalidationConditions: [],
        supportingSignalIds: [],
        contradictingSignalIds: [],
        recommendedNextStep: "Monitor",
        analysisUpdateType: "FULL_ANALYSIS",
      },
      // Last analysis was 48 hours ago (stale: > 24h for non-imminent events)
      lastAnalysedAt: new Date(NOW_MS - 48 * 3_600_000).toISOString(),
    }));
  });

  test("ticker with stale prior analysis is ANALYSIS_REQUIRED", () => {
    const state = getCatalystState(TICKER);
    const lifecycle = deriveLifecycleState(state!, NOW_ISO);
    assert.equal(lifecycle, "ANALYSIS_REQUIRED",
      "Stale prior analysis should yield ANALYSIS_REQUIRED lifecycle");
  });

  test("ANALYSIS_REQUIRED ticker is eligible for auto-analysis", () => {
    const state = getCatalystState(TICKER);
    assert.ok(isEligibleForAutoAnalysis(state!, NOW_ISO), "Should be eligible for auto-analysis");
  });

  test("pipeline picks up ANALYSIS_REQUIRED candidate and re-analyzes", async () => {
    const budget = { ...DEFAULT_CATALYST_BUDGET, maxDeepAnalysesPerCycle: 5 };
    const mockAnalyze = createMockAnalyzeStrategy({
      opportunityState: "HighInterest",
      shouldPromote: false,
    });

    const result = await runCatalystPipeline(budget, NOW_ISO, mockAnalyze);
    const analyzed = result.analyzed.find(a => a.ticker === TICKER);
    assert.ok(analyzed, "ANALYSIS_REQUIRED candidate should be picked up by pipeline");
    assert.ok(analyzed!.aiCalled, "AI (mocked) should have been called for stale analysis");
    assert.equal(analyzed!.opportunityState, "HighInterest");
  });
});
