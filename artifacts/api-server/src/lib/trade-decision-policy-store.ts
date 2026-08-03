/**
 * Trade Decision Policy Store
 *
 * Manages the active policy profile selection.  Persists the selected profile
 * to the analysis repository so it survives server restarts.
 *
 * Usage:
 *   import { initPolicyStore, getActivePolicyConfig, setActivePolicyProfile } from "./trade-decision-policy-store";
 *
 *   // During server startup (before any TDE calls):
 *   initPolicyStore();
 *
 *   // Inside any route:
 *   const policy = getActivePolicyConfig();
 */
import { analysisRepository } from "./analysis-repository.js";
import { systemLog } from "./system-log.js";
import {
  type PolicyProfile,
  type TradePolicyConfig,
  POLICY_CONFIGS,
  validateAllProfiles,
} from "./trade-decision-policy-config.js";

const STORE_KEY = "trade-decision-policy-settings";

// ---------------------------------------------------------------------------
// In-memory state (single copy, updated synchronously)
// ---------------------------------------------------------------------------

let _activeProfile: PolicyProfile = "Balanced";
let _activeConfig:  TradePolicyConfig = POLICY_CONFIGS.Balanced;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Call once during server startup.
 * 1. Validates all built-in profiles (fail-fast on misconfiguration).
 * 2. Loads the persisted profile selection from the repository.
 */
export function initPolicyStore(): void {
  // Validate every built-in profile at startup — fail loudly if broken
  validateAllProfiles();

  const entry = analysisRepository.get<{ profile: string }>(STORE_KEY);
  const saved = entry?.result?.profile;

  if (saved && saved in POLICY_CONFIGS) {
    _activeProfile = saved as PolicyProfile;
    _activeConfig  = POLICY_CONFIGS[_activeProfile];
    systemLog.logInternal("Settings", `Trade decision policy loaded: ${_activeProfile}`);
  } else {
    _activeProfile = "Balanced";
    _activeConfig  = POLICY_CONFIGS.Balanced;
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getActivePolicyProfile(): PolicyProfile {
  return _activeProfile;
}

export function getActivePolicyConfig(): TradePolicyConfig {
  return _activeConfig;
}

export function getActivePolicySettings(): {
  profile: PolicyProfile;
  updatedAt: string | null;
} {
  const entry = analysisRepository.get<{ profile: string; updatedAt?: string }>(STORE_KEY);
  return {
    profile:   _activeProfile,
    updatedAt: entry?.result?.updatedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Changes the active policy profile.
 *
 * - Updates the in-memory cache immediately (all subsequent TDE runs use the new profile).
 * - Persists to the analysis repository.
 * - Logs the change to System Log.
 * - Does NOT retroactively mutate stored decisions.
 *
 * @throws {Error} if the profile name is not recognised.
 */
export function setActivePolicyProfile(profile: PolicyProfile): void {
  if (!(profile in POLICY_CONFIGS)) {
    throw new Error(`Unknown policy profile: "${profile}". Valid profiles: ${Object.keys(POLICY_CONFIGS).join(", ")}`);
  }

  const previous = _activeProfile;
  _activeProfile  = profile;
  _activeConfig   = POLICY_CONFIGS[profile];

  const updatedAt = new Date().toISOString();
  analysisRepository.save(STORE_KEY, { profile, updatedAt });

  if (previous !== profile) {
    systemLog.logInfo(
      "Settings",
      `Trade decision policy changed: ${previous} → ${profile}. ` +
      `Existing decisions are not modified — new profile applies from the next Trade Decision run.`
    );
  }
}
