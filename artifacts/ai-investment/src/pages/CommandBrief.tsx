/**
 * Command Brief Page
 *
 * Compact executive summary of the current state of the AI Investor system.
 * Designed to be understood in approximately 20 seconds.
 *
 * Information/summary module only. Does not make investment decisions.
 */
import { useState } from "react"
import { useRunCommandBrief, useGetRepositoryEntry } from "@workspace/api-client-react"
import type { CommandBriefAnalysis, CommandBriefItem } from "@workspace/api-client-react"
import {
  RefreshCw,
  Info,
  Clock,
  Timer,
  Eye,
  Copy,
  Check,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  AlertCircle,
  Minus,
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

function severityColor(severity: string): string {
  if (severity === "positive") return "text-green-400"
  if (severity === "watch")    return "text-blue-400"
  if (severity === "warning")  return "text-yellow-400"
  if (severity === "critical") return "text-red-400"
  return "text-muted-foreground"
}

function SeverityIcon({ severity }: { severity: string }) {
  const cls = `h-4 w-4 shrink-0 ${severityColor(severity)}`
  if (severity === "positive") return <CheckCircle2 className={cls} />
  if (severity === "warning")  return <AlertTriangle className={cls} />
  if (severity === "critical") return <XCircle className={cls} />
  if (severity === "watch")    return <Eye className={cls} />
  return <Minus className={cls} />
}

function overallStatusBadgeVariant(status: string) {
  if (status === "normal")    return "positive" as const
  if (status === "attention") return "warning" as const
  return "negative" as const
}

function overallStatusLabel(status: string): string {
  if (status === "normal")    return "Normal"
  if (status === "attention") return "Attention"
  return "Action Required"
}

function actionStatusColor(status: string): string {
  if (status === "none")    return "text-green-400"
  if (status === "monitor") return "text-muted-foreground"
  if (status === "review")  return "text-yellow-400"
  return "text-red-400"
}

function categoryLabel(cat: string): string {
  const map: Record<string, string> = {
    system:      "System",
    portfolio:   "Portfolio",
    risk:        "Risk",
    market:      "Market",
    stock:       "Stock",
    event:       "Event",
    opportunity: "Opportunity",
    action:      "Action",
  }
  return map[cat] ?? cat
}

// ---------------------------------------------------------------------------
// Brief item card
// ---------------------------------------------------------------------------

function BriefItemRow({ item }: { item: CommandBriefItem }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border/20 last:border-0">
      <SeverityIcon severity={item.severity} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            {categoryLabel(item.category)}
          </Badge>
          {item.symbol && (
            <span className="text-xs font-mono font-semibold text-foreground/80">
              {item.symbol}
            </span>
          )}
        </div>
        <p className={`text-sm leading-snug ${severityColor(item.severity)}`}>
          {item.text}
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Language preference — persisted in localStorage, affects only whatThisMeans
// ---------------------------------------------------------------------------

const LANG_KEY = "commandBriefExplanationLanguage"

function readStoredLang(): "en" | "da" {
  try {
    const v = localStorage.getItem(LANG_KEY)
    return v === "da" ? "da" : "en"
  } catch {
    return "en"
  }
}

function storeLang(lang: "en" | "da"): void {
  try { localStorage.setItem(LANG_KEY, lang) } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function CommandBrief() {
  const [debugOpen, setDebugOpen] = useState(false)
  const [lastDebug, setLastDebug] = useState<AiDebugInfo | undefined>()
  const [lastError, setLastError] = useState<unknown>(null)
  const [visibleError, setVisibleError] = useState<string | null>(null)
  const [lang, setLang] = useState<"en" | "da">(readStoredLang)

  const { data: entry, isLoading: isLoadingData, refetch } = useGetRepositoryEntry("command-brief")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (entry as any)?.result as CommandBriefAnalysis | undefined
  const updatedAt = (entry as any)?.updatedAt as string | undefined

  const { mutate: run, isPending: isRunning } = useRunCommandBrief({
    mutation: {
      onSuccess: (result) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setLastDebug((result as any)._debug as AiDebugInfo | undefined)
        setLastError(null)
        void refetch()
      },
      onError: (err) => {
        setLastError(err)
        // Extract the server-side error message from the ApiError payload
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload = (err as any)?.payload as Record<string, unknown> | undefined
        const msg =
          (payload?.error as string | undefined) ??
          (err instanceof Error ? err.message : String(err))
        setVisibleError(msg)
      },
    },
  })

  /** Switch language preference — NO analysis call, only saves to localStorage. */
  function handleLangChange(next: "en" | "da") {
    setLang(next)
    storeLang(next)
  }

  const analysisDuration = (data as Record<string, unknown> | undefined)?.analysisDuration as number | undefined

  return (
    <div className="min-h-screen bg-background text-foreground p-4 md:p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-sm font-bold uppercase tracking-widest text-foreground">
            Command Brief
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Executive summary of the current investment system state
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDebugOpen(true)}
              className="h-7 gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <Eye className="h-3.5 w-3.5" />
              Debug
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => run({ explanationLanguage: lang })}
            disabled={isRunning}
            className="h-7 gap-1.5 text-[11px]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRunning ? "animate-spin" : ""}`} />
            {isRunning ? "Generating…" : "Run Analysis"}
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {visibleError && (
        <div className="flex items-start gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm">
          <XCircle className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-red-300 mb-0.5">Analysis failed</p>
            <p className="text-red-200/80 break-words">{visibleError}</p>
          </div>
          <button
            onClick={() => setVisibleError(null)}
            className="shrink-0 text-red-400/60 hover:text-red-300"
          >
            ✕
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {isLoadingData && (
        <div className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-5/6" />
        </div>
      )}

      {/* No data */}
      {!isLoadingData && !data && (
        <Card className="bg-card/40 border-card-border/40">
          <CardContent className="p-8 text-center">
            <AlertCircle className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground mb-1">No Command Brief generated yet</p>
            <p className="text-xs text-muted-foreground/60">
              Click "Run Analysis" to generate the first brief
            </p>
          </CardContent>
        </Card>
      )}

      {/* Brief content */}
      {data && (
        <div className="space-y-4">
          {/* Status + timestamp */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={overallStatusBadgeVariant(data.overallStatus)} className="text-xs px-2 py-0.5">
              {overallStatusLabel(data.overallStatus)}
            </Badge>
            {updatedAt && (
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span>Updated {format(new Date(updatedAt), "HH:mm")} · {format(new Date(updatedAt), "d MMM")}</span>
              </div>
            )}
            {analysisDuration !== undefined && (
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Timer className="h-3 w-3" />
                <span>{formatDuration(analysisDuration)}</span>
              </div>
            )}
          </div>

          {/* Headline */}
          <Card className="bg-card/40 border-card-border/40">
            <CardContent className="p-4">
              <p className={`text-base font-semibold leading-snug ${
                data.overallStatus === "normal" ? "text-green-400" :
                data.overallStatus === "attention" ? "text-yellow-400" : "text-red-400"
              }`}>
                {data.headline}
              </p>
            </CardContent>
          </Card>

          {/* Items */}
          {data.items.length > 0 && (
            <Card className="bg-card/40 border-card-border/40">
              <CardContent className="p-4 pt-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 mb-1">
                  Situation
                </p>
                <div>
                  {data.items.map((item, i) => (
                    <BriefItemRow key={i} item={item} />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* What This Means — plain-language explanation */}
          {data.whatThisMeans && (
            <Card className="bg-card/40 border-card-border/40">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
                    {lang === "da" ? "Hvad betyder det?" : "What This Means"}
                  </p>
                  {/* EN / DA toggle — saves preference only, no API call */}
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleLangChange("en")}
                      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded transition-colors ${
                        lang === "en"
                          ? "bg-primary/20 text-primary"
                          : "text-muted-foreground/50 hover:text-muted-foreground"
                      }`}
                      title="Show explanation in English (takes effect on next run)"
                    >
                      EN
                    </button>
                    <span className="text-muted-foreground/30 text-[10px]">|</span>
                    <button
                      onClick={() => handleLangChange("da")}
                      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded transition-colors ${
                        lang === "da"
                          ? "bg-primary/20 text-primary"
                          : "text-muted-foreground/50 hover:text-muted-foreground"
                      }`}
                      title="Vis forklaring på dansk (træder i kraft ved næste kørsel)"
                    >
                      DA
                    </button>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {data.whatThisMeans}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Action Status — prominent */}
          {data.actionStatus && (
            <Card className="bg-card/40 border-card-border/40">
              <CardContent className="p-4">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 mb-2">
                  Action Status
                </p>
                <p className={`text-sm font-bold uppercase tracking-wide ${actionStatusColor(data.actionStatus.status)}`}>
                  {data.actionStatus.text}
                </p>
                {data.actionStatus.status === "trade_ready" && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Open Trade Review to approve or reject pending trades.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Debug dialog */}
      <DebugDialog
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
        debugInfo={lastDebug}
        error={lastError}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Debug Dialog — mirrors the pattern used in other module pages
// ---------------------------------------------------------------------------

interface DebugDialogProps {
  open: boolean
  onClose: () => void
  debugInfo: AiDebugInfo | undefined
  error: unknown
}

function DebugDialog({ open, onClose, debugInfo, error }: DebugDialogProps) {
  const inputMessages: Array<{ role: string; content: string }> = (() => {
    if (!debugInfo) return []
    const req = debugInfo.request
    if (Array.isArray(req.messages)) return req.messages as Array<{ role: string; content: string }>
    if (Array.isArray(req.input))    return req.input as Array<{ role: string; content: string }>
    return []
  })()

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-3xl bg-[#0d1117] border-border text-foreground">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold uppercase tracking-widest flex items-center gap-2">
            <Info className="h-4 w-4 text-primary" />
            OpenAI Debug — Command Brief
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
                    <DebugRow label="API"        value="Chat Completions (no web search)" />
                    <DebugRow label="Model"      value={String(debugInfo.request.model ?? "—")} />
                    <DebugRow label="Temperature" value={String(debugInfo.request.temperature ?? "—")} />
                    <DebugRow label="Max tokens" value={String(debugInfo.request.max_tokens ?? "—")} />
                    <DebugRow label="Called at"  value={debugInfo.calledAt} />
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
              <p className="text-muted-foreground">No debug data available yet. Run analysis first.</p>
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
  const text   = color === "blue" ? "text-blue-400"      : color === "emerald" ? "text-emerald-400"      : "text-rose-400"
  return (
    <div className={`border ${border} rounded p-3`}>
      <div className="flex items-center justify-between mb-2">
        <p className={`text-[10px] font-bold uppercase tracking-widest ${text}`}>{label}</p>
        {copyText && (
          <button
            onClick={() => { navigator.clipboard.writeText(copyText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800) }) }}
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
