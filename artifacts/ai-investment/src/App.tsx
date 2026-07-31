import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { AppShell } from '@/components/layout/AppShell';
import MarketMonitor from '@/pages/MarketMonitor';
import EventMonitor from '@/pages/EventMonitor';
import Settings from '@/pages/Settings';

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
        <Route path="/" component={MarketMonitor} />
        <Route path="/events" component={EventMonitor} />
        <Route path="/settings" component={Settings} />
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
