---
name: Catalyst Analysis Schema Fix
description: Schema extracted to pino-free file; normalizer + one-shot repair wired into Phase 2; explicit JSON schema in system prompt.
---

## Rule
`AnalysisResponseSchema` and `qualifiesForPromotion` live in `catalyst-analysis-schema.ts` (pino-free). Tests must import from that file.

## Why
`catalyst-analysis.ts` is pino-tainted (callAi → ai-service → logger → pino). Schema needed in tests.

## How to apply
- Import schema in tests: `import { AnalysisResponseSchema } from "../catalyst-analysis-schema.js"`
- `ANALYSIS_SCHEMA_DESCRIPTION` string in that file must stay byte-for-byte in sync with the Zod enum values — if you add/rename a Zod enum value, update both.
- Phase 2 pipeline: normalizeAiResponse → safeParse → attemptSchemaRepair (one shot, gpt-4o-mini) → throw on persistent failure.

## Critical sync invariant
`ANALYSIS_SCHEMA_DESCRIPTION` (prompt text) ↔ `AnalysisResponseSchema` (Zod) must stay in sync.
Adding an enum value to Zod without updating the description → model returns old values → schema mismatch.

## Key values that differ from intuition (exact Zod casing)
- `expectationGap`: "StrongNegative" | "StrongPositive" | "Unknown"  (NOT UNKNOWN, NOT STRONG_NEGATIVE)
- `priceAsymmetry`: "VeryAttractive" (NOT VERY_ATTRACTIVE)
- `opportunityState`: "NotInteresting" | "HighInterest" | "CandidateForTradeDecision" (camelCase, no underscores)
- `catalystRisk` / `evidenceConfidence`: "Low" | "Medium" | "High" (title case)
- `temporaryVsStructural`: "LikelyTemporary" | "LikelyStructural" (NOT "Structural" — makeAnalysisResult test helper uses wrong value "Structural" but it's in test fixtures only, not validated)
