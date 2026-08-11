/**
 * OpenAI Usage Stats Route
 *
 * GET /api/openai-usage/stats?window=today|24h|7d|30d
 * Returns aggregated token usage and estimated cost for the requested time window.
 */
import { Router, type IRouter } from "express";
import { getStats, type TimeWindow } from "../lib/openai-usage-service.js";

const router: IRouter = Router();

const VALID_WINDOWS: TimeWindow[] = ["today", "24h", "7d", "30d"];

router.get("/openai-usage/stats", (req, res): void => {
  const w = (req.query.window as string) ?? "today";
  if (!VALID_WINDOWS.includes(w as TimeWindow)) {
    res.status(400).json({
      error: `Invalid window "${w}". Valid values: ${VALID_WINDOWS.join(", ")}`,
    });
    return;
  }
  res.json(getStats(w as TimeWindow));
});

export default router;
