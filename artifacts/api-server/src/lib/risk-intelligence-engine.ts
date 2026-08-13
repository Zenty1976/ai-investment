/**
 * Risk Intelligence Engine
 *
 * Computes all deterministic risk and portfolio facts from existing repository
 * data. No OpenAI calls are made here.
 *
 * Designed for shared use by Risk Analyzer and Portfolio Analyzer.
 * Call computeRiskFacts(nowIso) from any route that needs portfolio-level
 * quantitative facts without paying OpenAI to calculate them.
 *
 * Types and the pure computeRiskFactsFingerprint() function live in
 * risk-facts.ts so they can be imported and tested without pulling in this
 * file's dependency chain (price-context-service → saxo-store → pino).
 */
import { analysisRepository } from "./analysis-repository.js";
import { companyIdentityStore } from "./company-identity.js";
import { getPriceContext } from "./price-context-service.js";
import {
  computeRiskFactsFingerprint,
  type RiskFacts,
  type PriceRiskFacts,
  type ConcentrationFacts,
  type SectorFacts,
  type CurrencyFacts,
  type EventRiskFacts,
  type CompanyRiskFacts,
  type UpcomingEventFact,
  type PositionFact,
  type RiskIntelligenceResult,
} from "./risk-facts.js";

// Re-export everything from risk-facts.ts so callers only need one import.
export {
  computeRiskFactsFingerprint,
  type RiskFacts,
  type PriceRiskFacts,
  type ConcentrationFacts,
  type SectorFacts,
  type CurrencyFacts,
  type EventRiskFacts,
  type CompanyRiskFacts,
  type UpcomingEventFact,
  type PositionFact,
  type RiskIntelligenceResult,
} from "./risk-facts.js";
export type { PositionPriceSnapshot, ThesisFact } from "./risk-facts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

const DOWNTREND_STATES = new Set(["StrongDowntrend", "Downtrend"]);

// ─────────────────────────────────────────────────────────────────────────────
// Main computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute deterministic RiskFacts from current repository state.
 *
 * @param nowIso  Current UTC timestamp (ISO 8601). Used to filter upcoming events.
 * @returns  { riskFacts, fingerprint }
 */
export function computeRiskFacts(nowIso: string): RiskIntelligenceResult {
  const now = new Date(nowIso);
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // ── Portfolio data ─────────────────────────────────────────────────────────

  const portfolioEntry = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  const portfolioResult = (portfolioEntry?.result ?? {}) as Record<string, unknown>;

  const baseCurrency = String(portfolioResult.baseCurrency ?? "");
  const totalValue =
    typeof portfolioResult.totalValue === "number" ? portfolioResult.totalValue : null;

  const accounts: Array<Record<string, unknown>> = Array.isArray(portfolioResult.accounts)
    ? (portfolioResult.accounts as Array<Record<string, unknown>>)
    : [];

  // Flatten positions from all accounts
  const rawPositions: Array<{
    symbol: string;
    name: string;
    marketValueBase: number;
    currency: string;
  }> = [];

  for (const account of accounts) {
    const posArr = Array.isArray(account.positions)
      ? (account.positions as Array<Record<string, unknown>>)
      : [];
    for (const pos of posArr) {
      const mvb =
        typeof pos.marketValueBaseCurrency === "number" ? pos.marketValueBaseCurrency : 0;
      rawPositions.push({
        symbol: String(pos.symbol ?? "").toUpperCase(),
        name: String(pos.name ?? ""),
        marketValueBase: mvb,
        currency: String(pos.currency ?? ""),
      });
    }
  }

  const totalInvestedValue = rawPositions.reduce((s, p) => s + p.marketValueBase, 0);
  const baseForWeights = totalValue ?? totalInvestedValue;
  const cashPct =
    totalValue && totalValue > 0
      ? r1(((totalValue - totalInvestedValue) / totalValue) * 100)
      : 0;

  // ── Company Monitor lookups ────────────────────────────────────────────────
  // Build sector map and extract company risk signals for each holding.

  const allRepoEntries = analysisRepository.getAll();
  const cmCandidates = allRepoEntries
    .filter((e) => e.moduleName.startsWith("company-monitor:"))
    .map((e) => ({ key: e.moduleName, result: e.result as Record<string, unknown> }));

  const sectorBySymbol: Record<string, string> = {};
  const companyRisk: CompanyRiskFacts = {
    invalidatedTheses: [],
    weakenedTheses: [],
    strengthenedTheses: [],
    lowCaseStrength: [],
    avoidViewHoldings: [],
    viewDistribution: {},
  };

  for (const pos of rawPositions) {
    if (!pos.symbol || pos.symbol in sectorBySymbol) continue;

    const resolved = companyIdentityStore.resolve(
      pos.symbol,
      { companyName: pos.name },
      cmCandidates
    );
    if (!resolved) continue;

    const entry = analysisRepository.get<Record<string, unknown>>(resolved.key);
    if (!entry) continue;
    const r = entry.result as Record<string, unknown>;

    // Sector
    const company = r.company as Record<string, unknown> | undefined;
    if (company?.sector) sectorBySymbol[pos.symbol] = String(company.sector);

    // Thesis statuses
    if (Array.isArray(r.investmentThesis)) {
      for (const pt of r.investmentThesis as Array<Record<string, unknown>>) {
        const status = String(pt.status ?? "");
        const id = String(pt.id ?? "");
        if (status === "Invalidated") {
          companyRisk.invalidatedTheses.push({ ticker: pos.symbol, thesisId: id });
        } else if (status === "Weakened") {
          companyRisk.weakenedTheses.push({ ticker: pos.symbol, thesisId: id });
        } else if (status === "Strengthened") {
          companyRisk.strengthenedTheses.push({ ticker: pos.symbol, thesisId: id });
        }
      }
    }

    // Investment case strength
    const cs = r.investmentCaseStrength;
    if (typeof cs === "number" && cs < 40) {
      companyRisk.lowCaseStrength.push({ ticker: pos.symbol, strength: cs });
    }

    // Investment view
    const view = r.investmentView as Record<string, unknown> | undefined;
    const rating = view ? String(view.rating ?? "") : "";
    if (rating) {
      companyRisk.viewDistribution[rating] = (companyRisk.viewDistribution[rating] ?? 0) + 1;
      if (rating === "Avoid" || rating === "Strong Avoid") {
        companyRisk.avoidViewHoldings.push({ ticker: pos.symbol, view: rating });
      }
    }
  }

  // ── Position facts with weights ────────────────────────────────────────────

  const positionFacts: PositionFact[] = rawPositions.map((pos) => ({
    ticker: pos.symbol,
    name: pos.name,
    portfolioWeightPct: baseForWeights > 0 ? r1((pos.marketValueBase / baseForWeights) * 100) : 0,
    investedWeightPct:
      totalInvestedValue > 0 ? r1((pos.marketValueBase / totalInvestedValue) * 100) : 0,
    currency: pos.currency,
    sector: sectorBySymbol[pos.symbol] ?? "Unknown",
    marketValueBase: Math.round(pos.marketValueBase),
  }));

  // Sort by invested weight descending
  positionFacts.sort((a, b) => b.investedWeightPct - a.investedWeightPct);

  // ── Concentration ──────────────────────────────────────────────────────────

  const top3 = positionFacts.slice(0, 3);
  const top5 = positionFacts.slice(0, 5);

  const concentration: ConcentrationFacts = {
    topPositions: positionFacts.slice(0, 5),
    largestPositionTicker: positionFacts[0]?.ticker ?? null,
    largestPositionPct: positionFacts[0]?.investedWeightPct ?? 0,
    top3Pct: r1(top3.reduce((s, p) => s + p.investedWeightPct, 0)),
    top5Pct: r1(top5.reduce((s, p) => s + p.investedWeightPct, 0)),
    top3Tickers: top3.map((p) => p.ticker),
    positionsAbove20Pct: positionFacts.filter((p) => p.investedWeightPct > 20).map((p) => p.ticker),
    positionsAbove30Pct: positionFacts.filter((p) => p.investedWeightPct > 30).map((p) => p.ticker),
  };

  // ── Sector exposure ────────────────────────────────────────────────────────

  const sectorMap: Record<string, number> = {};
  for (const pos of positionFacts) {
    sectorMap[pos.sector] = (sectorMap[pos.sector] ?? 0) + pos.portfolioWeightPct;
  }
  const sectorExposures = Object.entries(sectorMap)
    .map(([name, pct]) => ({ name, pct: r1(pct) }))
    .sort((a, b) => b.pct - a.pct);

  const sectors: SectorFacts = {
    exposures: sectorExposures,
    largestSectorPct: sectorExposures[0]?.pct ?? 0,
    largestSectorName: sectorExposures[0]?.name ?? null,
  };

  // ── Currency exposure ──────────────────────────────────────────────────────

  const currencyMap: Record<string, number> = {};
  for (const pos of positionFacts) {
    if (!pos.currency) continue;
    currencyMap[pos.currency] = (currencyMap[pos.currency] ?? 0) + pos.portfolioWeightPct;
  }
  const currencies: CurrencyFacts = {
    exposures: Object.entries(currencyMap)
      .map(([currency, pct]) => ({ currency, pct: r1(pct) }))
      .sort((a, b) => b.pct - a.pct),
  };

  // ── Price risk ─────────────────────────────────────────────────────────────

  const priceRisk: PriceRiskFacts = {
    highVolatilityPct: 0,
    highVolatilityHoldings: [],
    strongDowntrendPct: 0,
    strongDowntrendHoldings: [],
    strongUptrendPct: 0,
    strongUptrendHoldings: [],
    fallingFastHoldings: [],
    risingHoldings: [],
    stabilizingFromDowntrendHoldings: [],
    missingPriceContext: [],
    perPositionState: {},
  };

  for (const pos of positionFacts) {
    const ctx = getPriceContext(pos.ticker);
    if (!ctx) {
      priceRisk.missingPriceContext.push(pos.ticker);
      continue;
    }

    // Record full categorical state for fingerprinting (catches any regime shift)
    priceRisk.perPositionState[pos.ticker] = {
      priceState: ctx.priceState,
      volatilityState: ctx.volatility.volatilityState,
      recentBehaviorState: ctx.recentBehavior?.state ?? null,
    };

    const w = pos.investedWeightPct;

    if (ctx.volatility.volatilityState === "High") {
      priceRisk.highVolatilityPct += w;
      priceRisk.highVolatilityHoldings.push(pos.ticker);
    }
    if (ctx.priceState === "StrongDowntrend") {
      priceRisk.strongDowntrendPct += w;
      priceRisk.strongDowntrendHoldings.push(pos.ticker);
    }
    if (ctx.priceState === "StrongUptrend") {
      priceRisk.strongUptrendPct += w;
      priceRisk.strongUptrendHoldings.push(pos.ticker);
    }

    const rb = ctx.recentBehavior;
    if (rb) {
      if (rb.state === "FallingFast") {
        priceRisk.fallingFastHoldings.push(pos.ticker);
      } else if (rb.state === "Rising") {
        priceRisk.risingHoldings.push(pos.ticker);
      } else if (rb.state === "Stabilizing" && DOWNTREND_STATES.has(ctx.priceState)) {
        priceRisk.stabilizingFromDowntrendHoldings.push(pos.ticker);
      }
    }
  }

  priceRisk.highVolatilityPct = r1(priceRisk.highVolatilityPct);
  priceRisk.strongDowntrendPct = r1(priceRisk.strongDowntrendPct);
  priceRisk.strongUptrendPct = r1(priceRisk.strongUptrendPct);

  // ── Event risk ─────────────────────────────────────────────────────────────

  const eventEntry = analysisRepository.get<Record<string, unknown>>("event-monitor");
  const rawEvents = eventEntry && Array.isArray(eventEntry.result.events)
    ? (eventEntry.result.events as Array<Record<string, unknown>>)
    : [];

  const symbolSet = new Set(rawPositions.map((p) => p.symbol));
  const namesLower: Record<string, string> = {};
  for (const pos of rawPositions) namesLower[pos.symbol] = pos.name.toLowerCase();

  function matchEventToHoldings(ev: Record<string, unknown>): string[] {
    const titleUp = String(ev.title ?? "").toUpperCase();
    const titleLow = String(ev.title ?? "").toLowerCase();
    const matched: string[] = [];
    for (const sym of symbolSet) {
      const nameLow = namesLower[sym] ?? "";
      if (titleUp.includes(sym) || (nameLow && titleLow.includes(nameLow))) {
        matched.push(sym);
      }
    }
    return matched;
  }

  const positionWeightByTicker: Record<string, number> = {};
  for (const pos of positionFacts) positionWeightByTicker[pos.ticker] = pos.portfolioWeightPct;

  const eventsNext3Days: UpcomingEventFact[] = [];
  const eventsNext7Days: UpcomingEventFact[] = [];
  const holdingsWithEvent3d = new Set<string>();
  const holdingsWithEvent7d = new Set<string>();

  for (const ev of rawEvents) {
    const importance = String(ev.importance ?? "");
    if (importance === "Low") continue;
    if (!ev.date) continue;
    const evDate = new Date(String(ev.date));
    if (isNaN(evDate.getTime()) || evDate < now) continue;

    const fact: UpcomingEventFact = {
      title: String(ev.title ?? ""),
      date: String(ev.date),
      importance,
      affectedHoldings: matchEventToHoldings(ev),
    };

    if (evDate <= in7Days) {
      eventsNext7Days.push(fact);
      for (const h of fact.affectedHoldings) holdingsWithEvent7d.add(h);
    }
    if (evDate <= in3Days) {
      eventsNext3Days.push(fact);
      for (const h of fact.affectedHoldings) holdingsWithEvent3d.add(h);
    }
  }

  // Sort by date ascending
  eventsNext3Days.sort((a, b) => a.date.localeCompare(b.date));
  eventsNext7Days.sort((a, b) => a.date.localeCompare(b.date));

  const portfolioPctWithEventNext3Days = r1(
    [...holdingsWithEvent3d].reduce((s, sym) => s + (positionWeightByTicker[sym] ?? 0), 0)
  );
  const portfolioPctWithEventNext7Days = r1(
    [...holdingsWithEvent7d].reduce((s, sym) => s + (positionWeightByTicker[sym] ?? 0), 0)
  );

  const eventRisk: EventRiskFacts = {
    eventsNext3Days,
    eventsNext7Days,
    portfolioPctWithEventNext3Days,
    portfolioPctWithEventNext7Days,
  };

  // ── Portfolio risk flags ───────────────────────────────────────────────────

  const flags: string[] = [];

  if (concentration.largestPositionPct > 30) {
    flags.push(
      `${concentration.largestPositionTicker} is ${concentration.largestPositionPct}% of invested capital — high concentration`
    );
  } else if (concentration.largestPositionPct > 20) {
    flags.push(
      `${concentration.largestPositionTicker} is ${concentration.largestPositionPct}% of invested capital`
    );
  }
  if (concentration.top3Pct > 70) {
    flags.push(`Top 3 positions (${concentration.top3Tickers.join(", ")}) are ${concentration.top3Pct}% of invested capital`);
  }

  if (cashPct > 20) {
    flags.push(`Cash is ${cashPct}% of portfolio (elevated)`);
  } else if (cashPct < 2 && rawPositions.length > 0) {
    flags.push(`Cash is ${cashPct}% of portfolio (near-fully invested)`);
  }

  if (sectors.largestSectorPct > 60) {
    flags.push(`${sectors.largestSectorName} sector is ${sectors.largestSectorPct}% of portfolio (heavy concentration)`);
  } else if (sectors.largestSectorPct > 40) {
    flags.push(`${sectors.largestSectorName} sector is ${sectors.largestSectorPct}% of portfolio`);
  }

  if (priceRisk.strongDowntrendPct > 15) {
    flags.push(
      `${priceRisk.strongDowntrendPct}% of invested portfolio is in StrongDowntrend: ${priceRisk.strongDowntrendHoldings.join(", ")}`
    );
  }
  if (priceRisk.highVolatilityPct > 20) {
    flags.push(
      `${priceRisk.highVolatilityPct}% of invested portfolio is in High-volatility positions: ${priceRisk.highVolatilityHoldings.join(", ")}`
    );
  }
  if (priceRisk.fallingFastHoldings.length > 0) {
    flags.push(`FallingFast (very sharp 3-day decline): ${priceRisk.fallingFastHoldings.join(", ")}`);
  }

  if (eventRisk.portfolioPctWithEventNext3Days > 10) {
    flags.push(
      `${eventRisk.portfolioPctWithEventNext3Days}% of portfolio has a material event within 3 days`
    );
  }
  if (eventRisk.portfolioPctWithEventNext7Days > 25) {
    flags.push(
      `${eventRisk.portfolioPctWithEventNext7Days}% of portfolio has a material event within 7 days`
    );
  }

  if (companyRisk.invalidatedTheses.length > 0) {
    const list = companyRisk.invalidatedTheses.map((t) => `${t.ticker}:${t.thesisId}`).join(", ");
    flags.push(`Invalidated thesis points: ${list}`);
  }
  if (companyRisk.weakenedTheses.length > 0) {
    const tickers = [...new Set(companyRisk.weakenedTheses.map((t) => t.ticker))].join(", ");
    flags.push(`Weakened thesis points in: ${tickers}`);
  }
  if (companyRisk.lowCaseStrength.length > 0) {
    const list = companyRisk.lowCaseStrength.map((l) => `${l.ticker}(${l.strength})`).join(", ");
    flags.push(`Low investment case strength (<40): ${list}`);
  }
  if (companyRisk.avoidViewHoldings.length > 0) {
    flags.push(
      `Avoid-rated holdings: ${companyRisk.avoidViewHoldings.map((h) => h.ticker).join(", ")}`
    );
  }

  // ── Assemble ───────────────────────────────────────────────────────────────

  const riskFacts: RiskFacts = {
    baseCurrency,
    portfolioValue: totalValue !== null ? Math.round(totalValue) : null,
    cashPct,
    numberOfHoldings: rawPositions.length,
    concentration,
    sectors,
    currencies,
    priceRisk,
    eventRisk,
    companyRisk,
    portfolioRiskFlags: flags,
    computedAt: nowIso,
  };

  return {
    riskFacts,
    fingerprint: computeRiskFactsFingerprint(riskFacts),
  };
}
