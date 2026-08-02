/**
 * Trade Decision Engine – Phase 1
 *
 * Converts stored portfolio analyses into cautious, transparent decision proposals.
 * Phase 1 NEVER places, modifies or cancels orders.
 */
import { useState } from "react"
import {
  useRunTradeDecisionEngine,
  useGetRepositoryEntry,
} from "@workspace/api-client-react"
import type {
  TradeDecisionEngineAnalysis,
  TradeDecision,
  TradeDecisionType,
  TradeDecisionPosture,
  TradeDecisionConfidence,
  TradeDecisionUrgency,
  TradeDecisionStatus,
  TradeDecisionReadiness,
} from "@workspace/api-client-react"
import {
  RefreshCw,
  Info,
  ChevronRight,
  ChevronDown,
  Clock,
  Timer,
  GitMerge,
  AlertTriangle,
  ShieldOff,
  CheckCircle2,
  Circle,
  Copy,
  Check,
  CalendarClock,
  Layers,
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

interface AiDebugInfo {
  request?: Record<string, unknown>
  rawResponse?: string
  webSearchUsed?: boolean
  usage?: { prompt_tokens?: number | null; completion_tokens?: number | null; total_tokens?: number | null }
  calledAt?: string
  /** Which stage failed — request | timeout | response | web-search-validation | json-parse */
  errorStage?: string
  webSearchDetection?: {
    outputItemTypes: string[]
    webSearchCallFound: boolean
    citationAnnotationCount: number
    extractedSourceCount: number
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "positive" | "warning" | "negative"

function decisionVariant(d: TradeDecisionType): BadgeVariant {
  if (d === "Hold")            return "default"
  if (d === "Review")          return "warning"
  if (d === "WaitForEvent")    return "warning"
  if (d === "NoAction")        return "secondary"
  // PrepareToBuy / PrepareToReduce use custom className instead
  return "outline"
}

function decisionClassName(d: TradeDecisionType): string {
  if (d === "PrepareToBuy")    return "border-emerald-500/60 text-emerald-400 bg-emerald-950/30"
  if (d === "PrepareToReduce") return "border-rose-500/60   text-rose-400   bg-rose-950/30"
  return ""
}

function decisionLabel(d: TradeDecisionType): string {
  if (d === "WaitForEvent")    return "Wait for Event"
  if (d === "PrepareToBuy")    return "Prepare to Buy"
  if (d === "PrepareToReduce") return "Prepare to Reduce"
  if (d === "NoAction")        return "No Action"
  return d
}

function postureVariant(p: TradeDecisionPosture): BadgeVariant {
  if (p === "ActivelyReview")             return "warning"
  if (p === "SelectivePreparation")       return "default"
  if (p === "MaintainCurrentPositioning") return "positive"
  return "secondary"
}

function postureLabel(p: TradeDecisionPosture): string {
  if (p === "ActivelyReview")             return "Actively Review"
  if (p === "SelectivePreparation")       return "Selective Preparation"
  if (p === "WaitForEvents")              return "Wait for Events"
  if (p === "MaintainCurrentPositioning") return "Maintain Positioning"
  if (p === "InsufficientEvidence")       return "Insufficient Evidence"
  return p
}

function confidenceVariant(c: TradeDecisionConfidence): BadgeVariant {
  if (c === "High")   return "positive"
  if (c === "Medium") return "warning"
  return "secondary"
}

function urgencyVariant(u: TradeDecisionUrgency): BadgeVariant {
  if (u === "Immediate") return "negative"
  if (u === "Days")      return "warning"
  return "secondary"
}

function urgencyLabel(u: TradeDecisionUrgency): string {
  if (u === "NoUrgency") return "No Urgency"
  return u
}

function statusVariant(s: TradeDecisionStatus): BadgeVariant {
  if (s === "New")     return "warning"
  if (s === "Changed") return "default"
  if (s === "Resolved") return "positive"
  return "secondary"
}

function readinessColor(score: number): string {
  if (score >= 70) return "text-emerald-400"
  if (score >= 40) return "text-amber-400"
  return "text-rose-400"
}

// ---------------------------------------------------------------------------
// Decision Card
// ---------------------------------------------------------------------------

function DecisionCard({ decision }: { decision: TradeDecision }) {
  const [expanded, setExpanded] = useState(false)

  const label   = decisionLabel(decision.decision)
  const variant = decisionVariant(decision.decision)
  const cls     = decisionClassName(decision.decision)

  return (
    <Card className="bg-card/40 border-card-border/40 overflow-hidden">
      <CardContent className="p-0">
        {/* Collapsed header */}
        <button
          className="w-full text-left p-4 hover:bg-white/[0.02] transition-colors"
          onClick={() => setExpanded((v) => !v)}
        >
          <div className="flex items-start gap-3">
            {/* Rank */}
            <span className="text-[11px] font-mono text-muted-foreground/40 shrink-0 w-5 mt-0.5 select-none">
              {decision.rank}.
            </span>

            <div className="flex-1 min-w-0">
              {/* Title row */}
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <Badge
                  variant={variant}
                  className={`text-[10px] px-1.5 ${cls}`}
                >
                  {label}
                </Badge>
                {decision.status && (
                  <Badge variant={statusVariant(decision.status)} className="text-[10px] px-1.5">
                    {decision.status}
                  </Badge>
                )}
                {decision.readiness === "WaitingForReevaluation" && (
                  <Badge variant="warning" className="text-[10px] px-1.5 flex items-center gap-1">
                    <CalendarClock className="h-2.5 w-2.5" />
                    Waiting for re-evaluation
                  </Badge>
                )}
                {decision.readiness === "ReadyForReview" && (
                  <Badge variant="positive" className="text-[10px] px-1.5 flex items-center gap-1">
                    <CheckCircle2 className="h-2.5 w-2.5" />
                    Ready for review
                  </Badge>
                )}
              </div>

              {/* Subject */}
              <p className="text-sm font-semibold text-foreground leading-snug mb-1">
                {decision.title}
              </p>
              {/* Readiness reason — shown only for waiting decisions in collapsed view */}
              {decision.readiness === "WaitingForReevaluation" && decision.readinessReason && (
                <p className="text-[11px] text-amber-400/70 leading-snug mb-1.5">
                  {decision.readinessReason}
                </p>
              )}

              {/* Meta row */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {(decision.ticker || decision.company) && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 font-mono">
                    {decision.ticker || decision.company}
                  </Badge>
                )}
                <Badge variant="secondary" className="text-[10px] px-1.5">
                  {decision.subjectType}
                </Badge>
                <Badge variant={confidenceVariant(decision.confidence)} className="text-[10px] px-1.5">
                  {decision.confidence} confidence
                </Badge>
                <Badge variant={urgencyVariant(decision.urgency)} className="text-[10px] px-1.5">
                  {urgencyLabel(decision.urgency)}
                </Badge>
              </div>
            </div>

            <ChevronRight
              className={`h-3.5 w-3.5 text-muted-foreground/30 shrink-0 mt-1 transition-transform duration-150 ${
                expanded ? "rotate-90" : ""
              }`}
            />
          </div>
        </button>

        {/* Expanded detail */}
        {expanded && (
          <div className="border-t border-border/20 px-4 pb-4 pt-3 space-y-3">

            {/* Reason */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">Reason</p>
              <p className="text-xs text-foreground/80 leading-relaxed">{decision.reason}</p>
            </div>

            {/* Supporting evidence */}
            {decision.supportingEvidence.length > 0 && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                  Supporting Evidence
                </p>
                <ul className="space-y-1">
                  {decision.supportingEvidence.map((e, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <CheckCircle2 className="h-3 w-3 text-emerald-500/60 shrink-0 mt-0.5" />
                      <span className="text-xs text-foreground/75 leading-relaxed">{e}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Opposing evidence */}
            {decision.opposingEvidence.length > 0 && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                  Opposing Evidence
                </p>
                <ul className="space-y-1">
                  {decision.opposingEvidence.map((e, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <AlertTriangle className="h-3 w-3 text-amber-500/60 shrink-0 mt-0.5" />
                      <span className="text-xs text-foreground/75 leading-relaxed">{e}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Portfolio impact */}
            {decision.portfolioImpact && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                  Portfolio Impact
                </p>
                <p className="text-xs text-foreground/75 leading-relaxed">{decision.portfolioImpact}</p>
              </div>
            )}

            {/* Account considerations */}
            {decision.accountConsiderations && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                  Account Considerations
                </p>
                <p className="text-xs text-foreground/75 leading-relaxed">{decision.accountConsiderations}</p>
              </div>
            )}

            {/* Blocking event */}
            {decision.blockedByEvent && decision.blockingEvent && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                  Blocking Event
                </p>
                <p className="text-xs text-amber-400/80 leading-relaxed">
                  {decision.blockingEvent}
                  {decision.blockingEventDate && (
                    <span className="text-muted-foreground/50 ml-1">({decision.blockingEventDate})</span>
                  )}
                </p>
              </div>
            )}

            {/* What would change */}
            {decision.whatWouldChangeDecision.length > 0 && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                  What Would Change This Decision
                </p>
                <ul className="space-y-1">
                  {decision.whatWouldChangeDecision.map((w, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <Circle className="h-2.5 w-2.5 text-muted-foreground/30 shrink-0 mt-1" />
                      <span className="text-xs text-foreground/75 leading-relaxed">{w}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Missing evidence */}
            {decision.missingEvidence.length > 0 && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                  Missing Evidence
                </p>
                <ul className="space-y-1">
                  {decision.missingEvidence.map((m, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <ShieldOff className="h-3 w-3 text-muted-foreground/30 shrink-0 mt-0.5" />
                      <span className="text-xs text-muted-foreground/60 leading-relaxed">{m}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Source modules */}
            {decision.sourceModules.length > 0 && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1.5">
                  Source Modules
                </p>
                <div className="flex flex-wrap gap-1">
                  {decision.sourceModules.map((m, i) => (
                    <Badge key={i} variant="outline" className="text-[10px] px-1.5">
                      {m}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Readiness Drivers (collapsible)
// ---------------------------------------------------------------------------

function ReadinessDrivers({
  drivers,
  score,
}: {
  drivers: TradeDecisionEngineAnalysis["readinessDrivers"]
  score: number
}) {
  const [open, setOpen] = useState(false)

  return (
    <Card className="bg-card/40 border-card-border/40">
      <CardContent className="p-0">
        <button
          className="w-full flex items-center justify-between p-4 hover:bg-white/[0.02] transition-colors"
          onClick={() => setOpen((v) => !v)}
        >
          <div className="flex items-center gap-2.5">
            <Layers className="h-3.5 w-3.5 text-muted-foreground/40" />
            <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              Decision Readiness Drivers
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-mono font-bold ${readinessColor(score)}`}>
              {score}/100
            </span>
            <ChevronDown
              className={`h-3.5 w-3.5 text-muted-foreground/30 transition-transform duration-150 ${
                open ? "rotate-180" : ""
              }`}
            />
          </div>
        </button>

        {open && (
          <div className="border-t border-border/20 px-4 pb-4 pt-2 space-y-2">
            {drivers.map((d, i) => (
              <div key={i} className="flex items-start gap-3">
                <span
                  className={`text-[10px] font-bold shrink-0 mt-0.5 ${
                    d.impact === "Positive" ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {d.impact === "Positive" ? "+" : "–"}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-foreground/90 leading-snug">{d.factor}</p>
                  <p className="text-xs text-muted-foreground/60 leading-relaxed mt-0.5">{d.reason}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function TradeDecisionEngine() {
  const [debugInfo, setDebugInfo] = useState<AiDebugInfo | null>(null)
  const [debugError, setDebugError] = useState<unknown>(null)
  const [debugOpen, setDebugOpen] = useState(false)

  const { data: repoEntry, isLoading: repoLoading } = useGetRepositoryEntry(
    "trade-decision-engine",
    { query: { retry: false } }
  )
  const storedAnalysis = repoEntry?.result as TradeDecisionEngineAnalysis | undefined

  const {
    mutate: runDecisions,
    data: mutationData,
    isPending,
    error: mutationError,
  } = useRunTradeDecisionEngine({
    mutation: {
      onSuccess: (data) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (data as any)?._debug
        if (d) setDebugInfo(d)
        setDebugError(null)
      },
      onError: (err) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (err as any)?.data?._debug ?? (err as any)?._debug
        if (d) setDebugInfo(d)
        setDebugError(err)
      },
    },
  })

  const analysis = (mutationData ?? storedAnalysis) as TradeDecisionEngineAnalysis | undefined
  const hasDebug = debugInfo !== null || debugError !== null

  const handleRun = () => {
    setDebugError(null)
    runDecisions()
  }

  // ── Loading skeleton ────────────────────────────────────────────────────────
  if (repoLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-28 w-full animate-in fade-in duration-300" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }

  // ── Not run yet ─────────────────────────────────────────────────────────────
  if (!analysis) {
    return (
      <div className="space-y-4 pb-8 animate-in fade-in duration-500">
        <div>
          <h1 className="text-base font-bold tracking-widest uppercase text-foreground mb-1">
            Trade Decision Engine
          </h1>
          <p className="text-xs text-muted-foreground/60">
            Converts portfolio analyses into cautious, transparent decision proposals.
          </p>
        </div>

        {/* Error banner */}
        {mutationError && (
          <div className="flex items-center gap-2 text-xs text-destructive/80 bg-destructive/8 border border-destructive/20 rounded-md px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>Analysis failed. No result was saved.</span>
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

        {/* Safety notice */}
        <Card className="bg-amber-950/20 border-amber-600/20">
          <CardContent className="p-3 flex items-center gap-2.5">
            <ShieldOff className="h-3.5 w-3.5 text-amber-400/70 shrink-0" />
            <p className="text-[11px] text-amber-300/70">
              Decision proposals only. No trades are created or submitted.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card/40 border-card-border/40">
          <CardContent className="p-6 flex flex-col items-center text-center gap-3">
            <GitMerge className="h-8 w-8 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground/60">
              No analysis yet. Run the Decision Engine to generate decision proposals from your portfolio analyses.
            </p>
            <div className="flex items-center gap-2 mt-2">
              <Button
                size="sm"
                onClick={handleRun}
                disabled={isPending}
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-2 ${isPending ? "animate-spin" : ""}`} />
                {isPending ? "Analysing…" : "Generate Decisions"}
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
          </CardContent>
        </Card>

        <DebugDialog
          open={debugOpen}
          onClose={() => setDebugOpen(false)}
          debugInfo={debugInfo}
          error={debugError}
        />
      </div>
    )
  }

  // ── Analysis view ───────────────────────────────────────────────────────────
  return (
    <div className="space-y-3 pb-8 animate-in fade-in slide-in-from-bottom-2 duration-500">

      {/* Error banner */}
      {mutationError && (
        <div className="flex items-center gap-2 text-xs text-destructive/80 bg-destructive/8 border border-destructive/20 rounded-md px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
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

      {/* Safety notice (always visible) */}
      <Card className="bg-amber-950/20 border-amber-600/20">
        <CardContent className="p-2.5 flex items-center gap-2.5">
          <ShieldOff className="h-3.5 w-3.5 text-amber-400/70 shrink-0" />
          <p className="text-[11px] text-amber-300/70">
            Decision proposals only. No trades are created or submitted.
          </p>
        </CardContent>
      </Card>

      {/* ── Header card ── */}
      <Card
        className={`bg-card/60 overflow-hidden transition-colors duration-300 ${
          isPending ? "border-primary/30" : "border-card-border/50"
        }`}
      >
        {isPending && <div className="h-0.5 bg-primary/70 animate-pulse" />}
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-bold tracking-widest uppercase text-foreground mb-2">
                Trade Decision Engine
              </h1>

              {/* Badge row */}
              <div className="flex items-center gap-2.5 flex-wrap">
                <Badge
                  variant={postureVariant(analysis.overallDecisionPosture)}
                  className="text-xs"
                >
                  {postureLabel(analysis.overallDecisionPosture)}
                </Badge>

                <span
                  className={`text-xs font-mono font-bold tabular-nums ${readinessColor(
                    analysis.decisionReadinessScore
                  )}`}
                  title="Decision readiness score (0–100)"
                >
                  {analysis.decisionReadinessScore}/100
                </span>

                {isPending ? (
                  <span className="flex items-center gap-1.5 text-[11px] text-primary/80 animate-pulse ml-1">
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    Generating decisions…
                  </span>
                ) : (
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground/50 ml-1">
                    <span className="flex items-center gap-1 whitespace-nowrap">
                      <Clock className="h-3 w-3 shrink-0" />
                      {format(new Date(analysis.timestamp), "d. MMM HH:mm")}
                    </span>
                    <span className="flex items-center gap-1 whitespace-nowrap">
                      <Timer className="h-3 w-3 shrink-0" />
                      {formatDuration(analysis.analysisDuration)}
                    </span>
                  </div>
                )}
              </div>

              {/* Main conclusion */}
              {analysis.mainConclusion.title && (
                <p className="text-sm font-semibold text-foreground mt-3 leading-snug">
                  {analysis.mainConclusion.title}
                </p>
              )}
              {analysis.mainConclusion.reason && (
                <p className="text-xs text-muted-foreground/70 mt-1 leading-relaxed">
                  {analysis.mainConclusion.reason}
                </p>
              )}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <Button
                size="sm"
                variant="outline"
                onClick={handleRun}
                disabled={isPending}
                className="h-8 text-xs font-medium"
              >
                <RefreshCw className={`h-3 w-3 mr-1.5 ${isPending ? "animate-spin" : ""}`} />
                {isPending ? "Analysing…" : "Update"}
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

      {/* ── Executive summary ── */}
      <Card className="bg-card/40 border-card-border/40">
        <CardContent className="p-4">
          <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-2">
            Executive Summary
          </p>
          <p className="text-xs text-foreground/80 leading-relaxed">{analysis.executiveSummary}</p>
        </CardContent>
      </Card>

      {/* ── Readiness drivers ── */}
      <ReadinessDrivers
        drivers={analysis.readinessDrivers}
        score={analysis.decisionReadinessScore}
      />

      {/* ── Decision cards ── */}
      {analysis.decisions.length > 0 && (
        <>
          <div className="flex items-center gap-2 px-1 text-[10px] text-muted-foreground/40">
            <span className="font-bold uppercase tracking-widest">
              Decisions ({analysis.decisions.length})
            </span>
            <span className="ml-auto italic">click to expand</span>
          </div>
          {analysis.decisions.map((d, i) => (
            <DecisionCard key={i} decision={d} />
          ))}
        </>
      )}

      {/* ── Conflicts resolved ── */}
      {analysis.conflictsResolved && analysis.conflictsResolved.length > 0 && (
        <Card className="bg-card/40 border-card-border/40">
          <CardContent className="p-4">
            <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-3">
              Conflicts Resolved ({analysis.conflictsResolved.length})
            </p>
            <div className="space-y-3">
              {analysis.conflictsResolved.map((c, i) => (
                <div key={i} className="border-l-2 border-border/30 pl-3 space-y-1">
                  <p className="text-xs font-semibold text-foreground/90">{c.topic}</p>
                  <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
                    <span className="text-amber-400/70">Conflict: </span>{c.conflict}
                  </p>
                  <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
                    <span className="text-emerald-400/70">Resolution: </span>{c.resolution}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Next review triggers ── */}
      {analysis.nextReviewTriggers && analysis.nextReviewTriggers.length > 0 && (
        <Card className="bg-card/40 border-card-border/40">
          <CardContent className="p-4">
            <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-3">
              Next Review Triggers
            </p>
            <div className="space-y-2.5">
              {analysis.nextReviewTriggers.map((t, i) => (
                <div key={i} className="flex items-start gap-3">
                  <CalendarClock className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-foreground/80 leading-snug">
                      {t.trigger}
                      {t.date && (
                        <span className="text-muted-foreground/50 ml-1.5 text-[11px]">{t.date}</span>
                      )}
                    </p>
                    {t.affectedDecisions && t.affectedDecisions.length > 0 && (
                      <p className="text-[10px] text-muted-foreground/40 mt-0.5 leading-relaxed">
                        Affects: {t.affectedDecisions.join(", ")}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
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
// Debug Dialog
// ---------------------------------------------------------------------------

interface DebugDialogProps {
  open: boolean
  onClose: () => void
  debugInfo: AiDebugInfo | null
  error: unknown
}

function DebugDialog({ open, onClose, debugInfo, error }: DebugDialogProps) {
  const req = debugInfo?.request ?? null
  const inputMessages: Array<{ role: string; content: string }> = (() => {
    if (!req) return []
    if (Array.isArray(req.messages)) return req.messages as Array<{ role: string; content: string }>
    if (Array.isArray(req.input))    return req.input    as Array<{ role: string; content: string }>
    return []
  })()

  const rawResponse = debugInfo?.rawResponse ?? ""
  const hasRequest  = req !== null
  const hasResponse = rawResponse.length > 0

  const prettyResponse = (() => {
    if (!hasResponse) return ""
    try { return JSON.stringify(JSON.parse(rawResponse), null, 2) }
    catch { return rawResponse }
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

            {/* ── Error ── */}
            {!!error && (
              <DebugSection label="❌ Error" color="rose">
                <pre className="whitespace-pre-wrap text-rose-400 break-all">
                  {error instanceof Error
                    ? JSON.stringify({ message: error.message, stack: error.stack }, null, 2)
                    : JSON.stringify(error, null, 2)}
                </pre>
              </DebugSection>
            )}

            {/* ── Sent to OpenAI ── shown whenever the request payload is available */}
            {hasRequest && (
              <DebugSection
                label="📤 Sent to OpenAI"
                color="blue"
                copyText={inputMessages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n") || undefined}
              >
                <div className="space-y-1.5 mb-3">
                  <DebugRow label="API"                  value="Responses API + web_search" />
                  {debugInfo?.errorStage && (
                    <DebugRow label="Failed at stage"    value={debugInfo.errorStage} />
                  )}
                  {debugInfo?.webSearchUsed !== undefined && (
                    <DebugRow label="Web search confirmed" value={debugInfo.webSearchUsed ? "Yes ✓" : "No ✗ (detection failed)"} />
                  )}
                  <DebugRow label="Model"       value={String(req?.model ?? "—")} />
                  <DebugRow label="Temperature" value={String(req?.temperature ?? "—")} />
                  <DebugRow label="Max tokens"  value={String(req?.max_tokens ?? req?.max_output_tokens ?? "—")} />
                  <DebugRow label="Called at"   value={debugInfo?.calledAt ?? "—"} />
                </div>
                {inputMessages.length > 0
                  ? inputMessages.map((m, i) => (
                    <div key={i} className="mb-2">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">[{m.role}]</p>
                      <pre className="whitespace-pre-wrap text-foreground/80 bg-background/60 rounded p-2 border border-border/40 break-all">
                        {m.content}
                      </pre>
                    </div>
                  ))
                  : <p className="text-muted-foreground/60 italic">No messages extracted from request payload.</p>
                }
              </DebugSection>
            )}

            {/* ── Received from OpenAI ── shown whenever we have any debug info */}
            {debugInfo && (
              <DebugSection
                label="📥 Received from OpenAI"
                color="emerald"
                copyText={prettyResponse || undefined}
              >
                <div className="mb-3 flex flex-wrap gap-4 text-muted-foreground">
                  {debugInfo.webSearchUsed !== undefined && (
                    <span>
                      Web search:{" "}
                      <span className={debugInfo.webSearchUsed ? "text-emerald-400" : "text-rose-400"}>
                        {debugInfo.webSearchUsed ? "Yes ✓" : "No ✗"}
                      </span>
                    </span>
                  )}
                  <span>Prompt tokens: <span className="text-foreground">{debugInfo.usage?.prompt_tokens ?? "—"}</span></span>
                  <span>Completion tokens: <span className="text-foreground">{debugInfo.usage?.completion_tokens ?? "—"}</span></span>
                  <span>Total: <span className="text-foreground">{debugInfo.usage?.total_tokens ?? "—"}</span></span>
                </div>
                {hasResponse
                  ? <pre className="whitespace-pre-wrap text-emerald-300/90 bg-background/60 rounded p-2 border border-emerald-500/20 break-all">{prettyResponse}</pre>
                  : <p className="text-muted-foreground/60 italic">OpenAI did not return a response before the request failed.</p>
                }
              </DebugSection>
            )}

            {/* ── Fallback — no debug data at all ── */}
            {!error && !debugInfo && (
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
  const border = color === "blue" ? "border-blue-500/30" : color === "emerald" ? "border-emerald-500/30" : "border-rose-500/30"
  const text   = color === "blue" ? "text-blue-400"      : color === "emerald" ? "text-emerald-400"      : "text-rose-400"
  return (
    <div className={`border ${border} rounded p-3`}>
      <div className="flex items-center justify-between mb-2">
        <p className={`text-[10px] font-bold uppercase tracking-widest ${text}`}>{label}</p>
        {copyText && (
          <button
            onClick={() => {
              navigator.clipboard.writeText(copyText).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1800)
              })
            }}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-white/5"
          >
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
