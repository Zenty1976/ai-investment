/**
 * News Monitor
 *
 * AI-curated summary of the most important market-moving news from the last
 * 24-72 hours. Follows the same architecture and UI conventions as Market
 * Monitor and Event Monitor.
 *
 * Data flows: reads stored result from the Analysis Repository on mount;
 * only calls OpenAI when the user explicitly presses "Update".
 */
import { useState } from "react"
import { useRunNewsAnalysis, useGetRepositoryEntry } from "@workspace/api-client-react"
import type { NewsAnalysis } from "@workspace/api-client-react"
import {
  AlertCircle,
  RefreshCw,
  Info,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Clock,
  Timer,
  Newspaper,
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
import { format, parseISO, isValid, differenceInMinutes, differenceInHours, differenceInDays } from "date-fns"

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

function formatRelativeTime(dateStr: string): string {
  try {
    const d = parseISO(dateStr)
    if (!isValid(d)) return dateStr.slice(0, 10)
    const now = new Date()
    const mins = differenceInMinutes(now, d)
    if (mins < 1) return "Just now"
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`
    const hrs = differenceInHours(now, d)
    if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`
    const days = differenceInDays(now, d)
    if (days === 1) return "Yesterday"
    if (days < 7) return `${days} days ago`
    // Fall back to a readable date for older items
    return format(d, "MMM d")
  } catch {
    return dateStr.slice(0, 10)
  }
}

function importanceBadgeVariant(
  importance: string
): "negative" | "warning" | "positive" | "outline" {
  if (importance === "High") return "negative"
  if (importance === "Medium") return "warning"
  return "positive"
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function NewsMonitor({ initialExpanded = false }: { initialExpanded?: boolean }) {
  const [debugInfo, setDebugInfo] = useState<AiDebugInfo | null>(null)
  const [debugError, setDebugError] = useState<unknown>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  const [expanded, setExpanded] = useState(initialExpanded)
  const [expandedWhyIdx, setExpandedWhyIdx] = useState<number | null>(null)

  // ── Persisted result (loaded from repository on mount) ────────────────────
  const { data: repoEntry, isLoading: repoLoading } = useGetRepositoryEntry("news-monitor", {
    query: { retry: false },
  })
  const storedAnalysis = repoEntry?.result as NewsAnalysis | undefined

  // ── Update mutation ───────────────────────────────────────────────────────
  const { mutate: runAnalysis, data: mutationData, isPending, error: mutationError } = useRunNewsAnalysis({
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
  const analysis = (mutationData ?? storedAnalysis) as NewsAnalysis | undefined

  const handleRefresh = () => {
    setExpandedWhyIdx(null)
    runAnalysis()
  }
  const hasDebug = debugInfo !== null || debugError !== null

  // ── Loading skeleton (initial repository fetch only) ──────────────────────
  if (repoLoading) {
    return <Skeleton className="h-16 w-full animate-in fade-in duration-300" />
  }

  // ── Not updated yet ───────────────────────────────────────────────────────
  if (!analysis) {
    return (
      <div className="space-y-3 pb-4 animate-in fade-in duration-500">
        <Card className="bg-card/60 border-card-border/50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-xs font-bold tracking-widest uppercase text-muted-foreground mb-1.5">
                  News Monitor
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
      <Card className={`bg-card/60 overflow-hidden transition-colors duration-300 ${isPending ? "border-primary/30" : "border-card-border/50"}`}>
        {isPending && <div className="h-0.5 bg-primary/70 animate-pulse" />}
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-4">

            {/* Left: title + top story + metadata */}
            <div className="min-w-0">
              <h2 className="text-xs font-bold tracking-widest uppercase text-muted-foreground mb-1.5">
                News Monitor
              </h2>
              <div className="flex items-center gap-3 flex-wrap">
                {/* Top story compact display */}
                <div className="flex items-center gap-1.5 min-w-0">
                  <Newspaper className="h-3.5 w-3.5 text-primary/70 shrink-0" />
                  <span className="text-sm font-medium text-foreground/90 truncate max-w-[220px] sm:max-w-xs">
                    {analysis.topStory.title}
                  </span>
                  <Badge
                    variant={importanceBadgeVariant(analysis.topStory.importance)}
                    className="text-xs shrink-0 tabular-nums px-1.5 py-0"
                  >
                    {analysis.topStory.importance}
                  </Badge>
                </div>
                {/* Metadata */}
                <div className="hidden sm:flex items-center gap-3 text-[11px] text-muted-foreground/50">
                  {isPending ? (
                    <span className="flex items-center gap-1.5 text-primary/80 animate-pulse">
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      Fetching live data…
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
                    </>
                  )}
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
              {analysis.overallMarketImpact && (
                <div className="mt-3 pt-3 border-t border-border/30 flex items-start gap-2">
                  <span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground/60 mt-0.5 shrink-0">
                    Market Tone
                  </span>
                  <p className="text-sm text-foreground/70 leading-snug">
                    {analysis.overallMarketImpact}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Top Story */}
          <Card className="bg-primary/5 border-primary/15">
            <CardHeader className="px-4 pt-4 pb-2">
              <CardTitle className="text-[11px] font-bold tracking-widest uppercase text-primary/70 flex items-center gap-1.5">
                <Newspaper className="h-3.5 w-3.5" />
                Top Story
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0">
              <div className="flex items-start gap-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap mb-1.5">
                    <Badge
                      variant={importanceBadgeVariant(analysis.topStory.importance)}
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0"
                    >
                      {analysis.topStory.importance}
                    </Badge>
                  </div>
                  <p className="text-base font-semibold text-foreground/95 leading-snug mb-1">
                    {analysis.topStory.title}
                  </p>
                  <p className="text-sm text-foreground/70 leading-relaxed">
                    {analysis.topStory.summary}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* News List */}
          {analysis.news && analysis.news.length > 0 && (
            <Card className="bg-card/40 border-card-border/40">
              <CardHeader className="px-4 pt-4 pb-2">
                <CardTitle className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground flex items-center gap-1.5">
                  <Newspaper className="h-3.5 w-3.5" />
                  Market-Moving News
                  <span className="ml-auto text-muted-foreground/40 font-normal normal-case tracking-normal text-[10px]">
                    {analysis.news.length} item{analysis.news.length !== 1 ? "s" : ""}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ul className="divide-y divide-border/40">
                  {analysis.news.map((item, i) => (
                    <li key={item.id ?? i} className="px-4 py-3">
                      {/* Row: importance | title */}
                      <div className="flex items-start gap-2.5">
                        <Badge
                          variant={importanceBadgeVariant(item.importance)}
                          className="text-[10px] uppercase tracking-wider px-1.5 py-0 shrink-0 mt-0.5"
                        >
                          {item.importance}
                        </Badge>
                        <div className="min-w-0 flex-1">
                          {/* Meta row: relative time · category · market impact */}
                          <div className="flex items-center gap-2 flex-wrap mb-0.5">
                            <span className="text-[11px] font-mono text-muted-foreground/60 shrink-0">
                              {formatRelativeTime(item.publishedAt)}
                            </span>
                            <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider border border-border/40 rounded px-1">
                              {item.category}
                            </span>
                            {item.marketImpact && (
                              <span className="text-[11px] text-muted-foreground/70 italic">
                                {item.marketImpact}
                              </span>
                            )}
                          </div>
                          {/* Title */}
                          <p className="text-sm font-medium text-foreground/90 leading-snug">
                            {item.title}
                          </p>
                          {/* Summary */}
                          <p className="text-xs text-muted-foreground/70 mt-0.5 leading-snug">
                            {item.summary}
                          </p>
                          {/* Affected markets */}
                          {item.affectedMarkets && item.affectedMarkets.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {item.affectedMarkets.map((market, j) => (
                                <span
                                  key={j}
                                  className="text-[10px] text-muted-foreground/60 bg-muted/20 border border-border/30 rounded px-1.5 py-0.5"
                                >
                                  {market}
                                </span>
                              ))}
                              {/* Source + confidence */}
                              <span className="text-[10px] text-muted-foreground/40 ml-auto self-center">
                                {item.source}
                                {item.confidence != null && (
                                  <> · {Math.round(item.confidence * 100)}% conf.</>
                                )}
                              </span>
                            </div>
                          )}
                          {/* Expandable "Why it matters" */}
                          {item.whyItMatters && (
                            <>
                              <button
                                className="flex items-center gap-1 text-[11px] text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors mt-1"
                                onClick={() =>
                                  setExpandedWhyIdx(expandedWhyIdx === i ? null : i)
                                }
                              >
                                <ChevronRight
                                  className={`h-3 w-3 transition-transform ${expandedWhyIdx === i ? "rotate-90" : ""}`}
                                />
                                Why it matters
                              </button>
                              {expandedWhyIdx === i && (
                                <p className="text-xs text-muted-foreground/70 mt-1 pl-4 border-l border-border/40 leading-snug animate-in fade-in duration-200">
                                  {item.whyItMatters}
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
