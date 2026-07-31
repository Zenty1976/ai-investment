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
 * The public API (save / get / getAll / has) is unchanged — callers never
 * need to know whether persistence is backed by a file or a database.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// process.cwd() is the api-server package directory when the dev/start scripts
// run via pnpm --filter, so this resolves to artifacts/api-server/data/
const DATA_DIR = resolve(process.cwd(), "data");
const DATA_FILE = resolve(DATA_DIR, "repository.json");

export interface RepositoryEntry<T = unknown> {
  /** Stable identifier for the module, e.g. "market-monitor" */
  moduleName: string;
  /** The structured analysis result produced by the module */
  result: T;
  /** ISO 8601 — when this module first saved a result */
  createdAt: string;
  /** ISO 8601 — when this module last saved a result */
  updatedAt: string;
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
        this.store.set(key, entry);
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

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Save or update a module's latest result.
   * `createdAt` is preserved on subsequent saves; only `updatedAt` changes.
   * Immediately writes the complete store to disk.
   */
  save<T>(moduleName: string, result: T): RepositoryEntry<T> {
    const existing = this.store.get(moduleName);
    const now = new Date().toISOString();
    const entry: RepositoryEntry<T> = {
      moduleName,
      result,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.set(moduleName, entry as RepositoryEntry);
    this._persistToDisk();
    return entry;
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
}

/** Singleton — import this everywhere; never instantiate AnalysisRepository directly. */
export const analysisRepository = new AnalysisRepository();
