/**
 * Risk Analyzer Route
 *
 * Identifies, explains, and prioritizes the risks affecting the current
 * portfolio over the next 1–3 months. Focuses entirely on portfolio-level risk.
 *
 * Before calling OpenAI, calculates a compact portfolio profile (weights,
 * currency exposures, sector exposures, cash %, upcoming events) so the AI
 * can make precise portfolio-level conclusions without having to infer metrics.
 *
 * Results are stored under "risk-analyzer".
 * A compact history (latest 20 analyses) is maintained under "risk-analyzer-history".
 * Invalid results are never stored; the previous stored result is preserved.
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunRiskAnalyzerResponse } from "@workspace/api-zod";
import { callAi, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";
import { companyIdentityStore } from "../lib/company-identity";
import { buildPriceContextBlockCompact } from "../lib/price-context-service.js";
import {
  getPortfolioAnalyzerAiContext,
  getMarketAiContext,
  getNewsAiContext,
  getCompanyAiContext,
} from "../lib/downstream-ai-context.js";

const router: IRouter = Router();

const MODULE_NAME = "Risk Analyzer";
const MAX_ATTEMPTS = 2;
const MAX_HISTORY = 20;

// ---------------------------------------------------------------------------
// History types
// ---------------------------------------------------------------------------

interface RiskHistoryRisk {
  title: string;
  category: string;
  probability: string;
  severity: string;
  normalizedKey: string; // `${title.toLowerCase().trim()}|${category.toLowerCase()}`
}

interface RiskHistoryEntry {
  timestamp: string;
  overallRiskLevel: string;
  riskScore: number;
  risks: RiskHistoryRisk[];
  overallConclusion: string;
}

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
const PROBABILITY_ORDER: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
const HORIZON_ORDER: Record<string, number> = { Immediate: 0, Weeks: 1, Months: 2 };

function sortTopRisks<T extends { severity: string; probability: string; timeHorizon: string }>(
  risks: T[]
): T[] {
  return [...risks].sort((a, b) => {
    const sv = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    if (sv !== 0) return sv;
    const pb = (PROBABILITY_ORDER[a.probability] ?? 9) - (PROBABILITY_ORDER[b.probability] ?? 9);
    if (pb !== 0) return pb;
    return (HORIZON_ORDER[a.timeHorizon] ?? 9) - (HORIZON_ORDER[b.timeHorizon] ?? 9);
  });
}

// ---------------------------------------------------------------------------
// Risk change tracking
// ---------------------------------------------------------------------------

type RiskStatus = "New" | "Increased" | "Reduced" | "Unchanged";

function computeRiskStatus(
  risk: { severity: string; probability: string; normalizedKey?: string },
  previousRisks: RiskHistoryRisk[]
): RiskStatus {
  const key =
    risk.normalizedKey ??
    `${String(risk.severity).toLowerCase()}|${String(risk.probability).toLowerCase()}`;
  const prev = previousRisks.find((p) => p.normalizedKey === key);
  if (!prev) return "New";

  const prevSev = SEVERITY_ORDER[prev.severity] ?? 9;
  const currSev = SEVERITY_ORDER[risk.severity] ?? 9;
  const prevProb = PROBABILITY_ORDER[prev.probability] ?? 9;
  const currProb = PROBABILITY_ORDER[risk.probability] ?? 9;

  const worsened = currSev < prevSev || currProb < prevProb;
  const improved = currSev > prevSev || currProb > prevProb;

  if (worsened) return "Increased";
  if (improved) return "Reduced";
  return "Unchanged";
}

function normalizeRiskKey(title: string, category: string): string {
  return `${title.toLowerCase().trim()}|${category.toLowerCase().trim()}`;
}

// ---------------------------------------------------------------------------
// Portfolio profile calculation
// ---------------------------------------------------------------------------

interface PositionProfile {
  symbol: string;
  name: string;
  marketValueBaseCurrency: number;
  /** % of total portfolio value including cash */
  portfolioWeight: number;
  /** % of total invested position value excluding cash */
  investedCapitalWeight: number;
  currency: string;
  sector?: string;
  upcomingEvent?: string;
}

function buildPortfolioProfile(
  portfolioResult: Record<string, unknown>,
  accounts: Array<Record<string, unknown>>,
  sectorBySymbol: Record<string, string>,
  eventContext: string | null,
  nowIso: string
): string {
  const baseCurrency = String(portfolioResult.baseCurrency ?? "");
  const totalValue =
    typeof portfolioResult.totalValue === "number" ? portfolioResult.totalValue : null;
  const totalAvailableCash =
    typeof portfolioResult.totalAvailableCash === "number"
      ? portfolioResult.totalAvailableCash
      : null;

  // Flatten all positions
  const allPositions: Array<{
    symbol: string;
    name: string;
    marketValueBaseCurrency: number;
    currency: string;
    accountCurrency: string;
  }> = [];

  for (const account of accounts) {
    const acctCurrency = String(account.currency ?? "");
    const posArr = Array.isArray(account.positions)
      ? (account.positions as Array<Record<string, unknown>>)
      : [];
    for (const pos of posArr) {
      const mvbc =
        typeof pos.marketValueBaseCurrency === "number" ? pos.marketValueBaseCurrency : 0;
      allPositions.push({
        symbol: String(pos.symbol ?? "").toUpperCase(),
        name: String(pos.name ?? ""),
        marketValueBaseCurrency: mvbc,
        currency: String(pos.currency ?? ""),
        accountCurrency: acctCurrency,
      });
    }
  }

  const totalInvestedValue = allPositions.reduce((sum, p) => sum + p.marketValueBaseCurrency, 0);
  const baseForWeights = totalValue ?? totalInvestedValue;

  // Currency exposures (% of total portfolio value)
  const currencyExposure: Record<string, number> = {};
  for (const pos of allPositions) {
    const cur = pos.currency || pos.accountCurrency;
    if (!cur) continue;
    currencyExposure[cur] = (currencyExposure[cur] ?? 0) + pos.marketValueBaseCurrency;
  }
  const currencyExposurePct: Record<string, number> = {};
  if (baseForWeights > 0) {
    for (const [cur, val] of Object.entries(currencyExposure)) {
      currencyExposurePct[cur] = Math.round((val / baseForWeights) * 1000) / 10;
    }
  }

  // Sector exposures
  const sectorExposure: Record<string, number> = {};
  for (const pos of allPositions) {
    const sector = sectorBySymbol[pos.symbol] ?? "Unknown";
    sectorExposure[sector] = (sectorExposure[sector] ?? 0) + pos.marketValueBaseCurrency;
  }
  const sectorExposurePct: Record<string, number> = {};
  if (baseForWeights > 0) {
    for (const [sec, val] of Object.entries(sectorExposure)) {
      sectorExposurePct[sec] = Math.round((val / baseForWeights) * 1000) / 10;
    }
  }

  // Upcoming events within 14 days
  const now = new Date(nowIso);
  const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  let upcomingEventCount = 0;
  const upcomingEventsBySymbol: Record<string, string> = {};
  if (eventContext) {
    try {
      const evData = JSON.parse(eventContext) as {
        events?: Array<{ title: string; date: string; importance: string }>;
      };
      for (const ev of evData.events ?? []) {
        if (!ev.date) continue;
        const evDate = new Date(ev.date);
        if (evDate >= now && evDate <= in14Days && ev.importance !== "Low") {
          upcomingEventCount++;
          // Try to match event to a holding symbol
          for (const pos of allPositions) {
            if (
              ev.title.toUpperCase().includes(pos.symbol) ||
              ev.title.toLowerCase().includes(pos.name.toLowerCase())
            ) {
              upcomingEventsBySymbol[pos.symbol] = `${ev.title} — ${ev.date}`;
            }
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  // Build position profiles with both weight bases
  const positionProfiles: PositionProfile[] = allPositions.map((pos) => {
    const portfolioWeight =
      baseForWeights > 0
        ? Math.round((pos.marketValueBaseCurrency / baseForWeights) * 1000) / 10
        : 0;
    const investedCapitalWeight =
      totalInvestedValue > 0
        ? Math.round((pos.marketValueBaseCurrency / totalInvestedValue) * 1000) / 10
        : 0;
    const profile: PositionProfile = {
      symbol: pos.symbol,
      name: pos.name,
      marketValueBaseCurrency: Math.round(pos.marketValueBaseCurrency),
      portfolioWeight,
      investedCapitalWeight,
      currency: pos.currency,
    };
    if (sectorBySymbol[pos.symbol]) profile.sector = sectorBySymbol[pos.symbol];
    if (upcomingEventsBySymbol[pos.symbol]) profile.upcomingEvent = upcomingEventsBySymbol[pos.symbol];
    return profile;
  });

  // Sort positions by portfolio weight desc for easier reading
  positionProfiles.sort((a, b) => b.portfolioWeight - a.portfolioWeight);

  // Portfolio-weight metrics (includes cash denominator)
  const largestPositionWeight = positionProfiles[0]?.portfolioWeight ?? 0;
  const twoLargestCombinedWeight =
    positionProfiles.length >= 2
      ? Math.round((positionProfiles[0].portfolioWeight + positionProfiles[1].portfolioWeight) * 10) / 10
      : largestPositionWeight;

  // Invested-capital-weight metrics (excludes cash — use for concentration analysis)
  const sortedByInvested = [...positionProfiles].sort(
    (a, b) => b.investedCapitalWeight - a.investedCapitalWeight
  );
  const largestInvestedPositionWeight = sortedByInvested[0]?.investedCapitalWeight ?? 0;
  const twoLargestCombinedInvestedWeight =
    sortedByInvested.length >= 2
      ? Math.round(
          (sortedByInvested[0].investedCapitalWeight + sortedByInvested[1].investedCapitalWeight) * 10
        ) / 10
      : largestInvestedPositionWeight;

  const cashPct =
    totalValue && totalValue > 0
      ? Math.round(((totalValue - totalInvestedValue) / totalValue) * 1000) / 10
      : 0;

  // Account summaries (including availableCash per account in account currency)
  const accountSummaries = accounts.map((a) => ({
    currency: a.currency,
    accountValue: a.accountValue,
    availableCash: a.availableCash,
  }));

  return JSON.stringify({
    baseCurrency,
    totalValue: totalValue !== null ? Math.round(totalValue) : null,
    totalInvestedValue: Math.round(totalInvestedValue),
    totalAvailableCash: totalAvailableCash !== null ? Math.round(totalAvailableCash) : null,
    cashPercentage: cashPct,
    numberOfHoldings: allPositions.length,
    largestPositionWeight,
    twoLargestCombinedWeight,
    largestInvestedPositionWeight,
    twoLargestCombinedInvestedWeight,
    upcomingEventsWithin14Days: upcomingEventCount,
    currencyExposures: currencyExposurePct,
    sectorExposures: sectorExposurePct,
    accounts: accountSummaries,
    positions: positionProfiles,
  });
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an experienced institutional portfolio risk manager.

Your task is to identify, explain, and prioritize the risks affecting the current portfolio over the next 1–3 months.

PORTFOLIO-LEVEL FOCUS — CRITICAL:
Analyse how risks affect the portfolio as a whole. Do not simply repeat separate company risks.
Prefer portfolio-level conclusions such as:
- Simultaneous company events increasing short-term portfolio volatility
- Concentration in correlated growth exposures
- Sensitivity to the AI investment cycle
- Interaction between macro shocks and company-specific events
- Currency exposure across accounts and holdings

Company-specific risks may still be included when material, but always explain their effect on total portfolio value.

TOP RISKS RULES:
- Return approximately 5 top risks
- Normally include at least 2 portfolio-level risks (Concentration, Macro, Currency, Diversification, Geopolitical)
- Do not return more than 2 standalone Company risks unless the portfolio genuinely justifies it
- Opportunity cost should normally be treated as a weakness or score driver, not a Top Risk, unless it is unusually material
- Explain every risk in relation to actual position weights provided in the portfolio profile
- Do not describe generic company risks without explaining their portfolio impact
- Identify when risks may reinforce each other (set interactionWithOtherRisks)
- Do not invent event dates. A past event must not be presented as upcoming. If no specific date is known, use an empty string for eventDate
- Set affectedHoldings to the ticker symbols actually affected

INFORMATION PRIORITY:
1. Current portfolio profile with calculated exposure metrics — primary source
2. Company Monitor data for held positions
3. Portfolio Analyzer — existing weaknesses and exposure assessments
4. Event Monitor — upcoming events
5. Sector Monitor
6. Market Monitor
7. News Monitor
8. Opportunity Finder — describes possible future investments only; treat candidates as non-holdings; use only to identify research gaps or risks connected to suggested future opportunities

OBJECTIVE:
Focus entirely on risk. Do not recommend buying or selling.
Use language such as: Monitor, Review, Prepare for, Watch.

CURRENT DATE VALIDATION:
The current UTC date is provided in the user prompt.
Only refer to upcoming events as upcoming if they are in the future.
If an event has already occurred, reference its published result rather than treating it as upcoming.

EVIDENCE-BASED REASONING:
Clearly distinguish facts, reasonable expectations, and analytical judgement.
Avoid generic risk language.
Explain why each risk applies specifically to this portfolio given its actual holdings and exposures.

riskScore is an integer 0–100 representing overall portfolio risk level (0 = minimal risk, 100 = extreme risk).
The risk score describes portfolio risk, not expected investment return.

scoreDrivers must include 5–6 key factors when sufficient information exists.
Include both risk-increasing and risk-reducing factors.
Risk-increasing examples: concentration, clustered company events, speculative holdings, currency exposure, correlated growth sensitivity.
Risk-reducing examples: cash buffer, high-quality holdings, exposure across currencies, limited leverage.
impact "Positive" means the factor REDUCES risk; "Negative" means it INCREASES risk.

riskProfile: return only categories that are relevant, but normally include Concentration, Company, Macro, Currency, Liquidity, Diversification.

riskInteractions: return 1–3 meaningful interactions where two or more risks reinforce each other. Do not create interactions merely to fill the array. If no meaningful interactions exist, return an empty array.

Return JSON only — no markdown, no code fences, no extra text.
Do not include the timestamp or analysisDuration fields — the server sets those.

Return exactly:
{"executiveSummary":"...","overallRiskLevel":"Low|Moderate|High","mainConclusion":{"title":"...","reason":"..."},"riskScore":0,"scoreDrivers":[{"factor":"...","impact":"Positive|Negative|Neutral","reason":"..."}],"riskProfile":[{"category":"Concentration|Company|Sector|Macro|Currency|Liquidity|Event|Geopolitical|Diversification","score":0,"level":"Low|Moderate|High","reason":"..."}],"topRisks":[{"title":"...","category":"Concentration|Company|Sector|Macro|Currency|Liquidity|Event|Geopolitical|Diversification","probability":"Low|Medium|High","severity":"Low|Medium|High","timeHorizon":"Immediate|Weeks|Months","eventDate":"YYYY-MM-DD or empty string","affectedHoldings":["..."],"reason":"...","portfolioImpact":"...","interactionWithOtherRisks":"...","monitor":"..."}],"riskInteractions":[{"title":"...","reason":"...","affectedHoldings":["..."],"severity":"Low|Medium|High"}],"portfolioWeaknesses":["..."],"portfolioStrengths":["..."],"watchClosely":["..."]}`;

function buildUserPrompt(
  nowIso: string,
  portfolioProfile: string,
  portfolioAnalyzerContext: string | null,
  marketContext: string | null,
  eventContext: string | null,
  newsContext: string | null,
  sectorContext: string | null,
  companyContexts: Record<string, string>,
  priceContexts: Record<string, string>
): string {
  // §5: Opportunity Finder removed — RA assesses current portfolio risk,
  // not potential future candidates. Opportunity context is irrelevant to
  // risk analysis unless an OF candidate has become a live trade decision.
  const blocks: string[] = [
    `Current UTC: ${nowIso}`,
    "",
    "Assess the risks facing this portfolio over the next 1–3 months.",
    "",
    "Portfolio Profile (pre-calculated — use these exact figures in your analysis):",
    portfolioProfile,
  ];

  if (portfolioAnalyzerContext) {
    blocks.push(
      "",
      "Portfolio Analyzer conclusions (existing weaknesses and exposures — use as starting context):",
      portfolioAnalyzerContext
    );
  }

  for (const [ticker, ctx] of Object.entries(companyContexts)) {
    blocks.push(
      "",
      `Company Monitor for held position ${ticker}:`,
      ctx
    );
  }

  // §7: Compact price context — prose rules are in the system prompt.
  const priceCtxEntries = Object.entries(priceContexts);
  if (priceCtxEntries.length > 0) {
    blocks.push(
      "",
      "PRICE CONTEXT for held positions (compact — actual Saxo data, NOT a forecast; semantic rules in system prompt):"
    );
    for (const [sym, pc] of priceCtxEntries) {
      blocks.push(`${sym}: ${pc}`);
    }
  }

  if (eventContext) {
    blocks.push(
      "",
      "Event Monitor (upcoming events — do not repeat verbatim):",
      eventContext
    );
  }

  if (sectorContext) {
    blocks.push(
      "",
      "Sector Monitor (sector conditions — do not repeat verbatim):",
      sectorContext
    );
  }

  if (marketContext) {
    blocks.push(
      "",
      "Market Monitor (macro conditions — do not repeat verbatim):",
      marketContext
    );
  }

  if (newsContext) {
    blocks.push(
      "",
      "News Monitor (recent news — do not repeat verbatim):",
      newsContext
    );
  }

  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/risk-analyzer/analyze", async (req, res): Promise<void> => {
  const orchestratorTrigger = req.headers['x-orchestrator-trigger'];
  if (orchestratorTrigger) {
    systemLog.logInfo(MODULE_NAME, `Scheduled run (trigger: ${orchestratorTrigger})`);
  } else {
    systemLog.logUser(MODULE_NAME, "User manually started risk analysis");
  }

  const startTime = Date.now();
  const nowIso = new Date().toISOString();
  const nowDate = new Date(nowIso);
  let lastDebug: AiDebugInfo | undefined;

  // ── Portfolio Manager ─────────────────────────────────────────────────────

  const portfolioEntry = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
  if (!portfolioEntry) {
    res.status(400).json({
      error: "No portfolio data available. Please run Portfolio Manager first.",
    });
    return;
  }

  const portfolioResult = portfolioEntry.result as Record<string, unknown>;

  if (portfolioResult.isMockData) {
    systemLog.logWarning(MODULE_NAME, "Risk analysis performed using mock portfolio data");
  }

  const accounts = Array.isArray(portfolioResult.accounts)
    ? (portfolioResult.accounts as Array<Record<string, unknown>>)
    : [];

  // ── Collect optional module contexts ─────────────────────────────────────

  // §1: Use compact downstream context layer for PA and Market contexts.
  const paCtx = getPortfolioAnalyzerAiContext();
  const portfolioAnalyzerContext = paCtx ? JSON.stringify(paCtx) : null;

  // §5: Opportunity Finder removed from RA — RA assesses current portfolio risk,
  // not potential future candidates.

  const marketCtx = getMarketAiContext();
  const marketContext = marketCtx ? JSON.stringify(marketCtx) : null;

  // NOTE: eventContext must remain verbose because buildPortfolioProfile (below)
  // parses events[].title and events[].date to count upcoming events and annotate
  // position profiles.  Only the minimal fields it needs are kept.
  const eventEntry = analysisRepository.get<Record<string, unknown>>("event-monitor");
  const eventContext = eventEntry
    ? JSON.stringify({
        events: Array.isArray(eventEntry.result.events)
          ? (eventEntry.result.events as Array<Record<string, unknown>>).map((e) => ({
              title: e.title,
              date: e.date,
              importance: e.importance,
              expectedImpact: e.expectedImpact,
            }))
          : [],
      })
    : null;

  // Filter news to holdings, using the compact getter.
  const holdingSymbols = accounts.flatMap((a) =>
    Array.isArray(a.positions)
      ? (a.positions as Array<Record<string, unknown>>).map(p => String(p.symbol ?? "").toUpperCase()).filter(Boolean)
      : []
  );
  const newsCtx = getNewsAiContext(holdingSymbols);
  const newsContext = newsCtx ? JSON.stringify(newsCtx) : null;

  // §4 (RA): Sector context not sent — covered by PA and Market Monitor already.
  const sectorContext: string | null = null;

  if (!portfolioAnalyzerContext) {
    systemLog.logWarning(MODULE_NAME, "Portfolio Analyzer data unavailable — analysis context is limited");
  }

  // ── Company Monitor for held positions ─────────────────────────────────────

  const allRepoEntries = analysisRepository.getAll();
  const companyMonitorCandidates = allRepoEntries
    .filter((e) => e.moduleName.startsWith("company-monitor:"))
    .map((e) => ({ key: e.moduleName, result: e.result as Record<string, unknown> }));

  const companyContexts: Record<string, string> = {};
  const sectorBySymbol: Record<string, string> = {};
  let hasMissingCompanyData = false;

  for (const account of accounts) {
    const posArr = Array.isArray(account.positions)
      ? (account.positions as Array<Record<string, unknown>>)
      : [];
    for (const pos of posArr) {
      const symbol = String(pos.symbol ?? pos.ticker ?? "").trim().toUpperCase();
      if (!symbol || symbol in companyContexts) continue;
      const resolved = companyIdentityStore.resolve(
        symbol,
        { companyName: String(pos.name ?? "") },
        companyMonitorCandidates
      );
      if (resolved) {
        const entry = analysisRepository.get<Record<string, unknown>>(resolved.key);
        if (entry) {
          const r = entry.result as Record<string, unknown>;
          // Extract sector for portfolio profile
          const companyInfo = r.company as Record<string, unknown> | undefined;
          if (companyInfo?.sector) {
            sectorBySymbol[symbol] = String(companyInfo.sector);
          }
          // §1: Compact downstream context getter for the AI prompt
          const ctxCompact = getCompanyAiContext(resolved.key, symbol);
          companyContexts[symbol] = ctxCompact
            ? JSON.stringify(ctxCompact)
            : JSON.stringify({ symbol, investmentView: r.investmentView });
        } else {
          hasMissingCompanyData = true;
        }
      } else {
        hasMissingCompanyData = true;
      }
    }
  }

  if (hasMissingCompanyData) {
    systemLog.logWarning(MODULE_NAME, "Company Monitor data missing for one or more holdings");
  }

  // ── Calculate portfolio profile ───────────────────────────────────────────

  const portfolioProfile = buildPortfolioProfile(
    portfolioResult,
    accounts,
    sectorBySymbol,
    eventContext,
    nowIso
  );

  // ── Load previous history for change tracking ─────────────────────────────

  const historyEntry = analysisRepository.get<{ entries: RiskHistoryEntry[] }>(
    "risk-analyzer-history"
  );
  const previousEntry = historyEntry?.result?.entries?.[0] ?? null;
  const previousRisks: RiskHistoryRisk[] = previousEntry?.risks ?? [];

  // ── AI call with retry ────────────────────────────────────────────────────

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: unknown;
    let debug: AiDebugInfo;

    try {
      ({ result, debug } = await callAi<unknown>(
        SYSTEM_PROMPT,
        buildUserPrompt(
          nowIso,
          portfolioProfile,
          portfolioAnalyzerContext,
          marketContext,
          eventContext,
          newsContext,
          sectorContext,
          companyContexts,
          buildPriceContextBlockCompact(
            accounts.flatMap(a =>
              Array.isArray(a.positions)
                ? (a.positions as Array<Record<string, unknown>>).map(p => String(p.symbol ?? "").toUpperCase()).filter(Boolean)
                : []
            )
          )
        ),
        { model: "gpt-4o", maxTokens: 3000, temperature: 0.1, module: "risk-analyzer", operation: "analyze", retryNumber: attempt }
      ));
    } catch (err) {
      const isLastAttempt = attempt >= MAX_ATTEMPTS;
      req.log[isLastAttempt ? "error" : "warn"](
        { err, attempt },
        isLastAttempt ? "AI service call failed after all attempts" : "AI service call failed — retrying"
      );
      if (isLastAttempt) {
        systemLog.logError(MODULE_NAME, "Risk analysis failed");
        res.status(500).json({
          error: err instanceof Error ? err.message : "AI service call failed",
          _debug: extractAiErrorDebug(err),
        });
        return;
      }
      continue;
    }

    lastDebug = debug;

    const analysisDuration = Date.now() - startTime;

    // ── eventDate validation — clear past dates ────────────────────────────
    const rawResult = result as Record<string, unknown>;
    if (Array.isArray(rawResult.topRisks)) {
      rawResult.topRisks = (rawResult.topRisks as Array<Record<string, unknown>>).map((risk) => {
        const dateStr = String(risk.eventDate ?? "").trim();
        if (dateStr) {
          const evDate = new Date(dateStr);
          if (!isNaN(evDate.getTime()) && evDate < nowDate) {
            risk.eventDate = "";
          }
        }
        return risk;
      });
    }

    const parsed = RunRiskAnalyzerResponse.safeParse({
      ...(rawResult as Record<string, unknown>),
      timestamp: nowIso,
      analysisDuration,
    });

    if (parsed.success) {
      // ── Sort top risks deterministically ──────────────────────────────────
      const sortedRisks = sortTopRisks(parsed.data.topRisks);

      // ── Compute status per risk ───────────────────────────────────────────
      const risksWithStatus = sortedRisks.map((risk) => {
        const nk = normalizeRiskKey(risk.title, risk.category);
        const status = computeRiskStatus(
          { severity: risk.severity, probability: risk.probability, normalizedKey: nk },
          previousRisks
        );
        return { ...risk, status };
      });

      // ── Identify resolved risks for logging ───────────────────────────────
      const currentKeys = new Set(
        risksWithStatus.map((r) => normalizeRiskKey(r.title, r.category))
      );
      const resolvedRisks = previousRisks.filter((p) => !currentKeys.has(p.normalizedKey));

      // Build resolved risk list for UI display
      const resolvedRisksForUi = resolvedRisks.map((p) => ({
        title: p.title,
        category: p.category,
        severity: p.severity,
        probability: p.probability,
      }));

      const finalData = {
        ...parsed.data,
        topRisks: risksWithStatus,
        previousRiskScore: previousEntry?.riskScore,
        resolvedRisks: resolvedRisksForUi,
      };

      // ── Store result ──────────────────────────────────────────────────────
      analysisRepository.save("risk-analyzer", finalData);

      // ── Update history ────────────────────────────────────────────────────
      const existingEntries = historyEntry?.result?.entries ?? [];
      const newHistoryEntry: RiskHistoryEntry = {
        timestamp: nowIso,
        overallRiskLevel: finalData.overallRiskLevel,
        riskScore: finalData.riskScore,
        risks: risksWithStatus.map((r) => ({
          title: r.title,
          category: r.category,
          probability: r.probability,
          severity: r.severity,
          normalizedKey: normalizeRiskKey(r.title, r.category),
        })),
        overallConclusion: finalData.mainConclusion.title,
      };
      const updatedHistory = [newHistoryEntry, ...existingEntries].slice(0, MAX_HISTORY);
      analysisRepository.save("risk-analyzer-history", { entries: updatedHistory });

      // ── System log ────────────────────────────────────────────────────────
      systemLog.logInfo(MODULE_NAME, "Risk analysis completed");

      if (previousEntry) {
        const delta = finalData.riskScore - previousEntry.riskScore;
        if (delta !== 0) {
          const direction = delta > 0 ? "▲" : "▼";
          systemLog.logInternal(
            MODULE_NAME,
            `Risk score: ${finalData.riskScore} ${direction} ${Math.abs(delta)} (was ${previousEntry.riskScore})`
          );
        } else {
          systemLog.logInternal(MODULE_NAME, `Risk score unchanged: ${finalData.riskScore}`);
        }
      } else {
        systemLog.logInternal(MODULE_NAME, `Risk score: ${finalData.riskScore}`);
      }

      // Log highest risk
      const topRisk = risksWithStatus[0];
      if (topRisk) {
        systemLog.logInternal(
          MODULE_NAME,
          `Highest portfolio risk: ${topRisk.title} [${topRisk.category}, ${topRisk.severity} severity]`
        );
      }

      // Log new, increased, or resolved risks
      for (const risk of risksWithStatus) {
        if (risk.status === "New") {
          systemLog.logInternal(MODULE_NAME, `New risk detected: ${risk.title}`);
        } else if (risk.status === "Increased") {
          systemLog.logInternal(MODULE_NAME, `Risk increased: ${risk.title}`);
        }
      }
      for (const resolved of resolvedRisks) {
        systemLog.logInternal(MODULE_NAME, `Risk resolved: ${resolved.title}`);
      }

      res.json({ ...finalData, _debug: debug });
      return;
    }

    if (attempt < MAX_ATTEMPTS) {
      req.log.warn(
        { errors: parsed.error.message, attempt },
        "Invalid AI response schema — retrying once"
      );
    } else {
      req.log.error(
        { errors: parsed.error.message },
        "Invalid AI response schema after retry"
      );
      systemLog.logError(MODULE_NAME, "Risk analysis failed — invalid response structure");
      res.status(500).json({
        error: "AI returned an invalid response structure. Please try again.",
        _debug: lastDebug,
      });
    }
  }
});

export default router;
