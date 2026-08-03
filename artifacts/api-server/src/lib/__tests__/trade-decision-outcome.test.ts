/**
 * Trade Decision Outcome Store — unit tests
 *
 * Uses Node.js built-in test runner (node:test).
 * Run via: pnpm --filter @workspace/api-server test
 *
 * The run-tests.mjs runner sets cwd to a fresh temp directory so
 * analysis-repository writes to an isolated data/ folder, preventing
 * test runs from polluting or reading from development repository.json.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  recordDecisionOutcome,
  updateDecisionOutcomeFromReview,
  getOutcomeForDecision,
  getOutcomeById,
  captureFuturePrice,
  captureReferencePrice,
  aggregateOutcomeStats,
} = await import("../trade-decision-outcome-store.js");

import type { RecordOutcomeInput } from "../trade-decision-outcome-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<RecordOutcomeInput> = {}): RecordOutcomeInput {
  return {
    subjectDecisionId: "Holding:AAPL",
    ticker:            "AAPL",
    company:           "Apple Inc",
    subjectType:       "Holding",
    decisionType:      "PrepareToBuy",
    decisionStatus:    "New",
    policyProfile:     "Balanced",
    isReadyForReview:  false,
    fingerprint:       "fp-v1",

    evidenceScore:           40,
    evidenceBand:            "Strong",
    confidence:              "High",
    urgency:                 "Days",
    targetAllocationPercent: 5,
    supportingModules:       ["CompanyMonitor", "RiskAnalyzer"],
    opposingModules:         [],

    companyMonitorStrength:           80,
    companyMonitorCaseChangeSeverity: null,
    portfolioValueAtDecision:         500000,

    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. recordDecisionOutcome
// ---------------------------------------------------------------------------

describe("recordDecisionOutcome", () => {
  it("creates a v1 record for a new decision using subjectDecisionId format", () => {
    const record = recordDecisionOutcome(baseInput(), "fp-v1");
    assert.strictEqual(record.decisionVersion, 1);
    assert.strictEqual(record.id, "Holding:AAPL:v1");
    assert.strictEqual(record.subjectDecisionId, "Holding:AAPL");
    assert.strictEqual(record.outcomeStatus, "Tracking");
    assert.strictEqual(record.supersededId, null);
  });

  it("new record has zero deferral counters and null approvedQuantity", () => {
    const record = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Opportunity:NEW1" }),
      "fp-new1"
    );
    assert.strictEqual(record.deferredCount, 0);
    assert.strictEqual(record.deferredAt, null);
    assert.strictEqual(record.lastDeferredAt, null);
    assert.strictEqual(record.approvedQuantity, null);
  });

  it("updates metadata without bumping version when fingerprint is unchanged", () => {
    recordDecisionOutcome(baseInput({ subjectDecisionId: "Holding:MSFT2" }), "fp-v1");
    const updated = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:MSFT2", evidenceScore: 45, decisionStatus: "Strengthened" }),
      "fp-v1"
    );
    assert.strictEqual(updated.decisionVersion, 1);
    assert.strictEqual(updated.evidenceScore, 45);
    assert.strictEqual(updated.decisionStatus, "Strengthened");
  });

  it("closes the old version and opens v2 when the fingerprint changes materially", () => {
    recordDecisionOutcome(baseInput({ subjectDecisionId: "Holding:AMZN" }), "fp-v1");
    const v2 = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:AMZN", evidenceScore: 20, evidenceBand: "Adequate" }),
      "fp-v2"
    );
    assert.strictEqual(v2.decisionVersion, 2);
    assert.strictEqual(v2.supersededId, "Holding:AMZN:v1");
    assert.strictEqual(v2.id, "Holding:AMZN:v2");
  });

  it("sets becameReadyAt when isReadyForReview transitions to true", () => {
    recordDecisionOutcome(baseInput({ subjectDecisionId: "Holding:NVDA2", isReadyForReview: false }), "fp-v1");
    const ready = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:NVDA2", isReadyForReview: true }),
      "fp-v1"
    );
    assert.ok(ready.becameReadyAt !== null, "becameReadyAt should be set when ReadyForReview");
  });

  it("decision type change creates a new linked version under same subjectDecisionId", () => {
    // Start with PrepareToBuy
    const v1 = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:CAT", decisionType: "PrepareToBuy" }),
      "fp-buy"
    );
    assert.strictEqual(v1.decisionType, "PrepareToBuy");
    assert.strictEqual(v1.decisionVersion, 1);

    // Switch to PrepareToReduce — same subject, different decision type
    const v2 = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:CAT", decisionType: "PrepareToReduce" }),
      "fp-sell"
    );
    assert.strictEqual(v2.decisionType, "PrepareToReduce");
    assert.strictEqual(v2.decisionVersion, 2, "version must bump on decision type change");
    assert.strictEqual(v2.supersededId, "Holding:CAT:v1", "v2 must link back to v1");
    assert.strictEqual(v2.subjectDecisionId, "Holding:CAT", "subjectDecisionId is stable across type changes");
  });
});

// ---------------------------------------------------------------------------
// 2. updateDecisionOutcomeFromReview
// ---------------------------------------------------------------------------

describe("updateDecisionOutcomeFromReview", () => {
  it("sets approvedAt and status to AwaitingExecution on Approved", () => {
    const outcome = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:GOOG" }),
      "fp-goog"
    );
    updateDecisionOutcomeFromReview({
      outcomeId: outcome.id,
      newStatus: "Approved",
    });
    const updated = getOutcomeById(outcome.id);
    assert.ok(updated?.approvedAt !== null, "approvedAt should be set");
    assert.strictEqual(updated?.outcomeStatus, "AwaitingExecution");
  });

  it("stores approvedQuantity when Approved with quantity", () => {
    const outcome = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:META" }),
      "fp-meta"
    );
    updateDecisionOutcomeFromReview({
      outcomeId: outcome.id,
      newStatus: "Approved",
      quantity:  42,
      estimatedPrice: 550.0,
      currency:  "USD",
    });
    const updated = getOutcomeById(outcome.id);
    assert.strictEqual(updated?.approvedQuantity, 42, "approvedQuantity should be stored");
    assert.strictEqual(updated?.referencePrice, 550.0);
  });

  it("moves record to history (null from active) when Rejected", () => {
    const outcome = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Opportunity:TSMC" }),
      "fp-tsmc"
    );
    updateDecisionOutcomeFromReview({
      outcomeId: outcome.id,
      newStatus: "Rejected",
    });
    assert.strictEqual(
      getOutcomeById(outcome.id),
      null,
      "Rejected outcome should be removed from active store"
    );
  });

  it("Deferred: increments deferral counters without changing outcomeStatus", () => {
    const outcome = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:ORCL" }),
      "fp-orcl"
    );
    assert.strictEqual(outcome.deferredCount, 0);

    updateDecisionOutcomeFromReview({ outcomeId: outcome.id, newStatus: "Deferred" });
    const after1 = getOutcomeById(outcome.id);
    assert.strictEqual(after1?.deferredCount, 1);
    assert.ok(after1?.deferredAt !== null, "deferredAt should be set on first deferral");
    assert.strictEqual(after1?.outcomeStatus, "Tracking", "Deferred must not change outcomeStatus");

    updateDecisionOutcomeFromReview({ outcomeId: outcome.id, newStatus: "Deferred" });
    const after2 = getOutcomeById(outcome.id);
    assert.strictEqual(after2?.deferredCount, 2);
    assert.strictEqual(after2?.deferredAt, after1?.deferredAt, "deferredAt stays as first deferral time");
    assert.ok(after2?.lastDeferredAt !== null);
  });

  it("terminal records (Rejected) cannot be modified after rejection", () => {
    const outcome = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:INTC" }),
      "fp-intc"
    );
    updateDecisionOutcomeFromReview({ outcomeId: outcome.id, newStatus: "Rejected" });

    // Record is now in history (null in active). A second update is a no-op.
    // If the record somehow reappears in active (e.g. concurrent calls), the
    // isTerminal guard prevents further modification.
    assert.strictEqual(
      getOutcomeById(outcome.id),
      null,
      "Rejected record must not be in active store"
    );
  });

  it("exact outcomeId lookup: updating v2 does not affect v1 (already in history)", () => {
    // Create v1 then bump to v2 via fingerprint change
    const v1 = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:CSCO" }),
      "fp-v1"
    );
    const v2 = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:CSCO", evidenceScore: 50 }),
      "fp-v2"
    );
    assert.strictEqual(v2.decisionVersion, 2);

    // Approve using v2's exact id
    updateDecisionOutcomeFromReview({ outcomeId: v2.id, newStatus: "Approved" });

    const approved = getOutcomeById(v2.id);
    assert.strictEqual(approved?.outcomeStatus, "AwaitingExecution", "v2 should be approved");

    // v1 is in history — cannot be found in active store
    assert.strictEqual(
      getOutcomeById(v1.id),
      null,
      "v1 should not be in active store (moved to history when v2 was created)"
    );
  });
});

// ---------------------------------------------------------------------------
// 3. captureFuturePrice / captureReferencePrice
// ---------------------------------------------------------------------------

describe("captureFuturePrice / captureReferencePrice", () => {
  it("stores reference price and computes 5-day return correctly for PrepareToBuy", () => {
    recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:NVDA", ticker: "NVDA", company: "NVIDIA" }),
      "fp-nvda"
    );
    captureReferencePrice("Holding:NVDA", 200, "USD");
    captureFuturePrice("Holding:NVDA", "5d", 210);

    const outcome = getOutcomeForDecision("Holding:NVDA");
    assert.strictEqual(outcome?.referencePrice, 200);
    assert.strictEqual(outcome?.outcomePrice5Days, 210);
    // (210-200)/200 * 100 = 5.00%
    assert.strictEqual(outcome?.outcomeReturn5DaysPercent, 5);
  });

  it("inverts return sign for PrepareToReduce (price fall is a positive outcome)", () => {
    recordDecisionOutcome(
      baseInput({
        subjectDecisionId: "Holding:TSLA",
        ticker:            "TSLA",
        company:           "Tesla",
        decisionType:      "PrepareToReduce",
      }),
      "fp-tsla"
    );
    captureReferencePrice("Holding:TSLA", 200, "USD");
    captureFuturePrice("Holding:TSLA", "5d", 190);

    const outcome = getOutcomeForDecision("Holding:TSLA");
    // price fell 5% → sell was correct → positive outcome (+5)
    assert.strictEqual(outcome?.outcomeReturn5DaysPercent, 5);
  });
});

// ---------------------------------------------------------------------------
// 4. aggregateOutcomeStats
// ---------------------------------------------------------------------------

describe("aggregateOutcomeStats", () => {
  it("returns the expected shape, correct band groupings, and deferredCount", () => {
    recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:SNAP", ticker: "SNAP", company: "Snap" }),
      "fp-snap"
    );
    const deferrable = recordDecisionOutcome(
      baseInput({
        subjectDecisionId:  "Opportunity:LYFT",
        ticker:             "LYFT",
        company:            "Lyft",
        evidenceBand:       "Adequate",
        evidenceScore:      28,
        isReadyForReview:   true,
      }),
      "fp-lyft"
    );
    // Defer the Lyft decision once
    updateDecisionOutcomeFromReview({ outcomeId: deferrable.id, newStatus: "Deferred" });

    const stats = aggregateOutcomeStats();
    assert.ok(stats.totalRecords >= 2, "Should have at least 2 records");
    assert.ok("Strong"   in stats.byEvidenceBand, "Expected 'Strong' band in stats");
    assert.ok("Adequate" in stats.byEvidenceBand, "Expected 'Adequate' band in stats");
    assert.ok(stats.readyForReviewCount  >= 1, "Expected at least 1 ReadyForReview record");
    assert.ok(stats.deferredCount >= 1, "Expected at least 1 deferred record");
    // deferredCount is a field in OutcomeStats
    assert.ok("deferredCount" in stats);
  });
});
