/**
 * Downstream AI Context Layer
 *
 * Provides small, semantically minimal structured objects for machine-to-machine
 * AI reasoning. These are specifically designed for downstream synthesis modules
 * (Portfolio Analyzer, Risk Analyzer, Trade Decision Engine) to avoid information
 * fan-out and token duplication.
 *
 * Rules:
 *  - Never calls OpenAI.
 *  - Always reads from analysisRepository — never imports route-level logic.
 *  - Returns compact objects; prose summaries and duplicate fields are stripped.
 *  - Callers can pass optional filter arrays to further restrict the result.
 */

import { analysisRepository } from "./analysis-repository.js";
import type { RepositoryEntry } from "./analysis-repository.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).map(String) : [];
}

function haystackMatch(needles: string[], ...sources: string[]): boolean {
  if (needles.length === 0) return false;
  const hay = sources.join(" ").toLowerCase();
  return needles.some((n) => hay.includes(n.toLowerCase()));
}

// ── Market context ────────────────────────────────────────────────────────────

export interface MarketAiContext {
  sentiment: unknown;
  riskLevel: unknown;
  materialDrivers: unknown;
  keyRisks: unknown;
  materialVersion?: number;
}

/**
 * Compact market context.
 * Omits summary prose, positiveFactors/negativeFactors lists, strongSectors/weakSectors.
 */
export function getMarketAiContext(): MarketAiContext | null {
  const entry = analysisRepository.get<Record<string, unknown>>("market-monitor");
  if (!entry) return null;
  const r = entry.result;
  return {
    sentiment: r.marketSentiment,
    riskLevel: r.riskLevel,
    materialDrivers: r.keyRisks, // keyRisks is the most actionable field
    keyRisks: r.keyRisks,
    materialVersion: (entry as RepositoryEntry<Record<string, unknown>> & { materialVersion?: number }).materialVersion,
  };
}

// ── News context ──────────────────────────────────────────────────────────────

export interface MaterialNewsItem {
  category: unknown;
  importance: unknown;
  affectedSymbols: unknown;
  impact: unknown;
}

export interface NewsAiContext {
  materialNews: MaterialNewsItem[];
  materialVersion?: number;
}

/**
 * Compact news context.
 * When filterSymbols or filterSectors are provided, only High-importance items
 * and items matching those filters are included. This prevents general market
 * noise from flowing into synthesis modules.
 */
export function getNewsAiContext(
  filterSymbols?: string[],
  filterSectors?: string[]
): NewsAiContext | null {
  const entry = analysisRepository.get<Record<string, unknown>>("news-monitor");
  if (!entry) return null;
  const r = entry.result;

  const hasFilters = (filterSymbols?.length ?? 0) + (filterSectors?.length ?? 0) > 0;

  let news = Array.isArray(r.news) ? (r.news as Array<Record<string, unknown>>) : [];

  if (hasFilters) {
    const syms = (filterSymbols ?? []).map((s) => s.toLowerCase());
    const sects = (filterSectors ?? []).map((s) => s.toLowerCase());
    news = news.filter((n) => {
      if (n.importance === "High") return true;
      return haystackMatch(
        [...syms, ...sects],
        str(n.title),
        str(n.marketImpact),
        ...strArr(n.affectedSymbols),
        ...strArr(n.affectedMarkets)
      );
    });
  }

  return {
    materialNews: news.map((n) => ({
      category: n.category,
      importance: n.importance,
      affectedSymbols: n.affectedSymbols ?? n.affectedMarkets,
      impact: n.marketImpact,
    })),
    materialVersion: (entry as RepositoryEntry<Record<string, unknown>> & { materialVersion?: number }).materialVersion,
  };
}

// ── Event context ─────────────────────────────────────────────────────────────

export interface MaterialEventItem {
  date: unknown;
  importance: unknown;
  affectedSymbolsOrMarkets: unknown;
  impactType: unknown;
}

export interface EventAiContext {
  upcomingMaterialEvents: MaterialEventItem[];
}

/**
 * Compact event context. Only includes the fields relevant to AI reasoning.
 * Optionally filters by symbols/sectors for synthesis modules.
 */
export function getEventAiContext(
  filterSymbols?: string[],
  filterSectors?: string[]
): EventAiContext | null {
  const entry = analysisRepository.get<Record<string, unknown>>("event-monitor");
  if (!entry) return null;
  const r = entry.result;

  const hasFilters = (filterSymbols?.length ?? 0) + (filterSectors?.length ?? 0) > 0;

  let events = Array.isArray(r.events)
    ? (r.events as Array<Record<string, unknown>>)
    : [];

  if (hasFilters) {
    const syms = (filterSymbols ?? []).map((s) => s.toLowerCase());
    const sects = (filterSectors ?? []).map((s) => s.toLowerCase());
    events = events.filter((e) => {
      if (e.importance === "High") return true;
      return haystackMatch(
        [...syms, ...sects],
        str(e.title),
        str(e.expectedImpact),
        ...strArr(e.affectedMarkets),
        ...strArr(e.affectedSymbols)
      );
    });
  }

  return {
    upcomingMaterialEvents: events.map((e) => ({
      date: e.date,
      importance: e.importance,
      affectedSymbolsOrMarkets: e.affectedMarkets ?? e.affectedSymbols,
      impactType: e.expectedImpact,
    })),
  };
}

// ── Sector context ────────────────────────────────────────────────────────────

export interface SectorAiContext {
  overallOutlook: unknown;
  sectors: Array<{ name: unknown; rating: unknown; trend: unknown }>;
}

/**
 * Compact sector context. Optionally filters to specific sectors.
 */
export function getSectorAiContext(filterSectors?: string[]): SectorAiContext | null {
  const entry = analysisRepository.get<Record<string, unknown>>("sector-monitor");
  if (!entry) return null;
  const r = entry.result;

  let sectors = Array.isArray(r.sectors)
    ? (r.sectors as Array<Record<string, unknown>>)
    : [];

  if (filterSectors?.length) {
    const low = filterSectors.map((s) => s.toLowerCase());
    sectors = sectors.filter((s) =>
      low.some((f) => str(s.name).toLowerCase().includes(f))
    );
  }

  return {
    overallOutlook: r.overallOutlook,
    sectors: sectors.map((s) => ({
      name: s.name,
      rating: s.rating,
      trend: s.trend,
    })),
  };
}

// ── Company context ───────────────────────────────────────────────────────────

export interface CompanyAiContext {
  symbol: string;
  view: unknown;
  caseStrength: unknown;
  materialChange: unknown;
  thesisChanges: Array<{ id: unknown; status: unknown }>;
  topRisks: unknown[];
  topCatalysts: unknown[];
  valuation: unknown;
  confidence: unknown;
  materialVersion?: number;
}

/**
 * Compact company context. Omits all prose: executiveSummary, stableProfile,
 * bullCase, baseCase, bearCase, competitivePosition, currentSituation.
 * Price state is injected separately via Price Context.
 */
export function getCompanyAiContext(moduleName: string, symbol: string): CompanyAiContext | null {
  const entry = analysisRepository.get<Record<string, unknown>>(moduleName);
  if (!entry) return null;
  const r = entry.result;

  const thesis = Array.isArray(r.investmentThesis)
    ? (r.investmentThesis as Array<Record<string, unknown>>).map((p) => ({
        id: p.id,
        status: p.status,
      }))
    : [];

  const topRisks = Array.isArray(r.risks)
    ? (r.risks as Array<Record<string, unknown>>)
        .slice(0, 3)
        .map((ri) => ri.title ?? ri)
    : [];

  const topCatalysts = Array.isArray(r.catalysts)
    ? (r.catalysts as Array<Record<string, unknown>>)
        .slice(0, 3)
        .map((c) => c.title ?? c)
    : [];

  return {
    symbol,
    view: r.investmentView,
    caseStrength: r.investmentCaseStrength,
    materialChange: r.investmentCaseChange,
    thesisChanges: thesis,
    topRisks,
    topCatalysts,
    valuation: r.valuationAssessment,
    confidence: r.confidence,
    materialVersion: (entry as RepositoryEntry<Record<string, unknown>> & { materialVersion?: number }).materialVersion,
  };
}

// ── Portfolio Analyzer context ────────────────────────────────────────────────

export interface PortfolioAnalyzerAiContext {
  overallRating: unknown;
  overallOutlook: unknown;
  portfolioScore: unknown;
  mainConclusion: unknown;
  strengths: unknown;
  weaknesses: unknown;
  topRisks: unknown;
  topOpportunities: unknown;
  recommendedActions: unknown;
  materialVersion?: number;
}

export function getPortfolioAnalyzerAiContext(): PortfolioAnalyzerAiContext | null {
  const entry = analysisRepository.get<Record<string, unknown>>("portfolio-analyzer");
  if (!entry) return null;
  const r = entry.result;
  return {
    overallRating: r.overallRating,
    overallOutlook: r.overallOutlook,
    portfolioScore: r.portfolioScore,
    mainConclusion: r.mainConclusion,
    strengths: r.strengths,
    weaknesses: r.weaknesses,
    topRisks: r.topRisks,
    topOpportunities: r.topOpportunities,
    recommendedActions: r.recommendedActions,
    materialVersion: (entry as RepositoryEntry<Record<string, unknown>> & { materialVersion?: number }).materialVersion,
  };
}

// ── Risk Analyzer context ─────────────────────────────────────────────────────

export interface RiskAnalyzerAiContext {
  overallRiskLevel: unknown;
  riskScore: unknown;
  previousRiskScore: unknown;
  mainConclusion: unknown;
  topRisks: unknown;
  riskInteractions: unknown;
  watchClosely: unknown;
  materialVersion?: number;
}

export function getRiskAnalyzerAiContext(): RiskAnalyzerAiContext | null {
  const entry = analysisRepository.get<Record<string, unknown>>("risk-analyzer");
  if (!entry) return null;
  const r = entry.result;
  return {
    overallRiskLevel: r.overallRiskLevel,
    riskScore: r.riskScore,
    previousRiskScore: r.previousRiskScore,
    mainConclusion: r.mainConclusion,
    topRisks: r.topRisks,
    riskInteractions: r.riskInteractions,
    watchClosely: r.watchClosely,
    materialVersion: (entry as RepositoryEntry<Record<string, unknown>> & { materialVersion?: number }).materialVersion,
  };
}

// ── Opportunity Finder context ────────────────────────────────────────────────

export interface OpportunityAiContext {
  overallOpportunityLevel: unknown;
  topOpportunities: Array<Record<string, unknown>>;
  sectorIdeas: unknown;
}

export function getOpportunityAiContext(): OpportunityAiContext | null {
  const entry = analysisRepository.get<Record<string, unknown>>("opportunity-finder");
  if (!entry) return null;
  const r = entry.result;
  return {
    overallOpportunityLevel: r.overallOpportunityLevel,
    topOpportunities: Array.isArray(r.topOpportunities)
      ? (r.topOpportunities as Array<Record<string, unknown>>).slice(0, 5).map((o) => ({
          rank: o.rank,
          company: o.company,
          ticker: o.ticker,
          sector: o.sector,
          overallScore: o.overallScore,
          confidence: o.confidence,
          priority: o.priority,
          investmentThesis: o.investmentThesis,
          whyNow: o.whyNow,
          whyThisPortfolio: o.whyThisPortfolio,
          mainCatalyst: o.mainCatalyst,
          mainRisk: o.mainRisk,
          companyAnalysisAvailable: o.companyAnalysisAvailable,
        }))
      : [],
    sectorIdeas: r.sectorIdeas,
  };
}

// ── Market Alerts context ─────────────────────────────────────────────────────

export interface MarketAlertsAiContext {
  overallAlertLevel: unknown;
  headline: unknown;
  alerts: Array<Record<string, unknown>>;
  thingsToWatch: unknown;
}

export function getMarketAlertsAiContext(): MarketAlertsAiContext | null {
  const entry = analysisRepository.get<Record<string, unknown>>("market-alerts");
  if (!entry) return null;
  const r = entry.result;
  return {
    overallAlertLevel: r.overallAlertLevel,
    headline: r.headline,
    alerts: Array.isArray(r.alerts)
      ? (r.alerts as Array<Record<string, unknown>>).map((a) => ({
          title: a.title,
          category: a.category,
          importance: a.importance,
          affectedSymbol: a.affectedSymbol ?? a.symbol,
        }))
      : [],
    thingsToWatch: r.thingsToWatch,
  };
}
