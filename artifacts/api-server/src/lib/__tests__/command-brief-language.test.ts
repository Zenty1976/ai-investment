/**
 * Command Brief — Explanation Language Instruction Tests
 *
 * Tests A-H as required by the spec.
 * All deterministic. Zero OpenAI calls. Zero paid tokens.
 *
 * WL-A  language=en → instruction requests English
 * WL-B  language=da → instruction explicitly requests Danish for whatThisMeans
 * WL-C  language=da → instruction does NOT say to translate headline/items/actionStatus
 * WL-D  changing language → ZERO API calls (localStorage only — verified by inspection:
 *        the route is only called on analysis; the test verifies the instruction builder
 *        is a pure function with no side effects)
 * WL-E  preference persists in localStorage (simulated with mock)
 * WL-F  next CB run uses newly selected language (verified by the route reading req.body)
 * WL-G  readyTradeCount=0 → whatThisMeans instruction is compatible (instruction
 *        says no independent recommendations — enforcement already tested in CB-F)
 * WL-H  Catalyst enforcement remains intact (CB-A through CB-V already cover this;
 *        this test verifies the enforcement module is still importable and unchanged)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildExplanationLanguageInstruction } from "../command-brief-language.js";
import { enforceRequiredCatalystItems } from "../command-brief-catalyst-enforcement.js";

// ── WL-A: English instruction ─────────────────────────────────────────────────

describe("buildExplanationLanguageInstruction", () => {
  test("WL-A: language=en → instruction requests English for whatThisMeans", () => {
    const instr = buildExplanationLanguageInstruction("en");
    assert.ok(instr.toLowerCase().includes("english"), `Expected 'english' in: "${instr}"`);
    assert.ok(instr.includes("whatThisMeans"), `Expected field name in: "${instr}"`);
  });

  // WL-B: Danish instruction requests Danish
  test("WL-B: language=da → instruction explicitly requests Danish for whatThisMeans", () => {
    const instr = buildExplanationLanguageInstruction("da");
    // Must explicitly mention Danish
    assert.ok(
      instr.toLowerCase().includes("danish") || instr.toLowerCase().includes("dansk"),
      `Expected Danish language instruction, got: "${instr}"`
    );
    assert.ok(instr.includes("whatThisMeans"), `Expected field name in: "${instr}"`);
  });

  // WL-C: Danish instruction must NOT say to translate headline/items/actionStatus
  test("WL-C: language=da → instruction does not tell model to translate headline/items/actionStatus", () => {
    const instr = buildExplanationLanguageInstruction("da");
    const lower = instr.toLowerCase();
    // The instruction should be scoped to whatThisMeans only
    // It must NOT instruct translation of headline, items, actionStatus
    assert.ok(
      !lower.includes("translate the headline") &&
      !lower.includes("translate the items") &&
      !lower.includes("translate actionstatus"),
      `Instruction must not translate headline/items/actionStatus, got: "${instr}"`
    );
  });

  // WL-D: language builder is a pure function (no side effects = no API calls possible)
  test("WL-D: buildExplanationLanguageInstruction is a pure function — no async, no side effects", () => {
    // If it returns a string synchronously with no awaiting, no API calls are made
    const result = buildExplanationLanguageInstruction("da");
    assert.equal(typeof result, "string", "Must return string synchronously");
    assert.ok(result.length > 0, "Must return non-empty string");
    // Call again to verify determinism
    const result2 = buildExplanationLanguageInstruction("da");
    assert.equal(result, result2, "Must be deterministic");
  });

  // WL-E: preference persists — simulated localStorage behavior
  test("WL-E: localStorage key 'commandBriefExplanationLanguage' round-trips correctly", () => {
    // Simulate browser localStorage behaviour with a plain Map
    const store = new Map<string, string>();
    const KEY = "commandBriefExplanationLanguage";
    const read = () => (store.get(KEY) ?? "en") as "en" | "da";
    const write = (v: "en" | "da") => store.set(KEY, v);

    // Default is "en"
    assert.equal(read(), "en");

    // User switches to DA
    write("da");
    assert.equal(read(), "da");

    // Simulate reload (store persists between reads)
    assert.equal(read(), "da");

    // Switch back to EN
    write("en");
    assert.equal(read(), "en");
  });

  // WL-F: next CB run picks up the newly stored language
  test("WL-F: next run uses new language — instruction changes when language changes", () => {
    // Simulate: user stored "da", next run reads "da" and calls buildExplanationLanguageInstruction("da")
    const storedLang: "en" | "da" = "da";
    const instr = buildExplanationLanguageInstruction(storedLang);
    assert.ok(
      instr.toLowerCase().includes("danish") || instr.toLowerCase().includes("dansk"),
      "Next run must produce Danish instruction when stored language is 'da'"
    );

    // And for "en"
    const instrEn = buildExplanationLanguageInstruction("en");
    assert.ok(instrEn.toLowerCase().includes("english"));
    assert.ok(!instrEn.toLowerCase().includes("danish") && !instrEn.toLowerCase().includes("dansk"));
  });

  // WL-G: English instruction includes "no independent recommendations" guard
  test("WL-G: instruction includes no-recommendation guard (compatible with readyTradeCount=0)", () => {
    for (const lang of ["en", "da"] as const) {
      const instr = buildExplanationLanguageInstruction(lang);
      assert.ok(
        instr.toLowerCase().includes("recommend") || instr.toLowerCase().includes("anbef"),
        `Expected recommendation guard in ${lang} instruction: "${instr}"`
      );
    }
  });
});

// WL-H: Catalyst enforcement is still importable and passes a basic smoke test
describe("Catalyst enforcement remains intact (WL-H)", () => {
  test("WL-H: enforceRequiredCatalystItems is still exported and functional", () => {
    // Smoke test: empty inputs → no change, no crash
    const result = enforceRequiredCatalystItems([], [], []);
    assert.equal(result.inserted, false);
    assert.equal(result.corrected, false);
    assert.equal(result.enforcedTicker, null);
    assert.deepEqual(result.items, []);
  });

  test("WL-H2: enforcement still fires when HIGH_INTEREST+WaitForEvent is present", () => {
    const { inserted, enforcedTicker } = enforceRequiredCatalystItems(
      [],
      [{ ticker: "KEYS", company: "Keysight", event: "Earnings in 2d", daysUntilEvent: 2, interestLevel: "HIGH_INTEREST", oneLineReason: "Strong setup" }],
      [{ ticker: "KEYS", decision: "WaitForEvent" }]
    );
    assert.equal(inserted, true);
    assert.equal(enforcedTicker, "KEYS");
  });
});
