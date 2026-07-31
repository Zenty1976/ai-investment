import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketMonitorRouter from "./market-monitor";
import eventMonitorRouter from "./event-monitor";
import newsMonitorRouter from "./news-monitor";
import repositoryRouter from "./repository";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketMonitorRouter);
router.use(eventMonitorRouter);
router.use(newsMonitorRouter);
router.use(repositoryRouter);

export default router;
