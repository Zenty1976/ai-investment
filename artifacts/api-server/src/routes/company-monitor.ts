/**
 * Company Monitor Route — v2
 *
 * A stateful institutional analyst that maintains a persistent investment
 * thesis and evaluates whether the investment case has materially changed
 * since the last analysis. On a first run it generates a complete analysis;
 * on subsequent runs it compares against the previous analysis and only
 * rewrites what has genuinely changed.
 *
 * Server-side processing after every AI call:
 *  - Validates against Zod schema
 *  - Runs consistency validation against the previous analysis
 *  - For NoMaterialChange: merges with previous to preserve stable fields
 *  - For UpdateWithChanges: preserves thesis point text for existing IDs
 *  - Validates and fixes date fields
 *  - Computes meaningfulChange for the orchestrator
 *  - Appends a compact history entry
 *  - Sets timestamp and analysisDuration (never trusted from AI)
 *  - Normalises ticker to uppercase
 *
 * Repository keys:
 *   company-monitor:<TICKER>          — latest full analysis
 *   company-monitor-history:<TICKER>  — compact history (last 20)
 */
import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { RunCompanyAnalysisResponse } from "@workspace/api-zod";
import { callAiWithWebSearch, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";
import type { z } from "zod";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ParsedAnalysis = z.infer<typeof RunCompanyAnalysisResponse>;
type MeaningfulChange = 'None' | 'Low' | 'Medium' | 'High';

interface HistoryEntry {
  timestamp: string;
  updateType: string;
  investmentViewRating: string;
  investmentViewOutlook: string;
  investmentCaseStrength: number;
  investmentCaseChangeSeverity: string;
  investmentCaseChangeSummary: string;
  thesisPointStatuses: Array<{ id: string; status: string }>;
  confidence: string;
  meaningfulChange: MeaningfulChange;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const HISTORY_MAX = 20;

// ---------------------------------------------------------------------------
// JSON output template — includes thesis point IDs
// ---------------------------------------------------------------------------

const JSON_TEMPLATE = `{"updateType":"FullAnalysis|UpdateWithChanges|NoMaterialChange","company":{"name":"...","ticker":"...","sector":"...","industry":"..."},"executiveSummary":"...","investmentView":{"rating":"Strong Buy|Buy|Watch|Avoid|Strong Avoid","outlook":"Bullish|Moderately Bullish|Neutral|Moderately Bearish|Bearish","reason":"..."},"investmentThesis":[{"id":"azure-growth","point":"...","status":"Strengthened|Unchanged|Weakened|Invalidated"}],"investmentCaseStrength":85,"investmentCaseChange":{"changed":false,"severity":"None|Low|Medium|High","summary":"...","previousInvestmentView":"N/A","currentInvestmentView":"Buy","reason":"..."},"investmentCaseStrengthChange":{"previousScore":88,"currentScore":82,"reasons":["..."]},"stableProfile":{"businessDescription":"...","competitiveAdvantage":"...","longTermStrengths":["..."],"recurringRisks":["..."]},"currentSituation":"...","catalysts":[{"title":"...","description":"...","timeframe":"Immediate|Within 1 month|Within 3 months","impact":"High|Medium|Low"}],"risks":[{"title":"...","description":"...","impact":"High|Medium|Low"}],"earningsAndGuidance":{"summary":"...","trend":"Improving|Stable|Weakening","nextKnownEvent":"...","nextKnownEventDate":"YYYY-MM-DD or empty string"},"competitivePosition":{"assessment":"Strong|Moderate|Weak","summary":"..."},"sectorContext":"...","marketSentiment":"Positive|Mixed|Negative","valuationAssessment":{"level":"Attractive|Reasonable|Expensive|Unclear","summary":"..."},"bullCase":"...","baseCase":"...","bearCase":"...","keyThingsToWatch":["..."],"confidence":"High|Medium|Low"}`;

// ---------------------------------------------------------------------------
// System prompt — first-time full analysis
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_FULL = `You are a senior institutional equity analyst. Your role is not to describe companies — it is to evaluate whether this company represents a compelling investment opportunity over the next 1-3 months.

Your analysis is the permanent foundation for downstream investment decisions by a Risk Analyzer, Portfolio Analyzer, and Trade Decision Engine. It must be structured, specific, and investment-focused.

Use current web search results and the supplied market context.

Focus on what could materially move the share price during the next 1-3 months.

Distinguish clearly between confirmed facts, market expectations and your own analytical conclusions.

Do not invent financial figures, dates, guidance or events.

If reliable information is unavailable, state this clearly.

OUTPUT RULES:
- Return exactly the JSON structure shown below — no markdown, no code fences, no extra text
- catalysts: maximum 5 items
- risks: maximum 5 items
- investmentThesis: 3-5 bullet points stating WHY this company is or is not a compelling investment — these are the permanent thesis points re-evaluated on every future update
  - Each point must have a stable kebab-case "id" (e.g. "azure-growth", "margin-expansion", "regulatory-risk"), a "point" string, and "status": always "Unchanged" for a first analysis
  - IDs must be short, unique, and descriptive — they persist across all future updates
- investmentCaseStrength: 0–100 score representing how strong the overall investment case is right now
  - Do NOT move this score based on ordinary daily price movement or minor news
  - Small changes should normally be 1–3 points; larger changes require clearly identified material evidence
- updateType: always "FullAnalysis" for a first-time analysis
- investmentCaseChange: set changed=false, severity="None", previousInvestmentView="N/A" for a first-time analysis; do NOT include investmentCaseStrengthChange
- stableProfile: core business facts — business model, competitive moat, structural strengths, recurring risks
- earningsAndGuidance.nextKnownEventDate: must be an ISO date in the future (YYYY-MM-DD) or an empty string — never a past date
- All enum fields must use exactly the allowed values
- Do not include the timestamp or analysisDuration fields — the server sets those

Return exactly:
${JSON_TEMPLATE}`;

// ---------------------------------------------------------------------------
// System prompt — update (previous analysis exists)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_UPDATE = `You are a senior institutional equity analyst maintaining a continuous investment thesis on a company.

You have been provided with the PREVIOUS ANALYSIS for this company. Your primary task is NOT to rewrite the analysis — it is to evaluate what has MATERIALLY CHANGED since the previous analysis.

Primary objectives:
1. Has the investment case changed?
2. Has each thesis point been strengthened or weakened?
3. Should the investment view (rating/outlook) change?
4. Has the investment case strength (score) changed materially?

A VALID OUTCOME is to confirm nothing material has changed:
- Set updateType="NoMaterialChange"
- Keep all thesis point IDs and return them with status="Unchanged"
- Update only the dynamic information (currentSituation, earningsAndGuidance, catalysts, risks, keyThingsToWatch, confidence)
- Keep investmentCaseChange.changed=false, severity="None"
- The investmentView, investmentCaseStrength, stableProfile, bullCase, baseCase, bearCase, competitivePosition must exactly match the previous analysis

Only set updateType="UpdateWithChanges" if the investment case or a thesis point has GENUINELY changed.

THESIS POINT RULES (critical):
- You MUST return ALL previous thesis point IDs — never omit an existing ID
- For existing IDs: preserve the exact "point" text; only update "status"
- Set status="Invalidated" if a thesis point is no longer valid — do NOT omit it
- Add new thesis points only with new unique IDs if genuinely warranted
- IDs are stable identifiers — do not change or reword them

INVESTMENT CASE STRENGTH SCORE RULES:
- Do NOT move the score for ordinary daily price movement or minor news
- Small changes should normally be 1–3 points
- A change of more than 10 points requires severity="High" and at least 2 concrete reasons in investmentCaseStrengthChange.reasons
- The score MUST NOT change when updateType="NoMaterialChange"
- If the score changed, include investmentCaseStrengthChange with previousScore (matching the previous analysis exactly), currentScore, and specific reasons
- If the score did NOT change, do NOT include investmentCaseStrengthChange

INVESTMENT CASE CHANGE RULES:
- investmentCaseChange.previousInvestmentView must match the actual previous rating exactly
- investmentCaseChange.currentInvestmentView must match the rating you are now returning
- For UpdateWithChanges: changed=true, severity must not be "None", reason and summary must be non-empty

DATE RULES:
- earningsAndGuidance.nextKnownEventDate: must be a future date in YYYY-MM-DD format or an empty string
- If the previous next event date has now passed, do not repeat it — find the next upcoming event or use an empty string

Return the full CompanyAnalysis JSON every time. The server applies the stable-field preservation rules.

OUTPUT RULES:
- Return exactly the JSON structure shown below — no markdown, no code fences, no extra text
- catalysts: maximum 5 items
- risks: maximum 5 items
- All enum fields must use exactly the allowed values
- Do not include the timestamp or analysisDuration fields — the server sets those

Return exactly:
${JSON_TEMPLATE}`;

// ---------------------------------------------------------------------------
// Previous analysis summary for the update prompt
// ---------------------------------------------------------------------------

function buildPreviousAnalysisSummary(prev: Record<string, unknown>): string {
  return JSON.stringify({
    analyzedAt:            prev.timestamp,
    updateType:            prev.updateType,
    investmentView:        prev.investmentView,
    investmentCaseStrength: prev.investmentCaseStrength ?? null,
    investmentThesis:      prev.investmentThesis ?? [],
    investmentCaseChange:  prev.investmentCaseChange ?? null,
    executiveSummary:      prev.executiveSummary,
    currentSituation:      prev.currentSituation,
    stableProfile:         prev.stableProfile ?? null,
    bullCase:              prev.bullCase,
    baseCase:              prev.baseCase,
    bearCase:              prev.bearCase,
    keyThingsToWatch:      prev.keyThingsToWatch,
    earningsAndGuidance:   prev.earningsAndGuidance,
    competitivePosition:   prev.competitivePosition,
  });
}

// ---------------------------------------------------------------------------
// Consistency validation (point 2)
// ---------------------------------------------------------------------------

function validateConsistency(
  data: ParsedAnalysis,
  prevAnalysis: Record<string, unknown> | undefined,
  isFirstRun: boolean
): string | null {
  const prevView = prevAnalysis?.investmentView as { rating: string; outlook: string } | undefined;
  const prevStrength = prevAnalysis?.investmentCaseStrength as number | undefined;
  const prevThesis = (prevAnalysis?.investmentThesis as Array<{ id: string; point: string; status: string }> | undefined) ?? [];
  const prevRating = prevView?.rating ?? '';
  const prevOutlook = prevView?.outlook ?? '';

  if (isFirstRun) {
    if (data.updateType !== 'FullAnalysis') {
      return `First run must use updateType="FullAnalysis", got "${data.updateType}"`;
    }
    if (data.investmentCaseChange.changed !== false) {
      return 'First run: investmentCaseChange.changed must be false';
    }
    if (data.investmentCaseChange.severity !== 'None') {
      return `First run: investmentCaseChange.severity must be "None", got "${data.investmentCaseChange.severity}"`;
    }
    if (data.investmentCaseChange.previousInvestmentView !== 'N/A') {
      return `First run: previousInvestmentView must be "N/A", got "${data.investmentCaseChange.previousInvestmentView}"`;
    }
    if (data.investmentCaseStrengthChange !== undefined) {
      return 'First run: investmentCaseStrengthChange must be absent';
    }
    return null;
  }

  // Update run
  if (data.updateType === 'NoMaterialChange') {
    if (data.investmentCaseChange.changed !== false) {
      return 'NoMaterialChange: investmentCaseChange.changed must be false';
    }
    if (data.investmentCaseChange.severity !== 'None') {
      return `NoMaterialChange: severity must be "None", got "${data.investmentCaseChange.severity}"`;
    }
    if (prevView && data.investmentView.rating !== prevRating) {
      return `NoMaterialChange: investmentView.rating "${data.investmentView.rating}" differs from previous "${prevRating}"`;
    }
    if (prevView && data.investmentView.outlook !== prevOutlook) {
      return `NoMaterialChange: investmentView.outlook "${data.investmentView.outlook}" differs from previous "${prevOutlook}"`;
    }
    if (prevStrength !== undefined && data.investmentCaseStrength !== prevStrength) {
      return `NoMaterialChange: investmentCaseStrength ${data.investmentCaseStrength} differs from previous ${prevStrength}`;
    }
    if (data.investmentCaseStrengthChange !== undefined) {
      return 'NoMaterialChange: investmentCaseStrengthChange must be absent';
    }
    // No previous thesis point may be removed or marked Invalidated
    for (const prevPt of prevThesis) {
      const found = data.investmentThesis.find(p => p.id === prevPt.id);
      if (!found) {
        return `NoMaterialChange: thesis point id "${prevPt.id}" was omitted (must be returned with Unchanged status)`;
      }
      if (found.status === 'Invalidated') {
        return `NoMaterialChange: thesis point "${prevPt.id}" may not be Invalidated`;
      }
    }
    return null;
  }

  if (data.updateType === 'UpdateWithChanges') {
    if (data.investmentCaseChange.changed !== true) {
      return 'UpdateWithChanges: investmentCaseChange.changed must be true';
    }
    if (data.investmentCaseChange.severity === 'None') {
      return 'UpdateWithChanges: severity must not be "None"';
    }
    if (!data.investmentCaseChange.reason.trim() || !data.investmentCaseChange.summary.trim()) {
      return 'UpdateWithChanges: investmentCaseChange.reason and .summary must be non-empty';
    }
    // previousInvestmentView must match actual previous
    if (prevView && data.investmentCaseChange.previousInvestmentView !== prevRating) {
      return `UpdateWithChanges: previousInvestmentView "${data.investmentCaseChange.previousInvestmentView}" must match previous rating "${prevRating}"`;
    }
    // currentInvestmentView must match the newly returned rating
    if (data.investmentCaseChange.currentInvestmentView !== data.investmentView.rating) {
      return `UpdateWithChanges: currentInvestmentView "${data.investmentCaseChange.currentInvestmentView}" must match investmentView.rating "${data.investmentView.rating}"`;
    }
    // Strength change consistency
    const scoreChanged = prevStrength !== undefined && data.investmentCaseStrength !== prevStrength;
    if (scoreChanged && !data.investmentCaseStrengthChange) {
      return `UpdateWithChanges: investmentCaseStrength changed from ${prevStrength} to ${data.investmentCaseStrength} but investmentCaseStrengthChange is absent`;
    }
    if (!scoreChanged && prevStrength !== undefined && data.investmentCaseStrengthChange !== undefined) {
      return 'UpdateWithChanges: investmentCaseStrength did not change but investmentCaseStrengthChange is present';
    }
    if (data.investmentCaseStrengthChange) {
      if (prevStrength !== undefined && data.investmentCaseStrengthChange.previousScore !== prevStrength) {
        return `UpdateWithChanges: investmentCaseStrengthChange.previousScore ${data.investmentCaseStrengthChange.previousScore} must equal previous score ${prevStrength}`;
      }
      if (data.investmentCaseStrengthChange.currentScore !== data.investmentCaseStrength) {
        return `UpdateWithChanges: investmentCaseStrengthChange.currentScore ${data.investmentCaseStrengthChange.currentScore} must equal investmentCaseStrength ${data.investmentCaseStrength}`;
      }
    }
    // Score movement discipline: >10 pts requires High severity and ≥2 reasons
    if (data.investmentCaseStrengthChange) {
      const delta = Math.abs(data.investmentCaseStrengthChange.currentScore - data.investmentCaseStrengthChange.previousScore);
      if (delta > 10) {
        if (data.investmentCaseChange.severity !== 'High') {
          return `Score moved by ${delta} points — requires severity="High" (got "${data.investmentCaseChange.severity}")`;
        }
        if (!data.investmentCaseStrengthChange.reasons || data.investmentCaseStrengthChange.reasons.length < 2) {
          return `Score moved by ${delta} points — requires at least 2 concrete reasons in investmentCaseStrengthChange.reasons`;
        }
      }
    }
    // Require all previous thesis IDs to be returned
    for (const prevPt of prevThesis) {
      if (!data.investmentThesis.find(p => p.id === prevPt.id)) {
        return `UpdateWithChanges: thesis point id "${prevPt.id}" was omitted (use Invalidated if no longer valid)`;
      }
    }
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Server-side merge for NoMaterialChange (point 1)
// ---------------------------------------------------------------------------

function mergeNoMaterialChange(
  newData: ParsedAnalysis,
  prev: Record<string, unknown>
): ParsedAnalysis {
  const prevThesis = (prev.investmentThesis as Array<{ id: string; point: string; status: string }> | undefined) ?? [];

  // Preserve thesis text; apply new status only when ID matches
  const mergedThesis = prevThesis.map(prevPt => {
    const match = newData.investmentThesis.find(p => p.id === prevPt.id);
    return {
      id: prevPt.id,
      point: prevPt.point, // always preserve original text
      status: (match?.status ?? 'Unchanged') as 'Strengthened' | 'Unchanged' | 'Weakened' | 'Invalidated',
    };
  });

  const prevView = prev.investmentView as ParsedAnalysis['investmentView'];
  const prevStrength = prev.investmentCaseStrength as number;
  const prevStableProfile = prev.stableProfile as ParsedAnalysis['stableProfile'];
  const prevCompetitivePosition = prev.competitivePosition as ParsedAnalysis['competitivePosition'];

  return {
    ...newData,
    // Preserve stable identity
    company: prev.company as ParsedAnalysis['company'],
    // Preserve stable analysis fields
    stableProfile: prevStableProfile ?? newData.stableProfile,
    investmentView: prevView ?? newData.investmentView,
    investmentCaseStrength: prevStrength ?? newData.investmentCaseStrength,
    competitivePosition: prevCompetitivePosition ?? newData.competitivePosition,
    bullCase: (prev.bullCase as string) ?? newData.bullCase,
    baseCase: (prev.baseCase as string) ?? newData.baseCase,
    bearCase: (prev.bearCase as string) ?? newData.bearCase,
    // Preserved + status-updated thesis
    investmentThesis: mergedThesis,
    // strengthChange is never valid on NoMaterialChange
    investmentCaseStrengthChange: undefined,
  };
}

// ---------------------------------------------------------------------------
// Thesis text preservation for UpdateWithChanges (point 3)
// ---------------------------------------------------------------------------

function applyThesisUpdate(
  newThesis: ParsedAnalysis['investmentThesis'],
  prevThesis: Array<{ id: string; point: string; status: string }>
): ParsedAnalysis['investmentThesis'] {
  const prevMap = new Map(prevThesis.map(p => [p.id, p]));
  const result: ParsedAnalysis['investmentThesis'] = [];
  const seenIds = new Set<string>();

  for (const newPt of newThesis) {
    const prev = prevMap.get(newPt.id);
    if (prev) {
      // Existing point — preserve original text, apply new status
      result.push({ id: newPt.id, point: prev.point, status: newPt.status });
    } else {
      // New thesis point with a new ID
      result.push(newPt);
    }
    seenIds.add(newPt.id);
  }

  // Ensure all previous IDs are present (consistency check should have caught this,
  // but defend in depth — add any missing ones as Invalidated)
  for (const [id, prev] of prevMap) {
    if (!seenIds.has(id)) {
      result.push({ id, point: prev.point, status: 'Invalidated' });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Date validation (point 7)
// ---------------------------------------------------------------------------

function validateAndFixDates(
  data: ParsedAnalysis,
  nowIso: string,
  warnings: string[]
): ParsedAnalysis {
  const now = new Date(nowIso);
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

  // nextKnownEventDate
  const eventDate = data.earningsAndGuidance.nextKnownEventDate;
  if (eventDate && eventDate.trim() !== '') {
    if (!isoDateRegex.test(eventDate.trim())) {
      warnings.push(`nextKnownEventDate "${eventDate}" is not ISO YYYY-MM-DD — clearing`);
      data = {
        ...data,
        earningsAndGuidance: { ...data.earningsAndGuidance, nextKnownEventDate: '' },
      };
    } else {
      const d = new Date(eventDate + 'T00:00:00Z');
      if (d < now) {
        warnings.push(`nextKnownEventDate "${eventDate}" is in the past — clearing`);
        data = {
          ...data,
          earningsAndGuidance: { ...data.earningsAndGuidance, nextKnownEventDate: '' },
        };
      }
    }
  }

  return data;
}

// ---------------------------------------------------------------------------
// Deterministic meaningfulChange computation (point 5)
// ---------------------------------------------------------------------------

function computeMeaningfulChange(
  data: ParsedAnalysis,
  prevAnalysis: Record<string, unknown> | undefined
): MeaningfulChange {
  if (data.updateType === 'FullAnalysis') {
    return 'High';
  }

  if (data.updateType === 'NoMaterialChange') {
    return 'None';
  }

  // UpdateWithChanges
  const severity = data.investmentCaseChange.severity;

  // Automatic High triggers
  if (severity === 'High') return 'High';

  const hasInvalidatedPoint = data.investmentThesis.some(p => p.status === 'Invalidated');
  if (hasInvalidatedPoint) return 'High';

  if (prevAnalysis) {
    const prevRating = (prevAnalysis.investmentView as { rating: string } | undefined)?.rating;
    if (prevRating && prevRating !== data.investmentView.rating) return 'High';

    const prevScore = prevAnalysis.investmentCaseStrength as number | undefined;
    if (prevScore !== undefined && Math.abs(data.investmentCaseStrength - prevScore) > 10) return 'High';
  }

  if (severity === 'Medium') return 'Medium';
  if (severity === 'Low') return 'Low';
  return 'Low';
}

// ---------------------------------------------------------------------------
// Compact history append (point 4)
// ---------------------------------------------------------------------------

function appendToHistory(
  ticker: string,
  data: ParsedAnalysis,
  meaningfulChange: MeaningfulChange
): void {
  const histKey = `company-monitor-history:${ticker}`;
  const existing = analysisRepository.getAll().find(e => e.moduleName === histKey);
  const existingHistory = existing
    ? ((existing.result as { entries: HistoryEntry[] }).entries ?? [])
    : [];

  const entry: HistoryEntry = {
    timestamp: data.timestamp,
    updateType: data.updateType,
    investmentViewRating: data.investmentView.rating,
    investmentViewOutlook: data.investmentView.outlook,
    investmentCaseStrength: data.investmentCaseStrength,
    investmentCaseChangeSeverity: data.investmentCaseChange.severity,
    investmentCaseChangeSummary: data.investmentCaseChange.summary,
    thesisPointStatuses: data.investmentThesis.map(p => ({ id: p.id, status: p.status })),
    confidence: data.confidence,
    meaningfulChange,
  };

  const newHistory = [entry, ...existingHistory].slice(0, HISTORY_MAX);
  analysisRepository.save(histKey, { entries: newHistory });
}

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

function buildUserPrompt(
  ticker: string,
  companyName: string | undefined,
  nowIso: string,
  marketContext: string | null,
  eventContext: string | null,
  newsContext: string | null,
  sectorContext: string | null,
  previousAnalysisSummary: string | null
): string {
  const displayName = companyName ? `${companyName} (${ticker})` : ticker;
  const isUpdate = !!previousAnalysisSummary;

  const blocks: string[] = [`UTC: ${nowIso}`, ""];

  if (isUpdate) {
    blocks.push(
      "PREVIOUS ANALYSIS (your own prior work on this company):",
      previousAnalysisSummary,
      "",
      `New information to evaluate for ${displayName}:`,
      "",
      "Search for material developments since the previous analysis: recent earnings, guidance changes, analyst upgrades/downgrades, regulatory news, major news events, or any other company-specific developments.",
      "",
      "Question: Has the investment case changed since the previous analysis? Evaluate each thesis point."
    );
  } else {
    blocks.push(
      `Perform a full investment analysis of ${displayName} for the next 1-3 months.`,
      "",
      "Analyse: recent company news, latest earnings and guidance, revenue and profit trends, key products and business segments, competitive position, sector conditions, analyst expectations, upcoming company-specific events, catalysts, risks, valuation concerns, market sentiment and likely short-term direction.",
      "",
      "Build an explicit investment thesis — 3-5 bullet points explaining WHY this company is (or is not) a compelling investment right now. Each thesis point must have a unique stable kebab-case ID.",
      "",
      "This must be an investment analysis — not a company description or news summary."
    );
  }

  if (marketContext) {
    blocks.push(
      "",
      "Current Market Monitor context (use for macro framing — do not repeat this):",
      marketContext
    );
  }
  if (eventContext) {
    blocks.push(
      "",
      "Current Event Monitor context (use for event-driven catalyst awareness — do not repeat this):",
      eventContext
    );
  }
  if (newsContext) {
    blocks.push(
      "",
      "Current News Monitor context (use for recent market-moving developments — do not repeat this):",
      newsContext
    );
  }
  if (sectorContext) {
    blocks.push(
      "",
      "Current Sector Monitor context (use for sector conditions — do not repeat this):",
      sectorContext
    );
  }

  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/company-monitor/analyze", async (req, res): Promise<void> => {
  // ── Validate request body ────────────────────────────────────────────────

  const rawTicker = typeof req.body?.ticker === "string" ? req.body.ticker.trim() : "";
  if (!rawTicker || rawTicker.length > 10) {
    res.status(400).json({ error: "ticker is required (max 10 characters)" });
    return;
  }
  const ticker = rawTicker.toUpperCase();
  const companyName: string | undefined =
    typeof req.body?.companyName === "string" && req.body.companyName.trim()
      ? req.body.companyName.trim()
      : undefined;

  req.log.info({ ticker, companyName }, "Running company monitor analysis with web search");

  const orchestratorTrigger = req.headers['x-orchestrator-trigger'];
  if (orchestratorTrigger) {
    systemLog.logInfo("Company Monitor", `Scheduled run for ${ticker} (trigger: ${orchestratorTrigger})`);
  } else {
    systemLog.logUser("Company Monitor", `User manually started company analysis for ${ticker}`);
  }

  const startTime = Date.now();
  const nowIso = new Date().toISOString();
  let lastDebug: AiDebugInfo | undefined;

  // ── Read previous analysis from repository ────────────────────────────────

  const repositoryKey = `company-monitor:${ticker}`;
  const prevEntry = analysisRepository.getAll().find(e => e.moduleName === repositoryKey);
  const prevAnalysis = prevEntry?.result as Record<string, unknown> | undefined;
  const isFirstRun = !prevAnalysis;

  const previousAnalysisSummary = prevAnalysis ? buildPreviousAnalysisSummary(prevAnalysis) : null;

  if (!isFirstRun) {
    req.log.info(
      { ticker, prevTimestamp: prevAnalysis?.timestamp },
      "Previous analysis found — running in update mode"
    );
  }

  // ── Read context from Analysis Repository ──────────────────────────────────

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
  const sectorContextStr = sectorEntry
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

  req.log.info(
    { hasMarket: !!marketContext, hasEvent: !!eventContext, hasNews: !!newsContext, hasSector: !!sectorContextStr, isFirstRun },
    "Context loaded from Analysis Repository"
  );

  // ── Choose prompt and build user message ───────────────────────────────────

  const systemPrompt = isFirstRun ? SYSTEM_PROMPT_FULL : SYSTEM_PROMPT_UPDATE;
  const userPrompt = buildUserPrompt(
    ticker, companyName, nowIso,
    marketContext, eventContext, newsContext, sectorContextStr,
    previousAnalysisSummary
  );

  // ── AI call with retry ─────────────────────────────────────────────────────

  let lastConsistencyError: string | null = null;
  let lastZodErrors: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: unknown;
    let debug: AiDebugInfo;

    // On retries, prepend the error so the model can correct exactly what was wrong
    let effectiveUserPrompt = userPrompt;
    if (lastConsistencyError) {
      effectiveUserPrompt = [
        "The previous response failed server-side consistency validation.",
        "",
        "Validation error:",
        lastConsistencyError,
        "",
        "Correct only the inconsistent fields while preserving the rest of the response.",
        "",
        "---",
        "",
        userPrompt,
      ].join("\n");
    } else if (lastZodErrors) {
      effectiveUserPrompt = [
        "The previous response failed server-side JSON schema validation.",
        "",
        "Schema errors:",
        lastZodErrors,
        "",
        "Correct only the invalid fields while preserving the rest of the response.",
        "",
        "---",
        "",
        userPrompt,
      ].join("\n");
    }

    try {
      ({ result, debug } = await callAiWithWebSearch<unknown>(
        systemPrompt,
        effectiveUserPrompt,
        { model: "gpt-4o", maxTokens: 4000, temperature: 0.1 }
      ));
    } catch (err) {
      const isLastAttempt = attempt >= MAX_ATTEMPTS;
      req.log[isLastAttempt ? "error" : "warn"](
        { err, attempt },
        isLastAttempt ? "AI service call failed after all attempts" : "AI service call failed — retrying"
      );
      if (isLastAttempt) {
        systemLog.logError("Company Monitor", `Company analysis failed for ${ticker}: ${err instanceof Error ? err.message : "AI service call failed"}`);
        res.status(500).json({
          error: err instanceof Error ? err.message : "AI service call failed",
          _debug: extractAiErrorDebug(err),
        });
        return;
      }
      continue;
    }

    lastDebug = debug;

    // ── Zod schema validation ────────────────────────────────────────────────

    const analysisDuration = Date.now() - startTime;
    const parsed = RunCompanyAnalysisResponse.safeParse({
      ...(result as Record<string, unknown>),
      timestamp: nowIso,
      analysisDuration,
    });

    if (!parsed.success) {
      const zodSummary = parsed.error.errors
        .map(e => `${e.path.join(".") || "(root)"}: ${e.message}`)
        .join("\n");
      lastZodErrors = zodSummary;
      lastConsistencyError = null; // clear so the next prompt targets the Zod issue
      if (attempt < MAX_ATTEMPTS) {
        req.log.warn({ errors: zodSummary, attempt }, "Invalid AI response schema — retrying with schema errors in prompt");
        continue;
      }
      req.log.error({ errors: zodSummary }, "Invalid AI response schema after all attempts");
      res.status(500).json({
        error: "AI returned an invalid response structure",
        schemaErrors: parsed.error.errors.map(e => ({
          field: e.path.join(".") || "(root)",
          message: e.message,
        })),
        attempt,
        _debug: lastDebug,
      });
      return;
    }

    // ── Identity verification ────────────────────────────────────────────────

    const returnedTicker = parsed.data.company.ticker.toUpperCase().trim();
    if (returnedTicker !== ticker) {
      req.log.warn({ requestedTicker: ticker, returnedTicker }, "AI returned analysis for wrong ticker — rejecting");
      if (attempt < MAX_ATTEMPTS) { req.log.info("Retrying after wrong-ticker response"); continue; }
      res.status(500).json({
        error: `AI returned an analysis for ${returnedTicker} instead of ${ticker}. Please try again.`,
        _debug: lastDebug,
      });
      return;
    }

    if (companyName) {
      const returnedName = parsed.data.company.name.toLowerCase();
      const requestedWords = companyName.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const nameMatches = requestedWords.length === 0 || requestedWords.some(w => returnedName.includes(w));
      if (!nameMatches) {
        req.log.warn({ requestedName: companyName, returnedName }, "AI returned analysis for a different company name — rejecting");
        if (attempt < MAX_ATTEMPTS) { req.log.info("Retrying after wrong-company-name response"); continue; }
        res.status(500).json({
          error: `AI returned an analysis for "${parsed.data.company.name}" instead of "${companyName}". Please verify the ticker and company name.`,
          _debug: lastDebug,
        });
        return;
      }
    }

    // ── Consistency validation ───────────────────────────────────────────────

    const consistencyError = validateConsistency(parsed.data, prevAnalysis, isFirstRun);
    if (consistencyError) {
      lastConsistencyError = consistencyError;
      req.log.warn({ consistencyError, attempt }, "Consistency validation failed");
      if (attempt < MAX_ATTEMPTS) {
        req.log.info({ attempt }, "Retrying after consistency failure — injecting error into next prompt");
        continue;
      }
      req.log.error({ consistencyError }, "Consistency validation failed after all attempts");
      systemLog.logError("Company Monitor", `Analysis for ${ticker} rejected after ${attempt} attempts: ${consistencyError}`);
      res.status(500).json({
        error: "Company Monitor consistency validation failed",
        validationError: consistencyError,
        attempt,
        _debug: lastDebug,
      });
      return;
    }

    // ── Server-side processing ───────────────────────────────────────────────

    const dateWarnings: string[] = [];
    let finalData = validateAndFixDates(parsed.data, nowIso, dateWarnings);
    if (dateWarnings.length > 0) {
      req.log.warn({ dateWarnings }, "Date fields corrected");
    }

    if (finalData.updateType === 'NoMaterialChange' && prevAnalysis) {
      finalData = mergeNoMaterialChange(finalData, prevAnalysis);
      req.log.info({ ticker }, "Applied NoMaterialChange merge — stable fields preserved from previous analysis");
    } else if (finalData.updateType === 'UpdateWithChanges' && prevAnalysis) {
      const prevThesis = (prevAnalysis.investmentThesis as Array<{ id: string; point: string; status: string }> | undefined) ?? [];
      finalData = {
        ...finalData,
        investmentThesis: applyThesisUpdate(finalData.investmentThesis, prevThesis),
      };
      req.log.info({ ticker }, "Applied thesis ID preservation for UpdateWithChanges");
    }

    // ── Compute orchestration metadata ───────────────────────────────────────

    const meaningfulChange = computeMeaningfulChange(finalData, prevAnalysis);
    const withMeta: ParsedAnalysis & { meaningfulChange: MeaningfulChange; affectedTickers: string[] } = {
      ...finalData,
      meaningfulChange,
      affectedTickers: [ticker],
    };

    // ── Persist ──────────────────────────────────────────────────────────────

    analysisRepository.save(repositoryKey, withMeta);
    appendToHistory(ticker, finalData, meaningfulChange);

    const updateTypeLabel = finalData.updateType;
    const strengthLabel = finalData.investmentCaseStrength !== undefined
      ? `, strength ${finalData.investmentCaseStrength}`
      : "";
    systemLog.logInfo(
      "Company Monitor",
      `Company analysis completed for ${ticker}: ${updateTypeLabel}, rating ${finalData.investmentView.rating}${strengthLabel}, meaningfulChange=${meaningfulChange}`
    );

    res.json({ ...withMeta, _debug: debug });
    return;
  }
});

export default router;
