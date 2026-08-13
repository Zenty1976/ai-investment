/**
 * Conservative deterministic AI response normalizer.
 *
 * Inserted between the raw JSON parse and Zod schema validation in every AI
 * module.  Repairs purely representational/format issues so trivial mismatches
 * do not trigger an unnecessary (and expensive) full AI retry.
 *
 * ── SAFETY CONTRACT ────────────────────────────────────────────────────────
 * ✓ Only repairs FORMAT / REPRESENTATION problems.
 * ✓ Never changes investment meaning, decisions, thesis, or conclusions.
 * ✓ Enum values are only normalised when EXACTLY ONE allowed value matches
 *   case-insensitively — ambiguous multi-matches are left for validation.
 * ✓ Numeric / boolean repairs apply only when the schema type is unambiguous.
 * ✓ null → [] only for required ZodArray fields, not ZodOptional wrappers.
 * ✓ Every change is logged in the returned `changes` array for transparency.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { z } from "zod";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Why validation failed / why a retry was triggered.
 * Classify the reason to understand where token spend is going.
 */
export type RetryReason =
  /** Normalizer fixed the issue; validation succeeded; no retry needed. */
  | "FORMAT_REPAIRED"
  /** Type/enum mismatch that the normalizer could not resolve. */
  | "FORMAT_UNREPAIRABLE"
  /** Required field absent — genuine content missing from AI response. */
  | "SCHEMA_MISSING_CONTENT"
  /** Custom validation rule failed — likely a semantic / investment issue. */
  | "SEMANTIC_INVALID"
  /** Response is for the wrong company or entity. */
  | "WRONG_ENTITY"
  /** Unclassified failure. */
  | "OTHER";

/** A single normalization change applied to the raw AI response. */
export interface NormalizationChange {
  /** Dot-notation path to the changed value (e.g. "events[0].importance"). */
  path: string;
  /** Original value before normalization. */
  from: unknown;
  /** Normalised value. */
  to: unknown;
  /** Which rule was applied. */
  rule:
    | "enum_case_normalize"
    | "numeric_string_to_number"
    | "boolean_string_to_boolean"
    | "null_to_empty_array"
    | "trim_whitespace";
}

/** Return value of `normalizeAiResponse`. */
export interface NormalizationResult {
  /** The (potentially modified) value ready for schema validation. */
  normalized: unknown;
  /** Every change applied, in traversal order. Empty when nothing changed. */
  changes: NormalizationChange[];
  /** Convenience flag — true when at least one change was applied. */
  wasModified: boolean;
}

// ── Internal recursive walker ─────────────────────────────────────────────────

function normalizeValue(
  value: unknown,
  schema: z.ZodTypeAny,
  path: string,
  changes: NormalizationChange[]
): unknown {
  // ── Transparent wrappers — unwrap before recursing ──────────────────────────

  // ZodOptional: null/undefined are already valid — do NOT convert them.
  if (schema instanceof z.ZodOptional) {
    if (value === null || value === undefined) return value;
    return normalizeValue(value, schema.unwrap(), path, changes);
  }

  // ZodNullable: null is explicitly allowed — leave it; recurse for other values.
  if (schema instanceof z.ZodNullable) {
    if (value === null) return value;
    return normalizeValue(value, schema.unwrap(), path, changes);
  }

  // ── Structural types ────────────────────────────────────────────────────────

  // ZodObject — walk each field in the schema shape
  if (schema instanceof z.ZodObject) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const obj = value as Record<string, unknown>;
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodTypeAny>;
    const result: Record<string, unknown> = { ...obj };
    for (const [key, fieldSchema] of Object.entries(shape)) {
      const fieldPath = path ? `${path}.${key}` : key;
      result[key] = normalizeValue(obj[key], fieldSchema, fieldPath, changes);
    }
    return result;
  }

  // ZodArray — null/undefined → [] for required arrays; recurse into elements.
  // NOTE: We do NOT apply null → [] inside ZodOptional (handled above).
  if (schema instanceof z.ZodArray) {
    if (value === null || value === undefined) {
      changes.push({ path, from: value, to: [], rule: "null_to_empty_array" });
      return [];
    }
    if (!Array.isArray(value)) return value;
    const elementSchema = (schema as z.ZodArray<z.ZodTypeAny>).element;
    return value.map((item, i) =>
      normalizeValue(item, elementSchema, `${path}[${i}]`, changes)
    );
  }

  // ── Scalar types ────────────────────────────────────────────────────────────

  // ZodEnum — case normalisation + whitespace trimming.
  // SAFETY: only normalise when EXACTLY ONE allowed value matches case-insensitively.
  // If zero or multiple values match, leave the value alone so schema validation
  // catches it; never guess between competing candidates.
  if (schema instanceof z.ZodEnum) {
    if (typeof value !== "string") return value;
    const allowed = (schema as z.ZodEnum<[string, ...string[]]>).options as readonly string[];
    const trimmed = value.trim();

    // Exact match (possibly only after trimming)
    if (allowed.includes(trimmed)) {
      if (trimmed !== value) {
        changes.push({ path, from: value, to: trimmed, rule: "trim_whitespace" });
      }
      return trimmed;
    }

    // Case-insensitive lookup — exactly one winner required
    const lower = trimmed.toLowerCase();
    const matches = allowed.filter(v => v.toLowerCase() === lower);
    if (matches.length === 1) {
      changes.push({ path, from: value, to: matches[0], rule: "enum_case_normalize" });
      return matches[0];
    }

    // Zero or multiple matches — do not guess; let schema validation handle it
    return value;
  }

  // ZodNumber — parse finite numeric strings
  if (schema instanceof z.ZodNumber) {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed !== "") {
        const num = Number(trimmed);
        if (Number.isFinite(num)) {
          changes.push({ path, from: value, to: num, rule: "numeric_string_to_number" });
          return num;
        }
      }
    }
    return value;
  }

  // ZodBoolean — parse "true" / "false" strings
  if (schema instanceof z.ZodBoolean) {
    if (typeof value === "boolean") return value;
    if (value === "true") {
      changes.push({ path, from: value, to: true, rule: "boolean_string_to_boolean" });
      return true;
    }
    if (value === "false") {
      changes.push({ path, from: value, to: false, rule: "boolean_string_to_boolean" });
      return false;
    }
    return value;
  }

  // ZodString — trim leading/trailing whitespace only; never rewrite content
  if (schema instanceof z.ZodString) {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed !== value) {
      changes.push({ path, from: value, to: trimmed, rule: "trim_whitespace" });
      return trimmed;
    }
    return value;
  }

  // All other types (ZodUnion, ZodDiscriminatedUnion, ZodRecord, ZodEffects,
  // ZodDefault, ZodLiteral, ZodIntersection, ZodTuple, …) — pass through
  // unchanged.  Too risky to normalise without understanding the semantics.
  return value;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Apply conservative deterministic normalization to a raw AI response value
 * before Zod schema validation.
 *
 * Insert this call AFTER parsing the JSON from the AI response and BEFORE
 * calling `Schema.safeParse()` or `Schema.parse()`.
 *
 * @param raw    The parsed (but not yet validated) JSON value from the AI.
 * @param schema The Zod schema that will be used to validate `raw`.
 * @returns      Normalised value + log of every change applied.
 */
export function normalizeAiResponse(
  raw: unknown,
  schema: z.ZodTypeAny
): NormalizationResult {
  const changes: NormalizationChange[] = [];
  const normalized = normalizeValue(raw, schema, "", changes);
  return { normalized, changes, wasModified: changes.length > 0 };
}

/**
 * Classify why Zod validation failed, to distinguish format issues from
 * genuine content problems.
 *
 * Call this when `Schema.safeParse(normalised)` returns `{ success: false }`
 * to decide how to log / surface the retry reason.
 *
 * Does NOT modify the error — classification only.
 *
 * @param error       The Zod error from a failed parse.
 * @param normChanges The changes that were applied by `normalizeAiResponse`.
 */
export function classifyRetryReason(
  error: z.ZodError,
  normChanges: NormalizationChange[]
): RetryReason {
  const issues = error.issues;

  // Missing required fields — schema expected a value but received undefined
  const hasMissingRequired = issues.some(
    i =>
      i.code === z.ZodIssueCode.invalid_type &&
      (i as z.ZodInvalidTypeIssue).received === "undefined"
  );
  if (hasMissingRequired) return "SCHEMA_MISSING_CONTENT";

  // Type or enum mismatch — either normalizer fixed nothing, or tried and failed
  const hasEnumMismatch = issues.some(i => i.code === z.ZodIssueCode.invalid_enum_value);
  const hasTypeMismatch  = issues.some(
    i =>
      i.code === z.ZodIssueCode.invalid_type &&
      (i as z.ZodInvalidTypeIssue).received !== "undefined"
  );
  if (hasEnumMismatch || hasTypeMismatch) {
    // Label as unrepairable regardless of whether normalizer ran —
    // it either couldn't fix the issue or nothing was tried.
    void normChanges; // referenced so callers can pass it without lint warnings
    return "FORMAT_UNREPAIRABLE";
  }

  // Custom validation rules — semantic or domain-specific constraint failure
  const hasCustom = issues.some(i => i.code === z.ZodIssueCode.custom);
  if (hasCustom) return "SEMANTIC_INVALID";

  return "OTHER";
}
