/**
 * Portfolio Manager
 *
 * Fetches all accounts, their balances, and net positions from Saxo Bank.
 * Stores a normalised multi-account snapshot in the shared Analysis Repository.
 * No OpenAI is used for the primary snapshot.
 *
 * After every successful snapshot a non-blocking v2 "CIO pass" enriches the
 * result with:
 *  - Portfolio health score (deterministic)
 *  - AI-synthesised target portfolio
 *  - Drift analysis vs target
 *  - Capital allocation plan
 *  - Replacement opportunity detection
 *  - Change explanation vs previous target
 *
 * Endpoints:
 *   GET  /portfolio-manager         → latest stored snapshot (or null)
 *   POST /portfolio-manager/update  → fetch fresh Saxo data, store & return
 *   GET  /portfolio-manager/v2      → latest v2 CIO analysis (or null)
 *   GET  /portfolio-manager/history → v2 history log (capped at 90 entries)
 */

import { Router } from "express";
import { analysisRepository } from "../lib/analysis-repository.js";
import { saxoStore } from "../lib/saxo-store.js";
import { logger } from "../lib/logger.js";
import { systemLog } from "../lib/system-log.js";
import { computePortfolioHealth } from "../lib/portfolio-health-engine.js";
import { synthesiseTargetPortfolio } from "../lib/portfolio-target-synthesiser.js";
import { detectDrift } from "../lib/portfolio-drift-detector.js";
import { computeCapitalAllocation } from "../lib/portfolio-capital-allocation-engine.js";
import { detectReplacements } from "../lib/portfolio-replacement-detector.js";
import { explainChanges } from "../lib/portfolio-change-explainer.js";
import { appendV2HistoryEntry } from "../lib/portfolio-history-writer.js";
import type { PortfolioV2, PortfolioV2HistoryEntry } from "../lib/portfolio-manager-v2-types.js";
import {
  mockAccounts,
  mockClientBalance,
  mockAccountBalances,
  mockAccountPositions,
  FX_USD_DKK,
} from "../lib/saxo-mock-data.js";

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
  /**
   * Client-level total value in base currency, taken from the Saxo client-level
   * balance. null when the field was absent — never a cross-currency sum.
   */
  totalValue: number | null;
  /**
   * Client-level available cash in base currency, taken from the Saxo
   * client-level balance. null when the field was absent.
   */
  totalAvailableCash: number | null;
  /** Sum of per-position P/L converted to base currency via the FX ratio. */
  totalUnrealizedProfitLoss: number;
  accounts: PortfolioAccount[];
  /** True when this snapshot was built from mock data, not the real Saxo API */
  isMockData?: boolean;
  /**
   * CIO (v2) enrichment — populated asynchronously after every snapshot.
   * Present when the v2 analysis has completed; absent on the very first run
   * before v2 has finished, or when it has been disabled.
   */
  v2?: PortfolioV2;
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
    const data: SaxoListResponse<T> = await saxoGet<SaxoListResponse<T>>(url, accessToken);
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
  const baseCurrency       = clientBalance.Currency ?? saxoAccounts[0]?.Currency ?? "";
  // Use client-level fields only — summing across accounts is wrong when
  // accounts are denominated in different currencies.
  const totalValue: number | null         = clientBalance.TotalValue ?? null;
  const totalAvailableCash: number | null =
    clientBalance.CashAvailableForTrading ??
    clientBalance.MarginAvailableForTrading ??
    clientBalance.CashBalance ??
    null;
  // Roll up P/L to base currency by using the implied FX rate Saxo already
  // provides: ExposureInBaseCurrency / Exposure gives the rate for each position.
  // Summing account.unrealizedProfitLoss directly is wrong when accounts are in
  // different currencies — it would mix DKK and USD (or any other pair).
  const totalUnrealizedProfitLoss = accounts.reduce((total, acct) => {
    return total + acct.positions.reduce((sum, pos) => {
      // marketValue === 0 means no FX ratio can be derived; exclude this
      // position rather than adding an account-currency value to a base-currency
      // total. The position-level profitLoss stays unchanged in its own currency.
      if (pos.marketValue === 0) return sum;
      const fxRate = pos.marketValueBaseCurrency / pos.marketValue;
      return sum + pos.profitLoss * fxRate;
    }, 0);
  }, 0);

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
    isMockData: false,
  };
}

// ── Build snapshot from mock data ─────────────────────────────────────────────
//
// Replaces only the raw Saxo HTTP responses with mock data.
// Everything after the raw response (normalisePosition, account building,
// totals, repository storage, system logging) is the real pipeline unchanged.

function buildSnapshotFromMock(env: "sim" | "live"): PortfolioSnapshot {
  const accounts: PortfolioAccount[] = mockAccounts.map((acct) => {
    const accountKey = acct.AccountKey;
    const bal = mockAccountBalances[accountKey] ?? {};
    const rawPositions = mockAccountPositions[accountKey] ?? [];

    const positions = rawPositions.map((p) => normalisePosition(p as SaxoNetPosition, accountKey));
    const unrealizedProfitLoss = positions.reduce((s, p) => s + p.profitLoss, 0);
    const availableCash =
      (bal as SaxoBalance).CashAvailableForTrading ??
      (bal as SaxoBalance).CashBalance ??
      0;

    return {
      accountKey,
      accountId:           acct.AccountId,
      accountName:         acct.DisplayName,
      accountType:         acct.AccountType,
      currency:            acct.Currency,
      availableCash,
      accountValue:        (bal as SaxoBalance).TotalValue ?? 0,
      unrealizedProfitLoss,
      positions,
    };
  });

  const baseCurrency       = mockClientBalance.Currency;
  const totalValue         = mockClientBalance.TotalValue;
  const totalAvailableCash = mockClientBalance.CashAvailableForTrading;

  // Convert each account's unrealised P/L to the client base currency (DKK)
  // before summing — never add DKK and USD directly.
  const totalUnrealizedProfitLoss = accounts.reduce((s, a) => {
    const acctCurrency = mockAccounts.find((m) => m.AccountKey === a.accountKey)?.Currency ?? baseCurrency;
    const rate = acctCurrency === baseCurrency ? 1 : FX_USD_DKK;
    return s + a.unrealizedProfitLoss * rate;
  }, 0);

  return {
    updatedAt:               new Date().toISOString(),
    environment:             env,
    baseCurrency,
    totalValue,
    totalAvailableCash,
    totalUnrealizedProfitLoss,
    accounts,
    isMockData:              true,
  };
}

// ── V2 CIO pass ───────────────────────────────────────────────────────────────
// Runs non-blocking after every successful snapshot. Failures never affect the
// primary snapshot response.

const V2_MODULE_NAME    = "portfolio-manager-v2";
const V2_HISTORY_KEY    = "portfolio-manager-v2-history";

async function runV2Pass(snapshot: PortfolioSnapshot): Promise<void> {
  const startMs = Date.now();
  // Capture the exact snapshot version we were called with.
  // After the async AI call we re-check that this snapshot is still
  // the current one; if a newer update arrived in the meantime we
  // discard our result rather than overwriting a more recent v2.
  const snapshotUpdatedAt = snapshot.updatedAt;

  try {
    // ── 1. Health score (deterministic, synchronous) ────────────────────────
    const health = computePortfolioHealth(snapshot);

    // ── 2. Read context from other modules (all optional) ───────────────────
    const paEntry  = analysisRepository.get<Record<string, unknown>>("portfolio-analyzer");
    const riskEntry = analysisRepository.get<Record<string, unknown>>("risk-analyzer");
    const ofEntry  = analysisRepository.get<Record<string, unknown>>("opportunity-finder");

    const portfolioAnalyzerContext = paEntry
      ? JSON.stringify({
          mainConclusion: paEntry.result.mainConclusion,
          executiveSummary: paEntry.result.executiveSummary,
          overallRating: paEntry.result.overallRating,
          overallOutlook: paEntry.result.overallOutlook,
          strengths: paEntry.result.strengths,
          weaknesses: paEntry.result.weaknesses,
          topRisks: paEntry.result.topRisks,
          topOpportunities: paEntry.result.topOpportunities,
          positionComments: paEntry.result.positionComments,
        })
      : null;

    const riskContext = riskEntry
      ? JSON.stringify({
          executiveSummary: riskEntry.result.executiveSummary,
          overallRiskLevel: riskEntry.result.overallRiskLevel,
          riskScore: riskEntry.result.riskScore,
          topRisks: Array.isArray(riskEntry.result.topRisks)
            ? (riskEntry.result.topRisks as Array<Record<string, unknown>>).slice(0, 5).map(
                (r) => ({ title: r.title, category: r.category, severity: r.severity })
              )
            : [],
        })
      : null;

    type OFCandidate = {
      ticker: string;
      company: string;
      overallScore: number;
      priority?: string;
      investmentThesis?: string[];
      mainCatalyst?: string;
    };

    const ofCandidates: OFCandidate[] = [];
    const positionAttentions: Array<{ ticker: string; attention: "High" | "Medium" | "Low" }> = [];

    if (ofEntry && Array.isArray((ofEntry.result as Record<string, unknown>).topOpportunities)) {
      const raw = (ofEntry.result as Record<string, unknown>).topOpportunities as Array<Record<string, unknown>>;
      for (const c of raw) {
        if (c.ticker && typeof c.overallScore === "number") {
          ofCandidates.push({
            ticker: String(c.ticker),
            company: String(c.company ?? c.ticker),
            overallScore: c.overallScore,
            priority: c.priority as string | undefined,
            investmentThesis: Array.isArray(c.investmentThesis)
              ? (c.investmentThesis as string[]).slice(0, 2)
              : undefined,
            mainCatalyst: c.mainCatalyst as string | undefined,
          });
        }
      }
    }

    if (paEntry && Array.isArray((paEntry.result as Record<string, unknown>).positionComments)) {
      const raw = (paEntry.result as Record<string, unknown>).positionComments as Array<Record<string, unknown>>;
      for (const pc of raw) {
        if (pc.ticker && (pc.attention === "High" || pc.attention === "Medium" || pc.attention === "Low")) {
          positionAttentions.push({ ticker: String(pc.ticker), attention: pc.attention });
        }
      }
    }

    const opportunityContext = ofCandidates.length > 0
      ? JSON.stringify(ofCandidates.slice(0, 5).map((c) => ({
          ticker: c.ticker,
          company: c.company,
          overallScore: c.overallScore,
          mainCatalyst: c.mainCatalyst ?? "",
          investmentThesis: c.investmentThesis ?? [],
        })))
      : null;

    // ── 3. Build allowed-ticker set for synthesiser validation ───────────────
    // Only tickers currently held OR listed as OF candidates are permitted in
    // the target; the AI must not invent tickers.
    const allPositions = snapshot.accounts.flatMap((a) => a.positions);
    const allowedTickers = new Set<string>([
      ...allPositions.map((p) => p.symbol.toUpperCase().trim()),
      ...ofCandidates.map((c) => c.ticker.toUpperCase().trim()),
    ]);

    // ── 4. AI target synthesis (async — may take several seconds) ────────────
    const target = await synthesiseTargetPortfolio(
      snapshot,
      portfolioAnalyzerContext,
      riskContext,
      opportunityContext,
      allowedTickers
    );

    // ── 5. Version guard — discard if a newer snapshot has arrived ────────────
    // Between snapshot save and here a second POST /update may have run and
    // saved a newer snapshot with a different updatedAt. Publishing this v2
    // would associate it with the wrong (stale) snapshot.
    const currentSnapshot = analysisRepository.get<PortfolioSnapshot>(MODULE_NAME);
    if (currentSnapshot?.result?.updatedAt !== snapshotUpdatedAt) {
      logger.warn(
        { snapshotUpdatedAt, currentUpdatedAt: currentSnapshot?.result?.updatedAt },
        "[portfolio-manager-v2] Snapshot superseded during CIO pass — discarding stale v2 result"
      );
      return;
    }

    // ── 6. Drift detection ───────────────────────────────────────────────────
    const drift = detectDrift(snapshot, target);

    // ── 7. Capital allocation ────────────────────────────────────────────────
    const capitalAllocation = computeCapitalAllocation(snapshot, target);

    // ── 8. Replacement detection ─────────────────────────────────────────────
    const replacements = detectReplacements(snapshot, ofCandidates, positionAttentions);

    // ── 9. Change explanation vs previous target ─────────────────────────────
    const prevV2Entry = analysisRepository.get<PortfolioV2>(V2_MODULE_NAME);
    const previousTarget = prevV2Entry?.result?.target ?? null;
    const changes = explainChanges(target, previousTarget);

    // ── 10. Assemble v2 result ───────────────────────────────────────────────
    const v2: PortfolioV2 = {
      generatedAt:        new Date().toISOString(),
      durationMs:         Date.now() - startMs,
      snapshotUpdatedAt:  snapshotUpdatedAt,   // binds this result to its source snapshot
      health,
      target,
      drift,
      capitalAllocation,
      replacements,
      changes,
    };

    // ── 11. Persist (second version guard — re-check immediately before write) ─
    // A tiny window remains between the first guard and the write; check once
    // more so the write and the guard are as close together as possible.
    const latestBeforeWrite = analysisRepository.get<PortfolioSnapshot>(MODULE_NAME);
    if (latestBeforeWrite?.result?.updatedAt !== snapshotUpdatedAt) {
      logger.warn(
        { snapshotUpdatedAt },
        "[portfolio-manager-v2] Snapshot superseded just before persist — discarding stale v2 result"
      );
      return;
    }
    analysisRepository.save<PortfolioV2>(V2_MODULE_NAME, v2);

    // ── 12. History snapshot ─────────────────────────────────────────────────
    appendV2HistoryEntry(snapshot, v2);

    const driftHigh = drift.filter((d) => d.severity === "High").length;
    systemLog.logInfo(
      "Portfolio Manager v2",
      `CIO analysis complete — health ${v2.health.overall}/100 (${v2.health.grade})` +
        (driftHigh > 0 ? `, ${driftHigh} high-severity drift item${driftHigh === 1 ? "" : "s"}` : "")
    );
    logger.info(
      { durationMs: v2.durationMs, healthOverall: v2.health.overall, driftItems: drift.length },
      "[portfolio-manager-v2] CIO pass complete"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[portfolio-manager-v2] CIO pass failed");
    systemLog.logError("Portfolio Manager v2", `CIO analysis failed: ${message}`);
  }
}

// ── GET /portfolio-manager ────────────────────────────────────────────────────

portfolioRouter.get("/portfolio-manager", (_req, res) => {
  const entry = analysisRepository.get<PortfolioSnapshot>(MODULE_NAME);
  if (!entry) {
    res.json(null);
    return;
  }
  // Only embed v2 when it was computed for this exact snapshot version.
  // A mismatch means either the async pass hasn't finished yet (pending)
  // or a new snapshot has arrived but v2 hasn't been updated yet (stale).
  // In both cases we must not attach analysis of a different portfolio.
  const v2Entry = analysisRepository.get<PortfolioV2>(V2_MODULE_NAME);
  const v2IsCurrent =
    v2Entry?.result?.snapshotUpdatedAt === entry.result.updatedAt;
  const result: PortfolioSnapshot = v2IsCurrent
    ? { ...entry.result, v2: v2Entry!.result }
    : entry.result;
  res.json({ ...entry, result });
});

// ── GET /portfolio-manager/v2 ─────────────────────────────────────────────────
// Returns null when v2 does not correspond to the current snapshot
// (analysis is pending or no snapshot exists yet).

portfolioRouter.get("/portfolio-manager/v2", (_req, res) => {
  const snapshotEntry = analysisRepository.get<PortfolioSnapshot>(MODULE_NAME);
  if (!snapshotEntry) {
    res.json(null);
    return;
  }
  const v2Entry = analysisRepository.get<PortfolioV2>(V2_MODULE_NAME);
  const v2IsCurrent =
    v2Entry?.result?.snapshotUpdatedAt === snapshotEntry.result.updatedAt;
  // Return only the unwrapped PortfolioV2 result, not the RepositoryEntry wrapper,
  // so the response shape matches the declared client hook type (PortfolioV2 | null).
  res.json(v2IsCurrent ? v2Entry.result : null);
});

// ── GET /portfolio-manager/history ────────────────────────────────────────────

portfolioRouter.get("/portfolio-manager/history", (_req, res) => {
  const entry = analysisRepository.get<PortfolioV2HistoryEntry[]>(V2_HISTORY_KEY);
  res.json(entry?.result ?? []);
});

// ── POST /portfolio-manager/update ────────────────────────────────────────────

portfolioRouter.post("/portfolio-manager/update", async (req, res) => {
  const mockMode = saxoStore.isMockMode();

  // Saxo authentication is only required when not using mock data.
  if (!mockMode) {
    if (!saxoStore.isConnected()) {
      res.status(401).json({
        error: "Not connected to Saxo Bank. Go to Settings and log in first.",
      });
      return;
    }
    const token = saxoStore.getAccessToken();
    if (!token) {
      res.status(401).json({ error: "No access token available." });
      return;
    }
  }

  const accessToken = saxoStore.getAccessToken();
  const env = saxoStore.getEnvironment();
  const orchestratorTrigger = req.headers['x-orchestrator-trigger'];
  if (orchestratorTrigger) {
    systemLog.logInfo("Portfolio Manager", `Scheduled run (trigger: ${orchestratorTrigger})`);
  } else {
    systemLog.logUser("Portfolio Manager", "User manually started portfolio update");
  }

  try {
    if (mockMode) {
      systemLog.logWarning("Portfolio Manager", "Portfolio update is using mock Saxo data");
    }

    const snapshot = mockMode
      ? buildSnapshotFromMock(env)
      : await buildSnapshot(accessToken!, env);
    const totalPositions = snapshot.accounts.reduce((s, a) => s + a.positions.length, 0);
    if (totalPositions === 0) {
      systemLog.logWarning("Portfolio Manager", "Saxo returned no open positions");
    }
    const cashStr = (snapshot.totalAvailableCash ?? 0).toLocaleString("da-DK", { maximumFractionDigits: 0 });
    if (mockMode) {
      systemLog.logInfo("Portfolio Manager", `Mock portfolio loaded: ${snapshot.accounts.length} account${snapshot.accounts.length !== 1 ? "s" : ""}, ${totalPositions} position${totalPositions !== 1 ? "s" : ""}`);
    } else {
      systemLog.logInfo(
        "Portfolio Manager",
        `Portfolio updated from Saxo: ${snapshot.accounts.length} account${snapshot.accounts.length !== 1 ? "s" : ""}, ${totalPositions} position${totalPositions !== 1 ? "s" : ""}, available cash ${cashStr} ${snapshot.baseCurrency}`
      );
    }
    const entry = analysisRepository.save<PortfolioSnapshot>(MODULE_NAME, snapshot);
    if (mockMode) {
      systemLog.logInfo("Portfolio Manager", "Mock portfolio snapshot stored");
    }

    // ── Launch v2 CIO pass (non-blocking — never delays the primary response) ─
    void runV2Pass(snapshot);

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
