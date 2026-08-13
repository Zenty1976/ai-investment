/**
 * PortfolioReturnBar
 *
 * A compact, always-visible summary bar shown at the top of the Overview/Dashboard page.
 * Renders ONLY when live price data is available — completely hidden (returns null)
 * while the portfolio has no price context, so there is never an empty or placeholder state.
 *
 * Shows:
 *   - Portfolio 1D return (colour-coded)
 *   - Top contributor (ticker + return)
 *   - Top detractor (ticker + return)
 *   - Price freshness timestamp (source-derived PriceContext asOf)
 */
import { Link } from "wouter"
import { TrendingUp, TrendingDown, Activity } from "lucide-react"
import { useGetPortfolioPerformance } from "@workspace/api-client-react"
import { format } from "date-fns"

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtReturn(val: number | null | undefined): string {
  if (val === null || val === undefined) return "—"
  const sign = val >= 0 ? "+" : ""
  return `${sign}${val.toFixed(2)}%`
}

function returnColor(val: number | null | undefined): string {
  if (val === null || val === undefined) return "text-muted-foreground/40"
  if (val > 0) return "text-emerald-400"
  if (val < 0) return "text-rose-400"
  return "text-muted-foreground/60"
}

// ── Main component ────────────────────────────────────────────────────────────

export function PortfolioReturnBar() {
  const { data } = useGetPortfolioPerformance()

  // Hide completely when no data yet or no price context
  if (!data || data.portfolioReturn1D === null) return null

  const {
    portfolioReturn1D,
    portfolioReturn5D,
    topContributors,
    topDetractors,
    priceDataAsOf,
  } = data

  const bestContributor  = topContributors[0] ?? null
  const worstDetractor   = topDetractors[0] ?? null
  const priceAsOf        = priceDataAsOf ? new Date(priceDataAsOf) : null

  return (
    <Link href="/portfolio">
      <div
        className="
          flex items-center gap-3 px-4 py-2 mb-2
          rounded-lg border border-border/30
          bg-card/40 hover:bg-card/60
          transition-colors cursor-pointer
          overflow-x-auto scrollbar-none
        "
        title="Go to Portfolio"
      >
        {/* Label */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Activity className="h-3 w-3 text-muted-foreground/40" />
          <span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground/40">
            Portfolio
          </span>
        </div>

        {/* Divider */}
        <div className="h-3 w-px bg-border/30 shrink-0" />

        {/* 1D return — primary figure */}
        <div className="flex items-baseline gap-1 shrink-0">
          <span className="text-[10px] text-muted-foreground/40 font-medium">1D</span>
          <span className={`text-sm font-bold font-mono tabular-nums ${returnColor(portfolioReturn1D)}`}>
            {fmtReturn(portfolioReturn1D)}
          </span>
        </div>

        {/* 5D return — secondary */}
        {portfolioReturn5D !== null && (
          <div className="flex items-baseline gap-1 shrink-0">
            <span className="text-[10px] text-muted-foreground/30 font-medium">5D</span>
            <span className={`text-[11px] font-mono tabular-nums ${returnColor(portfolioReturn5D)}`}>
              {fmtReturn(portfolioReturn5D)}
            </span>
          </div>
        )}

        {/* Divider */}
        <div className="h-3 w-px bg-border/30 shrink-0" />

        {/* Top contributor */}
        {bestContributor && (
          <div className="flex items-center gap-1.5 shrink-0">
            <TrendingUp className="h-3 w-3 text-emerald-400/50 shrink-0" />
            <span className="text-[11px] font-mono font-semibold text-foreground/70">
              {bestContributor.ticker}
            </span>
            <span className={`text-[11px] font-mono tabular-nums ${returnColor(bestContributor.return1D)}`}>
              {fmtReturn(bestContributor.return1D)}
            </span>
          </div>
        )}

        {/* Top detractor */}
        {worstDetractor && (
          <div className="flex items-center gap-1.5 shrink-0">
            <TrendingDown className="h-3 w-3 text-rose-400/50 shrink-0" />
            <span className="text-[11px] font-mono font-semibold text-foreground/70">
              {worstDetractor.ticker}
            </span>
            <span className={`text-[11px] font-mono tabular-nums ${returnColor(worstDetractor.return1D)}`}>
              {fmtReturn(worstDetractor.return1D)}
            </span>
          </div>
        )}

        {/* Price freshness — right-aligned */}
        {priceAsOf && (
          <span
            className="ml-auto text-[10px] font-mono text-muted-foreground/25 shrink-0"
            title={`Source price data as of ${priceDataAsOf}`}
          >
            Prices {format(priceAsOf, "HH:mm")}
          </span>
        )}
      </div>
    </Link>
  )
}
