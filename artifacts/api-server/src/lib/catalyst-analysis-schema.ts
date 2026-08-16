/**
 * Catalyst Analysis — Zod Schema + Promotion Logic (pino-free)
 *
 * Extracted from catalyst-analysis.ts so tests can import the schema without
 * pulling in callAi → ai-service → logger → pino (which crashes the esbuild
 * ESM test runner).
 *
 * Importable in: tests, catalyst-analysis.ts, catalyst-analyze-service.ts
 *
 * Do NOT add any pino/logger imports here.
 */

import { z } from "zod";
import type { CatalystAnalysisResult } from "./catalyst-types.js";

// ── Response schema (authoritative) ──────────────────────────────────────────
//
// Every enum value here must be mirrored EXACTLY in ANALYSIS_SCHEMA_DESCRIPTION.
// The model will never return the right structure unless both are in sync.

export const AnalysisResponseSchema = z.object({
  triggerType:            z.enum(["SCHEDULED_EVENT", "EARNINGS", "EMERGING_SETUP"]),
  catalystType:           z.string().nullable().optional(),
  eventId:                z.string().nullable().optional(),
  catalystDirection:      z.enum(["STRONGLY_NEGATIVE", "NEGATIVE", "NEUTRAL", "POSITIVE", "STRONGLY_POSITIVE"]),
  evidenceConfidence:     z.enum(["Low", "Medium", "High"]),
  expectationGap:         z.enum(["StrongNegative", "Negative", "Neutral", "Positive", "StrongPositive", "Unknown"]),
  priceAsymmetry:         z.enum(["Poor", "Weak", "Neutral", "Attractive", "VeryAttractive"]),
  alreadyPricedIn:        z.enum(["LOW", "MEDIUM", "HIGH", "UNKNOWN"]),
  catalystRisk:           z.enum(["Low", "Medium", "High", "Extreme"]),
  opportunityState:       z.enum(["NotInteresting", "Monitor", "Investigate", "HighInterest", "CandidateForTradeDecision"]),
  temporaryVsStructural:  z.enum(["LikelyTemporary", "Mixed", "LikelyStructural", "Unknown"]),
  earningsSurpriseSignal: z.enum([
    "StrongPositiveSurprise", "PositiveSurprise", "InLine",
    "NegativeSurprise", "StrongNegativeSurprise", "InsufficientData",
  ]).nullable().optional(),
  thesis:                     z.string(),
  whatMarketMayBeMissing:     z.string().nullable().optional(),
  strongestCounterargument:   z.string(),
  alreadyPricedInAssessment:  z.string(),
  invalidationConditions:     z.array(z.string()),
  dataLimitations:            z.array(z.string()),
  supportingSignalIds:        z.array(z.string()),
  contradictingSignalIds:     z.array(z.string()),
  recommendedNextStep:        z.enum(["Pass", "Monitor", "RunCompanyAnalysis", "PreparePosition", "ActNow", "WaitForData"]),
});

export type AnalysisResponseSchemaType = z.infer<typeof AnalysisResponseSchema>;

// ── Schema description for AI prompts ─────────────────────────────────────────
//
// Must stay byte-for-byte in sync with AnalysisResponseSchema above.
// Used in both buildSystemPrompt() and the repair retry prompt.
// Enum values are listed in EXACT casing expected by the Zod schema.

export const ANALYSIS_SCHEMA_DESCRIPTION = `{
  "triggerType": "SCHEDULED_EVENT" | "EARNINGS" | "EMERGING_SETUP",
  "catalystType": "string or null (optional — e.g. CapEx, Revenue, Regulatory)",
  "eventId": "string or null (optional)",
  "catalystDirection": "STRONGLY_NEGATIVE" | "NEGATIVE" | "NEUTRAL" | "POSITIVE" | "STRONGLY_POSITIVE",
  "evidenceConfidence": "Low" | "Medium" | "High",
  "expectationGap": "StrongNegative" | "Negative" | "Neutral" | "Positive" | "StrongPositive" | "Unknown",
  "priceAsymmetry": "Poor" | "Weak" | "Neutral" | "Attractive" | "VeryAttractive",
  "alreadyPricedIn": "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN",
  "catalystRisk": "Low" | "Medium" | "High" | "Extreme",
  "opportunityState": "NotInteresting" | "Monitor" | "Investigate" | "HighInterest" | "CandidateForTradeDecision",
  "temporaryVsStructural": "LikelyTemporary" | "Mixed" | "LikelyStructural" | "Unknown",
  "earningsSurpriseSignal": "StrongPositiveSurprise" | "PositiveSurprise" | "InLine" | "NegativeSurprise" | "StrongNegativeSurprise" | "InsufficientData" — or null for non-EARNINGS triggers,
  "thesis": "string (≤280 chars)",
  "whatMarketMayBeMissing": "string or null",
  "strongestCounterargument": "string (≤200 chars)",
  "alreadyPricedInAssessment": "string",
  "invalidationConditions": ["string"],
  "dataLimitations": ["string"],
  "supportingSignalIds": ["only IDs verbatim from KEY SIGNALS — empty array if none"],
  "contradictingSignalIds": ["only IDs verbatim from KEY SIGNALS — empty array if none"],
  "recommendedNextStep": "Pass" | "Monitor" | "RunCompanyAnalysis" | "PreparePosition" | "ActNow" | "WaitForData"
}`;

// ── Promotion threshold check (pino-free — safe to import in tests) ───────────

/** Whether this analysis result qualifies for promotion to Opportunity Finder. */
export function qualifiesForPromotion(result: CatalystAnalysisResult): boolean {
  return (
    result.opportunityState === "HighInterest" ||
    result.opportunityState === "CandidateForTradeDecision"
  ) && (
    result.catalystDirection === "POSITIVE" ||
    result.catalystDirection === "STRONGLY_POSITIVE"
  ) && result.analysisUpdateType !== "NO_MATERIAL_CHANGE";
}
