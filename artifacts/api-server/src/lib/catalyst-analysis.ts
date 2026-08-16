/**
 * Deep Catalyst AI Analysis (spec §15–17)
 *
 * Two-phase approach:
 *   Phase 1 (optional): Driver-directed web research
 *     - Uses CompanyDriverProfile to identify what to search for
 *     - Cheap targeted searches, NOT full module output dump
 *     - Skipped if driver profile is unavailable
 *   Phase 2: Deep analysis
 *     - Compact CatalystFacts as input (never raw candles/module outputs)
 *     - Structured CatalystAnalysisResult as output
 *     - AI must reference actual stored signal IDs
 *
 * Fingerprint skip (spec §17):
 *   - If material fingerprint unchanged → return NO_MATERIAL_CHANGE
 *   - Zero AI calls in that case
 *
 * Model: getModel("analysis", "catalyst-intelligence")
 * Cost tracking: module="catalyst-intelligence", operation="deep-analysis"
 */

import { callAi, callAiWithWebSearch, extractAiErrorDebug } from "./ai-service.js";
import { getModel } from "./ai-model-config.js";
import { normalizeAiResponse } from "./ai-response-normalizer.js";
import type {
  CatalystFacts,
  CatalystAnalysisResult,
  CompanyDriverProfile,
  TriggerType,
  CatalystDirection,
  AlreadyPricedIn,
  AnalysisUpdateType,
  ScheduledCatalystType,
  EarningsSurpriseSignal,
  EvidenceConfidence,
  ExpectationGap,
  PriceAsymmetry,
  CatalystRisk,
  PreEventOpportunityState,
  TemporaryVsStructural,
  RecommendedNextStep,
} from "./catalyst-types.js";
import { buildDriverProfileSummary } from "./catalyst-driver-profile.js";
import { computeCatalystFingerprint } from "./catalyst-screening.js";
import {
  AnalysisResponseSchema,
  ANALYSIS_SCHEMA_DESCRIPTION,
} from "./catalyst-analysis-schema.js";

// Re-export so catalyst-analyze-service.ts keeps its existing import path.
export { qualifiesForPromotion } from "./catalyst-analysis-schema.js";

// ── Fingerprint-based skip ─────────────────────────────────────────────────────

/**
 * Check if facts have materially changed since the last analysis.
 * If not, return null to signal "skip — no material change".
 *
 * @param facts - Current CatalystFacts
 * @param lastFingerprint - Fingerprint stored from the last AI analysis
 */
export function shouldSkipAnalysis(
  facts: CatalystFacts,
  lastFingerprint: string | null
): boolean {
  if (!lastFingerprint) return false;
  const currentFingerprint = computeCatalystFingerprint(facts);
  return currentFingerprint === lastFingerprint;
}

// ── Compact facts builder ──────────────────────────────────────────────────────

/**
 * Serialize CatalystFacts to a compact, token-safe string for AI injection.
 * NEVER sends raw candles, full module outputs, or oversized arrays.
 * Stays within ~1200 tokens.
 */
function buildCompactFacts(facts: CatalystFacts, driverSummary: string | null): string {
  const lines: string[] = [];

  // Identity — event may be null (PATH B)
  const company = facts.event?.company ?? facts.company.sector ?? "Unknown";
  const tickerStr = facts.event?.ticker ?? "?";
  lines.push(`COMPANY: ${company} (${tickerStr})`);
  if (facts.company.sector) lines.push(`SECTOR: ${facts.company.sector}`);
  if (facts.company.industry) lines.push(`INDUSTRY: ${facts.company.industry}`);

  // Event context
  const ev = facts.event;
  if (ev && ev.eventDate) {
    lines.push(`EVENT: ${ev.eventType} in ${ev.daysUntilEvent}D (${ev.eventDate})`);
    lines.push(`EVENT SOURCE: ${ev.source} (confidence: ${ev.sourceConfidence})`);
  } else {
    lines.push(`EVENT: No known scheduled event (emerging setup path)`);
  }

  // Price asymmetry
  const pa = facts.price.priceAsymmetryFacts;
  if (pa) {
    lines.push(`PRICE ASYMMETRY: ${pa.asymmetry} | runup: ${pa.preEventRunupPct !== null ? `${pa.preEventRunupPct.toFixed(1)}%` : "n/a"} | 5D: ${pa.recentMomentum5D !== null ? `${pa.recentMomentum5D.toFixed(1)}%` : "n/a"} | 30D: ${pa.momentum30D !== null ? `${pa.momentum30D.toFixed(1)}%` : "n/a"} | 90D: ${pa.momentum90D !== null ? `${pa.momentum90D.toFixed(1)}%` : "n/a"}`);
    lines.push(`PRICE TREND: short=${facts.price.shortTermTrend ?? "?"} / medium=${facts.price.mediumTermTrend ?? "?"} / long=${facts.price.longTermTrend ?? "?"}`);
  }

  // Company intelligence
  const cm = facts.company;
  if (cm.investmentView) lines.push(`CM VIEW: ${cm.investmentView}${cm.investmentCaseStrength ? ` (strength: ${cm.investmentCaseStrength})` : ""}`);
  if (cm.earningsGuidanceTrend) lines.push(`EARNINGS TREND: ${cm.earningsGuidanceTrend}`);
  if (cm.investmentThesis) lines.push(`THESIS: ${cm.investmentThesis.slice(0, 150)}`);
  if (cm.bullCase) lines.push(`BULL: ${cm.bullCase.slice(0, 100)}`);
  if (cm.bearCase) lines.push(`BEAR: ${cm.bearCase.slice(0, 100)}`);
  if (cm.recentMeaningfulChange) lines.push(`RECENT CHANGE: ${cm.recentMeaningfulChange.slice(0, 120)}`);

  // Earnings history
  const eh = facts.history;
  if (eh?.entries?.length) {
    const recent = eh.entries.slice(0, 3);
    lines.push(`RECENT EARNINGS: ${recent.map(e => `${e.period}=${e.guidanceAction ?? "?guidance"}`).join(", ")}`);
  }
  if (eh?.isUnavailable) {
    lines.push(`EARNINGS HISTORY: Not available (no external data provider)`);
  }

  // Consensus
  const ce = facts.expectations;
  if (ce?.isUnavailable) {
    lines.push(`ANALYST CONSENSUS: Not available (no external data provider)`);
  }

  // Driver profile summary
  if (driverSummary) {
    lines.push(`\nDRIVER PROFILE:\n${driverSummary}`);
  }

  // Key signals (top 8 — sorted by freshness + strength)
  const signals = [...(facts.signals ?? [])].sort((a, b) => {
    const strength: Record<string, number> = {
      StronglyBullish: 3, Bullish: 2, StronglyBearish: 3, Bearish: 2, Neutral: 0
    };
    const freshA = a.freshness === "Fresh" ? 1 : 0;
    const freshB = b.freshness === "Fresh" ? 1 : 0;
    return ((strength[b.direction] ?? 0) + freshB) - ((strength[a.direction] ?? 0) + freshA);
  }).slice(0, 8);

  if (signals.length > 0) {
    lines.push(`\nKEY SIGNALS (${signals.length} of ${facts.signals.length} total):`);
    for (const s of signals) {
      lines.push(`  [${s.signalId}] ${s.direction} | ${s.driver}: ${s.observedFact.slice(0, 120)} (${s.source}, ${s.freshness})`);
    }
  } else {
    lines.push(`\nKEY SIGNALS: None available — limited leading indicator data.`);
  }

  // News context (top 3)
  const newsItems = facts.news?.materialNews ?? [];
  if (newsItems.length > 0) {
    lines.push(`\nRECENT NEWS (${facts.news?.newsCount ?? newsItems.length} total, top 3):`);
    for (const h of newsItems.slice(0, 3)) {
      lines.push(`  - ${h.headline} (${h.publishedAt?.slice(0, 10) ?? "?"})`);
    }
  }

  // Sector context
  const sc = facts.sector;
  if (sc?.sectorSummary) {
    lines.push(`SECTOR: ${sc.sectorSummary.slice(0, 120)}`);
  }

  // Market context
  const mkt = facts.market;
  if (mkt?.marketSentiment) {
    lines.push(`MARKET: ${mkt.marketSentiment} | risk: ${mkt.riskLevel ?? "?"}`);
  }

  // Risks
  if (facts.risks.length > 0) {
    lines.push(`KEY RISKS: ${facts.risks.slice(0, 3).join("; ")}`);
  }

  return lines.join("\n");
}

// ── System prompt ──────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a senior pre-event investment analyst at a quantitative equity fund. Your specialty is assessing whether a company-specific catalyst creates an asymmetric opportunity before the event date.

CRITICAL RULES:
1. SIGNAL ID INTEGRITY: Every signalId you reference in supportingSignalIds or contradictingSignalIds MUST appear in the KEY SIGNALS section of the input. Never invent signal IDs.
2. EXPECTATION GAP: Focus on what the MARKET expects vs what you assess is likely. If market expectation data is unavailable, set expectationGap to "Unknown".
3. ALREADY PRICED IN: Assess whether the thesis is already reflected in the current price. Consider the priceAsymmetry context carefully.
4. DATA LIMITATIONS: List any material data gaps that reduce confidence.
5. TOKEN SAFETY: Do not request or summarize data not provided to you.

OPPORTUNITY STATE CALIBRATION:
- CandidateForTradeDecision: Strong evidence (≥3 independent sources), positive expectation gap, attractive price asymmetry, clear thesis, low contradiction
- HighInterest: Good evidence (2+ independent sources), positive direction, moderate price asymmetry
- Investigate: Mixed evidence, some promising signals, warrants more research
- Monitor: Early signals only, or conflicting evidence, or poor price asymmetry
- NotInteresting: Structurally negative, priced in, or insufficient quality signals

EARNINGS vs NON-EARNINGS:
- For EARNINGS trigger: assess earningsSurpriseSignal based on visible leading indicators
- For non-earnings (SCHEDULED_EVENT, EMERGING_SETUP): set earningsSurpriseSignal to null

OUTPUT FORMAT — respond with ONLY this JSON object at the ROOT LEVEL (no wrapper like "analysis" or "result"). Use EXACT enum values shown:
${ANALYSIS_SCHEMA_DESCRIPTION}`;
}

// ── Phase 1: Driver-directed research context ──────────────────────────────────

async function buildDriverResearchContext(
  facts: CatalystFacts,
  driverProfile: CompanyDriverProfile,
  retryNumber: number
): Promise<string> {
  // We don't make a separate AI call for research — instead, we include the
  // driver profile summary in the main analysis call, and let the AI
  // use its web search capability to look up current driver signals.
  // This is more efficient than a two-step approach.
  return buildDriverProfileSummary(driverProfile);
}

// ── Main analysis ──────────────────────────────────────────────────────────────

export interface CatalystAnalysisInput {
  facts: CatalystFacts;
  triggerType: TriggerType;
  eventId?: string | null;
  driverProfile?: CompanyDriverProfile | null;
  lastFingerprint?: string | null;
  retryNumber?: number;
}

export interface CatalystAnalysisOutput {
  result: CatalystAnalysisResult;
  fingerprint: string;
  tokensUsed: number;
  durationMs: number;
  skipped: boolean;
  skipReason?: string;
}

/**
 * Run deep Catalyst AI analysis.
 *
 * Returns null if analysis fails irrecoverably.
 * Respects fingerprint skip — call shouldSkipAnalysis() first if you want to pre-check.
 */
export async function runCatalystAnalysis(
  input: CatalystAnalysisInput
): Promise<CatalystAnalysisOutput | null> {
  const { facts, triggerType, eventId = null, driverProfile = null,
          lastFingerprint = null, retryNumber = 0 } = input;

  const startMs = Date.now();

  // ── Fingerprint skip ───────────────────────────────────────────────────────
  const currentFingerprint = computeCatalystFingerprint(facts);
  if (lastFingerprint && currentFingerprint === lastFingerprint) {
    const noChangeResult = buildNoChangeResult(facts.event?.company ?? "Unknown", facts.event?.ticker ?? "?", triggerType, eventId);
    return {
      result: noChangeResult,
      fingerprint: currentFingerprint,
      tokensUsed: 0,
      durationMs: Date.now() - startMs,
      skipped: true,
      skipReason: "Material fingerprint unchanged — skipping AI call",
    };
  }

  // ── Phase 1: Build driver research context ─────────────────────────────────
  let driverSummary: string | null = null;
  if (driverProfile) {
    driverSummary = await buildDriverResearchContext(facts, driverProfile, retryNumber);
  }

  // ── Phase 2: Deep analysis ─────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt();
  const compactFacts = buildCompactFacts(facts, driverSummary);

  const upcomingEvent = facts.event;
  const companyName = facts.event?.company ?? facts.company.investmentView ?? "Unknown Company";
  const tickerForPrompt = facts.event?.ticker ?? "?";
  const userPrompt = `Analyze the pre-event catalyst opportunity for ${companyName} (${tickerForPrompt}).

TRIGGER PATH: ${triggerType}
${upcomingEvent?.eventDate ? `UPCOMING EVENT: ${upcomingEvent.eventType} on ${upcomingEvent.eventDate} (${upcomingEvent.daysUntilEvent ?? "?"}D away)` : "UPCOMING EVENT: None (emerging setup)"}

CATALYST FACTS:
${compactFacts}

Assess:
1. Is there an asymmetric pre-event opportunity here?
2. What is the expectation gap between market pricing and likely outcome?
3. How much of the thesis is already in the price?
4. What would invalidate this thesis?

Return strict JSON.`;

  try {
    // Phase 2 uses callAi (Chat Completions API), NOT callAiWithWebSearch, because:
    //   - Structured JSON output (jsonMode / response_format json_object) is required.
    //   - OpenAI Responses API rejects text.format.json_object when web_search tools
    //     are active — they are mutually exclusive.
    //   - Driver research context is already injected via the driver profile summary
    //     in buildCompactFacts(). No further web search is needed here.
    // Using callAiWithWebSearch here (even without webSearchContextSize) would still
    // inject tools:[{type:"web_search_preview"}] unconditionally, causing a 400 error.
    const { result: raw, debug } = await callAi<unknown>(
      systemPrompt,
      userPrompt,
      {
        model: getModel("analysis", "catalyst-intelligence"),
        maxTokens: 1500,
        temperature: 0.1,
        module: "catalyst-intelligence",
        operation: "deep-analysis",
        retryNumber,
      }
    );

    // ── Normalize + validate ───────────────────────────────────────────────
    // 1. Deterministic normalizer: repairs enum casing, null→[], whitespace.
    const { normalized, changes: normChanges } = normalizeAiResponse(raw, AnalysisResponseSchema);
    if (normChanges.length > 0) {
      console.info(
        "[catalyst-analysis] Normalizer repaired formatting:",
        normChanges.map(c => c.path).join(", "),
      );
    }
    let parsed = AnalysisResponseSchema.safeParse(normalized);

    // 2. One-shot repair retry if normalization didn't fix everything.
    if (!parsed.success) {
      console.warn(
        "[catalyst-analysis] Schema validation failed after normalizer — attempting repair retry:",
        JSON.stringify(parsed.error.issues.slice(0, 3)),
      );
      const repaired = await attemptSchemaRepair(raw, parsed.error, retryNumber);
      if (repaired) {
        // Rebuild a successful safeParse result from the repaired data so the
        // rest of the function is unchanged.
        parsed = AnalysisResponseSchema.safeParse(repaired.data);
      }
    }

    if (!parsed.success) {
      const issuesSummary = JSON.stringify(parsed.error.issues.slice(0, 3));
      console.error("[catalyst-analysis] Schema validation failed (after normalizer + repair):", issuesSummary);
      // Throw so the caller can apply failure tracking / backoff
      throw new Error(`Catalyst analysis schema validation failed: ${issuesSummary}`);
    }

    const r = parsed.data;
    const isFullOrUpdate: AnalysisUpdateType = lastFingerprint ? "MATERIAL_UPDATE" : "FULL_ANALYSIS";

    const result: CatalystAnalysisResult = {
      triggerType,
      catalystType: (r.catalystType ?? null) as (ScheduledCatalystType | "EMERGING_SETUP" | null),
      eventId: eventId ?? r.eventId ?? null,
      catalystDirection: r.catalystDirection as CatalystDirection,
      evidenceConfidence: r.evidenceConfidence as EvidenceConfidence,
      expectationGap: r.expectationGap as ExpectationGap,
      priceAsymmetry: r.priceAsymmetry as PriceAsymmetry,
      alreadyPricedIn: r.alreadyPricedIn as AlreadyPricedIn,
      catalystRisk: r.catalystRisk as CatalystRisk,
      opportunityState: r.opportunityState as PreEventOpportunityState,
      temporaryVsStructural: r.temporaryVsStructural as TemporaryVsStructural,
      earningsSurpriseSignal: (r.earningsSurpriseSignal ?? null) as EarningsSurpriseSignal | null,
      thesis: r.thesis,
      whatMarketMayBeMissing: r.whatMarketMayBeMissing ?? null,
      strongestCounterargument: r.strongestCounterargument,
      alreadyPricedInAssessment: r.alreadyPricedInAssessment,
      invalidationConditions: r.invalidationConditions ?? [],
      dataLimitations: r.dataLimitations ?? [],
      // Only include signal IDs that actually exist in facts.signals
      supportingSignalIds: filterValidSignalIds(r.supportingSignalIds ?? [], facts),
      contradictingSignalIds: filterValidSignalIds(r.contradictingSignalIds ?? [], facts),
      recommendedNextStep: r.recommendedNextStep as RecommendedNextStep,
      analysisUpdateType: isFullOrUpdate,
    };

    return {
      result,
      fingerprint: currentFingerprint,
      tokensUsed: debug.usage?.total_tokens ?? 0,
      durationMs: Date.now() - startMs,
      skipped: false,
    };

  } catch (err) {
    const dbg = extractAiErrorDebug(err);
    const msg = err instanceof Error ? err.message : String(err);
    // Log full diagnostic details so the failure is visible in server logs.
    // Does NOT log API keys, prompts, or sensitive data.
    console.error("[catalyst-analysis] Phase 2 (deep-analysis) AI call failed:", {
      ticker: facts.event?.ticker ?? facts.company?.sector ?? "unknown",
      model: getModel("analysis", "catalyst-intelligence"),
      message: msg.slice(0, 300),
      // These come from the enriched error thrown by callAi / callAiWithWebSearch:
      errorStage: (err as Record<string, unknown>)?._errorStage ?? "unknown",
      durationMs: Date.now() - startMs,
    });
    // Throw so catalyst-analyze-service can call recordCatalystFailure + apply backoff.
    // Without this throw, failureCount stays at 0 and the same broken candidate is
    // retried every pipeline cycle without any backoff.
    throw new Error(`[catalyst-analysis/deep-analysis] ${msg}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Filter signal IDs to only those that actually exist in the provided facts.
 * Prevents AI from inventing signal references (spec §15).
 */
function filterValidSignalIds(ids: string[], facts: CatalystFacts): string[] {
  const validIds = new Set((facts.signals ?? []).map(s => s.signalId));
  return ids.filter(id => validIds.has(id));
}

/**
 * Build a NO_MATERIAL_CHANGE result for fingerprint-skip cases.
 */
function buildNoChangeResult(
  company: string,
  ticker: string,
  triggerType: TriggerType,
  eventId: string | null,
): CatalystAnalysisResult {
  return {
    triggerType,
    catalystType: null,
    eventId,
    catalystDirection: "NEUTRAL",
    evidenceConfidence: "Low",
    expectationGap: "Unknown",
    priceAsymmetry: "Neutral",
    alreadyPricedIn: "UNKNOWN",
    catalystRisk: "Medium",
    opportunityState: "Monitor",
    temporaryVsStructural: "Unknown",
    earningsSurpriseSignal: null,
    thesis: `No material change detected for ${company} (${ticker}) since last analysis.`,
    whatMarketMayBeMissing: null,
    strongestCounterargument: "Insufficient new evidence to update the thesis.",
    alreadyPricedInAssessment: "Assessment unchanged from previous analysis.",
    invalidationConditions: [],
    dataLimitations: ["No material change in evidence — previous analysis stands."],
    supportingSignalIds: [],
    contradictingSignalIds: [],
    recommendedNextStep: "Monitor",
    analysisUpdateType: "NO_MATERIAL_CHANGE",
  };
}

// ── One-shot schema repair retry ──────────────────────────────────────────────

/**
 * If Phase 2 returns valid JSON that fails Zod validation, attempt exactly ONE
 * cheap repair call.  The repair prompt sends the failed JSON + validation
 * errors + the explicit schema — the model corrects structural issues only
 * (field names, enum casing, missing required fields).
 *
 * DOES NOT re-run web research.  Uses getModel("repair") = gpt-4o-mini.
 * Returns the repaired parsed result on success, or null if repair also fails.
 */
async function attemptSchemaRepair(
  badJson: unknown,
  zodError: { issues: Array<{ path: (string | number)[]; message: string }> },
  retryNumber: number,
): Promise<{ data: ReturnType<typeof AnalysisResponseSchema.parse> } | null> {
  const issuesStr = zodError.issues
    .slice(0, 6)
    .map(i => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("\n");

  const repairSystemPrompt =
    `You are a JSON schema repair assistant. Fix ONLY structural issues (wrong field names, ` +
    `missing required fields, wrong enum casing). ` +
    `Do NOT change investment analysis, thesis, signals, or numeric estimates. ` +
    `Return ONLY the corrected JSON object — no explanation, no markdown, no wrapper key.`;

  const repairUserPrompt =
    `The following JSON failed schema validation:\n` +
    `${JSON.stringify(badJson, null, 2).slice(0, 3000)}\n\n` +
    `VALIDATION ERRORS:\n${issuesStr}\n\n` +
    `REQUIRED OUTPUT SCHEMA (return root-level JSON matching this exactly):\n` +
    `${ANALYSIS_SCHEMA_DESCRIPTION}\n\n` +
    `Return only the corrected JSON.`;

  try {
    const { result: repairRaw } = await callAi<unknown>(
      repairSystemPrompt,
      repairUserPrompt,
      {
        model: getModel("repair", "catalyst-intelligence"),
        maxTokens: 1600,
        temperature: 0,
        module: "catalyst-intelligence",
        operation: "deep-analysis-repair",
        retryNumber: retryNumber + 1,
      },
    );
    const { normalized: repairNorm } = normalizeAiResponse(repairRaw, AnalysisResponseSchema);
    const repairParsed = AnalysisResponseSchema.safeParse(repairNorm);
    if (repairParsed.success) {
      console.info("[catalyst-analysis] Schema repair retry succeeded");
      return { data: repairParsed.data };
    }
    console.warn(
      "[catalyst-analysis] Schema repair retry also failed:",
      JSON.stringify(repairParsed.error.issues.slice(0, 3)),
    );
    return null;
  } catch (repairErr) {
    console.warn(
      "[catalyst-analysis] Schema repair retry threw:",
      repairErr instanceof Error ? repairErr.message : String(repairErr),
    );
    return null;
  }
}
