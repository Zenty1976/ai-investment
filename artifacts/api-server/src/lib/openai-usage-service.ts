/**
 * Central OpenAI usage tracking service.
 *
 * Records every OpenAI API call (including retries as separate records),
 * skipped calls, aggregated stats by module and time window, and estimated cost.
 *
 * All cost labels must be shown as "Estimated" in the UI — pricing may be stale.
 *
 * Persists to data/openai-usage-log.json alongside the analysis repository.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger.js";

// ── Centralized model pricing ─────────────────────────────────────────────────
// USD per 1 million tokens. Update here when OpenAI changes rates.
// Source: openai.com/pricing

export interface ModelPricing {
  /** USD per 1M input tokens */
  inputPer1M: number;
  /** USD per 1M output tokens */
  outputPer1M: number;
  /** USD per 1M cached input tokens (prompt cache hit). Defaults to inputPer1M if absent. */
  cachedInputPer1M?: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-4o":                    { inputPer1M: 2.50,  outputPer1M: 10.00, cachedInputPer1M: 1.25 },
  "gpt-4o-mini":               { inputPer1M: 0.15,  outputPer1M: 0.60,  cachedInputPer1M: 0.075 },
  "gpt-4o-2024-08-06":         { inputPer1M: 2.50,  outputPer1M: 10.00, cachedInputPer1M: 1.25 },
  "gpt-4o-mini-2024-07-18":    { inputPer1M: 0.15,  outputPer1M: 0.60,  cachedInputPer1M: 0.075 },
  "gpt-4.1":                   { inputPer1M: 2.00,  outputPer1M: 8.00,  cachedInputPer1M: 0.50 },
  "gpt-4.1-mini":              { inputPer1M: 0.40,  outputPer1M: 1.60,  cachedInputPer1M: 0.10 },
};

/** Estimate cost in USD for a single API call. Returns null if model pricing is unknown. */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0
): number | null {
  const p = MODEL_PRICING[model];
  if (!p) return null;
  const uncachedInput = Math.max(0, promptTokens - cachedTokens);
  const cachedCost = (cachedTokens / 1_000_000) * (p.cachedInputPer1M ?? p.inputPer1M);
  const inputCost  = (uncachedInput  / 1_000_000) * p.inputPer1M;
  const outputCost = (completionTokens / 1_000_000) * p.outputPer1M;
  return inputCost + cachedCost + outputCost;
}

// ── Record types ──────────────────────────────────────────────────────────────

export interface OpenAIUsageRecord {
  /** Sequential ID (monotonically increasing within the process lifetime). */
  id: number;
  timestamp: string;
  /** Module name, e.g. "market-monitor", "company-monitor", "investor-watch". */
  module: string;
  /** Operation label, e.g. "analyze", "discovery", "repair-retry". */
  operation: string;
  /** OpenAI model identifier, e.g. "gpt-4o", "gpt-4o-mini". */
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Tokens served from the prompt cache. 0 when not reported by the API. */
  cachedTokens: number;
  /** True when the Responses API web_search tool was used. */
  webSearchUsed: boolean;
  /** 1 = first attempt, 2+ = retry call. Each retry is a separate record. */
  retryNumber: number;
  success: boolean;
  /** Wall-clock duration of the API call in milliseconds. */
  durationMs: number;
  /** Estimated USD cost. null when model pricing is unknown or call failed. */
  estimatedCostUsd: number | null;
}

export interface OpenAISkipRecord {
  id: number;
  timestamp: string;
  /** Module whose AI call was skipped. */
  module: string;
  /** Why the call was skipped. */
  reason: "fingerprint_unchanged" | "age_within_limit";
}

// ── Persistent store ──────────────────────────────────────────────────────────

const DATA_FILE = resolve("data/openai-usage-log.json");
const MAX_API_RECORDS  = 15_000;
const MAX_SKIP_RECORDS = 15_000;

interface PersistedStore {
  records: OpenAIUsageRecord[];
  skips: OpenAISkipRecord[];
  lastId: number;
}

let _store: PersistedStore = { records: [], skips: [], lastId: 0 };
let _dirty = false;

function persistDebounced(): void {
  if (_dirty) return;
  _dirty = true;
  // Write after current micro-task batch to avoid one write per token
  setImmediate(() => {
    try {
      writeFileSync(DATA_FILE, JSON.stringify(_store), "utf-8");
    } catch (err) {
      logger.warn({ err }, "[openai-usage] Failed to persist usage log");
    }
    _dirty = false;
  });
}

export function initUsageLog(): void {
  try {
    const raw = readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PersistedStore>;
    _store.records = Array.isArray(parsed.records) ? parsed.records : [];
    _store.skips   = Array.isArray(parsed.skips)   ? parsed.skips   : [];
    _store.lastId  = typeof parsed.lastId === "number" ? parsed.lastId : 0;
    logger.info(
      { apiRecords: _store.records.length, skipRecords: _store.skips.length },
      "[openai-usage] Loaded usage log from disk"
    );
  } catch {
    _store = { records: [], skips: [], lastId: 0 };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Record one OpenAI API call (success or failure). Call once per callAi/callAiWithWebSearch invocation. */
export function trackUsage(record: Omit<OpenAIUsageRecord, "id" | "estimatedCostUsd">): void {
  const id = ++_store.lastId;
  const estimatedCostUsd = record.success
    ? estimateCostUsd(record.model, record.promptTokens, record.completionTokens, record.cachedTokens)
    : null;
  _store.records.push({ ...record, id, estimatedCostUsd });
  if (_store.records.length > MAX_API_RECORDS) {
    _store.records = _store.records.slice(-MAX_API_RECORDS);
  }
  persistDebounced();
}

/** Record a skipped AI call (change-aware skip or age-within-limit skip). */
export function trackSkipped(
  module: string,
  reason: OpenAISkipRecord["reason"] = "fingerprint_unchanged"
): void {
  const id = ++_store.lastId;
  _store.skips.push({ id, timestamp: new Date().toISOString(), module, reason });
  if (_store.skips.length > MAX_SKIP_RECORDS) {
    _store.skips = _store.skips.slice(-MAX_SKIP_RECORDS);
  }
  persistDebounced();
}

// ── Aggregation ────────────────────────────────────────────────────────────────

export type TimeWindow = "today" | "24h" | "7d" | "30d";

function windowStartMs(window: TimeWindow): number {
  const now = Date.now();
  switch (window) {
    case "today": {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    }
    case "24h": return now - 24 * 3_600_000;
    case "7d":  return now - 7  * 86_400_000;
    case "30d": return now - 30 * 86_400_000;
  }
}

export interface ModuleStats {
  module: string;
  calls: number;
  successCalls: number;
  failedCalls: number;
  retries: number;
  webSearches: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number | null;
  /** Average prompt tokens across successful calls. null if no successful calls. */
  avgPromptTokens: number | null;
  /** Average completion tokens across successful calls. null if no successful calls. */
  avgCompletionTokens: number | null;
  skippedCalls: number;
}

export interface UsageStats {
  window: TimeWindow;
  windowStart: string;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  retries: number;
  webSearches: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  /** null when no calls have known pricing. */
  estimatedCostUsd: number | null;
  skippedCalls: number;
  /** All modules sorted by total tokens descending. */
  byModule: ModuleStats[];
  /** Top 8 modules by total tokens — convenience slice for the dashboard. */
  topModulesByTokens: Array<{
    module: string;
    totalTokens: number;
    estimatedCostUsd: number | null;
  }>;
}

export function getStats(window: TimeWindow = "today"): UsageStats {
  const sinceMs = windowStartMs(window);

  const records = _store.records.filter(r => new Date(r.timestamp).getTime() >= sinceMs);
  const skips   = _store.skips.filter(  r => new Date(r.timestamp).getTime() >= sinceMs);

  // ── Per-module aggregation ────────────────────────────────────────────────
  const moduleMap = new Map<string, ModuleStats>();

  const ensureModule = (module: string): ModuleStats => {
    if (!moduleMap.has(module)) {
      moduleMap.set(module, {
        module,
        calls: 0, successCalls: 0, failedCalls: 0, retries: 0, webSearches: 0,
        promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0,
        estimatedCostUsd: null,
        avgPromptTokens: null, avgCompletionTokens: null,
        skippedCalls: 0,
      });
    }
    return moduleMap.get(module)!;
  };

  for (const r of records) {
    const m = ensureModule(r.module);
    m.calls++;
    if (r.success) m.successCalls++; else m.failedCalls++;
    if (r.retryNumber > 1) m.retries++;
    if (r.webSearchUsed) m.webSearches++;
    m.promptTokens     += r.promptTokens;
    m.completionTokens += r.completionTokens;
    m.totalTokens      += r.totalTokens;
    m.cachedTokens     += r.cachedTokens;
    if (r.estimatedCostUsd !== null) {
      m.estimatedCostUsd = (m.estimatedCostUsd ?? 0) + r.estimatedCostUsd;
    }
  }

  for (const s of skips) {
    ensureModule(s.module).skippedCalls++;
  }

  // Compute averages
  for (const m of moduleMap.values()) {
    if (m.successCalls > 0) {
      m.avgPromptTokens      = Math.round(m.promptTokens      / m.successCalls);
      m.avgCompletionTokens  = Math.round(m.completionTokens  / m.successCalls);
    }
  }

  const byModule = [...moduleMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);

  // ── Overall totals ────────────────────────────────────────────────────────
  const totalCalls       = records.length;
  const successCalls     = records.filter(r => r.success).length;
  const retries          = records.filter(r => r.retryNumber > 1).length;
  const webSearches      = records.filter(r => r.webSearchUsed).length;
  const promptTokens     = records.reduce((s, r) => s + r.promptTokens,     0);
  const completionTokens = records.reduce((s, r) => s + r.completionTokens, 0);
  const totalTokens      = records.reduce((s, r) => s + r.totalTokens,      0);
  const cachedTokens     = records.reduce((s, r) => s + r.cachedTokens,     0);
  const estimatedCostUsd = records.some(r => r.estimatedCostUsd !== null)
    ? records.reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0)
    : null;

  return {
    window,
    windowStart: new Date(sinceMs).toISOString(),
    totalCalls,
    successCalls,
    failedCalls: totalCalls - successCalls,
    retries,
    webSearches,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    estimatedCostUsd,
    skippedCalls: skips.length,
    byModule,
    topModulesByTokens: byModule.slice(0, 8).map(m => ({
      module: m.module,
      totalTokens: m.totalTokens,
      estimatedCostUsd: m.estimatedCostUsd,
    })),
  };
}
