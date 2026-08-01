/**
 * Risk Analyzer Page
 *
 * Identifies, explains, and prioritizes the risks affecting the current
 * portfolio over the next 1–3 months. Focuses entirely on portfolio-level risk.
 */
import { useState } from "react"
import { useRunRiskAnalysis, useGetRepositoryEntry } from "@workspace/api-client-react"
import type { RiskAnalysis, RiskItem, RiskProfileItem, RiskInteraction, ResolvedRisk } from "@workspace/api-client-react"
import {
  AlertCircle,
  RefreshCw,
  Info,
  ChevronRight,
  Clock,
  Timer,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Eye,
  Copy,
  Check,
  TrendingUp,
  TrendingDown,
  Minus,
  Zap,
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

function riskLevelVariant(level: string): BadgeVariant {
  if (level === "High") return "negative"
  if (level === "Moderate") return "warning"
  return "positive"
}

function probabilityVariant(p: string): BadgeVariant {
  if (p === "High") return "negative"
  if (p === "Medium") return "warning"
  return "outline"
}

function severityVariant(s: string): BadgeVariant {
  if (s === "High") return "negative"
  if (s === "Medium") return "warning"
  return "outline"
}

function horizonVariant(h: string): BadgeVariant {
  if (h === "Immediate") return "negative"
  if (h === "Weeks") return "warning"
  return "outline"
}

function statusVariant(s: string): BadgeVariant {
  if (s === "Increased") return "negative"
  if (s === "New") return "warning"
  if (s === "Reduced") return "positive"
  return "secondary"
}

function riskScoreColor(score: number): string {
  if (score <= 30) return "text-emerald-400"
  if (score <= 55) return "text-amber-400"
  if (score <= 75) return "text-orange-400"
  return "text-rose-400"
}

function profileBarColor(score: number): string {
  if (score <= 30) return "bg-emerald-500/70"
  if (score <= 55) return "bg-amber-500/70"
  if (score <= 75) return "bg-orange-500/70"
  return "bg-rose-500/70"
}

function profileLevelVariant(level: string): BadgeVariant {
  if (level === "High") return "negative"
  if (level === "Moderate") return "warning"
  return "positive"
}

function interactionSeverityVariant(s: string): BadgeVariant {
  if (s === "High") return "negative"
  if (s === "Medium") return "warning"
  return "outline"
}

// ---------------------------------------------------------------------------
// Score Change display
// ---------------------------------------------------------------------------

function ScoreChange({ current, previous }: { current: number; previous: number | undefined }) {
  if (previous === undefined) return null
  const delta = current - previous
  if (delta === 0) {
    return (
      <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground/50">
        <Minus className="h-3 w-3" />
        Unchanged
      </span>
    )
  }
  const up = delta > 0
  return (
    <span className={`flex items-center gap-0.5 text-[11px] font-mono tabular-nums font-semibold ${up ? "text-rose-400" : "text-emerald-400"}`}>
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {up ? "▲" : "▼"} {Math.abs(delta)}
      <span className="text-muted-foreground/40 font-normal ml-1">prev {previous}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Risk Profile bars (expandable rows)
// ---------------------------------------------------------------------------

function RiskProfileRow({ item }: { item: RiskProfileItem }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div>
      <button
        className="w-full text-left hover:bg-white/[0.02] transition-colors rounded -mx-1 px-1"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2.5 py-1">
          <span className="text-[11px] text-muted-foreground/70 w-28 shrink-0 truncate">
            {item.category}
          </span>
          <div className="flex-1 bg-white/5 rounded-full h-1.5 min-w-0 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${profileBarColor(item.score)}`}
              style={{ width: `${item.score}%` }}
            />
          </div>
          <span className={`text-[11px] font-mono tabular-nums font-semibold w-6 text-right ${riskScoreColor(item.score)}`}>
            {item.score}
          </span>
          <Badge variant={profileLevelVariant(item.level)} className="text-[9px] px-1 shrink-0">
            {item.level}
          </Badge>
          <ChevronRight
            className={`h-3 w-3 text-muted-foreground/25 shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          />
        </div>
      </button>
      {expanded && item.reason && (
        <p className="text-[11px] text-foreground/60 leading-relaxed pb-2 pl-[7.5rem]">
          {item.reason}
        </p>
      )}
    </div>
  )
}

function RiskProfileBars({ profile }: { profile: RiskProfileItem[] }) {
  if (!profile || profile.length === 0) return null

  const sorted = [...profile].sort((a, b) => b.score - a.score)

  return (
    <Card className="bg-card/40 border-card-border/40">
      <CardContent className="p-4">
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 mb-3">
          Risk Profile
        </p>
        <div className="space-y-0.5">
          {sorted.map((item, i) => (
            <RiskProfileRow key={i} item={item} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Risk Card
// ---------------------------------------------------------------------------

function RiskCard({ risk }: { risk: RiskItem }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <Card className="bg-card/40 border-card-border/40 overflow-hidden">
      <CardContent className="p-0">
        <button
          className="w-full text-left p-4 hover:bg-white/[0.02] transition-colors"
          onClick={() => setExpanded((v) => !v)}
        >
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground mb-2 leading-snug">
                {risk.title}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge variant="secondary" className="text-[10px] px-1.5">
                  {risk.category}
                </Badge>
                <Badge variant={probabilityVariant(risk.probability)} className="text-[10px] px-1.5">
                  P: {risk.probability}
                </Badge>
                <Badge variant={severityVariant(risk.severity)} className="text-[10px] px-1.5">
                  S: {risk.severity}
                </Badge>
                <Badge variant={horizonVariant(risk.timeHorizon)} className="text-[10px] px-1.5">
                  {risk.timeHorizon}
                </Badge>
                {risk.status && (
                  <Badge variant={statusVariant(risk.status)} className="text-[10px] px-1.5">
                    {risk.status}
                  </Badge>
                )}
              </div>
            </div>
            <ChevronRight
              className={`h-3.5 w-3.5 text-muted-foreground/30 shrink-0 mt-0.5 transition-transform duration-150 ${
                expanded ? "rotate-90" : ""
              }`}
            />
          </div>
        </button>

        {expanded && (
          <div className="border-t border-border/20 px-4 pb-4 pt-3 space-y-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                Why This Risk Exists
              </p>
              <p className="text-xs text-foreground/80 leading-relaxed">{risk.reason}</p>
            </div>

            {risk.portfolioImpact && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                  Portfolio Impact
                </p>
                <p className="text-xs text-foreground/75 leading-relaxed">{risk.portfolioImpact}</p>
              </div>
            )}

            {risk.affectedHoldings && risk.affectedHoldings.length > 0 && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                  Affected Holdings
                </p>
                <div className="flex flex-wrap gap-1">
                  {risk.affectedHoldings.map((h, i) => (
                    <Badge key={i} variant="secondary" className="text-[10px] px-1.5 font-mono">
                      {h}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {risk.eventDate && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                  Event Date
                </p>
                <p className="text-xs text-foreground/70 font-mono">{risk.eventDate}</p>
              </div>
            )}

            {risk.interactionWithOtherRisks && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1 flex items-center gap-1">
                  <Zap className="h-2.5 w-2.5" />
                  Interaction with Other Risks
                </p>
                <p className="text-xs text-foreground/70 leading-relaxed">{risk.interactionWithOtherRisks}</p>
              </div>
            )}

            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1 flex items-center gap-1">
                <Eye className="h-3 w-3" />
                What to Monitor
              </p>
              <p className="text-xs text-foreground/70 leading-relaxed">{risk.monitor}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Risk Interactions
// ---------------------------------------------------------------------------

function RiskInteractionCard({ interaction }: { interaction: RiskInteraction }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <Card className="bg-card/40 border-card-border/40 overflow-hidden">
      <CardContent className="p-0">
        <button
          className="w-full text-left p-4 hover:bg-white/[0.02] transition-colors"
          onClick={() => setExpanded((v) => !v)}
        >
          <div className="flex items-start gap-3">
            <Zap className="h-3.5 w-3.5 text-amber-400/60 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground mb-1.5 leading-snug">
                {interaction.title}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge variant={interactionSeverityVariant(interaction.severity)} className="text-[10px] px-1.5">
                  {interaction.severity} severity
                </Badge>
                {interaction.affectedHoldings?.length > 0 && (
                  <span className="text-[10px] text-muted-foreground/50">
                    {interaction.affectedHoldings.join(", ")}
                  </span>
                )}
              </div>
            </div>
            <ChevronRight
              className={`h-3.5 w-3.5 text-muted-foreground/30 shrink-0 mt-0.5 transition-transform duration-150 ${
                expanded ? "rotate-90" : ""
              }`}
            />
          </div>
        </button>
        {expanded && (
          <div className="border-t border-border/20 px-4 pb-4 pt-3">
            <p className="text-xs text-foreground/75 leading-relaxed">{interaction.reason}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Resolved Risks Section
// ---------------------------------------------------------------------------

function ResolvedRisksSection({ risks }: { risks: ResolvedRisk[] }) {
  const [open, setOpen] = useState(false)
  if (!risks || risks.length === 0) return null

  return (
    <Card className="bg-card/30 border-card-border/25">
      <CardContent className="p-0">
        <button
          className="w-full text-left px-4 py-3 hover:bg-white/[0.02] transition-colors"
          onClick={() => setOpen((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <ChevronRight
              className={`h-3 w-3 text-muted-foreground/30 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
            />
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
              Resolved since previous analysis
            </span>
            <span className="text-[10px] text-muted-foreground/30 ml-1">({risks.length})</span>
          </div>
        </button>
        {open && (
          <div className="border-t border-border/15 px-4 pb-3 pt-2 space-y-2">
            {risks.map((r, i) => (
              <div key={i} className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground/55 line-through">{r.title}</span>
                <Badge variant="secondary" className="text-[9px] px-1 opacity-60">{r.category}</Badge>
                <Badge variant={r.severity === "High" ? "negative" : r.severity === "Medium" ? "warning" : "outline"} className="text-[9px] px-1 opacity-60">
                  S: {r.severity}
                </Badge>
                <Badge variant={r.probability === "High" ? "negative" : r.probability === "Medium" ? "warning" : "outline"} className="text-[9px] px-1 opacity-60">
                  P: {r.probability}
                </Badge>
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

export default function RiskAnalyzer() {
  const [scoreDriversOpen, setScoreDriversOpen] = useState(false)
  const [debugInfo, setDebugInfo] = useState<AiDebugInfo | null>(null)
  const [debugError, setDebugError] = useState<unknown>(null)
  const [debugOpen, setDebugOpen] = useState(false)

  // ── Persisted result ──────────────────────────────────────────────────────
  const { data: repoEntry, isLoading: repoLoading } = useGetRepositoryEntry(
    "risk-analyzer",
    { query: { retry: false } }
  )
  const storedAnalysis = repoEntry?.result as RiskAnalysis | undefined

  // ── Update mutation ───────────────────────────────────────────────────────
  const {
    mutate: runAnalysis,
    data: mutationData,
    isPending,
    error: mutationError,
  } = useRunRiskAnalysis({
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

  const analysis = (mutationData ?? storedAnalysis) as RiskAnalysis | undefined
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

  // ── Not run yet ───────────────────────────────────────────────────────────
  if (!analysis) {
    return (
      <div className="space-y-4 pb-8 animate-in fade-in duration-500">
        <div>
          <h1 className="text-base font-bold tracking-widest uppercase text-foreground mb-1">
            Risk Analyzer
          </h1>
          <p className="text-xs text-muted-foreground/60">
            Identifies and prioritizes the risks facing your portfolio over the next 1–3 months.
          </p>
        </div>
        <Card className="bg-card/40 border-card-border/40">
          <CardContent className="p-6 flex flex-col items-center text-center gap-3">
            <ShieldAlert className="h-8 w-8 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground/60">
              No analysis yet. Run the risk analyzer to identify and prioritize the risks facing this portfolio.
            </p>
            <Button size="sm" onClick={() => runAnalysis()} disabled={isPending} className="mt-2">
              <RefreshCw className={`h-3.5 w-3.5 mr-2 ${isPending ? "animate-spin" : ""}`} />
              {isPending ? "Analysing…" : "Analyse Risks"}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Analysis view ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-3 pb-8 animate-in fade-in slide-in-from-bottom-2 duration-500">

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
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-bold tracking-widest uppercase text-foreground mb-2">
                Risk Analyzer
              </h1>
              <div className="flex items-center gap-2.5 flex-wrap">
                <Badge variant={riskLevelVariant(analysis.overallRiskLevel)} className="text-xs">
                  {analysis.overallRiskLevel} risk
                </Badge>
                <span className={`text-base font-bold font-mono tabular-nums ${riskScoreColor(analysis.riskScore)}`}>
                  {analysis.riskScore}
                  <span className="text-[10px] font-normal text-muted-foreground/40 ml-0.5">/100</span>
                </span>
                <ScoreChange current={analysis.riskScore} previous={analysis.previousRiskScore} />
                {isPending ? (
                  <span className="flex items-center gap-1.5 text-[11px] text-primary/80 animate-pulse ml-1">
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    Analysing risks…
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

              {/* Score drivers collapsible */}
              {analysis.scoreDrivers.length > 0 && (
                <div className="mt-3">
                  <button
                    onClick={() => setScoreDriversOpen((v) => !v)}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground/60 hover:text-foreground transition-colors"
                  >
                    <ChevronRight
                      className={`h-3 w-3 transition-transform duration-150 ${scoreDriversOpen ? "rotate-90" : ""}`}
                    />
                    Score drivers ({analysis.scoreDrivers.length})
                  </button>
                  {scoreDriversOpen && (
                    <div className="mt-2 space-y-1.5">
                      {analysis.scoreDrivers.map((d, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <Badge
                            variant={d.impact === "Negative" ? "negative" : "positive"}
                            className="text-[10px] px-1 shrink-0 mt-0.5"
                          >
                            {d.impact === "Negative" ? "▼" : "▲"}
                          </Badge>
                          <div className="min-w-0">
                            <span className="text-xs font-medium text-foreground/80">{d.factor}</span>
                            <span className="text-xs text-muted-foreground/55"> — {d.reason}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
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

      {/* ── Main Conclusion ── */}
      {analysis.mainConclusion && (
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="p-4">
            <p className="text-[11px] font-bold tracking-widest uppercase text-primary/60 mb-1">
              Main Conclusion
            </p>
            <p className="text-sm font-semibold text-foreground mb-1">
              {analysis.mainConclusion.title}
            </p>
            <p className="text-xs text-foreground/70 leading-relaxed">
              {analysis.mainConclusion.reason}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Risk Profile bars ── */}
      {analysis.riskProfile && analysis.riskProfile.length > 0 && (
        <RiskProfileBars profile={analysis.riskProfile} />
      )}

      {/* ── Executive Summary ── */}
      <Card className="bg-card/40 border-card-border/40">
        <CardContent className="p-4">
          <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-2">
            Executive Summary
          </p>
          <p className="text-xs text-foreground/80 leading-relaxed">{analysis.executiveSummary}</p>
        </CardContent>
      </Card>

      {/* ── Top Risks ── */}
      {analysis.topRisks.length > 0 && (
        <>
          <div className="flex items-center gap-2 px-1 text-[10px] text-muted-foreground/40">
            <span className="font-bold uppercase tracking-widest">Top Risks</span>
            <span>P = Probability · S = Severity</span>
            <span className="ml-auto italic">click to expand</span>
          </div>
          {analysis.topRisks.map((risk, i) => (
            <RiskCard key={i} risk={risk} />
          ))}
        </>
      )}

      {/* ── Risk Interactions ── */}
      {analysis.riskInteractions && analysis.riskInteractions.length > 0 && (
        <>
          <div className="flex items-center gap-2 px-1 text-[10px] text-muted-foreground/40">
            <Zap className="h-3 w-3 text-amber-400/50" />
            <span className="font-bold uppercase tracking-widest">Risk Interactions</span>
            <span className="ml-auto italic">click to expand</span>
          </div>
          {analysis.riskInteractions.map((interaction, i) => (
            <RiskInteractionCard key={i} interaction={interaction} />
          ))}
        </>
      )}

      {/* ── Resolved risks ── */}
      {analysis.resolvedRisks && analysis.resolvedRisks.length > 0 && (
        <ResolvedRisksSection risks={analysis.resolvedRisks} />
      )}

      {/* ── Strengths / Weaknesses — stacks on narrow screens ── */}
      {(analysis.portfolioStrengths.length > 0 || analysis.portfolioWeaknesses.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {analysis.portfolioStrengths.length > 0 && (
            <Card className="bg-card/40 border-card-border/40">
              <CardContent className="p-4">
                <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-3">
                  Strengths
                </p>
                <ul className="space-y-2">
                  {analysis.portfolioStrengths.map((item, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400/60 shrink-0 mt-0.5" />
                      <span className="text-xs text-foreground/75 leading-relaxed">{item}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {analysis.portfolioWeaknesses.length > 0 && (
            <Card className="bg-card/40 border-card-border/40">
              <CardContent className="p-4">
                <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-3">
                  Weaknesses
                </p>
                <ul className="space-y-2">
                  {analysis.portfolioWeaknesses.map((item, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <XCircle className="h-3.5 w-3.5 text-rose-400/60 shrink-0 mt-0.5" />
                      <span className="text-xs text-foreground/75 leading-relaxed">{item}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Watch Closely ── */}
      {analysis.watchClosely.length > 0 && (
        <Card className="bg-card/40 border-card-border/40">
          <CardContent className="p-4">
            <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-3">
              Watch Closely
            </p>
            <ul className="space-y-2">
              {analysis.watchClosely.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <Eye className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0 mt-0.5" />
                  <span className="text-xs text-foreground/75 leading-relaxed">{item}</span>
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
// Debug Dialog
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
