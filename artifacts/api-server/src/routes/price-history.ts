/**
 * Price History Route
 *
 * GET /price-history/:ticker
 *
 * Returns the last 30 daily close prices for any ticker symbol.
 * Results are cached in the analysis repository (price-history:<TICKER>)
 * and shared across all modules — no duplicate Saxo requests.
 *
 * Ticker may include an exchange suffix (e.g. "SERV:XNAS"); the suffix is
 * stripped for Saxo UIC resolution but the full key is stored.
 */

import { Router, type IRouter } from "express";
import { fetchAndStorePriceHistory } from "../lib/price-context-service.js";

const router: IRouter = Router();

router.get("/price-history/:ticker", async (req, res): Promise<void> => {
  const ticker = req.params.ticker?.trim().toUpperCase();
  if (!ticker) {
    res.status(400).json({ error: "ticker is required" });
    return;
  }

  const entry = await fetchAndStorePriceHistory(ticker);
  if (!entry) {
    // Not connected or failed — return null (never mock data)
    res.json(null);
    return;
  }

  res.json(entry);
});

export default router;
