/**
 * Data Coverage Route — Provider health and data gap reporting (spec §25).
 *
 * GET /data-coverage
 *   Returns the full DataCoverageReport: provider capabilities, universe stats,
 *   expectations status, and a prioritized list of external data gaps.
 *
 * This is a system/debug endpoint. Not part of the investment pipeline.
 */

import { Router } from "express";
import { buildDataCoverageReport } from "../lib/data-provider-registry.js";

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

export default router;
