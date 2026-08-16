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

export async function executeToolCall(name: string, args: ToolArgs): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (moduleName: string): any => (analysisRepository.get(moduleName) as any)?.result;
  const ts = (moduleName: string) => analysisRepository.get(moduleName)?.updatedAt;

  switch (name) {

    // ── Command Brief ──────────────────────────────────────────────────────────
    case "get_command_brief": {
      const d = r("command-brief");
      if (!d) return { error: "No Command Brief result available yet." };
      return {
        headline:            d.headline,
        overallStatus:       d.overallStatus,
        items:               (d.items ?? []).slice(0, 12),
        actionStatus:        d.actionStatus,
        readyTradeCount:     d.readyTradeCount ?? 0,
        upcomingOpportunities: (d.upcomingOpportunities ?? []).slice(0, 5),
        updatedAt:           ts("command-brief"),
      };
    }

    // ── Portfolio ──────────────────────────────────────────────────────────────
    // Actual shape: PortfolioSnapshot — positions live under accounts[].positions,
    // NOT under a top-level d.positions array.
    case "get_portfolio": {
      const d = r("portfolio-manager");
      if (!d) return { error: "No Portfolio Manager result available yet." };

      // Flatten all positions across accounts, preserving account identity
      const accounts: Array<Record<string, unknown>> = Array.isArray(d.accounts) ? d.accounts : [];
      const positions = accounts.flatMap((acct: any) =>
        (Array.isArray(acct.positions) ? acct.positions : []).map((p: any) => ({
          symbol:                 p.symbol,
          name:                   p.name,
          quantity:               p.quantity,
          currentPrice:           p.currentPrice,
          marketValue:            p.marketValue,
          marketValueBaseCurrency: p.marketValueBaseCurrency,
          profitLoss:             p.profitLoss,
          dayChangePercent:       p.dayChangePercent,
          instrumentCurrency:     p.currency,
          accountKey:             p.accountKey ?? acct.accountKey,
        }))
      );

      return {
        baseCurrency:              d.baseCurrency,
        totalValue:                d.totalValue,
        totalAvailableCash:        d.totalAvailableCash,
        totalUnrealizedProfitLoss: d.totalUnrealizedProfitLoss,
        accounts: accounts.map((a: any) => ({
          accountName:   a.accountName,
          currency:      a.currency,
          availableCash: a.availableCash,
          accountValue:  a.accountValue,
        })),
        positions,
        updatedAt: ts("portfolio-manager"),
      };
    }

    // ── Risk Analysis ──────────────────────────────────────────────────────────
    // Actual shape: riskScore (not overallRiskScore), overallRiskLevel (not riskLevel),
    // mainConclusion object (not summary string), topRisks (not risks),
    // watchClosely (not recommendations).
    case "get_risk_analysis": {
      const d = r("risk-analyzer");
      if (!d) return { error: "No Risk Analyzer result available yet." };
      return {
        riskScore:      d.riskScore,
        overallRiskLevel: d.overallRiskLevel,
        mainConclusion: d.mainConclusion,   // { title, reason }
        topRisks:       (d.topRisks ?? []).slice(0, 5).map((risk: any) => ({
          title:           risk.title,
          category:        risk.category,
          severity:        risk.severity,
          probability:     risk.probability,
          timeHorizon:     risk.timeHorizon,
          affectedHoldings: risk.affectedHoldings,
          reason:          risk.reason,
        })),
        watchClosely:   (d.watchClosely ?? []).slice(0, 5),
        updatedAt:      ts("risk-analyzer"),
      };
    }

    // ── Portfolio Analysis ─────────────────────────────────────────────────────
    case "get_portfolio_analysis": {
      const d = r("portfolio-analyzer");
      if (!d) return { error: "No Portfolio Analyzer result available yet." };
      return d;
    }

    // ── Trade Decisions ────────────────────────────────────────────────────────
    // Actual fields: blockedByEvent (not waitingForEvent), blockingEventDate (not eventDate).
    case "get_trade_decisions": {
      const d = r("trade-decision-engine");
      if (!d) return { error: "No Trade Decision result available yet." };
      return {
        overallDecisionPosture:  d.overallDecisionPosture,
        decisionReadinessScore:  d.decisionReadinessScore,
        decisions: (d.decisions ?? []).map((td: any) => ({
          ticker:             td.ticker,
          company:            td.company,
          decision:           td.decision,
          confidence:         td.confidence,
          urgency:            td.urgency,
          evidenceScore:      td.evidenceScore,
          evidenceBand:       td.evidenceBand,
          blockedByEvent:     td.blockedByEvent,
          blockingEvent:      td.blockingEvent,
          blockingEventDate:  td.blockingEventDate,
          readiness:          td.readiness,
        })),
        updatedAt: ts("trade-decision-engine"),
      };
    }

    // ── Trade Review ───────────────────────────────────────────────────────────
    // Actual shape: { proposals: TradeProposal[], tdeTimestamp, generatedAt }
    // NOT { readyTrades, blockedTrades, summary }.
    case "get_trade_review": {
      const d = r("trade-review");
      if (!d) return { error: "No Trade Review result available yet." };
      const proposals: any[] = d.proposals ?? [];
      const readyProposals = proposals.filter((p: any) => p.status === "Ready");
      const waitingProposals = proposals.filter((p: any) => p.status === "Waiting");
      return {
        totalProposals:   proposals.length,
        readyProposals:   readyProposals.map((p: any) => ({
          id:              p.id,
          ticker:          p.ticker,
          company:         p.company,
          decisionTitle:   p.decisionTitle,
          quantity:        p.quantity,
          status:          p.status,
          decisionRank:    p.decisionRank,
          quantityNote:    p.quantityNote,
        })),
        waitingProposals: waitingProposals.map((p: any) => ({
          id:            p.id,
          ticker:        p.ticker,
          company:       p.company,
          decisionTitle: p.decisionTitle,
          status:        p.status,
        })),
        generatedAt: d.generatedAt,
        updatedAt:   ts("trade-review"),
      };
    }

    // ── Opportunities ──────────────────────────────────────────────────────────
    // Actual field: topOpportunities (not opportunities).
    case "get_opportunities": {
      const d = r("opportunity-finder");
      if (!d) return { error: "No Opportunity Finder result available yet." };
      return {
        overallOpportunityLevel: d.overallOpportunityLevel,
        executiveSummary:        d.executiveSummary,
        topOpportunities: (d.topOpportunities ?? []).slice(0, 8).map((o: any) => ({
          rank:            o.rank,
          ticker:          o.ticker,
          company:         o.company,
          sector:          o.sector,
          overallScore:    o.overallScore,
          confidence:      o.confidence,
          priority:        o.priority,
          investmentThesis: Array.isArray(o.investmentThesis) ? o.investmentThesis.slice(0, 3) : o.investmentThesis,
          whyNow:          Array.isArray(o.whyNow) ? o.whyNow.slice(0, 2) : o.whyNow,
          mainCatalyst:    o.mainCatalyst,
          catalystDate:    o.catalystDate,
          mainRisk:        o.mainRisk,
        })),
        updatedAt: ts("opportunity-finder"),
      };
    }

    // ── Catalyst Intelligence ──────────────────────────────────────────────────
    // Actual shape: CatalystState — analysis fields nested under d.analysis,
    // event under d.screening.event, screeningState under d.screening.screeningState.
    case "get_catalyst": {
      const ticker = String(args.ticker ?? "").toUpperCase();
      if (!ticker) return { error: "ticker is required" };
      const d = r(`catalyst-intelligence:${ticker}`);
      if (!d) return { error: `No Catalyst Intelligence result available for ${ticker}.` };

      const analysis = d.analysis ?? {};
      const screening = d.screening ?? {};
      const event = screening.event ?? {};
      const sa = d.signalAccumulation ?? {};

      return {
        ticker:          d.ticker ?? ticker,
        company:         d.company,
        triggerType:     d.triggerType,
        event: {
          type:          event.type ?? event.category,
          date:          event.date ?? event.eventDate,
          daysUntilEvent: event.daysUntilEvent,
        },
        screeningState:  screening.screeningState ?? screening.preliminaryState,
        analysis: {
          opportunityState:          analysis.opportunityState,
          catalystDirection:         analysis.catalystDirection,
          evidenceConfidence:        analysis.evidenceConfidence,
          expectationGap:            analysis.expectationGap,
          priceAsymmetry:            analysis.priceAsymmetry,
          alreadyPricedIn:           analysis.alreadyPricedIn,
          catalystRisk:              analysis.catalystRisk,
          thesis:                    analysis.thesis,
          strongestCounterargument:  analysis.strongestCounterargument,
          invalidationConditions:    (analysis.invalidationConditions ?? []).slice(0, 4),
          recommendedNextStep:       analysis.recommendedNextStep,
        },
        signalAccumulation: {
          state:         sa.state,
          overallDirection: sa.overallDirection,
          confidence:    sa.confidence,
          signalCount:   Array.isArray(sa.signals) ? sa.signals.length : undefined,
        },
        promotedAt:     d.promotedAt,
        lastAnalysedAt: d.lastAnalysedAt,
        updatedAt:      ts(`catalyst-intelligence:${ticker}`),
      };
    }

    // ── Company Monitor ────────────────────────────────────────────────────────
    // Actual shape: investmentView is {rating, outlook, reason} object (not flat fields).
    // Root also has: investmentCaseStrength, updateType, executiveSummary, confidence, etc.
    case "get_company_monitor": {
      const ticker = String(args.ticker ?? "").toUpperCase();
      if (!ticker) return { error: "ticker is required" };
      const d = r(`company-monitor:${ticker}`);
      if (!d) return { error: `No Company Monitor result available for ${ticker}.` };

      const view = d.investmentView ?? {};
      return {
        ticker:                      d.company?.ticker ?? ticker,
        company:                     d.company?.name ?? d.company,
        updateType:                  d.updateType,
        investmentView: {
          rating:  view.rating,
          outlook: view.outlook,
          reason:  view.reason,
        },
        investmentCaseStrength:      d.investmentCaseStrength,
        investmentCaseChangeSeverity: d.investmentCaseChange?.severity,
        investmentCaseChangeSummary:  d.investmentCaseChange?.summary,
        executiveSummary:            d.executiveSummary,
        currentSituation:            d.currentSituation,
        confidence:                  d.confidence,
        keyThingsToWatch:            (d.keyThingsToWatch ?? []).slice(0, 5),
        updatedAt:                   ts(`company-monitor:${ticker}`),
      };
    }

    // ── Price Context ──────────────────────────────────────────────────────────
    // Actual shape: PriceContext — returns are nested under d.returns,
    // volatility under d.volatility, trend under d.trend.
    case "get_price_context": {
      const ticker = String(args.ticker ?? "").toUpperCase();
      if (!ticker) return { error: "ticker is required" };
      const d = r(`price-context:${ticker}`);
      if (!d) return { error: `No price context available for ${ticker}.` };

      const ret  = d.returns ?? {};
      const vol  = d.volatility ?? {};
      const trend = d.trend ?? {};
      const rb   = d.recentBehavior ?? {};

      return {
        ticker,
        priceState:        d.priceState,
        currentPrice:      d.currentPrice,
        returns: {
          fiveDayPct:     ret.fiveDayPct,
          tenDayPct:      ret.tenDayPct,
          thirtyDayPct:   ret.thirtyDayPct,
          ninetyDayPct:   ret.ninetyDayPct,
        },
        trend: {
          shortTermTrend:  trend.shortTermTrend,
          mediumTermTrend: trend.mediumTermTrend,
          momentumChange:  trend.momentumChange,
        },
        volatility: {
          volatilityState: vol.volatilityState,
          volatilityTrend: vol.volatilityTrend,
          fiveDay:         vol.fiveDay,
          thirtyDay:       vol.thirtyDay,
        },
        recentBehavior: {
          state:               rb.state,
          twoDayReturnPct:     rb.twoDayReturnPct,
          threeDayReturnPct:   rb.threeDayReturnPct,
          declineDecelerating: rb.declineDecelerating,
          newLowLast3Days:     rb.newLowLast3Days,
          newLowLast5Days:     rb.newLowLast5Days,
        },
        updatedAt: ts(`price-context:${ticker}`),
      };
    }

    // ── Events ─────────────────────────────────────────────────────────────────
    // Shape: { summary, events[] } — d.events is correct.
    case "get_events": {
      const d = r("event-monitor");
      if (!d) return { error: "No Event Monitor result available yet." };
      return {
        summary:  d.summary,
        events:   (d.events ?? []).slice(0, 10),
        updatedAt: ts("event-monitor"),
      };
    }

    // ── Market Alerts ──────────────────────────────────────────────────────────
    // Shape: { overallAlertLevel, nothingImportantChanged, alerts[] }
    // There is no top-level "summary" field.
    case "get_market_alerts": {
      const d = r("market-alerts");
      if (!d) return { error: "No Market Alerts result available yet." };
      return {
        overallAlertLevel:       d.overallAlertLevel,
        nothingImportantChanged: d.nothingImportantChanged,
        alerts: (d.alerts ?? []).slice(0, 10).map((a: any) => ({
          title:            a.title,
          category:         a.category,
          severity:         a.severity,
          timeHorizon:      a.timeHorizon,
          affectedHoldings: a.affectedHoldings,
          currentStatus:    a.currentStatus,
        })),
        updatedAt: ts("market-alerts"),
      };
    }

    // ── Market Monitor ─────────────────────────────────────────────────────────
    // Shape: { summary, marketSentiment, riskLevel, positiveFactors, negativeFactors,
    //          strongSectors, weakSectors, keyRisks, sources }
    // There is no "keyIndicators" field.
    case "get_market_monitor": {
      const d = r("market-monitor");
      if (!d) return { error: "No Market Monitor result available yet." };
      return {
        marketSentiment:  d.marketSentiment,
        riskLevel:        d.riskLevel,
        summary:          d.summary,
        strongSectors:    (d.strongSectors ?? []).slice(0, 5),
        weakSectors:      (d.weakSectors ?? []).slice(0, 5),
        keyRisks:         (d.keyRisks ?? []).slice(0, 5),
        updatedAt:        ts("market-monitor"),
      };
    }

    // ── Sector Monitor ─────────────────────────────────────────────────────────
    // Shape: { executiveSummary, overallOutlook, topSector, sectors[] }
    case "get_sector_monitor": {
      const d = r("sector-monitor");
      if (!d) return { error: "No Sector Monitor result available yet." };
      return {
        executiveSummary: d.executiveSummary,
        overallOutlook:   d.overallOutlook,
        topSector:        d.topSector,
        sectors: (d.sectors ?? []).map((s: any) => ({
          name:       s.name,
          rating:     s.rating,
          trend:      s.trend,
          summary:    s.summary,
          confidence: s.confidence,
        })),
        updatedAt: ts("sector-monitor"),
      };
    }

    // ── News Monitor ───────────────────────────────────────────────────────────
    // Shape: { executiveSummary, overallMarketImpact, topStory, news[] }
    // The array field is "news", NOT "items".
    case "get_news_monitor": {
      const d = r("news-monitor");
      if (!d) return { error: "No News Monitor result available yet." };
      return {
        executiveSummary:   d.executiveSummary,
        overallMarketImpact: d.overallMarketImpact,
        topStory:           d.topStory,
        news: (d.news ?? []).slice(0, 8).map((item: any) => ({
          title:           item.title,
          summary:         item.summary,
          category:        item.category,
          importance:      item.importance,
          affectedMarkets: item.affectedMarkets,
          whyItMatters:    item.whyItMatters,
          publishedAt:     item.publishedAt,
        })),
        updatedAt: ts("news-monitor"),
      };
    }

    // ── System Health ──────────────────────────────────────────────────────────
    case "get_system_health": {
      const all = analysisRepository.getAll();
      return {
        modules: all.map((e) => ({
          module:          e.moduleName,
          updatedAt:       e.updatedAt,
          materialVersion: e.materialVersion,
        })),
        totalModules: all.length,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
