/**
 * Investor Watch Route
 *
 * A stateful informational module that tracks what a curated group of notable
 * investors currently appear to think, say, and do. It is intentionally
 * ISOLATED from the investment decision pipeline — its output must never
 * feed into Trade Decision, Risk Analyzer, Portfolio Analyzer, or any other
 * decision-making module.
 *
 * Stateful behaviour (similar to Company Monitor):
 *  - First run: FullAnalysis
 *  - Later runs: compares against previous analysis; may return
 *    FullAnalysis | MaterialUpdate | NoMaterialChange
 *
 * Repository keys:
 *   investor-watch              — array of all investor results (latest per person)
 *   investor-watch-history      — compact history per person (last 20 material snapshots)
 *
 * Routes:
 *   POST /investor-watch/analyze        — analyze one or all investors
 *   GET  /investor-watch/config         — return investor config list
 *   DELETE /investor-watch/reset        — clear all investor-watch data
 */

import { Router, type IRouter } from "express";
import { systemLog } from "../lib/system-log.js";
import { callAiWithWebSearch, extractAiErrorDebug, type AiDebugInfo } from "../lib/ai-service";
import { analysisRepository } from "../lib/analysis-repository";
import {
  INVESTOR_WATCH_CONFIG,
  getEnabledInvestors,
  getInvestorById,
  type InvestorConfig,
} from "../lib/investor-watch-config";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UpdateType = "FullAnalysis" | "MaterialUpdate" | "NoMaterialChange";
type OverallTone = "Bullish" | "Cautious" | "Bearish" | "Mixed" | "Unclear";
type EvidenceType = "Direct" | "Filing" | "ReliableReporting" | "Interpretation";
type Confidence = "High" | "Medium" | "Low";
type Consistency = "Consistent" | "PartlyConsistent" | "Conflicting" | "InsufficientEvidence";
type ChangeSeverity = "None" | "Low" | "Medium" | "High";

interface InvestorResult {
  person: {
    id: string;
    name: string;
    organization: string;
    focusLabel: string;
  };
  updateType: UpdateType;
  headline: string;
  shortSummary: string;
  currentView: {
    overallTone: OverallTone;
    summary: string;
    confidence: Confidence;
  };
  keyThemes: Array<{
    title: string;
    stance: string;
    summary: string;
  }>;
  latestDevelopments: Array<{
    title: string;
    date: string;
    summary: string;
    evidenceType: EvidenceType;
    confidence: Confidence;
    sourceName: string;
    sourceUrl?: string;
  }>;
  positioning: {
    summary: string;
    filingDate: string;
    reportingPeriod: string;
    isDelayedData: boolean;
    notableChanges: Array<{
      asset: string;
      action: "Increased" | "Reduced" | "New" | "Exited" | "Unknown";
      summary: string;
    }>;
  };
  sayVsDo: {
    statementsSummary: string;
    positioningSummary: string;
    consistency: Consistency;
    explanation: string;
  };
  changeSincePrevious: {
    changed: boolean;
    severity: ChangeSeverity;
    summary: string;
  };
  thingsToWatch: string[];
  lastCheckedAt: string;
  lastMaterialUpdateAt: string;
  analysisDuration?: number;
  _debug?: AiDebugInfo;
}

interface HistoryEntry {
  timestamp: string;
  investorId: string;
  updateType: UpdateType;
  overallTone: OverallTone;
  headline: string;
  changeSeverity: ChangeSeverity;
  keyThemeTitles: string[];
  notablePositioningChanges: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 2;
const HISTORY_MAX = 20;
const REPO_KEY = "investor-watch";
const REPO_HISTORY_KEY = "investor-watch-history";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return `You are an investment intelligence analyst specialising in tracking notable investors.

Your task is to find and synthesise the most recent, verifiable information about what a specific investor currently thinks, says, or does. You are NOT writing a biography.

FOCUS ON:
- Recent opinions, interviews, public statements from the last 3-6 months
- Investor letters or memos
- Regulatory filings (13F, SEC filings)
- Portfolio disclosures and major disclosed position changes
- Macro and sector views
- Bearish/bullish themes
- Material changes since any previous analysis provided

SOURCE DISCIPLINE — classify every important item by evidenceType:
- Direct: official investor letter, memo, regulatory filing, direct interview, verified social-media statement, official fund communication
- Filing: 13F or other regulatory filing (always note the filing date and reporting period; filings are delayed)
- ReliableReporting: Reuters, Bloomberg, Financial Times, Wall Street Journal, CNBC when directly reporting the investor's statement
- Interpretation: OpenAI infers the investor's likely view from filings, portfolio changes, or multiple pieces of evidence

CRITICAL RULES:
- Never present Interpretation as a direct quote or confirmed opinion
- Never fabricate quotes, statistics, or positions
- Always show filing dates and reporting periods — filings are delayed and may not represent the current portfolio
- Do not assume a filing proves the investor's exact opinion
- For NoMaterialChange: preserve the previous view summary, update lastCheckedAt, do not invent new information

SAYS VS DOES:
Where relevant, explicitly separate what the investor says/thinks from what their disclosed positioning shows.

OUTPUT FORMAT:
Return a single JSON object matching this exact structure. No markdown. No prose outside the JSON.

{
  "updateType": "FullAnalysis|MaterialUpdate|NoMaterialChange",
  "headline": "Very short description of the latest important point (≤15 words)",
  "shortSummary": "1-2 sentences maximum",
  "currentView": {
    "overallTone": "Bullish|Cautious|Bearish|Mixed|Unclear",
    "summary": "2-3 sentence view summary",
    "confidence": "High|Medium|Low"
  },
  "keyThemes": [
    { "title": "...", "stance": "Bullish|Bearish|Cautious|Neutral|Unclear", "summary": "..." }
  ],
  "latestDevelopments": [
    {
      "title": "...",
      "date": "YYYY-MM-DD or approximate month",
      "summary": "...",
      "evidenceType": "Direct|Filing|ReliableReporting|Interpretation",
      "confidence": "High|Medium|Low",
      "sourceName": "...",
      "sourceUrl": "https://... or empty string"
    }
  ],
  "positioning": {
    "summary": "...",
    "filingDate": "YYYY-MM-DD or empty string",
    "reportingPeriod": "e.g. Q1 2025 or empty string",
    "isDelayedData": true,
    "notableChanges": [
      { "asset": "...", "action": "Increased|Reduced|New|Exited|Unknown", "summary": "..." }
    ]
  },
  "sayVsDo": {
    "statementsSummary": "...",
    "positioningSummary": "...",
    "consistency": "Consistent|PartlyConsistent|Conflicting|InsufficientEvidence",
    "explanation": "..."
  },
  "changeSincePrevious": {
    "changed": true,
    "severity": "None|Low|Medium|High",
    "summary": "..."
  },
  "thingsToWatch": ["...", "..."],
  "lastCheckedAt": "ISO timestamp",
  "lastMaterialUpdateAt": "ISO timestamp"
}`;
}

function buildUserPrompt(
  investor: InvestorConfig,
  nowIso: string,
  previousSummary: string | null
): string {
  const blocks: string[] = [`UTC: ${nowIso}`, ""];

  blocks.push(`INVESTOR: ${investor.name} (${investor.organization})`);
  blocks.push(`FOCUS: ${investor.focusLabel}`);
  blocks.push("");

  blocks.push("ANALYSIS PRIORITIES FOR THIS INVESTOR:");
  investor.analysisPriorities.forEach(p => blocks.push(`- ${p}`));
  blocks.push("");

  if (previousSummary) {
    blocks.push("PREVIOUS ANALYSIS (your own prior work on this investor):");
    blocks.push(previousSummary);
    blocks.push("");
    blocks.push("INSTRUCTIONS:");
    blocks.push(
      "Search the web for material developments since the previous analysis above.",
      "Ask yourself: What has changed? Is the investor's view materially different?",
      "Has a major theme strengthened or weakened? Is there new positioning evidence?",
      "",
      "If nothing meaningful has changed, set updateType='NoMaterialChange'.",
      "In that case: preserve the previous currentView summary, update lastCheckedAt,",
      "and do not fabricate new information.",
      "",
      "If something material has changed, set updateType='MaterialUpdate'.",
      "changeSincePrevious.changed must be true and severity must reflect the degree of change."
    );
  } else {
    blocks.push("INSTRUCTIONS:");
    blocks.push(
      `Perform a full analysis of what ${investor.name} currently thinks and does.`,
      "",
      "Search for: recent public statements, interviews, investor letters, regulatory filings,",
      "major disclosed portfolio changes, macro and sector views, bearish/bullish themes.",
      "",
      "This is a first-time analysis — set updateType='FullAnalysis'.",
      "changeSincePrevious.changed=false, severity='None', summary='First analysis'."
    );
  }

  return blocks.join("\n");
}

function buildPreviousSummary(prev: InvestorResult): string {
  const lines: string[] = [];
  lines.push(`updateType: ${prev.updateType}`);
  lines.push(`headline: ${prev.headline}`);
  lines.push(`shortSummary: ${prev.shortSummary}`);
  lines.push(`currentView.overallTone: ${prev.currentView.overallTone}`);
  lines.push(`currentView.summary: ${prev.currentView.summary}`);
  lines.push(`currentView.confidence: ${prev.currentView.confidence}`);
  if (prev.keyThemes?.length) {
    lines.push("keyThemes:");
    prev.keyThemes.forEach(t => lines.push(`  - ${t.title} (${t.stance}): ${t.summary}`));
  }
  if (prev.latestDevelopments?.length) {
    lines.push("latestDevelopments (most recent):");
    prev.latestDevelopments.slice(0, 3).forEach(d =>
      lines.push(`  - [${d.date}] ${d.title} (${d.evidenceType}, ${d.confidence}): ${d.summary}`)
    );
  }
  if (prev.positioning?.summary) {
    lines.push(`positioning: ${prev.positioning.summary}`);
    if (prev.positioning.filingDate) {
      lines.push(`positioning.filingDate: ${prev.positioning.filingDate} (period: ${prev.positioning.reportingPeriod})`);
    }
  }
  lines.push(`lastCheckedAt: ${prev.lastCheckedAt}`);
  lines.push(`lastMaterialUpdateAt: ${prev.lastMaterialUpdateAt}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Repository helpers
// ---------------------------------------------------------------------------

type InvestorStore = Record<string, InvestorResult>;
type HistoryStore = Record<string, HistoryEntry[]>;

function loadStore(): InvestorStore {
  const entry = analysisRepository.get<InvestorStore>(REPO_KEY);
  return (entry?.result as InvestorStore) ?? {};
}

function saveStore(store: InvestorStore): void {
  analysisRepository.save(REPO_KEY, store);
}

function loadHistory(): HistoryStore {
  const entry = analysisRepository.get<HistoryStore>(REPO_HISTORY_KEY);
  return (entry?.result as HistoryStore) ?? {};
}

function appendHistory(
  investorId: string,
  result: InvestorResult
): void {
  const store = loadHistory();
  const prev = store[investorId] ?? [];
  const entry: HistoryEntry = {
    timestamp: result.lastCheckedAt,
    investorId,
    updateType: result.updateType,
    overallTone: result.currentView.overallTone,
    headline: result.headline,
    changeSeverity: result.changeSincePrevious.severity,
    keyThemeTitles: result.keyThemes.map(t => t.title),
    notablePositioningChanges: result.positioning.notableChanges.map(c => `${c.action} ${c.asset}`),
  };
  store[investorId] = [entry, ...prev].slice(0, HISTORY_MAX);
  analysisRepository.save(REPO_HISTORY_KEY, store);
}

// ---------------------------------------------------------------------------
// Analysis runner (single investor)
// ---------------------------------------------------------------------------

async function analyzeInvestor(
  investor: InvestorConfig,
  isOrchestratorTrigger: boolean
): Promise<InvestorResult> {
  const startTime = Date.now();
  const nowIso = new Date().toISOString();

  if (!isOrchestratorTrigger) {
    systemLog.logUser("Investor Watch", `User manually started analysis for ${investor.name}`);
  }

  const store = loadStore();
  const prevResult = store[investor.id] as InvestorResult | undefined;
  const previousSummary = prevResult ? buildPreviousSummary(prevResult) : null;
  const isFirstRun = !prevResult;

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(investor, nowIso, previousSummary);

  let lastDebug: AiDebugInfo | undefined;
  let lastZodErrors: string | null = null;
  let lastRawResponse: string | null = null;
  const JSON_ONLY_REMINDER = "Your entire response must begin with { and end with }. Do not add markdown fences or prose outside the JSON.";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let effectiveUserPrompt = userPrompt;
    if (attempt > 1 && lastZodErrors) {
      effectiveUserPrompt = [
        "The previous JSON response failed validation.",
        "Errors:", lastZodErrors,
        ...(lastRawResponse ? ["Invalid response received:", lastRawResponse, ""] : []),
        "Return the complete corrected JSON object.",
        JSON_ONLY_REMINDER,
        "---",
        userPrompt,
      ].join("\n");
    }

    let raw: unknown;
    let debug: AiDebugInfo;

    try {
      ({ result: raw, debug } = await callAiWithWebSearch<unknown>(
        systemPrompt,
        effectiveUserPrompt,
        { model: "gpt-4o", maxTokens: 2200, temperature: 0.1 }
      ));
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        systemLog.logError("Investor Watch", `Analysis failed for ${investor.name}: ${err instanceof Error ? err.message : "AI service call failed"}`);
        throw err;
      }
      continue;
    }

    lastDebug = debug;
    lastRawResponse = debug.rawResponse ?? null;

    // Basic validation
    if (!raw || typeof raw !== "object") {
      lastZodErrors = "Response was not a JSON object";
      continue;
    }

    const parsed = raw as Record<string, unknown>;

    // Validate required fields
    const missing: string[] = [];
    if (!parsed.updateType) missing.push("updateType");
    if (!parsed.headline) missing.push("headline");
    if (!parsed.currentView) missing.push("currentView");
    if (missing.length > 0) {
      lastZodErrors = `Missing required fields: ${missing.join(", ")}`;
      continue;
    }

    // For NoMaterialChange, preserve previous view if available
    if (parsed.updateType === "NoMaterialChange" && prevResult) {
      parsed.currentView = prevResult.currentView;
      parsed.keyThemes = prevResult.keyThemes;
      parsed.positioning = prevResult.positioning;
      parsed.sayVsDo = prevResult.sayVsDo;
      parsed.thingsToWatch = prevResult.thingsToWatch;
      // Preserve lastMaterialUpdateAt from previous
      parsed.lastMaterialUpdateAt = prevResult.lastMaterialUpdateAt;
    }

    // Server-set fields (never trusted from AI)
    parsed.lastCheckedAt = nowIso;
    if (parsed.updateType !== "NoMaterialChange" || !prevResult?.lastMaterialUpdateAt) {
      if (parsed.updateType !== "NoMaterialChange") {
        parsed.lastMaterialUpdateAt = nowIso;
      } else if (!parsed.lastMaterialUpdateAt) {
        parsed.lastMaterialUpdateAt = nowIso;
      }
    }

    // Ensure person block uses config values (not AI-generated)
    parsed.person = {
      id: investor.id,
      name: investor.name,
      organization: investor.organization,
      focusLabel: investor.focusLabel,
    };

    const analysisDuration = Date.now() - startTime;
    parsed.analysisDuration = analysisDuration;
    parsed._debug = lastDebug;

    const result = parsed as unknown as InvestorResult;

    // Save to store
    store[investor.id] = result;
    saveStore(store);

    // Append history for non-NoMaterialChange or first run
    if (parsed.updateType !== "NoMaterialChange" || isFirstRun) {
      appendHistory(investor.id, result);
    }

    // Log outcome
    if (parsed.updateType === "NoMaterialChange") {
      systemLog.logInfo("Investor Watch", `Updated — ${investor.name} — no material change.`);
    } else {
      systemLog.logInfo("Investor Watch", `${investor.name} — new material view detected. (${(parsed.changeSincePrevious as any)?.severity ?? "unknown"} change)`);
    }

    return result;
  }

  systemLog.logError("Investor Watch", `Analysis failed — ${investor.name}.`);
  throw new Error(`Failed to analyze ${investor.name} after ${MAX_ATTEMPTS} attempts`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /investor-watch/config
 * Returns the investor config list (id, name, organization, focusLabel, enabled, displayOrder).
 */
router.get("/investor-watch/config", (_req, res): void => {
  res.json({ investors: INVESTOR_WATCH_CONFIG });
});

/**
 * GET /investor-watch/results
 * Returns the latest result store for all investors.
 */
router.get("/investor-watch/results", (_req, res): void => {
  const store = loadStore();
  res.json({ results: store });
});

/**
 * GET /investor-watch/history
 * Returns compact history per investor.
 */
router.get("/investor-watch/history", (_req, res): void => {
  const history = loadHistory();
  res.json({ history });
});

/**
 * POST /investor-watch/analyze
 * Body: { investorId?: string }
 * If investorId is omitted, analyzes all enabled investors sequentially.
 * If investorId is provided, analyzes only that investor.
 */
router.post("/investor-watch/analyze", async (req, res): Promise<void> => {
  const { investorId } = req.body as { investorId?: string };
  const isOrchestratorTrigger = !!req.headers["x-orchestrator-trigger"];

  if (isOrchestratorTrigger) {
    systemLog.logInfo("Investor Watch", `Scheduled run (trigger: ${req.headers["x-orchestrator-trigger"]})`);
  }

  // Single investor
  if (investorId) {
    const investor = getInvestorById(investorId);
    if (!investor) {
      res.status(400).json({ error: `Unknown investor id: ${investorId}` });
      return;
    }
    if (!investor.enabled) {
      res.status(400).json({ error: `Investor ${investorId} is disabled` });
      return;
    }

    try {
      const result = await analyzeInvestor(investor, isOrchestratorTrigger);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Analysis failed",
        errorStage: "ai-call",
        _debug: extractAiErrorDebug(err),
      });
    }
    return;
  }

  // All enabled investors (sequentially to avoid OpenAI rate limits)
  const investors = getEnabledInvestors();
  const results: Array<{ investorId: string; ok: boolean; error?: string }> = [];

  for (const investor of investors) {
    try {
      await analyzeInvestor(investor, isOrchestratorTrigger);
      results.push({ investorId: investor.id, ok: true });
    } catch (err) {
      results.push({
        investorId: investor.id,
        ok: false,
        error: err instanceof Error ? err.message : "Analysis failed",
      });
    }
  }

  const allOk = results.every(r => r.ok);
  res.status(allOk ? 200 : 207).json({ ok: allOk, results });
});

/**
 * DELETE /investor-watch/reset
 * Clears all investor-watch data from the repository.
 */
router.delete("/investor-watch/reset", (_req, res): void => {
  analysisRepository.deleteByPrefix(REPO_KEY);
  systemLog.logInfo("Investor Watch", "All investor data reset.");
  res.json({ ok: true });
});

export default router;
