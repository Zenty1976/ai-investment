/**
 * Portfolio Performance Section
 *
 * Displays current deterministic portfolio performance data:
 *   - Portfolio value and returns (1D / 5D / 1M)
 *   - Top contributors and detractors by 1D portfolio contribution
 *   - Price coverage indicator + last-updated freshness
 *
 * FINANCIAL ACCURACY NOTE — partial coverage labelling:
 *   The engine returns the return of the COVERED portion of the portfolio,
 *   normalised by the invested weight of holdings that have price data.
 *   This is NOT the confirmed full-portfolio return when coverage is incomplete.
 *
 *   COVERAGE_THRESHOLD (95%) determines how returns are labelled:
 *     >= 95% → shown as portfolio return (de-minimis gap)
 *     <  95% → labelled as "Covered portfolio return" with explicit coverage %
 *
 *   Missing holdings are NEVER assumed to have 0% return.
 *
 * This section is fully deterministic — it does NOT trigger OpenAI calls
 * and updates whenever price context data changes (polling every 30 s).
 * It is visually and conceptually separate from the AI Portfolio Assessment.
 */
import { useGetPortfolioPerformance } from "@workspace/api-client-react"
import type { PortfolioHoldingPerf } from "@workspace/api-client-react"
import { RefreshCw, TrendingUp, TrendingDown, AlertCircle, Zap } from "lucide-react"
import { Link } from "wouter"
import { Card, CardContent } from "@/components/ui/card"
import { format } from "date-fns"

// Returns labelled as "portfolio return" only when coverage meets this threshold.
// Below this, they are explicitly labelled as "covered portfolio return".
const COVERAGE_THRESHOLD = 95

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

/**
 * A single return row (label + value).
 * When `partial=true` the value is prefixed with "~" to signal that it
 * reflects only the covered portion of the portfolio, not a confirmed total.
 */
function ReturnPill({
  label,
  value,
  partial = false,
}: {
  label: string
  value: number | null | undefined
  partial?: boolean
}) {
  const showTilde = partial && value !== null && value !== undefined
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground/40 font-medium w-5 shrink-0">
        {label}
      </span>
      <span className={`text-sm font-semibold font-mono tabular-nums ${returnColor(value)}`}>
        {showTilde && (
          <span className="text-[11px] text-amber-400/70 mr-0.5" title="Covered portion only">~</span>
        )}
        {fmtReturn(value)}
      </span>
    </div>
  )
}

function HoldingRow({ holding }: { holding: PortfolioHoldingPerf }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="text-[11px] font-mono font-semibold text-foreground/80 w-14 shrink-0">
        {holding.ticker}
      </span>
      <span className="text-[10px] font-mono tabular-nums text-muted-foreground/35 w-10 shrink-0 text-right">
        {holding.investedWeightPct.toFixed(1)}%
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

  // ── Coverage classification ───────────────────────────────────────────────
  // priceCoveragePct is computed from invested portfolio weight, not holding count.
  // null means no holdings exist (skip coverage logic entirely).
  const isPartialCoverage =
    priceCoveragePct !== null && priceCoveragePct < COVERAGE_THRESHOLD

  const hasContributors = topContributors.length > 0
  const hasDetractors = topDetractors.length > 0
  const hasContribData = hasContributors || hasDetractors

  // Source price freshness — use the engine-derived PriceContext asOf (oldest among
  // covered holdings) so the timestamp reflects actual data age, not polling cadence.
  // Falls back to React Query's dataUpdatedAt only when no price data exists yet.
  const priceAsOf = data.priceDataAsOf ? new Date(data.priceDataAsOf) : null
  const lastFetched = dataUpdatedAt ? new Date(dataUpdatedAt) : null

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
            {priceAsOf ? (
              <span title={`Source price data as of ${data.priceDataAsOf}`}>
                Prices {format(priceAsOf, "HH:mm")}
              </span>
            ) : lastFetched ? (
              <span title="Last backend fetch — no price data available yet">
                Fetched {format(lastFetched, "HH:mm:ss")}
              </span>
            ) : null}
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

          {/* Returns — labelled differently based on coverage */}
          <div className="space-y-0.5">
            {isPartialCoverage && (
              <div
                className="flex items-center gap-1.5 mb-1"
                title={`Returns shown are for the covered ${priceCoveragePct}% of the portfolio by invested weight. ${missingPriceCount} holding${missingPriceCount !== 1 ? "s" : ""} without price data are excluded — not assumed to have 0% return.`}
              >
                <span className="text-[9px] font-bold tracking-widest uppercase text-amber-400/70">
                  Covered portfolio return
                </span>
                <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400/80 font-mono font-medium tabular-nums">
                  {priceCoveragePct}%
                </span>
              </div>
            )}
            <ReturnPill label="1D" value={portfolioReturn1D} partial={isPartialCoverage} />
            <ReturnPill label="5D" value={portfolioReturn5D} partial={isPartialCoverage} />
            <ReturnPill label="1M" value={portfolioReturn1M} partial={isPartialCoverage} />
          </div>
        </div>

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
            <div className="flex items-center gap-2 mt-2 text-[9px] text-muted-foreground/25">
              <span className="w-14">ticker</span>
              <span className="w-10 text-right">wt</span>
              <span>return</span>
              <span className="ml-auto">contrib</span>
            </div>
          </div>
        )}

        {/* ── No price data at all — actionable prompt ── */}
        {portfolioReturn1D === null && portfolioReturn5D === null && (
          <div className="flex items-center justify-between gap-3 border-t border-border/15 pt-3">
            <p className="text-[10px] text-muted-foreground/40 leading-snug">
              No price data yet — enable automation to populate live returns.
            </p>
            <Link
              href="/automation"
              className="flex items-center gap-1 shrink-0 text-[10px] font-medium text-primary/60 hover:text-primary/90 transition-colors"
            >
              <Zap className="h-3 w-3" />
              Automation
            </Link>
          </div>
        )}

        {/* ── Coverage footer ── */}
        {priceCoveragePct !== null && (
          <div className="flex items-center justify-between text-[10px] text-muted-foreground/30 border-t border-border/10 pt-2">
            <span className={isPartialCoverage ? "text-amber-400/50" : ""}>
              Price coverage: {priceCoveragePct}%
              {isPartialCoverage && missingPriceCount > 0 && (
                <> · {missingPriceCount} holding{missingPriceCount !== 1 ? "s" : ""} excluded</>
              )}
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
