/**
 * Opportunity Finder Page
 *
 * Identifies the best investment opportunities for a 1–3 month horizon that
 * complement and strengthen the existing portfolio. Ranked and scored across
 * five dimensions. Includes source evidence and candidate history tracking.
 */
import { useState } from "react"
import { useLocation } from "wouter"
import { useRunOpportunityAnalysis, useGetRepositoryEntry } from "@workspace/api-client-react"
import type { OpportunityAnalysis, OpportunityFinderOpportunity } from "@workspace/api-client-react"
import {
  AlertCircle,
  RefreshCw,
  Info,
  ChevronRight,
  Clock,
  Timer,
  Lightbulb,
  Search,
  TrendingUp,
  ExternalLink,
  Copy,
  Check,
  ArrowUpRight,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
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
  webSearchUsed: boolean
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  calledAt: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "positive" | "warning" | "negative"

function levelBadgeVariant(level: string): BadgeVariant {
  if (level === "High") return "positive"
  if (level === "Medium") return "warning"
  return "outline"
}

function priorityBadgeVariant(p: string): BadgeVariant {
  if (p === "High") return "negative"
  if (p === "Medium") return "warning"
  return "outline"
}

function confidenceBadgeVariant(c: string): BadgeVariant {
  if (c === "High") return "positive"
  if (c === "Medium") return "warning"
  return "outline"
}

function scoreColor(score: number): string {
  if (score >= 75) return "text-emerald-400"
  if (score >= 55) return "text-blue-400"
  if (score >= 35) return "text-amber-400"
  return "text-rose-400"
}

function statusBadgeClass(status: string | undefined): string {
  switch (status) {
    case "New": return "bg-primary/15 text-primary"
    case "Up": return "bg-emerald-500/15 text-emerald-400"
    case "Down": return "bg-rose-500/15 text-rose-400"
    case "Unchanged": return "bg-muted/30 text-muted-foreground/60"
    default: return "hidden"
  }
}

function statusLabel(status: string | undefined): string {
  switch (status) {
    case "Up": return "↑ Up"
    case "Down": return "↓ Down"
    default: return status ?? ""
  }
}

// ---------------------------------------------------------------------------
// Score dots visualisation
// ---------------------------------------------------------------------------

function ScoreDots({ value, max = 5 }: { value: number; max?: number }) {
  return (
    <span className="flex items-center gap-0.5">
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          className={`h-1.5 w-1.5 rounded-full ${i < value ? "bg-primary/70" : "bg-muted/30"}`}
        />
      ))}
    </span>
  )
}

function ScoreRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] text-muted-foreground/60 min-w-0">{label}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        <ScoreDots value={value} />
        <span className="text-[11px] font-mono text-foreground/50 w-3 text-right">{value}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Opportunity Card
// ---------------------------------------------------------------------------

function OpportunityCard({ opp }: { opp: OpportunityFinderOpportunity }) {
  const [, navigate] = useLocation()
  const [expanded, setExpanded] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)

  return (
    <Card className="bg-card/40 border-card-border/40 overflow-hidden">
      <CardContent className="p-0">
        {/* ── Collapsed header ── */}
        <button
          className="w-full text-left p-4 hover:bg-white/[0.02] transition-colors"
          onClick={() => setExpanded((v) => !v)}
        >
          <div className="flex items-start gap-3">
            {/* Rank */}
            <div className="shrink-0 mt-0.5">
              <span className="text-[11px] font-mono font-bold text-muted-foreground/40">
                #{opp.rank}
              </span>
            </div>

            {/* Main info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                {opp.status && opp.status !== "Unchanged" && (
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${statusBadgeClass(opp.status)}`}>
                    {statusLabel(opp.status)}
                  </span>
                )}
                <span className="text-sm font-bold text-foreground">{opp.company}</span>
                <span className="text-[11px] font-mono text-muted-foreground/50 bg-muted/20 px-1.5 py-0.5 rounded">
                  {opp.ticker}
                </span>
                {opp.exchange && (
                  <span className="text-[10px] text-muted-foreground/40">{opp.exchange}</span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground/50">
                <span>{opp.sector}</span>
                <span className="text-muted-foreground/30">·</span>
                <span>{opp.country}</span>
              </div>
            </div>

            {/* Score + badges */}
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <span className={`text-lg font-bold font-mono tabular-nums leading-none ${scoreColor(opp.overallScore)}`}>
                {opp.overallScore}
              </span>
              <div className="flex items-center gap-1">
                <Badge variant={priorityBadgeVariant(opp.priority)} className="text-[10px] px-1.5">
                  {opp.priority}
                </Badge>
                <Badge variant={confidenceBadgeVariant(opp.confidence)} className="text-[10px] px-1.5">
                  {opp.confidence}
                </Badge>
                <ChevronRight
                  className={`h-3.5 w-3.5 text-muted-foreground/30 transition-transform duration-150 ml-0.5 ${
                    expanded ? "rotate-90" : ""
                  }`}
                />
              </div>
            </div>
          </div>
        </button>

        {/* ── Expanded detail ── */}
        {expanded && (
          <div className="border-t border-border/20 px-4 pb-4 pt-3 space-y-4">

            {/* Score breakdown */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-2">
                Component Scores
              </p>
              <div className="space-y-1.5">
                <ScoreRow label="Portfolio fit" value={opp.portfolioFit} />
                <ScoreRow label="Diversification" value={opp.diversificationBenefit} />
                <ScoreRow label="Sector / macro fit" value={opp.sectorMacroFit} />
                <ScoreRow label="Timing" value={opp.timing} />
                <ScoreRow label="Risk / reward" value={opp.riskReward} />
              </div>
              {opp.scoreReason && (
                <p className="text-[11px] text-muted-foreground/55 mt-2 leading-relaxed italic">
                  {opp.scoreReason}
                </p>
              )}
            </div>

            {/* Investment thesis */}
            {opp.investmentThesis.length > 0 && (
              <BulletSection label="Investment Thesis" items={opp.investmentThesis} accent />
            )}

            {/* Why now */}
            {opp.whyNow.length > 0 && (
              <BulletSection label="Why Now" items={opp.whyNow} />
            )}

            {/* Why this portfolio */}
            {opp.whyThisPortfolio.length > 0 && (
              <BulletSection label="Why This Portfolio" items={opp.whyThisPortfolio} />
            )}

            {/* Catalyst + date / Main Risk */}
            <div className={`grid gap-3 ${opp.mainCatalyst ? "grid-cols-2" : "grid-cols-1"}`}>
              {opp.mainCatalyst && (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                    Main Catalyst
                  </p>
                  <p className="text-xs text-foreground/80 leading-relaxed">{opp.mainCatalyst}</p>
                  {opp.catalystDate && (
                    <p className="text-[11px] text-primary/60 mt-0.5 font-mono">{opp.catalystDate}</p>
                  )}
                </div>
              )}
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                  Main Risk
                </p>
                <p className="text-xs text-foreground/70 leading-relaxed">{opp.mainRisk}</p>
              </div>
            </div>

            {/* Position size */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                Position Size Indication
              </p>
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-semibold text-foreground/80">
                  {opp.positionSizeSuitability}
                </span>
                <span className="text-[11px] text-muted-foreground/55 leading-relaxed">
                  — {opp.positionSizeReason}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground/35 mt-0.5 italic">
                Indication only — not a buy instruction.
              </p>
            </div>

            {/* Sources */}
            {opp.sources.length > 0 && (
              <div>
                <button
                  onClick={() => setSourcesOpen((v) => !v)}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground/60 hover:text-foreground transition-colors"
                >
                  <ChevronRight
                    className={`h-3 w-3 transition-transform duration-150 ${sourcesOpen ? "rotate-90" : ""}`}
                  />
                  Sources ({opp.sources.length})
                </button>
                {sourcesOpen && (
                  <ul className="mt-2 space-y-1.5">
                    {opp.sources.map((src, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-[11px]">
                        <ExternalLink className="h-3 w-3 text-muted-foreground/30 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <a
                            href={src.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary/70 hover:text-primary underline underline-offset-2 break-all"
                          >
                            {src.title}
                          </a>
                          {src.published && (
                            <span className="text-muted-foreground/40 ml-1.5">{src.published}</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Company analysis status */}
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/15">
              {opp.companyAnalysisAvailable ? (
                <p className="text-[11px] text-emerald-400/80 flex items-center gap-1">
                  <Check className="h-3 w-3" />
                  Company analysis available
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground/50 flex items-center gap-1">
                  <Info className="h-3 w-3" />
                  No saved company analysis
                </p>
              )}
              {!opp.companyAnalysisAvailable && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px] gap-1"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/companies?ticker=${encodeURIComponent(opp.ticker)}`)
                  }}
                >
                  Analyze company
                  <ArrowUpRight className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function BulletSection({ label, items, accent }: { label: string; items: string[]; accent?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1.5">
        {label}
      </p>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <span className="text-muted-foreground/30 shrink-0 mt-0.5 text-xs">•</span>
            <span className={`text-xs leading-relaxed ${accent ? "text-foreground/85" : "text-foreground/70"}`}>
              {item}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function OpportunityFinder() {
  const [debugInfo, setDebugInfo] = useState<AiDebugInfo | null>(null)
  const [debugError, setDebugError] = useState<unknown>(null)
  const [debugOpen, setDebugOpen] = useState(false)

  // ── Persisted result ──────────────────────────────────────────────────────
  const { data: repoEntry, isLoading: repoLoading } = useGetRepositoryEntry(
    "opportunity-finder",
    { query: { retry: false } }
  )
  const storedAnalysis = repoEntry?.result as OpportunityAnalysis | undefined

  // ── Update mutation ───────────────────────────────────────────────────────
  const {
    mutate: runAnalysis,
    data: mutationData,
    isPending,
    error: mutationError,
  } = useRunOpportunityAnalysis({
    mutation: {
      onSuccess: (data) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (data as any)?._debug
        if (d) setDebugInfo(d)
        setDebugError(null)
      },
      onError: (err) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (err as any)?._debug
        if (d) setDebugInfo(d)
        setDebugError(err)
      },
    },
  })

  const analysis = (mutationData ?? storedAnalysis) as OpportunityAnalysis | undefined
  const hasDebug = debugInfo !== null || debugError !== null

  // ── Loading skeleton ──────────────────────────────────────────────────────
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
          <h1 className="text-base font-bold tracking-widest uppercase text-foreground mb-1">
            Opportunity Finder
          </h1>
          <p className="text-xs text-muted-foreground/60">
            Identifies and ranks investment opportunities that complement your portfolio for the next 1–3 months.
          </p>
        </div>
        <Card className="bg-card/40 border-card-border/40">
          <CardContent className="p-6 flex flex-col items-center text-center gap-3">
            <Lightbulb className="h-8 w-8 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground/60">
              No analysis yet. Run the opportunity finder to identify ranked candidates with evidence and scoring.
            </p>
            <Button size="sm" onClick={() => runAnalysis()} disabled={isPending} className="mt-2">
              <RefreshCw className={`h-3.5 w-3.5 mr-2 ${isPending ? "animate-spin" : ""}`} />
              {isPending ? "Analysing…" : "Find Opportunities"}
            </Button>
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
      <Card className={`bg-card/60 overflow-hidden transition-colors duration-300 ${isPending ? "border-primary/30" : "border-card-border/50"}`}>
        {isPending && <div className="h-0.5 bg-primary/70 animate-pulse" />}
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-base font-bold tracking-widest uppercase text-foreground mb-2">
                Opportunity Finder
              </h1>
              <div className="flex items-center gap-2.5 flex-wrap">
                <Badge variant={levelBadgeVariant(analysis.overallOpportunityLevel)} className="text-xs">
                  {analysis.overallOpportunityLevel} opportunity level
                </Badge>
                {isPending ? (
                  <span className="flex items-center gap-1.5 text-[11px] text-primary/80 animate-pulse ml-1">
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    Searching for opportunities…
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
                <RefreshCw className={`h-3 w-3 mr-1.5 ${isPending ? "animate-spin" : ""}`} />
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
          <p className="text-xs text-foreground/80 leading-relaxed">{analysis.executiveSummary}</p>
        </CardContent>
      </Card>

      {/* ── Badge legend ── */}
      {analysis.topOpportunities.length > 0 && (
        <div className="flex items-center gap-3 px-1 text-[10px] text-muted-foreground/40">
          <span className="font-bold uppercase tracking-widest">Top Opportunities</span>
          <span className="flex items-center gap-1">
            score <span className="font-mono">0–100</span>
          </span>
          <span>Priority badge</span>
          <span>Confidence badge</span>
          <span className="ml-auto italic">click card to expand</span>
        </div>
      )}

      {/* ── Opportunity cards ── */}
      {analysis.topOpportunities.map((opp) => (
        <OpportunityCard key={opp.ticker} opp={opp} />
      ))}

      {/* ── Sector Ideas ── */}
      {analysis.sectorIdeas.length > 0 && (
        <Card className="bg-card/40 border-card-border/40">
          <CardContent className="p-4">
            <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-3">
              Sector Ideas
            </p>
            <div className="space-y-2.5">
              {analysis.sectorIdeas.map((idea, i) => (
                <div key={i} className="flex items-start gap-2">
                  <TrendingUp className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0 mt-0.5" />
                  <div>
                    <span className="text-xs font-semibold text-foreground/80">{idea.sector}</span>
                    <span className="text-xs text-muted-foreground/55"> — {idea.reason}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Things To Research ── */}
      {analysis.thingsToResearch.length > 0 && (
        <Card className="bg-card/40 border-card-border/40">
          <CardContent className="p-4">
            <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-3">
              Things To Research
            </p>
            <ul className="space-y-2">
              {analysis.thingsToResearch.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <Search className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0 mt-0.5" />
                  <span className="text-xs text-foreground/75">{item}</span>
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

// ---------------------------------------------------------------------------
// Debug Dialog (identical pattern to all other modules)
// ---------------------------------------------------------------------------

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
                    <DebugRow label="API" value={debugInfo.webSearchUsed ? "Responses API + web_search" : "Chat Completions"} />
                    <DebugRow label="Model" value={String(debugInfo.request.model ?? "—")} />
                    <DebugRow label="Temperature" value={String(debugInfo.request.temperature ?? "—")} />
                    <DebugRow label="Max tokens" value={String(debugInfo.request.max_tokens ?? debugInfo.request.max_output_tokens ?? "—")} />
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
                    <span>Web search: <span className={debugInfo.webSearchUsed ? "text-emerald-400" : "text-rose-400"}>{debugInfo.webSearchUsed ? "Yes ✓" : "No ✗"}</span></span>
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

function DebugSection({ label, color, copyText, children }: {
  label: string; color: string; copyText?: string; children: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const border = color === "blue" ? "border-blue-500/30" : color === "emerald" ? "border-emerald-500/30" : "border-rose-500/30"
  const text = color === "blue" ? "text-blue-400" : color === "emerald" ? "text-emerald-400" : "text-rose-400"
  return (
    <div className={`border ${border} rounded p-3`}>
      <div className="flex items-center justify-between mb-2">
        <p className={`text-[10px] font-bold uppercase tracking-widest ${text}`}>{label}</p>
        {copyText && (
          <button
            onClick={() => { navigator.clipboard.writeText(copyText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800) }) }}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-white/5"
          >
            {copied ? <><Check className="h-3 w-3 text-emerald-400" /><span className="text-emerald-400">Copied</span></> : <><Copy className="h-3 w-3" /><span>Copy</span></>}
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
