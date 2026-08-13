/**
 * Risk Analyzer Route
 *
 * Identifies, explains, and prioritizes the risks affecting the current
 * portfolio over the next 1–3 months. Focuses entirely on portfolio-level risk.
 *
 * HYBRID ARCHITECTURE:
 * All deterministic quantitative facts (weights, concentrations, sector/currency
 * exposures, price-risk exposure %, event exposure %, company risk signals) are
 * pre-calculated by the Risk Intelligence Engine. OpenAI receives compact
 * Risk Facts and is responsible only for qualitative interpretation.
 *
 * SKIP LOGIC:
 * A material fingerprint of RiskFacts is compared to the stored result on every
 * run. If unchanged, the previous qualitative assessment is reused — zero AI tokens.
 *
 * Results are stored under "risk-analyzer".
 * A compact history (latest 20 analyses) is maintained under "risk-analyzer-history".
 * Invalid results are never stored; the previous stored result is preserved.
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunRiskAnalyzerResponse } from "@workspace/api-zod";
import { callAi, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { getModel } from "../lib/ai-model-config.js";
import { normalizeAiResponse, classifyRetryReason } from "../lib/ai-response-normalizer.js";
import { analysisRepository } from "../lib/analysis-repository";
import { companyIdentityStore } from "../lib/company-identity";
import { buildPriceContextBlockCompact } from "../lib/price-context-service.js";
import {
  getPortfolioAnalyzerAiContext,
  getMarketAiContext,
  getNewsAiContext,
  getCompanyAiContext,
  getRiskAnalyzerAiContext,
} from "../lib/downstream-ai-context.js";
import { computeRiskFacts, type RiskFacts } from "../lib/risk-intelligence-engine.js";
import { trackSkipped } from "../lib/openai-usage-service.js";

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
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an experienced institutional portfolio risk manager.

Your task is to identify, explain, and prioritize the risks affecting the current portfolio over the next 1–3 months.

RISK FACTS — USE AS GROUND TRUTH:
All quantitative portfolio metrics have been pre-calculated by the backend and provided as Risk Facts:
position weights, cash percentage, sector and currency exposures, concentration figures,
price-volatility exposure percentages, event exposure percentages, and company risk signals.
Use these facts as ground truth. Do NOT recalculate or re-derive these metrics from raw data.
Your role is to interpret what these facts mean for portfolio risk — not to perform numerical analysis.

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
- Explain every risk in relation to the actual position weights provided in Risk Facts
- Do not describe generic company risks without explaining their portfolio impact
- Identify when risks may reinforce each other (set interactionWithOtherRisks)
- Do not invent event dates. A past event must not be presented as upcoming. If no specific date is known, use an empty string for eventDate
- Set affectedHoldings to the ticker symbols actually affected

INFORMATION PRIORITY:
1. Risk Facts (pre-calculated portfolio metrics) — primary quantitative source
2. Company Monitor data for held positions — qualitative company context
3. Portfolio Analyzer — existing weaknesses and exposure assessments
4. Event Monitor — upcoming events (already quantified in Risk Facts; Company Monitor is more detailed for specific events)
5. Market Monitor
6. News Monitor

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

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/** Strip internal / debug fields before sending RiskFacts to the AI. */
function slimRiskFacts(facts: RiskFacts) {
  return {
    baseCurrency: facts.baseCurrency,
    portfolioValue: facts.portfolioValue,
    cashPct: facts.cashPct,
    numberOfHoldings: facts.numberOfHoldings,
    concentration: {
      topPositions: facts.concentration.topPositions.map((p) => ({
        ticker: p.ticker,
        investedWeightPct: p.investedWeightPct,
        portfolioWeightPct: p.portfolioWeightPct,
        sector: p.sector,
      })),
      largestPositionTicker: facts.concentration.largestPositionTicker,
      largestPositionPct: facts.concentration.largestPositionPct,
      top3Pct: facts.concentration.top3Pct,
      top5Pct: facts.concentration.top5Pct,
      positionsAbove20Pct: facts.concentration.positionsAbove20Pct,
      positionsAbove30Pct: facts.concentration.positionsAbove30Pct,
    },
    sectors: facts.sectors,
    currencies: facts.currencies,
    priceRisk: {
      highVolatilityPct: facts.priceRisk.highVolatilityPct,
      highVolatilityHoldings: facts.priceRisk.highVolatilityHoldings,
      strongDowntrendPct: facts.priceRisk.strongDowntrendPct,
      strongDowntrendHoldings: facts.priceRisk.strongDowntrendHoldings,
      strongUptrendPct: facts.priceRisk.strongUptrendPct,
      strongUptrendHoldings: facts.priceRisk.strongUptrendHoldings,
      fallingFastHoldings: facts.priceRisk.fallingFastHoldings,
      risingHoldings: facts.priceRisk.risingHoldings,
      stabilizingFromDowntrendHoldings: facts.priceRisk.stabilizingFromDowntrendHoldings,
    },
    eventRisk: facts.eventRisk,
    companyRisk: facts.companyRisk,
    portfolioRiskFlags: facts.portfolioRiskFlags,
  };
}

function buildUserPrompt(
  nowIso: string,
  riskFacts: RiskFacts,
  portfolioAnalyzerContext: string | null,
  companyContexts: Record<string, string>,
  priceContexts: Record<string, string>,
  marketContext: string | null,
  newsContext: string | null,
  previousRiskContext: string | null
): string {
  const blocks: string[] = [
    `Current UTC: ${nowIso}`,
    "",
    "Interpret the risks facing this portfolio over the next 1–3 months.",
    "Risk Facts are pre-calculated — use them as ground truth for all quantitative assertions.",
    "",
    "RISK FACTS (calculated deterministically by backend):",
    JSON.stringify(slimRiskFacts(riskFacts)),
  ];

  if (portfolioAnalyzerContext) {
    blocks.push(
      "",
      "Portfolio Analyzer assessment (existing weaknesses and exposures — use as starting context):",
      portfolioAnalyzerContext
    );
  }

  for (const [ticker, ctx] of Object.entries(companyContexts)) {
    blocks.push(
      "",
      `Company Monitor for held position ${ticker} (qualitative context — thesis, risks, catalysts):`,
      ctx
    );
  }

  // Compact price context — one JSON line per symbol; for qualitative reasoning about position behavior.
  const priceCtxEntries = Object.entries(priceContexts);
  if (priceCtxEntries.length > 0) {
    blocks.push(
      "",
      "Price Context per held position (compact Saxo data — state, recent behavior, returns, volatility):"
    );
    for (const [sym, pc] of priceCtxEntries) {
      blocks.push(`${sym}: ${pc}`);
    }
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
      "News Monitor (material news for held positions — do not repeat verbatim):",
      newsContext
    );
  }

  if (previousRiskContext) {
    blocks.push(
      "",
      "Previous risk assessment (compact — for continuity and change detection):",
      previousRiskContext
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

  // ── Risk Intelligence Engine ──────────────────────────────────────────────
  // Compute all deterministic facts. This replaces the previous buildPortfolioProfile
  // and raw eventContext processing.

  const { riskFacts, fingerprint } = computeRiskFacts(nowIso);

  // ── Skip check ────────────────────────────────────────────────────────────
  // If RiskFacts fingerprint is unchanged since the last successful AI call,
  // reuse the previous qualitative assessment without calling OpenAI.

  const storedEntry = analysisRepository.get<Record<string, unknown>>("risk-analyzer");
  const storedFingerprint =
    typeof storedEntry?.result?._riskFactsFingerprint === "string"
      ? (storedEntry.result._riskFactsFingerprint as string)
      : null;

  if (storedFingerprint && storedFingerprint === fingerprint && storedEntry?.result) {
    systemLog.logInternal(
      MODULE_NAME,
      `Skipping AI call — RiskFacts fingerprint unchanged (${fingerprint})`
    );
    analysisRepository.saveSkipped("risk-analyzer");
    trackSkipped("risk-analyzer", "fingerprint_unchanged");

    res.json({
      ...storedEntry.result,
      _aiCalled: false,
      _debug: {
        aiCalled: false,
        skipReason: "riskFacts_unchanged",
        fingerprint,
        previousFingerprint: storedFingerprint,
        riskFacts,
      },
    });
    return;
  }

  // ── Collect optional module contexts ─────────────────────────────────────

  const paCtx = getPortfolioAnalyzerAiContext();
  const portfolioAnalyzerContext = paCtx ? JSON.stringify(paCtx) : null;

  const marketCtx = getMarketAiContext();
  const marketContext = marketCtx ? JSON.stringify(marketCtx) : null;

  // Filter news to holdings only.
  const holdingSymbols = accounts.flatMap((a) =>
    Array.isArray(a.positions)
      ? (a.positions as Array<Record<string, unknown>>)
          .map((p) => String(p.symbol ?? "").toUpperCase())
          .filter(Boolean)
      : []
  );
  const newsCtx = getNewsAiContext(holdingSymbols);
  const newsContext = newsCtx ? JSON.stringify(newsCtx) : null;

  // Compact previous risk state for continuity (not sending full previous result).
  const prevRiskCtx = getRiskAnalyzerAiContext();
  const previousRiskContext = prevRiskCtx ? JSON.stringify(prevRiskCtx) : null;

  if (!portfolioAnalyzerContext) {
    systemLog.logWarning(MODULE_NAME, "Portfolio Analyzer data unavailable — analysis context is limited");
  }

  // ── Company Monitor for held positions ─────────────────────────────────────
  // Build compact qualitative company contexts for the AI prompt.
  // (Risk signals are already captured in RiskFacts; this is for qualitative reasoning.)

  const allRepoEntries = analysisRepository.getAll();
  const companyMonitorCandidates = allRepoEntries
    .filter((e) => e.moduleName.startsWith("company-monitor:"))
    .map((e) => ({ key: e.moduleName, result: e.result as Record<string, unknown> }));

  const companyContexts: Record<string, string> = {};
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
        const ctxCompact = getCompanyAiContext(resolved.key, symbol);
        companyContexts[symbol] = ctxCompact
          ? JSON.stringify(ctxCompact)
          : JSON.stringify({ symbol });
      } else {
        hasMissingCompanyData = true;
      }
    }
  }

  if (hasMissingCompanyData) {
    systemLog.logWarning(MODULE_NAME, "Company Monitor data missing for one or more holdings");
  }

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
          riskFacts,
          portfolioAnalyzerContext,
          companyContexts,
          buildPriceContextBlockCompact(holdingSymbols),
          marketContext,
          newsContext,
          previousRiskContext
        ),
        {
          model: getModel("analysis", "risk-analyzer"),
          maxTokens: 3000,
          temperature: 0.1,
          module: "risk-analyzer",
          operation: "analyze",
          retryNumber: attempt,
        }
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

    const assembled = { ...(rawResult as Record<string, unknown>), timestamp: nowIso, analysisDuration };
    const { normalized: normAssembled, changes: normChanges } = normalizeAiResponse(assembled, RunRiskAnalyzerResponse);
    if (normChanges.length > 0) req.log.info({ changes: normChanges, attempt }, "Risk Analyzer: normalizer repaired formatting — no retry needed");
    const parsed = RunRiskAnalyzerResponse.safeParse(normAssembled);

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
        // Store the RiskFacts fingerprint so the next run can detect unchanged state.
        _riskFactsFingerprint: fingerprint,
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

      const topRisk = risksWithStatus[0];
      if (topRisk) {
        systemLog.logInternal(
          MODULE_NAME,
          `Highest portfolio risk: ${topRisk.title} [${topRisk.category}, ${topRisk.severity} severity]`
        );
      }

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

      systemLog.logInternal(
        MODULE_NAME,
        `RiskFacts fingerprint: ${fingerprint} (AI called; previous was ${storedFingerprint ?? "none"})`
      );

      res.json({
        ...finalData,
        _debug: {
          ...debug,
          aiCalled: true,
          fingerprint,
          previousFingerprint: storedFingerprint,
          riskFacts,
        },
      });
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
