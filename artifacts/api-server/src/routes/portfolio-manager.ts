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
import { systemLog } from "../lib/system-log.js";

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
  ClientKey?: string;
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
  /** Base currency of the account/client (present on client-level balance) */
  Currency?: string;
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

  // 1. Fetch all accounts + client-level balance in parallel
  const [saxoAccounts, clientBalance] = await Promise.all([
    saxoGetAll<SaxoAccount>(`${base}/port/v1/accounts/me`, accessToken),
    saxoGet<SaxoBalance>(`${base}/port/v1/balances/me`, accessToken).catch((err) => {
      logger.warn({ err }, "[portfolio-manager] Failed to fetch client-level balance");
      return {} as SaxoBalance;
    }),
  ]);

  if (saxoAccounts.length === 0) {
    return {
      updatedAt: new Date().toISOString(),
      environment: env,
      baseCurrency: clientBalance.Currency ?? "",
      totalValue: clientBalance.TotalValue ?? 0,
      totalAvailableCash:
        clientBalance.CashAvailableForTrading ??
        clientBalance.MarginAvailableForTrading ??
        clientBalance.CashBalance ??
        0,
      totalUnrealizedProfitLoss: 0,
      accounts: [],
    };
  }

  // 2. For each account, fetch its positions and balance in parallel.
  //    Positions are fetched per-account using AccountKey + ClientKey so
  //    they are directly assigned — no post-hoc grouping by AccountId.
  const accounts: PortfolioAccount[] = await Promise.all(
    saxoAccounts.map(async (acct): Promise<PortfolioAccount> => {
      const accountKey = acct.AccountKey ?? "";
      const clientKey  = acct.ClientKey  ?? "";

      const positionsUrl = new URL(`${base}/port/v1/netpositions/me`);
      positionsUrl.searchParams.set("FieldGroups", fieldGroups);
      if (accountKey) positionsUrl.searchParams.set("AccountKey", accountKey);
      if (clientKey)  positionsUrl.searchParams.set("ClientKey",  clientKey);

      const balUrl = new URL(`${base}/port/v1/balances`);
      if (accountKey) balUrl.searchParams.set("AccountKey", accountKey);
      if (clientKey)  balUrl.searchParams.set("ClientKey",  clientKey);

      const [rawPositions, bal] = await Promise.all([
        saxoGetAll<SaxoNetPosition>(positionsUrl.toString(), accessToken).catch((err) => {
          logger.warn({ err, accountKey }, "[portfolio-manager] Failed to fetch positions for account");
          return [] as SaxoNetPosition[];
        }),
        saxoGet<SaxoBalance>(balUrl.toString(), accessToken).catch((err) => {
          logger.warn({ err, accountKey }, "[portfolio-manager] Failed to fetch balance for account");
          return {} as SaxoBalance;
        }),
      ]);

      const positions = rawPositions.map((p) => normalisePosition(p, accountKey));

      // Fix 3: unrealizedProfitLoss = sum of positions' ProfitLossOnTrade only —
      // UnrealizedPositionsValue includes position market value, not just P/L.
      const unrealizedProfitLoss = positions.reduce((s, p) => s + p.profitLoss, 0);

      const availableCash =
        bal.CashAvailableForTrading ??
        bal.MarginAvailableForTrading ??
        bal.CashBalance ??
        0;

      return {
        accountKey,
        accountId:           acct.AccountId ?? "",
        accountName:         acct.DisplayName ?? acct.AccountId ?? accountKey,
        accountType:         acct.AccountType ?? "",
        currency:            acct.Currency ?? "",
        availableCash,
        accountValue:        bal.TotalValue ?? 0,
        unrealizedProfitLoss,
        positions,
      };
    })
  );

  // 3. Portfolio totals come from the client-level balance (Fix 2):
  //    cross-currency account values must not be summed directly.
  const baseCurrency      = clientBalance.Currency ?? saxoAccounts[0]?.Currency ?? "";
  const totalValue        = clientBalance.TotalValue ?? accounts.reduce((s, a) => s + a.accountValue, 0);
  const totalAvailableCash =
    clientBalance.CashAvailableForTrading ??
    clientBalance.MarginAvailableForTrading ??
    clientBalance.CashBalance ??
    accounts.reduce((s, a) => s + a.availableCash, 0);
  // Sum ProfitLossOnTrade across all positions for the aggregate P/L total
  // (consistent with Fix 3; Saxo converts each position to base currency in ExposureInBaseCurrency,
  //  but ProfitLossOnTrade is already in base currency for the client-level roll-up).
  const totalUnrealizedProfitLoss = accounts.reduce(
    (s, a) => s + a.unrealizedProfitLoss,
    0
  );

  const totalPositions = accounts.reduce((s, a) => s + a.positions.length, 0);
  logger.info(
    { accounts: accounts.length, positions: totalPositions, env },
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
  systemLog.logUser("Portfolio Manager", "User manually started portfolio update");

  try {
    const snapshot = await buildSnapshot(accessToken, env);
    const totalPositions = snapshot.accounts.reduce((s, a) => s + a.positions.length, 0);
    if (totalPositions === 0) {
      systemLog.logWarning("Portfolio Manager", "Saxo returned no open positions");
    }
    const cashStr = snapshot.totalAvailableCash.toLocaleString("da-DK", { maximumFractionDigits: 0 });
    systemLog.logInfo(
      "Portfolio Manager",
      `Portfolio updated from Saxo: ${snapshot.accounts.length} account${snapshot.accounts.length !== 1 ? "s" : ""}, ${totalPositions} position${totalPositions !== 1 ? "s" : ""}, available cash ${cashStr} ${snapshot.baseCurrency}`
    );
    const entry = analysisRepository.save<PortfolioSnapshot>(MODULE_NAME, snapshot);
    res.json(entry);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[portfolio-manager] Failed to build snapshot");
    systemLog.logError("Portfolio Manager", `Portfolio update failed: ${message}`);

    const stored = analysisRepository.get<PortfolioSnapshot>(MODULE_NAME);
    res.status(502).json({ error: message, stored: stored ?? null });
  }
});

export default portfolioRouter;
