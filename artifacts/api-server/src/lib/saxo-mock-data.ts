/**
 * Saxo Mock Data Provider
 *
 * Single source of truth for all mock Saxo API responses used when
 * mock mode is enabled in Settings.
 *
 * Values are internally consistent:
 *  - Quantity × current price ≈ Exposure
 *  - P/L = quantity × (current price − average open price)
 *  - Account totals ≈ cash + position exposure
 *  - Client-level totals reflect accounts converted to DKK at ≈6.85
 *
 * Rules:
 *  - Never import this from UI, repository, or normalisation code.
 *  - Never include tokens, keys, or real user data.
 *  - All Saxo field names and structures match what the real parser expects.
 */

// ── Shared constants ──────────────────────────────────────────────────────────

const CLIENT_KEY  = "MOCK-CLIENT-0001";
const ACCT_DKK    = "MOCK-DK-00001";
const ACCT_USD    = "MOCK-US-00001";
/** Approximate 1 USD → DKK rate used for ExposureInBaseCurrency and client-level roll-ups */
export const FX_USD_DKK = 6.85;

// ── Account list ─────────────────────────────────────────────────────────────

export const mockAccounts = [
  {
    AccountKey:   ACCT_DKK,
    AccountId:    "12345678",
    ClientKey:    CLIENT_KEY,
    DisplayName:  "Aktiekonto (DKK)",
    AccountType:  "Normal",
    Currency:     "DKK",
    Active:       true,
  },
  {
    AccountKey:   ACCT_USD,
    AccountId:    "12345679",
    ClientKey:    CLIENT_KEY,
    DisplayName:  "Foreign Securities (USD)",
    AccountType:  "Normal",
    Currency:     "USD",
    Active:       true,
  },
] as const;

// ── Client-level balance (DKK base) ──────────────────────────────────────────
//
// DKK account TotalValue:   446 000 DKK
// USD account TotalValue:    28 000 USD × 6.85 = 191 800 DKK
// ─────────────────────────────────────────────────────────
// TotalValue:               637 800 DKK
//
// Cash:  305 000 DKK + 5 000 USD × 6.85 = 339 250 DKK

export const mockClientBalance = {
  TotalValue:               637_800,
  CashAvailableForTrading:  339_250,
  CashBalance:              339_250,
  Currency:                 "DKK",
};

// ── Per-account balances ──────────────────────────────────────────────────────
//
// DKK account: 141 120 (NOVO B) + 305 000 cash = 446 120 → TotalValue 446 000
// USD account:  21 025 (MSFT) + 1 944 (SERV) + 5 000 cash = 27 969 → TotalValue 28 000

export const mockAccountBalances: Record<string, {
  TotalValue: number;
  CashAvailableForTrading: number;
  CashBalance: number;
  Currency: string;
}> = {
  [ACCT_DKK]: {
    TotalValue:               446_000,
    CashAvailableForTrading:  305_000,
    CashBalance:              305_000,
    Currency:                 "DKK",
  },
  [ACCT_USD]: {
    TotalValue:                28_000,
    CashAvailableForTrading:    5_000,
    CashBalance:                5_000,
    Currency:                 "USD",
  },
};

// ── Net positions ─────────────────────────────────────────────────────────────
//
// NOVO B  – 200 shares @ avg 680.00, current 705.60  → P/L = +5 120 DKK
// MSFT    –  50 shares @ avg 381.20, current 420.50  → P/L = +1 965 USD
// SERV    – 300 shares @ avg   7.20, current   6.48  → P/L =   −216 USD

export const mockAccountPositions: Record<string, Array<{
  NetPositionId: string;
  DisplayAndFormat: { Description: string; Symbol: string; Currency: string };
  Exchange: { Name: string; ExchangeId: string };
  NetPositionBase: {
    AccountId: string;
    Amount: number;
    AssetType: string;
    CanBeClosed: boolean;
    IsMarketOpen: boolean;
    OpeningDirection: string;
    Uic: number;
  };
  NetPositionView: {
    AverageOpenPrice: number;
    CurrentPrice: number;
    CurrentPriceDelayMinutes: number;
    Exposure: number;
    ExposureInBaseCurrency: number;
    InstrumentPriceDayPercentChange: number;
    ProfitLossOnTrade: number;
    TradeCostsTotal: number;
    Status: string;
  };
}>> = {
  // ── DKK account ─────────────────────────────────────────────────────────
  [ACCT_DKK]: [
    {
      NetPositionId: "MOCK-POS-NOVO-001",
      DisplayAndFormat: {
        Description: "Novo Nordisk B",
        Symbol:      "NOVO B",
        Currency:    "DKK",
      },
      Exchange: { Name: "Copenhagen Stock Exchange", ExchangeId: "CSE" },
      NetPositionBase: {
        AccountId:        "12345678",
        Amount:           200,
        AssetType:        "Stock",
        CanBeClosed:      true,
        IsMarketOpen:     true,
        OpeningDirection: "Buy",
        Uic:              22268,
      },
      NetPositionView: {
        AverageOpenPrice:                680.00,
        CurrentPrice:                    705.60,
        CurrentPriceDelayMinutes:          0,
        Exposure:                      141_120,   // 200 × 705.60
        ExposureInBaseCurrency:        141_120,   // DKK = base
        InstrumentPriceDayPercentChange:  1.23,
        ProfitLossOnTrade:               5_120,   // 200 × (705.60 − 680.00)
        TradeCostsTotal:                   -52,
        Status:                        "Open",
      },
    },
  ],

  // ── USD account ─────────────────────────────────────────────────────────
  [ACCT_USD]: [
    {
      NetPositionId: "MOCK-POS-MSFT-001",
      DisplayAndFormat: {
        Description: "Microsoft Corp",
        Symbol:      "MSFT",
        Currency:    "USD",
      },
      Exchange: { Name: "NASDAQ", ExchangeId: "NASDAQ" },
      NetPositionBase: {
        AccountId:        "12345679",
        Amount:           50,
        AssetType:        "Stock",
        CanBeClosed:      true,
        IsMarketOpen:     true,
        OpeningDirection: "Buy",
        Uic:              22,
      },
      NetPositionView: {
        AverageOpenPrice:                381.20,
        CurrentPrice:                    420.50,
        CurrentPriceDelayMinutes:          0,
        Exposure:                       21_025,   // 50 × 420.50
        ExposureInBaseCurrency:  Math.round(21_025 * FX_USD_DKK),  // ≈ 144 021
        InstrumentPriceDayPercentChange:  0.87,
        ProfitLossOnTrade:               1_965,   // 50 × (420.50 − 381.20)
        TradeCostsTotal:                   -38,
        Status:                        "Open",
      },
    },
    {
      NetPositionId: "MOCK-POS-SERV-001",
      DisplayAndFormat: {
        Description: "Serve Robotics Inc",
        Symbol:      "SERV",
        Currency:    "USD",
      },
      Exchange: { Name: "NASDAQ", ExchangeId: "NASDAQ" },
      NetPositionBase: {
        AccountId:        "12345679",
        Amount:           300,
        AssetType:        "Stock",
        CanBeClosed:      true,
        IsMarketOpen:     false,
        OpeningDirection: "Buy",
        Uic:              99998,
      },
      NetPositionView: {
        AverageOpenPrice:                  7.20,
        CurrentPrice:                      6.48,
        CurrentPriceDelayMinutes:           15,
        Exposure:                        1_944,   // 300 × 6.48
        ExposureInBaseCurrency:  Math.round(1_944 * FX_USD_DKK),  // ≈ 13 316
        InstrumentPriceDayPercentChange:  -2.15,
        ProfitLossOnTrade:                 -216,  // 300 × (6.48 − 7.20)
        TradeCostsTotal:                  -12.5,
        Status:                          "Open",
      },
    },
  ],
};
