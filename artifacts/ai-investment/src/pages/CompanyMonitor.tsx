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
import { useRunCompanyAnalysis, useGetRepositoryEntry } from "@workspace/api-client-react"
import type {
  CompanyAnalysis,
  CompanyCatalyst,
  CompanyRisk,
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
  return "negative" // Bearish
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
  const border = accentColor === "primary" ? "border-primary/20" : "border-destructive/20"
  const accent = accentColor === "primary" ? "text-primary/50" : "text-destructive/50"

  return (
    <li className={`px-4 py-3 border-b border-border/40 last:border-b-0`}>
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
}

function CompanyInput({ onLoad, isLoading }: CompanyInputProps) {
  const [ticker, setTicker] = useState("")
  const [companyName, setCompanyName] = useState("")
  const tickerRef = useRef<HTMLInputElement>(null)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const t = ticker.toUpperCase().trim()
    if (!t) return
    onLoad(t, companyName.trim())
  }

  useEffect(() => {
    tickerRef.current?.focus()
  }, [])

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2 flex-wrap">
      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
          Ticker <span className="text-destructive">*</span>
        </label>
        <Input
          ref={tickerRef}
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          placeholder="e.g. NVDA"
          className="h-8 w-28 font-mono text-sm uppercase bg-background/60 border-border/60 focus:border-primary/50"
          maxLength={10}
          required
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
          Company name
        </label>
        <Input
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          placeholder="e.g. Nvidia"
          className="h-8 w-44 text-sm bg-background/60 border-border/60 focus:border-primary/50"
        />
      </div>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={!ticker.trim() || isLoading}
        className="h-8 gap-1.5 border-primary/30 text-primary hover:bg-primary/10"
      >
        <Search className="h-3.5 w-3.5" />
        Load
      </Button>
    </form>
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
  // Company selection state
  const [activeTicker, setActiveTicker] = useState<string | null>(null)
  const [activeCompanyName, setActiveCompanyName] = useState<string>("")

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

  // ── Update mutation ───────────────────────────────────────────────────────
  const { mutate: runAnalysis, data: mutationData, isPending, error: mutationError } = useRunCompanyAnalysis({
    mutation: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onSuccess: (data: any) => {
        const d = data?._debug
        if (d) setDebugInfo(d)
        setDebugError(null)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onError: (err: any) => {
        const d = err?._debug
        if (d) setDebugInfo(d)
        setDebugError(err)
      },
    },
  })

  // Active analysis: latest mutation result takes priority, fall back to stored
  const analysis = (mutationData ?? storedAnalysis) as CompanyAnalysis | undefined

  const handleLoad = (ticker: string, companyName: string) => {
    setActiveTicker(ticker)
    setActiveCompanyName(companyName)
    setExpandedCatalyst(null)
    setExpandedRisk(null)
    // Reset mutation data when switching companies
    setDebugInfo(null)
    setDebugError(null)
  }

  const handleRefresh = () => {
    if (!activeTicker) return
    setExpandedCatalyst(null)
    setExpandedRisk(null)
    runAnalysis({ ticker: activeTicker, companyName: activeCompanyName || undefined })
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
            <h2 className="text-xs font-bold tracking-widest uppercase text-muted-foreground mb-3">
              Company Monitor
            </h2>
            <p className="text-sm text-muted-foreground/60 mb-4 leading-relaxed">
              Enter a ticker symbol to load or run an investment analysis.
            </p>
            <CompanyInput onLoad={handleLoad} />
          </CardContent>
        </Card>
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
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-xs font-bold tracking-widest uppercase text-muted-foreground mb-1.5">
                  Company Monitor
                </h2>
                <div className="flex items-center gap-2">
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                  <span className="text-sm font-mono font-semibold text-foreground/80">{activeTicker}</span>
                  {activeCompanyName && (
                    <span className="text-sm text-muted-foreground/60">{activeCompanyName}</span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground/40 italic mt-1">Not updated yet</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleRefresh}
                disabled={isPending}
                className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Update analysis"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
              </Button>
            </div>
            <CompanyInput onLoad={handleLoad} />
          </CardContent>
        </Card>
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
        <CardContent className="p-4">

          {/* Company input (always accessible) */}
          <div className="mb-3">
            <CompanyInput onLoad={handleLoad} isLoading={repoLoading} />
          </div>

          <div className="flex items-center justify-between gap-4">

            {/* Left: company + rating + metadata */}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
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
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <Building2 className="h-3.5 w-3.5 text-primary/70 shrink-0" />
                <span className="text-sm font-semibold text-foreground/90">
                  {analysis.company.name}
                </span>
                <span className="text-xs font-mono text-muted-foreground/60 bg-muted/30 rounded px-1.5 py-0.5">
                  {analysis.company.ticker}
                </span>
              </div>

              <div className="hidden sm:flex items-center gap-3 text-[11px] text-muted-foreground/50 mt-1">
                {isPending ? (
                  <span className="flex items-center gap-1.5 text-primary/80 animate-pulse">
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    Analysing {activeTicker}…
                  </span>
                ) : (
                  <>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {format(new Date(analysis.timestamp), "HH:mm 'UTC'")}
                    </span>
                    <span className="flex items-center gap-1">
                      <Timer className="h-3 w-3" />
                      {formatDuration(analysis.analysisDuration)}
                    </span>
                    <span className="text-muted-foreground/40">{analysis.company.sector}</span>
                  </>
                )}
              </div>
            </div>

            {/* Right: action buttons + expand toggle */}
            <div className="flex items-center gap-1 shrink-0">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleRefresh}
                disabled={isPending}
                className="h-8 px-2 gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Update analysis"
                data-testid="button-refresh"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
                <span className="hidden sm:inline">Update Analysis</span>
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
              <div className="flex items-center gap-2 mb-2">
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
              <div className="flex items-center gap-2 mb-2">
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

          {/* Valuation Assessment */}
          <Card className="bg-card/40 border-card-border/40">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
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
  const inputMessages: Array<{ role: string; content: string }> = (() => {
    if (!debugInfo) return []
    const req = debugInfo.request
    if (Array.isArray(req.messages)) return req.messages as Array<{ role: string; content: string }>
    if (Array.isArray(req.input)) return req.input as Array<{ role: string; content: string }>
    return []
  })()

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
            {!!error && (
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
                    <DebugRow label="API" value={debugInfo.webSearchUsed ? "Responses API + web_search" : "Chat Completions"} />
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
