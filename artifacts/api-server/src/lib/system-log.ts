/**
 * System Log Service
 *
 * Central logging service for all application modules. Stores up to 500
 * entries in memory and persists them to a JSON file for durability across
 * server restarts. Loaded automatically on startup.
 *
 * IMPORTANT: Logging failures must never break the calling module.
 * Every method swallows all errors internally.
 *
 * Never log API keys, tokens, authorization codes, or full Saxo account
 * identifiers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";

const DATA_DIR  = resolve(process.cwd(), "data");
const DATA_FILE = resolve(DATA_DIR, "system-log.json");
const MAX_ENTRIES = 500;

export type SystemLogLevel = "user" | "info" | "warning" | "error" | "internal";

export interface SystemLogEntry {
  id: string;
  timestamp: string;
  module: string;
  level: SystemLogLevel;
  message: string;
  details?: unknown;
}

class SystemLogService {
  private entries: SystemLogEntry[] = [];

  constructor() {
    this._loadFromDisk();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private _loadFromDisk(): void {
    try {
      if (!existsSync(DATA_FILE)) return;
      const raw  = readFileSync(DATA_FILE, "utf-8");
      const data = JSON.parse(raw) as unknown;
      if (Array.isArray(data)) {
        this.entries = data as SystemLogEntry[];
      }
    } catch {
      // Missing or invalid file — start empty, never crash
    }
  }

  private _persistToDisk(): void {
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(DATA_FILE, JSON.stringify(this.entries, null, 2), "utf-8");
    } catch {
      // Best-effort — never throw
    }
  }

  // ── Internal add ─────────────────────────────────────────────────────────────

  private _add(
    level: SystemLogLevel,
    module: string,
    message: string,
    details?: unknown
  ): void {
    try {
      const entry: SystemLogEntry = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        module,
        level,
        message,
        details,
      };
      this.entries.push(entry);
      if (this.entries.length > MAX_ENTRIES) {
        this.entries = this.entries.slice(-MAX_ENTRIES);
      }
      this._persistToDisk();
    } catch {
      // Swallow — logging must never break the caller
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** A user explicitly triggered an action. */
  logUser(module: string, message: string, details?: unknown): void {
    this._add("user", module, message, details);
  }

  /** Informational status update. */
  logInfo(module: string, message: string, details?: unknown): void {
    this._add("info", module, message, details);
  }

  /** Non-critical issue or unexpected fallback. */
  logWarning(module: string, message: string, details?: unknown): void {
    this._add("warning", module, message, details);
  }

  /** Operation failed. */
  logError(module: string, message: string, details?: unknown): void {
    this._add("error", module, message, details);
  }

  /** Internal decision, context, or diagnostic note. */
  logInternal(module: string, message: string, details?: unknown): void {
    this._add("internal", module, message, details);
  }

  /** Return all entries in insertion order (oldest first). */
  getAll(): SystemLogEntry[] {
    return [...this.entries];
  }

  /** Clear all entries and persist the empty state. */
  clear(): void {
    this.entries = [];
    this._persistToDisk();
  }
}

/** Singleton — import and call directly; never instantiate SystemLogService. */
export const systemLog = new SystemLogService();
