import { useState } from "react"
import { useRunMarketAnalysis } from "@workspace/api-client-react"
import {
  AlertCircle,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Activity,
  AlertTriangle,
  ShieldAlert,
  Info,
  ExternalLink,
  Globe,
  Copy,
  Check,
  Clock,
  Timer,
  ChevronDown,
  ChevronUp,
} from "lucide-react"
import type { MarketAnalysisSource } from "@workspace/api-client-react"
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

// ── Component ─────────────────────────────────────────────────────────────────

export default function MarketMonitor() {
  const [debugInfo, setDebugInfo] = useState<AiDebugInfo | null>(null)
  const [debugError, setDebugError] = useState<unknown>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const { mutate: runAnalysis, data: analysis, isPending, error } = useRunMarketAnalysis({
    mutation: {
      onSuccess: (data) => {
        window.dispatchEvent(new CustomEvent("market-updated", { detail: new Date() }))
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

  const handleRefresh = () => runAnalysis()
  const hasDebug = debugInfo !== null || debugError !== null

  // ── Loading skeleton ──────────────────────────────────────────────────────
  if (isPending && !analysis) {
    return (
      <div className="space-y-4 animate-in fade-in duration-500">
        <div className="flex gap-4">
          <Skeleton className="h-28 flex-1" />
          <Skeleton className="h-28 flex-1" />
        </div>
        <Skeleton className="h-20 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (error && !analysis) {
    return (
      <div className="max-w-2xl mt-8 space-y-4">
        <Alert variant="destructive" className="bg-destructive/10 border-destructive/20">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Analysis Failed</AlertTitle>
          <AlertDescription className="mt-1 text-destructive/80">
            {(error as { error?: string })?.error ??
              "An unexpected error occurred while fetching market intelligence."}
          </AlertDescription>
        </Alert>
        <div className="flex items-center gap-2">
          <Button onClick={handleRefresh} variant="outline">
            <RefreshCw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
          {hasDebug && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => setDebugOpen(true)}
              title="Show debug info"
            >
              <Info className="h-4 w-4" />
            </Button>
          )}
        </div>
        <DebugDialog
          open={debugOpen}
          onClose={() => setDebugOpen(false)}
          debugInfo={debugInfo}
          error={debugError}
        />
      </div>
    )
  }

  // ── Empty / initial state ─────────────────────────────────────────────────
  if (!analysis) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center max-w-lg mx-auto">
        <div className="h-20 w-20 bg-primary/10 rounded-full flex items-center justify-center mb-6 ring-1 ring-primary/20 shadow-[0_0_40px_rgba(37,99,235,0.2)]">
          <Activity className="h-10 w-10 text-primary" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight mb-3 text-foreground">Market Intelligence</h2>
        <p className="text-muted-foreground mb-8 leading-relaxed">
          Initialize the AI investment engine to process real-time market sentiment,
          sector strength, and emerging risks using live web research.
        </p>
        <Button
          onClick={handleRefresh}
          size="lg"
          className="h-11 px-8 font-medium"
          data-testid="button-initialize"
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Initialize Monitor
        </Button>
      </div>
    )
  }

  // ── Badge variants ────────────────────────────────────────────────────────
  const sentimentVariant =
    analysis.marketSentiment === "Positive" ? "positive"
    : analysis.marketSentiment === "Negative" ? "negative"
    : "warning"

  const riskVariant =
    analysis.riskLevel === "Low" ? "positive"
    : analysis.riskLevel === "High" ? "negative"
    : "warning"

  // ── Analysis view ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-3 pb-8 animate-in fade-in slide-in-from-bottom-2 duration-500">

      {/* ── Summary card — always visible ── */}
      <Card className="bg-card/60 border-card-border/50">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-4">

            {/* Left: title + metadata */}
            <div className="min-w-0">
              <h2 className="text-xs font-bold tracking-widest uppercase text-muted-foreground mb-1.5">
                Market Monitor
              </h2>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">Sentiment</span>
                  <Badge variant={sentimentVariant} className="text-sm uppercase tracking-wider px-2 py-0.5">
                    {analysis.marketSentiment === "Positive" ? (
                      <TrendingUp className="h-3 w-3 mr-1" />
                    ) : analysis.marketSentiment === "Negative" ? (
                      <TrendingDown className="h-3 w-3 mr-1" />
                    ) : null}
                    {analysis.marketSentiment}
                  </Badge>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">Risk</span>
                  <Badge variant={riskVariant} className="text-sm uppercase tracking-wider px-2 py-0.5">
                    {analysis.riskLevel}
                  </Badge>
                </div>
                <div className="hidden sm:flex items-center gap-3 text-[11px] text-muted-foreground/50">
                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{format(new Date(analysis.timestamp), "HH:mm 'UTC'")}</span>
                  <span className="flex items-center gap-1"><Timer className="h-3 w-3" />{formatDuration(analysis.analysisDuration)}</span>
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
              {analysis.sources && analysis.sources.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => setSourcesOpen(true)}
                  title="View sources"
                >
                  <Globe className="h-3.5 w-3.5" />
                  <span className="text-xs hidden sm:inline">Sources ({analysis.sources.length})</span>
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

      {/* ── Summary ── */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4">
          <p className="text-sm leading-relaxed text-foreground/90">{analysis.summary}</p>
        </CardContent>
      </Card>

      {/* ── 2×2 detail grid ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

        <Card className="border-card-border/50">
          <CardHeader className="py-3 px-4 border-b border-border/50">
            <CardTitle className="text-xs font-bold uppercase tracking-widest flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-emerald-500" /> Positive Factors
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <ul className="space-y-2">
              {analysis.positiveFactors.map((f, i) => (
                <li key={i} className="flex items-start gap-2.5 text-sm">
                  <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
                  <span className="text-foreground/80 leading-snug">{f}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card className="border-card-border/50">
          <CardHeader className="py-3 px-4 border-b border-border/50">
            <CardTitle className="text-xs font-bold uppercase tracking-widest flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-rose-500" /> Negative Factors
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <ul className="space-y-2">
              {analysis.negativeFactors.map((f, i) => (
                <li key={i} className="flex items-start gap-2.5 text-sm">
                  <div className="h-1.5 w-1.5 rounded-full bg-rose-500 mt-1.5 shrink-0" />
                  <span className="text-foreground/80 leading-snug">{f}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card className="border-card-border/50">
          <CardHeader className="py-3 px-4 border-b border-border/50">
            <CardTitle className="text-xs font-bold uppercase tracking-widest">
              Sector Rotation
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 grid grid-cols-2 gap-4">
            <div>
              <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">
                Strong Sectors
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {analysis.strongSectors.map((s, i) => (
                  <Badge key={i} variant="outline" className="text-[11px] bg-emerald-500/10 border-emerald-500/20 text-emerald-400">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>
            <div>
              <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">
                Weak Sectors
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {analysis.weakSectors.map((s, i) => (
                  <Badge key={i} variant="outline" className="text-[11px] bg-rose-500/10 border-rose-500/20 text-rose-400">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-amber-500/20 bg-amber-500/5">
          <CardHeader className="py-3 px-4 border-b border-amber-500/10">
            <CardTitle className="text-xs font-bold uppercase tracking-widest flex items-center gap-2 text-amber-400">
              <AlertTriangle className="h-4 w-4" /> Key Risks
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <ul className="space-y-2">
              {analysis.keyRisks.map((r, i) => (
                <li key={i} className="flex items-start gap-2.5 bg-background/40 p-2.5 rounded border border-border/40">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                  <span className="text-sm text-foreground/90 leading-snug">{r}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

      </div>

        </div>
      )}

      <SourcesDialog
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        sources={analysis.sources ?? []}
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
  // Pull out messages/input from the request regardless of which API was used
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
              <Section label="❌ Error" color="rose">
                <pre className="whitespace-pre-wrap text-rose-400 break-all">
                  {error instanceof Error
                    ? JSON.stringify({ message: error.message, stack: error.stack }, null, 2)
                    : JSON.stringify(error, null, 2)}
                </pre>
              </Section>
            )}

            {debugInfo ? (
              <>
                <Section
                  label="📤 Sent to OpenAI"
                  color="blue"
                  copyText={inputMessages.map(m => `[${m.role}]\n${m.content}`).join("\n\n")}
                >
                  <div className="space-y-1.5 mb-3">
                    <Row label="API" value={debugInfo.webSearchUsed ? "Responses API + web_search" : "Chat Completions"} />
                    <Row label="Model" value={String(debugInfo.request.model ?? "—")} />
                    <Row label="Temperature" value={String(debugInfo.request.temperature ?? "—")} />
                    <Row label="Max tokens" value={String(
                      debugInfo.request.max_tokens ??
                      debugInfo.request.max_output_tokens ??
                      "—"
                    )} />
                    {!!debugInfo.request.response_format && (
                      <Row label="Response format" value={String((debugInfo.request.response_format as { type?: string })?.type ?? "—")} />
                    )}
                    {!!debugInfo.request.tools && (
                      <Row label="Tools" value={JSON.stringify(debugInfo.request.tools)} />
                    )}
                    <Row label="Called at" value={debugInfo.calledAt} />
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
                </Section>

                <Section
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
                </Section>
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

// ── Sub-components ────────────────────────────────────────────────────────────

function Section({
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

  const borderColor =
    color === "blue" ? "border-blue-500/30" :
    color === "emerald" ? "border-emerald-500/30" :
    "border-rose-500/30"
  const labelColor =
    color === "blue" ? "text-blue-400" :
    color === "emerald" ? "text-emerald-400" :
    "text-rose-400"

  return (
    <div className={`border ${borderColor} rounded p-3`}>
      <div className="flex items-center justify-between mb-2">
        <p className={`text-[10px] font-bold uppercase tracking-widest ${labelColor}`}>{label}</p>
        {copyText && (
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-white/5"
            title="Copy as plain text"
          >
            {copied
              ? <><Check className="h-3 w-3 text-emerald-400" /><span className="text-emerald-400">Copied</span></>
              : <><Copy className="h-3 w-3" /><span>Copy</span></>
            }
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
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
  sources: MarketAnalysisSource[]
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
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-2.5 group"
              >
                <ExternalLink className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground/40 group-hover:text-primary transition-colors" />
                <div className="min-w-0">
                  <p className="text-sm text-foreground/80 group-hover:text-foreground group-hover:underline underline-offset-2 transition-colors leading-snug">
                    {source.title}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    {source.published && (
                      <>
                        <span className="text-[11px] text-muted-foreground/60 font-mono">
                          {source.published}
                        </span>
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
