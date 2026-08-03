/**
 * Trade Decision Policy Config — unit tests
 *
 * Uses Node.js built-in test runner (node:test).
 *
 * Verifies:
 *  1. validateAllProfiles passes for all built-in profiles.
 *  2. validatePolicyConfig throws on broken configs.
 *  3. Threshold ordering contract (Conservative > Balanced > Aggressive).
 *  4. Hard safety rules hold across all profiles.
 *  5. Conservative-specific gates are set.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  POLICY_CONFIGS,
  POLICY_CONSERVATIVE,
  POLICY_BALANCED,
  POLICY_AGGRESSIVE,
  validateAllProfiles,
  validatePolicyConfig,
  getProfileMetadata,
  getAllProfileMetadata,
} from "../trade-decision-policy-config.js";

// ---------------------------------------------------------------------------
// 1. Validation utilities
// ---------------------------------------------------------------------------

describe("validateAllProfiles", () => {
  it("passes without throwing for all built-in profiles", () => {
    assert.doesNotThrow(() => validateAllProfiles());
  });
});

describe("validatePolicyConfig", () => {
  it("rejects a config where strongMinimum < adequateMinimum", () => {
    const broken = {
      ...POLICY_BALANCED,
      profile: "Broken" as never,
      bands: { strongMinimum: 10, adequateMinimum: 25, weakMinimum: 5 },
    };
    assert.throws(() => validatePolicyConfig(broken));
  });

  it("rejects readyForReview.minimumEvidenceScore below weakMinimum", () => {
    const broken = {
      ...POLICY_BALANCED,
      profile: "Broken" as never,
      readyForReview: { ...POLICY_BALANCED.readyForReview, minimumEvidenceScore: -5 },
    };
    assert.throws(() => validatePolicyConfig(broken));
  });

  it("rejects minimumSupportingModules below 1", () => {
    const broken = {
      ...POLICY_BALANCED,
      profile: "Broken" as never,
      gate: { ...POLICY_BALANCED.gate, minimumSupportingModules: 0 },
    };
    assert.throws(() => validatePolicyConfig(broken));
  });
});

// ---------------------------------------------------------------------------
// 2. Threshold ordering contract
// ---------------------------------------------------------------------------

describe("profile threshold ordering", () => {
  it("Conservative evidence threshold is higher than Balanced", () => {
    assert.ok(
      POLICY_CONSERVATIVE.readyForReview.minimumEvidenceScore >
      POLICY_BALANCED.readyForReview.minimumEvidenceScore,
      "Conservative ≥ threshold should exceed Balanced"
    );
  });

  it("Balanced evidence threshold is higher than Aggressive", () => {
    assert.ok(
      POLICY_BALANCED.readyForReview.minimumEvidenceScore >
      POLICY_AGGRESSIVE.readyForReview.minimumEvidenceScore,
      "Balanced ≥ threshold should exceed Aggressive"
    );
  });

  it("Conservative requires ≥ 3 supporting modules", () => {
    assert.ok(
      POLICY_CONSERVATIVE.gate.minimumSupportingModules >= 3,
      `Expected ≥ 3, got ${POLICY_CONSERVATIVE.gate.minimumSupportingModules}`
    );
  });

  it("Balanced uses score ≥ 25 as ReadyForReview threshold", () => {
    assert.strictEqual(POLICY_BALANCED.readyForReview.minimumEvidenceScore, 25);
  });

  it("Aggressive uses score ≥ 15 as ReadyForReview threshold", () => {
    assert.strictEqual(POLICY_AGGRESSIVE.readyForReview.minimumEvidenceScore, 15);
  });
});

// ---------------------------------------------------------------------------
// 3. Hard safety rules — present in every profile
// ---------------------------------------------------------------------------

describe("hard safety rules — consistent across all profiles", () => {
  const profiles = Object.values(POLICY_CONFIGS);

  it("criticalOpposingModules always includes CompanyMonitor", () => {
    for (const p of profiles) {
      assert.ok(
        p.gate.criticalOpposingModules.includes("CompanyMonitor"),
        `${p.profile}: expected criticalOpposingModules to include CompanyMonitor`
      );
    }
  });

  it("criticalOpposingModules always includes RiskAnalyzer", () => {
    for (const p of profiles) {
      assert.ok(
        p.gate.criticalOpposingModules.includes("RiskAnalyzer"),
        `${p.profile}: expected criticalOpposingModules to include RiskAnalyzer`
      );
    }
  });

  it("downgrade.reviewThreshold is always below readyForReview.minimumEvidenceScore", () => {
    for (const p of profiles) {
      assert.ok(
        p.downgrade.reviewThreshold < p.readyForReview.minimumEvidenceScore,
        `${p.profile}: reviewThreshold (${p.downgrade.reviewThreshold}) should be < ` +
        `minimumEvidenceScore (${p.readyForReview.minimumEvidenceScore})`
      );
    }
  });

  it("downgrade.noActionThreshold is always below downgrade.reviewThreshold", () => {
    for (const p of profiles) {
      assert.ok(
        p.downgrade.noActionThreshold < p.downgrade.reviewThreshold,
        `${p.profile}: noActionThreshold should be < reviewThreshold`
      );
    }
  });

  it("stalenessHours values are all positive", () => {
    for (const p of profiles) {
      for (const [module, hours] of Object.entries(p.stalenessHours)) {
        assert.ok(hours > 0, `${p.profile}.stalenessHours["${module}"] = ${hours} should be > 0`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Conservative-specific rules
// ---------------------------------------------------------------------------

describe("Conservative-specific gates", () => {
  it("requireCompanyMonitorForCompanyTrades is true", () => {
    assert.strictEqual(
      POLICY_CONSERVATIVE.gate.requireCompanyMonitorForCompanyTrades,
      true
    );
  });

  it("maximumTargetAllocationPercent is set (not null)", () => {
    assert.notStrictEqual(
      POLICY_CONSERVATIVE.readyForReview.maximumTargetAllocationPercent,
      null
    );
  });
});

describe("Balanced-specific gates", () => {
  it("requireCompanyMonitorForCompanyTrades is false", () => {
    assert.strictEqual(
      POLICY_BALANCED.gate.requireCompanyMonitorForCompanyTrades,
      false
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Profile metadata — backend-derived, must match actual config values
// ---------------------------------------------------------------------------

describe("profile metadata accuracy", () => {
  it("Aggressive metadata: minimumSupportingModules is 1 (not 2)", () => {
    // This test prevents the UI description from drifting from the actual config.
    // The Aggressive profile allows 1 supporting module — getProfileMetadata must
    // reflect this so the frontend description cannot say "≥2".
    const meta = getProfileMetadata(POLICY_AGGRESSIVE);
    assert.strictEqual(
      meta.minimumSupportingModules,
      POLICY_AGGRESSIVE.gate.minimumSupportingModules,
      "metadata.minimumSupportingModules must equal the actual gate config"
    );
    assert.strictEqual(meta.minimumSupportingModules, 1);
  });

  it("Conservative metadata: minimumSupportingModules is 3", () => {
    const meta = getProfileMetadata(POLICY_CONSERVATIVE);
    assert.strictEqual(meta.minimumSupportingModules, 3);
  });

  it("all profile metadata shortDescriptions are non-empty strings", () => {
    for (const m of getAllProfileMetadata()) {
      assert.ok(
        typeof m.shortDescription === "string" && m.shortDescription.trim().length > 0,
        `${m.profile}: shortDescription must be a non-empty string`
      );
    }
  });

  it("getAllProfileMetadata returns all three profiles in order", () => {
    const metas = getAllProfileMetadata();
    assert.strictEqual(metas.length, 3);
    assert.deepStrictEqual(metas.map(m => m.profile), ["Conservative", "Balanced", "Aggressive"]);
  });

  it("metadata minimumEvidenceScore matches readyForReview config", () => {
    for (const [name, cfg] of Object.entries(POLICY_CONFIGS)) {
      const meta = getProfileMetadata(cfg);
      assert.strictEqual(
        meta.minimumEvidenceScore,
        cfg.readyForReview.minimumEvidenceScore,
        `${name}: metadata score must equal config score`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Additional validation rules
// ---------------------------------------------------------------------------

describe("extended validatePolicyConfig", () => {
  it("rejects downgrade.reviewThreshold >= readyForReview.minimumEvidenceScore", () => {
    // If reviewThreshold equals minimumEvidenceScore, a decision could be both
    // ReadyForReview and downgraded at the same time — invalid.
    const broken = {
      ...POLICY_BALANCED,
      profile: "Broken" as never,
      downgrade: { ...POLICY_BALANCED.downgrade, reviewThreshold: 25 }, // same as minimumEvidenceScore
    };
    assert.throws(() => validatePolicyConfig(broken), /reviewThreshold/);
  });

  it("rejects band value outside [-100, 100]", () => {
    const broken = {
      ...POLICY_BALANCED,
      profile: "Broken" as never,
      bands: { strongMinimum: 150, adequateMinimum: 25, weakMinimum: 10 },
    };
    assert.throws(() => validatePolicyConfig(broken), /bands\.strongMinimum/);
  });

  it("rejects readyForReview.minimumEvidenceScore below bands.weakMinimum", () => {
    // Score below weakMinimum means evidence classified as "Insufficient"
    // could still be ReadyForReview — a logical contradiction.
    const broken = {
      ...POLICY_BALANCED,
      profile: "Broken" as never,
      readyForReview: { ...POLICY_BALANCED.readyForReview, minimumEvidenceScore: 5 }, // below weakMinimum=10
    };
    assert.throws(() => validatePolicyConfig(broken), /weakMinimum/);
  });

  it("rejects staleness module with unknown ID", () => {
    const broken = {
      ...POLICY_BALANCED,
      profile: "Broken" as never,
      stalenessHours: { ...POLICY_BALANCED.stalenessHours, "unknown-module": 48 },
    };
    assert.throws(() => validatePolicyConfig(broken), /unknown module ID/);
  });

  it("rejects criticalOpposingModules with unknown module name", () => {
    const broken = {
      ...POLICY_BALANCED,
      profile: "Broken" as never,
      gate: {
        ...POLICY_BALANCED.gate,
        criticalOpposingModules: ["CompanyMonitor", "UnknownModule"],
      },
    };
    assert.throws(() => validatePolicyConfig(broken), /unknown module/);
  });
});
