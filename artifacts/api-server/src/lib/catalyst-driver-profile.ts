/**
 * Company Driver Profile — generation + lifecycle management (spec §8)
 *
 * CompanyDriverProfile captures what ACTUALLY drives a specific company's
 * financial results and stock price. It is the foundation for:
 *   - Driver-directed research (which signals to search for)
 *   - Pre-event evidence evaluation (is this signal relevant to a key driver?)
 *
 * Generation rules:
 *   - Generate when a ticker becomes a serious Catalyst candidate (screening ≥ DeepAnalysis)
 *     AND no fresh profile exists (stale = older than STALE_DAYS days)
 *   - Single AI call with web search per company (expensive)
 *   - NEVER regenerate for no reason — check isDriverProfileFresh() first
 *   - Uses getModel("analysis", "catalyst-intelligence")
 *
 * Storage: analysis-repository key "company-driver-profile:<TICKER>"
 * (Part 1 already defined CompanyDriverProfile type and storage, Part 2 adds generation)
 */

import { callAiWithWebSearch } from "./ai-service.js";
import { getModel } from "./ai-model-config.js";
import { analysisRepository } from "./analysis-repository.js";
import type { CompanyDriverProfile, DriverProfileUpdateState } from "./catalyst-types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/** Profile is considered stale after this many days. */
const STALE_DAYS = 30;

const DRIVER_PROFILE_KEY_PREFIX = "company-driver-profile:";

// ── Repository helpers ─────────────────────────────────────────────────────────

export function driverProfileKey(ticker: string): string {
  return `${DRIVER_PROFILE_KEY_PREFIX}${ticker.toUpperCase()}`;
}

export function getDriverProfile(ticker: string): CompanyDriverProfile | null {
  const entry = analysisRepository.get<CompanyDriverProfile>(driverProfileKey(ticker));
  return entry?.result ?? null;
}

export function saveDriverProfile(ticker: string, profile: CompanyDriverProfile): void {
  analysisRepository.save(driverProfileKey(ticker), profile);
}

// ── Freshness check ────────────────────────────────────────────────────────────

/**
 * Returns true if the profile exists and was updated within STALE_DAYS.
 * A stale or missing profile should trigger generation.
 */
export function isDriverProfileFresh(ticker: string): boolean {
  const profile = getDriverProfile(ticker);
  if (!profile) return false;
  // NoMaterialChange = profile was checked recently with no material update needed.
  // Treat it the same as FullProfile for freshness purposes.
  if (profile.updateState === "MaterialUpdate") return false;

  const updatedAt = new Date(profile.lastMateriallyUpdatedAt).getTime();
  const staleCutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
  return updatedAt > staleCutoff;
}

// ── Generation ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a fundamental equity research analyst specializing in company business model analysis.

Your task is to identify the KEY ECONOMIC DRIVERS that determine a specific company's financial results and stock price.

WHAT TO RESEARCH:
1. What are the 3-6 most important revenue drivers for this company? (things that, when they move, revenues move)
2. What are the 2-4 key margin/profitability drivers? (pricing power, cost structure, operating leverage)
3. What are the 2-4 largest cost components that affect profitability?
4. What are 4-8 leading real-world indicators that signal these drivers in advance? (observable from public sources)
5. What industry data sources are relevant? (freight indices, prescription data, app rankings, etc.)
6. What macro factors most affect this company?
7. What are the key competitors?
8. What company-specific KPIs does management emphasize?
9. How far in advance do leading indicators typically signal company results?

IMPORTANT RULES:
- Be SPECIFIC to this company, not generic sector commentary
- Leading indicators must be OBSERVABLE from public sources
- If this is a small company with limited public coverage, say so explicitly

OUTPUT FORMAT (strict JSON):
{
  "ticker": "string",
  "company": "string",
  "primaryRevenueDrivers": ["driver 1", "driver 2", "driver 3"],
  "primaryMarginDrivers": ["margin driver 1", "driver 2"],
  "costDrivers": ["cost 1", "cost 2"],
  "leadingIndicators": ["observable indicator 1", "indicator 2", "indicator 3"],
  "industryIndicators": ["data source 1", "data source 2"],
  "macroSensitivities": ["factor 1", "factor 2"],
  "geopoliticalSensitivities": ["risk 1"],
  "regulatorySensitivities": ["regulation 1"],
  "importantCompetitors": ["company A", "company B"],
  "companySpecificKPIs": ["KPI 1", "KPI 2"],
  "typicalIndicatorLeadTime": "e.g. '4-8 weeks for demand signals, 1 quarter for regulatory'",
  "driverConfidence": "High|Medium|Low"
}`;

/**
 * Generate a CompanyDriverProfile for the given company via AI + web search.
 *
 * This is an EXPENSIVE operation (~$0.05–0.15 per call). Only call when:
 *   1. The ticker is a serious Catalyst candidate
 *   2. isDriverProfileFresh(ticker) === false
 *
 * @returns The generated profile, or null on failure.
 */
export async function generateCompanyDriverProfile(
  ticker: string,
  company: string,
  sector: string | null,
  industry: string | null,
  retryNumber = 0
): Promise<CompanyDriverProfile | null> {
  const now = new Date().toISOString();

  const userPrompt = `Research the key business drivers for ${company} (ticker: ${ticker}${sector ? `, sector: ${sector}` : ""}${industry ? `, industry: ${industry}` : ""}).

Provide a comprehensive driver profile that will be used to:
1. Identify what to search for in the weeks leading up to earnings/events
2. Evaluate whether incoming news signals are relevant to key drivers
3. Determine what leading indicators have predictive value

Focus on: what actually moves ${company}'s financial results and stock price, quarter to quarter.`;

  try {
    const { result, debug } = await callAiWithWebSearch<{
      ticker: string;
      company: string;
      primaryRevenueDrivers: string[];
      primaryMarginDrivers: string[];
      costDrivers: string[];
      leadingIndicators: string[];
      industryIndicators: string[];
      macroSensitivities: string[];
      geopoliticalSensitivities: string[];
      regulatorySensitivities: string[];
      importantCompetitors: string[];
      companySpecificKPIs: string[];
      typicalIndicatorLeadTime: string;
      driverConfidence: "High" | "Medium" | "Low";
    }>(SYSTEM_PROMPT, userPrompt, {
      model: getModel("analysis", "catalyst-intelligence"),
      maxTokens: 2500,
      temperature: 0.1,
      jsonMode: true,
      module: "catalyst-intelligence",
      operation: "driver-profile",
      retryNumber,
      webSearchContextSize: "medium",
    });

    if (!result || !result.primaryRevenueDrivers?.length) {
      return null;
    }

    const profile: CompanyDriverProfile = {
      ticker: ticker.toUpperCase(),
      company,
      primaryRevenueDrivers: result.primaryRevenueDrivers ?? [],
      primaryMarginDrivers: result.primaryMarginDrivers ?? [],
      costDrivers: result.costDrivers ?? [],
      leadingIndicators: result.leadingIndicators ?? [],
      industryIndicators: result.industryIndicators ?? [],
      macroSensitivities: result.macroSensitivities ?? [],
      geopoliticalSensitivities: result.geopoliticalSensitivities ?? [],
      regulatorySensitivities: result.regulatorySensitivities ?? [],
      importantCompetitors: result.importantCompetitors ?? [],
      companySpecificKPIs: result.companySpecificKPIs ?? [],
      typicalIndicatorLeadTime: result.typicalIndicatorLeadTime ?? "Unknown",
      driverConfidence: result.driverConfidence ?? "Medium",
      lastMateriallyUpdatedAt: now,
      updateState: "FullProfile" as DriverProfileUpdateState,
    };

    saveDriverProfile(ticker, profile);
    return profile;

  } catch (err) {
    console.error(`[catalyst-driver-profile] Failed to generate profile for ${ticker}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Get or generate a driver profile for the given company.
 * Respects freshness — will NOT regenerate if the profile is fresh.
 *
 * @param force - Force regeneration even if fresh.
 */
export async function getOrGenerateDriverProfile(
  ticker: string,
  company: string,
  sector: string | null,
  industry: string | null,
  force = false
): Promise<CompanyDriverProfile | null> {
  if (!force && isDriverProfileFresh(ticker)) {
    return getDriverProfile(ticker);
  }
  return generateCompanyDriverProfile(ticker, company, sector, industry);
}

/**
 * Build a compact summary of the driver profile for injection into AI prompts.
 * Stays under ~500 tokens to avoid bloating context.
 */
export function buildDriverProfileSummary(profile: CompanyDriverProfile): string {
  return [
    profile.primaryRevenueDrivers.length
      ? `REVENUE DRIVERS: ${profile.primaryRevenueDrivers.slice(0, 4).join(" | ")}`
      : "",
    profile.primaryMarginDrivers.length
      ? `MARGIN DRIVERS: ${profile.primaryMarginDrivers.slice(0, 3).join(" | ")}`
      : "",
    profile.leadingIndicators.length
      ? `LEADING INDICATORS: ${profile.leadingIndicators.slice(0, 5).join(", ")}`
      : "",
    profile.macroSensitivities.length
      ? `MACRO RISKS: ${profile.macroSensitivities.slice(0, 3).join(", ")}`
      : "",
    profile.companySpecificKPIs.length
      ? `KEY KPIs: ${profile.companySpecificKPIs.slice(0, 4).join(", ")}`
      : "",
    profile.typicalIndicatorLeadTime
      ? `INDICATOR LEAD TIME: ${profile.typicalIndicatorLeadTime}`
      : "",
  ].filter(Boolean).join("\n");
}

/**
 * Build a driver-directed search query list.
 * Returns the leading indicators AI should search for, in priority order.
 * Maximum 5 search topics to stay within token budget.
 */
export function buildDriverSearchTopics(
  profile: CompanyDriverProfile,
  daysUntilEvent: number | null
): string[] {
  const topics: string[] = [];

  // Leading indicators are the most directly observable signals
  for (const indicator of profile.leadingIndicators.slice(0, 3)) {
    topics.push(`${indicator} ${profile.company}`);
    if (topics.length >= 5) break;
  }

  // Revenue drivers as secondary topics
  for (const driver of profile.primaryRevenueDrivers.slice(0, 2)) {
    if (topics.length >= 5) break;
    topics.push(`${driver} ${profile.company} ${daysUntilEvent !== null && daysUntilEvent <= 30 ? "latest" : ""}`);
  }

  // Company context fallback
  if (topics.length < 5) {
    topics.push(`${profile.company} ${profile.ticker} latest news earnings guidance`);
  }

  return topics.slice(0, 5);
}
