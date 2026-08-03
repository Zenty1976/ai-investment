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
import { computePortfolioHealth, type CmHealthData, type RiskHealthData, type TdeHealthData } from "../lib/portfolio-health-engine.js";
import { synthesiseTargetPortfolio, computeCioFingerprint, type CioInputContext } from "../lib/portfolio-target-synthesiser.js";
import { detectDrift } from "../lib/portfolio-drift-detector.js";
import { computeCapitalAllocation, type TdeCapitalData } from "../lib/portfolio-capital-allocation-engine.js";
import { detectReplacements, type CmReplacementData, type TdeReplacementData, type OpportunityCandidate } from "../lib/portfolio-replacement-detector.js";
import { explainChanges } from "../lib/portfolio-change-explainer.js";
import { appendV2HistoryEntry } from "../lib/portfolio-history-writer.js";
import type { PortfolioV2, PortfolioV2HistoryEntry, PortfolioV2Provenance } from "../lib/portfolio-manager-v2-types.js";
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

// ── Staleness thresholds for provenance ───────────────────────────────────────
// Sources older than these limits are marked as stale in provenance.
const STALE_HOURS_CRITICAL = 6;   // Portfolio Analyzer, Risk Analyzer
const STALE_HOURS_SECONDARY = 24; // Company Monitor, TDE, Sector, Alerts, Market Monitor

function ageHours(savedAt: string | undefined): number {
  if (!savedAt) return Infinity;
  return (Date.now() - new Date(savedAt).getTime()) / 3_600_000;
}

async function runV2Pass(snapshot: PortfolioSnapshot): Promise<void> {
  const startMs = Date.now();
  const snapshotUpdatedAt = snapshot.updatedAt;

  try {
    // ── 1. Read all strategic modules from repository ───────────────────────
    const paEntry       = analysisRepository.get<Record<string, unknown>>("portfolio-analyzer");
    const riskEntry     = analysisRepository.get<Record<string, unknown>>("risk-analyzer");
    const ofEntry       = analysisRepository.get<Record<string, unknown>>("opportunity-finder");
    const tdeEntry      = analysisRepository.get<Record<string, unknown>>("trade-decision-engine");
    const sectorEntry   = analysisRepository.get<Record<string, unknown>>("sector-monitor");
    const alertsEntry   = analysisRepository.get<Record<string, unknown>>("market-alerts");
    const mktMonEntry   = analysisRepository.get<Record<string, unknown>>("market-monitor");

    // Company Monitor: one entry per ticker, keyed "company-monitor:<TICKER>"
    const allCmEntries = analysisRepository.getAll().filter(
      (e) => e.moduleName.startsWith("company-monitor:")
    );

    // ── 2. Build per-ticker Company Monitor map ─────────────────────────────
    const companyMonitorByTicker = new Map<string, Record<string, unknown>>();
    for (const entry of allCmEntries) {
      const ticker = entry.moduleName.replace("company-monitor:", "").toUpperCase().trim();
      if (ticker) companyMonitorByTicker.set(ticker, entry.result as Record<string, unknown>);
    }

    // ── 3. Build per-ticker TDE map ─────────────────────────────────────────
    const tdeByTickerRaw = new Map<string, Record<string, unknown>>();
    if (tdeEntry && Array.isArray((tdeEntry.result as Record<string, unknown>).decisions)) {
      const decisions = (tdeEntry.result as Record<string, unknown>).decisions as Array<Record<string, unknown>>;
      for (const d of decisions) {
        if (d.ticker && typeof d.ticker === "string") {
          tdeByTickerRaw.set(d.ticker.toUpperCase().trim(), d);
        }
      }
    }

    // ── 4. Build Opportunity Finder candidate list ──────────────────────────
    const ofCandidates: OpportunityCandidate[] = [];
    if (ofEntry && Array.isArray((ofEntry.result as Record<string, unknown>).topOpportunities)) {
      const raw = (ofEntry.result as Record<string, unknown>).topOpportunities as Array<Record<string, unknown>>;
      for (const c of raw) {
        if (c.ticker && typeof c.overallScore === "number") {
          ofCandidates.push({
            ticker:                  String(c.ticker),
            company:                 String(c.company ?? c.ticker),
            overallScore:            c.overallScore,
            priority:                c.priority as string | undefined,
            investmentThesis:        Array.isArray(c.investmentThesis)
              ? (c.investmentThesis as string[]).slice(0, 2) : undefined,
            mainCatalyst:            c.mainCatalyst as string | undefined,
            sector:                  c.sector as string | undefined,
            rank:                    typeof c.rank === "number" ? c.rank : undefined,
            confidence:              c.confidence as string | undefined,
            companyAnalysisAvailable: Boolean(c.companyAnalysisAvailable),
          });
        }
      }
    }

    const allPositions   = snapshot.accounts.flatMap((a) => a.positions);
    const allowedTickers = new Set<string>([
      ...allPositions.map((p) => p.symbol.toUpperCase().trim()),
      ...ofCandidates.map((c) => c.ticker.toUpperCase().trim()),
    ]);

    // ── 4b. Relevant tickers = holdings + OF candidates + TDE subjects ─────
    // Company Monitor is only considered for these tickers in fingerprint,
    // provenance, and downstream engines. Unrelated stale CM entries must not
    // reduce target confidence or trigger a new AI synthesis.
    const relevantTickers = new Set<string>([
      ...allPositions.map((p) => p.symbol.toUpperCase().trim()),
      ...ofCandidates.map((c) => c.ticker.toUpperCase().trim()),
      ...[...tdeByTickerRaw.keys()],
    ]);

    // Filtered CM map — only relevant tickers
    const relevantCmByTicker = new Map<string, Record<string, unknown>>();
    for (const [ticker, cm] of companyMonitorByTicker) {
      if (relevantTickers.has(ticker)) relevantCmByTicker.set(ticker, cm);
    }

    // ── 5. Build sector-by-ticker map (CM sector → held tickers + OF cands) ─
    const sectorByTicker = new Map<string, string>();
    for (const [ticker, cm] of relevantCmByTicker) {
      const sector = (cm.company as Record<string, unknown> | undefined)?.sector as string | undefined
        ?? cm.sector as string | undefined;
      if (sector && sector.trim()) sectorByTicker.set(ticker, sector.trim());
    }
    // Also add OF candidate sectors when available
    for (const c of ofCandidates) {
      if (c.sector) sectorByTicker.set(c.ticker.toUpperCase().trim(), c.sector);
    }

    // ── 6. Build typed per-ticker maps for downstream engines ───────────────
    const cmHealthByTicker = new Map<string, CmHealthData>();
    for (const [ticker, cm] of relevantCmByTicker) {
      const iv = cm.investmentView as Record<string, unknown> | undefined;
      cmHealthByTicker.set(ticker, {
        ticker,
        sector:               sectorByTicker.get(ticker),
        investmentViewRating: iv?.rating as string | undefined,
        investmentCaseStrength: cm.investmentCaseStrength as number | undefined,
        confidence:           cm.confidence as string | undefined,
        updatedAt:            cm.updatedAt as string | undefined,
      });
    }

    const tdeHealthByTicker = new Map<string, TdeHealthData>();
    const tdeCapitalByTicker = new Map<string, TdeCapitalData>();
    const tdeReplacementByTicker = new Map<string, TdeReplacementData>();
    for (const [ticker, d] of tdeByTickerRaw) {
      tdeHealthByTicker.set(ticker, {
        ticker,
        blockedByEvent: d.blockedByEvent as boolean | undefined,
        readiness:      d.readiness as string | undefined,
      });
      tdeCapitalByTicker.set(ticker, {
        readiness:      String(d.readiness ?? "Informational"),
        blockedByEvent: Boolean(d.blockedByEvent),
        blockingEvent:  d.blockingEvent as string | undefined,
      });
      tdeReplacementByTicker.set(ticker, {
        decision:       d.decision as string | undefined,
        evidenceBand:   d.evidenceBand as string | undefined,
        readiness:      d.readiness as string | undefined,
        blockedByEvent: d.blockedByEvent as boolean | undefined,
      });
    }

    const cmReplacementByTicker = new Map<string, CmReplacementData>();
    for (const [ticker, cm] of relevantCmByTicker) {
      const iv = cm.investmentView as Record<string, unknown> | undefined;
      cmReplacementByTicker.set(ticker, {
        investmentCaseStrength: cm.investmentCaseStrength as number | undefined,
        investmentViewRating:   iv?.rating as string | undefined,
        investmentCaseChange:   cm.investmentCaseChange as CmReplacementData["investmentCaseChange"],
        thesisPointStatuses:    cm.investmentThesis as CmReplacementData["thesisPointStatuses"],
      });
    }

    const riskHealthData: RiskHealthData | undefined = riskEntry
      ? {
          topRisks: Array.isArray(riskEntry.result.topRisks)
            ? (riskEntry.result.topRisks as Array<Record<string, unknown>>).map((r) => ({
                ticker:   r.ticker as string | undefined,
                severity: r.severity as string | undefined,
                title:    r.title as string | undefined,
              }))
            : [],
          overallRiskLevel: riskEntry.result.overallRiskLevel as string | undefined,
        }
      : undefined;

    // ── 7. Compute deterministic input fingerprint ──────────────────────────
    // Uses RELEVANT CM entries only — unrelated stale analyses must not
    // trigger a new AI synthesis.  Each module contributes its material
    // strategic fields, not just timestamps, so a NoMaterialChange update
    // with identical content does NOT change the fingerprint.
    const sectorResult   = sectorEntry?.result  as Record<string, unknown> | undefined;
    const alertsResult   = alertsEntry?.result  as Record<string, unknown> | undefined;
    const mktResult      = mktMonEntry?.result  as Record<string, unknown> | undefined;
    const alertLevel     = alertsResult?.overallAlertLevel as string | undefined;

    const fingerprintInput = {
      // Portfolio positions (symbol + quantity, rounded value)
      positions: allPositions.map((p) => ({
        s: p.symbol.toUpperCase().trim(),
        q: p.quantity,
        v: Math.round(p.marketValueBaseCurrency / 1000),
      })).sort((a, b) => a.s.localeCompare(b.s)),
      cash:       Math.round((snapshot.totalAvailableCash ?? 0) / 1000),
      totalValue: Math.round((snapshot.totalValue ?? 0) / 1000),

      // Company Monitor — material strategic fields per RELEVANT ticker only.
      // updatedAt alone is intentionally excluded so NoMaterialChange updates
      // (same field values, different timestamp) don't force re-synthesis.
      cm: Object.fromEntries(
        [...relevantCmByTicker.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([ticker, cm]) => {
            const iv     = cm.investmentView     as Record<string, unknown> | undefined;
            const change = cm.investmentCaseChange as Record<string, unknown> | undefined;
            const thesis = cm.investmentThesis    as Array<Record<string, unknown>> | undefined;
            return [ticker, {
              updateType:       cm.updateType,
              strength:         cm.investmentCaseStrength,
              viewRating:       iv?.rating,
              viewOutlook:      iv?.outlook,
              caseChanged:      change?.changed,
              caseSeverity:     change?.severity,
              meaningfulChange: cm.meaningfulChange,
              thesisIds: thesis
                ?.map((t) => `${String(t.id ?? t.pointId ?? "")}:${String(t.status ?? "")}`)
                .sort() ?? [],
            }];
          })
      ),

      // Trade Decision Engine — full per-ticker decision fields
      tde: Object.fromEntries(
        [...tdeByTickerRaw.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([ticker, d]) => [ticker, {
            decision:           d.decision,
            readiness:          d.readiness,
            blockedByEvent:     d.blockedByEvent,
            blockingEvent:      d.blockingEvent,
            blockingEventDate:  d.blockingEventDate,
            confidence:         d.confidence,
            evidenceBand:       d.evidenceBand,
            targetAllocPct:     typeof d.targetAllocationPercent === "number"
              ? Math.round((d.targetAllocationPercent as number) * 2) / 2 : null,
          }])
      ),

      // Market Alerts — identity of meaningful alerts, not just the level.
      // Two "Medium" alerts with different content must produce different fingerprints.
      alerts: alertsResult ? {
        level:                    alertLevel,
        headline:                 alertsResult.headline,
        lastMeaningfulUpdateAt:   alertsResult.lastMeaningfulUpdateAt,
        topAlertKeys: Array.isArray(alertsResult.alerts)
          ? (alertsResult.alerts as Array<Record<string, unknown>>)
              .filter((a) => a.importance === "High" || a.requiresAttention)
              .map((a) => [
                String(a.title ?? ""),
                String(a.category ?? ""),
                String(a.importance ?? ""),
                ((a.affectedHoldings as string[] | undefined) ?? []).sort().join(","),
              ].join("|"))
              .sort()
              .slice(0, 15)
          : [],
      } : null,

      // Sector Monitor — outlook, top sector, all sector name/rating/trend
      sector: sectorResult ? {
        overallOutlook: sectorResult.overallOutlook,
        topSectorName:  (sectorResult.topSector as Record<string, string> | undefined)?.name,
        sectorKeys: Array.isArray(sectorResult.sectors)
          ? (sectorResult.sectors as Array<Record<string, unknown>>)
              .map((s) => `${String(s.name ?? "")}:${String(s.rating ?? "")}:${String(s.trend ?? "")}`)
              .sort()
          : [],
      } : null,

      // Market Monitor — sentiment, risk level, outlook version
      market: mktResult ? {
        overallOutlook: mktResult.overallOutlook,
        sentiment:      mktResult.marketSentiment ?? mktResult.sentiment,
        riskLevel:      mktResult.overallRiskLevel ?? mktResult.riskLevel,
      } : null,

      // Portfolio Analyzer — material conclusion fields
      pa: paEntry ? {
        rating:             paEntry.result.overallRating,
        outlook:            paEntry.result.overallOutlook,
        scoreBucket:        paEntry.result.portfolioScore != null
          ? Math.round((paEntry.result.portfolioScore as number) / 5) * 5 : null,
        conclusionTitle:    (paEntry.result.mainConclusion as Record<string, unknown> | undefined)?.title,
        topRiskCount:       Array.isArray(paEntry.result.topRisks) ? (paEntry.result.topRisks as unknown[]).length : 0,
        topOppsCount:       Array.isArray(paEntry.result.topOpportunities) ? (paEntry.result.topOpportunities as unknown[]).length : 0,
      } : null,

      // Risk Analyzer — risk level, score bucket, key risk titles
      risk: riskEntry ? {
        level:           riskEntry.result.overallRiskLevel,
        scoreBucket:     riskEntry.result.riskScore != null
          ? Math.round((riskEntry.result.riskScore as number) / 5) * 5 : null,
        conclusionTitle: (riskEntry.result.mainConclusion as Record<string, unknown> | undefined)?.title,
        topRiskKeys: Array.isArray(riskEntry.result.topRisks)
          ? (riskEntry.result.topRisks as Array<Record<string, unknown>>)
              .slice(0, 5)
              .map((r) => `${String(r.title ?? "")}:${String(r.severity ?? "")}`)
          : [],
      } : null,

      // Opportunity Finder — richer candidate identity (rank, score, confidence,
      // priority, catalyst prefix, company-analysis availability)
      of: ofCandidates
        .slice(0, 8)
        .map((c) => ({
          t:           c.ticker.toUpperCase(),
          rank:        c.rank,
          s:           Math.round(c.overallScore),
          conf:        c.confidence,
          pri:         c.priority,
          cat:         c.mainCatalyst?.slice(0, 50),
          hasAnalysis: c.companyAnalysisAvailable,
        }))
        .sort((a, b) => a.t.localeCompare(b.t)),
    };
    const inputFingerprint = computeCioFingerprint(fingerprintInput);

    // ── 8. Check whether AI synthesis can be skipped ────────────────────────
    const prevV2Entry     = analysisRepository.get<PortfolioV2>(V2_MODULE_NAME);
    const prevFingerprint = prevV2Entry?.result?.provenance?.inputFingerprint;
    const prevTarget      = prevV2Entry?.result?.target ?? null;

    let target: import("../lib/portfolio-manager-v2-types.js").TargetPortfolio;
    let aiSkipped = false;

    if (prevFingerprint === inputFingerprint && prevTarget) {
      // Fingerprint unchanged → reuse existing target; skip the AI call
      target = prevTarget;
      aiSkipped = true;
      logger.info(
        { fingerprint: inputFingerprint },
        "[portfolio-manager-v2] CIO inputs unchanged — reusing target, skipping AI synthesis"
      );
    } else {
      // ── 9. Build context strings for the AI synthesiser ──────────────────
      const suppliedModules = new Set<string>();

      const portfolioAnalyzerContext = paEntry
        ? (suppliedModules.add("PortfolioAnalyzer"), JSON.stringify({
            mainConclusion:   paEntry.result.mainConclusion,
            executiveSummary: paEntry.result.executiveSummary,
            overallRating:    paEntry.result.overallRating,
            overallOutlook:   paEntry.result.overallOutlook,
            strengths:        paEntry.result.strengths,
            weaknesses:       paEntry.result.weaknesses,
            topRisks:         paEntry.result.topRisks,
            topOpportunities: paEntry.result.topOpportunities,
            positionComments: paEntry.result.positionComments,
          }))
        : null;

      const riskContext = riskEntry
        ? (suppliedModules.add("RiskAnalyzer"), JSON.stringify({
            executiveSummary: riskEntry.result.executiveSummary,
            overallRiskLevel: riskEntry.result.overallRiskLevel,
            riskScore:        riskEntry.result.riskScore,
            topRisks: Array.isArray(riskEntry.result.topRisks)
              ? (riskEntry.result.topRisks as Array<Record<string, unknown>>).slice(0, 5).map(
                  (r) => ({ title: r.title, category: r.category, severity: r.severity, ticker: r.ticker })
                )
              : [],
          }))
        : null;

      // Company Monitor: build per-company context using the relevant-only map
      const cmContextItems: Record<string, unknown>[] = [];
      for (const [ticker, cm] of relevantCmByTicker) {
        const iv = cm.investmentView as Record<string, unknown> | undefined;
        cmContextItems.push({
          ticker,
          investmentView:          iv?.rating,
          investmentViewOutlook:   iv?.outlook,
          investmentCaseStrength:  cm.investmentCaseStrength,
          investmentCaseChange:    (cm.investmentCaseChange as Record<string, unknown> | undefined)?.severity,
          confidence:              cm.confidence,
          sector:                  (cm.company as Record<string, unknown> | undefined)?.sector,
          keyRisks:                (cm.risks as Array<Record<string, unknown>> | undefined)?.slice(0, 2).map(r => r.title),
          catalysts:               (cm.catalysts as Array<Record<string, unknown>> | undefined)?.slice(0, 2).map(c => c.title),
        });
      }
      const companyMonitorContext = cmContextItems.length > 0
        ? (suppliedModules.add("CompanyMonitor"), JSON.stringify(cmContextItems))
        : null;

      // Trade Decision Engine
      const tdeContext = tdeEntry && tdeByTickerRaw.size > 0
        ? (suppliedModules.add("TradeDecisionEngine"), JSON.stringify(
            [...tdeByTickerRaw.entries()].map(([ticker, d]) => ({
              ticker,
              decision:               d.decision,
              readiness:              d.readiness,
              blockedByEvent:         d.blockedByEvent,
              blockingEvent:          d.blockingEvent,
              evidenceBand:           d.evidenceBand,
              confidence:             d.confidence,
              targetAllocationPct:    d.targetAllocationPercent,
            }))
          ))
        : null;

      // Sector Monitor (top sectors only) — sectorResult already declared
      const sectorContext = sectorResult
        ? (suppliedModules.add("SectorMonitor"), JSON.stringify({
            executiveSummary: sectorResult.executiveSummary,
            overallOutlook:   sectorResult.overallOutlook,
            topSector:        sectorResult.topSector,
            sectors: Array.isArray(sectorResult.sectors)
              ? (sectorResult.sectors as Array<Record<string, unknown>>).slice(0, 8).map(
                  (s) => ({ name: s.name, rating: s.rating, trend: s.trend, summary: s.summary })
                )
              : [],
          }))
        : null;

      // Market Alerts — alertsResult / alertLevel already declared
      const alertsContext = alertsResult && (alertLevel === "High" || alertLevel === "Medium")
        ? (suppliedModules.add("MarketAlerts"), JSON.stringify({
            overallAlertLevel: alertLevel,
            headline:          alertsResult.headline,
            alerts: Array.isArray(alertsResult.alerts)
              ? (alertsResult.alerts as Array<Record<string, unknown>>)
                  .filter((a) => a.importance === "High" || a.requiresAttention)
                  .slice(0, 5)
                  .map((a) => ({ title: a.title, category: a.category, affectedHoldings: a.affectedHoldings, whyItMatters: a.whyItMatters }))
              : [],
          }))
        : null;

      // Market Monitor — mktResult already declared
      const marketContext = mktResult
        ? (suppliedModules.add("MarketMonitor"), JSON.stringify({
            executiveSummary: mktResult.executiveSummary,
            overallOutlook:   mktResult.overallOutlook,
          }))
        : null;

      const opportunityContext = ofCandidates.length > 0
        ? (suppliedModules.add("OpportunityFinder"), JSON.stringify(
            ofCandidates.slice(0, 6).map((c) => ({
              ticker:          c.ticker,
              company:         c.company,
              overallScore:    c.overallScore,
              mainCatalyst:    c.mainCatalyst ?? "",
              investmentThesis: c.investmentThesis ?? [],
              sector:          c.sector ?? "",
            }))
          ))
        : null;

      const ctx: CioInputContext = {
        portfolioAnalyzer: portfolioAnalyzerContext,
        risk:              riskContext,
        opportunities:     opportunityContext,
        companyMonitor:    companyMonitorContext,
        tradeDecision:     tdeContext,
        sectorMonitor:     sectorContext,
        marketAlerts:      alertsContext,
        marketMonitor:     marketContext,
      };

      // ── 10. AI target synthesis ─────────────────────────────────────────
      target = await synthesiseTargetPortfolio(snapshot, ctx, allowedTickers, suppliedModules);
    }

    // ── 11. Version guard — discard if snapshot was superseded ─────────────
    const currentSnapshot = analysisRepository.get<PortfolioSnapshot>(MODULE_NAME);
    if (currentSnapshot?.result?.updatedAt !== snapshotUpdatedAt) {
      logger.warn(
        { snapshotUpdatedAt, currentUpdatedAt: currentSnapshot?.result?.updatedAt },
        "[portfolio-manager-v2] Snapshot superseded during CIO pass — discarding stale v2 result"
      );
      return;
    }

    // ── 12. Build provenance ────────────────────────────────────────────────
    const sourceModulesUsed: string[] = [];
    const sourceUpdatedAt: Record<string, string> = {};
    const staleSources: string[] = [];
    const missingSources: string[] = [];

    const moduleChecks: Array<{
      key: string;
      entry: unknown;
      critical: boolean;
    }> = [
      { key: "PortfolioAnalyzer", entry: paEntry,      critical: true  },
      { key: "RiskAnalyzer",      entry: riskEntry,    critical: true  },
      { key: "OpportunityFinder", entry: ofEntry,      critical: false },
      { key: "TradeDecisionEngine", entry: tdeEntry,   critical: false },
      { key: "SectorMonitor",     entry: sectorEntry,  critical: false },
      { key: "MarketAlerts",      entry: alertsEntry,  critical: false },
      { key: "MarketMonitor",     entry: mktMonEntry,  critical: false },
    ];
    for (const { key, entry, critical } of moduleChecks) {
      if (!entry) {
        missingSources.push(key);
        continue;
      }
      sourceModulesUsed.push(key);
      const savedAt = (entry as unknown as { savedAt?: string }).savedAt ?? "";
      sourceUpdatedAt[key] = savedAt;
      const staleLimit = critical ? STALE_HOURS_CRITICAL : STALE_HOURS_SECONDARY;
      if (ageHours(savedAt) > staleLimit) staleSources.push(key);
    }
    // Add per-ticker Company Monitor entries — RELEVANT tickers only.
    // Unrelated stale CM analyses must not reduce target confidence.
    for (const [ticker, cm] of relevantCmByTicker) {
      const key = `CompanyMonitor:${ticker}`;
      sourceModulesUsed.push(key);
      const updatedAt = (cm.updatedAt ?? "") as string;
      sourceUpdatedAt[key] = updatedAt;
      if (ageHours(updatedAt) > STALE_HOURS_SECONDARY) staleSources.push(key);
    }
    if (relevantCmByTicker.size === 0) missingSources.push("CompanyMonitor");

    const criticalStale = staleSources.some((k) => k === "PortfolioAnalyzer" || k === "RiskAnalyzer");
    const criticalMissing = missingSources.includes("PortfolioAnalyzer") || missingSources.includes("RiskAnalyzer");
    const targetConfidence: "High" | "Medium" | "Low" =
      criticalMissing || criticalStale ? "Low" :
      (staleSources.length > 2 || missingSources.length > 2) ? "Medium" : "High";

    const provenance: PortfolioV2Provenance = {
      sourceModulesUsed,
      sourceUpdatedAt,
      staleSources,
      missingSources,
      targetConfidence,
      inputFingerprint,
    };

    // ── 13. Drift detection (uses CM sector map) ─────────────────────────────
    const drift = detectDrift(snapshot, target, sectorByTicker);

    // ── 14. Capital allocation (gates on allocationStatus + TDE readiness) ───
    const capitalAllocation = computeCapitalAllocation(snapshot, target, tdeCapitalByTicker);

    // ── 15. Replacement detection (CM + TDE evidence) ───────────────────────
    const replacements = detectReplacements(
      snapshot, ofCandidates, cmReplacementByTicker, tdeReplacementByTicker
    );

    // ── 16. Change explanation vs previous target ────────────────────────────
    const changes = explainChanges(target, prevTarget);

    // ── 17. Health score (with full context) ────────────────────────────────
    const health = computePortfolioHealth(snapshot, {
      target,
      companyMonitorByTicker: cmHealthByTicker,
      riskAnalyzer:           riskHealthData,
      tdeByTicker:            tdeHealthByTicker,
    });

    // ── 18. Assemble v2 result ───────────────────────────────────────────────
    const v2: PortfolioV2 = {
      generatedAt:       new Date().toISOString(),
      durationMs:        Date.now() - startMs,
      snapshotUpdatedAt: snapshotUpdatedAt,
      health,
      target,
      drift,
      capitalAllocation,
      replacements,
      changes,
      provenance,
    };

    // ── 19. Persist (second version guard) ──────────────────────────────────
    const latestBeforeWrite = analysisRepository.get<PortfolioSnapshot>(MODULE_NAME);
    if (latestBeforeWrite?.result?.updatedAt !== snapshotUpdatedAt) {
      logger.warn(
        { snapshotUpdatedAt },
        "[portfolio-manager-v2] Snapshot superseded just before persist — discarding stale v2 result"
      );
      return;
    }
    analysisRepository.save<PortfolioV2>(V2_MODULE_NAME, v2);

    // ── 20. History snapshot ─────────────────────────────────────────────────
    appendV2HistoryEntry(snapshot, v2);

    const driftHigh   = drift.filter((d) => d.severity === "High").length;
    const skipNote    = aiSkipped ? " (AI reused — inputs unchanged)" : "";
    const confNote    = targetConfidence !== "High" ? `, confidence ${targetConfidence}` : "";
    systemLog.logInfo(
      "Portfolio Manager v2",
      `CIO analysis complete — health ${v2.health.overall}/100 (${v2.health.grade})` +
        (driftHigh > 0 ? `, ${driftHigh} high-severity drift` : "") +
        confNote + skipNote
    );
    logger.info(
      {
        durationMs: v2.durationMs,
        healthOverall: v2.health.overall,
        driftItems: drift.length,
        aiSkipped,
        targetConfidence,
      },
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
