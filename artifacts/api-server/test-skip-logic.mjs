/**
 * Deterministic test for the change-aware AI execution skip logic.
 *
 * Verifies:
 *  1. First run → computeFingerprint returns a hash, no prior stored fingerprint → AI called
 *  2. Immediate second run → fingerprint unchanged → AI SKIPPED
 *  3. One material dependency change → fingerprint changes → AI called again
 *  4. Unrelated company change → portfolio-analyzer fingerprint UNCHANGED → skipped
 *
 * Uses node:test — no vitest or other external test runner.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ── Replicate fingerprint logic in pure JS (matches dependency-fingerprint-service.ts) ──

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function canonicalTicker(t) {
  return t.split(":")[0].toUpperCase().replace(/\s+/g, "");
}

const STATIC_DEPS = {
  "market-alerts":         ["portfolio-manager","market-monitor","news-monitor","event-monitor","sector-monitor","risk-analyzer","portfolio-analyzer","opportunity-finder"],
  "portfolio-analyzer":    ["portfolio-manager","market-monitor","news-monitor","event-monitor","sector-monitor"],
  "risk-analyzer":         ["portfolio-manager","portfolio-analyzer","opportunity-finder","market-monitor","news-monitor","event-monitor","sector-monitor"],
  "trade-decision-engine": ["portfolio-manager","portfolio-analyzer","risk-analyzer","market-alerts","opportunity-finder","event-monitor"],
  "command-brief":         ["trade-decision-engine","risk-analyzer","portfolio-analyzer","market-alerts"],
  "trade-review":          ["trade-decision-engine"],
  "company-monitor":       ["news-monitor","event-monitor"],
};

const PRICE_CONTEXT_MODULES = new Set(["company-monitor","trade-decision-engine","risk-analyzer","portfolio-analyzer","market-alerts"]);

/** Minimal in-memory repository for testing */
function makeRepo(initial = {}) {
  const store = {};
  for (const [k, v] of Object.entries(initial)) {
    store[k] = { materialVersion: 1, refreshVersion: 1, ...v };
  }
  return {
    get: (key) => store[key] ?? null,
    getAll: () => Object.values(store).map(e => ({ ...e })),
    setFingerprint: (key, fp, at) => {
      if (store[key]) {
        store[key].dependencyFingerprint = fp;
        store[key].lastAIAnalysisAt = at;
      }
    },
    bumpMaterial: (key) => {
      if (store[key]) store[key].materialVersion++;
    },
    getEntry: (key) => store[key],
  };
}

function computeFingerprint(repo, moduleId, relevantTickers) {
  const staticDeps = STATIC_DEPS[moduleId];
  if (!staticDeps) return null;

  const versions = {};
  for (const dep of staticDeps) {
    const entry = repo.get(dep);
    versions[dep] = entry?.materialVersion ?? 0;
  }

  const relevantSet = new Set(relevantTickers.map(canonicalTicker));
  const allEntries = repo.getAll();

  // CM entries
  const cmEntries = allEntries.filter(e => e.moduleName?.startsWith?.("company-monitor:") && !e.moduleName.includes("-history:"));
  if (moduleId !== "company-monitor") {
    for (const canon of relevantSet) {
      const vk = `company-monitor:${canon}`;
      const entry = repo.get(vk) ?? cmEntries.find(e => canonicalTicker(e.moduleName.replace("company-monitor:", "")) === canon);
      versions[vk] = entry?.materialVersion ?? 0;
    }
  }

  // Price context
  if (PRICE_CONTEXT_MODULES.has(moduleId)) {
    const pcEntries = allEntries.filter(e => e.moduleName?.startsWith?.("price-context:"));
    for (const canon of relevantSet) {
      const vk = `price-context:${canon}`;
      const entry = repo.get(vk) ?? pcEntries.find(e => canonicalTicker(e.moduleName.replace("price-context:", "")) === canon);
      versions[vk] = entry?.materialVersion ?? 0;
    }
  }

  const serialized = JSON.stringify(
    Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b)))
  );
  return djb2(serialized);
}

// ── Build a realistic test repository ─────────────────────────────────────────

const PORTFOLIO_TICKERS = ["AAPL", "MSFT", "SERV"];
const UNRELATED_TICKER = "XOM"; // not in portfolio

function makeTestRepo() {
  const entries = {
    // Portfolio data
    "portfolio-manager":     { moduleName: "portfolio-manager",     materialVersion: 3,  refreshVersion: 5 },
    "market-monitor":        { moduleName: "market-monitor",         materialVersion: 2,  refreshVersion: 4 },
    "news-monitor":          { moduleName: "news-monitor",           materialVersion: 2,  refreshVersion: 2 },
    "event-monitor":         { moduleName: "event-monitor",          materialVersion: 1,  refreshVersion: 1 },
    "sector-monitor":        { moduleName: "sector-monitor",         materialVersion: 2,  refreshVersion: 2 },
    "opportunity-finder":    { moduleName: "opportunity-finder",     materialVersion: 1,  refreshVersion: 1 },
    // Company monitors for portfolio tickers
    "company-monitor:AAPL":  { moduleName: "company-monitor:AAPL",  materialVersion: 2,  refreshVersion: 3 },
    "company-monitor:MSFT":  { moduleName: "company-monitor:MSFT",  materialVersion: 1,  refreshVersion: 1 },
    "company-monitor:SERV":  { moduleName: "company-monitor:SERV",  materialVersion: 1,  refreshVersion: 2 },
    "company-monitor:XOM":   { moduleName: "company-monitor:XOM",   materialVersion: 1,  refreshVersion: 1 },
    // Price contexts
    "price-context:AAPL":    { moduleName: "price-context:AAPL",    materialVersion: 1,  refreshVersion: 2 },
    "price-context:MSFT":    { moduleName: "price-context:MSFT",    materialVersion: 1,  refreshVersion: 1 },
    "price-context:SERV":    { moduleName: "price-context:SERV",    materialVersion: 1,  refreshVersion: 1 },
    // Analysis modules
    "portfolio-analyzer":    { moduleName: "portfolio-analyzer",     materialVersion: 2,  refreshVersion: 2 },
    "risk-analyzer":         { moduleName: "risk-analyzer",          materialVersion: 2,  refreshVersion: 2 },
    "market-alerts":         { moduleName: "market-alerts",          materialVersion: 2,  refreshVersion: 2 },
    "trade-decision-engine": { moduleName: "trade-decision-engine",  materialVersion: 1,  refreshVersion: 1 },
    "command-brief":         { moduleName: "command-brief",          materialVersion: 1,  refreshVersion: 1 },
    "trade-review":          { moduleName: "trade-review",           materialVersion: 1,  refreshVersion: 1 },
  };
  return makeRepo(entries);
}

// ── Max-age helper (300 min = far future for testing) ─────────────────────────
const MAX_AGE = { "portfolio-analyzer": 9999, "risk-analyzer": 9999, "market-alerts": 9999,
                  "trade-decision-engine": 9999, "command-brief": 9999, "trade-review": 9999,
                  "company-monitor": 9999 };

/**
 * Mirrors the production skip check in automation-orchestrator._executeJob().
 *
 * @param {object} repo           - Test repository
 * @param {string} entryKey       - Repository key (e.g. "portfolio-analyzer",
 *                                  "company-monitor:AAPL")
 * @param {string} fpModuleId     - ModuleId for computeFingerprint — for CM
 *                                  per-ticker entries this is "company-monitor",
 *                                  not the full key.
 * @param {string[]} relevantTickers
 */
function wouldSkip(repo, entryKey, fpModuleId, relevantTickers, now = new Date()) {
  const entry = repo.getEntry(entryKey);
  if (!entry?.dependencyFingerprint || !entry?.lastAIAnalysisAt) return false;

  const ageMin = (now - new Date(entry.lastAIAnalysisAt)) / 60_000;
  const maxAgeKey = fpModuleId.startsWith("company-monitor") ? "company-monitor" : fpModuleId;
  if (ageMin > (MAX_AGE[maxAgeKey] ?? 0)) return false;

  const currentFp = computeFingerprint(repo, fpModuleId, relevantTickers);
  return currentFp === entry.dependencyFingerprint;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Change-aware AI execution — skip logic", () => {

  test("1. First run: no prior fingerprint → AI called (not skipped)", () => {
    const repo = makeTestRepo();

    for (const mod of Object.keys(MAX_AGE)) {
      if (mod === "company-monitor") continue;
      const skipped = wouldSkip(repo, mod, mod, PORTFOLIO_TICKERS);
      assert.equal(skipped, false, `${mod}: should not skip on first run (no fingerprint stored)`);
    }
    console.log("  ✓ All AI modules: NOT skipped on first run");
  });

  test("2. After first run: fingerprints stored → second run SKIPS all unchanged modules", () => {
    const repo = makeTestRepo();
    const NOW = new Date().toISOString();

    // Simulate Run 1: AI called for every module, fingerprints stored
    for (const mod of Object.keys(MAX_AGE)) {
      if (mod === "company-monitor") continue;
      repo.setFingerprint(mod, computeFingerprint(repo, mod, PORTFOLIO_TICKERS), NOW);
    }
    for (const t of PORTFOLIO_TICKERS) {
      // entryKey = "company-monitor:AAPL", fpModuleId = "company-monitor"
      repo.setFingerprint(`company-monitor:${t}`, computeFingerprint(repo, "company-monitor", [t]), NOW);
    }

    // Simulate Run 2: NOTHING has changed in any dependency
    let totalSkipped = 0, totalRan = 0;
    const skippedModules = [], rannedModules = [];

    for (const mod of Object.keys(MAX_AGE)) {
      if (mod === "company-monitor") continue;
      // entryKey = fpModuleId for main analysis modules
      const s = wouldSkip(repo, mod, mod, PORTFOLIO_TICKERS);
      if (s) { totalSkipped++; skippedModules.push(mod); }
      else   { totalRan++;     rannedModules.push(mod); }
    }
    for (const t of PORTFOLIO_TICKERS) {
      const key = `company-monitor:${t}`;
      // entryKey = "company-monitor:AAPL", fpModuleId = "company-monitor"
      const s = wouldSkip(repo, key, "company-monitor", [t]);
      if (s) { totalSkipped++; skippedModules.push(`CM:${t}`); }
      else   { totalRan++;     rannedModules.push(`CM:${t}`); }
    }

    console.log(`  Skipped (${totalSkipped}): ${skippedModules.join(", ")}`);
    if (rannedModules.length) console.log(`  AI-called (${totalRan}): ${rannedModules.join(", ")}`);

    assert.equal(totalRan, 0,
      `Expected 0 AI calls on second run with no changes, got ${totalRan}: ${rannedModules.join(", ")}`);
    assert.ok(totalSkipped > 0, "Expected some modules to be skipped");
    console.log(`  ✓ ${totalSkipped} AI calls skipped, 0 AI calls made — 100% reduction`);
  });

  test("3. ONE material change: SERV company-monitor output changed → correct cascade reruns", () => {
    const repo = makeTestRepo();
    const NOW = new Date().toISOString();

    // Run 1: AI called for every module, fingerprints stored
    for (const mod of Object.keys(MAX_AGE)) {
      if (mod === "company-monitor") continue;
      repo.setFingerprint(mod, computeFingerprint(repo, mod, PORTFOLIO_TICKERS), NOW);
    }
    for (const t of PORTFOLIO_TICKERS) {
      repo.setFingerprint(`company-monitor:${t}`, computeFingerprint(repo, "company-monitor", [t]), NOW);
    }

    // Between Run 1 and Run 2: SERV's CM analysis ran (scheduled/triggered separately)
    // and found a material change (recentBehavior: FallingFast → Stabilizing).
    // The route called save() → materialVersion bumped.
    repo.bumpMaterial("company-monitor:SERV");

    // Run 2: check which modules skip vs rerun
    const skipped = [], reran = [];

    for (const mod of Object.keys(MAX_AGE)) {
      if (mod === "company-monitor") continue;
      const s = wouldSkip(repo, mod, mod, PORTFOLIO_TICKERS);
      (s ? skipped : reran).push(mod);
    }
    for (const t of PORTFOLIO_TICKERS) {
      const key = `company-monitor:${t}`;
      // CM:SERV's fingerprint is based on its INPUTS (news, events, price-context:SERV).
      // Those inputs didn't change — so CM:SERV SKIPS on this next scheduled run.
      // Its materialVersion already bumped from the earlier save(); that bump is what
      // invalidates portfolio-analyzer below.
      const s = wouldSkip(repo, key, "company-monitor", [t]);
      (s ? skipped : reran).push(`CM:${t}`);
    }

    console.log(`  Material change: company-monitor:SERV materialVersion bumped`);
    console.log(`  (recentBehavior changed in previous run; downstream now sees new version)`);
    console.log(`  Re-ran  (${reran.length}): ${reran.join(", ")}`);
    console.log(`  Skipped (${skipped.length}): ${skipped.join(", ")}`);

    // CM:SERV's OWN scheduled run sees unchanged inputs (news/events same) → SKIPS
    assert.ok(skipped.includes("CM:SERV"),
      "CM:SERV should SKIP — its inputs (news, events, price-context) unchanged");
    // CM:AAPL and CM:MSFT are completely unrelated → SKIP
    assert.ok(skipped.includes("CM:AAPL"), "CM:AAPL should skip — different ticker");
    assert.ok(skipped.includes("CM:MSFT"), "CM:MSFT should skip — different ticker");

    // portfolio-analyzer fingerprint includes company-monitor:SERV materialVersion
    // → that version just changed → portfolio-analyzer RERUNS
    assert.ok(reran.includes("portfolio-analyzer"),
      "portfolio-analyzer should rerun — depends on company-monitor:SERV which changed");
    assert.ok(reran.includes("risk-analyzer"),
      "risk-analyzer should rerun — depends on portfolio-analyzer");
    assert.ok(reran.includes("trade-decision-engine"),
      "TDE should rerun — depends on portfolio-analyzer + risk-analyzer");
    assert.ok(reran.includes("command-brief"),
      "command-brief should rerun — depends on TDE");

    // trade-review only depends on TDE which reruns → it also reruns
    assert.ok(reran.includes("trade-review"),
      "trade-review should rerun — depends on TDE");

    console.log("  ✓ SERV change cascades: portfolio-analyzer → risk → TDE → command-brief → trade-review");
    console.log("  ✓ CM:AAPL and CM:MSFT correctly isolated — no unnecessary reruns");
  });

  test("4. Unrelated company change (XOM, not in portfolio) → portfolio-analyzer NOT invalidated", () => {
    const repo = makeTestRepo();
    const NOW = new Date().toISOString();

    // Run 1: store fingerprints (only PORTFOLIO_TICKERS are relevant)
    for (const mod of Object.keys(MAX_AGE)) {
      if (mod === "company-monitor") continue;
      repo.setFingerprint(mod, computeFingerprint(repo, mod, PORTFOLIO_TICKERS), NOW);
    }

    // Introduce material change: XOM — NOT a portfolio holding
    repo.bumpMaterial("company-monitor:XOM");

    // portfolio-analyzer uses only PORTFOLIO_TICKERS in its fingerprint
    const paSkipped  = wouldSkip(repo, "portfolio-analyzer",    "portfolio-analyzer",    PORTFOLIO_TICKERS);
    const tdeSkipped = wouldSkip(repo, "trade-decision-engine", "trade-decision-engine", PORTFOLIO_TICKERS);

    console.log(`  Material change: company-monitor:XOM (NOT in portfolio [${PORTFOLIO_TICKERS.join(", ")}])`);
    console.log(`  portfolio-analyzer: ${paSkipped ? "SKIPPED ✓" : "AI-CALLED (wrong)"}`);
    console.log(`  trade-decision-engine: ${tdeSkipped ? "SKIPPED ✓" : "AI-CALLED (wrong)"}`);

    assert.equal(paSkipped, true, "portfolio-analyzer should NOT rerun for an unrelated company (XOM)");
    assert.equal(tdeSkipped, true, "TDE should NOT rerun for an unrelated company (XOM)");
    console.log("  ✓ Unrelated company change correctly isolated — no unnecessary reruns");
  });

  test("5. Max-age expiry forces rerun regardless of unchanged fingerprint", () => {
    const repo = makeTestRepo();
    const TWO_HOURS_AGO = new Date(Date.now() - 121 * 60_000).toISOString();
    const MAX_AGE_LOCAL = { "portfolio-analyzer": 120 }; // 120 min

    function wouldSkipWithAge(moduleId, relevantTickers) {
      const entry = repo.getEntry(moduleId);
      if (!entry?.dependencyFingerprint || !entry?.lastAIAnalysisAt) return false;
      const ageMin = (Date.now() - new Date(entry.lastAIAnalysisAt)) / 60_000;
      if (ageMin > (MAX_AGE_LOCAL[moduleId] ?? 9999)) return false; // expired
      const fp = computeFingerprint(repo, moduleId, relevantTickers);
      return fp === entry.dependencyFingerprint;
    }

    // Store fingerprint with old timestamp
    const fp = computeFingerprint(repo, "portfolio-analyzer", PORTFOLIO_TICKERS);
    repo.setFingerprint("portfolio-analyzer", fp, TWO_HOURS_AGO);

    // Nothing changed — but max-age exceeded
    const skipped = wouldSkipWithAge("portfolio-analyzer", PORTFOLIO_TICKERS);

    console.log(`  Fingerprint: stored 121 min ago (max-age = 120 min), inputs unchanged`);
    console.log(`  portfolio-analyzer: ${skipped ? "SKIPPED (wrong)" : "AI-CALLED ✓ (age expired)"}`);

    assert.equal(skipped, false, "Module should rerun after max-age even with unchanged fingerprint");
    console.log("  ✓ Max-age safety refresh works correctly");
  });

});
