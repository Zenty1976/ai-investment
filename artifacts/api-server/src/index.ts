import app from "./app";
import { logger } from "./lib/logger";
import { maybeSaxoRefresh } from "./routes/settings";
import { automationOrchestrator } from "./lib/automation-orchestrator";
import { initPolicyStore } from "./lib/trade-decision-policy-store";
import { initUsageLog } from "./lib/openai-usage-service";
import {
  setMarketUniverseProvider,
  SeedMarketUniverseProvider,
  SaxoMarketUniverseProvider,
  CompositeMarketUniverseProvider,
} from "./lib/market-universe-provider";
import { getAllUniverseEntries } from "./lib/catalyst-universe";
import { seedUniverseIfEmpty } from "./lib/market-universe-repository";
import { refreshSaxoUniverseIfStale } from "./lib/saxo-universe-refresh";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Initialise the trade decision policy store before accepting requests.
// This validates all built-in profiles (fail-fast) and loads the persisted
// profile selection from the analysis repository.
initPolicyStore();

// Initialize Market Universe Provider (Part 3/4 + authenticated Saxo recheck).
// Composite: Saxo for both bulk enumeration AND per-ticker lookup; Seed as fallback.
// CONFIRMED (authenticated audit 2026-08-14): Saxo CAN enumerate by ExchangeId.
//   CSE: 117 DK stocks, NASDAQ: 1,979, NYSE: 2,039 — full pagination available.
const allEntries = getAllUniverseEntries();
setMarketUniverseProvider(
  new CompositeMarketUniverseProvider([
    new SaxoMarketUniverseProvider(),
    new SeedMarketUniverseProvider(allEntries),
  ])
);

// Seed the Market Universe Repository so data-coverage reports have a baseline.
// Idempotent — only writes if the exchange key is absent from the repository.
// Groups by exchange and seeds each one separately.
{
  const byExchange = new Map<string, typeof allEntries>();
  for (const entry of allEntries) {
    const ex = entry.exchange.toUpperCase();
    if (!byExchange.has(ex)) byExchange.set(ex, []);
    byExchange.get(ex)!.push(entry);
  }
  for (const [exchange, entries] of byExchange) {
    seedUniverseIfEmpty(exchange, entries.map(e => ({
      ticker: e.ticker,
      company: e.company,
      exchange: e.exchange,
      country: e.country,
      currency: e.currency,
      sector: e.sector ?? null,
      industry: e.industry ?? null,
      uic: e.uic ?? null,
      tradeable: e.tradeable,
      active: e.active,
      lastVerifiedAt: null,
      source: "STATIC_SEED" as const,
    })));
  }
  logger.info(
    { exchanges: [...byExchange.keys()], total: allEntries.length },
    "Market Universe Repository seeded (STATIC_SEED — Saxo refresh will upgrade this)"
  );
}

// Background Saxo universe refresh — fire and forget (spec §5).
// Fetches all CSE, NASDAQ, NYSE equities from authenticated Saxo API and
// saves to MarketUniverseRepository with source=SAXO_API, overriding the seed.
// TTL: 7 days — safe to skip if cache is fresh.
// Does NOT block startup. Does NOT trigger any OpenAI calls.
refreshSaxoUniverseIfStale().then(result => {
  if (result.refreshed.length > 0) {
    logger.info(
      { refreshed: result.refreshed, counts: result.counts, durationMs: result.durationMs },
      "Market Universe Repository upgraded to Saxo-enumerated data"
    );
  } else if (result.error) {
    logger.warn({ error: result.error }, "Saxo universe refresh unavailable — using seed");
  }
}).catch(err => {
  logger.warn({ err }, "Saxo universe background refresh failed — using seed fallback");
});

// Load persisted OpenAI usage log from disk.
initUsageLog();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Start the Automation Orchestrator scheduler.
  // Runs as a background service — does nothing in Manual mode until the user
  // switches to SemiAutomatic.
  automationOrchestrator.start(port);
  logger.info("Automation Orchestrator started");
});

// Check every 5 minutes whether the Saxo access token needs refreshing.
// Does nothing when not connected or when the token is not yet close to expiry.
setInterval(() => {
  maybeSaxoRefresh().catch((err) => {
    logger.error({ err }, "[settings/saxo] Unexpected error in refresh interval");
  });
}, 5 * 60 * 1000);
