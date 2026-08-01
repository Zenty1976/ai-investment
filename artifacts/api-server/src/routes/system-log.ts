/**
 * System Log Route
 *
 * Endpoints:
 *   GET    /system-log  → return all log entries (oldest first)
 *   DELETE /system-log  → clear all log entries
 */

import { Router } from "express";
import { systemLog } from "../lib/system-log.js";

const systemLogRouter = Router();

systemLogRouter.get("/system-log", (_req, res) => {
  res.json(systemLog.getAll());
});

systemLogRouter.delete("/system-log", (_req, res) => {
  systemLog.clear();
  res.json({ ok: true });
});

export default systemLogRouter;
