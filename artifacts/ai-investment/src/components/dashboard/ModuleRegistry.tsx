import type { LucideIcon } from "lucide-react";
import {
  BarChart2, Calendar, Newspaper, PieChart, Building2,
  Briefcase, TrendingUp, Crosshair, Scale, Bell,
  Cpu, Activity, Users, ClipboardList, Zap, MessageSquare,
} from "lucide-react";

import { MarketMonitorWidget }     from "@/components/widgets/MarketMonitorWidget";
import { EventMonitorWidget }       from "@/components/widgets/EventMonitorWidget";
import { NewsMonitorWidget }        from "@/components/widgets/NewsMonitorWidget";
import { SectorMonitorWidget }      from "@/components/widgets/SectorMonitorWidget";
import { MarketAlertsWidget }       from "@/components/widgets/MarketAlertsWidget";
import { RiskAnalyzerWidget }       from "@/components/widgets/RiskAnalyzerWidget";
import { PortfolioManagerWidget }   from "@/components/widgets/PortfolioManagerWidget";
import { PortfolioAnalyzerWidget }  from "@/components/widgets/PortfolioAnalyzerWidget";
import { OpportunityFinderWidget }  from "@/components/widgets/OpportunityFinderWidget";
import { CompanyMonitorWidget }     from "@/components/widgets/CompanyMonitorWidget";
import { TradeDecisionWidget }      from "@/components/widgets/TradeDecisionWidget";
import { TradeReviewWidget }        from "@/components/widgets/TradeReviewWidget";
import { AutomationWidget }         from "@/components/widgets/AutomationWidget";
import { InvestorWatchWidget }      from "@/components/widgets/InvestorWatchWidget";
import { CommandBriefWidget }       from "@/components/widgets/CommandBriefWidget";
import { AiChatWidget }             from "@/components/widgets/AiChatWidget";

export interface ModuleDef {
  id: string;
  label: string;
  icon: LucideIcon;
  route: string;
  Widget: React.ComponentType;
}

export const MODULE_REGISTRY: ModuleDef[] = [
  {
    id: "automation",
    label: "Automation",
    icon: Cpu,
    route: "/automation",
    Widget: AutomationWidget,
  },
  {
    id: "portfolio-manager",
    label: "Portfolio",
    icon: Briefcase,
    route: "/portfolio",
    Widget: PortfolioManagerWidget,
  },
  {
    id: "market-monitor",
    label: "Market Monitor",
    icon: BarChart2,
    route: "/market",
    Widget: MarketMonitorWidget,
  },
  {
    id: "event-monitor",
    label: "Event Monitor",
    icon: Calendar,
    route: "/events",
    Widget: EventMonitorWidget,
  },
  {
    id: "news-monitor",
    label: "News Monitor",
    icon: Newspaper,
    route: "/news",
    Widget: NewsMonitorWidget,
  },
  {
    id: "sector-monitor",
    label: "Sector Monitor",
    icon: PieChart,
    route: "/sectors",
    Widget: SectorMonitorWidget,
  },
  {
    id: "market-alerts",
    label: "Market Alerts",
    icon: Bell,
    route: "/alerts",
    Widget: MarketAlertsWidget,
  },
  {
    id: "risk-analyzer",
    label: "Risk Analyzer",
    icon: Scale,
    route: "/risk",
    Widget: RiskAnalyzerWidget,
  },
  {
    id: "portfolio-analyzer",
    label: "Portfolio Analyzer",
    icon: Activity,
    route: "/analyse",
    Widget: PortfolioAnalyzerWidget,
  },
  {
    id: "opportunity-finder",
    label: "Opportunity Finder",
    icon: Crosshair,
    route: "/opportunities",
    Widget: OpportunityFinderWidget,
  },
  {
    id: "company-monitor",
    label: "Company Monitor",
    icon: Building2,
    route: "/companies",
    Widget: CompanyMonitorWidget,
  },
  {
    id: "trade-decision",
    label: "Trade Decisions",
    icon: TrendingUp,
    route: "/decisions",
    Widget: TradeDecisionWidget,
  },
  {
    id: "trade-review",
    label: "Trade Review",
    icon: ClipboardList,
    route: "/review",
    Widget: TradeReviewWidget,
  },
  {
    id: "investor-watch",
    label: "Investor Watch",
    icon: Users,
    route: "/investors",
    Widget: InvestorWatchWidget,
  },
  {
    id: "command-brief",
    label: "Command Brief",
    icon: Zap,
    route: "/command-brief",
    Widget: CommandBriefWidget,
  },
  {
    id: "ai-chat",
    label: "AI Chat",
    icon: MessageSquare,
    route: "/ai-chat",
    Widget: AiChatWidget,
  },
];
