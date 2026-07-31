import { useState } from "react"
import { useRunEventAnalysis, useGetRepositoryEntry } from "@workspace/api-client-react"
import type { EventMonitorAnalysis, EventMonitorSource } from "@workspace/api-client-react"
import {
  AlertCircle,
  RefreshCw,
  CalendarDays,
  Clock,
  Timer,
  Info,
  ExternalLink,
  Globe,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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

function importanceBadgeVariant(
  importance: string
): "negative" | "warning" | "positive" | "outline" {
  if (importance === "High") return "negative"
  if (importance === "Medium") return "warning"
  return "positive"
}


function countdownLabel(days: number): string {
  if (days === 0) return "Today"
  if (days === 1) return "Tomorrow"
  return `in ${days}d`
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function EventMonitor({ initialExpanded = false }: { initialExpanded?: boolean }) {
  const [debugInfo, setDebugInfo] = useState<AiDebugInfo | null>(null)
  const [debugError, setDebugError] = useState<unknown>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [expanded, setExpanded] = useState(initialExpanded)
  const [expandedReasonIdx, setExpandedReasonIdx] = useState<number | null>(null)

  // ── Persisted result (loaded from repository on mount) ────────────────────
  const { data: repoEntry, isLoading: repoLoading } = useGetRepositoryEntry("event-monitor", {
    query: { retry: false },
  })
  const storedAnalysis = repoEntry?.result as EventMonitorAnalysis | undefined

  // ── Update mutation ───────────────────────────────────────────────────────
  const { mutate: runAnalysis, data: mutationData, isPending, error: mutationError } = useRunEventAnalysis({
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

  // Active analysis: latest mutation result takes priority, fall back to stored
  const typed = (mutationData ?? storedAnalysis) as EventMonitorAnalysis | undefined

  const handleRefresh = () => {
    setExpandedReasonIdx(null)
    runAnalysis()
  }
  const hasDebug = debugInfo !== null || debugError !== null

  // ── Loading skeleton (initial repository fetch only) ──────────────────────
  if (repoLoading) {
    return <Skeleton className="h-16 w-full animate-in fade-in duration-300" />
  }

  // ── Not updated yet ───────────────────────────────────────────────────────
  if (!typed) {
    return (
      <div className="space-y-3 pb-4 animate-in fade-in duration-500">
        <Card className="bg-card/60 border-card-border/50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-xs font-bold tracking-widest uppercase text-muted-foreground mb-1.5">
                  Event Monitor
                </h2>
                <p className="text-sm text-muted-foreground/40 italic">Not updated yet</p>
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
            <button onClick={() => setDebugOpen(true)} className="ml-auto text-muted-foreground hover:text-foreground underline underline-offset-2">
              Details
            </button>
          )}
        </div>
      )}

      {/* ── Summary card — always visible ── */}
      <Card className="bg-card/60 border-card-border/50">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-4">

            {/* Left: title + next major event + metadata */}
            <div className="min-w-0">
              <h2 className="text-xs font-bold tracking-widest uppercase text-muted-foreground mb-1.5">
                Event Monitor
              </h2>
              <div className="flex items-center gap-3 flex-wrap">
                {/* Next major event compact display */}
                <div className="flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                  <span className="text-sm font-medium text-foreground/90 truncate max-w-[220px] sm:max-w-xs">
                    {typed.nextMajorEvent.title}
                  </span>
                  <Badge
                    variant={typed.nextMajorEvent.countdownDays === 0 ? "negative" : typed.nextMajorEvent.countdownDays <= 3 ? "warning" : "outline"}
                    className="text-xs shrink-0 tabular-nums px-1.5 py-0"
                  >
                    {countdownLabel(typed.nextMajorEvent.countdownDays)}
                  </Badge>
                </div>
                {/* Metadata */}
                <div className="hidden sm:flex items-center gap-3 text-[11px] text-muted-foreground/50">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {format(new Date(typed.timestamp), "HH:mm 'UTC'")}
                  </span>
                  <span className="flex items-center gap-1">
                    <Timer className="h-3 w-3" />
                    {formatDuration(typed.analysisDuration)}
                  </span>
                </div>
              </div>
            </div>

            {/* Right: action buttons + expand toggle */}
            <div className="flex items-center gap-1 shrink-0">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleRefresh}
                disabled={isPending}
                className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Update analysis"
                data-testid="button-refresh"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
              </Button>
              {typed.sources && typed.sources.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => setSourcesOpen(true)}
                  title="View sources"
                >
                  <Globe className="h-3.5 w-3.5" />
                  <span className="text-xs hidden sm:inline">
                    Sources ({typed.sources.length})
                  </span>
                </Button>
              )}
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
                onClick={() => setExpanded((v) => !v)}
                title={expanded ? "Collapse" : "Expand details"}
              >
                {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Expanded detail sections ── */}
      {expanded && (
        <div className="space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">

          {/* Summary */}
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="p-4">
              <p className="text-sm leading-relaxed text-foreground/90">{typed.summary}</p>
            </CardContent>
          </Card>

          {/* Next Major Event */}
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardHeader className="py-3 px-4 border-b border-amber-500/20">
              <CardTitle className="text-xs font-bold uppercase tracking-widest flex items-center gap-2 text-amber-400">
                <Zap className="h-4 w-4" /> Next Major Event
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold text-foreground leading-snug">
                    {typed.nextMajorEvent.title}
                  </p>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {typed.nextMajorEvent.date}
                  </p>
                </div>
                <Badge
                  variant={
                    typed.nextMajorEvent.countdownDays === 0
                      ? "negative"
                      : typed.nextMajorEvent.countdownDays <= 3
                      ? "warning"
                      : "outline"
                  }
                  className="text-sm tabular-nums px-2.5 py-1 shrink-0"
                >
                  {countdownLabel(typed.nextMajorEvent.countdownDays)}
                </Badge>
              </div>
            </CardContent>
          </Card>

          {/* Upcoming Events list */}
          <Card className="border-card-border/50">
            <CardHeader className="py-3 px-4 border-b border-border/50">
              <CardTitle className="text-xs font-bold uppercase tracking-widest flex items-center gap-2">
                <CalendarDays className="h-4 w-4 text-primary" />
                Upcoming Events
                <span className="text-muted-foreground/50 font-normal normal-case tracking-normal text-[11px]">
                  next 14 days
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-border/40">
                {typed.events.map((event, i) => (
                  <li key={i} className="px-4 py-3">
                    {/* Row: importance | date | category | title */}
                    <div className="flex items-start gap-2.5">
                      <Badge
                        variant={importanceBadgeVariant(event.importance)}
                        className="text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0 mt-0.5"
                      >
                        {event.importance}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-0.5">
                          <span className="text-[11px] font-mono text-muted-foreground/60 shrink-0">
                            {event.date}
                          </span>
                          <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider border border-border/40 rounded px-1">
                            {event.category}
                          </span>
                        </div>
                        <p className="text-sm font-medium text-foreground/90 leading-snug">
                          {event.title}
                        </p>
                        <p className="text-xs text-muted-foreground/70 mt-0.5 leading-snug">
                          {event.expectedImpact}
                        </p>
                        {/* Expandable reason */}
                        {event.reason && (
                          <>
                            <button
                              className="flex items-center gap-1 text-[11px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors mt-1"
                              onClick={() =>
                                setExpandedReasonIdx(expandedReasonIdx === i ? null : i)
                              }
                            >
                              <ChevronRight
                                className={`h-3 w-3 transition-transform ${expandedReasonIdx === i ? "rotate-90" : ""}`}
                              />
                              {expandedReasonIdx === i ? "Hide" : "Why it matters"}
                            </button>
                            {expandedReasonIdx === i && (
                              <p className="text-xs text-muted-foreground/60 mt-1 pl-4 border-l border-border/40 leading-snug animate-in fade-in duration-150">
                                {event.reason}
                              </p>
                            )}
                          </>
                        )}
                        {/* Affected markets */}
                        {event.affectedMarkets && event.affectedMarkets.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {event.affectedMarkets.map((m, mi) => (
                              <span
                                key={mi}
                                className="text-[10px] text-primary/70 bg-primary/8 border border-primary/15 rounded px-1.5 py-0"
                              >
                                {m}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

        </div>
      )}

      <SourcesDialog
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        sources={typed.sources ?? []}
      />

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

// ── Sources Dialog ────────────────────────────────────────────────────────────

interface SourcesDialogProps {
  open: boolean
  onClose: () => void
  sources: EventMonitorSource[]
}

function SourcesDialog({ open, onClose, sources }: SourcesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-lg bg-[#0d1117] border-border text-foreground">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold uppercase tracking-widest flex items-center gap-2">
            <Globe className="h-4 w-4 text-primary" />
            Sources — Live Web Research
          </DialogTitle>
        </DialogHeader>
        <ul className="divide-y divide-border/30 mt-1">
          {sources.map((source, i) => (
            <li key={i} className="py-3 first:pt-0 last:pb-0">
              <a href={source.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2.5 group">
                <ExternalLink className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground/40 group-hover:text-primary transition-colors" />
                <div className="min-w-0">
                  <p className="text-sm text-foreground/80 group-hover:text-foreground group-hover:underline underline-offset-2 transition-colors leading-snug">
                    {source.title}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    {source.published && (
                      <>
                        <span className="text-[11px] text-muted-foreground/60 font-mono">{source.published}</span>
                        <span className="text-muted-foreground/30 text-[11px]">·</span>
                      </>
                    )}
                    <span className="text-[11px] text-muted-foreground/50 font-mono truncate">
                      {(() => { try { return new URL(source.url).hostname } catch { return source.url } })()}
                    </span>
                  </div>
                </div>
              </a>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
