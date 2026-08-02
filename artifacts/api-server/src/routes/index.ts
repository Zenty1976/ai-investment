import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketMonitorRouter from "./market-monitor";
import eventMonitorRouter from "./event-monitor";
import newsMonitorRouter from "./news-monitor";
import sectorMonitorRouter from "./sector-monitor";
import companyMonitorRouter from "./company-monitor";
import portfolioManagerRouter from "./portfolio-manager";
import portfolioAnalyzerRouter from "./portfolio-analyzer";
import opportunityFinderRouter from "./opportunity-finder";
import riskAnalyzerRouter from "./risk-analyzer";
import marketAlertsRouter from "./market-alerts";
import tradeDecisionEngineRouter from "./trade-decision-engine";
import repositoryRouter from "./repository";
import settingsRouter from "./settings";
import systemLogRouter from "./system-log";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketMonitorRouter);
router.use(eventMonitorRouter);
router.use(newsMonitorRouter);
router.use(sectorMonitorRouter);
router.use(companyMonitorRouter);
router.use(portfolioManagerRouter);
router.use(portfolioAnalyzerRouter);
router.use(opportunityFinderRouter);
router.use(riskAnalyzerRouter);
router.use(marketAlertsRouter);
router.use(tradeDecisionEngineRouter);
router.use(repositoryRouter);
router.use(settingsRouter);
router.use(systemLogRouter);

export default router;
