import app from "./app";
import { logger } from "./lib/logger";
import { maybeSaxoRefresh } from "./routes/settings";
import { automationOrchestrator } from "./lib/automation-orchestrator";
import { initPolicyStore } from "./lib/trade-decision-policy-store";

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
