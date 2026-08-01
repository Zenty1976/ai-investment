/**
 * Saxo Bank configuration helper
 *
 * Reads SAXO_APP_KEY, SAXO_APP_SECRET, and SAXO_ENVIRONMENT from the
 * environment. The secret is read only when needed for server-side operations
 * (token exchange / refresh) and is never returned through any API endpoint.
 *
 * SAXO_ENVIRONMENT must be "sim" (Simulation) or "live" (Production).
 * Defaults to "sim" if not set.
 */

export type SaxoEnvironment = "sim" | "live";

export interface SaxoAuthUrls {
  authorizeUrl: string;
  tokenUrl: string;
}

const AUTH_URLS: Record<SaxoEnvironment, SaxoAuthUrls> = {
  sim: {
    authorizeUrl: "https://sim.logonvalidation.net/authorize",
    tokenUrl: "https://sim.logonvalidation.net/token",
  },
  live: {
    authorizeUrl: "https://live.logonvalidation.net/authorize",
    tokenUrl: "https://live.logonvalidation.net/token",
  },
};

/** Returns true/false flags for whether each credential is configured. */
export function getSaxoConfigStatus(): {
  appKeyConfigured: boolean;
  appSecretConfigured: boolean;
  environment: SaxoEnvironment;
} {
  const rawEnv = process.env["SAXO_ENVIRONMENT"]?.toLowerCase();
  const environment: SaxoEnvironment =
    rawEnv === "live" ? "live" : "sim";

  return {
    appKeyConfigured: !!process.env["SAXO_APP_KEY"],
    appSecretConfigured: !!process.env["SAXO_APP_SECRET"],
    environment,
  };
}

/**
 * Returns the App Key for use in authorization requests.
 * Throws if not configured.
 */
export function getAppKey(): string {
  const key = process.env["SAXO_APP_KEY"];
  if (!key) throw new Error("SAXO_APP_KEY is not configured");
  return key;
}

/**
 * Returns the App Secret for use in token exchange / refresh.
 * Call only server-side — never send the return value to the frontend.
 * Throws if not configured.
 */
export function getAppSecret(): string {
  const secret = process.env["SAXO_APP_SECRET"];
  if (!secret) throw new Error("SAXO_APP_SECRET is not configured");
  return secret;
}

/** Returns the Saxo authorization and token endpoint URLs for the given environment. */
export function getAuthUrls(environment: SaxoEnvironment): SaxoAuthUrls {
  return AUTH_URLS[environment];
}

/**
 * Exchanges an authorization code for access + refresh tokens.
 * Performed entirely on the server — the App Secret never leaves the backend.
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  environment: SaxoEnvironment
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
  const { tokenUrl } = getAuthUrls(environment);
  const appKey = getAppKey();
  const appSecret = getAppSecret();

  const credentials = Buffer.from(`${appKey}:${appSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const expiresAt = new Date(
    Date.now() + data.expires_in * 1000
  ).toISOString();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
  };
}

/**
 * Refreshes an access token using the stored refresh token.
 * Performed entirely on the server — the App Secret never leaves the backend.
 */
export async function refreshAccessToken(
  refreshToken: string,
  environment: SaxoEnvironment
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
  const { tokenUrl } = getAuthUrls(environment);
  const appKey = getAppKey();
  const appSecret = getAppSecret();

  const credentials = Buffer.from(`${appKey}:${appSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const expiresAt = new Date(
    Date.now() + data.expires_in * 1000
  ).toISOString();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
  };
}
