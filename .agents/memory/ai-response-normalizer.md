---
name: AI Response Normalizer
description: Conservative deterministic normalizer in lib/ai-response-normalizer.ts; runs before every Zod safeParse to avoid expensive retries for trivial formatting issues.
---

## Location
`artifacts/api-server/src/lib/ai-response-normalizer.ts`

## What it does
Walks a raw AI JSON response against the Zod schema and applies
format-only corrections BEFORE schema validation:

| Rule | Example |
|---|---|
| enum_case_normalize | `"high"` → `"High"` (only when exactly 1 allowed value matches case-insensitively) |
| numeric_string_to_number | `"82"` → `82` |
| boolean_string_to_boolean | `"true"` → `true`, `"false"` → `false` |
| null_to_empty_array | `null` → `[]` for required ZodArray (NOT inside ZodOptional) |
| trim_whitespace | `" padded "` → `"padded"` for strings and enums |

## Safety invariants
- Enum: only normalizes when exactly ONE allowed value matches case-insensitively (zero or multi → leave unchanged)
- Numeric: only `Number.isFinite()` results; rejects "Infinity", "NaN", ""
- Boolean: only exact `"true"`/`"false"` strings (not "TRUE", "True", "1", "0")
- null→[] only for non-optional arrays (ZodOptional<ZodArray> is left alone)
- Never rewrites investment conclusions, thesis text, or semantic content

## API
```typescript
normalizeAiResponse(raw, schema)  → { normalized, changes, wasModified }
classifyRetryReason(zodError, normChanges) → RetryReason
```

RetryReason values: FORMAT_REPAIRED | FORMAT_UNREPAIRABLE | SCHEMA_MISSING_CONTENT | SEMANTIC_INVALID | WRONG_ENTITY | OTHER

## Integration per route
- **Standard routes** (market, news, event, sector, opportunity, risk, portfolio, command-brief):
  Assemble the final object → `normalizeAiResponse(assembled, Schema)` → `Schema.safeParse(normAssembled)`
- **company-monitor**: existing `normalizeRawResponse()` runs FIRST (domain-specific fixes),
  then generic normalizer runs as a second pass on the result
- **trade-decision-engine**: existing sourceModules whitespace normalization runs FIRST,
  then generic normalizer on the assembled result; classifyRetryReason added to throw message
- **investor-watch**: model routing only; uses manual field validation (no safeParse), skip normalizer

## Tests
`src/lib/__tests__/ai-response-normalizer.test.ts` — 40 tests, all passing via node:test runner

**Why:** Trivial schema mismatches (enum case, numeric strings) were causing unnecessary full
OpenAI retries costing ~$0.01–0.08 each. The normalizer intercepts these before Zod validation
so FORMAT_REPAIRED cases never hit the retry path. Semantic failures still trigger a full retry.
