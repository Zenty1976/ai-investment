/**
 * Trade Review — Phase 1
 *
 * Converts Trade Decision Engine proposals into user-reviewable trade cards.
 * Phase 1 NEVER places, modifies or cancels orders.
 *
 * Design principles:
 *   - Decision Strength (Reason Score) and Execution Status are shown separately.
 *   - A blocked trade still shows calculated price / quantity / value.
 *   - The score measures evidence quality, not whether the trade can fire today.
 */
import { useState, useEffect } from "react"
import { useLocation } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import {
  useGetTradeReview,
  useUpdateTradeProposalStatus,
} from "@workspace/api-client-react"
import type {
  TradeProposal,
  TradeProposalStatus,
} from "@workspace/api-client-react"
import {
  RefreshCw,
  Minus,
  Plus,
  CheckCircle2,
  XCircle,
  Clock,
  ExternalLink,
  AlertTriangle,
  ClipboardList,
  Info,
  Calendar,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { format, parseISO } from "date-fns"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "positive" | "warning" | "negative"

function confidenceVariant(c: string): BadgeVariant {
  return c === "High" ? "positive" : c === "Medium" ? "warning" : "secondary"
}

function urgencyLabel(u: string): string {
  return u === "Immediate" ? "Immediate" : u === "Days" ? "Days" : u === "Weeks" ? "Weeks" : "No urgency"
}

function statusVariant(s: TradeProposalStatus): BadgeVariant {
  if (s === "Approved")  return "positive"
  if (s === "Rejected")  return "negative"
  if (s === "Ready")     return "default"
  return "outline"
}

function fmt2(n: number) {
  return n.toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmt0(n: number) {
  return n.toLocaleString("da-DK", { maximumFractionDigits: 0 })
}

function PriceDisplay({ price, currency, fxRate }: { price: number; currency: string; fxRate: number }) {
  if (price <= 0) return <span className="text-muted-foreground/60 italic">—</span>
  const dkkPrice   = price * fxRate
  const isNonDkk   = currency !== "DKK" && fxRate > 0 && Math.abs(fxRate - 1) > 0.001
  return (
    <span className="font-mono tabular-nums">
      {fmt2(dkkPrice)} kr/aktie
      {isNonDkk && (
        <span className="text-muted-foreground/50 font-normal ml-1.5">
          ({fmt2(price)} {currency})
        </span>
      )}
    </span>
  )
}

const NNBSP = "\u202F"

function ValueDisplay({ value, currency, fxRate, qty }: { value: number; currency: string; fxRate: number; qty: number }) {
  if (qty === 0) return <span className="text-muted-foreground/60">—</span>
  if (value <= 0) return <span className="text-muted-foreground/60">—</span>
  const isNonDkk   = currency !== "DKK" && fxRate > 0 && Math.abs(fxRate - 1) > 0.001
  const origValue  = isNonDkk ? Math.round(value / fxRate) : 0
  return (
    <span className="font-semibold tabular-nums">
      {`≈${NNBSP}${fmt0(value)} kr`}
      {isNonDkk && (
        <span className="text-muted-foreground/50 font-normal ml-1.5">
          {`(≈${NNBSP}${fmt0(origValue)} ${currency})`}
        </span>
      )}
    </span>
  )
}

function formatEventDate(iso: string | undefined): string {
  if (!iso) return ""
  try { return format(parseISO(iso), "d MMM yyyy") } catch { return iso }
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—"
  try { return format(parseISO(iso), "d MMM, HH:mm") } catch { return "—" }
}

// ---------------------------------------------------------------------------
// Decision Strength indicator (Reason Score)
// ---------------------------------------------------------------------------

function DecisionStrength({ score }: { score: number }) {
  const stroke = score >= 70 ? "#10b981" : score >= 45 ? "#f59e0b" : "#f43f5e"
  const label  = score >= 70 ? "Strong" : score >= 45 ? "Moderate" : "Weak"
  const circumference = 2 * Math.PI * 13
  const dashLen = (score / 100) * circumference
  return (
    <div
      className="flex flex-col items-center gap-0.5"
      title={`Decision strength: ${score}/100 — ${label} evidence quality`}
    >
      <div className="relative w-9 h-9">
        <svg viewBox="0 0 32 32" className="w-9 h-9 -rotate-90">
          <circle cx="16" cy="16" r="13" fill="none" stroke="hsl(var(--muted))" strokeWidth="3" />
          <circle
            cx="16" cy="16" r="13"
            fill="none" stroke={stroke} strokeWidth="3"
            strokeDasharray={`${dashLen} ${circumference}`}
            strokeLinecap="round"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold leading-none">
          {score}
        </span>
      </div>
      <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Strength</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Proposal card
// ---------------------------------------------------------------------------

interface CardProps {
  proposal: TradeProposal
  qty: number
  onQtyChange: (id: string, qty: number) => void
  onAction: (id: string, status: "Approved" | "Rejected" | "Waiting", qty: number) => Promise<void>
  onDetails: () => void
  isMutating: boolean
}

function ProposalCard({ proposal, qty, onQtyChange, onAction, onDetails, isMutating }: CardProps) {
  const isBuy     = proposal.action === "BUY"
  const isDecided = proposal.status === "Approved" || proposal.status === "Rejected"

  // Scale estimated value (always in DKK base currency) relative to the
  // server-computed suggestion. Fallback uses fxRate so the result stays in DKK.
  const safeFx = proposal.fxRate > 0 ? proposal.fxRate : 1
  const scaledValue =
    proposal.quantity > 0
      ? Math.round((qty / proposal.quantity) * proposal.estimatedValue)
      : proposal.estimatedValue > 0 && qty === 0
        ? 0
        : Math.round(qty * (proposal.estimatedPrice > 0 ? proposal.estimatedPrice * safeFx : 0))

  const borderClass = isBuy
    ? "border-emerald-500/25 bg-emerald-500/[0.03]"
    : "border-rose-500/25 bg-rose-500/[0.03]"
  const actionColor = isBuy ? "text-emerald-400" : "text-rose-400"

  return (
    <Card className={`border ${borderClass} transition-colors`}>
      <CardContent className="p-4 space-y-3">

        {/* ── Row 1: action · company · execution status · decision strength ── */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`text-xs font-bold tracking-widest shrink-0 ${actionColor}`}>
              {proposal.action}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-tight truncate">{proposal.company}</p>
              <p className="text-[11px] text-muted-foreground font-mono">{proposal.ticker}</p>
            </div>
          </div>
          {/* Right side: Execution Status + Decision Strength — kept visually separate */}
          <div className="flex items-start gap-2 shrink-0">
            <div className="flex flex-col items-end gap-1 pt-0.5">
              <Badge variant={statusVariant(proposal.status)} className="text-[10px] px-1.5 py-0">
                {proposal.status}
              </Badge>
              {proposal.blockedByEvent && (
                <Badge variant="warning" className="text-[10px] px-1.5 py-0 flex items-center gap-0.5">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {proposal.blockingEvent
                    ? `Waiting for ${proposal.blockingEvent}${proposal.blockingEventDate ? ` · ${formatEventDate(proposal.blockingEventDate)}` : ""}`
                    : "Event blocked"}
                </Badge>
              )}
            </div>
            <DecisionStrength score={proposal.reasonScore} />
          </div>
        </div>

        {/* ── Row 2: price / sizing panel ── */}
        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 space-y-1.5">

          {proposal.sizingUnavailableReason ? (
            /* Sizing data missing — show reason, allow manual qty entry */
            <>
              <div className="flex items-center gap-1.5 text-[11px] text-amber-500/90">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                <span className="font-medium">Sizing unavailable</span>
                <span className="text-muted-foreground ml-1">— {proposal.sizingUnavailableReason}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-muted-foreground shrink-0">Enter shares manually</span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline" size="icon" className="h-6 w-6"
                    onClick={() => onQtyChange(proposal.id, Math.max(0, qty - 1))}
                    disabled={isMutating || qty <= 0}
                  >
                    <Minus className="h-2.5 w-2.5" />
                  </Button>
                  <input
                    type="number"
                    value={qty}
                    min={0}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (!isNaN(v) && v >= 0) onQtyChange(proposal.id, v)
                    }}
                    className="w-14 text-center text-sm font-mono bg-transparent border border-border rounded-md py-0.5
                      [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <Button
                    variant="outline" size="icon" className="h-6 w-6"
                    onClick={() => onQtyChange(proposal.id, qty + 1)}
                    disabled={isMutating}
                  >
                    <Plus className="h-2.5 w-2.5" />
                  </Button>
                </div>
              </div>
            </>
          ) : (
            /* Full sizing data available */
            <>
              {/* Price */}
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">Price</span>
                <PriceDisplay
                  price={proposal.estimatedPrice}
                  currency={proposal.currency}
                  fxRate={safeFx}
                />
              </div>

              {/* Suggested quantity + user override */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-muted-foreground shrink-0">Shares</span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline" size="icon" className="h-6 w-6"
                    onClick={() => onQtyChange(proposal.id, Math.max(0, qty - 1))}
                    disabled={isMutating || qty <= 0}
                  >
                    <Minus className="h-2.5 w-2.5" />
                  </Button>
                  <input
                    type="number"
                    value={qty}
                    min={0}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (!isNaN(v) && v >= 0) onQtyChange(proposal.id, v)
                    }}
                    className="w-14 text-center text-sm font-mono bg-transparent border border-border rounded-md py-0.5
                      [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <Button
                    variant="outline" size="icon" className="h-6 w-6"
                    onClick={() => onQtyChange(proposal.id, qty + 1)}
                    disabled={isMutating}
                  >
                    <Plus className="h-2.5 w-2.5" />
                  </Button>
                </div>
              </div>

              {/* Estimated value */}
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">Est. value</span>
                <ValueDisplay
                  value={scaledValue}
                  currency={proposal.currency}
                  fxRate={safeFx}
                  qty={qty}
                />
              </div>
            </>
          )}

          {/* Allocation row — always shown when targets are set */}
          {(proposal.targetAllocationPercent > 0 || proposal.currentAllocationPercent > 0) && (
            <div className="flex items-center justify-between text-[10px] text-muted-foreground border-t border-border/40 pt-1 mt-0.5">
              <span>Target {proposal.targetAllocationPercent}%</span>
              <span>Now {proposal.currentAllocationPercent}%</span>
              {proposal.resultingAllocationPercent > 0 && qty > 0 && (
                <span>→ {proposal.resultingAllocationPercent}%</span>
              )}
            </div>
          )}
        </div>

        {/* ── Row 3: short reason ── */}
        {proposal.shortReason && (
          <p className="text-[11px] text-muted-foreground italic leading-snug">
            {proposal.shortReason}
          </p>
        )}

        {/* ── Row 4: evidence quality badges ── */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={confidenceVariant(proposal.confidence)} className="text-[10px] px-1.5 py-0">
            {proposal.confidence} confidence
          </Badge>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {urgencyLabel(proposal.urgency)}
          </Badge>
          {proposal.sourceModules.length > 0 && (
            <span className="text-[10px] text-muted-foreground ml-auto">
              {proposal.sourceModules.length} module{proposal.sourceModules.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {/* ── Row 5: action buttons ── */}
        <div className="flex items-center gap-1.5 border-t border-border/50 pt-3">
          {!isDecided && (
            <>
              <Button
                size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-3"
                onClick={() => onAction(proposal.id, "Approved", qty)}
                disabled={isMutating || qty === 0}
                title={qty === 0 ? "Set a quantity before approving" : undefined}
              >
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                Approve
              </Button>
              <Button
                size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground px-2"
                onClick={() => onAction(proposal.id, "Waiting", qty)}
                disabled={isMutating}
              >
                <Clock className="h-3.5 w-3.5 mr-1" />
                Later
              </Button>
              <Button
                size="sm" variant="ghost" className="h-7 text-xs text-rose-500 hover:text-rose-400 px-2"
                onClick={() => onAction(proposal.id, "Rejected", qty)}
                disabled={isMutating}
              >
                <XCircle className="h-3.5 w-3.5 mr-1" />
                Reject
              </Button>
            </>
          )}
          {isDecided && (
            <Button
              size="sm" variant="outline" className="h-7 text-xs px-3"
              onClick={() => onAction(proposal.id, "Waiting", qty)}
              disabled={isMutating}
            >
              Undo
            </Button>
          )}
          <Button
            size="sm" variant="ghost" className="h-7 text-xs ml-auto"
            onClick={onDetails}
          >
            <ExternalLink className="h-3.5 w-3.5 mr-1" />
            Details
          </Button>
        </div>

      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Summary bar
// ---------------------------------------------------------------------------

function SummaryBar({ proposals }: { proposals: TradeProposal[] }) {
  const counts = {
    Ready:    proposals.filter(p => p.status === "Ready").length,
    Waiting:  proposals.filter(p => p.status === "Waiting").length,
    Approved: proposals.filter(p => p.status === "Approved").length,
    Rejected: proposals.filter(p => p.status === "Rejected").length,
  }
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      {counts.Ready    > 0 && <span><span className="font-semibold text-foreground">{counts.Ready}</span> Ready</span>}
      {counts.Waiting  > 0 && <span><span className="font-semibold text-foreground">{counts.Waiting}</span> Waiting</span>}
      {counts.Approved > 0 && <span className="text-emerald-500"><span className="font-semibold">{counts.Approved}</span> Approved</span>}
      {counts.Rejected > 0 && <span className="text-rose-500"><span className="font-semibold">{counts.Rejected}</span> Rejected</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TradeReview() {
  const [, navigate]     = useLocation()
  const queryClient      = useQueryClient()
  const [qtyOverrides, setQtyOverrides] = useState<Record<string, number>>({})
  const [mutatingId, setMutatingId]     = useState<string | null>(null)

  const { data, isLoading, error, refetch, isRefetching } = useGetTradeReview()

  const { mutateAsync } = useUpdateTradeProposalStatus({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["getTradeReview"] })
      },
    },
  })

  // Seed local quantity from server data (without overwriting user changes)
  useEffect(() => {
    if (!data?.proposals) return
    setQtyOverrides(prev => {
      const next = { ...prev }
      for (const p of data.proposals) {
        if (!(p.id in next)) next[p.id] = p.quantity
      }
      return next
    })
  }, [data?.proposals])

  const handleQtyChange = (id: string, qty: number) => {
    setQtyOverrides(prev => ({ ...prev, [id]: qty }))
  }

  const handleAction = async (id: string, status: "Approved" | "Rejected" | "Waiting", qty: number) => {
    setMutatingId(id)
    try {
      await mutateAsync({ id, data: { status, quantity: qty } })
    } finally {
      setMutatingId(null)
    }
  }

  // ── Loading skeleton ──
  if (isLoading) {
    return (
      <div className="p-6 space-y-4 max-w-5xl mx-auto">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-6">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-72" />)}
        </div>
      </div>
    )
  }

  // ── Error state ──
  if (error) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="flex items-center gap-2 text-destructive mb-2">
          <AlertTriangle className="h-4 w-4" />
          <span className="text-sm font-medium">Failed to load trade proposals</span>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
      </div>
    )
  }

  const proposals    = data?.proposals ?? []
  const hasTde       = !!data?.tdeTimestamp
  const pendingCount = proposals.filter(p => p.status === "Ready" || p.status === "Waiting").length
  const blockedCount = proposals.filter(p => p.blockedByEvent).length

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold tracking-tight">Trade Review</h1>
          </div>
          <p className="text-xs text-muted-foreground">
            {hasTde
              ? `From Trade Decision Engine · ${formatTimestamp(data?.tdeTimestamp ?? null)}`
              : "No Trade Decision Engine analysis available"}
          </p>
        </div>
        <Button
          size="sm" variant="outline"
          onClick={() => refetch()}
          disabled={isRefetching}
          className="shrink-0"
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isRefetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* ── No TDE analysis ── */}
      {!hasTde && (
        <Card className="border-dashed">
          <CardContent className="p-8 flex flex-col items-center text-center gap-3">
            <Info className="h-8 w-8 text-muted-foreground/50" />
            <div>
              <p className="text-sm font-medium">No trade analysis available</p>
              <p className="text-xs text-muted-foreground mt-1">
                Run the Trade Decision Engine first to generate trade proposals.
              </p>
            </div>
            <Button size="sm" onClick={() => navigate("/decisions")}>
              Go to Trade Decision Engine
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── No actionable decisions ── */}
      {hasTde && proposals.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="p-8 flex flex-col items-center text-center gap-3">
            <ClipboardList className="h-8 w-8 text-muted-foreground/50" />
            <div>
              <p className="text-sm font-medium">No trade proposals</p>
              <p className="text-xs text-muted-foreground mt-1">
                The current analysis contains no PrepareToBuy or PrepareToReduce decisions.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => navigate("/decisions")}>
              View decisions
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Summary bar ── */}
      {proposals.length > 0 && (
        <div className="flex items-center justify-between gap-4">
          <SummaryBar proposals={proposals} />
          <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
            {blockedCount > 0 && (
              <span className="flex items-center gap-1 text-amber-500/80">
                <Calendar className="h-3 w-3" />
                {blockedCount} waiting for event
              </span>
            )}
            {pendingCount > 0 && <span>{pendingCount} pending review</span>}
          </div>
        </div>
      )}

      {/* ── Phase 1 notice ── */}
      {proposals.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 mt-0.5 shrink-0" />
          <p className="text-[11px] text-muted-foreground">
            Phase 1 — approvals are recorded only. No orders are placed automatically.{" "}
            <span className="text-muted-foreground/70">
              The <strong>Strength</strong> score measures evidence quality.
              <strong> Status</strong> reflects execution readiness.
            </span>
          </p>
        </div>
      )}

      {/* ── Proposal cards ── */}
      {proposals.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {proposals.map(proposal => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              qty={qtyOverrides[proposal.id] ?? proposal.quantity}
              onQtyChange={handleQtyChange}
              onAction={handleAction}
              onDetails={() => navigate("/decisions")}
              isMutating={mutatingId === proposal.id}
            />
          ))}
        </div>
      )}

    </div>
  )
}
