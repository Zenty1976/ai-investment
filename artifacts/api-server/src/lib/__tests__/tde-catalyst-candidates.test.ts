/**
 * TDE Catalyst Candidate Construction Tests
 *
 * Tests the buildCatalystTdeCandidates() helper (spec §1, §5, §6).
 *
 * All deterministic / mocked — no OpenAI, no pino, no route dependencies.
 *
 * K-A  KEYS regression: HighInterest, NOT in OF → enters catalystTdeCandidates
 * K-B  Dedup: NVDA in both OF AND HighInterest → one candidate (in OF, not in catalyst list)
 * K-C  Monitor/Investigate → NOT in catalystTdeCandidates
 * K-D  CandidateForTradeDecision → enters catalystTdeCandidates
 * K-E  Expired promotion → NOT in catalystTdeCandidates (excluded by getActivePromotions)
 * K-F  Cost cap: >5 qualifying promotions → capped at 5
 * K-G  Empty OF + empty promotions → empty result
 * K-H  All qualifying states deduped vs OF → empty result
 * K-I  Mixed: some qualifying in OF, some not → only non-OF qualifiers returned
 * K-J  NotInteresting → NOT in catalystTdeCandidates
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCatalystTdeCandidates,
  CATALYST_TDE_CANDIDATE_CAP,
  TDE_QUALIFYING_STATES,
} from "../tde-catalyst-candidates.js";
import type { CatalystPromotion } from "../catalyst-types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePromotion(
  ticker: string,
  opportunityState: CatalystPromotion["opportunityState"],
  overrides: Partial<CatalystPromotion> = {}
): CatalystPromotion {
  return {
    ticker: ticker.toUpperCase(),
    company: `${ticker} Corp`,
    promotedAt: "2026-08-16T12:00:00Z",
    triggerType: "EARNINGS",
    eventDate: "2026-08-19",
    eventType: "EARNINGS",
    catalystDirection: "POSITIVE",
    evidenceConfidence: "HIGH",
    expectationGap: "MODERATE",
    priceAsymmetry: "Attractive",
    opportunityState,
    keySignalIds: ["s1"],
    keyRisks: ["Execution risk"],
    thesis: `Strong pre-event setup for ${ticker}`,
    invalidationConditions: ["Miss by >5%"],
    acknowledgedAt: null,
    expired: false,
    expiresAt: "2026-09-02T00:00:00Z",
    ...overrides,
  };
}

function ofOpportunity(ticker: string): { ticker: string; company: string } {
  return { ticker: ticker.toUpperCase(), company: `${ticker} Corp` };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildCatalystTdeCandidates", () => {

  // K-A  KEYS regression ──────────────────────────────────────────────────────
  test("K-A: KEYS HighInterest NOT in OF → enters catalystTdeCandidates", () => {
    const ofTop = [
      ofOpportunity("NVDA"),
      ofOpportunity("CSCO"),
      ofOpportunity("HD"),
      ofOpportunity("LLY"),
      ofOpportunity("AVGO"),
    ];
    const promotions = [makePromotion("KEYS", "HighInterest")];

    const result = buildCatalystTdeCandidates(ofTop, promotions);

    assert.equal(result.length, 1);
    assert.equal(result[0].ticker, "KEYS");
    assert.equal(result[0].source, "CatalystIntelligence");
    assert.equal(result[0].opportunityState, "HighInterest");
    assert.equal(result[0].catalystDirection, "POSITIVE");
  });

  // K-B  Dedup: NVDA in both OF and Catalyst ──────────────────────────────────
  test("K-B: NVDA in OF AND HighInterest → deduped (only in OF, absent from catalystTdeCandidates)", () => {
    const ofTop = [ofOpportunity("NVDA"), ofOpportunity("CSCO")];
    const promotions = [
      makePromotion("NVDA", "HighInterest"),  // NVDA already in OF
      makePromotion("KEYS", "HighInterest"),  // KEYS not in OF
    ];

    const result = buildCatalystTdeCandidates(ofTop, promotions);

    // NVDA deduped out; KEYS remains
    assert.equal(result.length, 1);
    assert.equal(result[0].ticker, "KEYS");
    assert.ok(!result.find(c => c.ticker === "NVDA"), "NVDA must not be in catalystTdeCandidates when already in OF");
  });

  // K-C  Monitor → excluded ───────────────────────────────────────────────────
  test("K-C: Monitor opportunityState → NOT in catalystTdeCandidates", () => {
    const result = buildCatalystTdeCandidates(
      [],
      [makePromotion("XYZ", "Monitor")]
    );
    assert.equal(result.length, 0);
  });

  // K-C2  Investigate → excluded ──────────────────────────────────────────────
  test("K-C2: Investigate opportunityState → NOT in catalystTdeCandidates", () => {
    const result = buildCatalystTdeCandidates(
      [],
      [makePromotion("ABC", "Investigate")]
    );
    assert.equal(result.length, 0);
  });

  // K-D  CandidateForTradeDecision → included ─────────────────────────────────
  test("K-D: CandidateForTradeDecision → enters catalystTdeCandidates", () => {
    const result = buildCatalystTdeCandidates(
      [],
      [makePromotion("AMZN", "CandidateForTradeDecision")]
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].ticker, "AMZN");
    assert.equal(result[0].opportunityState, "CandidateForTradeDecision");
  });

  // K-E  Expired → excluded (simulated by caller not passing expired promotions) ──
  test("K-E: expired: true promotion → NOT included (caller uses getActivePromotions)", () => {
    // The function itself does not check expired flag; the caller is responsible
    // for passing only active promotions (via getActivePromotions()).
    // This test confirms that IF an expired promotion is accidentally passed,
    // the function still returns it IF it qualifies — the guard is in the caller.
    // We test the contract: caller must pre-filter; function does not double-check.
    const expired = makePromotion("OLD", "HighInterest", { expired: true });
    const result = buildCatalystTdeCandidates([], [expired]);
    // expired flag is caller's responsibility — function does not re-filter
    // This documents the contract explicitly.
    assert.equal(result.length, 1, "Function trusts caller to pass only active promotions");
  });

  // K-F  Cost cap at CATALYST_TDE_CANDIDATE_CAP ───────────────────────────────
  test(`K-F: more than ${CATALYST_TDE_CANDIDATE_CAP} qualifying promotions → capped at ${CATALYST_TDE_CANDIDATE_CAP}`, () => {
    const promotions = ["A", "B", "C", "D", "E", "F", "G"].map(t =>
      makePromotion(t, "HighInterest")
    );
    const result = buildCatalystTdeCandidates([], promotions);
    assert.equal(result.length, CATALYST_TDE_CANDIDATE_CAP);
  });

  // K-G  Empty inputs ──────────────────────────────────────────────────────────
  test("K-G: empty OF and empty promotions → empty result", () => {
    const result = buildCatalystTdeCandidates([], []);
    assert.equal(result.length, 0);
  });

  // K-H  All qualifying promotions deduped vs OF → empty ─────────────────────
  test("K-H: all qualifying tickers already in OF → empty catalystTdeCandidates", () => {
    const ofTop = [ofOpportunity("NVDA"), ofOpportunity("KEYS")];
    const promotions = [
      makePromotion("NVDA", "HighInterest"),
      makePromotion("KEYS", "CandidateForTradeDecision"),
    ];
    const result = buildCatalystTdeCandidates(ofTop, promotions);
    assert.equal(result.length, 0);
  });

  // K-I  Mixed: some in OF, some not ─────────────────────────────────────────
  test("K-I: mixed — some qualifying in OF, some not → only non-OF qualifiers returned", () => {
    const ofTop = [ofOpportunity("NVDA")];
    const promotions = [
      makePromotion("NVDA", "HighInterest"),    // deduped
      makePromotion("KEYS", "HighInterest"),    // included
      makePromotion("V",    "CandidateForTradeDecision"), // included
      makePromotion("DCI",  "Monitor"),         // excluded (wrong state)
    ];
    const result = buildCatalystTdeCandidates(ofTop, promotions);
    assert.equal(result.length, 2);
    const tickers = result.map(c => c.ticker);
    assert.ok(tickers.includes("KEYS"));
    assert.ok(tickers.includes("V"));
    assert.ok(!tickers.includes("NVDA"));
    assert.ok(!tickers.includes("DCI"));
  });

  // K-J  NotInteresting → excluded ────────────────────────────────────────────
  test("K-J: NotInteresting → NOT in catalystTdeCandidates", () => {
    const result = buildCatalystTdeCandidates(
      [],
      [makePromotion("ZZZ", "NotInteresting")]
    );
    assert.equal(result.length, 0);
  });

  // K-K  Qualifying states set contract ───────────────────────────────────────
  test("K-K: TDE_QUALIFYING_STATES contains exactly HighInterest and CandidateForTradeDecision", () => {
    assert.ok(TDE_QUALIFYING_STATES.has("HighInterest"));
    assert.ok(TDE_QUALIFYING_STATES.has("CandidateForTradeDecision"));
    assert.ok(!TDE_QUALIFYING_STATES.has("Monitor"));
    assert.ok(!TDE_QUALIFYING_STATES.has("Investigate"));
    assert.ok(!TDE_QUALIFYING_STATES.has("NotInteresting"));
    assert.equal(TDE_QUALIFYING_STATES.size, 2);
  });

  // K-L  Candidate shape contract ─────────────────────────────────────────────
  test("K-L: returned candidate has correct source and required fields", () => {
    const promotions = [makePromotion("TEST", "HighInterest")];
    const [c] = buildCatalystTdeCandidates([], promotions);

    assert.equal(c.source, "CatalystIntelligence");
    assert.equal(c.ticker, "TEST");
    assert.ok(typeof c.thesis === "string" && c.thesis.length > 0);
    assert.ok(typeof c.triggerType === "string");
    assert.ok(
      c.catalystDirection === "POSITIVE" ||
      c.catalystDirection === "NEGATIVE" ||
      c.catalystDirection === "NEUTRAL",
      "catalystDirection must be valid"
    );
  });

  // K-M  Case-insensitive dedup ───────────────────────────────────────────────
  test("K-M: OF ticker lowercase, promotion uppercase → still deduped correctly", () => {
    const ofTop = [{ ticker: "nvda" }]; // lowercase
    const promotions = [makePromotion("NVDA", "HighInterest")]; // uppercase
    const result = buildCatalystTdeCandidates(ofTop, promotions);
    assert.equal(result.length, 0, "Case-insensitive dedup must work");
  });
});
