/**
 * Trade Review — Phase 1
 *
 * Converts Trade Decision Engine proposals into concrete, user-reviewable
 * TradeProposal objects. No AI calls. No order placement.
 *
 * GET  /api/trade-review               — return proposals derived from latest TDE
 * PATCH /api/trade-review/:id/status   — update status (Approve/Reject/Later)
 */
import { Router, type Request, type Response } from "express";
import { analysisRepository } from "../lib/analysis-repository";
import { systemLog } from "../lib/system-log";
import { getMarketQuote } from "../lib/market-quote-service.js";
import { saxoStore } from "../lib/saxo-store.js";

const router = Router();
const MODULE_NAME = "TradeReview";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProposalStatus = "Waiting" | "Ready" | "Approved" | "Rejected" | "Executed" | "Cancelled" | "Superseded";

interface TradeProposal {
  id: string;
  decisionId: string;
  action: "BUY" | "SELL";
  ticker: string;
  company: string;
  quantity: number;
  estimatedPrice: number;
  estimatedValue: number;
  currency: string;
  targetAllocationPercent: number;
  currentAllocationPercent: number;
  resultingAllocationPercent: number;
  availableCashAfterTrade: number | null;
  confidence: "High" | "Medium" | "Low";
  urgency: "Immediate" | "Days" | "Weeks" | "NoUrgency";
  shortReason: string;
  reasonScore: number;
  status: ProposalStatus;
  decisionTitle: string;
  decisionRank: number;
  sourceModules: string[];
  blockedByEvent: boolean;
  blockingEvent: string;
  blockingEventDate: string;
  /** Non-null when quantity could not be calculated. Explains why. */
  sizingUnavailableReason: string | null;
  /** Instrument price → portfolio base currency rate. Stored for deterministic PATCH recalculation. */
  fxRate: number;
  /** Current market value of any existing position in base currency (0 for new positions). */
  currentPositionValueBase: number;
  sizingReason: string;
  sizingConfidence: "High" | "Medium" | "Low" | "";
  createdAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  executedAt: string | null;
  tdeTimestamp: string;
}

/** Compact read-only summary of a WaitingForReevaluation trade decision */
interface WaitingDecision {
  /** Stable id, e.g. "CAT:PrepareToBuy" */
  id: string;
  action: "BUY" | "SELL";
  ticker: string;
  company: string;
  /** Concise vocabulary label: "Event blocked" | "Missing analysis" | "Conflicting evidence" | "Stale data" | "Waiting for re-evaluation" */
  waitingLabel: string;
  /** Name of the event blocking this decision (empty string when not event-blocked) */
  blockingEvent: string;
  /** ISO date of the blocking event, e.g. "2026-08-04" (empty string when unknown) */
  blockingEventDate: string;
  /** One-sentence readiness reason (server-computed by TDE) */
  readinessReason: string;
  decisionRank: number;
}

interface TradeReviewStore {
  proposals: TradeProposal[];
  tdeTimestamp: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractShortReason(d: Record<string, unknown>): string {
  // Prefer sizingReason (already one-sentence)
  if (typeof d.sizingReason === "string" && d.sizingReason.trim()) {
    const r = d.sizingReason.trim();
    return r.split(/[.!?]/)[0]?.trim() || r;
  }
  // First supporting evidence item
  const evidence = Array.isArray(d.supportingEvidence) ? (d.supportingEvidence as string[]) : [];
  if (evidence.length > 0 && typeof evidence[0] === "string") {
    return String(evidence[0]).split(/[.!?]/)[0]?.trim() || String(evidence[0]);
  }
  // First sentence of reason
  if (typeof d.reason === "string" && d.reason.trim()) {
    const r = d.reason.trim();
    return r.split(/[.!?]/)[0]?.trim() || r.substring(0, 100);
  }
  return "";
}

/**
 * Backend-computed evidence score: 0–100.
 *
 * Measures DECISION QUALITY — not execution readiness.
 * Execution readiness is communicated separately via proposal status and blockedByEvent.
 *
 * Factors:
 *   Confidence (0–40) + module breadth (0–25) + key module bonuses (0–35)
 * Penalties:
 *   blockedByEvent (–5, small — only slightly reduces score) + missing evidence (–5)
 *
 * Target ranges:
 *   Excellent idea, blocked by event → 75–90
 *   Weak evidence, conflicting       → 20–40
 */
function computeReasonScore(d: Record<string, unknown>): number {
  const mods    = Array.isArray(d.sourceModules) ? (d.sourceModules as string[]) : [];
  const conf    = String(d.confidence ?? "");
  const blocked = d.blockedByEvent === true;
  const missing = Array.isArray(d.missingEvidence) ? d.missingEvidence : [];

  // Confidence: 0–40
  const confScore = conf === "High" ? 40 : conf === "Medium" ? 25 : 10;

  // Breadth: 0–25 (each unique module adds 5, capped at 5 modules)
  const breadthScore = Math.min(25, mods.length * 5);

  // Key module bonuses: 0–35
  let keyScore = 0;
  if (mods.includes("RiskAnalyzer"))      keyScore += 12;  // diversification/risk view
  if (mods.includes("CompanyMonitor"))    keyScore += 10;  // fundamental company support
  if (mods.includes("OpportunityFinder")) keyScore += 8;   // systematic opportunity signal
  if (mods.includes("MarketAlerts"))      keyScore += 3;   // market context
  if (mods.includes("NewsMonitor"))       keyScore += 1;
  if (mods.includes("SectorMonitor"))     keyScore += 1;

  // Penalties — small: execution timing should not dominate the quality score
  const blockPenalty   = blocked ? 5 : 0;          // was 20 — now only a slight reduction
  const missingPenalty = missing.length >= 3 ? 5 : 0;

  return Math.max(0, Math.min(100, confScore + breadthScore + keyScore - blockPenalty - missingPenalty));
}

function computeWaitingLabel(d: Record<string, unknown>): string {
  if (d.blockedByEvent === true && d.blockingEvent) return "Event blocked";
  const reason = String(d.readinessReason ?? "").toLowerCase();
  if (reason.includes("missing")) return "Missing analysis";
  if (reason.includes("conflict")) return "Conflicting evidence";
  if (reason.includes("stale") || reason.includes("outdated")) return "Stale data";
  return "Waiting for re-evaluation";
}

/**
 * Extract WaitingForReevaluation PrepareToBuy/PrepareToReduce decisions for
 * the compact read-only section in Trade Review. Always derived fresh from TDE
 * data — no user state to preserve.
 */
function computeWaitingDecisions(decisions: Array<Record<string, unknown>>): WaitingDecision[] {
  const seen = new Set<string>();
  const result: WaitingDecision[] = [];

  for (const d of decisions) {
    const decisionType = String(d.decision ?? "");
    if (decisionType !== "PrepareToBuy" && decisionType !== "PrepareToReduce") continue;

    const readiness       = String(d.readiness ?? "");
    const isLegacyBlocked = !readiness && d.blockedByEvent === true;
    if (readiness !== "WaitingForReevaluation" && !isLegacyBlocked) continue;

    const ticker = String(d.ticker ?? "").toUpperCase();
    const id     = `${ticker}:${decisionType}`;
    if (seen.has(id)) continue;
    seen.add(id);

    result.push({
      id,
      action:           decisionType === "PrepareToBuy" ? "BUY" : "SELL",
      ticker,
      company:          String(d.company ?? ""),
      waitingLabel:     computeWaitingLabel(d),
      blockingEvent:    String(d.blockingEvent ?? ""),
      blockingEventDate: String(d.blockingEventDate ?? ""),
      readinessReason:  String(d.readinessReason ?? ""),
      decisionRank:     typeof d.rank === "number" ? d.rank : 999,
    });
  }

  return result.sort((a, b) => a.decisionRank - b.decisionRank);
}

const STATUS_ORDER: Record<ProposalStatus, number> = {
  Ready: 0, Waiting: 1, Approved: 2, Rejected: 3, Executed: 4, Cancelled: 5, Superseded: 6,
};

const PRESERVED_STATUSES: ProposalStatus[] = ["Approved", "Rejected", "Executed", "Cancelled"];

// ---------------------------------------------------------------------------
// Shared generation logic (GET with cache, POST forced refresh)
// ---------------------------------------------------------------------------

async function doHandleTradeReview(res: Response, useCache: boolean): Promise<void> {
  try {
    const tdeEntry       = analysisRepository.get<Record<string, unknown>>("trade-decision-engine");
    const portfolioEntry = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
    const storedReview   = analysisRepository.get<TradeReviewStore>("trade-review");
    const nowIso         = new Date().toISOString();

    const portfolioResult    = portfolioEntry?.result as Record<string, unknown> | undefined;
    const totalValue         = typeof portfolioResult?.totalValue === "number" ? portfolioResult.totalValue : 0;
    const baseCurrency       = String(portfolioResult?.baseCurrency ?? "Unknown");
    const totalAvailableCash = typeof portfolioResult?.totalAvailableCash === "number"
      ? portfolioResult.totalAvailableCash : null;

    if (!tdeEntry) {
      return void res.json({
        proposals: [], tdeTimestamp: null,
        portfolioTotalValue: totalValue || null, baseCurrency, generatedAt: nowIso,
      });
    }

    const tdeTimestamp = String(tdeEntry.result?.timestamp ?? "");

    // Extract TDE decisions early — needed for waiting-decision computation
    // regardless of whether we serve from cache or regenerate.
    const allDecisions = Array.isArray(tdeEntry.result?.decisions)
      ? (tdeEntry.result.decisions as Array<Record<string, unknown>>) : [];

    // WaitingForReevaluation decisions are always derived fresh from TDE data
    // (they carry no user-mutable state, so there is nothing to preserve).
    const waitingDecisions = computeWaitingDecisions(allDecisions);

    // Return cached proposals when TDE analysis hasn't changed AND the cached
    // proposals are schema-compatible:
    //   - have the fxRate field (introduced in a previous version)
    //   - contain no legacy event-blocked proposals (under the old rules,
    //     blocked decisions were converted into "Waiting" proposals; under the
    //     new readiness model they must NOT appear in Trade Review at all)
    const cachedProposals = storedReview?.result?.proposals as TradeProposal[] | undefined;
    const cacheIsCompatible =
      Array.isArray(cachedProposals) &&
      cachedProposals.every((p) => {
        const pr = p as Record<string, unknown>;
        return (
          typeof pr.fxRate === "number" &&
          pr.blockedByEvent !== true          // bust if old blocked proposals exist
        );
      });

    if (
      useCache &&
      storedReview?.result?.tdeTimestamp === tdeTimestamp &&
      cacheIsCompatible
    ) {
      const cached = storedReview.result as TradeReviewStore;
      return void res.json({
        proposals: cached.proposals,
        waitingDecisions,
        tdeTimestamp: cached.tdeTimestamp,
        portfolioTotalValue: totalValue || null,
        baseCurrency,
        generatedAt: cached.generatedAt,
      });
    }

    // ── Build position map from portfolio data ───────────────────────────────

    interface PosData {
      currentPrice: number; quantity: number;
      marketValue: number; marketValueBaseCurrency: number;
      currency: string;
    }
    const posMap = new Map<string, PosData>();
    const accounts = Array.isArray(portfolioResult?.accounts)
      ? (portfolioResult!.accounts as Array<Record<string, unknown>>) : [];

    for (const acc of accounts) {
      const positions = Array.isArray(acc.positions)
        ? (acc.positions as Array<Record<string, unknown>>) : [];
      for (const pos of positions) {
        const ticker = String(pos.symbol ?? "").toUpperCase();
        posMap.set(ticker, {
          currentPrice:            typeof pos.currentPrice === "number" ? pos.currentPrice : 0,
          quantity:                typeof pos.quantity === "number" ? pos.quantity : 0,
          marketValue:             typeof pos.marketValue === "number" ? pos.marketValue : 0,
          marketValueBaseCurrency: typeof pos.marketValueBaseCurrency === "number" ? pos.marketValueBaseCurrency : 0,
          currency:                String(pos.currency ?? ""),
        });
      }
    }

    // ── Preserve user-decided statuses from previous proposals ───────────────

    const prevMap = new Map<string, TradeProposal>();
    if (Array.isArray(storedReview?.result?.proposals)) {
      for (const p of storedReview!.result!.proposals as TradeProposal[]) {
        prevMap.set(p.decisionId, p);
      }
    }

    // ── Convert TDE decisions → TradeProposals ───────────────────────────────

    const proposals: TradeProposal[] = [];
    const isMockMode = saxoStore.isMockMode();

    for (const d of allDecisions) {
      const decisionType = String(d.decision ?? "");
      if (decisionType !== "PrepareToBuy" && decisionType !== "PrepareToReduce") continue;

      // ── Readiness gate ───────────────────────────────────────────────────
      // Only ReadyForReview decisions become approvable Trade Review proposals.
      // WaitingForReevaluation (blocked by event or otherwise incomplete) must
      // NOT appear in Trade Review — they remain visible in Trade Decision only.
      // Fall back to blockedByEvent for TDE data that predates the readiness field.
      const readiness = String(d.readiness ?? "");
      if (readiness === "WaitingForReevaluation") {
        systemLog.logInternal(
          MODULE_NAME,
          `Decision ${String(d.ticker ?? "")}: WaitingForReevaluation — not converted to proposal`
        );
        continue;
      }
      if (!readiness && d.blockedByEvent === true) {
        // Legacy TDE data without readiness field: treat blocked as WaitingForReevaluation
        systemLog.logInternal(
          MODULE_NAME,
          `Decision ${String(d.ticker ?? "")}: legacy blocked — not converted to proposal`
        );
        continue;
      }

      const ticker     = String(d.ticker ?? "").toUpperCase();
      const company    = String(d.company ?? "");
      const action: "BUY" | "SELL" = decisionType === "PrepareToBuy" ? "BUY" : "SELL";
      const decisionId = `${ticker}:${decisionType}`;

      const targetPct = typeof d.targetAllocationPercent === "number" ? d.targetAllocationPercent : 0;
      const sizingConf = (["High", "Medium", "Low"].includes(String(d.sizingConfidence ?? "")))
        ? (String(d.sizingConfidence) as "High" | "Medium" | "Low") : ("" as const);
      const sizingReason = String(d.sizingReason ?? "");

      const pos              = posMap.get(ticker);
      const currentValueBase = pos?.marketValueBaseCurrency ?? 0;
      const currentQty       = pos?.quantity ?? 0;

      // ── Price lookup ─────────────────────────────────────────────────────
      // Priority 1: position data from Portfolio Manager (held stocks already
      //             have a live or mock price from the last portfolio refresh).
      // Priority 2: market quote service (covers opportunity candidates and
      //             stocks not yet held — uses mock quotes when in mock mode).
      const priceFromPos  = pos?.currentPrice ?? 0;
      const fxRateFromPos = (pos && pos.marketValue > 0)
        ? pos.marketValueBaseCurrency / pos.marketValue : 0;

      const quote = priceFromPos > 0 ? null : getMarketQuote(ticker, isMockMode);

      const estimatedPrice     = priceFromPos > 0 ? priceFromPos   : (quote?.price    ?? 0);
      const instrumentCurrency = pos?.currency   || quote?.currency || baseCurrency;
      const fxRate             = fxRateFromPos > 0 ? fxRateFromPos  : (quote?.fxToBase ?? 1);

      const currentAllocPct = totalValue > 0
        ? Math.round((currentValueBase / totalValue) * 1000) / 10 : 0;

      // ── Sizing availability ───────────────────────────────────────────────
      // Do not display "0 shares" when data is missing — explain the gap instead.
      let sizingUnavailableReason: string | null = null;
      if (targetPct <= 0) {
        sizingUnavailableReason = "Missing target allocation";
      } else if (estimatedPrice <= 0) {
        sizingUnavailableReason = "Market price unavailable";
      } else if (fxRate <= 0) {
        sizingUnavailableReason = "FX rate unavailable";
      }

      // ── Quantity calculation ──────────────────────────────────────────────
      // Runs regardless of blockedByEvent — a blocked trade still has a
      // proposed position size; only execution is deferred.
      let quantity       = 0;
      let estimatedValue = 0;

      if (!sizingUnavailableReason) {
        const priceInBase = estimatedPrice * fxRate;

        if (action === "BUY") {
          const targetBase = totalValue * targetPct / 100;
          const deltaBase  = Math.max(0, targetBase - currentValueBase);
          const cashCap    = totalAvailableCash != null ? totalAvailableCash : deltaBase;
          quantity         = priceInBase > 0 ? Math.floor(Math.min(deltaBase, cashCap) / priceInBase) : 0;
        } else {
          const targetBase = totalValue * targetPct / 100;
          const deltaBase  = Math.max(0, currentValueBase - targetBase);
          quantity         = priceInBase > 0
            ? Math.min(Math.floor(deltaBase / priceInBase), currentQty) : 0;
        }
        estimatedValue = Math.round(quantity * estimatedPrice * fxRate);
      }

      const deltaBase         = action === "BUY"
        ? quantity * estimatedPrice * fxRate
        : -(quantity * estimatedPrice * fxRate);
      const resultingAllocPct = totalValue > 0
        ? Math.round(((currentValueBase + deltaBase) / totalValue) * 1000) / 10 : targetPct;

      const availableCashAfterTrade = (totalAvailableCash != null && estimatedValue > 0)
        ? (action === "BUY" ? totalAvailableCash - estimatedValue : totalAvailableCash + estimatedValue)
        : null;

      // ── Status ────────────────────────────────────────────────────────────
      // Only ReadyForReview decisions reach this point (WaitingForReevaluation
      // was already filtered out above). Deliberate user decisions are preserved.
      // Sizing unavailable → Waiting (user cannot approve without a quantity).
      // Otherwise Ready when a valid non-zero quantity was calculated.
      const blocked = d.blockedByEvent === true; // always false here (gate above)
      const prev = prevMap.get(decisionId);
      let status: ProposalStatus;
      if (prev && PRESERVED_STATUSES.includes(prev.status)) {
        status = prev.status;
      } else if (sizingUnavailableReason !== null || quantity === 0) {
        status = "Waiting";
      } else {
        status = "Ready";
      }

      systemLog.logInternal(MODULE_NAME, `Trade Review proposal created: ${action} ${ticker} → ${status}`);

      proposals.push({
        id: decisionId,
        decisionId,
        action,
        ticker,
        company,
        quantity,
        estimatedPrice,
        estimatedValue,
        currency: instrumentCurrency,
        targetAllocationPercent: targetPct,
        currentAllocationPercent: currentAllocPct,
        resultingAllocationPercent: resultingAllocPct,
        availableCashAfterTrade,
        confidence: (["High", "Medium", "Low"].includes(String(d.confidence ?? "")))
          ? (String(d.confidence) as "High" | "Medium" | "Low") : "Medium",
        urgency: (["Immediate", "Days", "Weeks", "NoUrgency"].includes(String(d.urgency ?? "")))
          ? (String(d.urgency) as "Immediate" | "Days" | "Weeks" | "NoUrgency") : "NoUrgency",
        shortReason:              extractShortReason(d),
        reasonScore:              computeReasonScore(d),
        status,
        decisionTitle:            String(d.title ?? ""),
        decisionRank:             typeof d.rank === "number" ? d.rank : 0,
        sourceModules:            Array.isArray(d.sourceModules) ? (d.sourceModules as string[]) : [],
        blockedByEvent:           blocked,
        blockingEvent:            String(d.blockingEvent ?? ""),
        blockingEventDate:        String(d.blockingEventDate ?? ""),
        sizingUnavailableReason,
        fxRate,
        currentPositionValueBase: currentValueBase,
        sizingReason,
        sizingConfidence:         sizingConf,
        createdAt:                prev?.createdAt ?? nowIso,
        approvedAt:               status === "Approved" ? (prev?.approvedAt ?? nowIso) : null,
        rejectedAt:               status === "Rejected" ? (prev?.rejectedAt ?? nowIso) : null,
        executedAt:               prev?.executedAt ?? null,
        tdeTimestamp,
      });
    }

    proposals.sort((a, b) =>
      (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (a.decisionRank - b.decisionRank)
    );

    analysisRepository.save("trade-review", { proposals, tdeTimestamp, generatedAt: nowIso });

    return void res.json({
      proposals,
      waitingDecisions,
      tdeTimestamp,
      portfolioTotalValue: totalValue || null,
      baseCurrency,
      generatedAt: nowIso,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    systemLog.logError(MODULE_NAME, `trade-review generation failed: ${msg}`);
    return void res.status(500).json({ error: "Failed to generate trade review" });
  }
}

// ---------------------------------------------------------------------------
// GET /trade-review  (cache-aware: returns stored data when TDE unchanged)
// ---------------------------------------------------------------------------

router.get("/trade-review", (_req: Request, res: Response) => {
  return doHandleTradeReview(res, true /* useCache */);
});

// ---------------------------------------------------------------------------
// POST /trade-review/generate  (orchestration endpoint: always forces refresh)
// ---------------------------------------------------------------------------

router.post("/trade-review/generate", (req: Request, res: Response) => {
  const orchestratorTrigger = req.headers['x-orchestrator-trigger'];
  if (orchestratorTrigger) {
    systemLog.logInfo(MODULE_NAME, `Orchestrated run (trigger: ${orchestratorTrigger}): generating fresh trade review`);
  } else {
    systemLog.logUser(MODULE_NAME, "User requested forced trade review regeneration");
  }
  return doHandleTradeReview(res, false /* useCache */);
});

// ---------------------------------------------------------------------------
// PATCH /trade-review/:id/status
// ---------------------------------------------------------------------------

const VALID_STATUSES = ["Waiting", "Ready", "Approved", "Rejected"] as const;
type PatchStatus = (typeof VALID_STATUSES)[number];

function parseUpdateBody(
  body: unknown
): { status: PatchStatus; quantity?: number } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (!VALID_STATUSES.includes(b.status as PatchStatus)) {
    return { error: `status must be one of: ${VALID_STATUSES.join(", ")}` };
  }
  const result: { status: PatchStatus; quantity?: number } = {
    status: b.status as PatchStatus,
  };
  if (b.quantity !== undefined) {
    const q = Number(b.quantity);
    if (!Number.isInteger(q) || q < 0) return { error: "quantity must be a non-negative integer" };
    result.quantity = q;
  }
  return result;
}

router.patch("/trade-review/:id/status", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const parsed = parseUpdateBody(req.body);
    if ("error" in parsed) {
      return void res.status(400).json({ error: parsed.error });
    }
    const { status, quantity } = parsed;

    const stored = analysisRepository.get<TradeReviewStore>("trade-review");
    if (!stored || !Array.isArray(stored.result?.proposals)) {
      return void res.status(404).json({ error: "No trade review proposals found" });
    }

    const proposals = [...(stored.result.proposals as TradeProposal[])];
    const idx = proposals.findIndex((p) => p.id === id);
    if (idx === -1) {
      return void res.status(404).json({ error: `Proposal "${id}" not found` });
    }

    // Re-read portfolio totals for allocation recalculation (live values preferred)
    const portfolioEntry    = analysisRepository.get<Record<string, unknown>>("portfolio-manager");
    const portfolioResult   = portfolioEntry?.result as Record<string, unknown> | undefined;
    const totalValue        = typeof portfolioResult?.totalValue         === "number" ? portfolioResult.totalValue         : 0;
    const totalAvailableCash = typeof portfolioResult?.totalAvailableCash === "number" ? portfolioResult.totalAvailableCash : null;

    const now      = new Date().toISOString();
    const original = proposals[idx];
    const proposal: TradeProposal = {
      ...original,
      status,
      approvedAt: status === "Approved" ? (original.approvedAt ?? now) : null,
      rejectedAt: status === "Rejected" ? (original.rejectedAt ?? now) : null,
    };

    // Quantity change: deterministic recalculation using stored fxRate and price.
    // This works even when the original quantity was 0 (e.g. previously missing data).
    // fxRate falls back to 1 for legacy cached proposals that predate the field.
    if (quantity !== undefined) {
      const safeFxRate = (proposal.fxRate > 0 ? proposal.fxRate : null) ?? 1;
      proposal.quantity       = quantity;
      proposal.estimatedValue = Math.round(quantity * proposal.estimatedPrice * safeFxRate);

      if (totalValue > 0) {
        const deltaBase = proposal.action === "BUY"
          ? quantity * proposal.estimatedPrice * proposal.fxRate
          : -(quantity * proposal.estimatedPrice * proposal.fxRate);
        proposal.resultingAllocationPercent = Math.round(
          ((proposal.currentPositionValueBase + deltaBase) / totalValue) * 1000
        ) / 10;
      }

      if (totalAvailableCash !== null) {
        proposal.availableCashAfterTrade = proposal.action === "BUY"
          ? totalAvailableCash - proposal.estimatedValue
          : totalAvailableCash + proposal.estimatedValue;
      }

      // Clear the unavailability flag if the user has manually supplied a quantity
      if (quantity > 0 && proposal.sizingUnavailableReason) {
        proposal.sizingUnavailableReason = null;
      }
    }

    proposals[idx] = proposal;
    analysisRepository.save("trade-review", { ...stored.result, proposals });

    // ── Outcome tracking (non-blocking) ──────────────────────────────────────
    if (status === "Approved" || status === "Rejected") {
      try {
        const { updateDecisionOutcomeFromReview } = await import("../lib/trade-decision-outcome-store.js");
        // decisionId = ticker:decision reconstructed from proposal ticker + action
        const decisionType = original.action === "BUY" ? "PrepareToBuy" : "PrepareToReduce";
        updateDecisionOutcomeFromReview({
          decisionId:     `${original.ticker}:${decisionType}`,
          newStatus:      status as "Approved" | "Rejected",
          quantity:       proposal.quantity,
          estimatedPrice: proposal.estimatedPrice,
          currency:       original.currency,
          note:           `${status} in Trade Review`,
        });
      } catch {
        // Outcome tracking errors never break the Trade Review response
      }
    }

    return void res.json(proposal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    systemLog.logError(MODULE_NAME, `PATCH /trade-review: ${msg}`);
    return void res.status(500).json({ error: "Failed to update trade proposal" });
  }
});

export default router;
