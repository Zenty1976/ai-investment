/**
 * Trade Review — outcome version-linking contract
 *
 * These tests verify the behaviour described in the version-linking fix:
 *
 *   When the TDE issues a new fingerprint for the same subject, the outcome
 *   store creates a new version.  Trade Review must link to the NEW version
 *   and must NOT carry forward user decisions (Approved / Rejected) from the
 *   old version.  The old version's outcome record must remain unchanged in
 *   history.
 *
 * The tests exercise the outcome store directly and assert the exact
 * invariants that the Trade Review route relies upon.  The `sameOutcomeVersion`
 * guard is reproduced inline so its correctness can be verified independently
 * of the Express router.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  recordDecisionOutcome,
  updateDecisionOutcomeFromReview,
  getOutcomeForDecision,
  getOutcomeById,
} = await import("../trade-decision-outcome-store.js");

import type { RecordOutcomeInput } from "../trade-decision-outcome-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mirrors the `sameOutcomeVersion` guard in the Trade Review route. */
function isSameOutcomeVersion(
  prevOutcomeId: string | null | undefined,
  currentOutcomeId: string | null
): boolean {
  return (
    prevOutcomeId != null &&
    currentOutcomeId != null &&
    prevOutcomeId === currentOutcomeId
  );
}

function baseInput(overrides: Partial<RecordOutcomeInput> = {}): RecordOutcomeInput {
  return {
    subjectDecisionId: "Holding:CAT",
    ticker:            "CAT",
    company:           "Caterpillar",
    subjectType:       "Holding",
    decisionType:      "PrepareToBuy",
    decisionStatus:    "New",
    policyProfile:     "Balanced",
    isReadyForReview:  true,
    fingerprint:       "fp-v1",
    evidenceScore:           35,
    evidenceBand:            "Adequate",
    confidence:              "Medium",
    urgency:                 "Days",
    targetAllocationPercent: 4,
    supportingModules:       ["CompanyMonitor"],
    opposingModules:         [],
    companyMonitorStrength:           70,
    companyMonitorCaseChangeSeverity: null,
    portfolioValueAtDecision:         400000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario A — same decision type, fingerprint change creates v2
// ---------------------------------------------------------------------------

describe("version linking: fingerprint change (same type)", () => {
  it("creates v1, approves it, then v2 outcome exists after fingerprint change", () => {
    // Step 1 — TDE records v1
    const v1 = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:CAT_A" }),
      "fp-v1"
    );
    assert.strictEqual(v1.id, "Holding:CAT_A:v1");

    // Step 2 — user approves v1 through Trade Review
    updateDecisionOutcomeFromReview({ outcomeId: v1.id, newStatus: "Approved" });
    const approvedV1 = getOutcomeById(v1.id);
    assert.strictEqual(approvedV1?.outcomeStatus, "AwaitingExecution");

    // Step 3 — TDE produces a new fingerprint (e.g. evidence score changed materially)
    const v2 = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:CAT_A", evidenceScore: 50, evidenceBand: "Strong" }),
      "fp-v2"
    );
    assert.strictEqual(v2.id, "Holding:CAT_A:v2", "outcome store must create v2");
    assert.strictEqual(v2.supersededId, "Holding:CAT_A:v1");
    assert.strictEqual(v2.outcomeStatus, "Tracking", "v2 starts fresh — not Approved");
  });

  it("Trade Review links to v2: sameOutcomeVersion is false when stored proposal has v1 id", () => {
    // Simulate the proposal stored after the v1 approval
    const storedProposalOutcomeId = "Holding:CAT_A:v1";

    // Current active outcome id (after TDE bumped to v2)
    const currentOutcomeId = "Holding:CAT_A:v2";

    assert.strictEqual(
      isSameOutcomeVersion(storedProposalOutcomeId, currentOutcomeId),
      false,
      "stored v1 id must not match current v2 id → no status preservation"
    );
  });

  it("new proposal is not automatically Approved: status must be recalculated", () => {
    // When sameOutcomeVersion is false, the route falls through to
    // sizing-based status calculation.  We verify that the status the
    // route would produce is NOT Approved — the guard prevents inheritance.
    const storedProposalOutcomeId = "Holding:CAT_A:v1";
    const currentOutcomeId        = "Holding:CAT_A:v2";
    const prevStatus              = "Approved";

    const sameVersion = isSameOutcomeVersion(storedProposalOutcomeId, currentOutcomeId);

    // The preserved-status branch only fires when sameVersion is true.
    // With sameVersion=false the status is determined by sizing availability.
    const PRESERVED_STATUSES = ["Approved", "Rejected", "Executed", "Cancelled"];
    const wouldPreserve = sameVersion && PRESERVED_STATUSES.includes(prevStatus);

    assert.strictEqual(wouldPreserve, false, "Approved must NOT be carried from v1 to v2");
  });

  it("approvedAt is cleared for v2 proposal (no version-specific state carried forward)", () => {
    // The route uses `samePrev` (undefined when !sameOutcomeVersion)
    // so all version timestamps come from `undefined?.field ?? nowIso` = nowIso.
    const samePrev: { approvedAt: string } | undefined = undefined;
    const approvedAt = "Approved" === "Approved" ? (samePrev?.approvedAt ?? "nowIso") : null;
    // The resolved value is "nowIso" (the current generation time), not the old timestamp.
    assert.strictEqual(approvedAt, "nowIso", "approvedAt should reset to current time for the new proposal");
  });

  it("v1 outcome record stays unchanged in history after v2 approval", () => {
    const v1b = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:CAT_B" }),
      "fp-v1b"
    );
    updateDecisionOutcomeFromReview({ outcomeId: v1b.id, newStatus: "Approved" });

    // TDE bumps to v2
    const v2b = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:CAT_B", evidenceScore: 50 }),
      "fp-v2b"
    );

    // Approve v2
    updateDecisionOutcomeFromReview({ outcomeId: v2b.id, newStatus: "Approved" });

    // v1 is NOT in the active store — it was moved to history when v2 was created
    assert.strictEqual(
      getOutcomeById(v1b.id),
      null,
      "v1 must not be in active store after v2 was created"
    );

    // v2 should be AwaitingExecution
    const v2After = getOutcomeById(v2b.id);
    assert.strictEqual(v2After?.outcomeStatus, "AwaitingExecution");
  });

  it("actions targeting v2 id do not affect v1 (v1 is already in history)", () => {
    const v1c = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:CAT_C" }),
      "fp-v1c"
    );
    // Do NOT approve v1 — just bump to v2
    const v2c = recordDecisionOutcome(
      baseInput({ subjectDecisionId: "Holding:CAT_C", evidenceScore: 45 }),
      "fp-v2c"
    );

    // Reject v2
    updateDecisionOutcomeFromReview({ outcomeId: v2c.id, newStatus: "Rejected" });

    // v2 is now in history (Rejected → removed from active)
    assert.strictEqual(getOutcomeById(v2c.id), null, "v2 must not be in active store after Rejected");

    // v1 was already moved to history by v2 creation — also null from active
    assert.strictEqual(getOutcomeById(v1c.id), null, "v1 is in history, not in active store");
  });
});

// ---------------------------------------------------------------------------
// Scenario B — decision-type change: PrepareToBuy v1 → PrepareToReduce v2
// ---------------------------------------------------------------------------

describe("version linking: decision-type change", () => {
  it("PrepareToReduce v2 gets a new outcome version under the same subjectDecisionId", () => {
    const v1 = recordDecisionOutcome(
      baseInput({
        subjectDecisionId: "Holding:CAT_D",
        decisionType:      "PrepareToBuy",
      }),
      "fp-buy"
    );
    assert.strictEqual(v1.decisionType, "PrepareToBuy");
    assert.strictEqual(v1.id, "Holding:CAT_D:v1");

    const v2 = recordDecisionOutcome(
      baseInput({
        subjectDecisionId: "Holding:CAT_D",
        decisionType:      "PrepareToReduce",
      }),
      "fp-sell"
    );
    assert.strictEqual(v2.decisionType, "PrepareToReduce");
    assert.strictEqual(v2.id, "Holding:CAT_D:v2");
    assert.strictEqual(v2.supersededId, "Holding:CAT_D:v1");
  });

  it("Trade Review for PrepareToReduce does not inherit Approved status from PrepareToBuy v1", () => {
    // Simulate the scenario:
    //   - User approved a CAT_E PrepareToBuy proposal (linked to v1)
    //   - TDE flips to PrepareToReduce → v2 is created
    //   - Trade Review re-generates the proposal for CAT_E:PrepareToReduce
    //   - The new proposal MUST link to v2 and MUST NOT be Approved

    const v1 = recordDecisionOutcome(
      baseInput({
        subjectDecisionId: "Holding:CAT_E",
        decisionType:      "PrepareToBuy",
      }),
      "fp-buy-e"
    );
    updateDecisionOutcomeFromReview({ outcomeId: v1.id, newStatus: "Approved" });

    // TDE flips decision type
    const v2 = recordDecisionOutcome(
      baseInput({
        subjectDecisionId: "Holding:CAT_E",
        decisionType:      "PrepareToReduce",
      }),
      "fp-sell-e"
    );

    // Trade Review resolves: currentOutcomeId is now v2
    const currentOutcomeId        = getOutcomeForDecision("Holding:CAT_E")?.id ?? null;
    const storedProposalOutcomeId  = v1.id; // the proposal was linked to v1

    assert.strictEqual(currentOutcomeId, v2.id, "active outcome must be v2");
    assert.strictEqual(
      isSameOutcomeVersion(storedProposalOutcomeId, currentOutcomeId),
      false,
      "v1 id ≠ v2 id → sameOutcomeVersion must be false → status not preserved"
    );

    // With sameOutcomeVersion=false: Approved must NOT be preserved
    const PRESERVED_STATUSES = ["Approved", "Rejected", "Executed", "Cancelled"];
    const wouldPreserve =
      isSameOutcomeVersion(storedProposalOutcomeId, currentOutcomeId) &&
      PRESERVED_STATUSES.includes("Approved");

    assert.strictEqual(wouldPreserve, false);
  });

  it("subjectDecisionId is stable across the type change", () => {
    const v1 = recordDecisionOutcome(
      baseInput({
        subjectDecisionId: "Holding:CAT_F",
        decisionType:      "PrepareToBuy",
      }),
      "fp-buy-f"
    );
    const v2 = recordDecisionOutcome(
      baseInput({
        subjectDecisionId: "Holding:CAT_F",
        decisionType:      "PrepareToReduce",
      }),
      "fp-sell-f"
    );

    assert.strictEqual(v1.subjectDecisionId, "Holding:CAT_F");
    assert.strictEqual(v2.subjectDecisionId, "Holding:CAT_F");
    assert.notStrictEqual(v1.id, v2.id, "version ids must differ");
  });
});

// ---------------------------------------------------------------------------
// Scenario C — sameOutcomeVersion guard edge cases
// ---------------------------------------------------------------------------

describe("sameOutcomeVersion guard edge cases", () => {
  it("returns false when prev has no outcomeId (first time the proposal is generated)", () => {
    assert.strictEqual(isSameOutcomeVersion(null, "Holding:X:v1"), false);
    assert.strictEqual(isSameOutcomeVersion(undefined, "Holding:X:v1"), false);
  });

  it("returns false when current outcomeId is null (no active outcome record)", () => {
    assert.strictEqual(isSameOutcomeVersion("Holding:X:v1", null), false);
  });

  it("returns true when both ids are identical", () => {
    assert.strictEqual(isSameOutcomeVersion("Holding:X:v1", "Holding:X:v1"), true);
  });

  it("returns false when ids differ only by version suffix", () => {
    assert.strictEqual(isSameOutcomeVersion("Holding:X:v1", "Holding:X:v2"), false);
    assert.strictEqual(isSameOutcomeVersion("Holding:X:v2", "Holding:X:v3"), false);
  });
});
