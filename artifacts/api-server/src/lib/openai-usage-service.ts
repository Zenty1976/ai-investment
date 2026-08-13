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
import { estimateCostUsd, MODEL_PRICING } from "./ai-model-pricing.js";

// Re-export so existing callers can import from openai-usage-service without change.
export { estimateCostUsd, MODEL_PRICING };
export type { ModelPricing } from "./ai-model-pricing.js";

// ── Record types ──────────────────────────────────────────────────────────────

export interface OpenAIUsageRecord {
  /** Sequential ID (monotonically increasing within the process lifetime). */
  id: number;
  timestamp: string;
  /** Module name, e.g. "market-monitor", "company-monitor", "investor-watch". */
  module: string;
  /** Operation label, e.g. "analyze", "discovery", "repair-retry". */
  operation: string;
  /** OpenAI model identifier, e.g. "gpt-4.1", "gpt-4.1-mini", "gpt-4o-mini". */
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Tokens served from the prompt cache. 0 when not reported by the API. */
  cachedTokens: number;
  /**
   * Internal reasoning tokens used by the model (o-series models only).
   * 0 for gpt-4.1 family — tracked for future o-series compatibility.
   * When non-zero, these are a subset of completionTokens reported by the API
   * (for o-series, completionTokens = visibleOutput + reasoningTokens).
   */
  reasoningTokens: number;
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
  reason: "fingerprint_unchanged" | "age_within_limit" | "recent_run";
  /** Only present for recent_run skips — how old the last run was in minutes. */
  ageSinceLastRunMin?: number;
  /** Only present for recent_run skips — the configured minimum refresh age. */
  minimumRefreshAgeMin?: number;
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
    ? estimateCostUsd(
        record.model,
        record.promptTokens,
        record.completionTokens,
        record.cachedTokens,
        record.reasoningTokens ?? 0
      )
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

/** Record a SKIPPED_RECENT skip — external observation module ran too recently to repeat. */
export function trackRecentRunSkip(
  module: string,
  ageSinceLastRunMin: number,
  minimumRefreshAgeMin: number
): void {
  const id = ++_store.lastId;
  _store.skips.push({ id, timestamp: new Date().toISOString(), module, reason: "recent_run", ageSinceLastRunMin, minimumRefreshAgeMin });
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
  /** Internal reasoning tokens (o-series only; 0 for gpt-4.1 family). */
  reasoningTokens: number;
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
  /** Internal reasoning tokens summed across all calls (o-series only; 0 for gpt-4.1 family). */
  reasoningTokens: number;
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
        reasoningTokens: 0,
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
    m.reasoningTokens  += r.reasoningTokens ?? 0;
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
  const promptTokens     = records.reduce((s, r) => s + r.promptTokens,               0);
  const completionTokens = records.reduce((s, r) => s + r.completionTokens,           0);
  const totalTokens      = records.reduce((s, r) => s + r.totalTokens,                0);
  const cachedTokens     = records.reduce((s, r) => s + r.cachedTokens,               0);
  const reasoningTokens  = records.reduce((s, r) => s + (r.reasoningTokens ?? 0),     0);
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
    reasoningTokens,
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
