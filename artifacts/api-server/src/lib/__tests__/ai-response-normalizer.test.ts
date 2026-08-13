/**
 * Tests for the conservative deterministic AI response normalizer.
 *
 * Run with: node --import tsx/esm run-tests.mjs src/lib/__tests__/ai-response-normalizer.test.ts
 *
 * Verifies:
 *  1. Safe format normalizations are applied correctly.
 *  2. Semantic / investment content is NEVER changed.
 *  3. Retry reason classification is accurate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { normalizeAiResponse, classifyRetryReason } from "../ai-response-normalizer.js";

// ── Shared test schemas ───────────────────────────────────────────────────────

const ImportanceEnum   = z.enum(["High", "Medium", "Low"]);
const SentimentEnum    = z.enum(["Positive", "Neutral", "Negative"]);
const RiskLevelEnum    = z.enum(["Low", "Moderate", "High"]);

const SimpleSchema = z.object({
  importance: ImportanceEnum,
  riskLevel:  RiskLevelEnum,
  score:      z.number(),
  active:     z.boolean(),
  tags:       z.array(z.string()),
  summary:    z.string(),
});

const NestedSchema = z.object({
  sentiment: SentimentEnum,
  nested: z.object({
    risk: RiskLevelEnum,
    score: z.number(),
  }),
  items: z.array(z.object({
    importance: ImportanceEnum,
    label: z.string(),
  })),
});

const OptionalArraySchema = z.object({
  required: z.string(),
  optionalTags: z.array(z.string()).optional(),
  requiredTags: z.array(z.string()),
});

// Decision enum that shares words with standard sentiment (tests enum safety)
const DecisionSchema = z.object({
  decision: z.enum(["PrepareToBuy", "PrepareToReduce", "Hold", "Review", "WaitForEvent", "NoAction"]),
  conviction: z.enum(["High", "Medium", "Low"]),
  rationale: z.string(),
});

// ═════════════════════════════════════════════════════════════════════════════
// PART 1 — SAFE NORMALIZATIONS (must be applied)
// ═════════════════════════════════════════════════════════════════════════════

describe("normalizeAiResponse — safe format normalizations", () => {

  it("normalizes enum case: 'high' → 'High'", () => {
    const raw = { importance: "high", riskLevel: "Low", score: 5, active: true, tags: [], summary: "ok" };
    const { normalized, changes, wasModified } = normalizeAiResponse(raw, SimpleSchema);
    const obj = normalized as typeof raw;
    assert.equal(obj.importance, "High");
    assert.equal(wasModified, true);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].rule, "enum_case_normalize");
    assert.equal(changes[0].path, "importance");
    assert.equal(changes[0].from, "high");
    assert.equal(changes[0].to, "High");
  });

  it("normalizes enum case: 'MODERATE' → 'Moderate'", () => {
    const raw = { importance: "High", riskLevel: "MODERATE", score: 0, active: false, tags: [], summary: "" };
    const { normalized } = normalizeAiResponse(raw, SimpleSchema);
    const obj = normalized as typeof raw;
    assert.equal(obj.riskLevel, "Moderate");
  });

  it("normalizes all-caps enum: 'NEUTRAL' → 'Neutral'", () => {
    const raw = { sentiment: "NEUTRAL", nested: { risk: "Low", score: 1 }, items: [] };
    const { normalized } = normalizeAiResponse(raw, NestedSchema);
    const obj = normalized as typeof raw;
    assert.equal(obj.sentiment, "Neutral");
  });

  it("trims enum whitespace: ' High ' → 'High'", () => {
    const raw = { importance: " High ", riskLevel: "Low", score: 0, active: true, tags: [], summary: "" };
    const { normalized, changes } = normalizeAiResponse(raw, SimpleSchema);
    const obj = normalized as typeof raw;
    assert.equal(obj.importance, "High");
    assert.ok(changes.some(c => c.rule === "trim_whitespace" || c.rule === "enum_case_normalize"));
  });

  it("normalizes numeric string to number: '82' → 82", () => {
    const raw = { importance: "High", riskLevel: "Low", score: "82", active: true, tags: [], summary: "" };
    const { normalized, changes } = normalizeAiResponse(raw, SimpleSchema);
    const obj = normalized as unknown as { score: number };
    assert.equal(obj.score, 82);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].rule, "numeric_string_to_number");
  });

  it("normalizes negative numeric string: '-5.5' → -5.5", () => {
    const raw = { importance: "High", riskLevel: "Low", score: "-5.5", active: false, tags: [], summary: "" };
    const { normalized } = normalizeAiResponse(raw, SimpleSchema);
    assert.equal((normalized as { score: number }).score, -5.5);
  });

  it("normalizes boolean string 'true' → true", () => {
    const raw = { importance: "High", riskLevel: "Low", score: 0, active: "true", tags: [], summary: "" };
    const { normalized, changes } = normalizeAiResponse(raw, SimpleSchema);
    assert.strictEqual((normalized as { active: boolean }).active, true);
    assert.equal(changes[0].rule, "boolean_string_to_boolean");
  });

  it("normalizes boolean string 'false' → false", () => {
    const raw = { importance: "High", riskLevel: "Low", score: 0, active: "false", tags: [], summary: "" };
    const { normalized } = normalizeAiResponse(raw, SimpleSchema);
    assert.strictEqual((normalized as { active: boolean }).active, false);
  });

  it("converts null required array to []", () => {
    const raw = { importance: "High", riskLevel: "Low", score: 1, active: true, tags: null, summary: "" };
    const { normalized, changes } = normalizeAiResponse(raw, SimpleSchema);
    assert.deepEqual((normalized as { tags: string[] }).tags, []);
    assert.equal(changes[0].rule, "null_to_empty_array");
    assert.equal(changes[0].path, "tags");
  });

  it("converts undefined required array to []", () => {
    const raw = { importance: "High", riskLevel: "Low", score: 1, active: true, summary: "" };
    const { normalized } = normalizeAiResponse(raw, SimpleSchema);
    assert.deepEqual((normalized as { tags: string[] }).tags, []);
  });

  it("trims string whitespace: '  hello  ' → 'hello'", () => {
    const raw = { importance: "High", riskLevel: "Low", score: 0, active: true, tags: [], summary: "  hello  " };
    const { normalized, changes } = normalizeAiResponse(raw, SimpleSchema);
    assert.equal((normalized as { summary: string }).summary, "hello");
    assert.equal(changes[0].rule, "trim_whitespace");
    assert.equal(changes[0].path, "summary");
  });

  it("normalizes enum in nested object", () => {
    const raw = { sentiment: "Positive", nested: { risk: "moderate", score: 5 }, items: [] };
    const { normalized } = normalizeAiResponse(raw, NestedSchema);
    const obj = normalized as { nested: { risk: string } };
    assert.equal(obj.nested.risk, "Moderate");
  });

  it("normalizes enums inside array elements", () => {
    const raw = {
      sentiment: "Positive",
      nested: { risk: "Low", score: 1 },
      items: [
        { importance: "high", label: "item-a" },
        { importance: "MEDIUM", label: "item-b" },
      ],
    };
    const { normalized } = normalizeAiResponse(raw, NestedSchema);
    const obj = normalized as { items: Array<{ importance: string; label: string }> };
    assert.equal(obj.items[0].importance, "High");
    assert.equal(obj.items[1].importance, "Medium");
  });

  it("records correct path for nested changes", () => {
    const raw = { sentiment: "Positive", nested: { risk: "low", score: 1 }, items: [] };
    const { changes } = normalizeAiResponse(raw, NestedSchema);
    const change = changes.find(c => c.rule === "enum_case_normalize");
    assert.ok(change);
    assert.equal(change.path, "nested.risk");
  });

  it("records correct path for array element changes", () => {
    const raw = {
      sentiment: "Positive",
      nested: { risk: "Low", score: 1 },
      items: [{ importance: "high", label: "x" }],
    };
    const { changes } = normalizeAiResponse(raw, NestedSchema);
    const change = changes.find(c => c.rule === "enum_case_normalize");
    assert.ok(change);
    assert.equal(change.path, "items[0].importance");
  });

  it("makes no changes when input is already valid", () => {
    const raw = { importance: "High", riskLevel: "Low", score: 42, active: true, tags: ["a"], summary: "ok" };
    const { wasModified, changes } = normalizeAiResponse(raw, SimpleSchema);
    assert.equal(wasModified, false);
    assert.equal(changes.length, 0);
  });

  it("validates without error after normalization (full round-trip)", () => {
    const raw = {
      importance: "high",      // enum case wrong
      riskLevel:  "moderate",  // enum case wrong
      score:      "99",        // numeric string
      active:     "true",      // boolean string
      tags:       null,        // null for required array
      summary:    " padded ",  // needs trim
    };
    const { normalized } = normalizeAiResponse(raw, SimpleSchema);
    const result = SimpleSchema.safeParse(normalized);
    assert.equal(result.success, true, `Expected valid after normalization, got: ${result.error?.message}`);
    if (result.success) {
      assert.equal(result.data.importance, "High");
      assert.equal(result.data.riskLevel, "Moderate");
      assert.equal(result.data.score, 99);
      assert.equal(result.data.active, true);
      assert.deepEqual(result.data.tags, []);
      assert.equal(result.data.summary, "padded");
    }
  });

  it("does NOT convert null optional array (optional arrays already allow null/undefined)", () => {
    const raw = { required: "hello", optionalTags: null, requiredTags: [] };
    const { normalized, changes } = normalizeAiResponse(raw, OptionalArraySchema);
    const obj = normalized as { optionalTags: unknown };
    // null is valid for an optional field — normalizer must leave it alone
    assert.equal(obj.optionalTags, null);
    assert.ok(!changes.some(c => c.path === "optionalTags"));
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// PART 2 — SEMANTIC PROTECTION (must NOT be changed)
// ═════════════════════════════════════════════════════════════════════════════

describe("normalizeAiResponse — semantic content must never be changed", () => {

  it("does NOT normalize 'Buy' → any decision type (no single case-insensitive match)", () => {
    // "Buy" is not in the enum at all; there is no single case-insensitive match.
    const raw = { decision: "Buy", conviction: "High", rationale: "Strong growth" };
    const { normalized, changes } = normalizeAiResponse(raw, DecisionSchema);
    const obj = normalized as { decision: string };
    assert.equal(obj.decision, "Buy");
    assert.ok(!changes.some(c => c.path === "decision"));
  });

  it("does NOT normalize ambiguous enum (multi-match should not occur, but if it did — stays)", () => {
    // Create a schema where two values have same lowercase (unusual but guard test)
    // Since our enums don't have this, we test the no-match case: "Sell" → stays "Sell"
    const raw = { decision: "Sell", conviction: "High", rationale: "Overvalued" };
    const { normalized } = normalizeAiResponse(raw, DecisionSchema);
    assert.equal((normalized as { decision: string }).decision, "Sell");
  });

  it("does NOT rewrite rationale / thesis text even with leading whitespace? No — string trim is safe", () => {
    // Trimming whitespace from a string field is safe (format, not meaning)
    // but we should NOT change investment conclusion text in any other way
    const raw = { decision: "Hold", conviction: "High", rationale: "  Strong thesis.  " };
    const { normalized, changes } = normalizeAiResponse(raw, DecisionSchema);
    assert.equal((normalized as { rationale: string }).rationale, "Strong thesis.");
    // Only trim was applied — no semantic change
    assert.ok(changes.every(c => c.rule === "trim_whitespace"));
  });

  it("does NOT convert non-numeric string to number (leaves it for validation)", () => {
    const raw = { importance: "High", riskLevel: "Low", score: "not-a-number", active: true, tags: [], summary: "" };
    const { normalized, changes } = normalizeAiResponse(raw, SimpleSchema);
    assert.equal((normalized as { score: unknown }).score, "not-a-number");
    assert.ok(!changes.some(c => c.path === "score"));
  });

  it("does NOT convert 'TRUE' (non-standard case) as boolean — only exact 'true'/'false'", () => {
    const raw = { importance: "High", riskLevel: "Low", score: 1, active: "TRUE", tags: [], summary: "" };
    const { normalized } = normalizeAiResponse(raw, SimpleSchema);
    // "TRUE" is not exactly "true" so boolean conversion does not apply
    assert.equal((normalized as { active: unknown }).active, "TRUE");
  });

  it("does NOT normalize enum when multiple values match case-insensitively (safety guard)", () => {
    // Construct a degenerate schema where two allowed values differ only in case.
    // This should never happen in real schemas, but tests the safety guard.
    const AmbiguousSchema = z.object({
      status: z.enum(["Active", "active"]),
    });
    const raw = { status: "ACTIVE" };
    const { normalized, changes } = normalizeAiResponse(raw, AmbiguousSchema);
    assert.equal((normalized as { status: string }).status, "ACTIVE");
    assert.equal(changes.length, 0);
  });

  it("leaves missing required semantic fields as-is for schema validation to catch", () => {
    // thesis/rationale being missing should NOT be filled in
    const raw = { decision: "Hold", conviction: "High" }; // rationale missing
    const { normalized } = normalizeAiResponse(raw, DecisionSchema);
    assert.equal((normalized as { rationale?: string }).rationale, undefined);
    // Schema validation should catch this
    const result = DecisionSchema.safeParse(normalized);
    assert.equal(result.success, false);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// PART 3 — RETRY REASON CLASSIFICATION
// ═════════════════════════════════════════════════════════════════════════════

describe("classifyRetryReason", () => {

  it("SCHEMA_MISSING_CONTENT when a required field is absent", () => {
    const raw = { decision: "Hold", conviction: "High" }; // missing rationale
    const { normalized, changes } = normalizeAiResponse(raw, DecisionSchema);
    const result = DecisionSchema.safeParse(normalized);
    assert.equal(result.success, false);
    const reason = classifyRetryReason(result.error!, changes);
    assert.equal(reason, "SCHEMA_MISSING_CONTENT");
  });

  it("FORMAT_UNREPAIRABLE when enum value is invalid and normalizer could not fix it", () => {
    const raw = { decision: "Buy", conviction: "High", rationale: "Strong" }; // "Buy" not in enum
    const { normalized, changes } = normalizeAiResponse(raw, DecisionSchema);
    const result = DecisionSchema.safeParse(normalized);
    assert.equal(result.success, false);
    const reason = classifyRetryReason(result.error!, changes);
    assert.equal(reason, "FORMAT_UNREPAIRABLE");
  });

  it("FORMAT_UNREPAIRABLE when type is completely wrong (object instead of string)", () => {
    const raw = { decision: { type: "Hold" }, conviction: "High", rationale: "ok" }; // object instead of string
    const { normalized, changes } = normalizeAiResponse(raw, DecisionSchema);
    const result = DecisionSchema.safeParse(normalized);
    assert.equal(result.success, false);
    const reason = classifyRetryReason(result.error!, changes);
    assert.equal(reason, "FORMAT_UNREPAIRABLE");
  });

  it("SEMANTIC_INVALID when a custom validation fails", () => {
    const SchemaWithRefinement = z.object({
      score: z.number().refine(n => n >= 0 && n <= 100, "score must be 0–100"),
    });
    const raw = { score: 150 };
    const { normalized, changes } = normalizeAiResponse(raw, SchemaWithRefinement);
    const result = SchemaWithRefinement.safeParse(normalized);
    assert.equal(result.success, false);
    const reason = classifyRetryReason(result.error!, changes);
    assert.equal(reason, "SEMANTIC_INVALID");
  });

  it("FORMAT_REPAIRED label: after normalization, validation succeeds (no retry needed)", () => {
    // Verify the success path: normalizer fixed the issues, no retry required.
    const raw = {
      importance: "high",  // needs case normalization
      riskLevel:  "Low",
      score:      "10",    // numeric string
      active:     true,
      tags:       [],
      summary:    "ok",
    };
    const { normalized, changes } = normalizeAiResponse(raw, SimpleSchema);
    assert.ok(changes.length > 0, "Expected normalizer to make changes");
    const result = SimpleSchema.safeParse(normalized);
    assert.equal(result.success, true, "Expected validation to succeed after normalization (FORMAT_REPAIRED path)");
    // When success === true, no retry reason is needed (FORMAT_REPAIRED)
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// PART 4 — EDGE CASES
// ═════════════════════════════════════════════════════════════════════════════

describe("normalizeAiResponse — edge cases", () => {

  it("handles null input gracefully (non-object top level)", () => {
    const { normalized, changes } = normalizeAiResponse(null, SimpleSchema);
    assert.equal(normalized, null);
    assert.equal(changes.length, 0);
  });

  it("handles undefined input gracefully", () => {
    const { normalized, changes } = normalizeAiResponse(undefined, SimpleSchema);
    assert.equal(normalized, undefined);
    assert.equal(changes.length, 0);
  });

  it("handles non-object top level (array input)", () => {
    const { normalized, changes } = normalizeAiResponse([1, 2, 3], SimpleSchema);
    assert.deepEqual(normalized, [1, 2, 3]);
    assert.equal(changes.length, 0);
  });

  it("does not mutate the original input object", () => {
    const raw = { importance: "high", riskLevel: "Low", score: 5, active: true, tags: [], summary: "ok" };
    const originalImportance = raw.importance;
    normalizeAiResponse(raw, SimpleSchema);
    assert.equal(raw.importance, originalImportance, "Original object must not be mutated");
  });

  it("handles deeply nested null arrays", () => {
    const raw = {
      sentiment: "Positive",
      nested: { risk: "Low", score: 1 },
      items: null,
    };
    const { normalized } = normalizeAiResponse(raw, NestedSchema);
    assert.deepEqual((normalized as { items: unknown[] }).items, []);
  });

  it("Infinity and NaN strings are not converted to number", () => {
    const raw = { importance: "High", riskLevel: "Low", score: "Infinity", active: true, tags: [], summary: "" };
    const { normalized, changes } = normalizeAiResponse(raw, SimpleSchema);
    assert.equal((normalized as { score: unknown }).score, "Infinity");
    assert.ok(!changes.some(c => c.path === "score"));
  });

  it("NaN string is not converted", () => {
    const raw = { importance: "High", riskLevel: "Low", score: "NaN", active: true, tags: [], summary: "" };
    const { normalized } = normalizeAiResponse(raw, SimpleSchema);
    assert.equal((normalized as { score: unknown }).score, "NaN");
  });

});
