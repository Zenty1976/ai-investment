/**
 * Command Brief — Explanation Language Instruction Tests
 *
 * Tests 1–10 as required by the spec, plus the original WL-A–WL-H suite.
 * All deterministic. Zero OpenAI calls. Zero paid tokens.
 *
 * New tests (spec §TESTS):
 * IT-1  whatThisMeans instructed to explain individual items, not generic summary
 * IT-2  WaitForEvent: explain system waits for event and reassesses afterward
 * IT-3  Positive Catalyst sentiment cannot override Trade Decision state
 * IT-4  PrepareToBuy: explained as preparation, not actionable trade
 * IT-5  Trade Review remains authoritative for actionability
 * IT-6  Danish instructions scoped only to whatThisMeans
 * IT-7  EN/DA behavior unchanged (existing WL-A/WL-B)
 * IT-8  No additional OpenAI call (pure function, no async)
 * IT-9  Catalyst deterministic enforcement unchanged
 * IT-10 Paragraph/newline formatting instruction present
 *
 * Original WL suite retained:
 * WL-A  language=en → instruction requests English
 * WL-B  language=da → instruction explicitly requests Danish for whatThisMeans
 * WL-C  language=da → instruction does NOT say to translate headline/items/actionStatus
 * WL-D  pure function — no async, no side effects
 * WL-E  localStorage round-trips correctly
 * WL-F  next run uses newly selected language
 * WL-G  instruction includes no-recommendation guard
 * WL-H  Catalyst enforcement remains intact
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildExplanationLanguageInstruction } from "../command-brief-language.js";
import { enforceRequiredCatalystItems } from "../command-brief-catalyst-enforcement.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function instrEn() { return buildExplanationLanguageInstruction("en"); }
function instrDa() { return buildExplanationLanguageInstruction("da"); }

// ── New spec tests ────────────────────────────────────────────────────────────

describe("whatThisMeans improved instruction (spec tests)", () => {

  // IT-1: explain individual items, not generic summary
  test("IT-1: instruction tells model to explain individual Brief items, not produce a generic summary", () => {
    for (const instr of [instrEn(), instrDa()]) {
      assert.ok(
        instr.toLowerCase().includes("item") || instr.toLowerCase().includes("walkthrough"),
        `Must mention 'item' or 'walkthrough' to avoid generic summary: "${instr.slice(0, 200)}"`
      );
      // Must NOT merely say "plain-language summary" without item-level guidance
      const hasItemGuidance =
        instr.toLowerCase().includes("per important") ||
        instr.toLowerCase().includes("each important") ||
        instr.toLowerCase().includes("one short explanatory paragraph per");
      assert.ok(hasItemGuidance, `Must instruct per-item explanation: "${instr.slice(0, 200)}"`);
    }
  });

  // IT-2: WaitForEvent rule
  test("IT-2: WaitForEvent explanation — system waits for event and reassesses afterward", () => {
    for (const instr of [instrEn(), instrDa()]) {
      const lower = instr.toLowerCase();
      assert.ok(
        lower.includes("waitforevent") || lower.includes("wait for"),
        `Must mention WaitForEvent handling: "${instr.slice(0, 200)}"`
      );
      assert.ok(
        lower.includes("reassess") || lower.includes("vurderes igen") || lower.includes("after the event"),
        `Must mention reassessment after event: "${instr.slice(0, 200)}"`
      );
      assert.ok(
        lower.includes("waiting") || lower.includes("venter"),
        `Must say system is waiting: "${instr.slice(0, 200)}"`
      );
    }
  });

  // IT-3: Catalyst sentiment cannot override Trade Decision
  test("IT-3: positive Catalyst sentiment cannot override Trade Decision state", () => {
    for (const instr of [instrEn(), instrDa()]) {
      const lower = instr.toLowerCase();
      assert.ok(
        lower.includes("trade decision") && (
          lower.includes("takes precedence") ||
          lower.includes("overrid") ||
          lower.includes("recommend") ||
          lower.includes("never turn")
        ),
        `Must state TDE takes precedence over Catalyst sentiment: "${instr.slice(0, 200)}"`
      );
    }
  });

  // IT-4: PrepareToBuy — preparation, not actionable trade
  test("IT-4: PrepareToBuy explained as preparation, not an actionable trade", () => {
    for (const instr of [instrEn(), instrDa()]) {
      const lower = instr.toLowerCase();
      assert.ok(
        lower.includes("preparetobuy") || lower.includes("prepare to buy"),
        `Must mention PrepareToBuy: "${instr.slice(0, 200)}"`
      );
      assert.ok(
        lower.includes("not") && (lower.includes("ready") || lower.includes("klar")),
        `Must clarify trade is not yet ready: "${instr.slice(0, 200)}"`
      );
    }
  });

  // IT-5: Trade Review authoritative for actionability
  test("IT-5: Trade Review remains authoritative for actionability (approval language)", () => {
    for (const instr of [instrEn(), instrDa()]) {
      const lower = instr.toLowerCase();
      assert.ok(
        lower.includes("trade review") || lower.includes("godkend") || lower.includes("actionable"),
        `Must mention Trade Review / approval: "${instr.slice(0, 200)}"`
      );
    }
  });

  // IT-6: Danish instructions scoped only to whatThisMeans
  test("IT-6: Danish instruction scoped only to whatThisMeans — does not translate other fields", () => {
    const instr = instrDa();
    const lower = instr.toLowerCase();
    // Must explicitly say only whatThisMeans is in Danish
    assert.ok(
      lower.includes("\"whatthismeans\"") || lower.includes("'whatthismeans'") ||
      lower.includes("whatthismeans"),
      `Must name the field: "${instr.slice(0, 200)}"`
    );
    // Must NOT say to translate headline, items, actionStatus
    assert.ok(
      !lower.includes("translate the headline") &&
      !lower.includes("translate the items") &&
      !lower.includes("translate actionstatus"),
      `Must not translate other fields: "${instr.slice(0, 200)}"`
    );
    // Must explicitly say other fields stay in English or are excluded
    assert.ok(
      lower.includes("only") && (lower.includes("danish") || lower.includes("dansk")),
      `Must clarify scope: "${instr.slice(0, 200)}"`
    );
  });

  // IT-7: EN/DA behavior unchanged — separate instructions
  test("IT-7: EN instruction contains 'english', DA instruction contains 'danish' or 'dansk'", () => {
    assert.ok(instrEn().toLowerCase().includes("english"));
    assert.ok(instrDa().toLowerCase().includes("danish") || instrDa().toLowerCase().includes("dansk"));
    // Each must NOT include the other language's keywords in conflicting ways
    assert.ok(!instrEn().toLowerCase().includes("dansk"));
  });

  // IT-8: No additional OpenAI call — pure sync function
  test("IT-8: buildExplanationLanguageInstruction is synchronous — no additional AI call possible", () => {
    const result = buildExplanationLanguageInstruction("da");
    assert.equal(typeof result, "string");
    assert.ok(result.length > 0);
    // Calling twice must be identical (pure)
    assert.equal(result, buildExplanationLanguageInstruction("da"));
  });

  // IT-10: Paragraph/newline formatting instruction present
  test("IT-10: instruction mentions paragraph or newline formatting for per-item explanations", () => {
    for (const instr of [instrEn(), instrDa()]) {
      const lower = instr.toLowerCase();
      assert.ok(
        lower.includes("newline") || lower.includes("paragraph") ||
        lower.includes("\\n") || lower.includes("separate"),
        `Must mention newline/paragraph formatting: "${instr.slice(0, 200)}"`
      );
    }
  });
});

// IT-9: Catalyst enforcement unchanged
describe("IT-9: Catalyst deterministic enforcement remains unchanged", () => {
  test("enforceRequiredCatalystItems still exportable and functional after prompt changes", () => {
    const result = enforceRequiredCatalystItems([], [], []);
    assert.equal(result.inserted, false);
    assert.equal(result.corrected, false);
    assert.equal(result.enforcedTicker, null);
  });

  test("enforcement fires for HIGH_INTEREST + WaitForEvent", () => {
    const { inserted, enforcedTicker } = enforceRequiredCatalystItems(
      [],
      [{ ticker: "KEYS", company: "Keysight", event: "Earnings in 2d", daysUntilEvent: 2, interestLevel: "HIGH_INTEREST", oneLineReason: "Strong setup" }],
      [{ ticker: "KEYS", decision: "WaitForEvent" }]
    );
    assert.equal(inserted, true);
    assert.equal(enforcedTicker, "KEYS");
  });
});

// ── Original WL suite ─────────────────────────────────────────────────────────

describe("buildExplanationLanguageInstruction (original WL suite)", () => {
  test("WL-A: language=en → instruction requests English for whatThisMeans", () => {
    assert.ok(instrEn().toLowerCase().includes("english"));
    assert.ok(instrEn().includes("whatThisMeans"));
  });

  test("WL-B: language=da → instruction explicitly requests Danish for whatThisMeans", () => {
    const instr = instrDa();
    assert.ok(instr.toLowerCase().includes("danish") || instr.toLowerCase().includes("dansk"));
    assert.ok(instr.includes("whatThisMeans"));
  });

  test("WL-C: language=da → does not translate headline/items/actionStatus", () => {
    const lower = instrDa().toLowerCase();
    assert.ok(!lower.includes("translate the headline"));
    assert.ok(!lower.includes("translate the items"));
    assert.ok(!lower.includes("translate actionstatus"));
  });

  test("WL-D: pure function — no async, no side effects", () => {
    const r1 = buildExplanationLanguageInstruction("en");
    const r2 = buildExplanationLanguageInstruction("en");
    assert.equal(typeof r1, "string");
    assert.equal(r1, r2);
  });

  test("WL-E: localStorage round-trips correctly (simulated)", () => {
    const store = new Map<string, string>();
    const KEY = "commandBriefExplanationLanguage";
    const read = () => (store.get(KEY) ?? "en") as "en" | "da";
    const write = (v: "en" | "da") => store.set(KEY, v);
    assert.equal(read(), "en");
    write("da");
    assert.equal(read(), "da");
    assert.equal(read(), "da"); // persists
    write("en");
    assert.equal(read(), "en");
  });

  test("WL-F: next run uses new language", () => {
    const instr = buildExplanationLanguageInstruction("da");
    assert.ok(instr.toLowerCase().includes("danish") || instr.toLowerCase().includes("dansk"));
    assert.ok(!buildExplanationLanguageInstruction("en").toLowerCase().includes("dansk"));
  });

  test("WL-G: instruction includes no-recommendation guard", () => {
    for (const lang of ["en", "da"] as const) {
      const instr = buildExplanationLanguageInstruction(lang);
      assert.ok(
        instr.toLowerCase().includes("recommend") || instr.toLowerCase().includes("anbef"),
        `Missing guard in ${lang}`
      );
    }
  });
});

describe("WL-H: Catalyst enforcement intact", () => {
  test("WL-H: smoke test", () => {
    const result = enforceRequiredCatalystItems([], [], []);
    assert.deepEqual(result.items, []);
  });
});
