import app from "./app";
import { logger } from "./lib/logger";
import { maybeSaxoRefresh } from "./routes/settings";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Check every 5 minutes whether the Saxo access token needs refreshing.
// Does nothing when not connected or when the token is not yet close to expiry.
setInterval(() => {
  maybeSaxoRefresh().catch((err) => {
    logger.error({ err }, "[settings/saxo] Unexpected error in refresh interval");
  });
}, 5 * 60 * 1000);
