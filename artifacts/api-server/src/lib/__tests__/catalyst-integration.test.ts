/**
 * Catalyst Integration Tests (spec correction §8, tests A–G)
 *
 * Tests the complete downstream flow:
 *   Catalyst → Opportunity Finder → Trade Decision Engine
 *
 * All pino-free. No OpenAI calls.
 *
 * A. Catalyst → OF: promotion stored, OF context contains ticker, OF dependency satisfied
 * B. OF → TDE:   TDE receives compact Catalyst context for promoted ticker
 * C. No fake TDE wake: non-material catalyst change does not affect catalyst-promotions materialVersion
 * D. After-market event: not marked post-event at 12:00 UTC; marked after 22:00 UTC threshold
 * E. Unknown event time: conservative next-day fallback, NOT marked at 00:00 UTC on event day
 * F. Post-event failure: postEventAssessmentRequired stays true, pre-event thesis not actionable
 * G. Post-event success: flag clears, old promotion expired, new promotion only if qualifies
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Pino-free imports only ────────────────────────────────────────────────────
import {
  promoteToOpportunityFinder,
  buildPromotionsContextBlock,
  buildCatalystTdeContext,
  getActivePromotions,
  getPromotionForTicker,
  expirePromotion,
} from "../catalyst-promotion.js";
import {
  markPostEventCandidates,
  runPostEventReassessment,
  type CatalystAnalyzeStrategy,
} from "../catalyst-pipeline.js";
import {
  getCatalystState, saveCatalystState,
} from "../catalyst-repository.js";
import { analysisRepository } from "../analysis-repository.js";
import type { CatalystState, CatalystFacts, CatalystAnalysisResult } from "../catalyst-types.js";
import { setMarketUniverseProvider, SeedMarketUniverseProvider } from "../market-universe-provider.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW_ISO = "2026-08-14T12:00:00Z";
const NOW_MS  = new Date(NOW_ISO).getTime();

function makeFacts(ticker: string, eventDate: string | null, marketTiming = "Unknown"): CatalystFacts {
  return {
    ticker, company: `${ticker} Corp`,
    event: eventDate ? {
      ticker, company: `${ticker} Corp`,
      eventType: "Earnings",
      eventDate,
      daysUntilEvent: Math.round((new Date(eventDate).getTime() - NOW_MS) / 86_400_000),
      marketTiming,  // This is the field used by computeEventThresholdMs
      reportingPeriod: "Q2",
      source: "CompanyMonitor",
      sourceConfidence: "High",
      classification: "Unknown",
    } as unknown as CatalystFacts["event"] : null,
    signals: [],
    price: { priceAsymmetryFacts: { asymmetry: "Attractive" } } as unknown as CatalystFacts["price"],
    company: {} as CatalystFacts["company"],
    risks: [],
    dataQuality: {} as CatalystFacts["dataQuality"],
    sector: null as unknown as CatalystFacts["sector"],
  };
}

function makeAnalysis(opportunityState = "HighInterest"): CatalystAnalysisResult {
  return {
    opportunityState: opportunityState as CatalystAnalysisResult["opportunityState"],
    catalystDirection: "POSITIVE",
    thesis: `Strong pre-event setup — ${opportunityState}`,
    alreadyPricedIn: "LOW",
    expectationGap: "MODERATE",
    evidenceConfidence: "HIGH",
    priceAsymmetry: "Attractive",
    triggerType: "EARNINGS",
    riskFactors: ["Execution risk"],
    invalidationConditions: ["Miss by >5%"],
    supportingSignalIds: ["s1"],
    contradictingSignalIds: [],
    recommendedNextStep: "SendToOpportunityFinder",
    analysisUpdateType: "FULL_ANALYSIS",
  };
}

function makeState(ticker: string, overrides: Partial<CatalystState> = {}): CatalystState {
  return {
    ticker,
    company: `${ticker} Corp`,
    screening: null, facts: null, analysis: null,
    lastAnalysisFingerprint: null,
    lastScreenedAt: null, lastAnalysedAt: null,
    eventPassed: false,
    updatedAt: NOW_ISO,
    discoverySource: null, triggerType: null,
    signalAccumulation: null, emergingSetup: null,
    promotedAt: null, lastAnalysisUpdateType: null,
    failureCount: 0, lastError: null, retryEligibleAt: null,
    postEventAssessmentRequired: false,
    ...overrides,
  } as CatalystState;
}

/** Successful mock strategy that stores analysis + promotion. */
function successStrategy(
  opportunityState = "HighInterest",
  shouldPromote = true
): CatalystAnalyzeStrategy {
  return async (ticker, opts) => {
    const nowIso = opts.nowIso ?? new Date().toISOString();
    const existingState = getCatalystState(ticker);
    const facts = makeFacts(ticker, null);
    const analysis = makeAnalysis(opportunityState);

    const updated: CatalystState = {
      ...makeState(ticker),
      ...existingState,
      facts,
      analysis,
      lastAnalysedAt: nowIso,
      postEventAssessmentRequired: false,
      updatedAt: nowIso,
    };
    saveCatalystState(ticker, updated);

    if (shouldPromote) {
      promoteToOpportunityFinder(ticker, `${ticker} Corp`, analysis, facts);
    }

    return {
      error: null,
      promoted: shouldPromote,
      aiCalled: true,
      driverProfileGenerated: false,
      researchRan: false,
      analysisUpdateType: "FULL_ANALYSIS",
      opportunityState,
      state: updated,
    };
  };
}

/** Failing mock strategy. */
const failStrategy: CatalystAnalyzeStrategy = async () => ({
  error: "Simulated reassessment failure",
  promoted: false, aiCalled: false,
  driverProfileGenerated: false, researchRan: false,
  analysisUpdateType: null, opportunityState: null,
});

// ── Test A: Catalyst → Opportunity Finder ─────────────────────────────────────

describe("A: Catalyst promotion feeds Opportunity Finder context", () => {
  const TICKER = "INT_A_TICKER";

  beforeEach(() => {
    setMarketUniverseProvider(new SeedMarketUniverseProvider([]));
    // Save pre-promotion state
    saveCatalystState(TICKER, makeState(TICKER));
  });

  test("buildPromotionsContextBlock() contains the promoted ticker", () => {
    const facts = makeFacts(TICKER, "2026-08-25");
    const analysis = makeAnalysis("HighInterest");
    promoteToOpportunityFinder(TICKER, `${TICKER} Corp`, analysis, facts);

    const block = buildPromotionsContextBlock();
    assert.ok(block.length > 0, "Block must be non-empty after promotion");
    assert.ok(
      block.includes(TICKER),
      `Block must contain ${TICKER}:\n${block}`
    );
  });

  test("context block header signals priority to OF", () => {
    const facts = makeFacts(TICKER, "2026-08-25");
    promoteToOpportunityFinder(TICKER, `${TICKER} Corp`, makeAnalysis(), facts);

    const block = buildPromotionsContextBlock();
    assert.ok(
      block.includes("CATALYST INTELLIGENCE PROMOTIONS"),
      "Block must have CATALYST INTELLIGENCE PROMOTIONS header"
    );
    assert.ok(
      block.includes("priority candidates"),
      "Block must describe these as priority candidates"
    );
  });

  test("promotion materialVersion increments when new promotion is saved", () => {
    const before = analysisRepository.get("catalyst-promotions")?.materialVersion ?? 0;

    const facts = makeFacts(TICKER, "2026-08-25");
    promoteToOpportunityFinder(TICKER, `${TICKER} Corp`, makeAnalysis(), facts);

    const after = analysisRepository.get("catalyst-promotions")?.materialVersion ?? 0;
    assert.ok(
      after > before,
      `materialVersion must increase after promotion: before=${before}, after=${after}`
    );
  });

  test("promotion is active and retrievable", () => {
    const facts = makeFacts(TICKER, "2026-08-25");
    promoteToOpportunityFinder(TICKER, `${TICKER} Corp`, makeAnalysis(), facts);

    const active = getActivePromotions();
    const found = active.find(p => p.ticker === TICKER.toUpperCase());
    assert.ok(found, `${TICKER} should appear in getActivePromotions()`);
    assert.equal(found!.opportunityState, "HighInterest");
    assert.ok(found!.thesis.length > 0, "Promotion must have a thesis");
  });

  test("a ticker NOT yet promoted does not appear in the context block", () => {
    // No promotion stored for this ticker
    const block = buildPromotionsContextBlock();
    // Either block is empty or doesn't contain this ticker
    if (block.length > 0) {
      assert.ok(
        !block.includes("INT_A_NOPROMOTE"),
        "Unpromoted ticker must not appear in context block"
      );
    }
  });
});

// ── Test B: OF context → Trade Decision Engine ───────────────────────────────

describe("B: Catalyst context reaches Trade Decision Engine", () => {
  const TICKER = "INT_B_TDE";

  beforeEach(() => {
    setMarketUniverseProvider(new SeedMarketUniverseProvider([]));
  });

  test("buildCatalystTdeContext() returns non-null for promoted ticker", () => {
    const facts = makeFacts(TICKER, "2026-08-22");
    promoteToOpportunityFinder(TICKER, `${TICKER} Corp`, makeAnalysis(), facts);

    const ctx = buildCatalystTdeContext(TICKER);
    assert.ok(ctx !== null, "TDE context must be non-null for promoted ticker");
  });

  test("TDE context contains required compact fields", () => {
    const facts = makeFacts(TICKER, "2026-08-22");
    const analysis = makeAnalysis("HighInterest");
    promoteToOpportunityFinder(TICKER, `${TICKER} Corp`, analysis, facts);

    const ctx = buildCatalystTdeContext(TICKER)!;

    assert.ok(ctx.includes("CATALYST INTELLIGENCE CONTEXT"), "Must have header");
    assert.ok(ctx.includes("POSITIVE"), "Must include catalystDirection");
    assert.ok(ctx.includes("HighInterest"), "Must include opportunityState");
    assert.ok(ctx.includes("INTENTIONAL_PRE_EVENT_THESIS"), "Must have non-actionable flag");
    assert.ok(ctx.includes("requires manual approval"), "Must require manual approval");
  });

  test("buildCatalystTdeContext() returns null for non-promoted ticker", () => {
    const ctx = buildCatalystTdeContext("INT_B_NO_PROMO");
    assert.equal(ctx, null, "Non-promoted ticker must return null from TDE context builder");
  });

  test("TDE context includes event details when event is available", () => {
    const facts = makeFacts(TICKER, "2026-08-22");
    promoteToOpportunityFinder(TICKER, `${TICKER} Corp`, makeAnalysis(), facts);

    const ctx = buildCatalystTdeContext(TICKER)!;
    assert.ok(ctx.includes("2026-08-22"), "Must include event date");
  });

  test("expired promotions do not generate TDE context", () => {
    const facts = makeFacts(TICKER, "2026-08-22");
    promoteToOpportunityFinder(TICKER, `${TICKER} Corp`, makeAnalysis(), facts);

    // Expire the promotion
    expirePromotion(TICKER);

    const ctx = buildCatalystTdeContext(TICKER);
    assert.equal(ctx, null, "Expired promotion must not generate TDE context");
  });
});

// ── Test C: Non-material change does not wake TDE/OF ─────────────────────────

describe("C: Non-material catalyst change does not affect promotions materialVersion", () => {
  const TICKER = "INT_C_NOMATERIAL";

  beforeEach(() => {
    setMarketUniverseProvider(new SeedMarketUniverseProvider([]));
    saveCatalystState(TICKER, makeState(TICKER));
  });

  test("saving catalyst state does not change catalyst-promotions materialVersion", () => {
    const before = analysisRepository.get("catalyst-promotions")?.materialVersion ?? 0;

    // Non-material change: update the state's lastScreenedAt without touching promotions
    const state = getCatalystState(TICKER);
    saveCatalystState(TICKER, {
      ...state!,
      lastScreenedAt: new Date(NOW_MS + 60_000).toISOString(),
    });

    const after = analysisRepository.get("catalyst-promotions")?.materialVersion ?? 0;
    assert.equal(
      after, before,
      `Non-material catalyst state change must not change catalyst-promotions materialVersion (${before} → ${after})`
    );
  });

  test("only promotion saves change the materialVersion", () => {
    // Multiple non-promotion saves — materialVersion stays
    const startVersion = analysisRepository.get("catalyst-promotions")?.materialVersion ?? 0;
    for (let i = 0; i < 5; i++) {
      const state = getCatalystState(TICKER);
      saveCatalystState(TICKER, { ...state!, updatedAt: new Date(NOW_MS + i * 1000).toISOString() });
    }
    const midVersion = analysisRepository.get("catalyst-promotions")?.materialVersion ?? 0;
    assert.equal(midVersion, startVersion, "5 non-promotion saves must not change materialVersion");

    // Now promote — materialVersion must change
    const facts = makeFacts(TICKER, "2026-09-01");
    promoteToOpportunityFinder(TICKER, `${TICKER} Corp`, makeAnalysis(), facts);
    const afterVersion = analysisRepository.get("catalyst-promotions")?.materialVersion ?? 0;
    assert.ok(afterVersion > midVersion, "Promotion must increase materialVersion");
  });
});

// ── Test D: After-market event timing ─────────────────────────────────────────

describe("D: After-market event — not marked before threshold, marked after", () => {
  const TICKER = "INT_D_AFTERMARKET";
  const EVENT_DATE = "2026-08-20";

  beforeEach(() => {
    setMarketUniverseProvider(new SeedMarketUniverseProvider([]));
  });

  function setupState(marketTiming: string) {
    const facts = makeFacts(TICKER, EVENT_DATE, marketTiming);
    saveCatalystState(TICKER, makeState(TICKER, {
      facts,
      analysis: makeAnalysis("Investigate"),
      lastAnalysedAt: new Date(NOW_MS - 24 * 3_600_000).toISOString(),
    }));
  }

  test("AfterMarket: NOT post-event at 12:00 UTC on event day (threshold is 22:00 UTC)", () => {
    setupState("AfterMarket");

    // Noon UTC on event day — before the 22:00 threshold
    const noonEventDay = "2026-08-20T12:00:00Z";
    const marked = markPostEventCandidates(noonEventDay);

    const state = getCatalystState(TICKER);
    assert.equal(
      state!.postEventAssessmentRequired, false,
      "AfterMarket event must NOT be marked as post-event at noon UTC"
    );
    assert.equal(marked, 0, "No tickers should be marked at noon UTC for AfterMarket event");
  });

  test("AfterMarket: IS post-event at 23:00 UTC on event day (after 22:00 threshold)", () => {
    setupState("AfterMarket");

    // 23:00 UTC on event day — past the 22:00 threshold
    const eveningEventDay = "2026-08-20T23:00:00Z";
    const marked = markPostEventCandidates(eveningEventDay);

    const state = getCatalystState(TICKER);
    assert.equal(
      state!.postEventAssessmentRequired, true,
      "AfterMarket event must be marked as post-event at 23:00 UTC (past 22:00 threshold)"
    );
    assert.equal(state!.eventPassed, true, "eventPassed must be set to true");
    assert.ok(marked >= 1, "At least 1 ticker should be marked");
  });

  test("BeforeMarket: NOT post-event at 08:00 UTC on event day (threshold is 14:30 UTC)", () => {
    setupState("BeforeMarket");

    const earlyEventDay = "2026-08-20T08:00:00Z";
    const marked = markPostEventCandidates(earlyEventDay);

    const state = getCatalystState(TICKER);
    assert.equal(
      state!.postEventAssessmentRequired, false,
      "BeforeMarket event must NOT be marked as post-event at 08:00 UTC"
    );
    assert.equal(marked, 0);
  });

  test("BeforeMarket: IS post-event at 15:00 UTC on event day (past 14:30 threshold)", () => {
    setupState("BeforeMarket");

    const afterOpenEventDay = "2026-08-20T15:00:00Z";
    const marked = markPostEventCandidates(afterOpenEventDay);

    const state = getCatalystState(TICKER);
    assert.equal(
      state!.postEventAssessmentRequired, true,
      "BeforeMarket event must be marked as post-event at 15:00 UTC (past 14:30 threshold)"
    );
    assert.ok(marked >= 1);
  });
});

// ── Test E: Unknown event timing — conservative fallback ─────────────────────

describe("E: Unknown event timing — conservative next-day fallback", () => {
  const TICKER = "INT_E_UNKNOWN_TIMING";
  const EVENT_DATE = "2026-08-20";

  beforeEach(() => {
    setMarketUniverseProvider(new SeedMarketUniverseProvider([]));
    const facts = makeFacts(TICKER, EVENT_DATE, "Unknown");
    saveCatalystState(TICKER, makeState(TICKER, {
      facts,
      analysis: makeAnalysis("Investigate"),
      lastAnalysedAt: new Date(NOW_MS - 24 * 3_600_000).toISOString(),
    }));
  });

  test("NOT marked at 00:00:00 UTC on the event day itself (midnight start)", () => {
    const midnightOnDay = "2026-08-20T00:00:00Z";
    markPostEventCandidates(midnightOnDay);

    const state = getCatalystState(TICKER);
    assert.equal(
      state!.postEventAssessmentRequired, false,
      "Unknown-timing event must NOT be marked at 00:00 UTC on event day"
    );
  });

  test("NOT marked at 23:59:59 UTC on the event day (still before next-day threshold)", () => {
    const beforeMidnight = "2026-08-20T23:59:59Z";
    markPostEventCandidates(beforeMidnight);

    const state = getCatalystState(TICKER);
    assert.equal(
      state!.postEventAssessmentRequired, false,
      "Unknown-timing event must NOT be marked before next-day 06:00 UTC threshold"
    );
  });

  test("IS marked at 07:00 UTC the next day (past next-day 06:00 threshold)", () => {
    const nextDay = "2026-08-21T07:00:00Z";
    const marked = markPostEventCandidates(nextDay);

    const state = getCatalystState(TICKER);
    assert.equal(
      state!.postEventAssessmentRequired, true,
      "Unknown-timing event must be marked at 07:00 UTC next day (past 06:00 threshold)"
    );
    assert.equal(state!.eventPassed, true);
    assert.ok(marked >= 1);
  });
});

// ── Test F: Post-event reassessment failure — flag must stay set ──────────────

describe("F: Post-event failure — postEventAssessmentRequired stays true", () => {
  const TICKER = "INT_F_FAIL";

  beforeEach(() => {
    setMarketUniverseProvider(new SeedMarketUniverseProvider([]));

    // Promote first, so there's an active pre-event promotion
    const facts = makeFacts(TICKER, "2026-08-10");
    promoteToOpportunityFinder(TICKER, `${TICKER} Corp`, makeAnalysis(), facts);

    // Set state: event passed, reassessment required
    saveCatalystState(TICKER, makeState(TICKER, {
      facts,
      analysis: makeAnalysis("HighInterest"),
      lastAnalysedAt: new Date(NOW_MS - 5 * 24 * 3_600_000).toISOString(),
      eventPassed: true,
      postEventAssessmentRequired: true,
    }));
  });

  test("failed reassessment keeps postEventAssessmentRequired = true", async () => {
    const result = await runPostEventReassessment(TICKER, NOW_ISO, failStrategy);

    assert.equal(result.ok, false, "Result must indicate failure");
    assert.ok(result.error?.includes("Simulated"), "Error message must be preserved");

    const state = getCatalystState(TICKER);
    assert.equal(
      state!.postEventAssessmentRequired, true,
      "postEventAssessmentRequired must stay true after failed reassessment"
    );
  });

  test("failed reassessment increments failure count for backoff", async () => {
    const before = getCatalystState(TICKER)?.failureCount ?? 0;
    await runPostEventReassessment(TICKER, NOW_ISO, failStrategy);
    const after = getCatalystState(TICKER)?.failureCount ?? 0;
    assert.ok(after > before, "Failure count must increment after failed reassessment");
  });

  test("failed reassessment does not restore old pre-event thesis as fresh", async () => {
    await runPostEventReassessment(TICKER, NOW_ISO, failStrategy);

    // The state must still show postEventAssessmentRequired = true
    const state = getCatalystState(TICKER);
    assert.equal(
      state!.postEventAssessmentRequired, true,
      "Old thesis must not be treated as fresh — flag must remain set"
    );
  });

  test("promotion is already expired before reassessment (expired by markPostEventCandidates)", () => {
    // markPostEventCandidates skips states where postEventAssessmentRequired is already true.
    // Reset the state to simulate FIRST detection (the event just passed, not yet flagged).
    const facts = makeFacts(TICKER, "2026-08-10"); // event was 4 days ago
    saveCatalystState(TICKER, makeState(TICKER, {
      facts,
      analysis: makeAnalysis("HighInterest"),
      lastAnalysedAt: new Date(NOW_MS - 5 * 24 * 3_600_000).toISOString(),
      eventPassed: false,               // not yet detected by pipeline
      postEventAssessmentRequired: false, // not yet flagged
    }));
    // At this point INT_F_FAIL has an active promotion (created in beforeEach)
    // and the state has eventPassed=false — markPostEventCandidates should:
    // 1. detect the past event (eventDate=2026-08-10, nowIso=2026-08-14T12:00 → past threshold)
    // 2. mark postEventAssessmentRequired=true
    // 3. call expirePromotion(TICKER)
    markPostEventCandidates(NOW_ISO);

    // The promotion should now be expired
    const promotion = getPromotionForTicker(TICKER);
    // getPromotionForTicker returns null for expired promotions
    assert.equal(promotion, null, "Pre-event promotion must be expired when markPostEventCandidates detects a past event");
  });
});

// ── Test G: Post-event success — flag clears, old promotion expired ───────────

describe("G: Post-event success — flag clears, old promotion behavior", () => {
  const TICKER_WITH_NEW = "INT_G_SUCCESS_WITH";
  const TICKER_WITHOUT  = "INT_G_SUCCESS_WITHOUT";

  beforeEach(() => {
    setMarketUniverseProvider(new SeedMarketUniverseProvider([]));

    for (const ticker of [TICKER_WITH_NEW, TICKER_WITHOUT]) {
      const facts = makeFacts(ticker, "2026-08-10");
      // Old promotion (pre-event — already expired when post-event was marked)
      promoteToOpportunityFinder(ticker, `${ticker} Corp`, makeAnalysis("HighInterest"), facts);
      expirePromotion(ticker); // simulate what markPostEventCandidates does

      saveCatalystState(ticker, makeState(ticker, {
        facts,
        analysis: makeAnalysis("HighInterest"),
        lastAnalysedAt: new Date(NOW_MS - 5 * 24 * 3_600_000).toISOString(),
        eventPassed: true,
        postEventAssessmentRequired: true,
      }));
    }
  });

  test("successful reassessment clears postEventAssessmentRequired", async () => {
    const result = await runPostEventReassessment(
      TICKER_WITH_NEW, NOW_ISO,
      successStrategy("Monitor", false) // post-event: less exciting, no promotion
    );

    assert.equal(result.ok, true, "Reassessment must succeed");

    const state = getCatalystState(TICKER_WITH_NEW);
    assert.equal(
      state!.postEventAssessmentRequired, false,
      "postEventAssessmentRequired must be false after successful reassessment"
    );
  });

  test("new promotion created only if new analysis qualifies", async () => {
    // Strategy that promotes (high interest even after event)
    const withPromoStrategy = successStrategy("HighInterest", true);
    await runPostEventReassessment(TICKER_WITH_NEW, NOW_ISO, withPromoStrategy);

    // New promotion should exist (old one was expired, new one created by strategy)
    const newPromo = getPromotionForTicker(TICKER_WITH_NEW);
    assert.ok(newPromo, "New promotion must be created if post-event analysis qualifies");
    assert.equal(newPromo!.opportunityState, "HighInterest");
  });

  test("no new promotion if post-event analysis does not qualify", async () => {
    // Strategy that does NOT promote (Monitor outcome after event)
    const withoutPromoStrategy = successStrategy("Monitor", false);
    await runPostEventReassessment(TICKER_WITHOUT, NOW_ISO, withoutPromoStrategy);

    const promo = getPromotionForTicker(TICKER_WITHOUT);
    assert.equal(promo, null, "No new promotion should be created if post-event analysis does not qualify");
  });

  test("old pre-event promotion is not used after successful reassessment", async () => {
    // The old promotion was already expired in beforeEach (simulating markPostEventCandidates)
    // After reassessment without re-promoting, the active promotions list must not contain stale data
    await runPostEventReassessment(
      TICKER_WITHOUT, NOW_ISO,
      successStrategy("Monitor", false)
    );

    const activePromos = getActivePromotions();
    const stalePromo = activePromos.find(p => p.ticker === TICKER_WITHOUT.toUpperCase());
    assert.equal(stalePromo, undefined, "Old pre-event promotion must not be in active promotions after reassessment");
  });

  test("successful reassessment does not increment failure count", async () => {
    const before = getCatalystState(TICKER_WITH_NEW)?.failureCount ?? 0;
    await runPostEventReassessment(
      TICKER_WITH_NEW, NOW_ISO,
      successStrategy("Monitor", false)
    );
    const after = getCatalystState(TICKER_WITH_NEW)?.failureCount ?? 0;
    assert.equal(after, before, "Failure count must not increment after successful reassessment");
  });
});
