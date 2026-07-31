/**
 * Analysis Repository Routes
 *
 * Read-only HTTP interface to the in-memory Analysis Repository.
 * Write access is intentionally server-internal only — modules save results
 * by calling analysisRepository.save() directly, never via HTTP.
 */
import { Router, type IRouter } from "express";
import { analysisRepository } from "../lib/analysis-repository";

const router: IRouter = Router();

/** GET /repository — all stored module results, ordered by most recently updated */
router.get("/repository", (_req, res): void => {
  res.json(analysisRepository.getAll());
});

/** GET /repository/:module — latest result for a specific module */
router.get("/repository/:module", (req, res): void => {
  const entry = analysisRepository.get(req.params.module);
  if (!entry) {
    res.status(404).json({ error: `No result stored for module "${req.params.module}"` });
    return;
  }
  res.json(entry);
});

export default router;
