/**
 * Dashboard Layouts Route
 *
 * Persists dashboard layout configuration (tile positions, active modules,
 * active layout tab) to data/layouts.json so settings survive server restarts,
 * domain changes (preview ↔ deployed), and browser changes.
 *
 * The frontend uses localStorage as a fast synchronous cache and the server
 * as the authoritative persistent store.
 *
 *   GET  /api/layouts   → read full layout state
 *   PUT  /api/layouts   → overwrite full layout state
 */

import { Router, type IRouter } from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const DATA_DIR    = resolve(process.cwd(), "data");
const LAYOUTS_FILE = resolve(DATA_DIR, "layouts.json");

function readFile(): Record<string, unknown> {
  try {
    if (!existsSync(LAYOUTS_FILE)) return {};
    return JSON.parse(readFileSync(LAYOUTS_FILE, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err }, "[layouts] Failed to read layouts.json — returning empty");
    return {};
  }
}

function writeFile(data: unknown): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LAYOUTS_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    logger.error({ err }, "[layouts] Failed to write layouts.json");
    throw err;
  }
}

router.get("/layouts", (_req, res): void => {
  res.json(readFile());
});

router.put("/layouts", (req, res): void => {
  try {
    writeFile(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
