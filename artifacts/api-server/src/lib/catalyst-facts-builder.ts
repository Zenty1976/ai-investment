/**
 * Catalyst Facts Builder
 *
 * Assembles a compact CatalystFacts object from existing repository entries.
 * Zero AI calls. Zero new Saxo calls. Reads only from the analysis repository.
 *
 * Design rules:
 *   - DO NOT pass entire raw module outputs to AI — only the compact CatalystFacts.
 *   - If a field is unavailable, set it to null and note it in dataQuality.missingFields.
 *   - Signals in Part 1 come from CM catalysts + news monitor. Full driver-directed
 *     signal gathering is Part 2 (requires CompanyDriverProfile + catalyst web search).
 */

import { analysisRepository } from "./analysis-repository.js";
import { getPriceContext } from "./price-context-service.js";
import { getDriverProfile } from "./catalyst-repository.js";
import { buildPriceAsymmetryFacts } from "./catalyst-price-asymmetry.js";
import { DEFAULT_CATALYST_SCREENING_CONFIG } from "./catalyst-types.js";
import type {
  CatalystFacts,
  CatalystEvent,
  LeadingIndicatorSignal,
  EarningsHistoryProfile,
  ExpectationsProfile,
  SourceQualityCategory,
  InformationCategory,
} from "./catalyst-types.js";

// ── InformationCategory derivation ────────────────────────────────────────────

/**
 * Derive InformationCategory from sourceType/sourceQuality.
 * Used to tag signals with their epistemological status (spec §6).
 */
function deriveInformationCategory(
  sourceType: string,
  sourceQuality: SourceQualityCategory
): InformationCategory {
  if (sourceType === "CompanyAnnouncement" || sourceType === "RegFiling") return "CONFIRMED_FACT";
  if (sourceType === "OfficialStats" || sourceType === "IndustryData") return "INDUSTRY_SIGNAL";
  if (sourceQuality === "AnalystData") return "ANALYST_EXPECTATION";
  if (sourceQuality === "ReliableReporting" || sourceQuality === "DirectCompany") return "RELIABLE_REPORTING";
  if (sourceQuality === "AiInterpretation" || sourceType === "CompanyMonitor" || sourceType === "NewsMonitor") return "AI_INTERPRETATION";
  return "RELIABLE_REPORTING";
}

/**
 * Derive sourceOriginId from source name.
 * Strips URL to domain for deduplication purposes.
 */
function deriveSourceOriginId(source: string): string {
  try {
    const url = new URL(source);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return source.toLowerCase().replace(/\s+/g, "-").slice(0, 50);
  }
}

// ── Stub profiles (Part 1 — data not available) ───────────────────────────────

function unavailableEarningsHistory(): EarningsHistoryProfile {
  return {
    entries: [],
    dataSource: null,
    lastUpdatedAt: null,
    isUnavailable: true,
    unavailableReason:
      "Saxo Bank does not provide historical earnings data (EPS actuals/estimates, revenue, EBITDA). " +
      "An external data provider (e.g. Refinitiv, Alpha Vantage) is required.",
  };
}

function unavailableExpectations(): ExpectationsProfile {
  return {
    revenueConsensus: null,
    epsConsensus: null,
    ebitdaConsensus: null,
    otherRelevantMetrics: {},
    estimateRevision1M: null,
    estimateRevision3M: null,
    numberOfUpwardRevisions: null,
    numberOfDownwardRevisions: null,
    recentTargetChanges: null,
    recentRecommendationChanges: null,
    expectationsTrend: "Unknown",
    dataSource: null,
    lastUpdatedAt: null,
    isUnavailable: true,
    unavailableReason:
      "Saxo Bank does not provide analyst consensus estimates or recommendation changes. " +
      "An external data provider (e.g. FactSet, Bloomberg, Refinitiv) is required.",
  };
}

// ── Signal extraction from existing monitors (Part 1) ────────────────────────

function extractSignalsFromCompanyMonitor(
  ticker: string,
  cmResult: Record<string, unknown>,
  assembledAt: string
): LeadingIndicatorSignal[] {
  const signals: LeadingIndicatorSignal[] = [];

  // CM catalysts[] — upcoming catalysts noted in the company analysis
  const catalysts = cmResult.catalysts;
  if (Array.isArray(catalysts)) {
    for (const cat of catalysts) {
      if (!cat || typeof cat !== "object") continue;
      const c = cat as Record<string, unknown>;
      const title = String(c["title"] ?? "").trim();
      const description = String(c["description"] ?? "").trim();
      const impact = String(c["impact"] ?? "Neutral");
      if (!title) continue;

      const direction =
        impact === "High" || impact === "VeryHigh" ? "Positive" as const
        : impact === "Low" || impact === "VeryLow" ? "Negative" as const
        : "Neutral" as const;

      signals.push({
        signalId: `cm-catalyst-${ticker}-${title.slice(0, 30).replace(/\s+/g, "-").toLowerCase()}`,
        driver: "Company Catalyst",
        direction,
        observedFact: title,
        interpretation: description || null,
        previousContext: null,
        observationDate: assembledAt.slice(0, 10),
        source: "Company Monitor",
        sourceType: "CompanyMonitor",
        sourceQuality: "AiInterpretation",
        sourceConfidence: "Medium",
        leadTimeRelevance: "High",
        companyImpactReason: "Identified as a catalyst by Company Monitor AI analysis",
        freshness: "Fresh",
        informationCategory: "AI_INTERPRETATION",
        sourceOriginId: "company-monitor",
        canonicalSource: "Company Monitor AI Analysis",
        availableAt: assembledAt,
      });
    }
  }

  // Earnings and guidance trend as a signal
  const earningsGuidance = cmResult.earningsAndGuidance as Record<string, unknown> | undefined;
  if (earningsGuidance?.trend && earningsGuidance.trend !== "Stable") {
    const trend = String(earningsGuidance.trend);
    const direction = trend === "Improving" ? "Positive" as const
      : trend === "Weakening" ? "Negative" as const : "Neutral" as const;
    signals.push({
      signalId: `cm-earnings-trend-${ticker}`,
      driver: "Earnings/Guidance Trend",
      direction,
      observedFact: `Earnings and guidance trend: ${trend}`,
      interpretation: String(earningsGuidance.summary ?? ""),
      previousContext: null,
      observationDate: assembledAt.slice(0, 10),
      source: "Company Monitor",
      sourceType: "CompanyMonitor",
      sourceQuality: "AiInterpretation",
      sourceConfidence: "Medium",
      leadTimeRelevance: "High",
      companyImpactReason: "Earnings/guidance trend directly affects upcoming results",
      freshness: "Fresh",
      informationCategory: "AI_INTERPRETATION",
      sourceOriginId: "company-monitor",
      canonicalSource: "Company Monitor AI Analysis",
      availableAt: assembledAt,
    });
  }

  return signals;
}

function extractSignalsFromNews(
  ticker: string,
  newsResult: Record<string, unknown>,
  assembledAt: string
): LeadingIndicatorSignal[] {
  const signals: LeadingIndicatorSignal[] = [];
  const news = newsResult.news;
  if (!Array.isArray(news)) return signals;

  for (const item of news) {
    if (!item || typeof item !== "object") continue;
    const n = item as Record<string, unknown>;
    const headline = String(n["headline"] ?? "").trim();
    const summary = String(n["summary"] ?? "").trim();
    const companies = n["companies"];
    if (!headline) continue;

    // Only include news that mentions this ticker or is material market news
    const mentionsTicker = Array.isArray(companies)
      ? companies.some(c => String(c).toUpperCase().includes(ticker.toUpperCase().slice(0, 4)))
      : false;
    const isMarketWide = !Array.isArray(companies) || companies.length === 0;

    if (!mentionsTicker && !isMarketWide) continue;

    const sentiment = String(n["sentiment"] ?? "Neutral");
    const direction =
      sentiment === "Positive" || sentiment === "VeryPositive" ? "Positive" as const
      : sentiment === "Negative" || sentiment === "VeryNegative" ? "Negative" as const
      : "Neutral" as const;

    const newsSourceQuality: SourceQualityCategory = mentionsTicker ? "ReliableReporting" : "SecondaryReporting";
    signals.push({
      signalId: `news-${headline.slice(0, 40).replace(/\s+/g, "-").toLowerCase()}`,
      driver: "Market/Company News",
      direction,
      observedFact: headline,
      interpretation: summary || null,
      previousContext: null,
      observationDate: assembledAt.slice(0, 10),
      source: "News Monitor",
      sourceType: "NewsMonitor",
      sourceQuality: newsSourceQuality,
      sourceConfidence: "Medium",
      leadTimeRelevance: mentionsTicker ? "High" : "Low",
      companyImpactReason: mentionsTicker
        ? "News directly references this company"
        : "General market news that may affect overall conditions",
      freshness: "Fresh",
      informationCategory: deriveInformationCategory("NewsMonitor", newsSourceQuality),
      sourceOriginId: deriveSourceOriginId("News Monitor"),
      canonicalSource: "News Monitor AI Analysis",
      availableAt: assembledAt,
    });
  }

  return signals;
}

// ── Company info extraction ────────────────────────────────────────────────────

/**
 * Resolve investmentView to a plain string regardless of whether the CM
 * stores it as a plain string ("Buy") or as an object
 * { rating: "Watch", outlook: "Neutral", reason: "..." }.
 *
 * CM format note: all current company-monitor entries use the object shape
 * with a "rating" field. Plain-string shape is kept as a fallback for
 * backward-compat with any future schema changes.
 */
function resolveInvestmentView(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "string") return raw.trim() || null;
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const rating  = String(obj["rating"]  ?? "").trim();
    const outlook = String(obj["outlook"] ?? "").trim();
    if (rating)  return rating;
    if (outlook) return outlook;
    // Fallback: stringify whatever key we can find
    const first = Object.values(obj).find(v => typeof v === "string" && v.trim());
    return first ? String(first).trim() : null;
  }
  return null;
}

/**
 * Resolve investmentCaseStrength to a categorical string.
 * CM stores it as a 0–100 numeric score; we convert to Low/Medium/High.
 * If it's already a string (future schema), use it directly.
 */
function resolveInvestmentCaseStrength(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    if (raw >= 70) return "High";
    if (raw >= 40) return "Medium";
    return "Low";
  }
  if (typeof raw === "string") return raw.trim() || null;
  return null;
}

function extractCompanyInfo(cmResult: Record<string, unknown>): {
  investmentView: string | null;
  investmentCaseStrength: string | null;
  investmentThesis: string | null;
  bullCase: string | null;
  bearCase: string | null;
  earningsGuidanceTrend: "Improving" | "Stable" | "Weakening" | null;
  recentMeaningfulChange: string | null;
  sector: string | null;
  industry: string | null;
} {
  const eg     = cmResult.earningsAndGuidance as Record<string, unknown> | undefined;
  const change = cmResult.investmentCaseChange as Record<string, unknown> | undefined;
  const comp   = cmResult.company as Record<string, unknown> | undefined;

  return {
    investmentView:         resolveInvestmentView(cmResult.investmentView),
    investmentCaseStrength: resolveInvestmentCaseStrength(cmResult.investmentCaseStrength),
    investmentThesis:       String(cmResult.investmentThesis ?? "").trim() || null,
    bullCase:               String(cmResult.bullCase ?? "").trim() || null,
    bearCase:               String(cmResult.bearCase ?? "").trim() || null,
    earningsGuidanceTrend:
      (eg?.trend === "Improving" || eg?.trend === "Stable" || eg?.trend === "Weakening")
        ? eg.trend as "Improving" | "Stable" | "Weakening"
        : null,
    recentMeaningfulChange:
      change && change.severity !== "None"
        ? String(change.summary ?? "").trim() || null
        : null,
    sector:   String(comp?.sector   ?? "").trim() || null,
    industry: String(comp?.industry ?? "").trim() || null,
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export interface CatalystFactsInputs {
  ticker: string;
  /**
   * PATH A: The scheduled upcoming event.
   * PATH B (EMERGING_SETUP): null — no event required.
   * When null, price asymmetry uses a default 45-day window.
   */
  event: CatalystEvent | null;
  /**
   * Additional signals to merge from the persistent signal store.
   * These are historical signals from prior runs (for 7D/14D/30D accumulation).
   */
  storedSignals?: LeadingIndicatorSignal[];
}

/**
 * Assemble CatalystFacts for a ticker from existing repository data.
 *
 * Supports PATH A (event != null) and PATH B (event = null, EMERGING_SETUP).
 * For PATH B, price asymmetry uses a default 45-day window and event-related
 * fields are null/unavailable.
 *
 * Returns a complete CatalystFacts object with all available data populated
 * and all unavailable data clearly marked in dataQuality.
 */
export function buildCatalystFacts(inputs: CatalystFactsInputs): CatalystFacts {
  const { ticker, event, storedSignals = [] } = inputs;
  const assembledAt = new Date().toISOString();
  const missingFields: string[] = [];
  const staleFields: string[] = [];

  // ── Company Monitor ────────────────────────────────────────────────────────
  const cmEntry = analysisRepository.get<Record<string, unknown>>(
    `company-monitor:${ticker.toUpperCase()}`
  );
  const cmResult = cmEntry?.result ?? {};

  // Check CM freshness (stale if > 6 hours old)
  if (!cmEntry) {
    missingFields.push("company-monitor");
  } else {
    const cmAgeMs = Date.now() - new Date(cmEntry.updatedAt).getTime();
    if (cmAgeMs > 6 * 3_600_000) staleFields.push("company-monitor");
  }

  const companyInfo = extractCompanyInfo(cmResult);

  // ── Price Context ──────────────────────────────────────────────────────────
  const pc = getPriceContext(ticker);
  if (!pc) missingFields.push("price-context");

  // For PATH B (no event), use a neutral 45-day window for price asymmetry
  const daysForAsymmetry = event?.daysUntilEvent ?? 45;
  const priceAsymmetryFacts = pc
    ? buildPriceAsymmetryFacts(pc, daysForAsymmetry, DEFAULT_CATALYST_SCREENING_CONFIG)
    : {
        preEventRunupPct: null, preEventRunupPeriod: null,
        recentMomentum5D: null, recentMomentum10D: null,
        momentum30D: null, momentum90D: null,
        drawdownFrom30DayHighPct: null, distanceFrom90DayHighPct: null,
        distanceFrom90DayLowPct: null,
        runupPattern: "Unknown" as const, asymmetry: "Neutral" as const,
        reasoning: "Price data unavailable",
      };

  // ── News Monitor ───────────────────────────────────────────────────────────
  const newsEntry = analysisRepository.get<Record<string, unknown>>("news-monitor");
  if (!newsEntry) missingFields.push("news-monitor");

  // ── Sector Monitor ─────────────────────────────────────────────────────────
  const sectorEntry = analysisRepository.get<Record<string, unknown>>("sector-monitor");
  if (!sectorEntry) missingFields.push("sector-monitor");

  // ── Market Monitor ─────────────────────────────────────────────────────────
  const marketEntry = analysisRepository.get<Record<string, unknown>>("market-monitor");
  if (!marketEntry) missingFields.push("market-monitor");

  // ── Driver Profile ─────────────────────────────────────────────────────────
  const driverProfile = getDriverProfile(ticker) ?? null;
  if (!driverProfile) missingFields.push("company-driver-profile");

  // ── Signals: current-run (CM + News) + historical (signal store) ──────────
  const currentRunSignals: LeadingIndicatorSignal[] = [
    ...extractSignalsFromCompanyMonitor(ticker, cmResult, assembledAt),
    ...(newsEntry?.result ? extractSignalsFromNews(ticker, newsEntry.result as Record<string, unknown>, assembledAt) : []),
  ];

  // Merge with stored historical signals (Part 2: driver-directed research)
  // Deduplicate by signalId — current-run signals take precedence
  const currentRunIds = new Set(currentRunSignals.map(s => s.signalId));
  const historicalOnly = storedSignals.filter(s => !currentRunIds.has(s.signalId));
  const signals: LeadingIndicatorSignal[] = [...currentRunSignals, ...historicalOnly];

  // ── Material news extraction ───────────────────────────────────────────────
  const allNews = (newsEntry?.result as Record<string, unknown> | undefined)?.news;
  const materialNews = Array.isArray(allNews)
    ? (allNews as Array<Record<string, unknown>>)
        .filter(n => {
          const companies = n["companies"];
          return Array.isArray(companies) &&
            companies.some(c => String(c).toUpperCase().includes(ticker.toUpperCase().slice(0, 4)));
        })
        .slice(0, 5)
        .map(n => ({
          headline: String(n["headline"] ?? ""),
          summary:  String(n["summary"]  ?? "") || null,
          publishedAt: null,
          sourceQuality: "ReliableReporting" as SourceQualityCategory,
        }))
    : [];

  // ── Sector state ───────────────────────────────────────────────────────────
  const sectorResult = sectorEntry?.result as Record<string, unknown> | undefined;
  const sectorSummary = String(sectorResult?.summary ?? "").trim() || null;
  const sectorTrend: string | null = null; // computed in Part 2

  // ── Market state ───────────────────────────────────────────────────────────
  const marketResult = marketEntry?.result as Record<string, unknown> | undefined;

  // ── Risks ──────────────────────────────────────────────────────────────────
  const risks: string[] = [];
  const cmRisks = cmResult.risks;
  if (Array.isArray(cmRisks)) {
    for (const r of cmRisks) {
      if (r && typeof r === "object") {
        const rObj = r as Record<string, unknown>;
        const title = String(rObj["title"] ?? "").trim();
        if (title) risks.push(title);
      }
    }
  }

  // ── Data quality ───────────────────────────────────────────────────────────
  const overallSourceConfidence: "High" | "Medium" | "Low" =
    missingFields.length >= 3 ? "Low"
    : missingFields.length >= 1 ? "Medium"
    : "High";

  return {
    assembledAt,
    event,
    price: {
      currentPrice:      pc?.currentPrice ?? null,
      priceState:        pc?.priceState ?? "Unknown",
      priceAsymmetryFacts,
      volatilityState:   pc?.volatility.volatilityState ?? null,
      volatilityTrend:   pc?.volatility.volatilityTrend ?? null,
      shortTermTrend:    pc?.trend.shortTermTrend ?? null,
      mediumTermTrend:   pc?.trend.mediumTermTrend ?? null,
      longTermTrend:     pc?.trend.longTermTrend ?? null,
      momentumChange:    pc?.trend.momentumChange ?? null,
      recentBehavior:    pc?.recentBehavior?.state ?? null,
    },
    history:      unavailableEarningsHistory(),
    expectations: unavailableExpectations(),
    company: {
      investmentView:       companyInfo.investmentView,
      investmentCaseStrength: companyInfo.investmentCaseStrength,
      investmentThesis:     companyInfo.investmentThesis,
      bullCase:             companyInfo.bullCase,
      bearCase:             companyInfo.bearCase,
      earningsGuidanceTrend: companyInfo.earningsGuidanceTrend,
      recentMeaningfulChange: companyInfo.recentMeaningfulChange,
      driverProfile,
      sector:   companyInfo.sector,
      industry: companyInfo.industry,
    },
    signals,
    sector: sectorEntry ? { sectorSummary, sectorTrend } : null,
    market: marketEntry ? {
      marketSentiment: String(marketResult?.marketSentiment ?? "") || null,
      riskLevel:       String(marketResult?.riskLevel ?? "") || null,
      marketSummary:   String(marketResult?.summary ?? "") || null,
    } : null,
    news: {
      materialNews,
      newsCount: Array.isArray(allNews) ? allNews.length : 0,
    },
    risks,
    dataQuality: {
      missingFields,
      staleFields,
      overallSourceConfidence,
      earningsHistoryAvailable: false,
      consensusDataAvailable:   false,
      driverProfileAvailable:   !!driverProfile,
    },
  };
}
