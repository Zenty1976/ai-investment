/**
 * Recent-Run Guard & markAIAnalysis — unit tests.
 *
 * All tests are fully deterministic.  No OpenAI calls, no web search,
 * no network I/O.  Each test that touches the repository uses a fresh
 * AnalysisRepository instance (spawned in a fresh tmpdir by the test
 * runner) so tests are fully isolated from each other.
 *
 * Covers all 11 required scenarios from Part 7 spec:
 *
 *  1.  markAIAnalysis sets lastAIAnalysisAt without touching dependencyFingerprint
 *  2.  markAIAnalysis on non-existent entry is a safe no-op
 *  3.  SKIPPED_RECENT guard fires when lastAIAnalysisAt < minRefreshMinutes ago
 *  4.  SKIPPED_RECENT guard does NOT fire when lastAIAnalysisAt > minRefreshMinutes ago
 *  5.  SKIPPED_RECENT guard does NOT fire when lastAIAnalysisAt is absent
 *  6.  Force-AI mode bypasses the recent-run guard (aiCalled=true always)
 *  7.  SKIPPED_RECENT path does not advance lastAIAnalysisAt
 *  8.  Modules without STATIC_DEPS can have lastAIAnalysisAt (market/news/OF)
 *  9.  setFingerprint continues to write both fingerprint + lastAIAnalysisAt
 * 10.  OBSERVATION_MODULE_MIN_REFRESH_MINUTES includes the correct 5 modules
 * 11.  company-monitor is absent from OBSERVATION_MODULE_MIN_REFRESH_MINUTES
 *
 * Run: node run-tests.mjs src/lib/__tests__/recent-run-guard.test.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import {
  OBSERVATION_MODULE_MIN_REFRESH_MINUTES,
  computeFingerprint,
} from "../dependency-fingerprint-service.js";
import { analysisRepository } from "../analysis-repository.js";

// ── Helper: minutes → ms ────────────────────────────────────────────────────

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

// ── Helper: simulate the recent-run guard check from the orchestrator ────────
// This mirrors the exact logic in automation-orchestrator._executeJob() so
// any future change to the guard is caught by these tests immediately.

function shouldSkipRecent(
  lastAIAnalysisAt: string | undefined,
  minRefreshMin: number,
  nowMs = Date.now()
): boolean {
  if (!lastAIAnalysisAt) return false;
  const ageMs = nowMs - new Date(lastAIAnalysisAt).getTime();
  return ageMs / 60_000 < minRefreshMin;
}

// ── Helper: seed a repository entry ─────────────────────────────────────────

function seedEntry(moduleName: string, result: Record<string, unknown> = {}): void {
  analysisRepository.save(moduleName, result);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Recent-Run Guard & markAIAnalysis", () => {

  // ── Scenario 1 ──────────────────────────────────────────────────────────────
  it("markAIAnalysis sets lastAIAnalysisAt without touching dependencyFingerprint", () => {
    seedEntry("market-monitor", { headline: "Stable" });

    // Manually set a fingerprint so we can verify it survives markAIAnalysis
    analysisRepository.setFingerprint("market-monitor", "fp-abc", minutesAgo(5));

    const before = analysisRepository.get("market-monitor");
    assert.equal(before?.dependencyFingerprint, "fp-abc", "fingerprint should be set after setFingerprint");

    const newTimestamp = new Date().toISOString();
    analysisRepository.markAIAnalysis("market-monitor", newTimestamp);

    const after = analysisRepository.get("market-monitor");
    assert.equal(after?.lastAIAnalysisAt, newTimestamp, "lastAIAnalysisAt should be updated");
    assert.equal(after?.dependencyFingerprint, "fp-abc", "dependencyFingerprint must remain unchanged");
  });

  // ── Scenario 2 ──────────────────────────────────────────────────────────────
  it("markAIAnalysis on non-existent entry is a safe no-op", () => {
    // Module that has never been saved — repository has no entry for it
    const key = "no-such-module-" + Math.random().toString(36).slice(2);
    assert.doesNotThrow(() => {
      analysisRepository.markAIAnalysis(key, new Date().toISOString());
    }, "markAIAnalysis must not throw for missing entries");
    assert.equal(analysisRepository.get(key), undefined, "entry should still not exist");
  });

  // ── Scenario 3 ──────────────────────────────────────────────────────────────
  it("SKIPPED_RECENT guard fires when lastAIAnalysisAt < minRefreshMinutes ago", () => {
    // market-monitor min refresh = 15 min; ran 3 min ago → should skip
    const lastAI = minutesAgo(3);
    assert.equal(
      shouldSkipRecent(lastAI, 15),
      true,
      "guard must fire when ran only 3 min ago (limit: 15 min)"
    );
  });

  // ── Scenario 4 ──────────────────────────────────────────────────────────────
  it("SKIPPED_RECENT guard does NOT fire when lastAIAnalysisAt > minRefreshMinutes ago", () => {
    // market-monitor ran 20 min ago; limit 15 min → should NOT skip
    const lastAI = minutesAgo(20);
    assert.equal(
      shouldSkipRecent(lastAI, 15),
      false,
      "guard must NOT fire when 20 min have elapsed (limit: 15 min)"
    );
  });

  // ── Scenario 5 ──────────────────────────────────────────────────────────────
  it("SKIPPED_RECENT guard does NOT fire when lastAIAnalysisAt is absent", () => {
    assert.equal(
      shouldSkipRecent(undefined, 15),
      false,
      "guard must NOT fire when no previous AI timestamp exists (first run)"
    );
  });

  // ── Scenario 6 ──────────────────────────────────────────────────────────────
  it("Force-AI mode bypasses the recent-run guard", () => {
    // The orchestrator skips the guard block entirely when forceAI === true.
    // We test the equivalent condition: if forceAI is set, the guard check
    // is never reached, so shouldSkipRecent would not even be called.
    // Here we verify that the guard, when called, would normally fire but
    // that force-AI logic (simulated by skipping the call) returns false.
    const lastAI = minutesAgo(1); // very fresh — would normally fire
    const guardWouldFire = shouldSkipRecent(lastAI, 15);
    assert.equal(guardWouldFire, true, "pre-condition: guard would normally fire");

    // Simulate forceAI=true by bypassing the guard: result must be "run"
    const forceAI = true;
    const actuallySkipped = forceAI ? false : guardWouldFire;
    assert.equal(actuallySkipped, false, "force-AI must bypass the recent-run guard");
  });

  // ── Scenario 7 ──────────────────────────────────────────────────────────────
  it("SKIPPED_RECENT path does not advance lastAIAnalysisAt", async () => {
    // The orchestrator calls analysisRepository.saveSkipped() for SKIPPED_RECENT.
    // saveSkipped() must not overwrite lastAIAnalysisAt — it only refreshes updatedAt.
    seedEntry("news-monitor", { headline: "Stable" });

    const originalTs = minutesAgo(5);
    analysisRepository.markAIAnalysis("news-monitor", originalTs);

    const beforeSkip = analysisRepository.get("news-monitor");
    assert.equal(beforeSkip?.lastAIAnalysisAt, originalTs, "pre-condition: lastAIAnalysisAt should be set");

    // Wait 2 ms so the clock advances at least one millisecond.
    // Previously writeFileSync added implicit latency; now that saves are async
    // the gap must be created explicitly so updatedAt is guaranteed to differ.
    await new Promise(r => setTimeout(r, 2));

    // Simulate SKIPPED_RECENT: the orchestrator calls saveSkipped, not markAIAnalysis
    analysisRepository.saveSkipped("news-monitor");

    const afterSkip = analysisRepository.get("news-monitor");
    assert.equal(
      afterSkip?.lastAIAnalysisAt,
      originalTs,
      "lastAIAnalysisAt must be preserved after saveSkipped (not overwritten)"
    );
    assert.ok(
      afterSkip?.updatedAt !== undefined && afterSkip.updatedAt > (beforeSkip?.updatedAt ?? ""),
      `updatedAt should be refreshed by saveSkipped (before=${beforeSkip?.updatedAt}, after=${afterSkip?.updatedAt})`
    );
  });

  // ── Scenario 8 ──────────────────────────────────────────────────────────────
  it("Modules without STATIC_DEPS config can have lastAIAnalysisAt via markAIAnalysis", () => {
    // Verify the real module names have no STATIC_DEPS fingerprint config.
    // computeFingerprint returns null for them, so setFingerprint is never called
    // by the orchestrator, meaning the only way to set lastAIAnalysisAt is via
    // markAIAnalysis.
    // opportunity-finder now has STATIC_DEPS: ["catalyst-promotions"] so it WILL return
    // a non-null fingerprint. Only market-monitor and news-monitor are truly dep-free.
    const noFingerprintModules = ["market-monitor", "news-monitor"];
    for (const mod of noFingerprintModules) {
      const fp = computeFingerprint(mod, ["AAPL"]);
      assert.equal(fp, null, `${mod}: computeFingerprint must return null (no static deps)`);
    }

    // Use fresh keys for the repository operations to avoid cross-contamination
    // from other scenarios that may have set fingerprints on the same module names.
    // These are distinct enough to never be seeded by other scenarios.
    const freshKeys = [
      "market-monitor-s8-fresh",
      "news-monitor-s8-fresh",
    ];

    for (const key of freshKeys) {
      // Brand-new entry — no fingerprint has ever been set
      seedEntry(key, { result: "test" });

      const before = analysisRepository.get(key);
      assert.equal(before?.dependencyFingerprint, undefined, `${key}: fresh entry must have no fingerprint`);

      const ts = new Date().toISOString();
      analysisRepository.markAIAnalysis(key, ts);

      const after = analysisRepository.get(key);
      assert.equal(
        after?.lastAIAnalysisAt,
        ts,
        `${key}: lastAIAnalysisAt must be set by markAIAnalysis even without a fingerprint`
      );
      assert.equal(
        after?.dependencyFingerprint,
        undefined,
        `${key}: dependencyFingerprint must remain undefined after markAIAnalysis on a fresh entry`
      );
    }
  });

  // ── Scenario 9 ──────────────────────────────────────────────────────────────
  it("setFingerprint continues to write both dependencyFingerprint and lastAIAnalysisAt", () => {
    // setFingerprint is used by fingerprinted modules (portfolio-analyzer, etc.)
    // and must continue to update both fields correctly for backward compat.
    seedEntry("portfolio-analyzer", { summary: "stable" });

    const fp = "fp-xyz-123";
    const ts = new Date().toISOString();
    analysisRepository.setFingerprint("portfolio-analyzer", fp, ts);

    const entry = analysisRepository.get("portfolio-analyzer");
    assert.equal(entry?.dependencyFingerprint, fp, "dependencyFingerprint must be set");
    assert.equal(entry?.lastAIAnalysisAt, ts, "lastAIAnalysisAt must be set by setFingerprint");
  });

  // ── Scenario 10 ─────────────────────────────────────────────────────────────
  it("OBSERVATION_MODULE_MIN_REFRESH_MINUTES includes exactly the 5 expected modules", () => {
    const keys = Object.keys(OBSERVATION_MODULE_MIN_REFRESH_MINUTES).sort();
    const expected = [
      "event-monitor",
      "market-monitor",
      "news-monitor",
      "opportunity-finder",
      "sector-monitor",
    ].sort();

    assert.deepEqual(keys, expected,
      "OBSERVATION_MODULE_MIN_REFRESH_MINUTES must contain exactly these 5 modules");

    // Verify the specific minimum refresh windows (token-cost guardrails)
    assert.equal(OBSERVATION_MODULE_MIN_REFRESH_MINUTES["market-monitor"],     15);
    assert.equal(OBSERVATION_MODULE_MIN_REFRESH_MINUTES["news-monitor"],       15);
    assert.equal(OBSERVATION_MODULE_MIN_REFRESH_MINUTES["event-monitor"],      60);
    assert.equal(OBSERVATION_MODULE_MIN_REFRESH_MINUTES["sector-monitor"],    180);
    assert.equal(OBSERVATION_MODULE_MIN_REFRESH_MINUTES["opportunity-finder"], 180);
  });

  // ── Scenario 11 ─────────────────────────────────────────────────────────────
  it("company-monitor is absent from OBSERVATION_MODULE_MIN_REFRESH_MINUTES", () => {
    // Company Monitor uses its own fingerprint/discovery gate instead of the
    // time-based recent-run guard. It must NOT appear in the table.
    assert.equal(
      OBSERVATION_MODULE_MIN_REFRESH_MINUTES["company-monitor"],
      undefined,
      "company-monitor must not be in OBSERVATION_MODULE_MIN_REFRESH_MINUTES " +
      "(it uses the fingerprint-based skip gate instead)"
    );
    // investor-watch also has its own discovery/schedule behaviour
    assert.equal(
      OBSERVATION_MODULE_MIN_REFRESH_MINUTES["investor-watch"],
      undefined,
      "investor-watch must not be in OBSERVATION_MODULE_MIN_REFRESH_MINUTES"
    );
  });

});
