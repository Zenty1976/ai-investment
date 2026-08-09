import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { AppShell } from '@/components/layout/AppShell';
import Dashboard from '@/pages/Dashboard';
import MarketMonitor from '@/pages/MarketMonitor';
import EventMonitor from '@/pages/EventMonitor';
import NewsMonitor from '@/pages/NewsMonitor';
import SectorMonitor from '@/pages/SectorMonitor';
import CompanyMonitor from '@/pages/CompanyMonitor';
import PortfolioManager from '@/pages/PortfolioManager';
import PortfolioAnalyzer from '@/pages/PortfolioAnalyzer';
import OpportunityFinder from '@/pages/OpportunityFinder';
import RiskAnalyzer from '@/pages/RiskAnalyzer';
import MarketAlerts from '@/pages/MarketAlerts';
import TradeDecisionEngine from '@/pages/TradeDecisionEngine';
import TradeReview from '@/pages/TradeReview';
import InvestorWatch from '@/pages/InvestorWatch';
import Settings from '@/pages/Settings';
import SystemLog from '@/pages/SystemLog';
import Automation from '@/pages/Automation';
import CommandBrief from '@/pages/CommandBrief';

const queryClient = new QueryClient();

function SimpleNotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh]">
      <h2 className="text-2xl font-bold mb-2">404 - Not Found</h2>
      <p className="text-muted-foreground">The page you are looking for does not exist.</p>
    </div>
  );
}

function Router() {
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/market" component={() => <MarketMonitor initialExpanded={true} />} />
        <Route path="/events" component={() => <EventMonitor initialExpanded={true} />} />
        <Route path="/news" component={() => <NewsMonitor initialExpanded={true} />} />
        <Route path="/sectors" component={() => <SectorMonitor initialExpanded={true} />} />
        <Route path="/companies" component={CompanyMonitor} />
        <Route path="/portfolio" component={PortfolioManager} />
        <Route path="/analyse" component={PortfolioAnalyzer} />
        <Route path="/opportunities" component={OpportunityFinder} />
        <Route path="/risk" component={RiskAnalyzer} />
        <Route path="/alerts" component={MarketAlerts} />
        <Route path="/decisions" component={TradeDecisionEngine} />
        <Route path="/trade-review" component={TradeReview} />
        <Route path="/investors" component={InvestorWatch} />
        <Route path="/automation" component={Automation} />
        <Route path="/command-brief" component={CommandBrief} />
        <Route path="/settings" component={Settings} />
        <Route path="/log" component={SystemLog} />
        <Route component={SimpleNotFound} />
      </Switch>
    </AppShell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Router />
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;
