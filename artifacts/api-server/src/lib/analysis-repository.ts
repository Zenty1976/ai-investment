/**
 * Analysis Repository
 *
 * The single shared interface between all analysis modules. Each module saves
 * its latest structured result here; any module can read any other module's
 * latest result. Modules never communicate with each other directly.
 *
 * Storage is in-memory. Results survive server restarts only if the process
 * stays alive; persistence (database) can be added later without changing the
 * public API.
 */

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

  /**
   * Save or update a module's latest result.
   * `createdAt` is preserved on subsequent saves; only `updatedAt` changes.
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
