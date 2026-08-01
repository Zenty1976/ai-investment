/**
 * Portfolio Manager
 *
 * Fetches the user's open net positions from Saxo Bank and stores a
 * normalised snapshot in the shared Analysis Repository. No OpenAI is used.
 *
 * Endpoints:
 *   GET  /portfolio-manager        → latest stored snapshot (or null)
 *   POST /portfolio-manager/update → fetch fresh data from Saxo, store & return
 */

import { Router } from "express";
import { analysisRepository } from "../lib/analysis-repository.js";
import { saxoStore } from "../lib/saxo-store.js";
import { logger } from "../lib/logger.js";

const portfolioRouter = Router();

const MODULE_NAME = "portfolio-manager";

// ── Saxo base URLs ────────────────────────────────────────────────────────────

function saxoBaseUrl(env: "sim" | "live"): string {
  return env === "live"
    ? "https://gateway.saxobank.com/openapi"
    : "https://gateway.saxobank.com/sim/openapi";
}

// ── Saxo response types (raw — defensive, all fields optional) ────────────────

interface SaxoNetPosition {
  NetPositionId?: string;
  DisplayAndFormat?: {
    Description?: string;
    Symbol?: string;
    Currency?: string;
  };
  Exchange?: {
    Name?: string;
    ExchangeId?: string;
  };
  NetPositionBase?: {
    AccountId?: string;
    Amount?: number;
    AssetType?: string;
    CanBeClosed?: boolean;
    IsMarketOpen?: boolean;
    OpeningDirection?: string;
    Uic?: number;
  };
  NetPositionView?: {
    AverageOpenPrice?: number;
    CurrentPrice?: number;
    CurrentPriceDelayMinutes?: number;
    Exposure?: number;
    ExposureInBaseCurrency?: number;
    InstrumentPriceDayPercentChange?: number;
    ProfitLossOnTrade?: number;
    TradeCostsTotal?: number;
    Status?: string;
  };
}

interface SaxoNetPositionsResponse {
  Data?: SaxoNetPosition[];
  __count?: number;
  __next?: string;
}

// ── Internal portfolio types ──────────────────────────────────────────────────

export interface PortfolioPosition {
  id: string;
  name: string;
  symbol: string;
  assetType: string;
  exchange: string;
  currency: string;
  accountId: string;
  quantity: number;
  direction: string;
  averageOpenPrice: number;
  currentPrice: number;
  marketValue: number;
  marketValueBaseCurrency: number;
  profitLoss: number;
  dayChangePercent: number;
  priceDelayMinutes: number;
  isMarketOpen: boolean;
}

export interface PortfolioSnapshot {
  updatedAt: string;
  environment: "sim" | "live";
  positions: PortfolioPosition[];
}

// ── Fetch all pages from Saxo ─────────────────────────────────────────────────

async function fetchAllNetPositions(
  accessToken: string,
  env: "sim" | "live"
): Promise<SaxoNetPosition[]> {
  const base = saxoBaseUrl(env);
  const fieldGroups = "NetPositionBase,NetPositionView,DisplayAndFormat,ExchangeInfo";
  let url: string | undefined =
    `${base}/port/v1/netpositions/me?FieldGroups=${encodeURIComponent(fieldGroups)}`;
  const all: SaxoNetPosition[] = [];

  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Saxo API error (${res.status}): ${text}`);
    }

    const data = (await res.json()) as SaxoNetPositionsResponse;
    if (Array.isArray(data.Data)) {
      all.push(...data.Data);
    }
    url = data.__next ?? undefined;
  }

  return all;
}

// ── Normalise raw Saxo position → internal format ─────────────────────────────

function normalise(raw: SaxoNetPosition): PortfolioPosition {
  const base = raw.NetPositionBase ?? {};
  const view = raw.NetPositionView ?? {};
  const fmt = raw.DisplayAndFormat ?? {};
  const exch = raw.Exchange ?? {};

  const quantity = base.Amount ?? 0;
  const currentPrice = view.CurrentPrice ?? 0;
  const exposure = view.ExposureInBaseCurrency ?? view.Exposure ?? quantity * currentPrice;

  return {
    id: raw.NetPositionId ?? crypto.randomUUID(),
    name: fmt.Description ?? fmt.Symbol ?? "Unknown",
    symbol: fmt.Symbol ?? "",
    assetType: base.AssetType ?? "",
    exchange: exch.Name ?? exch.ExchangeId ?? "",
    currency: fmt.Currency ?? "",
    accountId: base.AccountId ?? "",
    quantity,
    direction: base.OpeningDirection ?? "",
    averageOpenPrice: view.AverageOpenPrice ?? 0,
    currentPrice,
    marketValue: view.Exposure ?? quantity * currentPrice,
    marketValueBaseCurrency: exposure,
    profitLoss: view.ProfitLossOnTrade ?? 0,
    dayChangePercent: view.InstrumentPriceDayPercentChange ?? 0,
    priceDelayMinutes: view.CurrentPriceDelayMinutes ?? 0,
    isMarketOpen: base.IsMarketOpen ?? false,
  };
}

// ── GET /portfolio-manager ────────────────────────────────────────────────────

portfolioRouter.get("/portfolio-manager", (_req, res) => {
  const entry = analysisRepository.get<PortfolioSnapshot>(MODULE_NAME);
  if (!entry) {
    res.json(null);
    return;
  }
  res.json(entry);
});

// ── POST /portfolio-manager/update ────────────────────────────────────────────

portfolioRouter.post("/portfolio-manager/update", async (_req, res) => {
  // Guard: must be connected
  if (!saxoStore.isConnected()) {
    res.status(401).json({
      error: "Not connected to Saxo Bank. Go to Settings and log in first.",
    });
    return;
  }

  const accessToken = saxoStore.getAccessToken();
  if (!accessToken) {
    res.status(401).json({ error: "No access token available." });
    return;
  }

  const env = saxoStore.getEnvironment();

  try {
    const rawPositions = await fetchAllNetPositions(accessToken, env);
    logger.info({ count: rawPositions.length, env }, "[portfolio-manager] Fetched positions from Saxo");

    const positions = rawPositions.map(normalise);
    const snapshot: PortfolioSnapshot = {
      updatedAt: new Date().toISOString(),
      environment: env,
      positions,
    };

    const entry = analysisRepository.save<PortfolioSnapshot>(MODULE_NAME, snapshot);
    res.json(entry);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[portfolio-manager] Failed to fetch from Saxo");

    // Return the stored snapshot alongside the error so the frontend can
    // keep showing the last known data while surfacing the new error.
    const stored = analysisRepository.get<PortfolioSnapshot>(MODULE_NAME);
    res.status(502).json({
      error: message,
      stored: stored ?? null,
    });
  }
});

export default portfolioRouter;
