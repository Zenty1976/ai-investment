/**
 * Automation Orchestrator Routes
 *
 * REST API for the Automation Orchestrator service. All mutations are
 * synchronous — the orchestrator executes module jobs asynchronously
 * in the background.
 */
import { Router, type IRouter } from "express";
import { automationOrchestrator, type ModuleId, type AutomationMode } from "../lib/automation-orchestrator.js";

const router: IRouter = Router();

// ── GET /automation/status ────────────────────────────────────────────────────

router.get("/automation/status", (_req, res): void => {
  try {
    res.json(automationOrchestrator.getStatus());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /automation/jobs ──────────────────────────────────────────────────────

router.get("/automation/jobs", (_req, res): void => {
  try {
    res.json({ jobs: automationOrchestrator.getJobs() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /automation/mode ─────────────────────────────────────────────────────

router.post("/automation/mode", (req, res): void => {
  const { mode } = req.body as { mode?: unknown };
  const valid: AutomationMode[] = ["Manual", "SemiAutomatic", "FullAutomatic"];
  if (!mode || !valid.includes(mode as AutomationMode)) {
    res.status(400).json({ error: `mode must be one of: ${valid.join(", ")}` });
    return;
  }
  try {
    automationOrchestrator.setMode(mode as AutomationMode);
    res.json({ ok: true, mode });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /automation/pause ────────────────────────────────────────────────────

router.post("/automation/pause", (_req, res): void => {
  automationOrchestrator.pause();
  res.json({ ok: true, paused: true });
});

// ── POST /automation/resume ───────────────────────────────────────────────────

router.post("/automation/resume", (_req, res): void => {
  automationOrchestrator.resume();
  res.json({ ok: true, paused: false });
});

// ── POST /automation/run-all ──────────────────────────────────────────────────

router.post("/automation/run-all", (_req, res): void => {
  try {
    const correlationId = automationOrchestrator.startRunAllNow();
    res.json({ ok: true, message: "Full cycle started", correlationId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // startRunAllNow throws synchronously when a cycle is already active
    res.status(409).json({ error: msg });
  }
});

// ── POST /automation/run-all-force ────────────────────────────────────────────
//
// Same as run-all but bypasses the fingerprint-skip check — every AI module
// will make an OpenAI call regardless of whether its inputs have changed.
// Intended for manual debugging/validation; not called by the scheduler.

router.post("/automation/run-all-force", (_req, res): void => {
  try {
    const correlationId = automationOrchestrator.startRunAllNow({ forceAI: true });
    res.json({ ok: true, message: "Full cycle started (force AI refresh)", correlationId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(409).json({ error: msg });
  }
});

// ── POST /automation/run/:moduleId ────────────────────────────────────────────

router.post("/automation/run/:moduleId", (req, res): void => {
  const { moduleId } = req.params;
  const { ticker } = req.body as { ticker?: string };

  const validModules: ModuleId[] = [
    "portfolio-manager", "market-monitor", "news-monitor", "event-monitor",
    "sector-monitor", "company-monitor", "market-alerts", "risk-analyzer",
    "portfolio-analyzer", "opportunity-finder", "trade-decision-engine", "trade-review",
    "investor-watch",
  ];

  if (!validModules.includes(moduleId as ModuleId)) {
    res.status(400).json({ error: `Unknown module: ${moduleId}` });
    return;
  }

  if (moduleId === "company-monitor" && !ticker) {
    res.status(400).json({ error: "company-monitor requires a ticker in the request body" });
    return;
  }

  // Respect the module's Enabled setting even for manual runs.
  // Return 409 so the UI can surface a clear message rather than silently queuing.
  const status = automationOrchestrator.getStatus();
  const modStatus = status.modules.find(m => m.moduleId === moduleId);
  if (modStatus && !modStatus.settings.enabled) {
    res.status(409).json({ error: `${moduleId} is disabled. Enable it in its settings before running.` });
    return;
  }

  automationOrchestrator
    .triggerModule(moduleId as ModuleId, "Manual", { ticker })
    .then((job) => {
      res.json({ ok: true, jobId: job.id });
    })
    .catch((err) => {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    });
});

// ── PUT /automation/modules/:moduleId/settings ────────────────────────────────

router.put("/automation/modules/:moduleId/settings", (req, res): void => {
  const { moduleId } = req.params;
  const patch = req.body as {
    enabled?: boolean;
    supportsAutomaticRun?: boolean;
    intervalMinutes?: number;
    staleAfterMinutes?: number;
    priority?: number;
    reset?: boolean;
  };

  const validModules: ModuleId[] = [
    "portfolio-manager", "market-monitor", "news-monitor", "event-monitor",
    "sector-monitor", "company-monitor", "market-alerts", "risk-analyzer",
    "portfolio-analyzer", "opportunity-finder", "trade-decision-engine", "trade-review",
    "investor-watch",
  ];

  if (!validModules.includes(moduleId as ModuleId)) {
    res.status(400).json({ error: `Unknown module: ${moduleId}` });
    return;
  }

  try {
    if (patch.reset) {
      automationOrchestrator.resetModuleSettings(moduleId as ModuleId);
    } else {
      automationOrchestrator.updateModuleSettings(moduleId as ModuleId, patch);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
