/**
 * Driver-Directed Signal Research — Catalyst Intelligence (spec §7, §8)
 *
 * Implements the intended signal generation flow:
 *
 *   CompanyDriverProfile
 *     → identify which driver indicators are ALREADY available from existing monitors
 *     → identify MISSING / MATERIAL indicators needing targeted research
 *     → targeted web search only where warranted
 *     → normalize findings into LeadingIndicatorSignal records
 *     → STORE signals in persistent signal store
 *     → return signals for SignalAccumulationState
 *
 * Cost-safe (spec §8):
 *   - Uses isSignalResearchFresh() to prevent re-running within 24h
 *   - Research fingerprint detects when driver profile changes materially
 *   - Existing monitor data (CM/News/Sector) is reused without new AI calls
 *   - Only runs targeted web search for drivers NOT already covered
 */

import { callAiWithWebSearch } from "./ai-service.js";
import { getModel } from "./ai-model-config.js";
import { analysisRepository } from "./analysis-repository.js";
import { buildDriverSearchTopics } from "./catalyst-driver-profile.js";
import {
  getStoredSignals, mergeStoredSignals,
  isSignalResearchFresh, recordSignalResearch, buildResearchFingerprint,
} from "./catalyst-signal-store.js";
import type {
  CompanyDriverProfile, LeadingIndicatorSignal,
  InformationCategory, SourceQualityCategory,
} from "./catalyst-types.js";

// ── Research system prompt ────────────────────────────────────────────────────

const RESEARCH_SYSTEM_PROMPT = `You are a financial intelligence analyst identifying pre-event leading indicators.

For the given company and driver topic, find specific, recent, observable signals that indicate whether this driver is positive, negative, or neutral for the upcoming event.

SIGNAL QUALITY RULES:
- CONFIRMED_FACT: Company press release, regulatory filing, official announcement
- RELIABLE_REPORTING: Major financial media (Reuters, Bloomberg, FT, WSJ), analyst research
- INDUSTRY_SIGNAL: Industry data (freight rates, prescription data, app downloads, PMI, etc.)
- ANALYST_EXPECTATION: Consensus estimate, analyst target, official guidance
- AI_INTERPRETATION: Your inference from available information (lowest weight)

OUTPUT: strict JSON array (max 5 signals, empty [] if nothing material found):
[{
  "driver": "exact driver name from profile",
  "direction": "StronglyPositive|Positive|Neutral|Negative|StronglyNegative",
  "observedFact": "Specific, concrete, verifiable fact (no opinions)",
  "interpretation": "Why this fact is relevant to the driver and upcoming event",
  "informationCategory": "CONFIRMED_FACT|RELIABLE_REPORTING|INDUSTRY_SIGNAL|ANALYST_EXPECTATION|AI_INTERPRETATION",
  "canonicalSource": "Publication name or data provider",
  "sourceOriginId": "domain.com or provider-name",
  "sourceQuality": "DirectCompany|ReliableReporting|AnalystData|IndustryData|SecondaryReporting|AiInterpretation",
  "companyImpactReason": "How this specifically affects this company's upcoming results"
}]`;

// ── Signal normalization ──────────────────────────────────────────────────────

const VALID_DIRECTIONS = new Set(["StronglyPositive", "Positive", "Neutral", "Negative", "StronglyNegative"]);
const VALID_CATEGORIES = new Set(["CONFIRMED_FACT", "RELIABLE_REPORTING", "INDUSTRY_SIGNAL", "ANALYST_EXPECTATION", "AI_INTERPRETATION"]);
const VALID_QUALITIES = new Set(["DirectCompany", "ReliableReporting", "AnalystData", "IndustryData", "SecondaryReporting", "AiInterpretation"]);

function normalizeSignal(
  raw: Record<string, unknown>,
  ticker: string,
  topic: string,
  availableAt: string,
  index: number
): LeadingIndicatorSignal | null {
  const observedFact = String(raw["observedFact"] ?? "").trim();
  if (!observedFact) return null;

  const direction = VALID_DIRECTIONS.has(String(raw["direction"]))
    ? raw["direction"] as LeadingIndicatorSignal["direction"]
    : "Neutral";

  const informationCategory = VALID_CATEGORIES.has(String(raw["informationCategory"]))
    ? raw["informationCategory"] as InformationCategory
    : "AI_INTERPRETATION";

  const sourceQuality = VALID_QUALITIES.has(String(raw["sourceQuality"]))
    ? raw["sourceQuality"] as SourceQualityCategory
    : "AiInterpretation";

  const driver = String(raw["driver"] ?? topic).trim().slice(0, 100);
  const canonicalSource = String(raw["canonicalSource"] ?? "Driver Research").trim().slice(0, 100);
  const sourceOriginId = String(raw["sourceOriginId"] ?? canonicalSource.toLowerCase().replace(/\s+/g, "-")).slice(0, 80);

  // Build stable signalId: ticker + driver + fact hash
  const factFragment = observedFact.slice(0, 40).replace(/\s+/g, "-").toLowerCase();
  const signalId = `dr-${ticker.toLowerCase()}-${driver.slice(0, 20).replace(/\s+/g, "-").toLowerCase()}-${factFragment}-${index}`;

  return {
    signalId,
    driver,
    direction,
    observedFact,
    interpretation: String(raw["interpretation"] ?? "").trim() || null,
    previousContext: null,
    observationDate: availableAt.slice(0, 10),
    source: canonicalSource,
    sourceType: "WebSearch",
    sourceQuality,
    sourceConfidence: ["CONFIRMED_FACT", "RELIABLE_REPORTING"].includes(informationCategory) ? "High" : "Medium",
    leadTimeRelevance: "High",
    companyImpactReason: String(raw["companyImpactReason"] ?? "").trim() || "Driver-directed research finding",
    freshness: "Fresh",
    informationCategory,
    sourceOriginId,
    canonicalSource,
    availableAt,
  };
}

// ── What drivers are already covered by existing monitors ────────────────────

interface CoverageResult {
  coveredDrivers: string[];
  uncoveredTopics: string[];
}

/**
 * Check which driver topics are already covered by existing repository data
 * (CM catalysts, News Monitor, Sector Monitor) so we don't re-search them.
 *
 * "Covered" = existing signal(s) in signal store reference the same driver keyword.
 */
function assessDriverCoverage(
  topics: string[],
  existingSignals: LeadingIndicatorSignal[],
  existingSignalCount: number
): CoverageResult {
  // If we already have substantial stored signals, check topic coverage
  if (existingSignalCount === 0) {
    return { coveredDrivers: [], uncoveredTopics: topics };
  }

  const existingDriverText = existingSignals
    .map(s => `${s.driver} ${s.observedFact}`.toLowerCase())
    .join(" ");

  const coveredDrivers: string[] = [];
  const uncoveredTopics: string[] = [];

  for (const topic of topics) {
    // Simple coverage check: does any existing signal mention keyword from this topic?
    const keywords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const isCovered = keywords.some(kw => existingDriverText.includes(kw));
    if (isCovered) {
      coveredDrivers.push(topic);
    } else {
      uncoveredTopics.push(topic);
    }
  }

  return { coveredDrivers, uncoveredTopics };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SignalResearchResult {
  ticker: string;
  skipped: boolean;
  skipReason: string | null;
  newSignals: LeadingIndicatorSignal[];
  allStoredSignals: LeadingIndicatorSignal[];
  topicsResearched: string[];
  topicsSkipped: string[];
  aiCalled: boolean;
}

/**
 * Run driver-directed signal research for a ticker.
 *
 * Flow:
 *   1. Check freshness gate — skip if research ran < 24h ago with same fingerprint
 *   2. Load existing stored signals
 *   3. Determine which driver topics need new research
 *   4. Run targeted web search for uncovered topics (max 3 calls per run)
 *   5. Normalize findings into LeadingIndicatorSignal records
 *   6. Merge into persistent signal store
 *   7. Return all signals (new + existing)
 *
 * @param ticker         Ticker symbol
 * @param company        Company display name
 * @param driverProfile  Pre-loaded CompanyDriverProfile (must be non-null)
 * @param daysUntilEvent Days until upcoming event (null for PATH B)
 * @param force          Bypass freshness gate (for manual refresh)
 * @param retryNumber    For AI retry tracking
 */
export async function researchDriverSignals(
  ticker: string,
  company: string,
  driverProfile: CompanyDriverProfile,
  daysUntilEvent: number | null,
  force = false,
  retryNumber = 0,
): Promise<SignalResearchResult> {
  const now = new Date().toISOString();
  const topics = buildDriverSearchTopics(driverProfile, daysUntilEvent);
  const fingerprint = buildResearchFingerprint(ticker, topics);

  // ── Freshness gate ────────────────────────────────────────────────────────
  if (!force && isSignalResearchFresh(ticker, fingerprint)) {
    const allStored = getStoredSignals(ticker, 30);
    return {
      ticker, skipped: true,
      skipReason: `Research fresh (< 24h, fingerprint matches)`,
      newSignals: [],
      allStoredSignals: allStored,
      topicsResearched: [],
      topicsSkipped: topics,
      aiCalled: false,
    };
  }

  // ── Load existing signals ─────────────────────────────────────────────────
  const existingSignals = getStoredSignals(ticker, 30);

  // ── Coverage assessment ───────────────────────────────────────────────────
  const { coveredDrivers, uncoveredTopics } = assessDriverCoverage(
    topics, existingSignals, existingSignals.length
  );

  // Limit to max 3 web search calls per research run (cost control)
  const topicsToResearch = uncoveredTopics.slice(0, 3);

  if (topicsToResearch.length === 0) {
    recordSignalResearch(ticker, fingerprint);
    const allStored = getStoredSignals(ticker, 30);
    return {
      ticker, skipped: false,
      skipReason: null,
      newSignals: [],
      allStoredSignals: allStored,
      topicsResearched: [],
      topicsSkipped: topics,
      aiCalled: false,
    };
  }

  // ── Targeted web search per uncovered topic ───────────────────────────────
  const newSignals: LeadingIndicatorSignal[] = [];
  const topicsResearched: string[] = [];

  for (const topic of topicsToResearch) {
    const userPrompt = `Find specific, recent observable signals for this driver topic:

Company: ${company} (${ticker})
Driver topic: ${topic}
Event context: ${daysUntilEvent !== null ? `${daysUntilEvent} days until upcoming event` : "No specific event — look for general company momentum signals"}

Find concrete, verifiable facts published in the last 30 days that indicate whether this driver is strengthening or weakening for ${company}.

Focus on observable data: industry metrics, company-specific data points, analyst estimates, official guidance, regulatory developments.
Return JSON array of signals (max 5).`;

    try {
      const { result: raw } = await callAiWithWebSearch<unknown[]>(
        RESEARCH_SYSTEM_PROMPT,
        userPrompt,
        {
          model: getModel("discovery", "catalyst-intelligence"),
          maxTokens: 1000,
          temperature: 0.1,
          jsonMode: false,
          module: "catalyst-intelligence",
          operation: "signal-research",
          retryNumber,
          webSearchContextSize: "medium",
        }
      );

      const rawArray = Array.isArray(raw) ? raw : [];
      let idx = 0;
      for (const item of rawArray) {
        if (!item || typeof item !== "object") continue;
        const signal = normalizeSignal(item as Record<string, unknown>, ticker, topic, now, idx++);
        if (signal) newSignals.push(signal);
      }
      topicsResearched.push(topic);
    } catch {
      // Non-fatal — continue with other topics
    }
  }

  // ── Store signals ─────────────────────────────────────────────────────────
  if (newSignals.length > 0) {
    mergeStoredSignals(ticker, newSignals);
  }

  recordSignalResearch(ticker, fingerprint);

  const allStored = getStoredSignals(ticker, 30);

  return {
    ticker, skipped: false,
    skipReason: null,
    newSignals,
    allStoredSignals: allStored,
    topicsResearched,
    topicsSkipped: [...coveredDrivers, ...uncoveredTopics.slice(3)],
    aiCalled: topicsToResearch.length > 0 && topicsResearched.length > 0,
  };
}
