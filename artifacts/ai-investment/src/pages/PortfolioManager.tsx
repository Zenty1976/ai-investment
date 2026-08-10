/**
 * Portfolio Manager
 *
 * Displays the user's current Saxo net positions fetched via the backend.
 * Supports multiple accounts internally; exposes a simple "Available Cash"
 * summary card that expands to show per-account details.
 *
 * Does not call OpenAI. Does not fetch automatically on mount — the user
 * must press "Update Portfolio" to pull fresh data from Saxo.
 */

import { useState } from "react"
import { useGetPortfolioLive, useUpdatePortfolio } from "@workspace/api-client-react"
import type { PortfolioAccount, PortfolioSnapshot } from "@workspace/api-client-react"
import {
  RefreshCw,
  AlertCircle,
  TrendingUp,
  TrendingDown,
  Minus,
  WifiOff,
  BarChart2,
  ChevronDown,
  ChevronUp,
  FlaskConical,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { format, formatDistanceToNow } from "date-fns"

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString("da-DK", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function fmtCcy(n: number, currency?: string): string {
  if (!currency) return fmt(n)
  try {
    return n.toLocaleString("da-DK", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  } catch {
    return `${fmt(n)} ${currency}`
  }
}

function PnlBadge({ value }: { value: number }) {
  const positive = value > 0
  const zero = value === 0
  return (
    <span className={`font-mono text-xs tabular-nums ${
      zero ? "text-muted-foreground/50" : positive ? "text-emerald-400" : "text-red-400"
    }`}>
      {positive ? "+" : ""}{fmt(value)}
    </span>
  )
}

function DayChangeBadge({ value }: { value: number }) {
  const positive = value > 0
  const zero = Math.abs(value) < 0.001
  const Icon = zero ? Minus : positive ? TrendingUp : TrendingDown
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-mono tabular-nums ${
      zero ? "text-muted-foreground/40" : positive ? "text-emerald-400" : "text-red-400"
    }`}>
      <Icon className="h-3 w-3" />
      {positive ? "+" : ""}{fmt(value, 2)}%
    </span>
  )
}

// ── Summary strip ─────────────────────────────────────────────────────────────

function SummaryStrip({
  snapshot,
  onCashClick,
  cashExpanded,
}: {
  snapshot: PortfolioSnapshot
  onCashClick: () => void
  cashExpanded: boolean
}) {
  const allPositions = (snapshot.accounts ?? []).flatMap((a) => a.positions)
  const pnl = snapshot.totalUnrealizedProfitLoss ?? 0

  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      {/* Positions count */}
      <Card className="bg-card/60 border-card-border/50">
        <CardContent className="p-3">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-1">
            Positions
          </p>
          <p className="text-lg font-bold leading-tight text-foreground">
            {allPositions.length}
          </p>
        </CardContent>
      </Card>

      {/* Total value */}
      <Card className="bg-card/60 border-card-border/50">
        <CardContent className="p-3">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-1">
            Total value (base currency)
          </p>
          <p className="text-lg font-bold leading-tight font-mono tabular-nums text-foreground">
            {snapshot.totalValue != null ? fmt(snapshot.totalValue) : <span className="text-muted-foreground/40 font-sans text-sm">—</span>}
          </p>
        </CardContent>
      </Card>

      {/* Unrealised P/L */}
      <Card className="bg-card/60 border-card-border/50">
        <CardContent className="p-3">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-1">
            Unrealised P/L
          </p>
          <p className={`text-lg font-bold leading-tight font-mono tabular-nums ${
            pnl > 0 ? "text-emerald-400" : pnl < 0 ? "text-red-400" : "text-foreground"
          }`}>
            {pnl >= 0 ? "+" : ""}{fmt(pnl)}
          </p>
        </CardContent>
      </Card>

      {/* Available Cash — clickable */}
      <Card
        className={`border-card-border/50 cursor-pointer transition-colors select-none ${
          cashExpanded
            ? "bg-primary/10 border-primary/30"
            : "bg-card/60 hover:bg-card/80"
        }`}
        onClick={onCashClick}
      >
        <CardContent className="p-3">
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
              Available Cash
            </p>
            {cashExpanded
              ? <ChevronUp className="h-3 w-3 text-primary/60" />
              : <ChevronDown className="h-3 w-3 text-muted-foreground/30" />}
          </div>
          <p className="text-lg font-bold leading-tight font-mono tabular-nums text-foreground">
            {snapshot.totalAvailableCash != null ? fmt(snapshot.totalAvailableCash) : <span className="text-muted-foreground/40 font-sans text-sm">—</span>}
          </p>
          <p className="text-[10px] text-muted-foreground/40 mt-0.5">
            Click to {cashExpanded ? "collapse" : "expand"} accounts
          </p>
        </CardContent>
      </Card>

      {/* Environment */}
      <Card className="bg-card/60 border-card-border/50">
        <CardContent className="p-3">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-1">
            Environment
          </p>
          <span className={`text-xs font-medium rounded px-1.5 py-0.5 ${
            snapshot.environment === "live"
              ? "bg-green-600/20 text-green-400 border border-green-600/30"
              : "bg-amber-500/20 text-amber-400 border border-amber-500/30"
          }`}>
            {snapshot.environment === "live" ? "Live" : "Simulation"}
          </span>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Account cards (expanded section) ─────────────────────────────────────────

function AccountCards({ accounts }: { accounts: PortfolioAccount[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {accounts.map((acct) => (
        <Card key={acct.accountKey} className="bg-card/40 border-border/40">
          <CardContent className="p-4 space-y-2.5">
            {/* Header */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">
                  {acct.accountName}
                </p>
                {acct.accountId && acct.accountId !== acct.accountName && (
                  <p className="text-[10px] text-muted-foreground/40 font-mono">
                    {acct.accountId}
                  </p>
                )}
              </div>
              {acct.accountType && (
                <Badge
                  variant="outline"
                  className="text-[9px] px-1 py-0 border-border/30 text-muted-foreground/50 shrink-0"
                >
                  {acct.accountType}
                </Badge>
              )}
            </div>

            {/* Metrics */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <div>
                <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider">Currency</p>
                <p className="font-mono text-foreground/80">{acct.currency || "—"}</p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider">Positions</p>
                <p className="font-mono text-foreground/80">{acct.positions.length}</p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider">Account value</p>
                <p className="font-mono tabular-nums text-foreground/80">{fmt(acct.accountValue)}</p>
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider">Available cash</p>
                <p className="font-mono tabular-nums text-foreground/80">{fmt(acct.availableCash)}</p>
              </div>
              <div className="col-span-2">
                <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider">Unrealised P/L</p>
                <p className={`font-mono tabular-nums ${
                  acct.unrealizedProfitLoss > 0
                    ? "text-emerald-400"
                    : acct.unrealizedProfitLoss < 0
                    ? "text-red-400"
                    : "text-foreground/50"
                }`}>
                  {acct.unrealizedProfitLoss >= 0 ? "+" : ""}
                  {fmt(acct.unrealizedProfitLoss)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ── Positions table ───────────────────────────────────────────────────────────

function PositionsTable({ snapshot }: { snapshot: PortfolioSnapshot }) {
  const allPositions = (snapshot.accounts ?? [])
    .flatMap((a) => a.positions)
    .sort((a, b) => a.name.localeCompare(b.name))

  if (allPositions.length === 0) {
    return (
      <Card className="bg-card/60 border-card-border/50">
        <CardContent className="p-8 flex flex-col items-center gap-2 text-center">
          <BarChart2 className="h-8 w-8 text-muted-foreground/20" />
          <p className="text-sm text-muted-foreground/50">No open positions</p>
          <p className="text-[11px] text-muted-foreground/30">
            Press <span className="font-semibold">Update Portfolio</span> to refresh from Saxo.
          </p>
        </CardContent>
      </Card>
    )
  }

  const multiAccount = (snapshot.accounts ?? []).length > 1

  return (
    <Card className="bg-card/60 border-card-border/50 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/30 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
              <th className="text-left px-3 py-2.5">Instrument</th>
              {multiAccount && <th className="text-left px-3 py-2.5">Account</th>}
              <th className="text-right px-3 py-2.5">Qty</th>
              <th className="text-right px-3 py-2.5">Avg price</th>
              <th className="text-right px-3 py-2.5">Current</th>
              <th className="text-right px-3 py-2.5">Market value</th>
              <th className="text-right px-3 py-2.5">P/L</th>
              <th className="text-right px-3 py-2.5">Day %</th>
              <th className="text-center px-3 py-2.5">Market</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/20">
            {allPositions.map((pos) => {
              const account = multiAccount
                ? snapshot.accounts.find((a) => a.accountKey === pos.accountKey)
                : null
              return (
                <tr key={pos.id} className="hover:bg-muted/20 transition-colors">
                  {/* Instrument */}
                  <td className="px-3 py-2.5">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-semibold text-foreground">
                        {pos.symbol || pos.name}
                      </span>
                      {pos.symbol && pos.name !== pos.symbol && (
                        <span className="text-[10px] text-muted-foreground/50 truncate max-w-[14rem]">
                          {pos.name}
                        </span>
                      )}
                      <div className="flex items-center gap-1 flex-wrap">
                        {pos.assetType && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 border-border/30 text-muted-foreground/50">
                            {pos.assetType}
                          </Badge>
                        )}
                        {pos.exchange && (
                          <span className="text-[9px] text-muted-foreground/40">{pos.exchange}</span>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Account (only when multiple accounts) */}
                  {multiAccount && (
                    <td className="px-3 py-2.5">
                      <span className="text-[10px] text-muted-foreground/50 truncate max-w-[10rem] block">
                        {account?.accountName ?? pos.accountKey}
                      </span>
                    </td>
                  )}

                  {/* Quantity */}
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="font-mono tabular-nums text-foreground/80">
                        {fmt(pos.quantity, 0)}
                      </span>
                      <span className={`text-[10px] font-medium ${
                        pos.direction === "Buy" ? "text-emerald-400/70" : "text-red-400/70"
                      }`}>
                        {pos.direction}
                      </span>
                    </div>
                  </td>

                  {/* Average open price */}
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground/70">
                    {fmt(pos.averageOpenPrice)}
                  </td>

                  {/* Current price */}
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="font-mono tabular-nums text-foreground">
                        {fmt(pos.currentPrice)}
                      </span>
                      {pos.priceDelayMinutes > 0 && (
                        <span className="text-[9px] text-amber-500/60">
                          +{pos.priceDelayMinutes} min
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Market value */}
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground/80">
                    {fmtCcy(pos.marketValueBaseCurrency, pos.currency)}
                  </td>

                  {/* P/L */}
                  <td className="px-3 py-2.5 text-right">
                    <PnlBadge value={pos.profitLoss} />
                  </td>

                  {/* Day % */}
                  <td className="px-3 py-2.5 text-right">
                    <DayChangeBadge value={pos.dayChangePercent} />
                  </td>

                  {/* Market open */}
                  <td className="px-3 py-2.5 text-center">
                    {pos.isMarketOpen ? (
                      <span className="inline-flex items-center text-[9px] font-semibold uppercase tracking-wider text-emerald-400 bg-emerald-400/10 border border-emerald-400/25 rounded px-1.5 py-0.5">
                        Open
                      </span>
                    ) : (
                      <span className="inline-flex items-center text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/40 bg-muted/20 border border-border/20 rounded px-1.5 py-0.5">
                        Closed
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PortfolioManager() {
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [cashExpanded, setCashExpanded] = useState(false)

  // useGetPortfolioLive returns PortfolioSnapshot directly (not wrapped in a RepositoryEntry)
  const { data: liveData, isLoading, refetch } = useGetPortfolioLive({
    query: { retry: false, refetchInterval: 10_000 },
  })

  const updateMutation = useUpdatePortfolio()

  const snapshot: PortfolioSnapshot | null = (liveData as PortfolioSnapshot) ?? null

  const handleUpdate = () => {
    setUpdateError(null)
    updateMutation.mutate(undefined, {
      onSuccess: () => refetch(),
      onError: (err: unknown) => {
        const msg =
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          (err instanceof Error ? err.message : String(err))
        setUpdateError(msg)
        refetch()
      },
    })
  }

  return (
    <div className="space-y-3 pb-8 animate-in fade-in duration-500">

      {/* ── Header card ── */}
      <Card className="bg-card/60 border-card-border/50">
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-xs font-bold tracking-widest uppercase text-muted-foreground">
                Portfolio Manager
              </h2>
              {snapshot ? (
                <div className="flex items-center gap-2 flex-wrap mt-0.5">
                  <p className="text-[11px] text-muted-foreground/50">
                    Last updated{" "}
                    {formatDistanceToNow(new Date(snapshot.updatedAt), { addSuffix: true })}{" "}
                    · {format(new Date(snapshot.updatedAt), "HH:mm 'd.' d MMM yyyy")}
                  </p>
                  {snapshot.isMockData && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-amber-400 bg-amber-400/10 border border-amber-400/25 rounded px-1.5 py-0.5">
                      <FlaskConical className="h-2.5 w-2.5" />
                      Mock data
                    </span>
                  )}
                </div>
              ) : isLoading ? (
                <p className="text-[11px] text-muted-foreground/40 mt-0.5">Loading…</p>
              ) : (
                <p className="text-[11px] text-muted-foreground/40 mt-0.5">
                  No portfolio data yet. Press Update Portfolio to fetch from Saxo.
                </p>
              )}
            </div>

            <Button
              size="sm"
              variant="outline"
              onClick={handleUpdate}
              disabled={updateMutation.isPending}
              className="h-8 gap-1.5 border-primary/30 text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${updateMutation.isPending ? "animate-spin" : ""}`} />
              Update Portfolio
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Saxo not connected warning ── */}
      {updateError?.toLowerCase().includes("not connected") && (
        <Card className="bg-card/60 border-destructive/30">
          <CardContent className="p-4 flex items-start gap-2 text-sm text-destructive/80">
            <WifiOff className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              Not connected to Saxo Bank.{" "}
              <a href="/settings" className="underline underline-offset-2 hover:text-foreground">
                Go to Settings
              </a>{" "}
              and log in first.
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Generic error banner ── */}
      {updateError && !updateError.toLowerCase().includes("not connected") && (
        <Card className="bg-card/60 border-destructive/30">
          <CardContent className="p-3 flex items-start gap-2 text-xs text-destructive/80">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{updateError}</span>
          </CardContent>
        </Card>
      )}

      {/* ── Summary + accounts + positions ── */}
      {snapshot && (
        <>
          <SummaryStrip
            snapshot={snapshot}
            onCashClick={() => setCashExpanded((v) => !v)}
            cashExpanded={cashExpanded}
          />

          {/* Expandable accounts section */}
          {cashExpanded && snapshot.accounts.length > 0 && (
            <AccountCards accounts={snapshot.accounts} />
          )}

          <PositionsTable snapshot={snapshot} />
        </>
      )}

    </div>
  )
}
