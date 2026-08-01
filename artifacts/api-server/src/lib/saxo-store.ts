/**
 * Saxo Connection Store
 *
 * Lightweight file-backed store for Saxo Bank OAuth state and tokens.
 * Kept entirely separate from the Analysis Repository — credentials and
 * tokens are not analysis results and must never appear in shared data.
 *
 * Security rules enforced here:
 *  - Tokens are never logged (the logger serialisers in app.ts strip req/res
 *    bodies, but we add an extra layer by never putting them in log calls).
 *  - The backing file path is added to .gitignore.
 *  - The public `getPublicStatus()` method returns everything the frontend
 *    needs without exposing any token value.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { logger } from "./logger.js";

const DATA_DIR = resolve(process.cwd(), "data");
export const SAXO_STORE_FILE = resolve(DATA_DIR, "saxo-connection.json");

// ── Stored shape (written to disk) ──────────────────────────────────────────

interface SaxoStoreData {
  /** "sim" | "live" — follows SAXO_ENVIRONMENT env var; may be overridden here */
  environment: "sim" | "live";
  /** User-supplied override for the OAuth callback URL */
  redirectUrlOverride?: string;
  /** Short-lived nonce stored during an active auth flow */
  pendingState?: string;
  /** redirect_uri used when the login was initiated (must match token exchange) */
  pendingRedirectUrl?: string;
  /** Where to redirect the browser after the callback completes */
  pendingReturnUrl?: string;
  /** Access token — never exposed to the frontend */
  accessToken?: string;
  /** Refresh token — never exposed to the frontend */
  refreshToken?: string;
  /** ISO 8601 — when the access token expires */
  expiresAt?: string;
  /** ISO 8601 — when we successfully authenticated */
  connectedAt?: string;
  /** Last authentication error, if any */
  error?: string;
}

// ── Public status shape (safe to send to the frontend) ──────────────────────

export interface SaxoPublicStatus {
  configured: boolean;
  appKeyConfigured: boolean;
  appSecretConfigured: boolean;
  connected: boolean;
  environment: "sim" | "live";
  redirectUrlOverride?: string;
  expiresAt?: string;
  connectedAt?: string;
  error?: string;
}

// ── Store class ──────────────────────────────────────────────────────────────

class SaxoStore {
  private data: SaxoStoreData = { environment: "sim" };

  constructor() {
    this._loadFromDisk();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private _loadFromDisk(): void {
    try {
      if (!existsSync(SAXO_STORE_FILE)) return;
      const raw = readFileSync(SAXO_STORE_FILE, "utf-8");
      this.data = JSON.parse(raw) as SaxoStoreData;
      logger.info("[saxo-store] Loaded connection state from disk");
    } catch (err) {
      logger.warn({ err }, "[saxo-store] Failed to load from disk — starting empty");
    }
  }

  private _persistToDisk(): void {
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(SAXO_STORE_FILE, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (err) {
      logger.error({ err }, "[saxo-store] Failed to persist to disk");
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  getEnvironment(): "sim" | "live" {
    return this.data.environment;
  }

  getRedirectUrlOverride(): string | undefined {
    return this.data.redirectUrlOverride;
  }

  getPendingState(): string | undefined {
    return this.data.pendingState;
  }

  getPendingRedirectUrl(): string | undefined {
    return this.data.pendingRedirectUrl;
  }

  getPendingReturnUrl(): string | undefined {
    return this.data.pendingReturnUrl;
  }

  getAccessToken(): string | undefined {
    return this.data.accessToken;
  }

  getRefreshToken(): string | undefined {
    return this.data.refreshToken;
  }

  isConnected(): boolean {
    return (
      !!this.data.accessToken &&
      !!this.data.expiresAt &&
      new Date(this.data.expiresAt) > new Date()
    );
  }

  isTokenExpiringSoon(withinMs = 10 * 60 * 1000): boolean {
    if (!this.data.expiresAt) return false;
    return new Date(this.data.expiresAt).getTime() - Date.now() < withinMs;
  }

  /** Returns a safe-to-send-to-frontend status snapshot (no tokens). */
  getPublicStatus(appKeyConfigured: boolean, appSecretConfigured: boolean): SaxoPublicStatus {
    return {
      configured: appKeyConfigured && appSecretConfigured,
      appKeyConfigured,
      appSecretConfigured,
      connected: this.isConnected(),
      environment: this.data.environment,
      redirectUrlOverride: this.data.redirectUrlOverride,
      expiresAt: this.data.expiresAt,
      connectedAt: this.data.connectedAt,
      error: this.data.error,
    };
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  setEnvironment(env: "sim" | "live"): void {
    this.data.environment = env;
    this._persistToDisk();
  }

  setRedirectUrlOverride(url: string | undefined): void {
    this.data.redirectUrlOverride = url || undefined;
    this._persistToDisk();
  }

  /** Called when login is initiated. Stores state nonce + URLs for callback. */
  beginAuthFlow(state: string, redirectUrl: string, returnUrl: string): void {
    this.data.pendingState = state;
    this.data.pendingRedirectUrl = redirectUrl;
    this.data.pendingReturnUrl = returnUrl;
    this.data.error = undefined;
    this._persistToDisk();
  }

  /** Called after successful token exchange. Stores tokens without logging them. */
  saveTokens(accessToken: string, refreshToken: string, expiresAt: string): void {
    this.data.accessToken = accessToken;
    this.data.refreshToken = refreshToken;
    this.data.expiresAt = expiresAt;
    this.data.connectedAt = new Date().toISOString();
    this.data.error = undefined;
    // Clear pending auth flow state
    this.data.pendingState = undefined;
    this.data.pendingRedirectUrl = undefined;
    this.data.pendingReturnUrl = undefined;
    this._persistToDisk();
  }

  /** Called when refresh or callback fails. */
  markDisconnected(error: string): void {
    this.data.accessToken = undefined;
    this.data.refreshToken = undefined;
    this.data.expiresAt = undefined;
    this.data.pendingState = undefined;
    this.data.pendingRedirectUrl = undefined;
    this.data.pendingReturnUrl = undefined;
    this.data.error = error;
    this._persistToDisk();
  }

  /** Called on explicit logout. */
  clearTokens(): void {
    this.data.accessToken = undefined;
    this.data.refreshToken = undefined;
    this.data.expiresAt = undefined;
    this.data.connectedAt = undefined;
    this.data.pendingState = undefined;
    this.data.pendingRedirectUrl = undefined;
    this.data.pendingReturnUrl = undefined;
    this.data.error = undefined;
    this._persistToDisk();
  }
}

/** Singleton — import this everywhere; never instantiate SaxoStore directly. */
export const saxoStore = new SaxoStore();
