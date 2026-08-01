/**
 * Settings Routes
 *
 * Handles all backend logic for the Settings module, starting with the
 * Saxo Bank OAuth connection. Additional integrations will be added here
 * as separate sub-routers under /api/settings/.
 *
 * Routes:
 *   GET  /api/settings/saxo/status        — Public connection status (no tokens)
 *   POST /api/settings/saxo/config        — Save non-secret config (redirect URL override, environment)
 *   POST /api/settings/saxo/login         — Begin OAuth flow; returns auth URL
 *   GET  /api/settings/saxo/callback      — OAuth callback; exchanges code, stores tokens, redirects
 *   POST /api/settings/saxo/logout        — Clears stored tokens
 */

import { Router } from "express";
import crypto from "crypto";
import { saxoStore } from "../lib/saxo-store.js";
import {
  getSaxoConfigStatus,
  getAppKey,
  getAuthUrls,
  exchangeCodeForTokens,
  refreshAccessToken,
} from "../lib/saxo-config.js";
import { logger } from "../lib/logger.js";

const settingsRouter = Router();

// ── GET /api/settings/saxo/status ────────────────────────────────────────────

settingsRouter.get("/settings/saxo/status", (_req, res) => {
  const { appKeyConfigured, appSecretConfigured } = getSaxoConfigStatus();
  const status = saxoStore.getPublicStatus(appKeyConfigured, appSecretConfigured);
  res.json(status);
});

// ── POST /api/settings/saxo/config ───────────────────────────────────────────

settingsRouter.post("/settings/saxo/config", (req, res) => {
  const { redirectUrlOverride } = req.body as {
    redirectUrlOverride?: string;
  };

  if (typeof redirectUrlOverride !== "undefined") {
    saxoStore.setRedirectUrlOverride(redirectUrlOverride || undefined);
  }

  const { appKeyConfigured, appSecretConfigured } = getSaxoConfigStatus();
  res.json(saxoStore.getPublicStatus(appKeyConfigured, appSecretConfigured));
});

// ── POST /api/settings/saxo/login ────────────────────────────────────────────

settingsRouter.post("/settings/saxo/login", (req, res) => {
  const { redirectUrl, returnUrl } = req.body as {
    redirectUrl: string;
    returnUrl: string;
  };

  if (!redirectUrl || !returnUrl) {
    res.status(400).json({ error: "redirectUrl and returnUrl are required" });
    return;
  }

  let appKey: string;
  try {
    appKey = getAppKey();
  } catch {
    res.status(400).json({ error: "SAXO_APP_KEY is not configured" });
    return;
  }

  const environment = saxoStore.getEnvironment();
  const { authorizeUrl } = getAuthUrls(environment);

  // Generate a cryptographically secure state nonce
  const state = crypto.randomBytes(24).toString("hex");

  // Store the pending flow details
  saxoStore.beginAuthFlow(state, redirectUrl, returnUrl);

  // Build the authorization URL
  const params = new URLSearchParams({
    response_type: "code",
    client_id: appKey,
    state,
    redirect_uri: redirectUrl,
  });

  const authUrl = `${authorizeUrl}?${params.toString()}`;

  logger.info(
    { environment },
    "[settings/saxo] OAuth login initiated"
  );

  res.json({ authUrl });
});

// ── GET /api/settings/saxo/callback ──────────────────────────────────────────

settingsRouter.get("/settings/saxo/callback", async (req, res) => {
  const { code, state, error: oauthError } = req.query as {
    code?: string;
    state?: string;
    error?: string;
  };

  const returnUrl = saxoStore.getPendingReturnUrl() ?? "/";

  // Saxo returned an error
  if (oauthError) {
    saxoStore.markDisconnected(`Authorization denied: ${oauthError}`);
    logger.warn({ oauthError }, "[settings/saxo] OAuth callback received error");
    res.redirect(`${returnUrl}?saxo_error=denied`);
    return;
  }

  // Missing code or state
  if (!code || !state) {
    saxoStore.markDisconnected("Missing code or state in callback");
    res.redirect(`${returnUrl}?saxo_error=invalid_callback`);
    return;
  }

  // Verify state nonce
  const pendingState = saxoStore.getPendingState();
  if (!pendingState || !crypto.timingSafeEqual(
    Buffer.from(state),
    Buffer.from(pendingState)
  )) {
    saxoStore.markDisconnected("State mismatch — possible CSRF attempt");
    logger.warn("[settings/saxo] State mismatch in callback");
    res.redirect(`${returnUrl}?saxo_error=state_mismatch`);
    return;
  }

  const redirectUrl = saxoStore.getPendingRedirectUrl();
  if (!redirectUrl) {
    saxoStore.markDisconnected("No pending redirect URL found");
    res.redirect(`${returnUrl}?saxo_error=no_redirect_url`);
    return;
  }

  const environment = saxoStore.getEnvironment();

  try {
    const tokens = await exchangeCodeForTokens(code, redirectUrl, environment);
    saxoStore.saveTokens(
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresAt
    );
    logger.info(
      { environment, expiresAt: tokens.expiresAt },
      "[settings/saxo] OAuth callback successful — tokens stored"
    );
    res.redirect(`${returnUrl}?saxo_success=1`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token exchange failed";
    saxoStore.markDisconnected(message);
    logger.error({ err: message }, "[settings/saxo] Token exchange failed");
    res.redirect(`${returnUrl}?saxo_error=token_exchange_failed`);
  }
});

// ── POST /api/settings/saxo/logout ───────────────────────────────────────────

settingsRouter.post("/settings/saxo/logout", (_req, res) => {
  saxoStore.clearTokens();
  logger.info("[settings/saxo] Logged out — tokens cleared");
  const { appKeyConfigured, appSecretConfigured } = getSaxoConfigStatus();
  res.json(saxoStore.getPublicStatus(appKeyConfigured, appSecretConfigured));
});

export default settingsRouter;

// ── Token refresh helper (called from index.ts on an interval) ───────────────

/**
 * Checks whether the access token needs refreshing and, if so, attempts it.
 * Called every 5 minutes from the server entry point.
 * On failure, marks the connection as disconnected and logs a warning —
 * never logs token values.
 */
export async function maybeSaxoRefresh(): Promise<void> {
  if (!saxoStore.isConnected() && !saxoStore.isTokenExpiringSoon()) return;
  if (!saxoStore.isTokenExpiringSoon()) return;

  const refreshToken = saxoStore.getRefreshToken();
  if (!refreshToken) return;

  const environment = saxoStore.getEnvironment();

  try {
    const tokens = await refreshAccessToken(refreshToken, environment);
    saxoStore.saveTokens(
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresAt
    );
    logger.info(
      { environment, expiresAt: tokens.expiresAt },
      "[settings/saxo] Access token refreshed"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Refresh failed";
    saxoStore.markDisconnected(message);
    logger.warn({ err: message }, "[settings/saxo] Token refresh failed — marked disconnected");
  }
}
