/**
 * Portfolio Manager
 *
 * Displays the user's current Saxo net positions fetched via the backend.
 * Does not call OpenAI. Does not fetch automatically on mount — the user
 * must press "Update Portfolio" to pull fresh data from Saxo.
 */

import { useState } from "react"
import { useGetPortfolio, useUpdatePortfolio } from "@workspace/api-client-react"
import type { PortfolioSnapshot } from "@workspace/api-client-react"
import {
  RefreshCw,
  AlertCircle,
  TrendingUp,
  TrendingDown,
  Minus,
  WifiOff,
  BarChart2,
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
    <span
      className={`font-mono text-xs tabular-nums ${
        zero
          ? "text-muted-foreground/50"
          : positive
          ? "text-emerald-400"
          : "text-red-400"
      }`}
    >
      {positive ? "+" : ""}
      {fmt(value)}
    </span>
  )
}

function DayChangeBadge({ value }: { value: number }) {
  const positive = value > 0
  const zero = Math.abs(value) < 0.001
  const Icon = zero ? Minus : positive ? TrendingUp : TrendingDown
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] font-mono tabular-nums ${
        zero
          ? "text-muted-foreground/40"
          : positive
          ? "text-emerald-400"
          : "text-red-400"
      }`}
    >
      <Icon className="h-3 w-3" />
      {positive ? "+" : ""}
      {fmt(value, 2)}%
    </span>
  )
}

// ── Summary strip ─────────────────────────────────────────────────────────────

function SummaryStrip({ snapshot }: { snapshot: PortfolioSnapshot }) {
  const totalValue = snapshot.positions.reduce(
    (s, p) => s + p.marketValueBaseCurrency,
    0
  )
  const totalPnl = snapshot.positions.reduce((s, p) => s + p.profitLoss, 0)

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[
        {
          label: "Positions",
          value: snapshot.positions.length.toString(),
          mono: false,
        },
        {
          label: "Total value (base currency)",
          value: fmt(totalValue),
          mono: true,
        },
        {
          label: "Unrealised P/L",
          value: (totalPnl >= 0 ? "+" : "") + fmt(totalPnl),
          mono: true,
          color:
            totalPnl > 0
              ? "text-emerald-400"
              : totalPnl < 0
              ? "text-red-400"
              : undefined,
        },
        {
          label: "Environment",
          value: snapshot.environment === "live" ? "Live" : "Simulation",
          mono: false,
          badge: true,
          badgeColor:
            snapshot.environment === "live"
              ? "bg-green-600/20 text-green-400 border border-green-600/30"
              : "bg-amber-500/20 text-amber-400 border border-amber-500/30",
        },
      ].map(({ label, value, mono, color, badge, badgeColor }) => (
        <Card key={label} className="bg-card/60 border-card-border/50">
          <CardContent className="p-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 mb-1">
              {label}
            </p>
            {badge ? (
              <span
                className={`text-xs font-medium rounded px-1.5 py-0.5 ${badgeColor}`}
              >
                {value}
              </span>
            ) : (
              <p
                className={`text-lg font-bold leading-tight ${
                  mono ? "font-mono tabular-nums" : ""
                } ${color ?? "text-foreground"}`}
              >
                {value}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ── Positions table ───────────────────────────────────────────────────────────

function PositionsTable({ snapshot }: { snapshot: PortfolioSnapshot }) {
  if (snapshot.positions.length === 0) {
    return (
      <Card className="bg-card/60 border-card-border/50">
        <CardContent className="p-8 flex flex-col items-center gap-2 text-center">
          <BarChart2 className="h-8 w-8 text-muted-foreground/20" />
          <p className="text-sm text-muted-foreground/50">No open positions</p>
          <p className="text-[11px] text-muted-foreground/30">
            Press <span className="font-semibold">Update Portfolio</span> to
            refresh from Saxo.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="bg-card/60 border-card-border/50 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/30 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
              <th className="text-left px-3 py-2.5">Instrument</th>
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
            {[...snapshot.positions]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((pos) => (
              <tr
                key={pos.id}
                className="hover:bg-muted/20 transition-colors"
              >
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
                        <Badge
                          variant="outline"
                          className="text-[9px] px-1 py-0 border-border/30 text-muted-foreground/50"
                        >
                          {pos.assetType}
                        </Badge>
                      )}
                      {pos.exchange && (
                        <span className="text-[9px] text-muted-foreground/40">
                          {pos.exchange}
                        </span>
                      )}
                    </div>
                  </div>
                </td>

                {/* Quantity */}
                <td className="px-3 py-2.5 text-right">
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="font-mono tabular-nums text-foreground/80">
                      {fmt(pos.quantity, 0)}
                    </span>
                    <span
                      className={`text-[10px] font-medium ${
                        pos.direction === "Buy"
                          ? "text-emerald-400/70"
                          : "text-red-400/70"
                      }`}
                    >
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
                    <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-400 bg-emerald-400/10 border border-emerald-400/25 rounded px-1.5 py-0.5">
                      Open
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/40 bg-muted/20 border border-border/20 rounded px-1.5 py-0.5">
                      Closed
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PortfolioManager() {
  const [updateError, setUpdateError] = useState<string | null>(null)

  const { data: stored, isLoading, refetch } = useGetPortfolio({
    query: { retry: false },
  })

  const updateMutation = useUpdatePortfolio()

  const snapshot: PortfolioSnapshot | null =
    (stored?.result as PortfolioSnapshot) ?? null

  const handleUpdate = () => {
    setUpdateError(null)
    updateMutation.mutate(undefined, {
      onSuccess: () => refetch(),
      onError: (err: unknown) => {
        const msg =
          (err as { response?: { data?: { error?: string } } })?.response?.data
            ?.error ??
          (err instanceof Error ? err.message : String(err))
        setUpdateError(msg)
        // Refetch in case the backend returned a stored snapshot alongside the error
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
                <p className="text-[11px] text-muted-foreground/50 mt-0.5">
                  Last updated{" "}
                  {formatDistanceToNow(new Date(snapshot.updatedAt), {
                    addSuffix: true,
                  })}{" "}
                  ·{" "}
                  {format(new Date(snapshot.updatedAt), "HH:mm 'd.' d MMM yyyy")}
                </p>
              ) : isLoading ? (
                <p className="text-[11px] text-muted-foreground/40 mt-0.5">
                  Loading…
                </p>
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
              {updateMutation.isPending ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
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
              <a
                href="/settings"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Go to Settings
              </a>{" "}
              and log in first.
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Generic error banner (shown without overwriting last good snapshot) ── */}
      {updateError && !updateError.toLowerCase().includes("not connected") && (
        <Card className="bg-card/60 border-destructive/30">
          <CardContent className="p-3 flex items-start gap-2 text-xs text-destructive/80">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{updateError}</span>
          </CardContent>
        </Card>
      )}

      {/* ── Summary + table ── */}
      {snapshot && (
        <>
          <SummaryStrip snapshot={snapshot} />
          <PositionsTable snapshot={snapshot} />
        </>
      )}

    </div>
  )
}
