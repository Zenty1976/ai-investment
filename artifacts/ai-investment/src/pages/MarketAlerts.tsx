/**
 * Market Alerts Page
 *
 * The user's "attention manager" — answers one question:
 * "What has changed since my previous analysis that deserves attention?"
 *
 * Does NOT summarise the market. Only surfaces meaningful new developments.
 */
import { useState } from "react"
import { useRunMarketAlerts, useGetRepositoryEntry } from "@workspace/api-client-react"
import type { MarketAlertsAnalysis, MarketAlert } from "@workspace/api-client-react"
import {
  AlertCircle,
  RefreshCw,
  Info,
  ChevronRight,
  Clock,
  Timer,
  Bell,
  CheckCircle2,
  Eye,
  Copy,
  Check,
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

function alertLevelVariant(level: string): BadgeVariant {
  if (level === "High") return "negative"
  if (level === "Medium") return "warning"
  return "positive"
}

function importanceVariant(i: string): BadgeVariant {
  if (i === "High") return "negative"
  if (i === "Medium") return "warning"
  return "outline"
}

function statusVariant(s: string): BadgeVariant {
  if (s === "New") return "warning"
  if (s === "Updated") return "default"
  return "secondary"
}

function attentionVariant(a: string): BadgeVariant {
  if (a === "Prepare") return "negative"
  if (a === "Review") return "warning"
  return "secondary"
}

// ---------------------------------------------------------------------------
// Alert Card
// ---------------------------------------------------------------------------

function AlertCard({ alert }: { alert: MarketAlert }) {
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
                {alert.title}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge variant="secondary" className="text-[10px] px-1.5">
                  {alert.category}
                </Badge>
                <Badge variant={importanceVariant(alert.importance)} className="text-[10px] px-1.5">
                  {alert.importance}
                </Badge>
                {alert.status && (
                  <Badge variant={statusVariant(alert.status)} className="text-[10px] px-1.5">
                    {alert.status}
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
                Summary
              </p>
              <p className="text-xs text-foreground/80 leading-relaxed">{alert.summary}</p>
            </div>

            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                Why It Matters
              </p>
              <p className="text-xs text-foreground/75 leading-relaxed">{alert.whyItMatters}</p>
            </div>

            {alert.affectedHoldings && alert.affectedHoldings.length > 0 && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                  Affected Holdings
                </p>
                <div className="flex flex-wrap gap-1">
                  {alert.affectedHoldings.map((h, i) => (
                    <Badge key={i} variant="secondary" className="text-[10px] px-1.5 font-mono">
                      {h}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-3 flex-wrap">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                  Recommended Action
                </p>
                <Badge variant={attentionVariant(alert.recommendedAttention)} className="text-[10px] px-1.5">
                  {alert.recommendedAttention}
                </Badge>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40 mb-1">
                  Source
                </p>
                <Badge variant="outline" className="text-[10px] px-1.5">
                  {alert.sourceType}
                </Badge>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function MarketAlerts() {
  const [debugInfo, setDebugInfo] = useState<AiDebugInfo | null>(null)
  const [debugError, setDebugError] = useState<unknown>(null)
  const [debugOpen, setDebugOpen] = useState(false)

  // ── Persisted result ──────────────────────────────────────────────────────
  const { data: repoEntry, isLoading: repoLoading } = useGetRepositoryEntry(
    "market-alerts",
    { query: { retry: false } }
  )
  const storedAnalysis = repoEntry?.result as MarketAlertsAnalysis | undefined

  // ── Update mutation ───────────────────────────────────────────────────────
  const {
    mutate: runAlerts,
    data: mutationData,
    isPending,
    error: mutationError,
  } = useRunMarketAlerts({
    mutation: {
      onSuccess: (data) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (data as any)?._debug
        if (d) setDebugInfo(d)
        setDebugError(null)
      },
      onError: (err) => {
        // ApiError wraps the parsed JSON body in `.data`; fall back to the
        // error object itself for non-ApiError cases.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (err as any)?.data?._debug ?? (err as any)?._debug
        if (d) setDebugInfo(d)
        setDebugError(err)
      },
    },
  })

  const analysis = (mutationData ?? storedAnalysis) as MarketAlertsAnalysis | undefined
  const hasDebug = debugInfo !== null || debugError !== null

  // ── Loading skeleton ──────────────────────────────────────────────────────
  if (repoLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full animate-in fade-in duration-300" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    )
  }

  // ── Not run yet ───────────────────────────────────────────────────────────
  if (!analysis) {
    return (
      <div className="space-y-4 pb-8 animate-in fade-in duration-500">
        <div>
          <h1 className="text-base font-bold tracking-widest uppercase text-foreground mb-1">
            Market Alerts
          </h1>
          <p className="text-xs text-muted-foreground/60">
            Identifies developments that require your attention since the previous analysis.
          </p>
        </div>
        <Card className="bg-card/40 border-card-border/40">
          <CardContent className="p-6 flex flex-col items-center text-center gap-3">
            <Bell className="h-8 w-8 text-muted-foreground/20" />
            <p className="text-sm text-muted-foreground/60">
              No analysis yet. Run Market Alerts to surface important developments since your last check-in.
            </p>
            <Button size="sm" onClick={() => runAlerts()} disabled={isPending} className="mt-2">
              <RefreshCw className={`h-3.5 w-3.5 mr-2 ${isPending ? "animate-spin" : ""}`} />
              {isPending ? "Analysing…" : "Check for Alerts"}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Sort alerts: High importance first, then New/Updated status
  const sortedAlerts = [...analysis.alerts].sort((a, b) => {
    const imp: Record<string, number> = { High: 0, Medium: 1, Low: 2 }
    const sta: Record<string, number> = { New: 0, Updated: 1, Unchanged: 2 }
    const impDiff = (imp[a.importance] ?? 9) - (imp[b.importance] ?? 9)
    if (impDiff !== 0) return impDiff
    return (sta[a.status ?? "Unchanged"] ?? 9) - (sta[b.status ?? "Unchanged"] ?? 9)
  })

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
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-bold tracking-widest uppercase text-foreground mb-2">
                Market Alerts
              </h1>
              <div className="flex items-center gap-2.5 flex-wrap">
                <Badge variant={alertLevelVariant(analysis.overallAlertLevel)} className="text-xs">
                  {analysis.overallAlertLevel} alert level
                </Badge>
                {isPending ? (
                  <span className="flex items-center gap-1.5 text-[11px] text-primary/80 animate-pulse ml-1">
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    Checking for alerts…
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

              {/* Headline */}
              {analysis.headline && (
                <p className="text-sm font-semibold text-foreground mt-3 leading-snug">
                  {analysis.headline}
                </p>
              )}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <Button
                size="sm"
                variant="outline"
                onClick={() => runAlerts()}
                disabled={isPending}
                className="h-8 text-xs font-medium"
              >
                <RefreshCw className={`h-3 w-3 mr-1.5 ${isPending ? "animate-spin" : ""}`} />
                {isPending ? "Checking…" : "Update"}
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

      {/* ── Nothing changed card ── */}
      {analysis.nothingImportantChanged && (
        <Card className="bg-emerald-950/20 border-emerald-500/20">
          <CardContent className="p-4 flex items-start gap-3">
            <CheckCircle2 className="h-4 w-4 text-emerald-400/70 shrink-0 mt-0.5" />
            <p className="text-sm text-emerald-300/80 leading-relaxed">
              No significant developments since the previous update.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Alert cards ── */}
      {sortedAlerts.length > 0 && (
        <>
          <div className="flex items-center gap-2 px-1 text-[10px] text-muted-foreground/40">
            <span className="font-bold uppercase tracking-widest">
              Alerts ({sortedAlerts.length})
            </span>
            <span className="ml-auto italic">click to expand</span>
          </div>
          {sortedAlerts.map((alert, i) => (
            <AlertCard key={i} alert={alert} />
          ))}
        </>
      )}

      {/* ── Things to Watch ── */}
      {analysis.thingsToWatch && analysis.thingsToWatch.length > 0 && (
        <Card className="bg-card/40 border-card-border/40">
          <CardContent className="p-4">
            <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground mb-3">
              Things to Watch
            </p>
            <ul className="space-y-2">
              {analysis.thingsToWatch.map((item, i) => (
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
                    <DebugRow label="API" value="Responses API + web_search" />
                  <DebugRow label="Web search confirmed" value={debugInfo.webSearchUsed ? "Yes ✓" : "No ✗ (detection failed)"} />
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
