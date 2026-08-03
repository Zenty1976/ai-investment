/**
 * Trade Decision Policy Configuration
 *
 * Single source of truth for all evidence weights, band thresholds, gate
 * requirements, and readiness thresholds used by the Trade Decision Engine.
 *
 * Profiles (Conservative, Balanced, Aggressive) adjust the deterministic
 * backend rules only — they never change the OpenAI prompt.
 *
 * Hard safety invariants that NO profile may bypass:
 *   - blockedByEvent must be false for ReadyForReview
 *   - valid current portfolio data is required
 *   - valid price and sizing data are required
 *   - critical opposing evidence from CompanyMonitor or RiskAnalyzer always blocks
 *   - no Low-confidence ReadyForReview
 *   - no direct order creation or Saxo execution
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyProfile = "Conservative" | "Balanced" | "Aggressive";

export interface ModuleWeights {
  /**
   * Maximum supporting score contribution (+ve integer).
   * The function scales sub-conditions proportionally within this ceiling.
   */
  supporting: number;
  /**
   * Maximum opposing penalty (must be zero or negative).
   */
  opposing: number;
  /** Staleness penalty when module data exceeds the freshness threshold (must be <= 0). */
  stale: number;
  /** Missing-data penalty when no module data is available at all (must be <= 0). */
  missing: number;
}

export interface TradePolicyConfig {
  readonly profile: PolicyProfile;

  /** Evidence band score boundaries. */
  readonly bands: {
    /** score >= strongMinimum    → "Strong"      */
    readonly strongMinimum:    number;
    /** score >= adequateMinimum  → "Adequate"    */
    readonly adequateMinimum:  number;
    /** score >= weakMinimum      → "Weak"        */
    readonly weakMinimum:      number;
    // score < weakMinimum         → "Insufficient"
  };

  /** Directional evidence gate (Prepare* decisions). */
  readonly gate: {
    /** Minimum number of data-driven Supporting modules required for gate to pass. */
    readonly minimumSupportingModules:              number;
    /** Modules that trigger a gate failure when they classify as Opposing. */
    readonly criticalOpposingModules:               string[];
    /**
     * When true, Holding/Opportunity PrepareToBuy/PrepareToReduce decisions
     * gate-fail if CompanyMonitor data is missing or stale.
     * (Conservative only — Balanced/Aggressive allow missing CM.)
     */
    readonly requireCompanyMonitorForCompanyTrades: boolean;
  };

  /** Thresholds that control when a Prepare* decision is ReadyForReview. */
  readonly readyForReview: {
    /** Minimum evidence score for ReadyForReview status. */
    readonly minimumEvidenceScore: number;
    /**
     * Minimum confidence level allowed for ReadyForReview.
     * "Medium" → Low is blocked; "High" → only High passes.
     * "Low" is never allowed regardless of profile (hard safety rule).
     */
    readonly minimumConfidence: "Medium" | "High";
    /**
     * Maximum targetAllocationPercent for any ReadyForReview decision.
     * null = no limit.  Conservative uses 12 to prevent oversizing.
     */
    readonly maximumTargetAllocationPercent: number | null;
  };

  /** Score-based decision-type downgrade thresholds. */
  readonly downgrade: {
    /**
     * Prepare* with evidenceScore < reviewThreshold → downgraded to Review.
     * Conservative raises this to catch marginally supported ideas earlier.
     */
    readonly reviewThreshold:   number;
    /**
     * Review with evidenceScore < noActionThreshold → downgraded to NoAction.
     * Aggressive may lower this to allow more Review decisions through.
     */
    readonly noActionThreshold: number;
  };

  /** Per-module evidence weights for the directional classification function. */
  readonly evidenceWeights: {
    readonly CompanyMonitor:    ModuleWeights;
    readonly RiskAnalyzer:      ModuleWeights;
    readonly OpportunityFinder: ModuleWeights;
    readonly PortfolioAnalyzer: ModuleWeights;
    readonly MarketAlerts:      ModuleWeights;
  };

  /** Maximum module data age (hours) before data is considered stale. */
  readonly stalenessHours: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class PolicyConfigValidationError extends Error {
  constructor(message: string) {
    super(`[TradePolicyConfig] Invalid configuration: ${message}`);
    this.name = "PolicyConfigValidationError";
  }
}

export function validatePolicyConfig(cfg: TradePolicyConfig): void {
  // Evidence bands must be ordered correctly
  if (cfg.bands.strongMinimum <= cfg.bands.adequateMinimum) {
    throw new PolicyConfigValidationError(
      `bands.strongMinimum (${cfg.bands.strongMinimum}) must be > bands.adequateMinimum (${cfg.bands.adequateMinimum})`
    );
  }
  if (cfg.bands.adequateMinimum <= cfg.bands.weakMinimum) {
    throw new PolicyConfigValidationError(
      `bands.adequateMinimum (${cfg.bands.adequateMinimum}) must be > bands.weakMinimum (${cfg.bands.weakMinimum})`
    );
  }
  if (cfg.bands.weakMinimum < 0) {
    throw new PolicyConfigValidationError(
      `bands.weakMinimum (${cfg.bands.weakMinimum}) must be >= 0`
    );
  }

  // Gate requirements
  if (cfg.gate.minimumSupportingModules < 1) {
    throw new PolicyConfigValidationError(
      `gate.minimumSupportingModules must be at least 1, got ${cfg.gate.minimumSupportingModules}`
    );
  }
  if (cfg.gate.criticalOpposingModules.length === 0) {
    throw new PolicyConfigValidationError(
      "gate.criticalOpposingModules must contain at least one module"
    );
  }

  // Readiness thresholds
  if (cfg.readyForReview.minimumEvidenceScore < 0) {
    throw new PolicyConfigValidationError(
      `readyForReview.minimumEvidenceScore must be >= 0, got ${cfg.readyForReview.minimumEvidenceScore}`
    );
  }
  if (
    cfg.readyForReview.maximumTargetAllocationPercent !== null &&
    (cfg.readyForReview.maximumTargetAllocationPercent <= 0 ||
      cfg.readyForReview.maximumTargetAllocationPercent > 100)
  ) {
    throw new PolicyConfigValidationError(
      `readyForReview.maximumTargetAllocationPercent must be in (0, 100] or null`
    );
  }

  // Downgrade thresholds must be within the evidence score range
  if (cfg.downgrade.reviewThreshold < cfg.downgrade.noActionThreshold) {
    throw new PolicyConfigValidationError(
      `downgrade.reviewThreshold (${cfg.downgrade.reviewThreshold}) must be >= downgrade.noActionThreshold (${cfg.downgrade.noActionThreshold})`
    );
  }
  if (cfg.downgrade.reviewThreshold > 100 || cfg.downgrade.noActionThreshold < -100) {
    throw new PolicyConfigValidationError(
      "downgrade thresholds must be in the range [-100, 100]"
    );
  }

  // Evidence weights per module
  for (const [mod, w] of Object.entries(cfg.evidenceWeights)) {
    if (w.supporting < 0) {
      throw new PolicyConfigValidationError(
        `evidenceWeights.${mod}.supporting must be >= 0`
      );
    }
    if (w.opposing > 0) {
      throw new PolicyConfigValidationError(
        `evidenceWeights.${mod}.opposing must be <= 0`
      );
    }
    if (w.stale > 0) {
      throw new PolicyConfigValidationError(
        `evidenceWeights.${mod}.stale must be <= 0`
      );
    }
    if (w.missing > 0) {
      throw new PolicyConfigValidationError(
        `evidenceWeights.${mod}.missing must be <= 0`
      );
    }
  }

  // Staleness hours must be positive
  for (const [mod, hours] of Object.entries(cfg.stalenessHours)) {
    if (hours <= 0) {
      throw new PolicyConfigValidationError(
        `stalenessHours.${mod} must be > 0`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Profile: Balanced (reproduces current behaviour exactly)
// ---------------------------------------------------------------------------

export const POLICY_BALANCED: TradePolicyConfig = {
  profile: "Balanced",

  bands: {
    strongMinimum:   50,
    adequateMinimum: 25,
    weakMinimum:     10,
  },

  gate: {
    minimumSupportingModules:              2,
    criticalOpposingModules:               ["CompanyMonitor", "RiskAnalyzer"],
    requireCompanyMonitorForCompanyTrades: false,
  },

  readyForReview: {
    minimumEvidenceScore:           25,
    minimumConfidence:              "Medium",
    maximumTargetAllocationPercent: null,
  },

  downgrade: {
    reviewThreshold:   10,
    noActionThreshold: 0,
  },

  evidenceWeights: {
    CompanyMonitor:    { supporting: 40, opposing: -35, stale: -10, missing: -5  },
    RiskAnalyzer:      { supporting: 20, opposing: -30, stale: -10, missing: -5  },
    OpportunityFinder: { supporting: 25, opposing: -15, stale: -5,  missing: -5  },
    PortfolioAnalyzer: { supporting: 15, opposing: -15, stale: -8,  missing: -5  },
    MarketAlerts:      { supporting: 15, opposing: -25, stale: -8,  missing: -5  },
  },

  stalenessHours: {
    "portfolio-manager":   4,
    "risk-analyzer":      48,
    "portfolio-analyzer": 48,
    "market-alerts":      24,
    "opportunity-finder": 72,
    "company-monitor":    72,
    "event-monitor":      72,
    "sector-monitor":    168,
  },
} as const;

// ---------------------------------------------------------------------------
// Profile: Conservative
// ---------------------------------------------------------------------------

export const POLICY_CONSERVATIVE: TradePolicyConfig = {
  profile: "Conservative",

  bands: {
    strongMinimum:   55,  // harder to reach "Strong"
    adequateMinimum: 35,  // "Adequate" requires more convergence
    weakMinimum:     15,
  },

  gate: {
    minimumSupportingModules:              3,   // needs three aligned sources
    criticalOpposingModules:               ["CompanyMonitor", "RiskAnalyzer"],
    requireCompanyMonitorForCompanyTrades: true,
  },

  readyForReview: {
    minimumEvidenceScore:           35,   // higher bar than Balanced (25)
    minimumConfidence:              "Medium",
    maximumTargetAllocationPercent: 12,   // prevents single large positions
  },

  downgrade: {
    reviewThreshold:   15,  // early demotion of marginal Prepare* ideas
    noActionThreshold: 5,   // stricter — marginal evidence gets NoAction
  },

  evidenceWeights: {
    // Stricter stale/missing penalties — stale/missing data is less tolerated
    CompanyMonitor:    { supporting: 40, opposing: -40, stale: -15, missing: -15 },
    RiskAnalyzer:      { supporting: 20, opposing: -35, stale: -15, missing: -10 },
    OpportunityFinder: { supporting: 25, opposing: -15, stale: -8,  missing: -8  },
    PortfolioAnalyzer: { supporting: 15, opposing: -15, stale: -12, missing: -8  },
    MarketAlerts:      { supporting: 15, opposing: -25, stale: -12, missing: -8  },
  },

  stalenessHours: {
    // Tighter freshness requirements
    "portfolio-manager":   4,
    "risk-analyzer":      36,  // 48 → 36
    "portfolio-analyzer": 36,  // 48 → 36
    "market-alerts":      18,  // 24 → 18
    "opportunity-finder": 48,  // 72 → 48
    "company-monitor":    48,  // 72 → 48
    "event-monitor":      48,
    "sector-monitor":    120,  // 168 → 120
  },
};

// ---------------------------------------------------------------------------
// Profile: Aggressive
// ---------------------------------------------------------------------------

export const POLICY_AGGRESSIVE: TradePolicyConfig = {
  profile: "Aggressive",

  bands: {
    strongMinimum:   45,   // Strong reached slightly more easily
    adequateMinimum: 20,   // Adequate threshold lowered
    weakMinimum:      8,
  },

  gate: {
    minimumSupportingModules:              1,   // one strong source may suffice
    criticalOpposingModules:               ["CompanyMonitor", "RiskAnalyzer"],  // NOT relaxed
    requireCompanyMonitorForCompanyTrades: false,
  },

  readyForReview: {
    minimumEvidenceScore:           15,   // lower bar (Balanced: 25)
    minimumConfidence:              "Medium",   // Low is ALWAYS blocked (hard safety)
    maximumTargetAllocationPercent: null,
  },

  downgrade: {
    reviewThreshold:    5,  // only very weak evidence triggers demotion
    noActionThreshold: -15, // very marginal evidence still produces a Review
  },

  evidenceWeights: {
    // Lighter stale/missing penalties — more tolerance for older data
    CompanyMonitor:    { supporting: 40, opposing: -35, stale: -6,  missing: -3  },
    RiskAnalyzer:      { supporting: 20, opposing: -30, stale: -6,  missing: -3  },
    OpportunityFinder: { supporting: 25, opposing: -15, stale: -3,  missing: -3  },
    PortfolioAnalyzer: { supporting: 15, opposing: -15, stale: -5,  missing: -3  },
    MarketAlerts:      { supporting: 15, opposing: -25, stale: -5,  missing: -3  },
  },

  stalenessHours: {
    // More lenient freshness — older data is still accepted
    "portfolio-manager":   4,
    "risk-analyzer":      72,   // 48 → 72
    "portfolio-analyzer": 72,   // 48 → 72
    "market-alerts":      36,   // 24 → 36
    "opportunity-finder": 96,   // 72 → 96
    "company-monitor":    96,   // 72 → 96
    "event-monitor":      96,
    "sector-monitor":    240,   // 168 → 240
  },
};

// ---------------------------------------------------------------------------
// Exported profile map
// ---------------------------------------------------------------------------

export const POLICY_CONFIGS: Record<PolicyProfile, TradePolicyConfig> = {
  Conservative: POLICY_CONSERVATIVE,
  Balanced:     POLICY_BALANCED,
  Aggressive:   POLICY_AGGRESSIVE,
};

/** Returns the named profile config, or Balanced as a safe fallback. */
export function getPolicyConfig(profile: PolicyProfile): TradePolicyConfig {
  return POLICY_CONFIGS[profile] ?? POLICY_CONFIGS.Balanced;
}

/**
 * Call during server startup. Validates all built-in profiles.
 * Throws PolicyConfigValidationError immediately if any profile is invalid.
 */
export function validateAllProfiles(): void {
  for (const [name, cfg] of Object.entries(POLICY_CONFIGS)) {
    try {
      validatePolicyConfig(cfg);
    } catch (err) {
      throw new PolicyConfigValidationError(
        `Built-in profile "${name}" failed validation: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
