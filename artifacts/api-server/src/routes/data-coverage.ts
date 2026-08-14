/**
 * Data Coverage Route — Provider health and data gap reporting (spec §25).
 *
 * GET  /data-coverage
 *   Returns the full DataCoverageReport: provider capabilities, universe stats,
 *   expectations status, and a prioritized list of external data gaps.
 *
 * POST /data-coverage/refresh-universe
 *   Triggers a synchronous Saxo universe refresh (bypasses TTL for one exchange
 *   if specified, or refreshes all stale exchanges).
 *   Body: { exchange?: "CSE" | "NASDAQ" | "NYSE" }
 *
 * This is a system/debug endpoint. Not part of the investment pipeline.
 */

import { Router } from "express";
import { buildDataCoverageReport } from "../lib/data-provider-registry.js";
import {
  refreshSaxoUniverseIfStale,
  forceRefreshExchange,
} from "../lib/saxo-universe-refresh.js";

const router = Router();

router.get("/data-coverage", (_req, res) => {
  try {
    const report = buildDataCoverageReport();
    res.json(report);
  } catch (err) {
    res.status(500).json({
      error: "Failed to build data coverage report",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

router.post("/data-coverage/refresh-universe", async (req, res) => {
  try {
    const { exchange } = req.body as { exchange?: string };
    if (exchange) {
      const result = await forceRefreshExchange(exchange.toUpperCase());
      res.json({
        exchange: exchange.toUpperCase(),
        ...result,
        report: buildDataCoverageReport(),
      });
    } else {
      const result = await refreshSaxoUniverseIfStale();
      res.json({ ...result, report: buildDataCoverageReport() });
    }
  } catch (err) {
    res.status(500).json({
      error: "Universe refresh failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
