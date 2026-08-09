import { useRef, useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetTradeReview,
  useUpdateTradeProposalStatus,
} from "@workspace/api-client-react";
import type { TradeProposal, TradeProposalStatus, WaitingTradeDecision } from "@workspace/api-client-react";
import {
  CheckCircle2, XCircle, Clock, ExternalLink,
  AlertTriangle, ClipboardList, CalendarClock, Info,
  RefreshCw, Minus, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useTileSize } from "@/hooks/useTileSize";
import { WidgetSpinner } from "@/lib/widget-components";
import { format, parseISO } from "date-fns";

// ── helpers ──────────────────────────────────────────────────────────────────

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "positive" | "warning" | "negative";

function confidenceVariant(c: string): BadgeVariant {
  return c === "High" ? "positive" : c === "Medium" ? "warning" : "secondary";
}

function statusVariant(s: TradeProposalStatus): BadgeVariant {
  if (s === "Approved") return "positive";
  if (s === "Rejected") return "negative";
  if (s === "Ready")    return "default";
  return "outline";
}

function fmt2(n: number) {
  return n.toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmt0(n: number) {
  return n.toLocaleString("da-DK", { maximumFractionDigits: 0 });
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return format(parseISO(iso), "d MMM, HH:mm"); } catch { return "—"; }
}

function formatEventDateShort(iso: string | undefined): string {
  if (!iso) return "";
  try { return format(parseISO(iso), "d MMM"); } catch { return iso; }
}

// ── DecisionStrength circle ───────────────────────────────────────────────────

function DecisionStrength({ score }: { score: number }) {
  const stroke = score >= 70 ? "#10b981" : score >= 45 ? "#f59e0b" : "#f43f5e";
  const label  = score >= 70 ? "Strong" : score >= 45 ? "Moderate" : "Weak";
  const circumference = 2 * Math.PI * 13;
  const dashLen = (score / 100) * circumference;
  return (
    <div className="flex items-center gap-1.5" title="Decision strength — how strongly analyses support this trade">
      <div className="relative w-7 h-7 shrink-0">
        <svg viewBox="0 0 32 32" className="w-7 h-7 -rotate-90">
          <circle cx="16" cy="16" r="13" fill="none" stroke="hsl(var(--muted))" strokeWidth="3" />
          <circle cx="16" cy="16" r="13" fill="none" stroke={stroke} strokeWidth="3"
            strokeDasharray={`${dashLen} ${circumference}`} strokeLinecap="round" />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold leading-none">
          {score}
        </span>
      </div>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

// ── Compact proposal row (for md/lg list) ─────────────────────────────────────

interface RowProps {
  proposal: TradeProposal;
  qty: number;
  onQtyChange: (id: string, qty: number) => void;
  onAction: (id: string, status: "Approved" | "Rejected" | "Waiting", qty: number) => Promise<void>;
  onNavigate: () => void;
  isMutating: boolean;
  showQty: boolean;
}

function ProposalRow({ proposal, qty, onQtyChange, onAction, onNavigate, isMutating, showQty }: RowProps) {
  const isBuy     = proposal.action === "BUY";
  const isDecided = proposal.status === "Approved" || proposal.status === "Rejected";
  const actionColor = isBuy ? "text-emerald-400" : "text-rose-400";
  const borderColor = isBuy ? "border-l-emerald-500/40" : "border-l-rose-500/40";

  return (
    <div className={`border-l-2 ${borderColor} pl-2.5 py-2 space-y-1.5`}>
      {/* Row 1: action · company · ticker · status */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={`text-[11px] font-bold tracking-widest shrink-0 ${actionColor}`}>
          {proposal.action}
        </span>
        <span className="text-[11px] text-muted-foreground/40 shrink-0">·</span>
        <span className="text-[11px] font-medium truncate flex-1">{proposal.company}</span>
        <span className="text-[11px] font-mono text-muted-foreground/60 shrink-0">{proposal.ticker}</span>
        <Badge variant={statusVariant(proposal.status)} className="text-[9px] px-1 py-0 h-3.5 shrink-0 ml-1">
          {proposal.status}
        </Badge>
      </div>

      {/* Row 2: price + qty (if showQty) + reason snippet */}
      {showQty && (
        <div className="flex items-center gap-2 flex-wrap">
          {proposal.estimatedPrice > 0 && (
            <span className="text-[10px] text-muted-foreground font-mono">
              {fmt2(proposal.estimatedPrice)} {proposal.currency}
            </span>
          )}
          <div className="flex items-center gap-0.5 shrink-0">
            <Button variant="outline" size="icon" className="h-5 w-5"
              onClick={() => onQtyChange(proposal.id, Math.max(0, qty - 1))}
              disabled={isMutating || qty <= 0}>
              <Minus className="h-2 w-2" />
            </Button>
            <input
              type="number" value={qty} min={0}
              onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) onQtyChange(proposal.id, v); }}
              className="w-10 text-center text-[11px] font-mono bg-transparent border border-border rounded px-0.5 py-0
                [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <Button variant="outline" size="icon" className="h-5 w-5"
              onClick={() => onQtyChange(proposal.id, qty + 1)}
              disabled={isMutating}>
              <Plus className="h-2 w-2" />
            </Button>
            <span className="text-[10px] text-muted-foreground ml-0.5">shares</span>
          </div>
          {proposal.estimatedValue > 0 && qty > 0 && (
            <span className="text-[10px] text-muted-foreground">
              ≈ {fmt0(Math.round((qty / (proposal.quantity || 1)) * proposal.estimatedValue))} kr
            </span>
          )}
        </div>
      )}

      {/* Row 3: confidence + strength + actions */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge variant={confidenceVariant(proposal.confidence)} className="text-[9px] px-1 py-0 h-3.5">
          {proposal.confidence}
        </Badge>
        <DecisionStrength score={proposal.reasonScore} />
        <div className="ml-auto flex items-center gap-1">
          {!isDecided && (
            <>
              <Button size="sm" className="h-6 text-[10px] bg-emerald-600 hover:bg-emerald-700 text-white px-2"
                onClick={() => onAction(proposal.id, "Approved", qty)}
                disabled={isMutating || qty === 0}
                title={qty === 0 ? "Set quantity first" : undefined}>
                <CheckCircle2 className="h-3 w-3 mr-0.5" /> Approve
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-[10px] text-muted-foreground px-1.5"
                onClick={() => onAction(proposal.id, "Waiting", qty)}
                disabled={isMutating}>
                <Clock className="h-3 w-3 mr-0.5" /> Later
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-[10px] text-rose-500 hover:text-rose-400 px-1.5"
                onClick={() => onAction(proposal.id, "Rejected", qty)}
                disabled={isMutating}>
                <XCircle className="h-3 w-3 mr-0.5" /> Reject
              </Button>
            </>
          )}
          {isDecided && (
            <Button size="sm" variant="outline" className="h-6 text-[10px] px-2"
              onClick={() => onAction(proposal.id, "Waiting", qty)}
              disabled={isMutating}>
              Undo
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-6 text-[10px] px-1"
            onClick={onNavigate}>
            <ExternalLink className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Waiting row ───────────────────────────────────────────────────────────────

function WaitingRow({ item, isLast, onNavigate }: { item: WaitingTradeDecision; isLast: boolean; onNavigate: () => void }) {
  const actionColor = item.action === "BUY" ? "text-emerald-500/60" : "text-rose-500/60";
  const labelVariant = item.waitingLabel === "Event blocked" ? "warning" : "secondary";
  const eventDate = formatEventDateShort(item.blockingEventDate);
  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1.5 cursor-pointer hover:bg-muted/20 transition-colors overflow-hidden ${!isLast ? "border-b border-border/30" : ""}`}
      onClick={onNavigate}
    >
      <span className={`text-[10px] font-bold tracking-widest shrink-0 ${actionColor}`}>
        {item.action === "BUY" ? "BUY" : "SELL"}
      </span>
      <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0">{item.ticker}</span>
      <Badge variant={labelVariant} className="text-[9px] px-1 py-0 h-3.5 shrink-0">{item.waitingLabel}</Badge>
      {item.blockingEvent && (
        <span className="text-[10px] text-muted-foreground/60 truncate">
          {item.blockingEvent}{eventDate ? ` · ${eventDate}` : ""}
        </span>
      )}
    </div>
  );
}

// ── Summary pill row ──────────────────────────────────────────────────────────

function SummaryPills({ proposals }: { proposals: TradeProposal[] }) {
  const ready    = proposals.filter(p => p.status === "Ready").length;
  const waiting  = proposals.filter(p => p.status === "Waiting").length;
  const approved = proposals.filter(p => p.status === "Approved").length;
  const rejected = proposals.filter(p => p.status === "Rejected").length;
  return (
    <div className="flex flex-wrap gap-2 text-[11px]">
      {ready    > 0 && <span><span className="font-semibold text-foreground">{ready}</span> <span className="text-muted-foreground">Ready</span></span>}
      {waiting  > 0 && <span><span className="font-semibold text-foreground">{waiting}</span> <span className="text-muted-foreground">Waiting</span></span>}
      {approved > 0 && <span className="text-emerald-500"><span className="font-semibold">{approved}</span> Approved</span>}
      {rejected > 0 && <span className="text-rose-500"><span className="font-semibold">{rejected}</span> Rejected</span>}
    </div>
  );
}

// ── Widget ────────────────────────────────────────────────────────────────────

export function TradeReviewWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [qtyOverrides, setQtyOverrides] = useState<Record<string, number>>({});
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const { data, isLoading, error, refetch, isRefetching } = useGetTradeReview();

  const { mutateAsync } = useUpdateTradeProposalStatus({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["getTradeReview"] }),
    },
  });

  useEffect(() => {
    if (!data?.proposals) return;
    setQtyOverrides(prev => {
      const next = { ...prev };
      for (const p of data.proposals) {
        if (!(p.id in next)) next[p.id] = p.quantity;
      }
      return next;
    });
  }, [data?.proposals]);

  const handleQtyChange = (id: string, qty: number) => setQtyOverrides(prev => ({ ...prev, [id]: qty }));

  const handleAction = async (id: string, status: "Approved" | "Rejected" | "Waiting", qty: number) => {
    setMutatingId(id);
    try { await mutateAsync({ id, data: { status, quantity: qty } }); }
    finally { setMutatingId(null); }
  };

  const proposals        = data?.proposals ?? [];
  const waitingDecisions = data?.waitingDecisions ?? [];
  const hasTde           = !!data?.tdeTimestamp;
  const ready            = proposals.filter(p => p.status === "Ready").length;

  // ── xs: single-number summary ──
  if (size === "xs") {
    return (
      <div ref={ref} className="h-full w-full flex items-center gap-2 p-2">
        {isLoading && <WidgetSpinner />}
        {!isLoading && (
          <>
            <ClipboardList className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-xl font-bold">{ready}</span>
            <span className="text-[10px] text-muted-foreground">ready</span>
          </>
        )}
      </div>
    );
  }

  // ── sm: counts + nav ──
  if (size === "sm") {
    return (
      <div ref={ref} className="h-full w-full flex flex-col justify-between p-2 gap-1">
        {isLoading && <WidgetSpinner />}
        {!isLoading && (
          <>
            <SummaryPills proposals={proposals} />
            {waitingDecisions.length > 0 && (
              <p className="text-[10px] text-muted-foreground">
                {waitingDecisions.length} waiting
              </p>
            )}
            <Button size="sm" variant="ghost" className="h-6 text-[10px] self-start px-0 text-muted-foreground"
              onClick={() => navigate("/review")}>
              <ExternalLink className="h-3 w-3 mr-1" /> Open
            </Button>
          </>
        )}
      </div>
    );
  }

  // ── md / lg: full list with actions ──
  const showQty = size === "lg";

  return (
    <div ref={ref} className="h-full w-full flex flex-col overflow-hidden p-2 gap-2">

      {/* header */}
      <div className="flex items-center justify-between shrink-0 gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <ClipboardList className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          {hasTde && proposals.length > 0 && <SummaryPills proposals={proposals} />}
          {hasTde && proposals.length === 0 && (
            <span className="text-[11px] text-muted-foreground">No proposals ready</span>
          )}
          {!hasTde && <span className="text-[11px] text-muted-foreground">No TDE analysis</span>}
        </div>
        <Button size="sm" variant="ghost" className="h-6 w-6 shrink-0 p-0"
          onClick={() => refetch()} disabled={isRefetching}>
          <RefreshCw className={`h-3 w-3 ${isRefetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {isLoading && <WidgetSpinner />}

      {error && (
        <div className="flex items-center gap-1.5 text-[11px] text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" /> Kunne ikke hente data
        </div>
      )}

      {/* no TDE analysis */}
      {!isLoading && !hasTde && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
          <Info className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-[11px] text-muted-foreground">Run the Trade Decision Engine to generate proposals.</p>
          <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => navigate("/decisions")}>
            Go to TDE
          </Button>
        </div>
      )}

      {/* empty — no proposals, no waiting */}
      {!isLoading && hasTde && proposals.length === 0 && waitingDecisions.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-center">
          <ClipboardList className="h-6 w-6 text-muted-foreground/30" />
          <p className="text-[11px] text-muted-foreground">No current trade proposals.</p>
        </div>
      )}

      {/* scrollable proposal list */}
      {!isLoading && proposals.length > 0 && (
        <div className="flex-1 overflow-y-auto space-y-2 pr-0.5 min-h-0">
          {proposals.map(p => (
            <ProposalRow
              key={p.id}
              proposal={p}
              qty={qtyOverrides[p.id] ?? p.quantity}
              onQtyChange={handleQtyChange}
              onAction={handleAction}
              onNavigate={() => navigate("/review")}
              isMutating={mutatingId === p.id}
              showQty={showQty}
            />
          ))}
        </div>
      )}

      {/* waiting section */}
      {!isLoading && waitingDecisions.length > 0 && (
        <div className="shrink-0 border-t border-border/30 pt-1.5">
          <div className="flex items-center gap-1 mb-1">
            <CalendarClock className="h-3 w-3 text-muted-foreground/50" />
            <span className="text-[9px] font-medium text-muted-foreground/50 uppercase tracking-widest">
              Awaiting re-evaluation
            </span>
          </div>
          <div className="rounded border border-border/35 overflow-hidden">
            {waitingDecisions.slice(0, size === "lg" ? 5 : 2).map((item, i, arr) => (
              <WaitingRow
                key={item.id}
                item={item}
                isLast={i === arr.length - 1}
                onNavigate={() => navigate("/review")}
              />
            ))}
          </div>
        </div>
      )}

      {/* phase 1 notice */}
      {!isLoading && proposals.length > 0 && (
        <div className="shrink-0 flex items-start gap-1.5 rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1">
          <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-[10px] text-muted-foreground">
            Phase 1 — approvals are recorded only. No orders are placed automatically.
          </p>
        </div>
      )}
    </div>
  );
}
