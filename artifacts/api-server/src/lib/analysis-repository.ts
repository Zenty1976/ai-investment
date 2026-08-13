/**
 * Analysis Repository
 *
 * The single shared interface between all analysis modules. Each module saves
 * its latest structured result here; any module can read any other module's
 * latest result. Modules never communicate with each other directly.
 *
 * Persistence: on startup the store is pre-loaded from a single JSON file.
 * Every call to save() immediately writes the complete store back to that
 * file. The in-memory Map is always the source of truth at runtime; the file
 * is purely for durability across server restarts.
 *
 * Versioning:
 *   materialVersion — incremented when content changes materially (timestamps
 *     stripped, price-context entries use a categorical-only comparison).
 *     Used by the dependency fingerprint service to detect meaningful changes.
 *   refreshVersion  — incremented on every save, including no-op saves where
 *     the result is unchanged. Useful for tracking refresh cadence.
 *
 * The public API (save / get / getAll / has) is unchanged — callers never
 * need to know whether persistence is backed by a file or a database.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const DATA_DIR = resolve(process.cwd(), "data");
const DATA_FILE = resolve(DATA_DIR, "repository.json");

export interface RepositoryEntry<T = unknown> {
  /** Stable identifier for the module, e.g. "market-monitor" */
  moduleName: string;
  /** The structured analysis result produced by the module */
  result: T;
  /** ISO 8601 — when this module first saved a result */
  createdAt: string;
  /** ISO 8601 — when this module last saved a result (or was refreshed) */
  updatedAt: string;
  /**
   * Incremented when the stored result changes materially.
   * Used by the dependency fingerprint service: when a downstream module's
   * fingerprint includes this entry's materialVersion and it changes, the
   * downstream module must rerun its AI call.
   *
   * For price-context entries: only bumped on categorical state changes
   * (priceState, recentBehavior.state, volatilityRegime) or a ≥3% move
   * in changePercent1W — minor daily price fluctuations are NOT material.
   */
  materialVersion: number;
  /** Incremented on every save, including no-material-change saves */
  refreshVersion: number;
  /**
   * Fingerprint of the dependency materialVersions used for the last AI call.
   * Set by the orchestrator after a successful AI-backed analysis.
   * If this matches the current fingerprint → AI call can be skipped.
   */
  dependencyFingerprint?: string;
  /**
   * ISO timestamp of the last actual OpenAI/AI call for this module.
   * May differ from updatedAt when the orchestrator skips (SKIPPED_UNCHANGED).
   */
  lastAIAnalysisAt?: string;
}

class AnalysisRepository {
  private readonly store = new Map<string, RepositoryEntry>();

  constructor() {
    this._loadFromDisk();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private _loadFromDisk(): void {
    try {
      if (!existsSync(DATA_FILE)) return;
      const raw = readFileSync(DATA_FILE, "utf-8");
      const data = JSON.parse(raw) as Record<string, RepositoryEntry>;
      for (const [key, entry] of Object.entries(data)) {
        // Back-fill version fields for entries persisted before this feature was added.
        // Spread entry first so stored values are preserved; defaults apply only when
        // the field is absent (legacy entries written before versioning was introduced).
        this.store.set(key, {
          ...entry,
          materialVersion: entry.materialVersion ?? 1,
          refreshVersion:  entry.refreshVersion  ?? 1,
        });
      }
      console.info(
        `[repository] Loaded ${this.store.size} module(s) from ${DATA_FILE}`
      );
    } catch (err) {
      console.warn(
        `[repository] Failed to load from disk — starting empty. Error: ${err}`
      );
    }
  }

  private _persistToDisk(): void {
    try {
      if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true });
      }
      const data: Record<string, RepositoryEntry> = {};
      for (const [key, entry] of this.store) {
        data[key] = entry;
      }
      writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error(
        `[repository] Failed to persist to disk — in-memory store is unaffected. Error: ${err}`
      );
    }
  }

  // ── Materiality helpers ──────────────────────────────────────────────────────

  /** Strip common timestamp-only fields before deep-equality comparison. */
  private _stripTimestamps(o: unknown): unknown {
    if (!o || typeof o !== "object") return o;
    const obj = o as Record<string, unknown>;
    const {
      timestamp, generatedAt, updatedAt, lastRunAt,
      fetchedAt, analyzedAt, asOf,
      ...rest
    } = obj;
    void timestamp; void generatedAt; void updatedAt; void lastRunAt;
    void fetchedAt; void analyzedAt; void asOf;
    return rest;
  }

  /**
   * Determine whether a new result is materially different from the previous
   * one for a price-context entry.
   *
   * Field names are taken directly from PriceContext (price-context-calculator.ts):
   *   priceState          — top-level string field
   *   recentBehavior.state — categorical (RecentBehaviorState)
   *   volatility.volatilityState  — categorical (VolatilityState)
   *   volatility.volatilityTrend  — categorical (VolatilityTrend)
   *   returns.fiveDayPct  — number | null
   *
   * Material = any categorical state change OR a ≥3 percentage-point move in
   * the 5-day return.  Minor daily fluctuations that leave all categories
   * unchanged are intentionally NOT material so they don't cascade AI reruns.
   */
  private _isPriceContextMaterial(prev: unknown, next: unknown): boolean {
    const p = prev as Record<string, unknown>;
    const n = next as Record<string, unknown>;

    // Primary categorical state (PriceState enum)
    if (p.priceState !== n.priceState) return true;

    // Recent behaviour categorical state (RecentBehaviorState)
    const pRb = p.recentBehavior as Record<string, unknown> | null | undefined;
    const nRb = n.recentBehavior as Record<string, unknown> | null | undefined;
    if ((pRb?.state ?? null) !== (nRb?.state ?? null)) return true;

    // Volatility state and trend (both categorical, inside the `volatility` object)
    const pVol = p.volatility as Record<string, unknown> | undefined;
    const nVol = n.volatility as Record<string, unknown> | undefined;
    if ((pVol?.volatilityState ?? null) !== (nVol?.volatilityState ?? null)) return true;
    if ((pVol?.volatilityTrend ?? null) !== (nVol?.volatilityTrend ?? null)) return true;

    // 5-day return: material if it moved ≥3 percentage points
    const pReturns = p.returns as Record<string, unknown> | undefined;
    const nReturns = n.returns as Record<string, unknown> | undefined;
    const pPct = typeof pReturns?.fiveDayPct === "number" ? pReturns.fiveDayPct : 0;
    const nPct = typeof nReturns?.fiveDayPct === "number" ? nReturns.fiveDayPct : 0;
    if (Math.abs(nPct - pPct) >= 3) return true;

    return false;
  }

  private _isMaterialChange(moduleName: string, prev: unknown, next: unknown): boolean {
    if (!prev) return true; // first-ever save is always material

    if (moduleName.startsWith("price-context:")) {
      return this._isPriceContextMaterial(prev, next);
    }

    // Default: compare after stripping timestamps
    const prevStr = JSON.stringify(this._stripTimestamps(prev));
    const nextStr = JSON.stringify(this._stripTimestamps(next));
    return prevStr !== nextStr;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Save or update a module's latest result.
   *
   * Always bumps refreshVersion.
   * Bumps materialVersion only when the result changes materially
   * (timestamps stripped; price-context uses categorical comparison).
   *
   * Immediately writes the complete store to disk.
   */
  save<T>(moduleName: string, result: T): RepositoryEntry<T> {
    const existing = this.store.get(moduleName);
    const now = new Date().toISOString();

    const prevMaterial = existing?.materialVersion ?? 0;
    const prevRefresh  = existing?.refreshVersion  ?? 0;
    const isMaterial   = this._isMaterialChange(moduleName, existing?.result, result);

    const entry: RepositoryEntry<T> = {
      moduleName,
      result,
      createdAt:            existing?.createdAt ?? now,
      updatedAt:            now,
      materialVersion:      isMaterial ? prevMaterial + 1 : prevMaterial,
      refreshVersion:       prevRefresh + 1,
      dependencyFingerprint: existing?.dependencyFingerprint,
      lastAIAnalysisAt:     existing?.lastAIAnalysisAt,
    };
    this.store.set(moduleName, entry as RepositoryEntry);
    this._persistToDisk();
    return entry;
  }

  /**
   * Record a successful orchestrator check where no AI call was needed
   * (the dependency fingerprint was unchanged).
   *
   * Bumps refreshVersion and updatedAt so _freshness() continues to return
   * "Fresh". Does NOT change result, materialVersion, dependencyFingerprint,
   * or lastAIAnalysisAt.
   */
  saveSkipped(moduleName: string): void {
    const existing = this.store.get(moduleName);
    if (!existing) return;
    const entry: RepositoryEntry = {
      ...existing,
      updatedAt:      new Date().toISOString(),
      refreshVersion: (existing.refreshVersion ?? 0) + 1,
    };
    this.store.set(moduleName, entry);
    this._persistToDisk();
  }

  /**
   * Record that an AI call was made for this module, independently of whether
   * the module has a dependency fingerprint.
   *
   * This is the authoritative way to set lastAIAnalysisAt. It must be called
   * after every successful AI-backed route execution, including modules that
   * have no static dependency config (market-monitor, news-monitor,
   * opportunity-finder, sector-monitor DISCOVERY path, event-monitor DISCOVERY
   * path). These modules cannot use setFingerprint (no fingerprint to store),
   * so without this method their lastAIAnalysisAt would never be written, and
   * the OBSERVATION_MODULE_MIN_REFRESH_MINUTES recent-run guard would have no
   * timestamp to check.
   *
   * SKIPPED paths (MAINTENANCE, SKIPPED_RECENT, SKIPPED_UNCHANGED) must NOT
   * call this — preserving the previous timestamp is the correct behaviour.
   *
   * Called by the orchestrator immediately after a successful HTTP response when
   * the route's _debug.aiCalled is true (or absent, which defaults to true).
   */
  markAIAnalysis(moduleName: string, lastAIAnalysisAt: string): void {
    const existing = this.store.get(moduleName);
    if (!existing) return;
    const entry: RepositoryEntry = {
      ...existing,
      lastAIAnalysisAt,
    };
    this.store.set(moduleName, entry);
    this._persistToDisk();
  }

  /**
   * Store the dependency fingerprint and AI analysis timestamp after a
   * successful AI-backed analysis completes. Does not change result or
   * version numbers.
   *
   * Called by the orchestrator after each successful HTTP call for modules
   * that have a static dependency config (i.e. computeFingerprint returns
   * non-null). Also updates lastAIAnalysisAt for backward compatibility —
   * callers should prefer markAIAnalysis for setting the timestamp and
   * setFingerprint only for the fingerprint itself.
   */
  setFingerprint(moduleName: string, fingerprint: string, lastAIAnalysisAt: string): void {
    const existing = this.store.get(moduleName);
    if (!existing) return;
    const entry: RepositoryEntry = {
      ...existing,
      dependencyFingerprint: fingerprint,
      lastAIAnalysisAt,
    };
    this.store.set(moduleName, entry);
    this._persistToDisk();
  }

  /** Retrieve the latest entry for a module, or undefined if none exists. */
  get<T>(moduleName: string): RepositoryEntry<T> | undefined {
    return this.store.get(moduleName) as RepositoryEntry<T> | undefined;
  }

  /** Retrieve all stored entries, ordered by most recently updated. */
  getAll(): RepositoryEntry[] {
    return [...this.store.values()].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  /** Returns true if the module has a stored result. */
  has(moduleName: string): boolean {
    return this.store.has(moduleName);
  }

  /**
   * Delete all entries whose key starts with the given prefix.
   * Immediately persists to disk.
   * Returns the number of entries deleted.
   */
  deleteByPrefix(prefix: string): number {
    const toDelete: string[] = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) toDelete.push(key);
    }
    for (const key of toDelete) this.store.delete(key);
    if (toDelete.length > 0) this._persistToDisk();
    return toDelete.length;
  }
}

/** Singleton — import this everywhere; never instantiate AnalysisRepository directly. */
export const analysisRepository = new AnalysisRepository();
