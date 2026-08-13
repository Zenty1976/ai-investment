/**
 * Sector Intelligence Layer
 *
 * Deterministic backend computation for Sector Monitor — no OpenAI calls.
 *
 * Computes:
 *   - Portfolio sector exposure from live position data + Company Monitor sector
 *   - A stable input fingerprint from all deterministic inputs (upstream module
 *     states + portfolio exposure). If this fingerprint is unchanged from the
 *     last AI call, Sector Monitor can reuse the previous qualitative interpretation
 *     without calling OpenAI.
 *   - An output fingerprint from the AI-produced sector ratings/trends, for
 *     downstream materiality tracking.
 *   - A compact SectorFacts block to inject into the AI prompt so OpenAI receives
 *     objective portfolio exposure facts and doesn't need to calculate them.
 *
 * No sector ETF/index price series exists in the current application. Returns,
 * relative performance, and rotation signals derived from price data are therefore
 * NOT computed here — see DATA GAPS section at the bottom of this file.
 *
 * Naming: uses SectorMonitorFacts to avoid collision with the existing SectorFacts
 * type in risk-facts.ts (which covers risk-engine sector concentration).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** How much of the portfolio is concentrated in a sector. */
export type ExposureBand = "Significant" | "Moderate" | "Minor" | "None";

/** Exposure to one sector, derived from live portfolio positions. */
export interface SectorPortfolioExposure {
  sector: string;
  /** Market value of positions in this sector (base currency) */
  marketValueBc: number;
  /** % of total classifiable portfolio value (0–100) */
  exposurePct: number;
  /** Discrete exposure band — stable across small market-value fluctuations */
  band: ExposureBand;
  /** Holdings in this sector */
  tickers: string[];
}

/** What the Sector Intelligence layer produces from deterministic data. */
export interface SectorMonitorFacts {
  /** Sector exposures for all sectors with ≥1 known holding, sorted by exposure desc */
  portfolioExposure: SectorPortfolioExposure[];
  /** Sectors with known holdings but no sector classification */
  unclassifiedTickers: string[];
  /** % of classifiable portfolio MV that has a known sector (0–100) */
  coveragePct: number;
  /** Confidence level for portfolio-sector analytics */
  coverageConfidence: "High" | "Medium" | "Low";
  /** Total portfolio market value in base currency that was used for exposure calc */
  totalClassifiableMv: number;
}

// ── Exposure ──────────────────────────────────────────────────────────────────

/**
 * Map an exposure percentage to a stable discrete band.
 *
 * Bands are defined conservatively to prevent fingerprint churn from small
 * market-value fluctuations:
 *   Significant  ≥ 15%
 *   Moderate      5% – 14.99%
 *   Minor         1% – 4.99%
 *   None         < 1%
 */
export function computeExposureBand(pct: number): ExposureBand {
  if (pct >= 15) return "Significant";
  if (pct >= 5) return "Moderate";
  if (pct >= 1) return "Minor";
  return "None";
}

/**
 * Compute portfolio sector exposure from a portfolio snapshot and a
 * company-sector map derived from Company Monitor repository entries.
 *
 * @param positions  Flat array of portfolio positions (from all accounts).
 *                   Each position needs: symbol, marketValueBaseCurrency.
 * @param sectorByTicker  Map of UPPERCASE ticker → sector name (from CM data).
 * @returns SectorMonitorFacts — deterministic, no AI, no network calls.
 */
export function computePortfolioSectorExposure(
  positions: Array<{ symbol: string; marketValueBaseCurrency: number }>,
  sectorByTicker: Map<string, string>
): SectorMonitorFacts {
  const sectorMv = new Map<string, number>();
  const sectorTickers = new Map<string, string[]>();
  const unclassifiedTickers: string[] = [];
  let totalPositionMv = 0;

  for (const pos of positions) {
    const mv = pos.marketValueBaseCurrency ?? 0;
    if (mv <= 0) continue; // skip zero/negative market values (shorts, errors)
    const ticker = pos.symbol.toUpperCase().trim();
    const sector = sectorByTicker.get(ticker);
    totalPositionMv += mv;

    if (sector && sector.trim()) {
      const norm = sector.trim();
      sectorMv.set(norm, (sectorMv.get(norm) ?? 0) + mv);
      const existing = sectorTickers.get(norm) ?? [];
      if (!existing.includes(ticker)) existing.push(ticker);
      sectorTickers.set(norm, existing);
    } else {
      if (!unclassifiedTickers.includes(ticker)) {
        unclassifiedTickers.push(ticker);
      }
    }
  }

  const classifiedMv = [...sectorMv.values()].reduce((s, v) => s + v, 0);
  const totalClassifiableMv = totalPositionMv;
  const coveragePct = totalPositionMv > 0
    ? Math.round((classifiedMv / totalPositionMv) * 1000) / 10
    : 0;

  const coverageConfidence: "High" | "Medium" | "Low" =
    coveragePct >= 70 ? "High" : coveragePct >= 40 ? "Medium" : "Low";

  const portfolioExposure: SectorPortfolioExposure[] = [...sectorMv.entries()]
    .map(([sector, mv]) => {
      const exposurePct = totalPositionMv > 0
        ? Math.round((mv / totalPositionMv) * 1000) / 10
        : 0;
      return {
        sector,
        marketValueBc: Math.round(mv),
        exposurePct,
        band: computeExposureBand(exposurePct),
        tickers: (sectorTickers.get(sector) ?? []).sort(),
      };
    })
    .sort((a, b) => b.exposurePct - a.exposurePct);

  return {
    portfolioExposure,
    unclassifiedTickers: unclassifiedTickers.sort(),
    coveragePct,
    coverageConfidence,
    totalClassifiableMv: Math.round(totalClassifiableMv),
  };
}

// ── Compact prompt block ───────────────────────────────────────────────────────

/**
 * Build a compact text block that describes portfolio sector exposure
 * to inject into the AI system prompt.
 *
 * The AI receives objective facts so it doesn't need to calculate them.
 * Includes coverage caveats when data is incomplete.
 */
export function buildSectorFactsBlock(facts: SectorMonitorFacts): string {
  const lines: string[] = [
    "PORTFOLIO SECTOR EXPOSURE (deterministic — do NOT recalculate these):",
  ];

  if (facts.portfolioExposure.length === 0) {
    lines.push(
      "  No sector classification available for current holdings.",
      "  Coverage: Low (sector data not available — do not estimate exposure from position names)."
    );
    if (facts.unclassifiedTickers.length > 0) {
      lines.push(`  Unclassified tickers: ${facts.unclassifiedTickers.join(", ")}`);
    }
    return lines.join("\n");
  }

  for (const e of facts.portfolioExposure) {
    const tickerList = e.tickers.length > 0 ? ` (${e.tickers.join(", ")})` : "";
    lines.push(`  ${e.sector}: ${e.exposurePct.toFixed(1)}% — ${e.band}${tickerList}`);
  }

  if (facts.unclassifiedTickers.length > 0) {
    lines.push(`  Unclassified holdings: ${facts.unclassifiedTickers.join(", ")} (no sector data available — do not guess)`);
  }

  lines.push(
    `  Coverage: ${facts.coveragePct.toFixed(0)}% of portfolio value classified (${facts.coverageConfidence} confidence)`
  );

  return lines.join("\n");
}

// ── Fingerprints ───────────────────────────────────────────────────────────────

/**
 * Compute a stable input fingerprint from all deterministic inputs that
 * determine whether the sector analysis needs to be re-run.
 *
 * Uses DISCRETE structured data only — not prose text — so small wording
 * changes in narrative fields do not trigger unnecessary AI runs.
 *
 * @param marketSentiment  e.g. "Bullish" | "Neutral" | "Bearish"
 * @param marketRisk       e.g. "High" | "Medium" | "Low"
 * @param marketStrongSectors  sorted list of sectors market-monitor labels strong
 * @param marketWeakSectors    sorted list of sectors market-monitor labels weak
 * @param upcomingEventKeys    sorted list of "title|date" for upcoming events
 * @param newsImpact           e.g. "Positive" | "Mixed" | "Negative"
 * @param newsTopStoryTitle    title of the top news story (stable, not prose)
 * @param portfolioExposureBands  sorted list of "sector:band" pairs
 */
export function computeInputFingerprint(
  marketSentiment: string,
  marketRisk: string,
  marketStrongSectors: string[],
  marketWeakSectors: string[],
  upcomingEventKeys: string[],
  newsImpact: string,
  newsTopStoryTitle: string,
  portfolioExposureBands: string[]
): string {
  const parts = [
    `mkt:${marketSentiment}:${marketRisk}`,
    `strong:${[...marketStrongSectors].sort().join(",")}`,
    `weak:${[...marketWeakSectors].sort().join(",")}`,
    `events:${[...upcomingEventKeys].sort().join(",")}`,
    `news:${newsImpact}:${newsTopStoryTitle}`,
    `exp:${[...portfolioExposureBands].sort().join(",")}`,
  ];
  return parts.join("|");
}

/**
 * Compute the output fingerprint from the AI-produced sector list.
 *
 * Only captures name:rating:trend — the qualitatively meaningful fields.
 * Summary prose, drivers, risks, outlook text are excluded so that minor
 * wording variations don't trigger unnecessary downstream refreshes.
 *
 * The rating and trend enums are discrete buckets, so this naturally provides
 * hysteresis: Technology moving from "Moderately Strong" to "Strong" IS
 * material; minor return fluctuations within one bucket are NOT.
 */
export function computeOutputFingerprint(
  sectors: Array<{ name: string; rating: string; trend: string }>
): string {
  return sectors
    .map((s) => `${String(s.name)}:${String(s.rating)}:${String(s.trend)}`)
    .sort()
    .join(";");
}

/**
 * Returns true when the sector output changed in a way that matters to
 * downstream consumers (ranking change, rating change, trend change).
 *
 * A one-sector noisy rank swap with identical ratings is still captured
 * here — but the sorted fingerprint means ordering within the same rating
 * band does NOT cause a change.
 *
 * Note: "materiality" at the output level is coarser than raw position rank.
 * The fingerprint is sorted so position-only swaps within the same
 * name:rating:trend tuple do not register as changes.
 */
export function isOutputMaterial(prevFingerprint: string, newFingerprint: string): boolean {
  return prevFingerprint !== newFingerprint;
}

// ── Input snapshot helpers ─────────────────────────────────────────────────────

/**
 * Extract the stable discrete fields from a market-monitor result for
 * fingerprinting. Returns defaults if the entry is missing.
 */
export function extractMarketInputs(marketResult: Record<string, unknown> | null): {
  sentiment: string;
  risk: string;
  strongSectors: string[];
  weakSectors: string[];
} {
  if (!marketResult) return { sentiment: "unknown", risk: "unknown", strongSectors: [], weakSectors: [] };
  return {
    sentiment: String(marketResult.marketSentiment ?? "unknown"),
    risk: String(marketResult.riskLevel ?? "unknown"),
    strongSectors: Array.isArray(marketResult.strongSectors)
      ? (marketResult.strongSectors as string[]).map(String).sort()
      : [],
    weakSectors: Array.isArray(marketResult.weakSectors)
      ? (marketResult.weakSectors as string[]).map(String).sort()
      : [],
  };
}

/**
 * Extract stable event keys from an event-monitor result.
 * Returns "title|date" pairs for upcoming events only.
 */
export function extractEventInputs(eventResult: Record<string, unknown> | null): string[] {
  if (!eventResult || !Array.isArray(eventResult.events)) return [];
  return (eventResult.events as Array<Record<string, unknown>>)
    .filter((e) => e.status !== "passed")
    .map((e) => `${String(e.title ?? "")}|${String(e.date ?? "")}`)
    .sort();
}

/**
 * Extract stable fields from a news-monitor result.
 */
export function extractNewsInputs(newsResult: Record<string, unknown> | null): {
  impact: string;
  topStoryTitle: string;
} {
  if (!newsResult) return { impact: "unknown", topStoryTitle: "" };
  const topStory = newsResult.topStory as Record<string, unknown> | undefined;
  return {
    impact: String(newsResult.overallMarketImpact ?? "unknown"),
    topStoryTitle: String(topStory?.title ?? newsResult.executiveSummary ?? ""),
  };
}

/**
 * Build the sorted list of "sector:band" strings from portfolio exposure.
 * Excludes "None" bands to keep the fingerprint stable when tiny positions
 * appear/disappear.
 */
export function buildExposureBandKeys(exposure: SectorPortfolioExposure[]): string[] {
  return exposure
    .filter((e) => e.band !== "None")
    .map((e) => `${e.sector}:${e.band}`)
    .sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA GAPS — explicitly documented per spec §31
// ─────────────────────────────────────────────────────────────────────────────
//
// The following SectorFacts from the spec COULD NOT be implemented because the
// application currently has no sector ETF/index price series:
//
//   ✗ return1D, return5D, return1M       — no sector price history
//   ✗ relativeToMarket1D/5D/1M           — no market-level returns series
//   ✗ trendState (price-derived)         — price-context-calculator has a TODO
//                                          for relative sector metrics
//   ✗ momentumState (price-derived)      — same
//   ✗ rank1D, rank5D, rank1M             — requires returnXD above
//   ✗ changeInRank                       — requires rankXD above
//   ✗ rotation.detected/from/toward      — requires multi-period rank series
//   ✗ dispersion.level                   — requires returns for all sectors
//
// What COULD be added later with Saxo ETF data (e.g. XLK, XLF, XLE equivalents):
//   • fetchAndStorePriceHistory() in price-context-service.ts already handles
//     Saxo OHLC acquisition — a sector ETF UIC map would enable all the above.
//   • price-context-calculator.ts already computes 1D/5D/1M returns — the
//     infrastructure would re-use that without changes.
//
// What IS implemented deterministically today:
//   ✓ portfolioExposurePct per sector
//   ✓ coverage confidence
//   ✓ input fingerprint (from upstream module states + portfolio exposure)
//   ✓ output fingerprint (from AI-produced sector ratings/trends)
//   ✓ skip logic (no AI when input fingerprint unchanged)
// ─────────────────────────────────────────────────────────────────────────────
