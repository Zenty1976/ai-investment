import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketMonitorRouter from "./market-monitor";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketMonitorRouter);

export default router;
