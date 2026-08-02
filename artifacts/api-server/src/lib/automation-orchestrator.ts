/**
 * Automation Orchestrator
 *
 * Central scheduler, dependency manager and operational dashboard for all
 * analysis modules. Owns scheduling, sequencing, dependencies, retry
 * coordination and operational visibility.
 *
 * The orchestrator NEVER contains investment logic, never modifies module
 * results, and never approves or executes trades.
 *
 * Dispatch strategy: internal HTTP calls to the same Express server
 * (localhost:PORT). This reuses all existing module routes without
 * duplicating business logic.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { analysisRepository } from "./analysis-repository.js";
import { systemLog } from "./system-log.js";

// ── Data directory ───────────────────────────────────────────────────────────

const DATA_DIR = resolve(process.cwd(), "data");

function readJson<T>(file: string, fallback: T): T {
  try {
    const path = resolve(DATA_DIR, file);
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(resolve(DATA_DIR, file), JSON.stringify(data, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export type ModuleId =
  | "portfolio-manager" | "market-monitor" | "news-monitor" | "event-monitor"
  | "sector-monitor"   | "company-monitor" | "market-alerts" | "risk-analyzer"
  | "portfolio-analyzer" | "opportunity-finder" | "trade-decision-engine" | "trade-review";

export type AutomationMode = "Manual" | "SemiAutomatic" | "FullAutomatic";

export type ModuleTrigger =
  | "Manual" | "Scheduled" | "Dependency" | "EventPassed" | "ImportantAlert"
  | "PortfolioChanged" | "StaleData" | "StartupRecovery" | "RunAllNow";

export type JobStatus =
  | "Pending" | "Running" | "Completed" | "Failed" | "Cancelled" | "Skipped" | "WaitingForDependency";

export type ModuleFreshness =
  | "Fresh" | "DueSoon" | "Stale" | "Running" | "Failed" | "Disabled"
  | "WaitingForDependency" | "NeverRun";

export type ScheduleType = "fixed" | "trigger" | "after";

export interface ModuleDefaults {
  moduleId: ModuleId;
  displayName: string;
  scheduleType: ScheduleType;
  defaultIntervalMinutes: number;
  minimumIntervalMinutes: number;
  maximumIntervalMinutes: number;
  staleAfterMinutes: number;
  dependencies: ModuleId[];
  runAfter: ModuleId[];
  priority: number;
  supportsAutomaticRun: boolean;
  marketHoursOnly: boolean;
}

export interface ModuleSettings {
  enabled: boolean;
  supportsAutomaticRun: boolean;
  intervalMinutes: number;
  staleAfterMinutes: number;
  priority: number;
}

export interface ModuleRuntimeState {
  status: "Idle" | "Running" | "Failed" | "Disabled";
  lastRunAt: string | null;
  lastSuccessfulRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  currentJobId: string | null;
  waitingForDeps: ModuleId[];
}

export interface OrchestratorJob {
  id: string;
  correlationId: string;
  moduleId: ModuleId;
  ticker?: string;
  trigger: ModuleTrigger;
  status: JobStatus;
  priority: number;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  attempt: number;
  maxAttempts: number;
  error: string | null;
  affectedTickers: string[];
  parentJobId: string | null;
}

export interface OrchestratorSettings {
  mode: AutomationMode;
  paused: boolean;
  moduleOverrides: Record<string, Partial<ModuleSettings>>;
}

export interface OrchestratorModuleStatus {
  moduleId: ModuleId;
  displayName: string;
  freshness: ModuleFreshness;
  settings: ModuleSettings;
  defaults: Pick<ModuleDefaults, "scheduleType" | "minimumIntervalMinutes" | "maximumIntervalMinutes" | "dependencies" | "runAfter">;
  runtime: ModuleRuntimeState;
  lastUpdatedAt: string | null;
  nextRunAt: string | null;
}

export interface OrchestratorStats {
  running: number;
  stale: number;
  failed: number;
  analysesToday: number;
  failedToday: number;
  nextScheduledJobAt: string | null;
}

export interface OrchestratorStatus {
  mode: AutomationMode;
  paused: boolean;
  modules: OrchestratorModuleStatus[];
  jobs: OrchestratorJob[];
  stats: OrchestratorStats;
  lastFullCycleAt: string | null;
  cycleInProgress: boolean;
}

// ── Default registry ─────────────────────────────────────────────────────────

const MODULE_DEFAULTS: ModuleDefaults[] = [
  {
    moduleId: "portfolio-manager",
    displayName: "Portfolio Manager",
    scheduleType: "fixed",
    defaultIntervalMinutes: 60,
    minimumIntervalMinutes: 5,
    maximumIntervalMinutes: 480,
    staleAfterMinutes: 90,
    dependencies: [],
    runAfter: [],
    priority: 10,
    supportsAutomaticRun: true,
    marketHoursOnly: false,
  },
  {
    moduleId: "market-monitor",
    displayName: "Market Monitor",
    scheduleType: "fixed",
    defaultIntervalMinutes: 30,
    minimumIntervalMinutes: 10,
    maximumIntervalMinutes: 240,
    staleAfterMinutes: 60,
    dependencies: [],
    runAfter: [],
    priority: 20,
    supportsAutomaticRun: true,
    marketHoursOnly: false,
  },
  {
    moduleId: "news-monitor",
    displayName: "News Monitor",
    scheduleType: "fixed",
    defaultIntervalMinutes: 30,
    minimumIntervalMinutes: 10,
    maximumIntervalMinutes: 240,
    staleAfterMinutes: 45,
    dependencies: [],
    runAfter: [],
    priority: 20,
    supportsAutomaticRun: true,
    marketHoursOnly: false,
  },
  {
    moduleId: "event-monitor",
    displayName: "Event Monitor",
    scheduleType: "fixed",
    defaultIntervalMinutes: 180,
    minimumIntervalMinutes: 30,
    maximumIntervalMinutes: 720,
    staleAfterMinutes: 240,
    dependencies: [],
    runAfter: [],
    priority: 20,
    supportsAutomaticRun: true,
    marketHoursOnly: false,
  },
  {
    moduleId: "sector-monitor",
    displayName: "Sector Monitor",
    scheduleType: "fixed",
    defaultIntervalMinutes: 720,
    minimumIntervalMinutes: 60,
    maximumIntervalMinutes: 1440,
    staleAfterMinutes: 900,
    dependencies: ["market-monitor", "news-monitor"],
    runAfter: [],
    priority: 30,
    supportsAutomaticRun: true,
    marketHoursOnly: false,
  },
  {
    moduleId: "company-monitor",
    displayName: "Company Monitor",
    scheduleType: "trigger",
    defaultIntervalMinutes: 360,
    minimumIntervalMinutes: 30,
    maximumIntervalMinutes: 1440,
    staleAfterMinutes: 480,
    dependencies: [],
    runAfter: [],
    priority: 35,
    supportsAutomaticRun: true,
    marketHoursOnly: false,
  },
  {
    moduleId: "market-alerts",
    displayName: "Market Alerts",
    scheduleType: "fixed",
    defaultIntervalMinutes: 15,
    minimumIntervalMinutes: 5,
    maximumIntervalMinutes: 120,
    staleAfterMinutes: 20,
    // Needs portfolio + market/news/event context to generate meaningful alerts
    dependencies: ["portfolio-manager", "market-monitor", "news-monitor", "event-monitor"],
    runAfter: [],
    priority: 40,
    supportsAutomaticRun: true,
    marketHoursOnly: false,
  },
  {
    moduleId: "risk-analyzer",
    displayName: "Risk Analyzer",
    scheduleType: "fixed",
    defaultIntervalMinutes: 120,
    minimumIntervalMinutes: 30,
    maximumIntervalMinutes: 720,
    staleAfterMinutes: 180,
    // Needs portfolio, active alerts, and event/news context for risk assessment
    dependencies: ["portfolio-manager", "market-alerts", "event-monitor", "news-monitor"],
    runAfter: [],
    priority: 50,
    supportsAutomaticRun: true,
    marketHoursOnly: false,
  },
  {
    moduleId: "portfolio-analyzer",
    displayName: "Portfolio Analyzer",
    scheduleType: "fixed",
    defaultIntervalMinutes: 180,
    minimumIntervalMinutes: 30,
    maximumIntervalMinutes: 720,
    staleAfterMinutes: 240,
    // Needs portfolio snapshot and risk analysis
    dependencies: ["portfolio-manager", "risk-analyzer"],
    runAfter: [],
    priority: 60,
    supportsAutomaticRun: true,
    marketHoursOnly: false,
  },
  {
    moduleId: "opportunity-finder",
    displayName: "Opportunity Finder",
    scheduleType: "fixed",
    defaultIntervalMinutes: 720,
    minimumIntervalMinutes: 60,
    maximumIntervalMinutes: 1440,
    staleAfterMinutes: 900,
    // Needs the full market picture: portfolio, sector context, macro, news, events
    dependencies: ["portfolio-manager", "portfolio-analyzer", "sector-monitor", "market-monitor", "news-monitor", "event-monitor"],
    runAfter: [],
    priority: 70,
    supportsAutomaticRun: true,
    marketHoursOnly: false,
  },
  {
    moduleId: "trade-decision-engine",
    displayName: "Trade Decision Engine",
    scheduleType: "fixed",
    defaultIntervalMinutes: 120,
    minimumIntervalMinutes: 30,
    maximumIntervalMinutes: 720,
    staleAfterMinutes: 180,
    // Needs all analysis layers: portfolio, risk, analysis, alerts, opportunities, macro context
    dependencies: [
      "portfolio-manager", "risk-analyzer", "portfolio-analyzer",
      "market-alerts", "opportunity-finder", "event-monitor", "news-monitor",
    ],
    runAfter: [],
    priority: 80,
    supportsAutomaticRun: true,
    marketHoursOnly: false,
  },
  {
    moduleId: "trade-review",
    displayName: "Trade Review",
    scheduleType: "after",
    defaultIntervalMinutes: 120,
    minimumIntervalMinutes: 30,
    maximumIntervalMinutes: 720,
    staleAfterMinutes: 60,
    dependencies: ["trade-decision-engine"],
    runAfter: ["trade-decision-engine"],
    priority: 90,
    supportsAutomaticRun: true,
    marketHoursOnly: false,
  },
];

// ── Module HTTP endpoints ─────────────────────────────────────────────────────

const MODULE_ENDPOINTS: Record<ModuleId, { method: "POST" | "GET"; path: string }> = {
  "portfolio-manager":    { method: "POST", path: "/api/portfolio-manager/update" },
  "market-monitor":       { method: "POST", path: "/api/market-monitor/analyze" },
  "news-monitor":         { method: "POST", path: "/api/news-monitor/analyze" },
  "event-monitor":        { method: "POST", path: "/api/event-monitor/analyze" },
  "sector-monitor":       { method: "POST", path: "/api/sector-monitor/analyze" },
  "company-monitor":      { method: "POST", path: "/api/company-monitor/analyze" },
  "market-alerts":        { method: "POST", path: "/api/market-alerts/analyze" },
  "risk-analyzer":        { method: "POST", path: "/api/risk-analyzer/analyze" },
  "portfolio-analyzer":   { method: "POST", path: "/api/portfolio-analyzer/analyze" },
  "opportunity-finder":   { method: "POST", path: "/api/opportunity-finder/analyze" },
  "trade-decision-engine":{ method: "POST", path: "/api/trade-decision-engine/analyze" },
  // POST /generate forces fresh generation (bypasses cache); GET serves existing data.
  "trade-review":         { method: "POST", path: "/api/trade-review/generate" },
};

const MAX_JOBS = 100;
const SCHEDULER_INTERVAL_MS = 30_000;
const MODULE_NAME = "AutomationOrchestrator";

// ── Service ───────────────────────────────────────────────────────────────────

class AutomationOrchestratorService {
  private settings: OrchestratorSettings;
  private runtimeState: Map<ModuleId, ModuleRuntimeState> = new Map();
  private jobs: OrchestratorJob[] = [];
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private port = 8080;
  private lastFullCycleAt: string | null = null;
  private cycleInProgress = false;

  constructor() {
    this.settings = readJson<OrchestratorSettings>("automation-settings.json", {
      mode: "Manual",
      paused: false,
      moduleOverrides: {},
    });
    this.jobs = readJson<OrchestratorJob[]>("automation-jobs.json", []);
    const savedState = readJson<Record<string, ModuleRuntimeState>>("automation-state.json", {});

    for (const def of MODULE_DEFAULTS) {
      this.runtimeState.set(def.moduleId, savedState[def.moduleId] ?? {
        status: "Idle",
        lastRunAt: null,
        lastSuccessfulRunAt: null,
        nextRunAt: null,
        lastError: null,
        currentJobId: null,
        waitingForDeps: [],
      });
    }
  }

  // ── Startup ─────────────────────────────────────────────────────────────────

  start(port: number): void {
    this.port = port;
    this._recoverOnStartup();
    // If already in SemiAutomatic mode (persisted across restarts), ensure any
    // modules that never ran get a staggered initial schedule.
    if (this.settings.mode === "SemiAutomatic" && !this.settings.paused) {
      this._scheduleInitialRuns();
    }
    this.schedulerTimer = setInterval(() => this._tick(), SCHEDULER_INTERVAL_MS);
    // Run first tick soon after startup
    setTimeout(() => this._tick(), 5_000);
  }

  private _recoverOnStartup(): void {
    let recovered = 0;
    for (const job of this.jobs) {
      if (job.status === "Running" || job.status === "Pending") {
        job.status = "Failed";
        job.completedAt = new Date().toISOString();
        job.error = "Process restarted — job abandoned";
        recovered++;

        const st = this.runtimeState.get(job.moduleId);
        if (st && st.status === "Running") {
          st.status = "Failed";
          st.lastError = "Process restarted";
          st.currentJobId = null;
        }
      }
    }
    if (recovered > 0) {
      systemLog.logWarning(MODULE_NAME, `Startup: marked ${recovered} abandoned job(s) as failed`);
      this._persist();
    }

    // Recalculate nextRunAt for modules that have been run before
    for (const def of MODULE_DEFAULTS) {
      const st = this.runtimeState.get(def.moduleId)!;
      const settings = this._moduleSettings(def.moduleId);
      if (st.lastSuccessfulRunAt && !st.nextRunAt) {
        const nextMs = new Date(st.lastSuccessfulRunAt).getTime() + settings.intervalMinutes * 60_000;
        st.nextRunAt = new Date(Math.max(nextMs, Date.now() + 10_000)).toISOString();
      }
    }
    this._persistState();
  }

  // ── Mode & control ──────────────────────────────────────────────────────────

  getMode(): AutomationMode { return this.settings.mode; }
  isPaused(): boolean { return this.settings.paused; }

  setMode(mode: AutomationMode): void {
    if (mode === "FullAutomatic") {
      throw new Error("FullAutomatic is not available yet.");
    }
    const prev = this.settings.mode;
    this.settings.mode = mode;
    this._persistSettings();
    systemLog.logInfo(MODULE_NAME, `Automation mode changed: ${prev} → ${mode}`);
    // When switching to SemiAutomatic, stagger initial runs for unscheduled modules
    if (mode === "SemiAutomatic" && !this.settings.paused) {
      this._scheduleInitialRuns();
      setTimeout(() => this._tick(), 1_000);
    }
  }

  /**
   * For modules that have never been run (nextRunAt === null), assign staggered
   * initial run times so that activating SemiAutomatic mode does not flood all
   * modules at once. Modules are ordered by priority and staged 2 minutes apart
   * so the dependency graph can gate higher-priority completions naturally.
   */
  private _scheduleInitialRuns(): void {
    const now = Date.now();
    // Sort by priority ascending (lower value = higher priority = runs earlier)
    const sorted = [...MODULE_DEFAULTS].sort(
      (a, b) => this._moduleSettings(a.moduleId).priority - this._moduleSettings(b.moduleId).priority
    );
    let offsetMs = 5_000; // first module starts 5 s after activation
    for (const def of sorted) {
      const settings = this._moduleSettings(def.moduleId);
      if (!settings.enabled || !settings.supportsAutomaticRun) continue;
      const st = this.runtimeState.get(def.moduleId)!;
      if (!st.nextRunAt) {
        // Modules with dependencies get a longer initial delay so their deps have
        // a chance to complete first; others are staggered by a 2-minute gap.
        const depDelay = def.dependencies.length * 120_000;
        st.nextRunAt = new Date(now + offsetMs + depDelay).toISOString();
        offsetMs += 2 * 60_000; // 2-minute gap between successive modules
      }
    }
    this._persistState();
    systemLog.logInfo(MODULE_NAME, "Initial run schedule established for unscheduled modules");
  }

  pause(): void {
    this.settings.paused = true;
    this._persistSettings();
    systemLog.logInfo(MODULE_NAME, "Automation paused");
  }

  resume(): void {
    this.settings.paused = false;
    this._persistSettings();
    systemLog.logInfo(MODULE_NAME, "Automation resumed");
    setTimeout(() => this._tick(), 1_000);
  }

  // ── Module settings ─────────────────────────────────────────────────────────

  private _defaultsMap(): Map<ModuleId, ModuleDefaults> {
    const m = new Map<ModuleId, ModuleDefaults>();
    for (const d of MODULE_DEFAULTS) m.set(d.moduleId, d);
    return m;
  }

  private _moduleSettings(moduleId: ModuleId): ModuleSettings {
    const def = MODULE_DEFAULTS.find(d => d.moduleId === moduleId)!;
    const override = this.settings.moduleOverrides[moduleId] ?? {};
    return {
      enabled:              override.enabled             ?? true,
      supportsAutomaticRun: override.supportsAutomaticRun ?? def.supportsAutomaticRun,
      intervalMinutes:      override.intervalMinutes      ?? def.defaultIntervalMinutes,
      staleAfterMinutes:    override.staleAfterMinutes    ?? def.staleAfterMinutes,
      priority:             override.priority             ?? def.priority,
    };
  }

  updateModuleSettings(moduleId: ModuleId, patch: Partial<ModuleSettings>): void {
    const def = MODULE_DEFAULTS.find(d => d.moduleId === moduleId);
    if (!def) throw new Error(`Unknown module: ${moduleId}`);

    const current = this._moduleSettings(moduleId);
    const merged: ModuleSettings = { ...current, ...patch };

    // Clamp interval to safe bounds
    merged.intervalMinutes = Math.max(def.minimumIntervalMinutes, Math.min(def.maximumIntervalMinutes, merged.intervalMinutes));

    this.settings.moduleOverrides[moduleId] = merged;
    this._persistSettings();
    systemLog.logInfo(MODULE_NAME, `Settings updated for ${def.displayName}`);
  }

  resetModuleSettings(moduleId: ModuleId): void {
    delete this.settings.moduleOverrides[moduleId];
    this._persistSettings();
    systemLog.logInfo(MODULE_NAME, `Settings reset to defaults for ${moduleId}`);
  }

  // ── Freshness ───────────────────────────────────────────────────────────────

  private _freshness(moduleId: ModuleId): ModuleFreshness {
    const st = this.runtimeState.get(moduleId);
    if (!st) return "NeverRun";
    const settings = this._moduleSettings(moduleId);

    if (!settings.enabled) return "Disabled";
    if (st.status === "Running") return "Running";
    if (st.status === "Failed") return "Failed";

    // Company Monitor stores results per ticker under "company-monitor:<TICKER>".
    // Use the most recently updated per-ticker entry for freshness computation.
    let entry = analysisRepository.get(moduleId);
    if (!entry && moduleId === "company-monitor") {
      const allEntries = analysisRepository.getAll(); // sorted by updatedAt descending
      const tickerEntry = allEntries.find(e => e.moduleName.startsWith("company-monitor:"));
      if (tickerEntry) entry = tickerEntry;
    }
    if (!entry) return "NeverRun";

    const ageMs  = Date.now() - new Date(entry.updatedAt).getTime();
    const staleMs = settings.staleAfterMinutes * 60_000;

    if (ageMs >= staleMs) return "Stale";
    if (ageMs >= staleMs * 0.85) return "DueSoon";
    return "Fresh";
  }

  private _isFresh(moduleId: ModuleId): boolean {
    const f = this._freshness(moduleId);
    return f === "Fresh" || f === "DueSoon";
  }

  // ── Scheduler tick ──────────────────────────────────────────────────────────

  private _tick(): void {
    if (this.settings.mode !== "SemiAutomatic" || this.settings.paused) return;

    const now = Date.now();

    // Process modules in priority order
    const sorted = [...MODULE_DEFAULTS].sort((a, b) =>
      this._moduleSettings(a.moduleId).priority - this._moduleSettings(b.moduleId).priority
    );

    for (const def of sorted) {
      const settings = this._moduleSettings(def.moduleId);
      if (!settings.enabled || !settings.supportsAutomaticRun) continue;

      const st = this.runtimeState.get(def.moduleId)!;
      if (st.status === "Running") continue;
      if (this._hasActiveJob(def.moduleId)) continue;

      // Check if due. Null means "never scheduled" — do NOT treat as immediately due;
      // initial scheduling happens in _scheduleInitialRuns() when mode becomes SemiAutomatic.
      if (!st.nextRunAt) continue;
      const nextRun = new Date(st.nextRunAt).getTime();
      if (nextRun > now) continue;

      // Check dependencies
      const staleDeps = def.dependencies.filter(d => !this._isFresh(d));
      if (staleDeps.length > 0) {
        st.waitingForDeps = staleDeps;
        // Trigger stale dependencies first — only if the dep allows automatic runs.
        // If a dependency has Auto-run disabled, leave the module in WaitingForDependency
        // and let the user trigger the dependency manually.
        for (const dep of staleDeps) {
          const depSettings = this._moduleSettings(dep);
          if (depSettings.enabled && depSettings.supportsAutomaticRun && !this._hasActiveJob(dep)) {
            void this.triggerModule(dep, "Dependency");
          }
        }
        continue;
      }

      st.waitingForDeps = [];

      // Skip company-monitor in tick (handled specially — target selection needed)
      if (def.moduleId === "company-monitor") {
        void this._dispatchCompanyMonitorScheduled("Scheduled");
        continue;
      }

      void this.triggerModule(def.moduleId, "Scheduled");
    }
  }

  // ── Trigger & execute ───────────────────────────────────────────────────────

  private _hasActiveJob(moduleId: ModuleId): boolean {
    return this.jobs.some(j =>
      j.moduleId === moduleId &&
      (j.status === "Running" || j.status === "Pending")
    );
  }

  async triggerModule(
    moduleId: ModuleId,
    trigger: ModuleTrigger,
    options: { ticker?: string; parentJobId?: string; correlationId?: string } = {}
  ): Promise<OrchestratorJob> {
    // Dedup: skip if already running/pending (unless ticker-specific company-monitor)
    if (moduleId !== "company-monitor" && this._hasActiveJob(moduleId)) {
      const existing = this.jobs.find(j =>
        j.moduleId === moduleId && (j.status === "Running" || j.status === "Pending")
      )!;
      return existing;
    }

    const correlationId = options.correlationId ?? randomUUID();
    const job: OrchestratorJob = {
      id: randomUUID(),
      correlationId,
      moduleId,
      ticker: options.ticker,
      trigger,
      status: "Pending",
      priority: this._moduleSettings(moduleId).priority,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      durationMs: null,
      attempt: 0,
      maxAttempts: 2,
      error: null,
      affectedTickers: options.ticker ? [options.ticker] : [],
      parentJobId: options.parentJobId ?? null,
    };

    this._addJob(job);
    void this._executeJob(job);
    return job;
  }

  private async _executeJob(job: OrchestratorJob, retryDelay = 0): Promise<void> {
    if (retryDelay > 0) {
      await new Promise(r => setTimeout(r, retryDelay));
    }

    job.status = "Running";
    job.startedAt = new Date().toISOString();
    job.attempt++;

    const st = this.runtimeState.get(job.moduleId);
    if (st) {
      st.status = "Running";
      st.currentJobId = job.id;
      st.lastRunAt = job.startedAt;
    }
    this._persist();

    const ep = MODULE_ENDPOINTS[job.moduleId];
    const url = `http://localhost:${this.port}${ep.path}`;

    try {
      const init: RequestInit = {
        method: ep.method,
        headers: {
          "Content-Type": "application/json",
          "X-Orchestrator-Trigger": job.trigger,
          "X-Orchestrator-Job-Id": job.id,
        },
      };

      if (ep.method === "POST" && job.moduleId === "company-monitor" && job.ticker) {
        init.body = JSON.stringify({ ticker: job.ticker });
      } else if (ep.method === "POST") {
        init.body = JSON.stringify({});
      }

      const res = await fetch(url, init);
      const now = new Date().toISOString();

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      // Success
      const completedMs = Date.now();
      job.status = "Completed";
      job.completedAt = now;
      job.durationMs = completedMs - new Date(job.startedAt!).getTime();

      if (st) {
        st.status = "Idle";
        st.lastSuccessfulRunAt = now;
        st.lastError = null;
        st.currentJobId = null;
        // Schedule next run
        const intervalMs = this._moduleSettings(job.moduleId).intervalMinutes * 60_000;
        st.nextRunAt = new Date(completedMs + intervalMs).toISOString();
        st.waitingForDeps = [];
      }

      this._persist();
      systemLog.logInternal(MODULE_NAME, `${job.moduleId} completed via ${job.trigger} (${job.durationMs}ms)`);

      // Trigger downstream modules
      void this._triggerDownstream(job.moduleId, job.correlationId, job.id);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (job.attempt < job.maxAttempts) {
        // Exponential backoff retry
        const backoff = 10_000 * job.attempt;
        job.status = "Pending";
        this._persist();
        void this._executeJob(job, backoff);
        return;
      }

      const now = new Date().toISOString();
      job.status = "Failed";
      job.completedAt = now;
      job.error = msg;

      if (st) {
        st.status = "Failed";
        st.lastError = msg;
        st.currentJobId = null;
        // Schedule retry after a longer interval even on failure
        const intervalMs = this._moduleSettings(job.moduleId).intervalMinutes * 60_000;
        st.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
      }

      this._persist();
      systemLog.logError(MODULE_NAME, `${job.moduleId} failed after ${job.attempt} attempt(s): ${msg}`);
    }
  }

  // ── Downstream chaining ─────────────────────────────────────────────────────

  private _triggerDownstream(completedModuleId: ModuleId, correlationId: string, parentJobId: string): void {
    // Only auto-chain in SemiAutomatic (non-paused)
    if (this.settings.mode !== "SemiAutomatic" || this.settings.paused) return;

    const now = Date.now();

    for (const def of MODULE_DEFAULTS) {
      if (!def.dependencies.includes(completedModuleId) && !def.runAfter.includes(completedModuleId)) continue;
      const settings = this._moduleSettings(def.moduleId);
      if (!settings.enabled || !settings.supportsAutomaticRun) continue;
      if (this._hasActiveJob(def.moduleId)) continue;

      // Gate 1: the dependent must actually need refreshing.
      // "runAfter" modules (e.g. Trade Review after TDE) chain immediately;
      // modules that only have a dependency relationship only run if stale/due.
      const isRunAfter = def.runAfter.includes(completedModuleId);
      const freshness = this._freshness(def.moduleId);
      const isStale = freshness === "Stale" || freshness === "NeverRun" || freshness === "DueSoon";
      if (!isRunAfter && !isStale) continue; // still fresh — honour its own interval

      // Gate 2: for scheduled modules, respect nextRunAt unless it's a runAfter chain.
      const st = this.runtimeState.get(def.moduleId)!;
      if (!isRunAfter && st.nextRunAt && new Date(st.nextRunAt).getTime() > now) continue;

      // Verify ALL deps are fresh
      const staleDeps = def.dependencies.filter(d => !this._isFresh(d));
      if (staleDeps.length > 0) {
        st.waitingForDeps = staleDeps;
        systemLog.logInternal(MODULE_NAME,
          `${def.moduleId} waiting for fresh: ${staleDeps.join(", ")}`
        );
        continue;
      }

      st.waitingForDeps = [];

      if (def.moduleId === "company-monitor") {
        void this._dispatchCompanyMonitorScheduled("Dependency", correlationId, parentJobId);
      } else {
        void this.triggerModule(def.moduleId, "Dependency", { correlationId, parentJobId });
      }
    }
  }

  // ── Company Monitor targeting ───────────────────────────────────────────────

  private _getTargetTickers(maxCount = 5): string[] {
    const tickers = new Set<string>();

    // Portfolio holdings
    try {
      const pm = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
      const accounts = Array.isArray(pm?.result?.accounts) ? pm!.result!.accounts as Array<Record<string, unknown>> : [];
      for (const acc of accounts) {
        const positions = Array.isArray(acc.positions) ? acc.positions as Array<Record<string, unknown>> : [];
        for (const pos of positions) {
          const sym = String(pos.symbol ?? "").toUpperCase();
          if (sym) tickers.add(sym);
        }
      }
    } catch { /* ignore */ }

    // Trade Decision Engine subjects
    try {
      const tde = analysisRepository.get<Record<string, unknown>>("trade-decision-engine");
      const decisions = Array.isArray(tde?.result?.decisions) ? tde!.result!.decisions as Array<Record<string, unknown>> : [];
      for (const d of decisions) {
        const ticker = String(d.ticker ?? "").toUpperCase();
        if (ticker) tickers.add(ticker);
      }
    } catch { /* ignore */ }

    return [...tickers].slice(0, maxCount);
  }

  private async _dispatchCompanyMonitorScheduled(
    trigger: ModuleTrigger,
    correlationId?: string,
    parentJobId?: string
  ): Promise<void> {
    const tickers = this._getTargetTickers(5);
    if (tickers.length === 0) return;

    const corrId = correlationId ?? randomUUID();
    for (const ticker of tickers) {
      await this.triggerModule("company-monitor", trigger, {
        ticker,
        correlationId: corrId,
        parentJobId,
      });
    }
  }

  // ── Run all now ─────────────────────────────────────────────────────────────

  async runAllNow(): Promise<void> {
    if (this.cycleInProgress) {
      throw new Error("A full cycle is already in progress.");
    }
    this.cycleInProgress = true;
    const corrId = randomUUID();
    systemLog.logInfo(MODULE_NAME, "Full cycle started (Run all now)");

    try {
      // Stage 1: Portfolio Manager
      await this._runStage(["portfolio-manager"], corrId, "RunAllNow");

      // Stage 2: Market Monitor, News Monitor, Event Monitor in parallel
      await this._runStageParallel(["market-monitor", "news-monitor", "event-monitor"], corrId, "RunAllNow");

      // Stage 3: Sector Monitor
      await this._runStage(["sector-monitor"], corrId, "RunAllNow");

      // Stage 4: Company Monitor for each target ticker (sequential)
      const tickers = this._getTargetTickers(5);
      for (const ticker of tickers) {
        const job = await this.triggerModule("company-monitor", "RunAllNow", { ticker, correlationId: corrId });
        await this._waitForJob(job.id, 300_000);
      }

      // Stage 5: Market Alerts
      await this._runStage(["market-alerts"], corrId, "RunAllNow");

      // Stage 6: Risk Analyzer
      await this._runStage(["risk-analyzer"], corrId, "RunAllNow");

      // Stage 7: Portfolio Analyzer
      await this._runStage(["portfolio-analyzer"], corrId, "RunAllNow");

      // Stage 8: Opportunity Finder
      await this._runStage(["opportunity-finder"], corrId, "RunAllNow");

      // Stage 9: Trade Decision Engine
      await this._runStage(["trade-decision-engine"], corrId, "RunAllNow");

      // Stage 10: Trade Review
      await this._runStage(["trade-review"], corrId, "RunAllNow");

      this.lastFullCycleAt = new Date().toISOString();
      systemLog.logInfo(MODULE_NAME, "Full cycle completed");

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      systemLog.logError(MODULE_NAME, `Full cycle aborted: ${msg}`);
    } finally {
      this.cycleInProgress = false;
    }
  }

  private async _runStage(moduleIds: ModuleId[], corrId: string, trigger: ModuleTrigger): Promise<void> {
    for (const moduleId of moduleIds) {
      const settings = this._moduleSettings(moduleId);
      if (!settings.enabled) continue;
      const job = await this.triggerModule(moduleId, trigger, { correlationId: corrId });
      await this._waitForJob(job.id, 300_000);
    }
  }

  private async _runStageParallel(moduleIds: ModuleId[], corrId: string, trigger: ModuleTrigger): Promise<void> {
    const jobs = await Promise.all(
      moduleIds
        .filter(id => this._moduleSettings(id).enabled)
        .map(id => this.triggerModule(id, trigger, { correlationId: corrId }))
    );
    await Promise.all(jobs.map(j => this._waitForJob(j.id, 300_000)));
  }

  /**
   * Wait for a job to reach a terminal state and throw if it did not succeed.
   * Throws an Error for: job not found, Failed, Cancelled, Skipped, or timeout.
   * This ensures `runAllNow` aborts the cycle when any prerequisite stage fails.
   */
  private _waitForJob(jobId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        const job = this.jobs.find(j => j.id === jobId);
        if (!job) {
          reject(new Error(`Job ${jobId} not found`));
          return;
        }
        if (job.status === "Completed") {
          resolve();
          return;
        }
        if (job.status === "Failed") {
          reject(new Error(`${job.moduleId} failed: ${job.error ?? "unknown error"}`));
          return;
        }
        if (job.status === "Cancelled") {
          reject(new Error(`${job.moduleId} was cancelled`));
          return;
        }
        if (job.status === "Skipped") {
          // Skipped is non-fatal — the module was already fresh; proceed.
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`${job.moduleId} timed out after ${timeoutMs / 1000}s`));
          return;
        }
        setTimeout(check, 1_000);
      };
      setTimeout(check, 500);
    });
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  getStatus(): OrchestratorStatus {
    const defaultsMap = this._defaultsMap();
    const today = new Date().toDateString();

    const modules: OrchestratorModuleStatus[] = MODULE_DEFAULTS.map(def => {
      const st = this.runtimeState.get(def.moduleId)!;
      const settings = this._moduleSettings(def.moduleId);
      const freshness = this._freshness(def.moduleId);
      const entry = analysisRepository.get(def.moduleId);

      // Compute WaitingForDependency freshness override
      const effectiveFreshness: ModuleFreshness =
        !settings.enabled ? "Disabled" :
        st.status === "Running" ? "Running" :
        st.waitingForDeps && st.waitingForDeps.length > 0 ? "WaitingForDependency" :
        freshness;

      return {
        moduleId: def.moduleId,
        displayName: def.displayName,
        freshness: effectiveFreshness,
        settings,
        defaults: {
          scheduleType: def.scheduleType,
          minimumIntervalMinutes: def.minimumIntervalMinutes,
          maximumIntervalMinutes: def.maximumIntervalMinutes,
          dependencies: def.dependencies,
          runAfter: def.runAfter,
        },
        runtime: { ...st, waitingForDeps: st.waitingForDeps ?? [] },
        lastUpdatedAt: entry?.updatedAt ?? st.lastSuccessfulRunAt,
        nextRunAt: st.nextRunAt,
      };
    });

    const recentJobs = [...this.jobs].reverse().slice(0, 50);

    const analysesToday = this.jobs.filter(j =>
      j.status === "Completed" &&
      j.completedAt &&
      new Date(j.completedAt).toDateString() === today
    ).length;

    const failedToday = this.jobs.filter(j =>
      j.status === "Failed" &&
      j.completedAt &&
      new Date(j.completedAt).toDateString() === today
    ).length;

    const nextJobs = modules
      .filter(m => m.nextRunAt && m.freshness !== "Disabled" && m.settings.supportsAutomaticRun)
      .map(m => m.nextRunAt!)
      .filter(t => new Date(t).getTime() > Date.now())
      .sort();

    return {
      mode: this.settings.mode,
      paused: this.settings.paused,
      modules,
      jobs: recentJobs,
      stats: {
        running: modules.filter(m => m.freshness === "Running").length,
        stale:   modules.filter(m => m.freshness === "Stale").length,
        failed:  modules.filter(m => m.freshness === "Failed").length,
        analysesToday,
        failedToday,
        nextScheduledJobAt: nextJobs[0] ?? null,
      },
      lastFullCycleAt: this.lastFullCycleAt,
      cycleInProgress: this.cycleInProgress,
    };
  }

  getJobs(): OrchestratorJob[] {
    return [...this.jobs].reverse();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private _addJob(job: OrchestratorJob): void {
    this.jobs.push(job);
    if (this.jobs.length > MAX_JOBS) {
      this.jobs = this.jobs.slice(-MAX_JOBS);
    }
  }

  private _persistSettings(): void {
    writeJson("automation-settings.json", this.settings);
  }

  private _persistState(): void {
    const obj: Record<string, ModuleRuntimeState> = {};
    for (const [k, v] of this.runtimeState) obj[k] = v;
    writeJson("automation-state.json", obj);
  }

  private _persist(): void {
    this._persistSettings();
    this._persistState();
    writeJson("automation-jobs.json", this.jobs);
  }
}

/** Singleton — import everywhere; never instantiate directly. */
export const automationOrchestrator = new AutomationOrchestratorService();
