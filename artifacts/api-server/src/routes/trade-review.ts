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

const router = Router();
const MODULE_NAME = "TradeReview";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProposalStatus = "Waiting" | "Ready" | "Approved" | "Rejected" | "Executed" | "Cancelled";

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
  sizingReason: string;
  sizingConfidence: "High" | "Medium" | "Low" | "";
  createdAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  executedAt: string | null;
  tdeTimestamp: string;
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

const STATUS_ORDER: Record<ProposalStatus, number> = {
  Ready: 0, Waiting: 1, Approved: 2, Rejected: 3, Executed: 4, Cancelled: 5,
};

const PRESERVED_STATUSES: ProposalStatus[] = ["Approved", "Rejected", "Executed", "Cancelled"];

// ---------------------------------------------------------------------------
// GET /trade-review
// ---------------------------------------------------------------------------

router.get("/trade-review", async (_req: Request, res: Response) => {
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

    // Return cached proposals when TDE analysis hasn't changed
    if (
      storedReview?.result?.tdeTimestamp === tdeTimestamp &&
      Array.isArray(storedReview?.result?.proposals)
    ) {
      const cached = storedReview.result as TradeReviewStore;
      return void res.json({
        proposals: cached.proposals,
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

    const decisions = Array.isArray(tdeEntry.result?.decisions)
      ? (tdeEntry.result.decisions as Array<Record<string, unknown>>) : [];

    const proposals: TradeProposal[] = [];

    for (const d of decisions) {
      const decisionType = String(d.decision ?? "");
      if (decisionType !== "PrepareToBuy" && decisionType !== "PrepareToReduce") continue;

      const ticker     = String(d.ticker ?? "").toUpperCase();
      const company    = String(d.company ?? "");
      const action: "BUY" | "SELL" = decisionType === "PrepareToBuy" ? "BUY" : "SELL";
      const decisionId = `${ticker}:${decisionType}`;

      const targetPct = typeof d.targetAllocationPercent === "number" ? d.targetAllocationPercent : 0;
      const sizingConf = (["High", "Medium", "Low"].includes(String(d.sizingConfidence ?? "")))
        ? (String(d.sizingConfidence) as "High" | "Medium" | "Low") : ("" as const);
      const sizingReason = String(d.sizingReason ?? "");

      const pos                 = posMap.get(ticker);
      const currentValueBase    = pos?.marketValueBaseCurrency ?? 0;
      const currentQty          = pos?.quantity ?? 0;
      const currentPrice        = pos?.currentPrice ?? 0;
      const instrumentCurrency  = pos?.currency ?? baseCurrency;
      // Derive FX rate from stored position data (base / instrument)
      const fxRate              = (pos && pos.marketValue > 0)
        ? pos.marketValueBaseCurrency / pos.marketValue : 1;

      const currentAllocPct = totalValue > 0
        ? Math.round((currentValueBase / totalValue) * 1000) / 10 : 0;

      let quantity       = 0;
      let estimatedPrice = 0;
      let estimatedValue = 0;

      if (currentPrice > 0) {
        estimatedPrice = currentPrice;
        const priceInBase = currentPrice * fxRate;

        if (action === "BUY") {
          const targetBase  = totalValue * targetPct / 100;
          const deltaBase   = Math.max(0, targetBase - currentValueBase);
          const cashCap     = totalAvailableCash != null ? totalAvailableCash : deltaBase;
          quantity          = priceInBase > 0 ? Math.floor(Math.min(deltaBase, cashCap) / priceInBase) : 0;
        } else {
          const targetBase  = totalValue * targetPct / 100;
          const deltaBase   = Math.max(0, currentValueBase - targetBase);
          quantity          = priceInBase > 0
            ? Math.min(Math.floor(deltaBase / priceInBase), currentQty) : 0;
        }
        estimatedValue = Math.round(quantity * currentPrice * fxRate);
      }

      const deltaBase         = action === "BUY"
        ? quantity * estimatedPrice * fxRate
        : -(quantity * estimatedPrice * fxRate);
      const resultingAllocPct = totalValue > 0
        ? Math.round(((currentValueBase + deltaBase) / totalValue) * 1000) / 10 : targetPct;

      const availableCashAfterTrade = (totalAvailableCash != null && estimatedValue > 0)
        ? (action === "BUY" ? totalAvailableCash - estimatedValue : totalAvailableCash + estimatedValue)
        : null;

      // Status: preserve deliberate user decisions from previous proposals
      const blocked = d.blockedByEvent === true;
      const prev = prevMap.get(decisionId);
      let status: ProposalStatus;
      if (prev && PRESERVED_STATUSES.includes(prev.status)) {
        status = prev.status;
      } else if (blocked || currentPrice === 0 || quantity === 0) {
        // Blocked by event → always Waiting regardless of calculated quantity.
        // No price or zero quantity → also Waiting (user must supply qty manually).
        status = "Waiting";
      } else {
        status = "Ready";
      }

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
      tdeTimestamp,
      portfolioTotalValue: totalValue || null,
      baseCurrency,
      generatedAt: nowIso,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    systemLog.logError(MODULE_NAME, `GET /trade-review: ${msg}`);
    return void res.status(500).json({ error: "Failed to generate trade review" });
  }
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

    const now      = new Date().toISOString();
    const original = proposals[idx];
    const proposal: TradeProposal = {
      ...original,
      status,
      approvedAt: status === "Approved" ? (original.approvedAt ?? now) : null,
      rejectedAt: status === "Rejected" ? (original.rejectedAt ?? now) : null,
    };

    // Quantity change: proportionally scale estimatedValue
    if (quantity !== undefined) {
      proposal.quantity = quantity;
      if (original.quantity > 0 && original.estimatedValue > 0) {
        proposal.estimatedValue = Math.round((quantity / original.quantity) * original.estimatedValue);
      }
    }

    proposals[idx] = proposal;
    analysisRepository.save("trade-review", { ...stored.result, proposals });

    return void res.json(proposal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    systemLog.logError(MODULE_NAME, `PATCH /trade-review: ${msg}`);
    return void res.status(500).json({ error: "Failed to update trade proposal" });
  }
});

export default router;
