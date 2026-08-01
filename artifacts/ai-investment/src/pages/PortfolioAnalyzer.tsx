/**
 * Portfolio Analyzer Page
 *
 * AI-powered portfolio assessment for a 1–3 month investment horizon.
 * Combines data from Portfolio Manager, Market, Event, News and Sector
 * Monitors, plus Company Monitor analyses for held positions.
 *
 * Data flows: loads the stored result from the Analysis Repository on mount.
 * Only calls OpenAI when the user explicitly presses "Update Analysis".
 * If an update fails, the previous successful result remains visible.
 */
import { useState } from "react"
import { useRunPortfolioAnalysis, useGetRepositoryEntry } from "@workspace/api-client-react"
import type { PortfolioAnalysis } from "@workspace/api-client-react"
import {
  AlertCircle,
  RefreshCw,
  Info,
  ChevronRight,
  Clock,
  Timer,
  BarChart2,
  TrendingUp,
  TrendingDown,
  Shield,
  Lightbulb,
  Target,
  Eye,
  Copy,
  Check,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
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
): "positive" | "warning" | "negative" | "outline" {
  if (rating === "Excellent") return "positive"
  if (rating === "Good") return "outline"
  if (rating === "Fair") return "warning"
  return "negative"
}

function outlookBadgeVariant(
  outlook: string
): "positive" | "warning" | "negative" | "outline" {
  if (outlook === "Bullish" || outlook === "Moderately Bullish") return "positive"
  if (outlook === "Neutral") return "outline"
  if (outlook === "Moderately Bearish") return "warning"
  return "negative"
}

function highMedLowBadgeVariant(
  level: string,
  highIsGood = false
): "positive" | "warning" | "negative" | "outline" {
  if (highIsGood) {
    if (level === "High") return "positive"
    if (level === "Medium") return "warning"
    return "outline"
  }
  if (level === "High") return "negative"
  if (level === "Medium") return "warning"
  return "outline"
}

function scoreColor(score: number): string {
  if (score >= 75) return "text-emerald-400"
  if (score >= 55) return "text-blue-400"
  if (score >= 35) return "text-amber-400"
  return "text-red-400"
}

function toggleIdx(set: Set<number>, idx: number): Set<number> {
  const next = new Set(set)
  if (next.has(idx)) next.delete(idx)
  else next.add(idx)
  return next
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PortfolioAnalyzer() {
  const [debugInfo, setDebugInfo] = useState<AiDebugInfo | null>(null)
  const [debugError, setDebugError] = useState<unknown>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  const [expandedRisks, setExpandedRisks] = useState<Set<number>>(new Set())
  const [expandedOpps, setExpandedOpps] = useState<Set<number>>(new Set())
  const [expandedActions, setExpandedActions] = useState<Set<number>>(new Set())
  const [expandedPositions, setExpandedPositions] = useState<Set<number>>(new Set())

  // ── Persisted result (loaded from repository on mount) ────────────────────
  const { data: repoEntry, isLoading: repoLoading } = useGetRepositoryEntry(
    "portfolio-analyzer",
    { query: { retry: false } }
  )
  const storedAnalysis = repoEntry?.result as PortfolioAnalysis | undefined

  // ── Update mutation ───────────────────────────────────────────────────────
  const {
    mutate: runAnalysis,
    data: mutationData,
    isPending,
    error: mutationError,
  } = useRunPortfolioAnalysis({
    mutation: {
      onSuccess: (data) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (data as any)?._debug
        if (d) setDebugInfo(d)
        setDebugError(null)
        setExpandedRisks(new Set())
        setExpandedOpps(new Set())
        setExpandedActions(new Set())
        setExpandedPositions(new Set())
      },
      onError: (err) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (err as any)?._debug
        if (d) setDebugInfo(d)
        setDebugError(err)
      },
    },
  })

  // Latest mutation result takes priority; fall back to stored
  const analysis = (mutationData ?? storedAnalysis) as PortfolioAnalysis | undefined
  const hasDebug = debugInfo !== null || debugError !== null

  // ── Loading skeleton (initial repository fetch only) ──────────────────────
  if (repoLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full animate-in fade-in duration-300" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  // ── Not updated yet ───────────────────────────────────────────────────────
  if (!analysis) {
    return (
      <div className="space-y-4 pb-8 animate-in fade-in duration-500">
        <div>
          <h1 className="text-base font-bold tracking-widest uppercase text-foreground">
            Portfolio Analyzer
          </h1>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            AI-powered portfolio assessment · 1–3 month horizon
          </p>
        </div>
        <Card className="bg-card/60 border-card-border/50">
          <CardContent className="p-8">
            <div className="flex flex-col items-center justify-center gap-3 text-center">
              <BarChart2 className="h-10 w-10 text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground/60 italic">No analysis yet</p>
              <p className="text-xs text-muted-foreground/40 max-w-sm leading-relaxed">
                Run an update to generate your first AI-powered portfolio assessment combining
                data from all available modules.
              </p>
              <Button
                size="sm"
                onClick={() => runAnalysis()}
                disabled={isPending}
                className="mt-2"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 mr-2 ${isPending ? "animate-spin" : ""}`}
                />
                {isPending ? "Analysing…" : "Update Analysis"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Analysis view ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-3 pb-8 animate-in fade-in slide-in-from-bottom-2 duration-500">

      {/* Inline update-failed banner — only shown when we still have data */}
      {mutationError && (
        <div className="flex items-center gap-2 text-xs text-destructive/80 bg-destructive/8 border border-destructive/20 rounded-md px-3 py-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>Update failed — showing last saved result.</span>
          {hasDebug && (
            <button
              onClick={() => setDebugOpen(true)}
              className="ml-auto text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              Details
            </button>
          )}
        </div>
      )}

      {/* ── Header card ── */}
      <Card
        className={`bg-card/60 overflow-hidden transition-colors duration-300 ${
          isPending ? "border-primary/30" : "border-card-border/50"
        }`}
      >
        {isPending && <div className="h-0.5 bg-primary/70 animate-pulse" />}
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-base font-bold tracking-widest uppercase text-foreground mb-2">
                Portfolio Analyzer
              </h1>
              <div className="flex items-center gap-2.5 flex-wrap">
                {/* Score */}
                <div className="flex items-baseline gap-1">
                  <span
                    className={`text-2xl font-bold font-mono tabular-nums leading-none ${scoreColor(
                      analysis.portfolioScore
                    )}`}
                  >
                    {analysis.portfolioScore}
                  </span>
                  <span className="text-[11px] text-muted-foreground/40">/100</span>
                </div>
                <Badge
                  variant={ratingBadgeVariant(analysis.overallRating)}
                  className="text-xs"
                >
                  {analysis.overallRating}
                </Badge>
                <Badge
                  variant={outlookBadgeVariant(analysis.overallOutlook)}
                  className="text-xs"
                >
                  {analysis.overallOutlook}
                </Badge>
                {/* Metadata */}
                {isPending ? (
                  <span className="flex items-center gap-1.5 text-[11px] text-primary/80 animate-pulse ml-1">
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    Analysing portfolio…
                  </span>
                ) : (
                  <div className="hidden sm:flex items-center gap-3 text-[11px] text-muted-foreground/50 ml-1">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {format(new Date(analysis.timestamp), "HH:mm 'UTC'")}
                    </span>
                    <span className="flex items-center gap-1">
                      <Timer className="h-3 w-3" />
                      {formatDuration(analysis.analysisDuration)}
                    </span>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                size="sm"
                variant="outline"
                onClick={() => runAnalysis()}
                disabled={isPending}
                className="h-8 text-xs font-medium"
              >
                <RefreshCw
                  className={`h-3 w-3 mr-1.5 ${isPending ? "animate-spin" : ""}`}
                />
                {isPending ? "Analysing…" : "Update Analysis"}
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
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Executive Summary ── */}
      <Card className="bg-card/40 border-card-border/40">
        <CardContent className="p-4">
          <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-2">
            Executive Summary
          </p>
          <p className="text-sm text-foreground/80 leading-relaxed">
            {analysis.executiveSummary}
          </p>
        </CardContent>
      </Card>

      {/* ── Strengths & Weaknesses ── */}
      {(analysis.strengths.length > 0 || analysis.weaknesses.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {analysis.strengths.length > 0 && (
            <Card className="bg-emerald-950/20 border-emerald-500/15">
              <CardHeader className="px-4 pt-4 pb-2">
                <CardTitle className="text-[11px] font-bold tracking-widest uppercase text-emerald-400/70 flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5" />
                  Strengths
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 pt-0">
                <ul className="space-y-2">
                  {analysis.strengths.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-foreground/80">
                      <span className="text-emerald-400/60 mt-0.5 shrink-0 font-bold">+</span>
                      {s}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {analysis.weaknesses.length > 0 && (
            <Card className="bg-rose-950/20 border-rose-500/15">
              <CardHeader className="px-4 pt-4 pb-2">
                <CardTitle className="text-[11px] font-bold tracking-widest uppercase text-rose-400/70 flex items-center gap-1.5">
                  <TrendingDown className="h-3.5 w-3.5" />
                  Weaknesses
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 pt-0">
                <ul className="space-y-2">
                  {analysis.weaknesses.map((w, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-foreground/80">
                      <span className="text-rose-400/60 mt-0.5 shrink-0 font-bold">−</span>
                      {w}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Top Risks ── */}
      {analysis.topRisks.length > 0 && (
        <Card className="bg-card/40 border-card-border/40">
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5" />
              Top Risks
              <span className="ml-auto text-muted-foreground/40 font-normal normal-case tracking-normal text-[10px]">
                {analysis.topRisks.length} risk{analysis.topRisks.length !== 1 ? "s" : ""}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border/40">
              {analysis.topRisks.map((risk, i) => (
                <li key={i} className="px-4 py-3">
                  <div className="flex items-start gap-2.5">
                    <Badge
                      variant={highMedLowBadgeVariant(risk.severity)}
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0 mt-0.5"
                    >
                      {risk.severity}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground/90 leading-snug">
                        {risk.title}
                      </p>
                      {risk.reason && (
                        <>
                          <button
                            className="flex items-center gap-1 text-[11px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors mt-1"
                            onClick={() =>
                              setExpandedRisks(toggleIdx(expandedRisks, i))
                            }
                          >
                            <ChevronRight
                              className={`h-3 w-3 transition-transform ${
                                expandedRisks.has(i) ? "rotate-90" : ""
                              }`}
                            />
                            {expandedRisks.has(i) ? "Collapse" : "Reasoning"}
                          </button>
                          {expandedRisks.has(i) && (
                            <p className="text-xs text-muted-foreground/70 mt-1 pl-4 border-l border-border/40 leading-snug animate-in fade-in duration-200">
                              {risk.reason}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* ── Top Opportunities ── */}
      {analysis.topOpportunities.length > 0 && (
        <Card className="bg-card/40 border-card-border/40">
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground flex items-center gap-1.5">
              <Lightbulb className="h-3.5 w-3.5" />
              Top Opportunities
              <span className="ml-auto text-muted-foreground/40 font-normal normal-case tracking-normal text-[10px]">
                {analysis.topOpportunities.length} opportunit
                {analysis.topOpportunities.length !== 1 ? "ies" : "y"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border/40">
              {analysis.topOpportunities.map((opp, i) => (
                <li key={i} className="px-4 py-3">
                  <div className="flex items-start gap-2.5">
                    <Badge
                      variant={highMedLowBadgeVariant(opp.confidence, true)}
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0 mt-0.5"
                    >
                      {opp.confidence}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground/90 leading-snug">
                        {opp.title}
                      </p>
                      {opp.reason && (
                        <>
                          <button
                            className="flex items-center gap-1 text-[11px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors mt-1"
                            onClick={() =>
                              setExpandedOpps(toggleIdx(expandedOpps, i))
                            }
                          >
                            <ChevronRight
                              className={`h-3 w-3 transition-transform ${
                                expandedOpps.has(i) ? "rotate-90" : ""
                              }`}
                            />
                            {expandedOpps.has(i) ? "Collapse" : "Reasoning"}
                          </button>
                          {expandedOpps.has(i) && (
                            <p className="text-xs text-muted-foreground/70 mt-1 pl-4 border-l border-border/40 leading-snug animate-in fade-in duration-200">
                              {opp.reason}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* ── Sector Assessment ── */}
      {analysis.sectorAssessment && (
        <Card className="bg-card/40 border-card-border/40">
          <CardContent className="p-4">
            <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-2">
              Sector Assessment
            </p>
            <p className="text-sm text-foreground/80 leading-relaxed">
              {analysis.sectorAssessment}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Position Comments ── */}
      {analysis.positionComments.length > 0 && (
        <Card className="bg-card/40 border-card-border/40">
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground flex items-center gap-1.5">
              <BarChart2 className="h-3.5 w-3.5" />
              Position Comments
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border/40">
              {analysis.positionComments.map((pos, i) => (
                <li key={i} className="px-4 py-3">
                  <div className="flex items-start gap-2.5">
                    <span className="text-xs font-bold font-mono text-primary/80 shrink-0 mt-0.5 w-16 truncate">
                      {pos.ticker}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1.5">
                        <Badge
                          variant={highMedLowBadgeVariant(pos.attention)}
                          className="text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0"
                        >
                          {pos.attention}
                        </Badge>
                      </div>
                      <button
                        className="text-left w-full"
                        onClick={() =>
                          setExpandedPositions(toggleIdx(expandedPositions, i))
                        }
                      >
                        <p
                          className={`text-sm text-foreground/80 leading-snug ${
                            !expandedPositions.has(i) ? "line-clamp-2" : ""
                          }`}
                        >
                          {pos.summary}
                        </p>
                        {pos.summary.length > 120 && (
                          <span className="flex items-center gap-1 text-[11px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors mt-1">
                            <ChevronRight
                              className={`h-3 w-3 transition-transform ${
                                expandedPositions.has(i) ? "rotate-90" : ""
                              }`}
                            />
                            {expandedPositions.has(i) ? "Collapse" : "Read more"}
                          </span>
                        )}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* ── Recommended Actions ── */}
      {analysis.recommendedActions.length > 0 && (
        <Card className="bg-card/40 border-card-border/40">
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground flex items-center gap-1.5">
              <Target className="h-3.5 w-3.5" />
              Recommended Actions
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border/40">
              {analysis.recommendedActions.map((action, i) => (
                <li key={i} className="px-4 py-3">
                  <div className="flex items-start gap-2.5">
                    <Badge
                      variant={highMedLowBadgeVariant(action.priority)}
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0 mt-0.5"
                    >
                      {action.priority}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground/90 leading-snug">
                        {action.action}
                      </p>
                      {action.reason && (
                        <>
                          <button
                            className="flex items-center gap-1 text-[11px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors mt-1"
                            onClick={() =>
                              setExpandedActions(toggleIdx(expandedActions, i))
                            }
                          >
                            <ChevronRight
                              className={`h-3 w-3 transition-transform ${
                                expandedActions.has(i) ? "rotate-90" : ""
                              }`}
                            />
                            {expandedActions.has(i) ? "Collapse" : "Reasoning"}
                          </button>
                          {expandedActions.has(i) && (
                            <p className="text-xs text-muted-foreground/70 mt-1 pl-4 border-l border-border/40 leading-snug animate-in fade-in duration-200">
                              {action.reason}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* ── Things To Watch ── */}
      {analysis.thingsToWatch.length > 0 && (
        <Card className="bg-card/40 border-card-border/40">
          <CardContent className="p-4">
            <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-3">
              Things To Watch
            </p>
            <ul className="space-y-2">
              {analysis.thingsToWatch.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-foreground/80">
                  <Eye className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0 mt-0.5" />
                  {item}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
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
                  copyText={inputMessages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n")}
                >
                  <div className="space-y-1.5 mb-3">
                    <DebugRow
                      label="API"
                      value={debugInfo.webSearchUsed ? "Responses API + web_search" : "Chat Completions"}
                    />
                    <DebugRow label="Model" value={String(debugInfo.request.model ?? "—")} />
                    <DebugRow label="Temperature" value={String(debugInfo.request.temperature ?? "—")} />
                    <DebugRow
                      label="Max tokens"
                      value={String(debugInfo.request.max_tokens ?? debugInfo.request.max_output_tokens ?? "—")}
                    />
                    <DebugRow label="Called at" value={debugInfo.calledAt} />
                  </div>
                  {inputMessages.map((m, i) => (
                    <div key={i} className="mb-2">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">
                        [{m.role}]
                      </p>
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
                    try {
                      return JSON.stringify(JSON.parse(debugInfo.rawResponse), null, 2)
                    } catch {
                      return debugInfo.rawResponse
                    }
                  })()}
                >
                  <div className="mb-3 flex flex-wrap gap-4 text-muted-foreground">
                    <span>
                      Web search:{" "}
                      <span className={debugInfo.webSearchUsed ? "text-emerald-400" : "text-rose-400"}>
                        {debugInfo.webSearchUsed ? "Yes ✓" : "No ✗"}
                      </span>
                    </span>
                    <span>
                      Prompt tokens:{" "}
                      <span className="text-foreground">{debugInfo.usage.prompt_tokens ?? "—"}</span>
                    </span>
                    <span>
                      Completion tokens:{" "}
                      <span className="text-foreground">{debugInfo.usage.completion_tokens ?? "—"}</span>
                    </span>
                    <span>
                      Total:{" "}
                      <span className="text-foreground">{debugInfo.usage.total_tokens ?? "—"}</span>
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap text-emerald-300/90 bg-background/60 rounded p-2 border border-emerald-500/20 break-all">
                    {(() => {
                      try {
                        return JSON.stringify(JSON.parse(debugInfo.rawResponse), null, 2)
                      } catch {
                        return debugInfo.rawResponse
                      }
                    })()}
                  </pre>
                </DebugSection>
              </>
            ) : (
              <p className="text-muted-foreground">
                No debug data available yet. Run an analysis first.
              </p>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

function DebugSection({
  label,
  color,
  copyText,
  children,
}: {
  label: string
  color: string
  copyText?: string
  children: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    if (!copyText) return
    navigator.clipboard.writeText(copyText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }
  const border =
    color === "blue"
      ? "border-blue-500/30"
      : color === "emerald"
      ? "border-emerald-500/30"
      : "border-rose-500/30"
  const text =
    color === "blue"
      ? "text-blue-400"
      : color === "emerald"
      ? "text-emerald-400"
      : "text-rose-400"
  return (
    <div className={`border ${border} rounded p-3`}>
      <div className="flex items-center justify-between mb-2">
        <p className={`text-[10px] font-bold uppercase tracking-widest ${text}`}>{label}</p>
        {copyText && (
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-white/5"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-emerald-400" />
                <span className="text-emerald-400">Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                <span>Copy</span>
              </>
            )}
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
