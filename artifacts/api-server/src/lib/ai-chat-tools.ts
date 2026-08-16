/**
 * AI Chat — Read-Only Tool Definitions + Executors
 *
 * All tools are READ-ONLY. They read stored module results from analysisRepository.
 * They NEVER trigger analysis, run modules, or write anything.
 *
 * Tool results are compact — only the fields useful to the LLM are returned.
 */

import { analysisRepository } from "./analysis-repository.js";

// ── Tool schema definitions (for Responses API) ────────────────────────────────

export const AI_CHAT_TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    name: "get_command_brief",
    description:
      "Read the latest Command Brief — the executive summary of current system state, headline, key items, and action status. Does NOT regenerate it.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "get_portfolio",
    description:
      "Read the latest Portfolio Manager snapshot — current holdings, weights, and account state.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "get_risk_analysis",
    description:
      "Read the latest Risk Analyzer result — portfolio risk score, key risk factors, and recommendations.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "get_portfolio_analysis",
    description:
      "Read the latest Portfolio Analyzer result — performance analysis, concentration, and allocation assessment.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "get_trade_decisions",
    description:
      "Read the latest Trade Decision Engine results for all tracked companies — current decision state (Hold, WaitForEvent, PrepareToBuy, etc.) for each ticker.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "get_trade_review",
    description:
      "Read the latest Trade Review results — which trades, if any, are currently actionable and ready for approval.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "get_opportunities",
    description:
      "Read the latest Opportunity Finder results — scored investment opportunities currently tracked by the system.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "get_catalyst",
    description:
      "Read the latest Catalyst Intelligence result for a specific ticker. Returns event details, catalyst direction, evidence confidence, price asymmetry, thesis, and key risks.",
    parameters: {
      type: "object",
      properties: {
        ticker: {
          type: "string",
          description: "The stock ticker symbol, e.g. KEYS, NVDA, V",
        },
      },
      required: ["ticker"],
    },
  },
  {
    type: "function" as const,
    name: "get_company_monitor",
    description:
      "Read the latest Company Monitor result for a specific ticker — investment view, rating, outlook, and recent analysis.",
    parameters: {
      type: "object",
      properties: {
        ticker: {
          type: "string",
          description: "The stock ticker symbol",
        },
      },
      required: ["ticker"],
    },
  },
  {
    type: "function" as const,
    name: "get_price_context",
    description:
      "Read the latest price context for a specific ticker — price state, recent behavior, momentum, and volatility regime.",
    parameters: {
      type: "object",
      properties: {
        ticker: {
          type: "string",
          description: "The stock ticker symbol",
        },
      },
      required: ["ticker"],
    },
  },
  {
    type: "function" as const,
    name: "get_events",
    description:
      "Read the latest Event Monitor results — upcoming events (earnings, economic reports, dividends) being tracked.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "get_market_alerts",
    description:
      "Read the latest Market Alerts — active alerts and signal detections.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "get_market_monitor",
    description:
      "Read the latest Market Monitor result — current market conditions and indicators.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "get_sector_monitor",
    description:
      "Read the latest Sector Monitor results — sector trends and momentum currently tracked.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "get_news_monitor",
    description:
      "Read the latest News Monitor results — recent news items and sentiment tracked by the system.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function" as const,
    name: "get_system_health",
    description:
      "Read a summary of which modules have run recently and when they were last updated.",
    parameters: { type: "object", properties: {}, required: [] },
  },
] as const;

// ── Tool executor ──────────────────────────────────────────────────────────────

type ToolArgs = Record<string, unknown>;

function safeResult(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return null;
  return raw;
}

function compact<T extends object>(obj: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) {
    if (k in obj) out[k] = obj[k];
  }
  return out;
}

export async function executeToolCall(name: string, args: ToolArgs): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (moduleName: string) => (analysisRepository.get(moduleName) as any)?.result;

  switch (name) {
    case "get_command_brief": {
      const d = r("command-brief");
      if (!d) return { error: "No Command Brief result available yet." };
      return {
        headline: d.headline,
        overallStatus: d.overallStatus,
        items: (d.items ?? []).slice(0, 12),
        actionStatus: d.actionStatus,
        readyTradeCount: d.readyTradeCount,
        updatedAt: analysisRepository.get("command-brief")?.updatedAt,
      };
    }

    case "get_portfolio": {
      const d = r("portfolio-manager");
      if (!d) return { error: "No Portfolio Manager result available yet." };
      return {
        totalValue: d.totalValue,
        cashAmount: d.cashAmount,
        cashPercent: d.cashPercent,
        positions: (d.positions ?? []).map((p: Record<string,unknown>) =>
          compact(p as { ticker:unknown; company:unknown; quantity:unknown; currentPrice:unknown; marketValue:unknown; weight:unknown; gainLossPercent:unknown }, ["ticker","company","quantity","currentPrice","marketValue","weight","gainLossPercent"])
        ),
        updatedAt: analysisRepository.get("portfolio-manager")?.updatedAt,
      };
    }

    case "get_risk_analysis": {
      const d = r("risk-analyzer");
      if (!d) return { error: "No Risk Analyzer result available yet." };
      return {
        overallRiskScore: d.overallRiskScore,
        riskLevel: d.riskLevel,
        summary: d.summary,
        topRisks: (d.risks ?? []).slice(0, 5),
        recommendations: (d.recommendations ?? []).slice(0, 5),
        updatedAt: analysisRepository.get("risk-analyzer")?.updatedAt,
      };
    }

    case "get_portfolio_analysis": {
      const d = r("portfolio-analyzer");
      if (!d) return { error: "No Portfolio Analyzer result available yet." };
      return safeResult(d);
    }

    case "get_trade_decisions": {
      const d = r("trade-decision-engine");
      if (!d) return { error: "No Trade Decision result available yet." };
      return {
        decisions: (d.decisions ?? []).map((td: Record<string,unknown>) =>
          compact(td as { ticker:unknown; company:unknown; decision:unknown; confidence:unknown; reason:unknown; waitingForEvent:unknown; eventDate:unknown }, ["ticker","company","decision","confidence","reason","waitingForEvent","eventDate"])
        ),
        summary: d.summary,
        updatedAt: analysisRepository.get("trade-decision-engine")?.updatedAt,
      };
    }

    case "get_trade_review": {
      const d = r("trade-review");
      if (!d) return { error: "No Trade Review result available yet." };
      return {
        readyTrades: d.readyTrades ?? [],
        blockedTrades: (d.blockedTrades ?? []).slice(0, 5),
        summary: d.summary,
        updatedAt: analysisRepository.get("trade-review")?.updatedAt,
      };
    }

    case "get_opportunities": {
      const d = r("opportunity-finder");
      if (!d) return { error: "No Opportunity Finder result available yet." };
      return {
        opportunities: (d.opportunities ?? []).map((o: Record<string,unknown>) =>
          compact(o as { ticker:unknown; company:unknown; opportunityScore:unknown; opportunityState:unknown; attractiveness:unknown; thesis:unknown }, ["ticker","company","opportunityScore","opportunityState","attractiveness","thesis"])
        ).slice(0, 8),
        updatedAt: analysisRepository.get("opportunity-finder")?.updatedAt,
      };
    }

    case "get_catalyst": {
      const ticker = String(args.ticker ?? "").toUpperCase();
      if (!ticker) return { error: "ticker is required" };
      // Catalyst results are stored per-ticker as "catalyst-intelligence:TICKER"
      const d = r(`catalyst-intelligence:${ticker}`);
      if (!d) return { error: `No Catalyst Intelligence result available for ${ticker}.` };
      return {
        ticker: d.ticker,
        company: d.company,
        eventType: d.eventType,
        eventDate: d.eventDate,
        daysUntilEvent: d.daysUntilEvent,
        opportunityState: d.opportunityState,
        catalystDirection: d.catalystDirection,
        evidenceConfidence: d.evidenceConfidence,
        expectationGap: d.expectationGap,
        priceAsymmetry: d.priceAsymmetry,
        alreadyPricedIn: d.alreadyPricedIn,
        thesis: d.thesis,
        keyRisks: (d.keyRisks ?? []).slice(0, 4),
        lastUpdated: analysisRepository.get(`catalyst-intelligence:${ticker}`)?.updatedAt,
      };
    }

    case "get_company_monitor": {
      const ticker = String(args.ticker ?? "").toUpperCase();
      if (!ticker) return { error: "ticker is required" };
      const d = r(`company-monitor:${ticker}`);
      if (!d) return { error: `No Company Monitor result available for ${ticker}.` };
      return {
        ticker: d.ticker ?? ticker,
        company: d.company,
        investmentView: d.investmentView,
        rating: d.rating,
        outlook: d.outlook,
        summary: d.summary ?? d.reason,
        lastUpdated: analysisRepository.get(`company-monitor:${ticker}`)?.updatedAt,
      };
    }

    case "get_price_context": {
      const ticker = String(args.ticker ?? "").toUpperCase();
      if (!ticker) return { error: "ticker is required" };
      const d = r(`price-context:${ticker}`);
      if (!d) return { error: `No price context available for ${ticker}.` };
      return {
        ticker,
        priceState: d.priceState,
        changePercent1W: d.changePercent1W,
        changePercent1M: d.changePercent1M,
        recentBehavior: d.recentBehavior,
        volatilityRegime: d.volatilityRegime,
        lastUpdated: analysisRepository.get(`price-context:${ticker}`)?.updatedAt,
      };
    }

    case "get_events": {
      const d = r("event-monitor");
      if (!d) return { error: "No Event Monitor result available yet." };
      return {
        events: (d.events ?? []).slice(0, 10),
        updatedAt: analysisRepository.get("event-monitor")?.updatedAt,
      };
    }

    case "get_market_alerts": {
      const d = r("market-alerts");
      if (!d) return { error: "No Market Alerts result available yet." };
      return {
        alerts: (d.alerts ?? []).slice(0, 10),
        summary: d.summary,
        updatedAt: analysisRepository.get("market-alerts")?.updatedAt,
      };
    }

    case "get_market_monitor": {
      const d = r("market-monitor");
      if (!d) return { error: "No Market Monitor result available yet." };
      return {
        marketSentiment: d.marketSentiment,
        summary: d.summary,
        keyIndicators: (d.keyIndicators ?? []).slice(0, 6),
        updatedAt: analysisRepository.get("market-monitor")?.updatedAt,
      };
    }

    case "get_sector_monitor": {
      const d = r("sector-monitor");
      if (!d) return { error: "No Sector Monitor result available yet." };
      return safeResult(d);
    }

    case "get_news_monitor": {
      const d = r("news-monitor");
      if (!d) return { error: "No News Monitor result available yet." };
      return {
        items: (d.items ?? []).slice(0, 8),
        summary: d.summary,
        updatedAt: analysisRepository.get("news-monitor")?.updatedAt,
      };
    }

    case "get_system_health": {
      const all = analysisRepository.getAll();
      return {
        modules: all.map((e) => ({
          module: e.moduleName,
          updatedAt: e.updatedAt,
          materialVersion: e.materialVersion,
        })),
        totalModules: all.length,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
