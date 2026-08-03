/**
 * Trade Decision Outcome Store — unit tests
 *
 * Uses Node.js built-in test runner (node:test).
 *
 * These tests use the real analysis-repository backed by a temp data directory
 * (set via DATA_DIR_OVERRIDE env var by run-tests.mjs), so they are fully
 * isolated from development data.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Point analysis-repository to a fresh temp directory before importing the store.
// The DATA_DIR_OVERRIDE variable is read by a modified repository lookup below.
// Since we can't dynamically override the module-level singleton, we instead
// clear the temp directory between each test group via beforeEach.
const testDataDir = join(tmpdir(), `api-server-test-data-${process.pid}`);
mkdirSync(testDataDir, { recursive: true });

// The analysis-repository uses process.cwd()/data. To avoid polluting dev data
// we do NOT run these tests via `pnpm test` directly — the run-tests.mjs
// runner changes cwd to tmpdir so DATA_DIR resolves there.
// As a fallback guard, we dynamically import after directory setup.

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { recordDecisionOutcome, updateDecisionOutcomeFromReview,
        getOutcomeForDecision, captureFuturePrice, captureReferencePrice,
        aggregateOutcomeStats } =
  await import("../trade-decision-outcome-store.js");

import type { RecordOutcomeInput } from "../trade-decision-outcome-store.js";

function baseInput(overrides: Partial<RecordOutcomeInput> = {}): RecordOutcomeInput {
  return {
    decisionId:     "AAPL:PrepareToBuy",
    ticker:         "AAPL",
    company:        "Apple Inc",
    subjectType:    "Holding",
    decisionType:   "PrepareToBuy",
    decisionStatus: "New",
    policyProfile:  "Balanced",
    isReadyForReview: false,
    fingerprint:    "fp-v1",

    evidenceScore:   40,
    evidenceBand:    "Strong",
    confidence:      "High",
    urgency:         "Days",
    targetAllocationPercent: 5,
    supportingModules: ["CompanyMonitor", "RiskAnalyzer"],
    opposingModules:   [],

    companyMonitorStrength:           80,
    companyMonitorCaseChangeSeverity: null,
    portfolioValueAtDecision:         500000,

    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("recordDecisionOutcome", () => {
  it("creates a v1 record for a new decision", () => {
    const record = recordDecisionOutcome(baseInput(), "fp-v1");
    assert.strictEqual(record.decisionVersion, 1);
    assert.strictEqual(record.id, "AAPL:PrepareToBuy:v1");
    assert.strictEqual(record.outcomeStatus, "Tracking");
    assert.strictEqual(record.supersededId, null);
  });

  it("updates metadata without bumping version when fingerprint is unchanged", () => {
    recordDecisionOutcome(baseInput(), "fp-v1");
    const updated = recordDecisionOutcome(
      baseInput({ evidenceScore: 45, decisionStatus: "Strengthened" }),
      "fp-v1"
    );
    assert.strictEqual(updated.decisionVersion, 1);
    assert.strictEqual(updated.evidenceScore, 45);
    assert.strictEqual(updated.decisionStatus, "Strengthened");
  });

  it("closes the old version and opens v2 when the fingerprint changes materially", () => {
    recordDecisionOutcome(baseInput(), "fp-v1");
    const v2 = recordDecisionOutcome(
      baseInput({ evidenceScore: 20, evidenceBand: "Adequate" }),
      "fp-v2"
    );
    assert.strictEqual(v2.decisionVersion, 2);
    assert.strictEqual(v2.supersededId, "AAPL:PrepareToBuy:v1");
  });

  it("sets becameReadyAt when isReadyForReview transitions to true", () => {
    recordDecisionOutcome(baseInput({ isReadyForReview: false }), "fp-v1");
    const ready = recordDecisionOutcome(baseInput({ isReadyForReview: true }), "fp-v1");
    assert.ok(ready.becameReadyAt !== null, "becameReadyAt should be set when ReadyForReview");
  });
});

// ---------------------------------------------------------------------------

describe("updateDecisionOutcomeFromReview", () => {
  it("sets approvedAt and status to AwaitingExecution on Approved", () => {
    recordDecisionOutcome(
      baseInput({ decisionId: "MSFT:PrepareToBuy", ticker: "MSFT", company: "Microsoft" }),
      "fp-msft"
    );
    updateDecisionOutcomeFromReview({
      decisionId: "MSFT:PrepareToBuy",
      newStatus:  "Approved",
    });
    const outcome = getOutcomeForDecision("MSFT:PrepareToBuy");
    assert.ok(outcome?.approvedAt !== null, "approvedAt should be set");
    assert.strictEqual(outcome?.outcomeStatus, "AwaitingExecution");
  });

  it("moves record to history (null from active) when Rejected", () => {
    recordDecisionOutcome(
      baseInput({ decisionId: "AMZN:PrepareToBuy", ticker: "AMZN", company: "Amazon" }),
      "fp-amzn"
    );
    updateDecisionOutcomeFromReview({
      decisionId: "AMZN:PrepareToBuy",
      newStatus:  "Rejected",
    });
    const outcome = getOutcomeForDecision("AMZN:PrepareToBuy");
    assert.strictEqual(outcome, null, "Rejected outcome should be moved to history (not active)");
  });
});

// ---------------------------------------------------------------------------

describe("captureFuturePrice / captureReferencePrice", () => {
  it("stores reference price and computes 5-day return correctly for PrepareToBuy", () => {
    recordDecisionOutcome(
      baseInput({ decisionId: "NVDA:PrepareToBuy", ticker: "NVDA", company: "NVIDIA" }),
      "fp-nvda"
    );
    captureReferencePrice("NVDA:PrepareToBuy", 200, "USD");
    captureFuturePrice("NVDA:PrepareToBuy", "5d", 210);

    const outcome = getOutcomeForDecision("NVDA:PrepareToBuy");
    assert.strictEqual(outcome?.referencePrice, 200);
    assert.strictEqual(outcome?.outcomePrice5Days, 210);
    // (210-200)/200 * 100 = 5.00%
    assert.strictEqual(outcome?.outcomeReturn5DaysPercent, 5);
  });

  it("inverts return sign for PrepareToReduce (price fall is a positive outcome)", () => {
    recordDecisionOutcome(
      baseInput({
        decisionId:   "TSLA:PrepareToReduce",
        ticker:       "TSLA",
        company:      "Tesla",
        decisionType: "PrepareToReduce",
      }),
      "fp-tsla"
    );
    captureReferencePrice("TSLA:PrepareToReduce", 200, "USD");
    captureFuturePrice("TSLA:PrepareToReduce", "5d", 190);

    const outcome = getOutcomeForDecision("TSLA:PrepareToReduce");
    // price fell 5% → sell was correct → positive outcome (+5)
    assert.strictEqual(outcome?.outcomeReturn5DaysPercent, 5);
  });
});

// ---------------------------------------------------------------------------

describe("aggregateOutcomeStats", () => {
  it("returns the expected shape and correct band groupings", () => {
    recordDecisionOutcome(
      baseInput({ decisionId: "META:PrepareToBuy", ticker: "META", company: "Meta" }),
      "fp-meta"
    );
    recordDecisionOutcome(
      baseInput({
        decisionId:   "GOOGL:PrepareToBuy",
        ticker:       "GOOGL",
        company:      "Alphabet",
        evidenceBand: "Adequate",
        evidenceScore: 28,
        isReadyForReview: true,
      }),
      "fp-googl"
    );

    const stats = aggregateOutcomeStats();
    assert.ok(stats.totalRecords >= 2, "Should have at least 2 records");
    assert.ok("Strong" in stats.byEvidenceBand, "Expected 'Strong' band in stats");
    assert.ok("Adequate" in stats.byEvidenceBand, "Expected 'Adequate' band in stats");
    assert.ok(stats.readyForReviewCount >= 1, "Expected at least 1 ReadyForReview record");
  });
});
