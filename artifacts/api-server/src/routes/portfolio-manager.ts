/**
 * Portfolio Manager
 *
 * Fetches all accounts, their balances, and net positions from Saxo Bank.
 * Stores a normalised multi-account snapshot in the shared Analysis Repository.
 * No OpenAI is used.
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

// ── Saxo raw response types (all fields optional — parse defensively) ─────────

interface SaxoAccount {
  AccountKey?: string;
  AccountId?: string;
  DisplayName?: string;
  AccountType?: string;
  Currency?: string;
}

interface SaxoBalance {
  CashBalance?: number;
  CashAvailableForTrading?: number;
  MarginAvailableForTrading?: number;
  TotalValue?: number;
  UnrealizedPositionsValue?: number;
  /** Some Saxo environments expose this instead */
  InitialMarginAvailable?: number;
}

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

interface SaxoListResponse<T> {
  Data?: T[];
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
  /** AccountKey this position belongs to */
  accountKey: string;
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

export interface PortfolioAccount {
  accountKey: string;
  accountId: string;
  accountName: string;
  accountType: string;
  currency: string;
  availableCash: number;
  accountValue: number;
  unrealizedProfitLoss: number;
  positions: PortfolioPosition[];
}

export interface PortfolioSnapshot {
  updatedAt: string;
  environment: "sim" | "live";
  /** Base currency of the primary account */
  baseCurrency: string;
  /** Sum of accountValue across all accounts */
  totalValue: number;
  /** Sum of availableCash across all accounts */
  totalAvailableCash: number;
  /** Sum of unrealizedProfitLoss across all accounts */
  totalUnrealizedProfitLoss: number;
  accounts: PortfolioAccount[];
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function saxoGet<T>(
  url: string,
  accessToken: string
): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Saxo API error (${res.status}) ${url}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/** Fetch all pages following __next links. */
async function saxoGetAll<T>(
  firstUrl: string,
  accessToken: string
): Promise<T[]> {
  const all: T[] = [];
  let url: string | undefined = firstUrl;
  while (url) {
    const data = await saxoGet<SaxoListResponse<T>>(url, accessToken);
    if (Array.isArray(data.Data)) all.push(...data.Data);
    url = data.__next ?? undefined;
  }
  return all;
}

// ── Normalise raw position ────────────────────────────────────────────────────

function normalisePosition(
  raw: SaxoNetPosition,
  accountKey: string
): PortfolioPosition {
  const base = raw.NetPositionBase ?? {};
  const view = raw.NetPositionView ?? {};
  const fmt  = raw.DisplayAndFormat ?? {};
  const exch = raw.Exchange ?? {};

  const quantity     = base.Amount ?? 0;
  const currentPrice = view.CurrentPrice ?? 0;
  const marketValue  =
    view.Exposure !== undefined ? view.Exposure : quantity * currentPrice;
  const marketValueBaseCurrency =
    view.ExposureInBaseCurrency !== undefined
      ? view.ExposureInBaseCurrency
      : marketValue;

  return {
    id:                     raw.NetPositionId ?? crypto.randomUUID(),
    name:                   fmt.Description ?? fmt.Symbol ?? "Unknown",
    symbol:                 fmt.Symbol ?? "",
    assetType:              base.AssetType ?? "",
    exchange:               exch.Name ?? exch.ExchangeId ?? "",
    currency:               fmt.Currency ?? "",
    accountKey,
    quantity,
    direction:              base.OpeningDirection ?? "",
    averageOpenPrice:       view.AverageOpenPrice ?? 0,
    currentPrice,
    marketValue,
    marketValueBaseCurrency,
    profitLoss:             view.ProfitLossOnTrade ?? 0,
    dayChangePercent:       view.InstrumentPriceDayPercentChange ?? 0,
    priceDelayMinutes:      view.CurrentPriceDelayMinutes ?? 0,
    isMarketOpen:           base.IsMarketOpen ?? false,
  };
}

// ── Build snapshot ────────────────────────────────────────────────────────────

async function buildSnapshot(
  accessToken: string,
  env: "sim" | "live"
): Promise<PortfolioSnapshot> {
  const base = saxoBaseUrl(env);
  const fieldGroups = "NetPositionBase,NetPositionView,DisplayAndFormat,ExchangeInfo";

  // 1. Fetch all accounts
  const saxoAccounts = await saxoGetAll<SaxoAccount>(
    `${base}/port/v1/accounts/me`,
    accessToken
  );

  if (saxoAccounts.length === 0) {
    return {
      updatedAt: new Date().toISOString(),
      environment: env,
      baseCurrency: "",
      totalValue: 0,
      totalAvailableCash: 0,
      totalUnrealizedProfitLoss: 0,
      accounts: [],
    };
  }

  // 2. Fetch all net positions once (one call, then group by accountKey)
  const allRawPositions = await saxoGetAll<SaxoNetPosition>(
    `${base}/port/v1/netpositions/me?FieldGroups=${encodeURIComponent(fieldGroups)}`,
    accessToken
  );

  // Group positions by the AccountId stored on the position (= AccountKey of the account)
  const positionsByAccountKey = new Map<string, SaxoNetPosition[]>();
  for (const p of allRawPositions) {
    const key = p.NetPositionBase?.AccountId ?? "";
    if (!positionsByAccountKey.has(key)) positionsByAccountKey.set(key, []);
    positionsByAccountKey.get(key)!.push(p);
  }

  // 3. Fetch balance for each account in parallel
  const balances = await Promise.all(
    saxoAccounts.map(async (acct): Promise<SaxoBalance> => {
      const key = acct.AccountKey ?? "";
      if (!key) return {};
      try {
        return await saxoGet<SaxoBalance>(
          `${base}/port/v1/balances?AccountKey=${encodeURIComponent(key)}`,
          accessToken
        );
      } catch (err) {
        logger.warn({ err, accountKey: key }, "[portfolio-manager] Failed to fetch balance for account");
        return {};
      }
    })
  );

  // 4. Assemble per-account objects
  const accounts: PortfolioAccount[] = saxoAccounts.map((acct, i) => {
    const accountKey = acct.AccountKey ?? "";
    const bal = balances[i];

    const rawPositions = positionsByAccountKey.get(accountKey) ?? [];
    const positions = rawPositions.map((p) => normalisePosition(p, accountKey));

    const availableCash =
      bal.CashAvailableForTrading ??
      bal.MarginAvailableForTrading ??
      bal.CashBalance ??
      0;

    const unrealizedProfitLoss =
      bal.UnrealizedPositionsValue ??
      positions.reduce((s, p) => s + p.profitLoss, 0);

    return {
      accountKey,
      accountId:            acct.AccountId ?? "",
      accountName:          acct.DisplayName ?? acct.AccountId ?? accountKey,
      accountType:          acct.AccountType ?? "",
      currency:             acct.Currency ?? "",
      availableCash,
      accountValue:         bal.TotalValue ?? 0,
      unrealizedProfitLoss,
      positions,
    };
  });

  // 5. Compute portfolio totals
  const totalValue               = accounts.reduce((s, a) => s + a.accountValue, 0);
  const totalAvailableCash       = accounts.reduce((s, a) => s + a.availableCash, 0);
  const totalUnrealizedProfitLoss = accounts.reduce((s, a) => s + a.unrealizedProfitLoss, 0);
  const baseCurrency             = saxoAccounts[0]?.Currency ?? "";

  logger.info(
    { accounts: accounts.length, positions: allRawPositions.length, env },
    "[portfolio-manager] Snapshot built"
  );

  return {
    updatedAt: new Date().toISOString(),
    environment: env,
    baseCurrency,
    totalValue,
    totalAvailableCash,
    totalUnrealizedProfitLoss,
    accounts,
  };
}

// ── GET /portfolio-manager ────────────────────────────────────────────────────

portfolioRouter.get("/portfolio-manager", (_req, res) => {
  const entry = analysisRepository.get<PortfolioSnapshot>(MODULE_NAME);
  res.json(entry ?? null);
});

// ── POST /portfolio-manager/update ────────────────────────────────────────────

portfolioRouter.post("/portfolio-manager/update", async (_req, res) => {
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
    const snapshot = await buildSnapshot(accessToken, env);
    const entry = analysisRepository.save<PortfolioSnapshot>(MODULE_NAME, snapshot);
    res.json(entry);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[portfolio-manager] Failed to build snapshot");

    const stored = analysisRepository.get<PortfolioSnapshot>(MODULE_NAME);
    res.status(502).json({ error: message, stored: stored ?? null });
  }
});

export default portfolioRouter;
