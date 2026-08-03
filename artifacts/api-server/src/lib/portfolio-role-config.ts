/**
 * Portfolio Role Configuration
 *
 * Defines the 10 portfolio roles used by Portfolio Manager v2,
 * including their ideal allocation ranges and a short description.
 */

import type { PortfolioRole } from "./portfolio-manager-v2-types.js";

export interface RoleDefinition {
  role: PortfolioRole;
  label: string;
  description: string;
  /** Recommended allocation range as % of total portfolio */
  typicalMinPercent: number;
  typicalMaxPercent: number;
}

export const ROLE_DEFINITIONS: Record<PortfolioRole, RoleDefinition> = {
  Cash: {
    role: "Cash",
    label: "Cash / Dry Powder",
    description: "Undeployed capital that provides optionality and a buffer against drawdowns.",
    typicalMinPercent: 5,
    typicalMaxPercent: 25,
  },
  CoreHolding: {
    role: "CoreHolding",
    label: "Core Holding",
    description: "High-conviction, longer-duration positions forming the stable backbone of the portfolio.",
    typicalMinPercent: 8,
    typicalMaxPercent: 20,
  },
  GrowthCore: {
    role: "GrowthCore",
    label: "Growth Core",
    description: "Above-average growth companies with strong secular tailwinds and durable competitive positions.",
    typicalMinPercent: 5,
    typicalMaxPercent: 15,
  },
  SpeculativeGrowth: {
    role: "SpeculativeGrowth",
    label: "Speculative Growth",
    description: "Higher-risk, higher-upside positions with binary or asymmetric outcomes.",
    typicalMinPercent: 2,
    typicalMaxPercent: 8,
  },
  IncomeDividend: {
    role: "IncomeDividend",
    label: "Income / Dividend",
    description: "Yield-oriented holdings providing regular cash flow and relative defensiveness.",
    typicalMinPercent: 3,
    typicalMaxPercent: 12,
  },
  Defensive: {
    role: "Defensive",
    label: "Defensive",
    description: "Low-beta, recession-resistant positions that reduce drawdown during market stress.",
    typicalMinPercent: 3,
    typicalMaxPercent: 12,
  },
  CyclicalExposure: {
    role: "CyclicalExposure",
    label: "Cyclical Exposure",
    description: "Positions sensitive to the economic cycle, held tactically when macro conditions are supportive.",
    typicalMinPercent: 3,
    typicalMaxPercent: 10,
  },
  InternationalDiversifier: {
    role: "InternationalDiversifier",
    label: "International Diversifier",
    description: "Non-domestic exposure that reduces home-country bias and captures different growth drivers.",
    typicalMinPercent: 3,
    typicalMaxPercent: 15,
  },
  SectorPlay: {
    role: "SectorPlay",
    label: "Sector Play",
    description: "Tactical sector-themed position exploiting a specific industry catalyst or rotation.",
    typicalMinPercent: 2,
    typicalMaxPercent: 8,
  },
  EventDriven: {
    role: "EventDriven",
    label: "Event-Driven",
    description: "Position sized around a specific near-term catalyst (earnings, M&A, regulatory decision).",
    typicalMinPercent: 1,
    typicalMaxPercent: 6,
  },
};

/** Return the RoleDefinition for a given role, or a safe fallback. */
export function getRoleDefinition(role: PortfolioRole): RoleDefinition {
  return ROLE_DEFINITIONS[role] ?? ROLE_DEFINITIONS.CoreHolding;
}
