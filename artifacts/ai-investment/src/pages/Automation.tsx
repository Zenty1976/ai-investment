/**
 * Automation Orchestrator Dashboard
 *
 * Displays and controls the central automation orchestrator:
 * mode selection, pause/resume, run-all, per-module status rows
 * with live countdowns, and expandable per-module settings.
 */
import { useState, useEffect, useCallback } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { customFetch, useOpenAIUsageStats } from "@workspace/api-client-react"
import type {
  OrchestratorStatus,
  OrchestratorModuleStatus,
  ModuleFreshness,
  AutomationMode,
  OrchestratorModuleSettings,
  OrchestratorModuleId,
  OpenAIUsageStats,
  OpenAITimeWindow,
} from "@workspace/api-client-react"
import {
  Cpu,
  Play,
  Pause,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Save,
  AlertTriangle,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Timer,
  Zap,
  Info,
  BarChart3,
  SkipForward,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { formatDistanceToNowStrict, format } from "date-fns"

// ── OpenAI Usage Panel ───────────────────────────────────────────────────────

const WINDOWS: { value: OpenAITimeWindow; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "24h",   label: "24h" },
  { value: "7d",    label: "7 days" },
  { value: "30d",   label: "30 days" },
]

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtCost(usd: number | null): string {
  if (usd === null) return "—"
  if (usd < 0.001) return "<$0.001"
  return `$${usd.toFixed(3)}`
}

function moduleLabel(m: string): string {
  return m
    .replace(/-/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase())
}

function OpenAIUsagePanel() {
  const [window, setWindow] = useState<OpenAITimeWindow>("today")
  const { data, isLoading } = useOpenAIUsageStats(window)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary/70" />
            <CardTitle className="text-sm font-semibold">OpenAI Usage</CardTitle>
          </div>
          {/* Window selector */}
          <div className="flex items-center gap-1 rounded-md border border-border/60 p-0.5 bg-muted/20">
            {WINDOWS.map(w => (
              <button
                key={w.value}
                onClick={() => setWindow(w.value)}
                className={`px-2.5 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  window === w.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading || !data ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading usage data…
          </div>
        ) : (
          <>
            {/* ── Summary row ── */}
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-4 lg:grid-cols-8">
              {[
                { label: "Input",     value: fmtTokens(data.promptTokens),     sub: "tokens" },
                { label: "Output",    value: fmtTokens(data.completionTokens), sub: "tokens" },
                { label: "Cached",    value: fmtTokens(data.cachedTokens),     sub: "tokens" },
                { label: "Total",     value: fmtTokens(data.totalTokens),      sub: "tokens", bold: true },
                { label: "API calls", value: String(data.successCalls),        sub: `of ${data.totalCalls} total` },
                { label: "Web srch",  value: String(data.webSearches),         sub: "searches" },
                { label: "Retries",   value: String(data.retries),             sub: "retried calls" },
                { label: "Skipped",   value: String(data.skippedCalls),        sub: "AI calls saved" },
              ].map(s => (
                <div key={s.label} className="flex flex-col gap-0.5 p-2 rounded-md bg-muted/30">
                  <div className={`text-base font-bold tabular-nums leading-none ${s.bold ? "text-primary" : ""}`}>
                    {s.value}
                  </div>
                  <div className="text-[9px] text-muted-foreground font-medium uppercase tracking-wide">{s.label}</div>
                  <div className="text-[9px] text-muted-foreground/60">{s.sub}</div>
                </div>
              ))}
            </div>

            {/* Estimated cost */}
            {data.estimatedCostUsd !== null && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground border-t border-border/40 pt-3">
                <span className="font-medium text-foreground/80">Estimated cost:</span>
                <span className="font-mono tabular-nums text-foreground">{fmtCost(data.estimatedCostUsd)}</span>
                <span className="text-muted-foreground/60 text-[10px]">· Model pricing may be stale</span>
                {data.skippedCalls > 0 && data.totalCalls > 0 && (
                  <>
                    <span className="mx-1 text-border">·</span>
                    <SkipForward className="h-3 w-3 text-emerald-400/80" />
                    <span className="text-emerald-400/80">
                      {data.skippedCalls} AI calls avoided ({Math.round(data.skippedCalls / (data.totalCalls + data.skippedCalls) * 100)}% skip rate)
                    </span>
                  </>
                )}
              </div>
            )}

            {/* ── Module breakdown ── */}
            {data.byModule.length > 0 && (
              <div className="border-t border-border/40 pt-3">
                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-2">Module breakdown</div>
                <div className="space-y-1">
                  {/* Header row */}
                  <div className="grid grid-cols-[1fr_60px_60px_60px_48px_48px_56px] gap-x-2 text-[9px] text-muted-foreground/60 uppercase tracking-wide font-medium px-2 pb-1 border-b border-border/30">
                    <span>Module</span>
                    <span className="text-right">Input</span>
                    <span className="text-right">Output</span>
                    <span className="text-right">Total</span>
                    <span className="text-right">Calls</span>
                    <span className="text-right">Skip</span>
                    <span className="text-right">Est. cost</span>
                  </div>
                  {data.byModule.map(m => (
                    <div
                      key={m.module}
                      className="grid grid-cols-[1fr_60px_60px_60px_48px_48px_56px] gap-x-2 items-center px-2 py-1 rounded hover:bg-muted/30 text-xs"
                    >
                      <span className="font-medium text-foreground/80 truncate" title={m.module}>{moduleLabel(m.module)}</span>
                      <span className="text-right tabular-nums text-muted-foreground">{fmtTokens(m.promptTokens)}</span>
                      <span className="text-right tabular-nums text-muted-foreground">{fmtTokens(m.completionTokens)}</span>
                      <span className="text-right tabular-nums font-medium">{fmtTokens(m.totalTokens)}</span>
                      <span className="text-right tabular-nums text-muted-foreground">
                        {m.successCalls}{m.retries > 0 && <span className="text-amber-400/70 ml-0.5">+{m.retries}r</span>}
                      </span>
                      <span className="text-right tabular-nums text-emerald-400/70">{m.skippedCalls || "—"}</span>
                      <span className="text-right tabular-nums text-muted-foreground">{fmtCost(m.estimatedCostUsd)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.byModule.length === 0 && (
              <div className="text-xs text-muted-foreground/60 py-2">
                No API calls recorded yet for this window. Usage is tracked from server start.
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ── Hooks ────────────────────────────────────────────────────────────────────

function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

const STATUS_KEY = ["automation-status"] as const

function useAutomationStatus() {
  return useQuery<OrchestratorStatus>({
    queryKey: STATUS_KEY,
    queryFn: () => customFetch<OrchestratorStatus>("/api/automation/status"),
    refetchInterval: 5_000,
    staleTime: 4_000,
  })
}

function useSetMode() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (mode: AutomationMode) =>
      customFetch("/api/automation/mode", {
        method: "POST",
        body: JSON.stringify({ mode }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  })
}

function usePause() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => customFetch("/api/automation/pause", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  })
}

function useResume() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => customFetch("/api/automation/resume", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  })
}

function useRunAll() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => customFetch("/api/automation/run-all", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  })
}

function useForceRunAll() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => customFetch("/api/automation/run-all-force", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  })
}

function useRunModule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ moduleId, ticker }: { moduleId: OrchestratorModuleId; ticker?: string }) =>
      customFetch(`/api/automation/run/${moduleId}`, {
        method: "POST",
        body: JSON.stringify(ticker ? { ticker } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  })
}

function useUpdateSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ moduleId, settings }: { moduleId: OrchestratorModuleId; settings: Partial<OrchestratorModuleSettings> }) =>
      customFetch(`/api/automation/modules/${moduleId}/settings`, {
        method: "PUT",
        body: JSON.stringify(settings),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  })
}

function useResetSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (moduleId: OrchestratorModuleId) =>
      customFetch(`/api/automation/modules/${moduleId}/settings`, {
        method: "PUT",
        body: JSON.stringify({ reset: true }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatCountdown(nextRunAt: string | null, now: Date): string {
  if (!nextRunAt) return "—"
  const diffMs = new Date(nextRunAt).getTime() - now.getTime()
  if (diffMs <= 0) return "Due now"
  const totalSecs = Math.floor(diffMs / 1000)
  const hours = Math.floor(totalSecs / 3600)
  const mins  = Math.floor((totalSecs % 3600) / 60)
  const secs  = totalSecs % 60
  if (hours > 0)  return `${hours}h ${mins}m`
  if (mins > 0)   return `${mins}m ${secs}s`
  return `${secs}s`
}

function formatRelative(iso: string | null): string {
  if (!iso) return "Never"
  try {
    return formatDistanceToNowStrict(new Date(iso), { addSuffix: true })
  } catch {
    return "—"
  }
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—"
  try {
    return format(new Date(iso), "HH:mm:ss d MMM")
  } catch {
    return "—"
  }
}

// ── Freshness badge ──────────────────────────────────────────────────────────

const FRESHNESS: Record<ModuleFreshness, { label: string; className: string }> = {
  Fresh:                { label: "Fresh",         className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25" },
  DueSoon:              { label: "Due soon",       className: "bg-amber-500/10 text-amber-400 border-amber-500/25" },
  Stale:                { label: "Stale",          className: "bg-red-500/10 text-red-400 border-red-500/25" },
  Running:              { label: "Running",        className: "bg-blue-500/10 text-blue-400 border-blue-500/25 animate-pulse" },
  Failed:               { label: "Failed",         className: "bg-red-500/15 text-red-300 border-red-500/40" },
  Disabled:             { label: "Disabled",       className: "bg-muted/50 text-muted-foreground border-muted/50" },
  WaitingForDependency: { label: "Waiting",        className: "bg-amber-500/10 text-amber-400 border-amber-500/25" },
  NeverRun:             { label: "Never run",      className: "bg-muted/30 text-muted-foreground border-muted/30" },
}

function FreshnessBadge({ freshness }: { freshness: ModuleFreshness }) {
  const cfg = FRESHNESS[freshness]
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide border ${cfg.className}`}>
      {freshness === "Running" && <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />}
      {cfg.label}
    </span>
  )
}

// ── Module row ───────────────────────────────────────────────────────────────

interface ModuleRowProps {
  mod: OrchestratorModuleStatus
  now: Date
  runModule: ReturnType<typeof useRunModule>
  updateSettings: ReturnType<typeof useUpdateSettings>
  resetSettings: ReturnType<typeof useResetSettings>
}

function ModuleRow({ mod, now, runModule, updateSettings, resetSettings }: ModuleRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<OrchestratorModuleSettings>(mod.settings)
  const [ticker, setTicker] = useState("")
  const [saved, setSaved] = useState(false)

  // Sync draft when settings change externally
  useEffect(() => {
    setDraft(mod.settings)
  }, [mod.settings])

  const isCompanyMonitor = mod.moduleId === "company-monitor"
  const isRunning = runModule.isPending && (runModule.variables as { moduleId: string })?.moduleId === mod.moduleId

  const handleRun = useCallback(() => {
    if (isCompanyMonitor && !ticker.trim()) return
    runModule.mutate({ moduleId: mod.moduleId, ticker: ticker.trim() || undefined })
  }, [mod.moduleId, ticker, runModule, isCompanyMonitor])

  const handleSave = useCallback(() => {
    updateSettings.mutate({ moduleId: mod.moduleId, settings: draft })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [mod.moduleId, draft, updateSettings])

  const handleReset = useCallback(() => {
    resetSettings.mutate(mod.moduleId)
  }, [mod.moduleId, resetSettings])

  const countdown = formatCountdown(mod.nextRunAt, now)

  return (
    <div className="border-b border-border last:border-0">
      {/* ── Compact row ── */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Name */}
        <div className="w-44 shrink-0">
          <div className="text-sm font-medium text-foreground">{mod.displayName}</div>
          {mod.runtime.waitingForDeps.length > 0 && (
            <div className="text-[10px] text-amber-400 mt-0.5">
              Waiting for: {mod.runtime.waitingForDeps.join(", ")}
            </div>
          )}
          {mod.runtime.lastSkippedUnchanged && mod.freshness === "Fresh" && (
            <div className="text-[10px] text-blue-400/70 mt-0.5">Skipped — unchanged</div>
          )}
        </div>

        {/* Freshness */}
        <div className="w-28 shrink-0">
          <FreshnessBadge freshness={mod.freshness} />
        </div>

        {/* Last updated */}
        <div className="hidden md:block w-32 shrink-0 text-xs text-muted-foreground">
          {mod.lastUpdatedAt ? (
            <span title={formatTimestamp(mod.lastUpdatedAt)}>
              {formatRelative(mod.lastUpdatedAt)}
            </span>
          ) : (
            <span className="opacity-50">Never</span>
          )}
        </div>

        {/* Next run countdown */}
        <div className="hidden lg:flex items-center gap-1.5 w-24 shrink-0">
          {mod.freshness === "Running" ? (
            <span className="text-xs text-blue-400">Running…</span>
          ) : mod.settings.supportsAutomaticRun && mod.nextRunAt ? (
            <>
              <Timer className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="text-xs font-mono tabular-nums text-muted-foreground">{countdown}</span>
            </>
          ) : (
            <span className="text-xs text-muted-foreground/50">—</span>
          )}
        </div>

        {/* Interval */}
        <div className="hidden xl:block w-20 shrink-0 text-xs text-muted-foreground">
          {mod.settings.enabled
            ? `${mod.settings.intervalMinutes}m`
            : <span className="opacity-50">disabled</span>}
        </div>

        {/* Run now */}
        <div className="ml-auto flex items-center gap-2">
          {isCompanyMonitor ? (
            expanded ? (
              <span className="text-[10px] text-muted-foreground">Set ticker below</span>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setExpanded(true)}
                disabled={isRunning}
                className="h-7 text-xs px-2"
              >
                Run…
              </Button>
            )
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRun}
              disabled={isRunning || mod.freshness === "Disabled" || !mod.settings.enabled}
              className="h-7 text-xs px-2"
            >
              {isRunning ? (
                <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Running</>
              ) : (
                <><Play className="h-3 w-3 mr-1" />Run</>
              )}
            </Button>
          )}

          <button
            onClick={() => setExpanded(v => !v)}
            className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
            aria-label={expanded ? "Collapse settings" : "Expand settings"}
          >
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* ── Expanded settings ── */}
      {expanded && (
        <div className="px-4 pb-4 bg-muted/20 border-t border-border/50">
          <div className="pt-3 space-y-4">

            {/* Company Monitor ticker input */}
            {isCompanyMonitor && (
              <div className="flex items-end gap-2">
                <div className="flex-1 max-w-xs">
                  <Label className="text-xs text-muted-foreground mb-1 block">Run for ticker</Label>
                  <Input
                    value={ticker}
                    onChange={e => setTicker(e.target.value.toUpperCase())}
                    placeholder="e.g. NVDA"
                    className="h-8 text-sm font-mono"
                    onKeyDown={e => e.key === "Enter" && handleRun()}
                  />
                </div>
                <Button
                  size="sm"
                  onClick={handleRun}
                  disabled={!ticker.trim() || isRunning}
                  className="h-8 px-3 text-xs"
                >
                  {isRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
                  Run
                </Button>
              </div>
            )}

            {mod.runtime.lastError && (
              <div className="flex items-start gap-2 p-2 rounded bg-red-500/10 border border-red-500/20">
                <XCircle className="h-3.5 w-3.5 text-red-400 mt-0.5 shrink-0" />
                <p className="text-xs text-red-400 break-words">{mod.runtime.lastError}</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {/* Enabled */}
              <div className="flex items-center gap-2">
                <Switch
                  id={`${mod.moduleId}-enabled`}
                  checked={draft.enabled}
                  onCheckedChange={v => setDraft(d => ({ ...d, enabled: v }))}
                />
                <Label htmlFor={`${mod.moduleId}-enabled`} className="text-xs">Enabled</Label>
              </div>

              {/* Auto-run */}
              <div className="flex items-center gap-2">
                <Switch
                  id={`${mod.moduleId}-autorun`}
                  checked={draft.supportsAutomaticRun}
                  onCheckedChange={v => setDraft(d => ({ ...d, supportsAutomaticRun: v }))}
                />
                <Label htmlFor={`${mod.moduleId}-autorun`} className="text-xs">Auto-run</Label>
              </div>

              {/* Interval */}
              <div>
                <Label className="text-xs text-muted-foreground block mb-1">
                  Interval (min) — min {mod.defaults.minimumIntervalMinutes}
                </Label>
                <Input
                  type="number"
                  value={draft.intervalMinutes}
                  min={mod.defaults.minimumIntervalMinutes}
                  max={mod.defaults.maximumIntervalMinutes}
                  onChange={e => setDraft(d => ({ ...d, intervalMinutes: Number(e.target.value) }))}
                  className="h-7 text-sm w-24"
                />
              </div>

              {/* Stale threshold */}
              <div>
                <Label className="text-xs text-muted-foreground block mb-1">Stale after (min)</Label>
                <Input
                  type="number"
                  value={draft.staleAfterMinutes}
                  min={mod.defaults.minimumIntervalMinutes}
                  onChange={e => setDraft(d => ({ ...d, staleAfterMinutes: Number(e.target.value) }))}
                  className="h-7 text-sm w-24"
                />
              </div>

              {/* Priority */}
              <div>
                <Label className="text-xs text-muted-foreground block mb-1">Priority</Label>
                <Input
                  type="number"
                  value={draft.priority}
                  min={1}
                  max={100}
                  onChange={e => setDraft(d => ({ ...d, priority: Number(e.target.value) }))}
                  className="h-7 text-sm w-24"
                />
              </div>
            </div>

            {/* Dependencies info */}
            {mod.defaults.dependencies.length > 0 && (
              <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
                <Info className="h-3 w-3 mt-0.5 shrink-0" />
                <span>Depends on: {mod.defaults.dependencies.join(", ")}</span>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={updateSettings.isPending}
                className="h-7 text-xs px-3"
              >
                {saved ? (
                  <><CheckCircle2 className="h-3 w-3 mr-1 text-emerald-400" />Saved</>
                ) : (
                  <><Save className="h-3 w-3 mr-1" />Save</>
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReset}
                disabled={resetSettings.isPending}
                className="h-7 text-xs px-3 text-muted-foreground"
              >
                <RotateCcw className="h-3 w-3 mr-1" />Reset to defaults
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Mode selector ─────────────────────────────────────────────────────────────

const MODES: { value: AutomationMode; label: string; description: string; disabled?: boolean }[] = [
  { value: "Manual",        label: "Manual",        description: "Modules run only when you click Run" },
  { value: "SemiAutomatic", label: "Semi-automatic", description: "Modules run on schedule; trades still require manual approval" },
  { value: "FullAutomatic", label: "Full automatic", description: "Coming later", disabled: true },
]

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Automation() {
  const { data: status, isLoading, isError } = useAutomationStatus()
  const now = useNow()
  const setMode = useSetMode()
  const pause = usePause()
  const resume = useResume()
  const runAll = useRunAll()
  const forceRunAll = useForceRunAll()
  const runModule = useRunModule()
  const updateSettings = useUpdateSettings()
  const resetSettings = useResetSettings()

  const [showRunAllConfirm, setShowRunAllConfirm] = useState(false)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh] gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading automation status…</span>
      </div>
    )
  }

  if (isError || !status) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <Alert variant="destructive" className="max-w-md">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Could not load automation status</AlertTitle>
          <AlertDescription>Check that the API server is running.</AlertDescription>
        </Alert>
      </div>
    )
  }

  const isSemiAuto = status.mode === "SemiAutomatic"
  const isPaused   = status.paused

  return (
    <div className="space-y-5 max-w-5xl">
      {/* ── Page header ── */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 ring-1 ring-primary/20">
          <Cpu className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-bold tracking-tight">Automation Orchestrator</h1>
          <p className="text-xs text-muted-foreground">Schedule and sequence all analysis modules from a single control panel</p>
        </div>
      </div>

      {/* ── Semi-automatic warning banner ── */}
      {isSemiAuto && !isPaused && (
        <Alert className="border-amber-500/30 bg-amber-500/5">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          <AlertTitle className="text-amber-400 text-sm">Semi-automatic mode active</AlertTitle>
          <AlertDescription className="text-xs text-amber-300/80">
            Analysis modules update automatically on schedule. <strong>Trades still require manual approval</strong> — the orchestrator never approves or executes orders.
          </AlertDescription>
        </Alert>
      )}

      {/* ── Control bar + stats ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Mode & control */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Automation Mode</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2">
              {MODES.map(m => (
                <button
                  key={m.value}
                  onClick={() => !m.disabled && setMode.mutate(m.value)}
                  disabled={m.disabled || setMode.isPending}
                  className={`flex items-start gap-3 px-3 py-2.5 rounded-md border text-left transition-all ${
                    m.disabled
                      ? "opacity-40 cursor-not-allowed border-border/30"
                      : status.mode === m.value
                        ? "border-primary/40 bg-primary/8 ring-1 ring-primary/20"
                        : "border-border/50 hover:border-border hover:bg-muted/30 cursor-pointer"
                  }`}
                >
                  <div className={`mt-0.5 h-3.5 w-3.5 rounded-full border-2 shrink-0 flex items-center justify-center ${
                    status.mode === m.value && !m.disabled
                      ? "border-primary bg-primary"
                      : "border-muted-foreground/40"
                  }`}>
                    {status.mode === m.value && !m.disabled && (
                      <div className="h-1.5 w-1.5 rounded-full bg-background" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      {m.label}
                      {m.disabled && <span className="ml-2 text-[10px] text-muted-foreground/60 font-normal">Coming later</span>}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">{m.description}</div>
                  </div>
                </button>
              ))}
            </div>

            <Separator />

            <div className="flex items-center gap-2 flex-wrap">
              {/* Pause / Resume */}
              {isSemiAuto && (
                isPaused ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resume.mutate()}
                    disabled={resume.isPending}
                    className="h-8 text-xs gap-1.5 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
                  >
                    <Play className="h-3.5 w-3.5" />
                    Resume
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => pause.mutate()}
                    disabled={pause.isPending}
                    className="h-8 text-xs gap-1.5 text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
                  >
                    <Pause className="h-3.5 w-3.5" />
                    Pause
                  </Button>
                )
              )}

              {/* Run all now */}
              {showRunAllConfirm ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Confirm 10-stage cycle?</span>
                  <Button
                    size="sm"
                    onClick={() => { runAll.mutate(); setShowRunAllConfirm(false) }}
                    disabled={runAll.isPending || status.cycleInProgress}
                    className="h-7 text-xs px-2 bg-primary"
                  >
                    Yes, run
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowRunAllConfirm(false)}
                    className="h-7 text-xs px-2"
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowRunAllConfirm(true)}
                  disabled={runAll.isPending || status.cycleInProgress}
                  className="h-8 text-xs gap-1.5"
                >
                  {status.cycleInProgress ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" />Cycle running…</>
                  ) : (
                    <><Zap className="h-3.5 w-3.5" />Run all now</>
                  )}
                </Button>
              )}

              {/* Force AI Refresh — bypasses fingerprint skip check */}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => forceRunAll.mutate()}
                disabled={forceRunAll.isPending || runAll.isPending || status.cycleInProgress}
                title="Force every AI module to rerun even if inputs are unchanged. Use for debugging."
                className="h-8 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${forceRunAll.isPending ? "animate-spin" : ""}`} />
                Force AI refresh
              </Button>

              {/* Last cycle */}
              <span className="text-[10px] text-muted-foreground ml-auto w-36 text-right shrink-0 tabular-nums">
                {status.lastFullCycleAt ? `Last cycle: ${formatRelative(status.lastFullCycleAt)}` : ""}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Stats */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">System Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              {/* Running */}
              <div className="flex items-center gap-2 p-2.5 rounded-md bg-muted/30">
                <div className="flex h-7 w-7 items-center justify-center rounded bg-blue-500/10">
                  <Loader2 className={`h-3.5 w-3.5 text-blue-400 ${status.stats.running > 0 ? "animate-spin" : ""}`} />
                </div>
                <div>
                  <div className="text-lg font-bold tabular-nums">{status.stats.running}</div>
                  <div className="text-[10px] text-muted-foreground">Running</div>
                </div>
              </div>

              {/* Stale */}
              <div className="flex items-center gap-2 p-2.5 rounded-md bg-muted/30">
                <div className="flex h-7 w-7 items-center justify-center rounded bg-red-500/10">
                  <Clock className="h-3.5 w-3.5 text-red-400" />
                </div>
                <div>
                  <div className="text-lg font-bold tabular-nums">{status.stats.stale}</div>
                  <div className="text-[10px] text-muted-foreground">Stale</div>
                </div>
              </div>

              {/* Failed */}
              <div className="flex items-center gap-2 p-2.5 rounded-md bg-muted/30">
                <div className="flex h-7 w-7 items-center justify-center rounded bg-red-500/10">
                  <XCircle className="h-3.5 w-3.5 text-red-400" />
                </div>
                <div>
                  <div className="text-lg font-bold tabular-nums">{status.stats.failed}</div>
                  <div className="text-[10px] text-muted-foreground">Failed</div>
                </div>
              </div>

              {/* Analyses today */}
              <div className="flex items-center gap-2 p-2.5 rounded-md bg-muted/30">
                <div className="flex h-7 w-7 items-center justify-center rounded bg-emerald-500/10">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                </div>
                <div>
                  <div className="text-lg font-bold tabular-nums">{status.stats.analysesToday}</div>
                  <div className="text-[10px] text-muted-foreground">Done today</div>
                </div>
              </div>
            </div>

            {/* Next scheduled */}
            {status.mode === "SemiAutomatic" && !isPaused && status.stats.nextScheduledJobAt && (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground border-t border-border pt-3">
                <Timer className="h-3 w-3 shrink-0" />
                <span>Next scheduled: {formatCountdown(status.stats.nextScheduledJobAt, now)}</span>
              </div>
            )}

            {status.mode === "Manual" && (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground border-t border-border pt-3">
                <Info className="h-3 w-3 shrink-0" />
                <span>Scheduler inactive — switch to Semi-automatic to enable automatic runs.</span>
              </div>
            )}

            {status.mode === "SemiAutomatic" && isPaused && (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-amber-400 border-t border-border pt-3">
                <Pause className="h-3 w-3 shrink-0" />
                <span>Scheduler paused — resume to re-enable automatic runs.</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Module list ── */}
      <Card>
        <CardHeader className="pb-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold">Module Status</CardTitle>
            <div className="hidden lg:flex items-center gap-6 text-[10px] text-muted-foreground font-medium tracking-wider uppercase pr-1">
              <span className="w-28">Freshness</span>
              <span className="w-32">Last update</span>
              <span className="w-24">Next run</span>
              <span className="w-20">Interval</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0 pt-2">
          {status.modules.map(mod => (
            <ModuleRow
              key={mod.moduleId}
              mod={mod}
              now={now}
              runModule={runModule}
              updateSettings={updateSettings}
              resetSettings={resetSettings}
            />
          ))}
        </CardContent>
      </Card>

      {/* ── OpenAI usage ── */}
      <OpenAIUsagePanel />

      {/* ── Recent jobs ── */}
      {status.jobs.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Recent Jobs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {status.jobs.slice(0, 20).map(job => (
                <div key={job.id} className="flex items-center gap-3 px-4 py-2 text-xs">
                  {/* Status icon */}
                  <div className="shrink-0 w-4">
                    {job.status === "Completed" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
                    {job.status === "Failed"    && <XCircle className="h-3.5 w-3.5 text-red-400" />}
                    {job.status === "Running"   && <Loader2 className="h-3.5 w-3.5 text-blue-400 animate-spin" />}
                    {job.status === "Pending"   && <Clock className="h-3.5 w-3.5 text-muted-foreground" />}
                    {job.status === "Cancelled" && <XCircle className="h-3.5 w-3.5 text-muted-foreground" />}
                    {job.status === "Skipped"   && <Info className={`h-3.5 w-3.5 ${job.skippedUnchanged ? "text-blue-400/60" : "text-muted-foreground"}`} />}
                  </div>

                  {/* Module + ticker */}
                  <span className="w-44 shrink-0 font-medium text-foreground/90">
                    {status.modules.find(m => m.moduleId === job.moduleId)?.displayName ?? job.moduleId}
                    {job.ticker && <span className="ml-1 text-muted-foreground font-mono">{job.ticker}</span>}
                  </span>

                  {/* Trigger */}
                  <Badge variant="outline" className="text-[9px] h-4 px-1.5 font-normal shrink-0">
                    {job.trigger}
                  </Badge>

                  {/* Duration */}
                  {job.durationMs && (
                    <span className="text-muted-foreground tabular-nums">
                      {job.durationMs < 1000 ? `${job.durationMs}ms` : `${(job.durationMs / 1000).toFixed(1)}s`}
                    </span>
                  )}

                  {/* Error */}
                  {job.error && (
                    <span className="text-red-400 truncate max-w-xs" title={job.error}>
                      {job.error}
                    </span>
                  )}

                  {/* Time */}
                  <span className="ml-auto text-muted-foreground/70 shrink-0 tabular-nums">
                    {formatRelative(job.completedAt ?? job.startedAt ?? job.requestedAt)}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
