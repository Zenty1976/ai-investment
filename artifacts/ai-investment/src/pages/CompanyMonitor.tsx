/**
 * Company Monitor
 *
 * AI-curated investment analysis of a single company over the next 1-3 months.
 * The user enters a ticker (and optional company name), loads the last stored
 * analysis from the Analysis Repository, and can trigger a fresh AI analysis.
 *
 * Follows exactly the same architecture and UI conventions as the other monitors.
 *
 * Data flows: reads stored result from the Analysis Repository on mount;
 * only calls OpenAI when the user explicitly presses "Update Analysis".
 */
import { useState, useRef, useEffect } from "react"
import { useSearch } from "wouter"
import {
  useRunCompanyAnalysis,
  useGetRepositoryEntry,
  useListRepositoryEntries,
} from "@workspace/api-client-react"
import type {
  CompanyAnalysis,
  CompanyCatalyst,
  CompanyRisk,
  CompanyThesisPoint,
} from "@workspace/api-client-react"
import {
  AlertCircle,
  RefreshCw,
  Info,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Clock,
  Timer,
  Building2,
  TrendingUp,
  TrendingDown,
  Minus,
  Copy,
  Check,
  Search,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { format } from "date-fns"

// Matches AiDebugInfo from api-server/src/lib/ai-service.ts
interface AiDebugInfo {
  request: Record<string, unknown>
  rawResponse: string
  usage: {
    prompt_tokens: number | null
    completion_tokens: number | null
    total_tokens: number | null
  }
  calledAt: string
  webSearchUsed: boolean
}

interface RecentCompany {
  ticker: string
  name: string
  updatedAt: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function ratingBadgeVariant(
  rating: string
): "positive" | "negative" | "warning" | "outline" {
  if (rating === "Strong Buy") return "positive"
  if (rating === "Buy") return "positive"
  if (rating === "Watch") return "warning"
  if (rating === "Avoid") return "negative"
  return "negative" // Strong Avoid
}

function ratingOpacity(rating: string): string {
  if (rating === "Buy") return "opacity-80"
  if (rating === "Avoid") return "opacity-80"
  return ""
}

function outlookBadgeVariant(
  outlook: string
): "positive" | "negative" | "warning" | "outline" {
  if (outlook === "Bullish") return "positive"
  if (outlook === "Moderately Bullish") return "positive"
  if (outlook === "Neutral") return "outline"
  if (outlook === "Moderately Bearish") return "warning"
  return "negative"
}

function impactBadgeVariant(
  impact: string
): "negative" | "warning" | "outline" {
  if (impact === "High") return "negative"
  if (impact === "Medium") return "warning"
  return "outline"
}

function sentimentBadgeVariant(
  sentiment: string
): "positive" | "negative" | "warning" {
  if (sentiment === "Positive") return "positive"
  if (sentiment === "Negative") return "negative"
  return "warning"
}

function valuationBadgeVariant(
  level: string
): "positive" | "negative" | "warning" | "outline" {
  if (level === "Attractive") return "positive"
  if (level === "Expensive") return "negative"
  if (level === "Reasonable") return "outline"
  return "outline"
}

function competitiveBadgeVariant(
  assessment: string
): "positive" | "warning" | "negative" {
  if (assessment === "Strong") return "positive"
  if (assessment === "Moderate") return "warning"
  return "negative"
}

function confidenceBadgeVariant(
  confidence: string
): "positive" | "warning" | "outline" {
  if (confidence === "High") return "positive"
  if (confidence === "Medium") return "warning"
  return "outline"
}

function earningsTrendBadgeVariant(
  trend: string
): "positive" | "negative" | "outline" {
  if (trend === "Improving") return "positive"
  if (trend === "Weakening") return "negative"
  return "outline"
}

function TrendIcon({ trend }: { trend: string }) {
  const cls = "h-3 w-3 mr-0.5"
  if (trend === "Improving") return <TrendingUp className={cls} />
  if (trend === "Weakening") return <TrendingDown className={cls} />
  return <Minus className={cls} />
}

function timeframeBadgeVariant(
  tf: string
): "negative" | "warning" | "outline" {
  if (tf === "Immediate") return "negative"
  if (tf === "Within 1 month") return "warning"
  return "outline"
}

// ── Price Context types (mirrors price-context-calculator.ts) ─────────────────

interface PriceContext {
  symbol: string
  asOf: string
  currentPrice: number
  returns: { d1: number; d5: number; d10: number; d30: number; d90: number }
  trend: { shortTermTrend: string; mediumTermTrend: string; longTermTrend: string }
  momentum: { change: string; shortTermSlope: number; mediumTermSlope: number }
  volatility: { realized30d: number; realized90d: number; state: string; trend: string }
  rangePosition: { from30dLow: number; from30dHigh: number; from90dLow: number; from90dHigh: number }
  priceState: string
  observedOn: string
  barsUsed: number
}

function priceStateBadgeVariant(
  state: string
): "positive" | "negative" | "warning" | "outline" {
  if (state.includes("Trending") && state.includes("Up")) return "positive"
  if (state === "PossibleRecovery" || state === "StabilizingAfterDecline") return "warning"
  if (state === "Consolidating") return "outline"
  if (state.includes("Down") || state === "Breaking Down") return "negative"
  if (state === "ExtendedAfterRally") return "warning"
  return "outline"
}

function trendBadgeVariant(t: string): "positive" | "negative" | "outline" {
  if (t === "Up" || t === "Strong Up") return "positive"
  if (t === "Down" || t === "Strong Down") return "negative"
  return "outline"
}

function returnColour(pct: number): string {
  if (pct > 1) return "text-emerald-400"
  if (pct < -1) return "text-rose-400"
  return "text-muted-foreground"
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`
}

function PriceContextPanel({ ctx }: { ctx: PriceContext }) {
  const returns = [
    { label: "1D",  val: ctx.returns.d1 },
    { label: "5D",  val: ctx.returns.d5 },
    { label: "1M",  val: ctx.returns.d30 },
    { label: "3M",  val: ctx.returns.d90 },
  ]

  return (
    <Card className="bg-card/40 border-card-border/40">
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground">
            Price Context
          </p>
          <Badge
            variant={priceStateBadgeVariant(ctx.priceState)}
            className="text-[10px] uppercase tracking-wider px-1.5 py-0"
          >
            {ctx.priceState.replace(/([A-Z])/g, ' $1').trim()}
          </Badge>
          <span className="ml-auto text-[10px] text-muted-foreground/40">
            {ctx.barsUsed}d of data
          </span>
        </div>

        {/* Returns row */}
        <div className="grid grid-cols-4 gap-1">
          {returns.map(({ label, val }) => (
            <div key={label} className="flex flex-col items-center p-1.5 rounded-md bg-background/30">
              <span className="text-[9px] text-muted-foreground/60 uppercase tracking-widest">{label}</span>
              <span className={`text-xs font-mono font-semibold ${returnColour(val)}`}>{fmtPct(val)}</span>
            </div>
          ))}
        </div>

        {/* Trend & Momentum */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-muted-foreground/60 uppercase tracking-widest mr-0.5">Trend</span>
          <Badge variant={trendBadgeVariant(ctx.trend.shortTermTrend)} className="text-[9px] px-1 py-0">{ctx.trend.shortTermTrend} ST</Badge>
          <Badge variant={trendBadgeVariant(ctx.trend.mediumTermTrend)} className="text-[9px] px-1 py-0">{ctx.trend.mediumTermTrend} MT</Badge>
          <Badge variant={trendBadgeVariant(ctx.trend.longTermTrend)} className="text-[9px] px-1 py-0">{ctx.trend.longTermTrend} LT</Badge>
          <span className="text-[10px] text-muted-foreground/60 uppercase tracking-widest ml-2 mr-0.5">Momentum</span>
          <span className="text-[10px] text-foreground/70">{ctx.momentum.change.replace(/([A-Z])/g, ' $1').trim()}</span>
        </div>

        {/* Volatility & Range */}
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground/70">
          <span>
            <span className="uppercase tracking-widest mr-1 text-muted-foreground/50">Vol</span>
            {ctx.volatility.state}
            <span className="text-muted-foreground/40 ml-1">({ctx.volatility.realized30d.toFixed(0)}% ann)</span>
          </span>
          <span className="text-muted-foreground/30">·</span>
          <span>
            <span className="uppercase tracking-widest mr-1 text-muted-foreground/50">30d range</span>
            <span className={returnColour(ctx.rangePosition.from30dLow)}>
              {ctx.rangePosition.from30dLow >= 0 ? "+" : ""}{ctx.rangePosition.from30dLow.toFixed(1)}% from low
            </span>
            <span className="text-muted-foreground/30 mx-1">/</span>
            <span className={returnColour(-ctx.rangePosition.from30dHigh)}>
              {ctx.rangePosition.from30dHigh.toFixed(1)}% from high
            </span>
          </span>
        </div>

        {/* Disclaimer note */}
        <p className="text-[9px] text-muted-foreground/30 leading-tight">
          Observed price behavior — not a forecast. Do not use to infer valuation.
        </p>
      </CardContent>
    </Card>
  )
}

// ── Collapsible item card (catalysts / risks) ─────────────────────────────────

interface CollapsibleItemProps {
  title: string
  description: string
  impact: string
  timeframe?: string
  accentColor: "primary" | "destructive"
  expandedKey: string | null
  onToggle: (key: string) => void
  itemKey: string
}

function CollapsibleItem({
  title,
  description,
  impact,
  timeframe,
  accentColor,
  expandedKey,
  onToggle,
  itemKey,
}: CollapsibleItemProps) {
  const isOpen = expandedKey === itemKey
  const accent = accentColor === "primary" ? "text-primary/50" : "text-destructive/50"

  return (
    <li className="px-4 py-3 border-b border-border/40 last:border-b-0">
      <button
        className="w-full text-left flex items-start gap-2.5"
        onClick={() => onToggle(itemKey)}
      >
        <span className={`${accent} shrink-0 mt-0.5`}>
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <Badge
              variant={impactBadgeVariant(impact)}
              className="text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0"
            >
              {impact}
            </Badge>
            {timeframe && (
              <Badge
                variant={timeframeBadgeVariant(timeframe)}
                className="text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0"
              >
                {timeframe}
              </Badge>
            )}
          </div>
          <p className="text-sm font-medium text-foreground/90 leading-snug">{title}</p>
        </div>
      </button>
      {isOpen && (
        <div className={`mt-2 ml-6 pl-3 border-l ${accentColor === "primary" ? "border-primary/30" : "border-destructive/30"} animate-in fade-in duration-200`}>
          <p className="text-xs text-muted-foreground/70 leading-relaxed">{description}</p>
        </div>
      )}
    </li>
  )
}

// ── Company input form ────────────────────────────────────────────────────────

interface CompanyInputProps {
  onLoad: (ticker: string, companyName: string) => void
  isLoading?: boolean
  initialTicker?: string
  initialCompanyName?: string
  compact?: boolean
}

function CompanyInput({
  onLoad,
  isLoading,
  initialTicker = "",
  initialCompanyName = "",
  compact = false,
}: CompanyInputProps) {
  const [ticker, setTicker] = useState(initialTicker)
  const [companyName, setCompanyName] = useState(initialCompanyName)
  const tickerRef = useRef<HTMLInputElement>(null)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const t = ticker.toUpperCase().trim()
    if (!t) return
    onLoad(t, companyName.trim())
  }

  useEffect(() => {
    if (!compact) tickerRef.current?.focus()
  }, [compact])

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
        {/* Ticker */}
        <div className="flex flex-col gap-1 w-full sm:w-auto">
          <label className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
            Ticker symbol <span className="text-destructive">*</span>
          </label>
          <Input
            ref={tickerRef}
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder="NVDA"
            className="h-8 w-full sm:w-28 font-mono text-sm uppercase bg-background/60 border-border/60 focus:border-primary/50"
            maxLength={10}
            required
          />
        </div>

        {/* Company name */}
        <div className="flex flex-col gap-1 w-full sm:w-auto">
          <label className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
            Company name (optional)
          </label>
          <Input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Nvidia"
            className="h-8 w-full sm:w-48 text-sm bg-background/60 border-border/60 focus:border-primary/50"
          />
        </div>

        {/* Submit */}
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={isLoading}
          className="h-8 gap-1.5 border-primary/30 text-primary hover:bg-primary/10 w-full sm:w-auto disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          Select company
        </Button>
      </div>

      {/* Helper text — only show on the main (non-compact) form */}
      {!compact && (
        <p className="text-[11px] text-muted-foreground/50 leading-snug">
          Enter the ticker symbol. The company name is optional but helps OpenAI verify the correct company.
        </p>
      )}
    </form>
  )
}

// ── Recently analyzed list ────────────────────────────────────────────────────

interface RecentCompaniesProps {
  onSelect: (ticker: string, name: string) => void
  activeTicker: string | null
}

function RecentCompanies({ onSelect, activeTicker }: RecentCompaniesProps) {
  const { data: entries } = useListRepositoryEntries({ query: { retry: false } })

  const recent: RecentCompany[] = (entries ?? [])
    .filter((e) => e.moduleName.startsWith("company-monitor:"))
    .map((e) => {
      const ticker = e.moduleName.replace("company-monitor:", "")
      const result = e.result as Record<string, unknown>
      const company = result?.company as Record<string, unknown> | undefined
      const name = typeof company?.name === "string" ? company.name : ticker
      return { ticker, name, updatedAt: e.updatedAt }
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 10)

  if (recent.length === 0) return null

  return (
    <Card className="bg-card/40 border-card-border/40">
      <CardContent className="p-4">
        <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-2">
          Recently analyzed
        </p>
        <div className="flex flex-wrap gap-2">
          {recent.map((c) => (
            <button
              key={c.ticker}
              onClick={() => onSelect(c.ticker, c.name)}
              className={`flex items-center gap-1.5 text-xs rounded px-2 py-1 border transition-colors ${
                activeTicker === c.ticker
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/40 bg-background/40 text-muted-foreground hover:border-primary/30 hover:text-foreground"
              }`}
            >
              <span className="font-mono font-semibold">{c.ticker}</span>
              {c.name !== c.ticker && (
                <span className="text-muted-foreground/60 hidden sm:inline">{c.name}</span>
              )}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ── Section card ──────────────────────────────────────────────────────────────

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="bg-card/40 border-card-border/40">
      <CardContent className="p-4">
        <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-2">
          {title}
        </p>
        {children}
      </CardContent>
    </Card>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CompanyMonitor() {
  // Pre-fill ticker from URL param (e.g. /companies?ticker=AAPL from Opportunity Finder)
  const search = useSearch()
  const urlTicker = new URLSearchParams(search).get("ticker")?.toUpperCase() ?? null

  // Company selection state
  const [activeTicker, setActiveTicker] = useState<string | null>(urlTicker)
  const [activeCompanyName, setActiveCompanyName] = useState<string>("")

  useEffect(() => {
    if (urlTicker && !activeTicker) setActiveTicker(urlTicker)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTicker])

  // UI state
  const [debugInfo, setDebugInfo] = useState<AiDebugInfo | null>(null)
  const [debugError, setDebugError] = useState<unknown>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [expandedCatalyst, setExpandedCatalyst] = useState<string | null>(null)
  const [expandedRisk, setExpandedRisk] = useState<string | null>(null)

  // ── Persisted result (loaded from repository on company selection) ─────────
  const repositoryKey = activeTicker ? `company-monitor:${activeTicker}` : ""
  const { data: repoEntry, isLoading: repoLoading } = useGetRepositoryEntry(repositoryKey, {
    query: { retry: false, enabled: !!activeTicker },
  })
  const storedAnalysis = repoEntry?.result as CompanyAnalysis | undefined

  // ── Price Context (from repository, no loading state needed — just display if available) ──
  const priceCtxKey = activeTicker ? `price-context:${activeTicker}` : ""
  const { data: priceCtxEntry } = useGetRepositoryEntry(priceCtxKey, {
    query: { retry: false, enabled: !!activeTicker, staleTime: 60_000 },
  })
  const priceCtx = priceCtxEntry?.result as PriceContext | undefined

  // ── Update mutation ───────────────────────────────────────────────────────
  const {
    mutate: runAnalysis,
    data: mutationData,
    isPending,
    error: mutationError,
    reset: resetMutation,
  } = useRunCompanyAnalysis({
    mutation: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onSuccess: (data: any) => {
        const d = data?._debug
        if (d) setDebugInfo(d)
        setDebugError(null)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onError: (err: any) => {
        // ApiError puts the parsed response body in .data — _debug lives there
        const body = err?.data ?? err
        const d = body?._debug
        if (d) setDebugInfo(d)
        setDebugError(body)
      },
    },
  })

  // Active analysis: latest mutation result takes priority, fall back to stored.
  // When switching companies the mutation is reset immediately so mutationData
  // never bleeds through from the previous company.
  const analysis = (mutationData ?? storedAnalysis) as CompanyAnalysis | undefined

  const handleLoad = (ticker: string, companyName: string) => {
    // Reset mutation state immediately so previous company's result never shows
    resetMutation()
    setActiveTicker(ticker)
    setActiveCompanyName(companyName)
    setExpandedCatalyst(null)
    setExpandedRisk(null)
    setDebugInfo(null)
    setDebugError(null)
  }

  const handleRefresh = () => {
    if (!activeTicker) return
    setExpandedCatalyst(null)
    setExpandedRisk(null)
    runAnalysis({ data: { ticker: activeTicker, companyName: activeCompanyName || undefined } })
  }

  const toggleCatalyst = (key: string) => {
    setExpandedCatalyst(prev => prev === key ? null : key)
  }
  const toggleRisk = (key: string) => {
    setExpandedRisk(prev => prev === key ? null : key)
  }

  const hasDebug = debugInfo !== null || debugError !== null

  // ── Input screen (no company selected) ───────────────────────────────────
  if (!activeTicker) {
    return (
      <div className="space-y-3 pb-4 animate-in fade-in duration-500">
        <Card className="bg-card/60 border-card-border/50">
          <CardContent className="p-4">
            <h2 className="text-xs font-bold tracking-widest uppercase text-muted-foreground mb-4">
              Company Monitor
            </h2>
            <CompanyInput onLoad={handleLoad} />
          </CardContent>
        </Card>
        <RecentCompanies onSelect={handleLoad} activeTicker={activeTicker} />
      </div>
    )
  }

  // ── Loading skeleton (initial repository fetch only) ──────────────────────
  if (repoLoading) {
    return <Skeleton className="h-16 w-full animate-in fade-in duration-300" />
  }

  // ── Company selected but no analysis yet ──────────────────────────────────
  if (!analysis) {
    return (
      <div className="space-y-3 pb-4 animate-in fade-in duration-500">
        <Card className="bg-card/60 border-card-border/50">
          <CardContent className="p-4 space-y-4">
            <h2 className="text-xs font-bold tracking-widest uppercase text-muted-foreground">
              Company Monitor
            </h2>
            <CompanyInput onLoad={handleLoad} initialTicker={activeTicker} initialCompanyName={activeCompanyName} />
            <div className="flex items-center justify-between gap-3 pt-1 border-t border-border/30">
              <div className="flex items-center gap-2 min-w-0">
                <Building2 className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                <span className="text-sm font-mono font-semibold text-foreground/80">{activeTicker}</span>
                {activeCompanyName && (
                  <span className="text-sm text-muted-foreground/60 truncate">{activeCompanyName}</span>
                )}
                <span className="text-sm text-muted-foreground/40 italic">— Not updated yet</span>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleRefresh}
                disabled={isPending}
                className="h-8 gap-1.5 border-primary/30 text-primary hover:bg-primary/10 shrink-0"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
                Update Analysis
              </Button>
            </div>
          </CardContent>
        </Card>
        <RecentCompanies onSelect={handleLoad} activeTicker={activeTicker} />
      </div>
    )
  }

  // ── Analysis view ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-3 pb-8 animate-in fade-in slide-in-from-bottom-2 duration-500">

      {/* Inline update-failed banner */}
      {mutationError && (
        <div className="flex items-center gap-2 text-xs text-destructive/80 bg-destructive/8 border border-destructive/20 rounded-md px-3 py-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Update failed — showing last saved result.</span>
          {hasDebug && (
            <button onClick={() => setDebugOpen(true)} className="ml-auto text-muted-foreground hover:text-foreground underline underline-offset-2">
              Details
            </button>
          )}
        </div>
      )}

      {/* ── Summary card — always visible ── */}
      <Card className={`bg-card/60 overflow-hidden transition-colors duration-300 ${isPending ? "border-primary/30" : "border-card-border/50"}`}>
        {isPending && <div className="h-0.5 bg-primary/70 animate-pulse" />}
        <CardContent className="p-4 space-y-3">

          {/* Company input — always accessible for switching */}
          <CompanyInput
            onLoad={handleLoad}
            isLoading={repoLoading}
            initialTicker={activeTicker ?? ""}
            initialCompanyName={activeCompanyName}
            compact
          />

          {/* Analysis header row */}
          <div className="flex items-start justify-between gap-3 pt-1 border-t border-border/30">
            <div className="min-w-0">
              {/* Badges */}
              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                <Badge
                  variant={ratingBadgeVariant(analysis.investmentView.rating)}
                  className={`text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0 ${ratingOpacity(analysis.investmentView.rating)}`}
                >
                  {analysis.investmentView.rating}
                </Badge>
                <Badge
                  variant={outlookBadgeVariant(analysis.investmentView.outlook)}
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0"
                >
                  {analysis.investmentView.outlook}
                </Badge>
                <Badge
                  variant={confidenceBadgeVariant(analysis.confidence)}
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0"
                >
                  {analysis.confidence} conf.
                </Badge>
                {analysis.investmentCaseStrength !== undefined && (
                  <span className="text-[10px] font-mono text-muted-foreground/60 bg-muted/30 rounded px-1.5 py-0.5 shrink-0 tabular-nums">
                    ICS {analysis.investmentCaseStrength}
                    {analysis.investmentCaseStrengthChange && (
                      <span className={analysis.investmentCaseStrengthChange.currentScore > analysis.investmentCaseStrengthChange.previousScore ? "text-emerald-500/70" : "text-rose-500/70"}>
                        {analysis.investmentCaseStrengthChange.currentScore > analysis.investmentCaseStrengthChange.previousScore ? " ↑" : " ↓"}
                        {Math.abs(analysis.investmentCaseStrengthChange.currentScore - analysis.investmentCaseStrengthChange.previousScore)}
                      </span>
                    )}
                  </span>
                )}
                {analysis.updateType === "UpdateWithChanges" && (
                  <Badge variant="warning" className="text-[9px] px-1.5 py-0 shrink-0">
                    Updated
                  </Badge>
                )}
              </div>

              {/* Company name + ticker */}
              <div className="flex items-center gap-2 flex-wrap">
                <Building2 className="h-3.5 w-3.5 text-primary/70 shrink-0" />
                <span className="text-sm font-semibold text-foreground/90">
                  {analysis.company.name}
                </span>
                <span className="text-xs font-mono text-muted-foreground/60 bg-muted/30 rounded px-1.5 py-0.5">
                  {analysis.company.ticker}
                </span>
              </div>

              {/* Timestamp row */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/50 mt-1">
                {isPending ? (
                  <span className="flex items-center gap-1.5 text-primary/80 animate-pulse">
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    Analysing {activeTicker}…
                  </span>
                ) : (
                  <>
                    <span className="flex items-center gap-1 whitespace-nowrap">
                      <Clock className="h-3 w-3 shrink-0" />
                      {format(new Date(analysis.timestamp), "d. MMM HH:mm 'UTC'")}
                      {analysis.updateType === "NoMaterialChange" && (
                        <span className="text-muted-foreground/35">(no change)</span>
                      )}
                    </span>
                    <span className="flex items-center gap-1 whitespace-nowrap">
                      <Timer className="h-3 w-3 shrink-0" />
                      {formatDuration(analysis.analysisDuration)}
                    </span>
                    <span className="whitespace-nowrap text-muted-foreground/40">{analysis.company.sector}</span>
                  </>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-1 shrink-0">
              <Button
                size="sm"
                variant="outline"
                onClick={handleRefresh}
                disabled={isPending}
                className="h-8 gap-1.5 border-primary/30 text-primary hover:bg-primary/10 disabled:opacity-30"
                data-testid="button-refresh"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
                <span className="hidden sm:inline text-xs">Update Analysis</span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
                onClick={() => setDebugOpen(true)}
                title="Show debug info"
                disabled={!hasDebug}
              >
                <Info className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                onClick={() => setExpanded(!expanded)}
                title={expanded ? "Collapse" : "Expand"}
              >
                {expanded ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Recently analyzed ── */}
      <RecentCompanies onSelect={handleLoad} activeTicker={activeTicker} />

      {/* ── Expanded content ── */}
      {expanded && (
        <>
          {/* Executive Summary */}
          <Card className="bg-card/40 border-card-border/40">
            <CardContent className="p-4">
              <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-2">
                Executive Summary
              </p>
              <p className="text-sm text-foreground/80 leading-relaxed">
                {analysis.executiveSummary}
              </p>
              {analysis.investmentView.reason && (
                <div className="mt-3 pt-3 border-t border-border/30 flex items-start gap-2">
                  <span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground/60 mt-0.5 shrink-0">
                    View
                  </span>
                  <p className="text-sm text-foreground/70 leading-snug">
                    {analysis.investmentView.reason}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Investment Case Change — shown prominently when something materially changed */}
          {analysis.investmentCaseChange?.changed && (
            <Card className={`overflow-hidden border ${
              analysis.investmentCaseChange.severity === "High"
                ? "border-amber-500/35 bg-amber-500/5"
                : analysis.investmentCaseChange.severity === "Medium"
                ? "border-blue-500/25 bg-blue-500/5"
                : "border-border/40 bg-muted/10"
            }`}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground">
                    Investment Case Changed
                  </p>
                  <Badge
                    variant={analysis.investmentCaseChange.severity === "High" ? "warning" : "secondary"}
                    className="text-[9px] px-1.5 py-0"
                  >
                    {analysis.investmentCaseChange.severity}
                  </Badge>
                  {analysis.investmentCaseChange.previousInvestmentView !== "N/A" &&
                    analysis.investmentCaseChange.previousInvestmentView !== analysis.investmentCaseChange.currentInvestmentView && (
                    <span className="text-[10px] text-muted-foreground/60 font-mono">
                      {analysis.investmentCaseChange.previousInvestmentView}
                      <span className="mx-1 text-muted-foreground/30">→</span>
                      {analysis.investmentCaseChange.currentInvestmentView}
                    </span>
                  )}
                </div>
                <p className="text-sm text-foreground/80 leading-relaxed">{analysis.investmentCaseChange.summary}</p>
                {analysis.investmentCaseChange.reason && (
                  <p className="text-xs text-muted-foreground/60 leading-snug">{analysis.investmentCaseChange.reason}</p>
                )}
                {analysis.investmentCaseStrengthChange && (
                  <div className="pt-2 border-t border-border/30 space-y-1">
                    <p className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground/60">
                      Case Strength: {analysis.investmentCaseStrengthChange.previousScore} →{" "}
                      <span className={analysis.investmentCaseStrengthChange.currentScore >= analysis.investmentCaseStrengthChange.previousScore ? "text-emerald-500/70" : "text-rose-500/70"}>
                        {analysis.investmentCaseStrengthChange.currentScore}
                      </span>
                    </p>
                    <ul className="space-y-0.5">
                      {analysis.investmentCaseStrengthChange.reasons.map((r: string, i: number) => (
                        <li key={i} className="text-xs text-muted-foreground/60 flex gap-1.5">
                          <span className="shrink-0 mt-0.5 text-muted-foreground/30">·</span>
                          {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Investment Thesis */}
          {analysis.investmentThesis && analysis.investmentThesis.length > 0 && (
            <Card className="bg-card/40 border-card-border/40">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground">
                    Investment Thesis
                  </p>
                  {analysis.investmentCaseStrength !== undefined && (
                    <span className="ml-auto text-[10px] font-mono text-muted-foreground/50 tabular-nums">
                      Strength: {analysis.investmentCaseStrength}/100
                    </span>
                  )}
                </div>
                <ul className="space-y-2">
                  {analysis.investmentThesis.map((pt: CompanyThesisPoint, i: number) => {
                    const statusColor =
                      pt.status === "Strengthened" ? "text-emerald-500/70 border-emerald-500/30" :
                      pt.status === "Weakened"     ? "text-amber-500/70 border-amber-500/30" :
                      pt.status === "Invalidated"  ? "text-rose-500/70 border-rose-500/30" :
                                                     "text-muted-foreground/40 border-border/30";
                    const dotColor =
                      pt.status === "Strengthened" ? "bg-emerald-500/60" :
                      pt.status === "Weakened"     ? "bg-amber-500/60" :
                      pt.status === "Invalidated"  ? "bg-rose-500/60" :
                                                     "bg-muted-foreground/30";
                    return (
                      <li key={pt.id || i} className={`flex items-start gap-2.5 pb-2 ${i < analysis.investmentThesis.length - 1 ? "border-b border-border/20" : ""}`}>
                        <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${dotColor}`} />
                        <span className="text-sm text-foreground/80 leading-snug flex-1">{pt.point}</span>
                        {analysis.updateType !== "FullAnalysis" && (
                          <span className={`text-[9px] font-medium uppercase tracking-wider shrink-0 mt-0.5 border rounded px-1 py-0 ${statusColor}`}>
                            {pt.status}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Investment View highlight card */}
          <Card className="bg-primary/5 border-primary/15">
            <CardHeader className="px-4 pt-4 pb-2">
              <CardTitle className="text-[11px] font-bold tracking-widest uppercase text-primary/70 flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5" />
                {analysis.company.name} · {analysis.company.ticker}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0">
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <Badge
                  variant={ratingBadgeVariant(analysis.investmentView.rating)}
                  className={`text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0 ${ratingOpacity(analysis.investmentView.rating)}`}
                >
                  {analysis.investmentView.rating}
                </Badge>
                <Badge
                  variant={outlookBadgeVariant(analysis.investmentView.outlook)}
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0"
                >
                  {analysis.investmentView.outlook}
                </Badge>
                <Badge
                  variant={sentimentBadgeVariant(analysis.marketSentiment)}
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0"
                >
                  Sentiment: {analysis.marketSentiment}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground/60">
                {analysis.company.sector} · {analysis.company.industry}
              </p>
            </CardContent>
          </Card>

          {/* Current Situation */}
          <SectionCard title="Current Situation">
            <p className="text-sm text-foreground/80 leading-relaxed">{analysis.currentSituation}</p>
          </SectionCard>

          {/* Earnings & Guidance */}
          <Card className="bg-card/40 border-card-border/40">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground">
                  Earnings &amp; Guidance
                </p>
                <Badge
                  variant={earningsTrendBadgeVariant(analysis.earningsAndGuidance.trend)}
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0 flex items-center gap-0.5"
                >
                  <TrendIcon trend={analysis.earningsAndGuidance.trend} />
                  {analysis.earningsAndGuidance.trend}
                </Badge>
              </div>
              <p className="text-sm text-foreground/80 leading-relaxed mb-3">
                {analysis.earningsAndGuidance.summary}
              </p>
              {analysis.earningsAndGuidance.nextKnownEvent && (
                <div className="flex items-start gap-2 pt-2 border-t border-border/30">
                  <span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground/60 mt-0.5 shrink-0">
                    Next event
                  </span>
                  <div>
                    <p className="text-sm text-foreground/80">{analysis.earningsAndGuidance.nextKnownEvent}</p>
                    {analysis.earningsAndGuidance.nextKnownEventDate && (
                      <p className="text-xs text-muted-foreground/50 mt-0.5">
                        {analysis.earningsAndGuidance.nextKnownEventDate}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Catalysts */}
          {analysis.catalysts && analysis.catalysts.length > 0 && (
            <Card className="bg-card/40 border-card-border/40">
              <CardHeader className="px-4 pt-4 pb-2">
                <CardTitle className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground flex items-center gap-1.5">
                  Catalysts
                  <span className="ml-auto text-muted-foreground/40 font-normal normal-case tracking-normal text-[10px]">
                    {analysis.catalysts.length} item{analysis.catalysts.length !== 1 ? "s" : ""}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ul>
                  {analysis.catalysts.map((c: CompanyCatalyst, i: number) => (
                    <CollapsibleItem
                      key={i}
                      itemKey={`catalyst-${i}`}
                      title={c.title}
                      description={c.description}
                      impact={c.impact}
                      timeframe={c.timeframe}
                      accentColor="primary"
                      expandedKey={expandedCatalyst}
                      onToggle={toggleCatalyst}
                    />
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Risks */}
          {analysis.risks && analysis.risks.length > 0 && (
            <Card className="bg-card/40 border-card-border/40">
              <CardHeader className="px-4 pt-4 pb-2">
                <CardTitle className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground flex items-center gap-1.5">
                  Risks
                  <span className="ml-auto text-muted-foreground/40 font-normal normal-case tracking-normal text-[10px]">
                    {analysis.risks.length} item{analysis.risks.length !== 1 ? "s" : ""}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ul>
                  {analysis.risks.map((r: CompanyRisk, i: number) => (
                    <CollapsibleItem
                      key={i}
                      itemKey={`risk-${i}`}
                      title={r.title}
                      description={r.description}
                      impact={r.impact}
                      accentColor="destructive"
                      expandedKey={expandedRisk}
                      onToggle={toggleRisk}
                    />
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Competitive Position */}
          <Card className="bg-card/40 border-card-border/40">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground">
                  Competitive Position
                </p>
                <Badge
                  variant={competitiveBadgeVariant(analysis.competitivePosition.assessment)}
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0"
                >
                  {analysis.competitivePosition.assessment}
                </Badge>
              </div>
              <p className="text-sm text-foreground/80 leading-relaxed">
                {analysis.competitivePosition.summary}
              </p>
            </CardContent>
          </Card>

          {/* Sector Context */}
          <SectionCard title="Sector Context">
            <p className="text-sm text-foreground/80 leading-relaxed">{analysis.sectorContext}</p>
          </SectionCard>

          {/* Price Context */}
          {priceCtx && <PriceContextPanel ctx={priceCtx} />}

          {/* Valuation Assessment */}
          <Card className="bg-card/40 border-card-border/40">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground">
                  Valuation Assessment
                </p>
                <Badge
                  variant={valuationBadgeVariant(analysis.valuationAssessment.level)}
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0"
                >
                  {analysis.valuationAssessment.level}
                </Badge>
              </div>
              <p className="text-sm text-foreground/80 leading-relaxed">
                {analysis.valuationAssessment.summary}
              </p>
            </CardContent>
          </Card>

          {/* Bull / Base / Bear Cases */}
          <Card className="bg-card/40 border-card-border/40">
            <CardContent className="p-4 space-y-4">
              <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground">
                Scenarios
              </p>
              <div className="space-y-3">
                <div className="flex items-start gap-2.5">
                  <span className="text-[10px] font-bold tracking-widest uppercase text-emerald-500/70 mt-0.5 w-8 shrink-0">Bull</span>
                  <p className="text-sm text-foreground/80 leading-relaxed">{analysis.bullCase}</p>
                </div>
                <div className="flex items-start gap-2.5 pt-3 border-t border-border/30">
                  <span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground/60 mt-0.5 w-8 shrink-0">Base</span>
                  <p className="text-sm text-foreground/80 leading-relaxed">{analysis.baseCase}</p>
                </div>
                <div className="flex items-start gap-2.5 pt-3 border-t border-border/30">
                  <span className="text-[10px] font-bold tracking-widest uppercase text-destructive/60 mt-0.5 w-8 shrink-0">Bear</span>
                  <p className="text-sm text-foreground/80 leading-relaxed">{analysis.bearCase}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Key Things to Watch */}
          {analysis.keyThingsToWatch && analysis.keyThingsToWatch.length > 0 && (
            <Card className="bg-card/40 border-card-border/40">
              <CardContent className="p-4">
                <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-2">
                  Key Things to Watch
                </p>
                <ul className="space-y-1.5">
                  {analysis.keyThingsToWatch.map((item: string, i: number) => (
                    <li key={i} className="text-sm text-foreground/80 leading-snug flex gap-2">
                      <span className="text-primary/50 shrink-0 mt-0.5">→</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Stable Profile — core business facts that rarely change */}
          {analysis.stableProfile && (
            <Card className="bg-card/30 border-card-border/30">
              <CardContent className="p-4 space-y-3">
                <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground/60">
                  Stable Profile
                </p>
                {analysis.stableProfile.businessDescription && (
                  <p className="text-sm text-foreground/70 leading-relaxed">
                    {analysis.stableProfile.businessDescription}
                  </p>
                )}
                {analysis.stableProfile.competitiveAdvantage && (
                  <div className="pt-2 border-t border-border/20">
                    <p className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground/50 mb-1">
                      Competitive Advantage
                    </p>
                    <p className="text-sm text-foreground/70 leading-relaxed">
                      {analysis.stableProfile.competitiveAdvantage}
                    </p>
                  </div>
                )}
                {analysis.stableProfile.longTermStrengths && analysis.stableProfile.longTermStrengths.length > 0 && (
                  <div className="pt-2 border-t border-border/20">
                    <p className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground/50 mb-1.5">
                      Long-Term Strengths
                    </p>
                    <ul className="space-y-1">
                      {analysis.stableProfile.longTermStrengths.map((s: string, i: number) => (
                        <li key={i} className="text-sm text-foreground/70 flex gap-2">
                          <span className="text-emerald-500/40 shrink-0 mt-0.5">+</span>
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {analysis.stableProfile.recurringRisks && analysis.stableProfile.recurringRisks.length > 0 && (
                  <div className="pt-2 border-t border-border/20">
                    <p className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground/50 mb-1.5">
                      Recurring Risks
                    </p>
                    <ul className="space-y-1">
                      {analysis.stableProfile.recurringRisks.map((r: string, i: number) => (
                        <li key={i} className="text-sm text-foreground/70 flex gap-2">
                          <span className="text-muted-foreground/40 shrink-0 mt-0.5">·</span>
                          {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      <DebugDialog
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
        debugInfo={debugInfo}
        error={debugError}
      />
    </div>
  )
}

// ── Debug Dialog ──────────────────────────────────────────────────────────────

interface DebugDialogProps {
  open: boolean
  onClose: () => void
  debugInfo: AiDebugInfo | null
  error: unknown
}

function DebugDialog({ open, onClose, debugInfo, error }: DebugDialogProps) {
  // error is now the parsed response body (not the ApiError wrapper)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errorBody = error as any

  const inputMessages: Array<{ role: string; content: string }> = (() => {
    if (!debugInfo) return []
    const req = debugInfo.request
    if (Array.isArray(req.messages)) return req.messages as Array<{ role: string; content: string }>
    if (Array.isArray(req.input)) return req.input as Array<{ role: string; content: string }>
    return []
  })()

  // Structured validation fields from the server error body
  const validationError: string | undefined = errorBody?.validationError
  const schemaErrors: Array<{ field: string; message: string }> | undefined = errorBody?.schemaErrors
  const serverErrorMsg: string | undefined = errorBody?.error
  const attemptCount: number | undefined = errorBody?.attempt
  const errorStage: string | undefined = errorBody?.errorStage
  const normalizations: string[] | undefined = errorBody?.normalizations
  const hasStructuredError = !!(validationError || schemaErrors?.length || serverErrorMsg)

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-3xl bg-[#0d1117] border-border text-foreground">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold uppercase tracking-widest flex items-center gap-2">
            <Info className="h-4 w-4 text-primary" />
            OpenAI Debug — Request &amp; Response
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[70vh] pr-2">
          <div className="space-y-4 text-xs font-mono">
            {hasStructuredError && (
              <DebugSection label="❌ Server Error" color="rose">
                {serverErrorMsg && (
                  <p className="text-rose-400 mb-2 font-semibold">
                    {serverErrorMsg}
                    {attemptCount !== undefined && (
                      <span className="text-rose-400/60 font-normal ml-2">(after {attemptCount} {attemptCount === 1 ? "attempt" : "attempts"})</span>
                    )}
                    {errorStage && (
                      <span className="text-rose-400/50 font-normal ml-2 text-[10px] uppercase tracking-wider">stage: {errorStage}</span>
                    )}
                  </p>
                )}
                {normalizations && normalizations.length > 0 && (
                  <div className="mb-2">
                    <p className="text-[10px] text-amber-400/60 uppercase tracking-widest mb-1">Applied normalizations</p>
                    <ul className="space-y-0.5">
                      {normalizations.map((n, i) => (
                        <li key={i} className="text-amber-300/80 text-[11px]">✓ {n}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {validationError && (
                  <div className="mb-2">
                    <p className="text-[10px] text-rose-400/60 uppercase tracking-widest mb-1">Consistency error</p>
                    <pre className="whitespace-pre-wrap text-rose-300/90 bg-background/60 rounded p-2 border border-rose-500/20 break-all">
                      {validationError}
                    </pre>
                  </div>
                )}
                {schemaErrors && schemaErrors.length > 0 && (
                  <div>
                    <p className="text-[10px] text-rose-400/60 uppercase tracking-widest mb-1">Schema errors</p>
                    <ul className="space-y-1">
                      {schemaErrors.map((e, i) => (
                        <li key={i} className="text-rose-300/90 bg-background/60 rounded px-2 py-1 border border-rose-500/20 flex gap-2">
                          <span className="text-rose-400/60 shrink-0 font-semibold">{e.field}:</span>
                          <span className="break-all">{e.message}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </DebugSection>
            )}
            {!hasStructuredError && !!error && (
              <DebugSection label="❌ Error" color="rose">
                <pre className="whitespace-pre-wrap text-rose-400 break-all">
                  {error instanceof Error
                    ? JSON.stringify({ message: error.message, stack: error.stack }, null, 2)
                    : JSON.stringify(error, null, 2)}
                </pre>
              </DebugSection>
            )}
            {debugInfo ? (
              <>
                <DebugSection
                  label="📤 Sent to OpenAI"
                  color="blue"
                  copyText={inputMessages.map(m => `[${m.role}]\n${m.content}`).join("\n\n")}
                >
                  <div className="space-y-1.5 mb-3">
                    <DebugRow label="API" value={"Responses API + Web Search"} />
                    <DebugRow label="Model" value={String(debugInfo.request.model ?? "—")} />
                    <DebugRow label="Temperature" value={String(debugInfo.request.temperature ?? "—")} />
                    <DebugRow label="Max tokens" value={String(
                      debugInfo.request.max_tokens ?? debugInfo.request.max_output_tokens ?? "—"
                    )} />
                    {!!debugInfo.request.tools && (
                      <DebugRow label="Tools" value={JSON.stringify(debugInfo.request.tools)} />
                    )}
                    <DebugRow label="Called at" value={debugInfo.calledAt} />
                  </div>
                  {inputMessages.map((m, i) => (
                    <div key={i} className="mb-2">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">[{m.role}]</p>
                      <pre className="whitespace-pre-wrap text-foreground/80 bg-background/60 rounded p-2 border border-border/40 break-all">
                        {m.content}
                      </pre>
                    </div>
                  ))}
                </DebugSection>
                <DebugSection
                  label="📥 Received from OpenAI"
                  color="emerald"
                  copyText={(() => {
                    try { return JSON.stringify(JSON.parse(debugInfo.rawResponse), null, 2) }
                    catch { return debugInfo.rawResponse }
                  })()}
                >
                  <div className="mb-3 flex flex-wrap gap-4 text-muted-foreground">
                    <span>
                      Web search:{" "}
                      <span className={debugInfo.webSearchUsed ? "text-emerald-400" : "text-rose-400"}>
                        {debugInfo.webSearchUsed ? "Yes ✓" : "No ✗"}
                      </span>
                    </span>
                    <span>Prompt tokens: <span className="text-foreground">{debugInfo.usage.prompt_tokens ?? "—"}</span></span>
                    <span>Completion tokens: <span className="text-foreground">{debugInfo.usage.completion_tokens ?? "—"}</span></span>
                    <span>Total: <span className="text-foreground">{debugInfo.usage.total_tokens ?? "—"}</span></span>
                  </div>
                  <pre className="whitespace-pre-wrap text-emerald-300/90 bg-background/60 rounded p-2 border border-emerald-500/20 break-all">
                    {(() => {
                      try { return JSON.stringify(JSON.parse(debugInfo.rawResponse), null, 2) }
                      catch { return debugInfo.rawResponse }
                    })()}
                  </pre>
                </DebugSection>
              </>
            ) : (
              <p className="text-muted-foreground">No debug data available yet. Run an analysis first.</p>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

function DebugSection({
  label, color, copyText, children,
}: {
  label: string; color: string; copyText?: string; children: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    if (!copyText) return
    navigator.clipboard.writeText(copyText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }
  const border = color === "blue" ? "border-blue-500/30" : color === "emerald" ? "border-emerald-500/30" : "border-rose-500/30"
  const text = color === "blue" ? "text-blue-400" : color === "emerald" ? "text-emerald-400" : "text-rose-400"
  return (
    <div className={`border ${border} rounded p-3`}>
      <div className="flex items-center justify-between mb-2">
        <p className={`text-[10px] font-bold uppercase tracking-widest ${text}`}>{label}</p>
        {copyText && (
          <button onClick={handleCopy} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-white/5">
            {copied
              ? <><Check className="h-3 w-3 text-emerald-400" /><span className="text-emerald-400">Copied</span></>
              : <><Copy className="h-3 w-3" /><span>Copy</span></>}
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function DebugRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground w-40 shrink-0">{label}:</span>
      <span className="text-foreground break-all">{value}</span>
    </div>
  )
}
