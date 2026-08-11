/**
 * Opportunity Finder Route
 *
 * Identifies the best investment opportunities for a 1–3 month horizon that
 * complement the user's existing portfolio. Uses the OpenAI Responses API
 * with live web search.
 *
 * Reads context from: Portfolio Manager, Portfolio Analyzer, Market Monitor,
 * Event Monitor, News Monitor, Sector Monitor, and Company Monitor analyses
 * for currently-held positions (resolved via companyIdentityStore).
 *
 * Results are stored under "opportunity-finder".
 * A compact history (latest 20 analyses) is maintained under "opportunity-finder-history".
 * Invalid results are never stored.
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunOpportunityFinderResponse } from "@workspace/api-zod";
import { callAiWithWebSearch, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";
import { companyIdentityStore } from "../lib/company-identity";
import { getAllPriceContexts } from "../lib/price-context-service.js";

const router: IRouter = Router();

const MODULE_NAME = "Opportunity Finder";
const MAX_ATTEMPTS = 2;
const MAX_HISTORY = 20;

// ---------------------------------------------------------------------------
// History types
// ---------------------------------------------------------------------------

interface HistoryCandidate {
  ticker: string;
  company: string;
  rank: number;
  overallScore: number;
  priority: string;
  confidence: string;
}

interface HistoryEntry {
  timestamp: string;
  overallOpportunityLevel: string;
  candidates: HistoryCandidate[];
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an experienced institutional portfolio manager.

Your task is to identify the most attractive investment opportunities for the next 1–3 months that complement and strengthen the existing portfolio.

WEB SEARCH REQUIREMENT:
You must perform a web search before producing your analysis. Search for:
- Recent earnings announcements, guidance and upcoming earnings dates for candidate companies
- Upcoming catalysts and events over the next 1–3 months
- Current sector momentum and capital flows
- Specific investment opportunities that address the portfolio's gaps

OBJECTIVE:
Use the existing portfolio as your baseline. Do not simply list companies from currently strong sectors.
Evaluate each candidate for: portfolio fit, diversification benefit, sector and macro fit, timing and catalysts, risk/reward, and evidence quality.
Avoid recommending companies already held in the portfolio unless there is a compelling reason.

INFORMATION PRIORITY:
1. Current portfolio positions, position sizes, and cash — the baseline to improve upon
2. Portfolio Analyzer conclusions — identified gaps, weaknesses, and opportunities
3. Sector Monitor
4. Event Monitor
5. Market Monitor
6. News Monitor
7. Web search results (verify and supplement — not replace — the stored analyses)

COMPANY MONITOR CONTEXT:
Company Monitor analyses are available only for current portfolio holdings and previously analysed companies already stored in the system.
They are NOT available for candidate companies you are about to suggest.
Use Company Monitor data only for existing-holdings context, not for evaluating new candidates.
After this analysis, the user can separately trigger a Company Monitor analysis for any candidate of interest.

CURRENT DATE VALIDATION (critical):
The current UTC date is provided in the user prompt.
- Never describe a past date as an upcoming catalyst.
- Compare every event date, earnings date, and corporate event with the supplied current UTC date.
- If an event has already occurred, reference its published result rather than calling it upcoming.
- If a catalyst date cannot be verified from a reliable source, return an empty string for catalystDate.
- Do not invent earnings dates, dividend dates, guidance, or corporate events.
- Prefer official company investor-relations pages, exchange announcements, and reputable financial sources.
- Verify ticker symbol, company name, and primary exchange before returning a candidate.

SOURCE EVIDENCE (required for every candidate):
Every candidate must include 1–3 sources actually retrieved through web search.
At least one source must directly support the main catalyst.
Do not return a candidate without usable source evidence verified through the web search.
For each source: include title, URL, and publication date if available.

SCORING AND RANKING:
Score each candidate on five dimensions (each 1–5, where 5 is best):
- portfolioFit: how well this fills a specific gap or weakness in the current portfolio
- diversificationBenefit: sector, geographic or factor diversification added relative to existing holdings
- sectorMacroFit: alignment of this sector and company with current macro and sector conditions
- timing: proximity and quality of upcoming catalyst within the next 1–3 months
- riskReward: expected return relative to downside risk given current verified information

Compute overallScore as an integer 0–100 (your holistic assessment weighted across all five dimensions).
Order candidates by overallScore from highest to lowest.
Assign rank starting at 1 for the highest score.

FIELD DEFINITIONS:
- confidence: quality and reliability of the evidence supporting this opportunity (High = multiple verified sources, Low = limited or indirect evidence)
- priority: how urgently this candidate deserves further research given timing and risk (High = imminent catalyst or closing window)
- positionSizeSuitability: indication of appropriate allocation size for this type of opportunity relative to a diversified portfolio (Small/Medium/Large) — this is an indication only, NOT a buy instruction or exact recommendation
- companyAnalysisAvailable: always return false — the server will override this field with the correct value

EVIDENCE-BASED REASONING:
Explain why each opportunity fits this specific portfolio.
Clearly distinguish confirmed facts, reasonable expectations, and analytical judgement.
Avoid generic investment language.
Each investmentThesis item, whyNow item, and whyThisPortfolio item must be a concise, specific statement — not a generic claim.

Return JSON only — no markdown, no code fences, no extra text.

OUTPUT RULES:
- Return approximately 5 candidates ordered by overallScore highest first
- catalystDate must be a future date (after current UTC) or empty string — never a past date
- Do not include the timestamp or analysisDuration fields — the server sets those

Return exactly:
{"executiveSummary":"...","overallOpportunityLevel":"High|Medium|Low","topOpportunities":[{"rank":1,"company":"...","ticker":"...","exchange":"...","sector":"...","country":"...","overallScore":82,"portfolioFit":4,"diversificationBenefit":3,"sectorMacroFit":4,"timing":4,"riskReward":4,"scoreReason":"...","investmentThesis":["...","..."],"whyNow":["..."],"whyThisPortfolio":["...","..."],"mainCatalyst":"...","catalystDate":"YYYY-MM-DD or empty string","mainRisk":"...","confidence":"High|Medium|Low","priority":"High|Medium|Low","positionSizeSuitability":"Small|Medium|Large","positionSizeReason":"...","companyAnalysisAvailable":false,"sources":[{"title":"...","url":"...","published":"YYYY-MM-DD or empty string"}]}],"sectorIdeas":[{"sector":"...","reason":"..."}],"thingsToResearch":["..."]}`;

function buildUserPrompt(
  nowIso: string,
  portfolioContext: string,
  portfolioAnalyzerContext: string | null,
  marketContext: string | null,
  eventContext: string | null,
  newsContext: string | null,
  sectorContext: string | null,
  companyContexts: Record<string, string>,
  priceContexts: Record<string, string>
): string {
  const blocks: string[] = [
    `Current UTC: ${nowIso}`,
    "",
    "Identify investment opportunities that complement and strengthen this portfolio.",
    "",
    "Current Portfolio (your baseline — find opportunities that improve this):",
    portfolioContext,
  ];

  if (portfolioAnalyzerContext) {
    blocks.push(
      "",
      "Portfolio Analyzer conclusions (existing gaps, weaknesses and opportunities — use as your starting point for what is missing):",
      portfolioAnalyzerContext
    );
  }

  if (sectorContext) {
    blocks.push(
      "",
      "Sector Monitor context (sector ratings and flows — do not repeat this verbatim):",
      sectorContext
    );
  }

  if (eventContext) {
    blocks.push(
      "",
      "Event Monitor context (upcoming market events — do not repeat this verbatim):",
      eventContext
    );
  }

  if (marketContext) {
    blocks.push(
      "",
      "Market Monitor context (macro conditions — do not repeat this verbatim):",
      marketContext
    );
  }

  if (newsContext) {
    blocks.push(
      "",
      "News Monitor context (recent market-moving news — do not repeat this verbatim):",
      newsContext
    );
  }

  for (const [ticker, ctx] of Object.entries(companyContexts)) {
    blocks.push(
      "",
      `Company Monitor context for held position ${ticker} (existing holding context only — do not repeat this verbatim):`,
      ctx
    );
  }

  const priceCtxEntries = Object.entries(priceContexts);
  if (priceCtxEntries.length > 0) {
    blocks.push(
      "",
      "PRICE CONTEXT for held positions (deterministic backend data — actual price behavior computed from Saxo historical data, NOT a forecast):",
      "Rules: Use alongside fundamentals. Never infer valuation from price movement alone. 'StabilizingAfterDecline' does NOT confirm a bottom. 'PossibleRecovery' does NOT confirm a durable reversal. 'ExtendedAfterRally' does NOT mean sell. recentBehavior describes only the last 2–3 sessions: Stabilizing/Recovering do NOT confirm a bottom or BUY signal."
    );
    for (const [sym, pc] of priceCtxEntries) {
      blocks.push(`[${sym}]`, pc);
    }
  }

  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/opportunity-finder/analyze", async (req, res): Promise<void> => {
  const orchestratorTrigger = req.headers['x-orchestrator-trigger'];
  if (orchestratorTrigger) {
    systemLog.logInfo(MODULE_NAME, `Scheduled run (trigger: ${orchestratorTrigger})`);
  } else {
    systemLog.logUser(MODULE_NAME, "User manually started opportunity analysis");
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
    systemLog.logWarning(MODULE_NAME, "Opportunity analysis performed using mock portfolio data");
  }

  const accounts = Array.isArray(portfolioResult.accounts)
    ? (portfolioResult.accounts as Array<Record<string, unknown>>)
    : [];

  const portfolioSummary = {
    baseCurrency: portfolioResult.baseCurrency,
    totalValue: portfolioResult.totalValue,
    totalAvailableCash: portfolioResult.totalAvailableCash,
    totalUnrealizedProfitLoss: portfolioResult.totalUnrealizedProfitLoss,
    accounts: accounts.map((a) => ({
      currency: a.currency,
      totalValue: a.totalValue,
      positions: Array.isArray(a.positions)
        ? (a.positions as Array<Record<string, unknown>>).map((p) => ({
            symbol: p.symbol,
            name: p.name,
            quantity: p.quantity,
            marketValue: p.marketValue,
            marketValueBaseCurrency: p.marketValueBaseCurrency,
            profitLoss: p.profitLoss,
            currency: p.currency,
          }))
        : [],
    })),
  };
  const portfolioContext = JSON.stringify(portfolioSummary);

  // ── Portfolio Analyzer ────────────────────────────────────────────────────

  const analyzerEntry = analysisRepository.get<Record<string, unknown>>("portfolio-analyzer");
  const portfolioAnalyzerContext = analyzerEntry
    ? JSON.stringify({
        executiveSummary: analyzerEntry.result.executiveSummary,
        mainConclusion: analyzerEntry.result.mainConclusion,
        overallRating: analyzerEntry.result.overallRating,
        overallOutlook: analyzerEntry.result.overallOutlook,
        portfolioScore: analyzerEntry.result.portfolioScore,
        strengths: analyzerEntry.result.strengths,
        weaknesses: analyzerEntry.result.weaknesses,
        topRisks: analyzerEntry.result.topRisks,
        topOpportunities: analyzerEntry.result.topOpportunities,
        sectorAssessment: analyzerEntry.result.sectorAssessment,
      })
    : null;

  // ── Other monitors ────────────────────────────────────────────────────────

  const marketEntry = analysisRepository.get<Record<string, unknown>>("market-monitor");
  const marketContext = marketEntry
    ? JSON.stringify({
        marketSentiment: marketEntry.result.marketSentiment,
        riskLevel: marketEntry.result.riskLevel,
        summary: marketEntry.result.summary,
        positiveFactors: marketEntry.result.positiveFactors,
        negativeFactors: marketEntry.result.negativeFactors,
        strongSectors: marketEntry.result.strongSectors,
        weakSectors: marketEntry.result.weakSectors,
        keyRisks: marketEntry.result.keyRisks,
      })
    : null;

  const eventEntry = analysisRepository.get<Record<string, unknown>>("event-monitor");
  const eventContext = eventEntry
    ? JSON.stringify({
        summary: eventEntry.result.summary,
        nextMajorEvent: eventEntry.result.nextMajorEvent,
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

  const newsEntry = analysisRepository.get<Record<string, unknown>>("news-monitor");
  const newsContext = newsEntry
    ? JSON.stringify({
        executiveSummary: newsEntry.result.executiveSummary,
        overallMarketImpact: newsEntry.result.overallMarketImpact,
        topStory: newsEntry.result.topStory,
        news: Array.isArray(newsEntry.result.news)
          ? (newsEntry.result.news as Array<Record<string, unknown>>).map((n) => ({
              title: n.title,
              category: n.category,
              importance: n.importance,
              marketImpact: n.marketImpact,
              affectedMarkets: n.affectedMarkets,
            }))
          : [],
      })
    : null;

  const sectorEntry = analysisRepository.get<Record<string, unknown>>("sector-monitor");
  const sectorContext = sectorEntry
    ? JSON.stringify({
        executiveSummary: sectorEntry.result.executiveSummary,
        overallOutlook: sectorEntry.result.overallOutlook,
        topSector: sectorEntry.result.topSector,
        sectors: Array.isArray(sectorEntry.result.sectors)
          ? (sectorEntry.result.sectors as Array<Record<string, unknown>>).map((s) => ({
              name: s.name,
              rating: s.rating,
              trend: s.trend,
              summary: s.summary,
            }))
          : [],
      })
    : null;

  // ── Company Monitor for held positions (via companyIdentityStore) ─────────

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
        const entry = analysisRepository.get<Record<string, unknown>>(resolved.key);
        if (entry) {
          const r = entry.result as Record<string, unknown>;
          companyContexts[symbol] = JSON.stringify({
            executiveSummary: r.executiveSummary,
            investmentView: r.investmentView,
            currentSituation: r.currentSituation,
            catalysts: r.catalysts,
            risks: r.risks,
            earningsAndGuidance: r.earningsAndGuidance,
            marketSentiment: r.marketSentiment,
            keyThingsToWatch: r.keyThingsToWatch,
          });
        } else {
          hasMissingCompanyData = true;
        }
      } else {
        hasMissingCompanyData = true;
      }
    }
  }

  if (hasMissingCompanyData) {
    systemLog.logWarning(
      MODULE_NAME,
      "Company Monitor analysis missing for one or more portfolio holdings"
    );
  }

  req.log.info(
    {
      hasPortfolioAnalyzer: !!portfolioAnalyzerContext,
      hasMarket: !!marketContext,
      hasEvent: !!eventContext,
      hasNews: !!newsContext,
      hasSector: !!sectorContext,
      holdingCompanyContextCount: Object.keys(companyContexts).length,
    },
    "Context loaded from Analysis Repository"
  );

  // ── Load previous history for status computation ───────────────────────────

  const historyEntry = analysisRepository.get<{ entries: HistoryEntry[] }>("opportunity-finder-history");
  const previousCandidates: HistoryCandidate[] = historyEntry?.result?.entries?.[0]?.candidates ?? [];

  function computeStatus(ticker: string, rank: number): "New" | "Up" | "Down" | "Unchanged" {
    const prev = previousCandidates.find(
      (c) => c.ticker.toUpperCase() === ticker.toUpperCase()
    );
    if (!prev) return "New";
    if (rank < prev.rank) return "Up";
    if (rank > prev.rank) return "Down";
    return "Unchanged";
  }

  // ── AI call with retry ─────────────────────────────────────────────────────

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: unknown;
    let debug: AiDebugInfo;

    try {
      ({ result, debug } = await callAiWithWebSearch<unknown>(
        SYSTEM_PROMPT,
        buildUserPrompt(
          nowIso,
          portfolioContext,
          portfolioAnalyzerContext,
          marketContext,
          eventContext,
          newsContext,
          sectorContext,
          companyContexts,
          getAllPriceContexts()
        ),
        { model: "gpt-4o", maxTokens: 3500, temperature: 0.1 }
      ));
    } catch (err) {
      const isLastAttempt = attempt >= MAX_ATTEMPTS;
      req.log[isLastAttempt ? "error" : "warn"](
        { err, attempt },
        isLastAttempt ? "AI service call failed after all attempts" : "AI service call failed — retrying"
      );
      if (isLastAttempt) {
        systemLog.logError(MODULE_NAME, "Opportunity analysis failed");
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
    const parsed = RunOpportunityFinderResponse.safeParse({
      ...(result as Record<string, unknown>),
      timestamp: nowIso,
      analysisDuration,
    });

    if (parsed.success) {
      // ── Sort by overallScore and reassign ranks (do not trust AI ordering) ──

      const sortedCandidates = [...parsed.data.topOpportunities]
        .sort((a, b) => b.overallScore - a.overallScore)
        .map((opp, i) => ({ ...opp, rank: i + 1 }));

      req.log.info(
        { order: sortedCandidates.map((o) => `${o.ticker}(${o.overallScore})`) },
        "Candidates sorted by overallScore"
      );

      // ── Post-process each candidate ────────────────────────────────────────

      const enrichedOpportunities = sortedCandidates.map((opp) => {
        // 1. Override companyAnalysisAvailable — server is authoritative
        const resolved = companyIdentityStore.resolve(
          opp.ticker,
          { companyName: opp.company },
          companyMonitorCandidates
        );
        const companyAnalysisAvailable = resolved !== null;

        // 2. Clear expired catalysts.
        //    If catalystDate is in the past, the catalyst text is stale too — a
        //    past date signals the AI described an already-occurred event as
        //    upcoming. Clear both fields so the saved candidate contains no
        //    expired catalyst. A past event is only valid if the text describes
        //    its published result (no date needed), but that cannot be
        //    distinguished programmatically, so we clear both conservatively.
        let catalystDate = opp.catalystDate;
        let mainCatalyst = opp.mainCatalyst;
        if (catalystDate) {
          const d = new Date(catalystDate);
          if (!isNaN(d.getTime()) && d <= nowDate) {
            req.log.debug(
              { ticker: opp.ticker, catalystDate },
              "Clearing past catalyst date and text"
            );
            catalystDate = "";
            mainCatalyst = "";
          }
        }

        // 3. Compute status using the corrected (server-assigned) rank
        const status = computeStatus(opp.ticker, opp.rank);

        return { ...opp, companyAnalysisAvailable, catalystDate, mainCatalyst, status };
      });

      const enrichedData = { ...parsed.data, topOpportunities: enrichedOpportunities };

      // ── Store result ──────────────────────────────────────────────────────
      analysisRepository.save("opportunity-finder", enrichedData);

      // ── Update history ────────────────────────────────────────────────────
      const existingEntries = historyEntry?.result?.entries ?? [];
      const newHistoryEntry: HistoryEntry = {
        timestamp: nowIso,
        overallOpportunityLevel: enrichedData.overallOpportunityLevel,
        candidates: enrichedOpportunities.map((o) => ({
          ticker: o.ticker,
          company: o.company,
          rank: o.rank,
          overallScore: o.overallScore,
          priority: o.priority,
          confidence: o.confidence,
        })),
      };
      const updatedHistory = [newHistoryEntry, ...existingEntries].slice(0, MAX_HISTORY);
      analysisRepository.save("opportunity-finder-history", { entries: updatedHistory });

      // ── System Log ────────────────────────────────────────────────────────
      systemLog.logInfo(MODULE_NAME, "Opportunity analysis completed");
      systemLog.logInfo(
        MODULE_NAME,
        `Overall opportunity level: ${enrichedData.overallOpportunityLevel}`
      );

      const topOpp = enrichedOpportunities[0];
      if (topOpp) {
        systemLog.logInternal(
          MODULE_NAME,
          `Highest-ranked opportunity: ${topOpp.company} (${topOpp.ticker}) — score ${topOpp.overallScore} — ${topOpp.scoreReason}`
        );
      }

      // Log candidate changes
      const newTickers = new Set(enrichedOpportunities.map((o) => o.ticker.toUpperCase()));
      const prevTickers = new Set(previousCandidates.map((c) => c.ticker.toUpperCase()));

      for (const opp of enrichedOpportunities) {
        if (!prevTickers.has(opp.ticker.toUpperCase())) {
          systemLog.logInternal(
            MODULE_NAME,
            `${opp.ticker} entered the list at rank ${opp.rank} (score: ${opp.overallScore})`
          );
        }
      }
      for (const prev of previousCandidates) {
        if (!newTickers.has(prev.ticker.toUpperCase())) {
          systemLog.logInternal(
            MODULE_NAME,
            `${prev.ticker} left the list (was rank ${prev.rank})`
          );
        }
      }

      res.json({ ...enrichedData, _debug: debug });
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
      systemLog.logError(MODULE_NAME, "Opportunity analysis failed");
      res.status(500).json({
        error: "AI returned an invalid response structure. Please try again.",
        _debug: lastDebug,
      });
    }
  }
});

export default router;
