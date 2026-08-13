/**
 * Portfolio Performance Section
 *
 * Displays current deterministic portfolio performance data:
 *   - Portfolio value and returns (1D / 5D / 1M)
 *   - Top contributors and detractors by 1D portfolio contribution
 *   - Price coverage indicator + last-updated freshness
 *
 * This section is fully deterministic — it does NOT trigger OpenAI calls
 * and updates whenever price context data changes (polling every 30 s).
 * It is visually and conceptually separate from the AI Portfolio Assessment.
 */
import { useGetPortfolioPerformance } from "@workspace/api-client-react"
import type { PortfolioHoldingPerf } from "@workspace/api-client-react"
import { RefreshCw, TrendingUp, TrendingDown, AlertCircle } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { format } from "date-fns"

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtReturn(val: number | null | undefined): string {
  if (val === null || val === undefined) return "—"
  const sign = val >= 0 ? "+" : ""
  return `${sign}${val.toFixed(2)}%`
}

function fmtContrib(val: number | null | undefined): string {
  if (val === null || val === undefined) return ""
  const sign = val >= 0 ? "+" : ""
  return `${sign}${val.toFixed(2)}pp`
}

function returnColor(val: number | null | undefined): string {
  if (val === null || val === undefined) return "text-muted-foreground/40"
  if (val > 0) return "text-emerald-400"
  if (val < 0) return "text-rose-400"
  return "text-muted-foreground/60"
}

function contribColor(val: number | null | undefined): string {
  if (val === null || val === undefined) return "text-muted-foreground/30"
  if (val > 0) return "text-emerald-400/70"
  if (val < 0) return "text-rose-400/70"
  return "text-muted-foreground/40"
}

function fmtValue(val: number | null | undefined, currency: string): string {
  if (val === null || val === undefined) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(val)
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ReturnPill({
  label,
  value,
}: {
  label: string
  value: number | null | undefined
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground/40 font-medium w-5 shrink-0">
        {label}
      </span>
      <span className={`text-sm font-semibold font-mono tabular-nums ${returnColor(value)}`}>
        {fmtReturn(value)}
      </span>
    </div>
  )
}

function HoldingRow({ holding }: { holding: PortfolioHoldingPerf }) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-[11px] font-mono font-semibold text-foreground/80 w-14 shrink-0">
        {holding.ticker}
      </span>
      <span className={`text-[11px] font-mono tabular-nums ${returnColor(holding.return1D)}`}>
        {fmtReturn(holding.return1D)}
      </span>
      <span className={`text-[10px] font-mono tabular-nums ml-auto ${contribColor(holding.contribution1DPct)}`}>
        {fmtContrib(holding.contribution1DPct)}
      </span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function PortfolioPerformanceSection() {
  const { data, isLoading, isError, dataUpdatedAt, isFetching } =
    useGetPortfolioPerformance()

  // ── Loading ────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <Card className="bg-card/40 border-card-border/30">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground/40">
            <RefreshCw className="h-3 w-3 animate-spin" />
            Loading portfolio performance…
          </div>
        </CardContent>
      </Card>
    )
  }

  // ── No portfolio data ─────────────────────────────────────────────────────
  if (isError || !data) {
    return (
      <Card className="bg-card/40 border-card-border/30">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground/40">
            <AlertCircle className="h-3 w-3" />
            Run Portfolio Manager to see current performance.
          </div>
        </CardContent>
      </Card>
    )
  }

  const {
    portfolio,
    portfolioReturn1D,
    portfolioReturn5D,
    portfolioReturn1M,
    topContributors,
    topDetractors,
    priceCoveragePct,
    missingPriceCount,
  } = data

  const hasContributors = topContributors.length > 0
  const hasDetractors = topDetractors.length > 0
  const hasContribData = hasContributors || hasDetractors

  // Freshness — use client-side refetch timestamp (not server computedAt)
  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt) : null

  return (
    <Card className="bg-card/50 border-card-border/40 overflow-hidden">
      <CardContent className="p-4 space-y-3">

        {/* ── Section header ── */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground/50">
              Current Performance
            </span>
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground/40 font-medium tracking-wide uppercase">
              Deterministic
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/35">
            {isFetching && <RefreshCw className="h-2.5 w-2.5 animate-spin" />}
            {lastUpdated && (
              <span>Updated {format(lastUpdated, "HH:mm:ss")}</span>
            )}
          </div>
        </div>

        {/* ── Portfolio value + returns ── */}
        <div className="flex items-start justify-between gap-4">
          {/* Value */}
          <div className="shrink-0">
            {portfolio.totalValue !== null ? (
              <>
                <div className="text-lg font-bold tabular-nums text-foreground leading-none">
                  {fmtValue(portfolio.totalValue, portfolio.baseCurrency)}
                </div>
                <div className="text-[10px] text-muted-foreground/40 mt-0.5">
                  {portfolio.baseCurrency} · {portfolio.cashPct.toFixed(1)}% cash
                </div>
              </>
            ) : (
              <div className="text-[11px] text-muted-foreground/35 italic">
                Value not available
              </div>
            )}
          </div>

          {/* Returns */}
          <div className="space-y-0.5">
            <ReturnPill label="1D" value={portfolioReturn1D} />
            <ReturnPill label="5D" value={portfolioReturn5D} />
            <ReturnPill label="1M" value={portfolioReturn1M} />
          </div>
        </div>

        {/* ── Coverage warning for partial data ── */}
        {portfolioReturn1D !== null && priceCoveragePct !== null && priceCoveragePct < 100 && (
          <div className="text-[10px] text-amber-400/60 leading-snug">
            Returns are based on available data ({priceCoveragePct}% price coverage
            {missingPriceCount > 0 ? ` · ${missingPriceCount} holding${missingPriceCount > 1 ? "s" : ""} missing` : ""})
          </div>
        )}

        {/* ── Contributors / detractors ── */}
        {hasContribData && (
          <div className="border-t border-border/15 pt-3">
            {/* Column headers */}
            <div className="grid grid-cols-2 gap-3">

              {/* Contributors */}
              <div>
                <div className="flex items-center gap-1 mb-1.5">
                  <TrendingUp className="h-3 w-3 text-emerald-400/60" />
                  <span className="text-[9px] font-bold tracking-widest uppercase text-muted-foreground/35">
                    Contributors
                  </span>
                </div>
                {hasContributors ? (
                  <div className="space-y-0.5">
                    {topContributors.map((h: PortfolioHoldingPerf) => (
                      <HoldingRow key={h.ticker} holding={h} />
                    ))}
                  </div>
                ) : (
                  <span className="text-[10px] text-muted-foreground/30 italic">None today</span>
                )}
              </div>

              {/* Detractors */}
              <div>
                <div className="flex items-center gap-1 mb-1.5">
                  <TrendingDown className="h-3 w-3 text-rose-400/60" />
                  <span className="text-[9px] font-bold tracking-widest uppercase text-muted-foreground/35">
                    Detractors
                  </span>
                </div>
                {hasDetractors ? (
                  <div className="space-y-0.5">
                    {topDetractors.map((h: PortfolioHoldingPerf) => (
                      <HoldingRow key={h.ticker} holding={h} />
                    ))}
                  </div>
                ) : (
                  <span className="text-[10px] text-muted-foreground/30 italic">None today</span>
                )}
              </div>
            </div>

            {/* Column sub-header legend */}
            <div className="flex items-center gap-1 mt-2 text-[9px] text-muted-foreground/25">
              <span className="w-14">ticker</span>
              <span>return</span>
              <span className="ml-auto">contribution</span>
            </div>
          </div>
        )}

        {/* ── No price data at all ── */}
        {portfolioReturn1D === null && portfolioReturn5D === null && (
          <div className="text-[10px] text-muted-foreground/35 italic border-t border-border/15 pt-3">
            No price context available. Run the orchestrator to fetch price data.
          </div>
        )}

        {/* ── Coverage footer ── */}
        {priceCoveragePct !== null && (
          <div className="flex items-center justify-between text-[10px] text-muted-foreground/30 border-t border-border/10 pt-2">
            <span>
              Price coverage: {priceCoveragePct}%
            </span>
            <span>
              {portfolio.holdingCount} holding{portfolio.holdingCount !== 1 ? "s" : ""}
            </span>
          </div>
        )}

      </CardContent>
    </Card>
  )
}
