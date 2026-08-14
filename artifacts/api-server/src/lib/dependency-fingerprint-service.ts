/**
 * Dependency Fingerprint Service
 *
 * Provides deterministic dependency fingerprinting for AI analysis modules.
 * Used by the Automation Orchestrator to decide whether to skip an AI call
 * when none of the relevant inputs have materially changed since the last run.
 *
 * IMPORTANT: No AI calls are made here. Everything is deterministic computation.
 */

import { analysisRepository } from "./analysis-repository.js";

// ── Per-module maximum analysis age ───────────────────────────────────────────

/**
 * Maximum age (minutes) before a module must rerun its AI call even when the
 * dependency fingerprint has not changed. This prevents stale analyses from
 * persisting indefinitely even when inputs are stable.
 *
 * Only modules that can be fingerprint-skipped appear here.
 */
export const AI_MODULE_MAX_AGE_MINUTES: Record<string, number> = {
  "company-monitor":       240,  // 4 hours — per-ticker, age-gated; deps drive any earlier rerun
  "market-alerts":         120,  // 2 hours
  "portfolio-analyzer":    240,  // 4 hours
  "risk-analyzer":         240,  // 4 hours
  "trade-decision-engine": 360,  // 6 hours
  "command-brief":         360,  // 6 hours
  "trade-review":          480,  // 8 hours
};

/**
 * Minimum age (minutes) before an external observation module may repeat its
 * web-search AI call on a normal (non-force) run.
 *
 * Prevents redundant calls caused by repeated Run All clicks, overlapping
 * dependency triggers, or multiple pipeline paths requesting the same module
 * within minutes of a successful run.
 *
 * Force AI Refresh always bypasses this guard.
 * Company Monitor uses its own fingerprint/discovery gate instead.
 * Investor Watch uses its own discovery/schedule behavior.
 */
export const OBSERVATION_MODULE_MIN_REFRESH_MINUTES: Record<string, number> = {
  "market-monitor":     15,
  "news-monitor":       15,
  "event-monitor":      60,
  "sector-monitor":    180,
  "opportunity-finder": 180,
};

// ── Static dependency configs ─────────────────────────────────────────────────

/**
 * Static repository keys whose materialVersion contributes to each module's fingerprint.
 * Company Monitor and Price Context keys are added dynamically per relevant-ticker set.
 */
const STATIC_DEPS: Record<string, string[]> = {
  // Observation module — no static repo deps (content comes from web search),
  // but fingerprinted so that material news/event changes trigger a rerun and
  // unchanged tickers are skipped after AI_MODULE_MAX_AGE_MINUTES.
  "company-monitor": ["news-monitor", "event-monitor"],

  "portfolio-analyzer": [
    "portfolio-manager",
    "market-monitor", "news-monitor", "event-monitor", "sector-monitor",
  ],
  "risk-analyzer": [
    "portfolio-manager",
    "portfolio-analyzer", "opportunity-finder",
    "market-monitor", "news-monitor", "event-monitor", "sector-monitor",
  ],
  "market-alerts": [
    "portfolio-manager",
    "market-monitor", "news-monitor", "event-monitor", "sector-monitor",
    "risk-analyzer", "portfolio-analyzer", "opportunity-finder",
  ],
  // Catalyst Intelligence promotions make OF eligible for reassessment when a new
  // pre-event opportunity is identified. This is the critical link: promotion → OF wakes.
  "opportunity-finder": [
    "catalyst-promotions",
  ],
  "trade-decision-engine": [
    "portfolio-manager",
    "portfolio-analyzer", "risk-analyzer", "market-alerts", "opportunity-finder",
    "event-monitor",
    // Catalyst Intelligence promotions — material catalyst promotion bumps TDE fingerprint
    // so the Trade Decision Engine reassesses when a new pre-event opportunity is identified.
    "catalyst-promotions",
  ],
  "command-brief": [
    "trade-decision-engine", "risk-analyzer", "portfolio-analyzer", "market-alerts",
  ],
  "trade-review": [
    "trade-decision-engine",
  ],
};

// ── Modules that include price-context in their fingerprint ───────────────────

const PRICE_CONTEXT_FINGERPRINT_MODULES = new Set([
  "company-monitor",       // per-ticker price context (only the ticker being analysed)
  "trade-decision-engine",
  "risk-analyzer",
  "portfolio-analyzer",
  "market-alerts",
]);

// ── Canonical ticker normalization ────────────────────────────────────────────

/**
 * Produce a canonical ticker identifier for use as a fingerprint dependency key.
 *
 * Bridges the two ticker formats that coexist in the repository:
 *   - Exchange-qualified Saxo symbols  e.g. "NOVOb:xcse", "SERV:xnas"
 *   - AI/display tickers               e.g. "NOVO B", "SERV", "AAPL"
 *
 * Both map to the same canonical form so fingerprints are stable across the
 * sources that feed `computeFingerprint`:
 *   "NOVOb:xcse"  → strip exchange → "NOVOb"  → uppercase, strip spaces → "NOVOB"
 *   "NOVO B"      → no exchange    → "NOVO B" → uppercase, strip spaces → "NOVOB"
 *   "SERV:xnas"   → strip exchange → "SERV"   → uppercase, strip spaces → "SERV"
 *
 * Used only for fingerprint version-key construction and CM entry lookups.
 * Repository keys themselves are NOT changed by this function.
 */
export function canonicalCmTicker(ticker: string): string {
  const base = ticker.split(":")[0];              // strip exchange qualifier
  return base.toUpperCase().replace(/\s+/g, "");  // uppercase + strip spaces
}

// ── Hash function (djb2-inspired, 32-bit, no external packages) ───────────────

function hash32(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

// ── Fingerprint computation ───────────────────────────────────────────────────

/**
 * Compute a deterministic fingerprint for an AI module's dependency inputs.
 *
 * The fingerprint is a short hash of the materialVersion of each relevant
 * dependency entry. When any dependency's materialVersion changes (because
 * its content materially changed), the fingerprint changes, and the module
 * will rerun its AI call on the next scheduled execution.
 *
 * Returns null if the module is not fingerprint-aware (= always run).
 *
 * @param moduleId        The analysis module being fingerprinted
 * @param relevantTickers Portfolio holdings + TDE subjects + OF candidates (uppercase)
 */
export function computeFingerprint(
  moduleId: string,
  relevantTickers: string[]
): string | null {
  const staticDeps = STATIC_DEPS[moduleId];
  if (!staticDeps) return null; // module has no fingerprint config

  const versions: Record<string, number> = {};

  // Static dependencies — same for every run of this module
  for (const dep of staticDeps) {
    const entry = analysisRepository.get(dep);
    versions[dep] = entry?.materialVersion ?? 0;
  }

  const relevantSet = new Set(relevantTickers.map(t => t.toUpperCase()));

  // Company Monitor per-ticker entries — included for analysis modules so a
  // material company news change cascades to downstream reruns.
  // Excluded when computing CM's own fingerprint to avoid circular self-reference.
  //
  // Ticker normalization: portfolio symbols use exchange-qualified Saxo format
  // (e.g. "NOVOB:XCSE") while CM entries are stored under display tickers
  // (e.g. "NOVO B"). We canonicalize both forms (strip exchange + spaces,
  // uppercase) and scan all CM entries to find a match, ensuring fingerprints
  // are stable regardless of which ticker format the caller provides.
  if (moduleId !== "company-monitor") {
    const allCmEntries = analysisRepository.getAll()
      .filter(e => e.moduleName.startsWith("company-monitor:") && !e.moduleName.includes("-history:"));

    for (const ticker of relevantSet) {
      const canon = canonicalCmTicker(ticker);
      const versionKey = `company-monitor:${canon}`;

      // Prefer exact canonical-key hit; fall back to scanning for a matching entry
      const entry =
        analysisRepository.get(versionKey) ??
        allCmEntries.find(e => canonicalCmTicker(e.moduleName.replace("company-monitor:", "")) === canon);

      versions[versionKey] = entry?.materialVersion ?? 0;
    }
  }

  // Price Context — relevant tickers only, for modules that use price data.
  // For company-monitor the caller passes only the single ticker being analysed.
  //
  // Same canonical normalization as CM: price-context is stored under the
  // symbol form used when fetched (e.g. "NOVO B", "SERV", "SERV:XNAS"), while
  // portfolio tickers arrive here as Saxo-qualified strings ("NOVOB:XCSE").
  // We scan all price-context entries and match via canonical form so the
  // fingerprint correctly tracks real entries across ticker format variants.
  if (PRICE_CONTEXT_FINGERPRINT_MODULES.has(moduleId)) {
    const allPcEntries = analysisRepository.getAll()
      .filter(e => e.moduleName.startsWith("price-context:"));

    for (const ticker of relevantSet) {
      const canon = canonicalCmTicker(ticker); // strip exchange qualifier + spaces, uppercase
      const versionKey = `price-context:${canon}`;

      // Prefer exact canonical-key hit; fall back to scanning for a matching entry
      const entry =
        analysisRepository.get(versionKey) ??
        allPcEntries.find(e => canonicalCmTicker(e.moduleName.replace("price-context:", "")) === canon);

      versions[versionKey] = entry?.materialVersion ?? 0;
    }
  }

  // Stable serialization: sort keys so insertion order never affects the hash
  const serialized = JSON.stringify(
    Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b)))
  );

  return hash32(serialized);
}
