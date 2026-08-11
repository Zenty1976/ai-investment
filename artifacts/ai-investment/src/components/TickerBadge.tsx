/**
 * TickerBadge
 *
 * Renders a ticker symbol as inline text with a hover tooltip showing a
 * mini 30-day price sparkline fetched from /price-history/:ticker.
 *
 * Data is cached by React Query (staleTime = 4 h) so repeated hovers and
 * cross-module reuse never trigger duplicate API calls.
 */

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from "recharts"

// ── Types ──────────────────────────────────────────────────────────────────────

interface PriceHistoryBar {
  date: string
  close: number
}

interface PriceHistoryEntry {
  ticker: string
  bars: PriceHistoryBar[]
  fetchedAt: string
}

// ── Fetch helper ───────────────────────────────────────────────────────────────

async function fetchPriceHistory(ticker: string): Promise<PriceHistoryEntry | null> {
  // Strip exchange suffix for cleaner URL (server handles both forms)
  const clean = ticker.includes(":") ? ticker.split(":")[0] : ticker
  const res = await fetch(`/price-history/${encodeURIComponent(clean)}`)
  if (!res.ok) return null
  return res.json()
}

// ── Sparkline content ──────────────────────────────────────────────────────────

interface SparklineProps {
  entry: PriceHistoryEntry
}

function SparklineContent({ entry }: SparklineProps) {
  const bars = entry.bars
  if (bars.length < 2) return <p className="text-xs text-muted-foreground">No data</p>

  const first = bars[0].close
  const last = bars[bars.length - 1].close
  const changePct = ((last - first) / first) * 100
  const isPositive = changePct >= 0

  const min = Math.min(...bars.map((b) => b.close))
  const max = Math.max(...bars.map((b) => b.close))
  const range = max - min

  const color = isPositive ? "#34d399" : "#f87171"

  return (
    <div className="w-52 space-y-2 p-1">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono font-semibold text-foreground">
          {entry.ticker.includes(":") ? entry.ticker.split(":")[0] : entry.ticker}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold tabular-nums">
            {last.toFixed(last < 10 ? 3 : 2)}
          </span>
          <span
            className={`text-[11px] font-medium tabular-nums ${isPositive ? "text-emerald-400" : "text-rose-400"}`}
          >
            {isPositive ? "+" : ""}{changePct.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* Sparkline */}
      <div className="h-16 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={bars} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
            <defs>
              <linearGradient id={`grad-${entry.ticker}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <RechartsTooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const bar = payload[0].payload as PriceHistoryBar
                return (
                  <div className="rounded border border-border/60 bg-popover px-2 py-1 text-[10px] shadow-md">
                    <p className="text-muted-foreground">{bar.date}</p>
                    <p className="font-medium tabular-nums">{bar.close.toFixed(bar.close < 10 ? 3 : 2)}</p>
                  </div>
                )
              }}
            />
            <Area
              type="monotone"
              dataKey="close"
              stroke={color}
              strokeWidth={1.5}
              fill={`url(#grad-${entry.ticker})`}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Range footer */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground/60">
        <span>30d L {min.toFixed(min < 10 ? 3 : 2)}</span>
        <span className="text-muted-foreground/30">·</span>
        <span>30d H {max.toFixed(max < 10 ? 3 : 2)}</span>
        {range > 0 && (
          <>
            <span className="text-muted-foreground/30">·</span>
            <span>Rng {((range / first) * 100).toFixed(1)}%</span>
          </>
        )}
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export interface TickerBadgeProps {
  ticker: string
  className?: string
  children?: React.ReactNode
}

export function TickerBadge({ ticker, className, children }: TickerBadgeProps) {
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(false)

  const { data, isLoading } = useQuery<PriceHistoryEntry | null>({
    queryKey: ["price-history", ticker.toUpperCase()],
    queryFn: () => fetchPriceHistory(ticker),
    enabled,
    staleTime: 4 * 60 * 60 * 1000,
    retry: false,
  })

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next && !enabled) setEnabled(true)
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip open={open} onOpenChange={handleOpenChange}>
        <TooltipTrigger asChild>
          <span
            className={`cursor-default ${className ?? ""}`}
            onMouseEnter={() => handleOpenChange(true)}
            onMouseLeave={() => handleOpenChange(false)}
          >
            {children ?? ticker}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="p-2 bg-popover border border-border/60 shadow-lg rounded-lg"
          sideOffset={6}
        >
          {isLoading ? (
            <div className="flex items-center gap-2 w-40 py-2 px-1">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-xs text-muted-foreground">Loading…</span>
            </div>
          ) : data ? (
            <SparklineContent entry={data} />
          ) : (
            <p className="text-[11px] text-muted-foreground px-1 py-0.5">No price data</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
