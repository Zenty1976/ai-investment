/**
 * Settings
 *
 * A generic settings hub. Currently contains the Saxo Bank integration
 * section. Additional sections will be added here over time.
 */
import { useState, useEffect } from "react"
import {
  useGetSaxoStatus,
  useSaxoLogin,
  useSaxoLogout,
  useSaxoSaveConfig,
  useSaxoSetEnvironment,
  useSaxoSetMock,
} from "@workspace/api-client-react"
import type { SaxoStatus } from "@workspace/api-client-react"
import {
  AlertCircle,
  CheckCircle2,
  XCircle,
  RefreshCw,
  LogIn,
  LogOut,
  ExternalLink,
  Info,
  Copy,
  Check,
  FlaskConical,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { format, formatDistanceToNow } from "date-fns"

// ── Helpers ───────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <button
      onClick={handleCopy}
      className="text-muted-foreground hover:text-foreground transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500/80" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

// ── Saxo status badge ─────────────────────────────────────────────────────────

function SaxoStatusBadge({ status }: { status: SaxoStatus }) {
  if (status.connected) {
    return (
      <Badge variant="positive" className="text-[10px] uppercase tracking-wider px-1.5 py-0 gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Connected
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-[10px] uppercase tracking-wider px-1.5 py-0 gap-1 text-muted-foreground">
      <XCircle className="h-3 w-3" />
      Disconnected
    </Badge>
  )
}

// ── Layout helpers ────────────────────────────────────────────────────────────

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="bg-card/60 border-card-border/50">
      <CardContent className="p-4 space-y-4">
        <p className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground">
          {title}
        </p>
        {children}
      </CardContent>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60 sm:w-36 shrink-0 mt-0.5">
        {label}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

// ── Saxo Bank section ─────────────────────────────────────────────────────────

function SaxoBankSection() {
  const { data: status, isLoading, refetch, isRefetching } = useGetSaxoStatus({
    query: { refetchInterval: 30_000, retry: false },
  })

  const loginMutation = useSaxoLogin()
  const logoutMutation = useSaxoLogout()
  const configMutation = useSaxoSaveConfig()
  const envMutation = useSaxoSetEnvironment()
  const mockMutation = useSaxoSetMock()

  // Redirect URL override — local edit state, saved explicitly
  const [redirectOverride, setRedirectOverride] = useState("")
  const [overrideSaved, setOverrideSaved] = useState(false)
  const [debugAuthUrl, setDebugAuthUrl] = useState<string | null>(null)

  // Populate from server on first load
  useEffect(() => {
    if (status?.redirectUrlOverride !== undefined) {
      setRedirectOverride(status.redirectUrlOverride ?? "")
    }
  }, [status?.redirectUrlOverride])

  // Handle saxo_success / saxo_error query params after OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("saxo_success") || params.get("saxo_error")) {
      window.history.replaceState({}, "", window.location.pathname)
      refetch()
    }
  }, [refetch])

  const detectedUrl = status?.detectedCallbackUrl ?? ""
  const activeRedirectUrl = redirectOverride.trim() || detectedUrl

  const handleSaveRedirectUrl = () => {
    configMutation.mutate(
      { redirectUrlOverride: redirectOverride.trim() || undefined },
      {
        onSuccess: () => {
          setOverrideSaved(true)
          setTimeout(() => setOverrideSaved(false), 2500)
          refetch()
        },
      }
    )
  }

  const handleLogin = () => {
    setDebugAuthUrl(null)
    const returnUrl = window.location.href.split("?")[0]
    loginMutation.mutate(
      { redirectUrl: activeRedirectUrl, returnUrl },
      { onSuccess: (data) => { setDebugAuthUrl(data.authUrl) } }
    )
  }

  const handleLogout = () => {
    logoutMutation.mutate(undefined, { onSuccess: () => refetch() })
  }

  const handleSetEnvironment = (env: "sim" | "live") => {
    if (env === status?.environment) return
    envMutation.mutate({ environment: env }, { onSuccess: () => refetch() })
  }

  const handleSetMock = (useMockData: boolean) => {
    mockMutation.mutate({ useMockData }, { onSuccess: () => refetch() })
  }

  // ── Loading / error states ────────────────────────────────────────────────

  if (isLoading) {
    return (
      <SectionCard title="Saxo Bank">
        <div className="h-8 flex items-center gap-2 text-xs text-muted-foreground/50">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          Loading status…
        </div>
      </SectionCard>
    )
  }

  if (!status) {
    return (
      <SectionCard title="Saxo Bank">
        <div className="flex items-center gap-2 text-xs text-destructive/80">
          <AlertCircle className="h-3.5 w-3.5" />
          Could not load connection status.
          <button onClick={() => refetch()} className="underline underline-offset-2 hover:text-foreground">
            Retry
          </button>
        </div>
      </SectionCard>
    )
  }

  // ── Main content ──────────────────────────────────────────────────────────

  return (
    <SectionCard title="Saxo Bank">

      {/* Status row */}
      <Row label="Status">
        <div className="flex items-center gap-2 flex-wrap">
          <SaxoStatusBadge status={status} />
          <button
            onClick={() => refetch()}
            disabled={isRefetching}
            className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            title="Refresh status"
          >
            <RefreshCw className={`h-3 w-3 ${isRefetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </Row>

      {/* Environment toggle */}
      <Row label="Environment">
        <div className="flex items-center gap-1 rounded-md border border-border/40 p-0.5 w-fit">
          {(["sim", "live"] as const).map((env) => {
            const active = status.environment === env
            return (
              <button
                key={env}
                onClick={() => handleSetEnvironment(env)}
                disabled={envMutation.isPending}
                className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
                  active
                    ? env === "live"
                      ? "bg-green-600/20 text-green-400 border border-green-600/30"
                      : "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {env === "sim" ? "Simulation" : "Live"}
              </button>
            )
          })}
        </div>
        {status.environment === "live" && (
          <p className="text-[11px] text-amber-400/70 mt-1">
            Live environment — real money is at risk.
          </p>
        )}
        {status.connected && envMutation.isSuccess && (
          <p className="text-[11px] text-muted-foreground/50 mt-1">
            Tokens cleared — please log in again for the new environment.
          </p>
        )}
      </Row>

      {/* Credentials */}
      <Row label="Credentials">
        <div className="flex items-center gap-3 flex-wrap text-xs">
          {[
            { label: "App Key", ok: status.appKeyConfigured },
            { label: "App Secret", ok: status.appSecretConfigured },
          ].map(({ label, ok }) => (
            <span
              key={label}
              className={`flex items-center gap-1 ${ok ? "text-green-500/80" : "text-muted-foreground/50"}`}
            >
              {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
              {label}
            </span>
          ))}
        </div>
        {(!status.appKeyConfigured || !status.appSecretConfigured) && (
          <p className="text-[11px] text-muted-foreground/50 mt-1">
            Set <code className="text-primary/70">SAXO_APP_KEY</code> and{" "}
            <code className="text-primary/70">SAXO_APP_SECRET</code> as Replit secrets.
          </p>
        )}
      </Row>

      {/* Token expiry when connected */}
      {status.connected && status.expiresAt && (
        <Row label="Token expires">
          <span className="text-xs text-foreground/70">
            {formatDistanceToNow(new Date(status.expiresAt), { addSuffix: true })}
            <span className="text-muted-foreground/40 ml-2">
              ({format(new Date(status.expiresAt), "HH:mm 'd.' d MMM")})
            </span>
          </span>
        </Row>
      )}

      {/* Connected at when connected */}
      {status.connected && status.connectedAt && (
        <Row label="Connected">
          <span className="text-xs text-muted-foreground/60">
            {format(new Date(status.connectedAt), "HH:mm 'd.' d MMM yyyy")}
          </span>
        </Row>
      )}

      {/* Detected redirect URL (server-computed) */}
      <Row label="Detected URL">
        <div className="flex items-center gap-2 min-w-0">
          <code className="text-[11px] text-primary/70 bg-muted/30 rounded px-1.5 py-0.5 break-all">
            {detectedUrl || "—"}
          </code>
          {detectedUrl && <CopyButton text={detectedUrl} />}
        </div>
      </Row>

      {/* Redirect URL override */}
      <Row label="Redirect URL">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Input
              value={redirectOverride}
              onChange={(e) => setRedirectOverride(e.target.value)}
              placeholder={detectedUrl || "https://your-domain/api/settings/saxo/callback"}
              className="h-8 text-xs bg-background/60 border-border/60 focus:border-primary/50 font-mono"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleSaveRedirectUrl}
              disabled={configMutation.isPending}
              className="h-8 shrink-0 border-border/50 text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {overrideSaved ? (
                <span className="flex items-center gap-1 text-green-500/80 text-xs">
                  <Check className="h-3 w-3" /> Saved
                </span>
              ) : (
                <span className="text-xs">Save</span>
              )}
            </Button>
          </div>
          <div className="flex items-start gap-1.5 text-[11px] text-amber-400/70">
            <Info className="h-3 w-3 shrink-0 mt-0.5" />
            <span>
              This exact redirect URL must also be registered in the{" "}
              <a
                href="https://www.developer.saxo/openapi/appmanagement"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-amber-400 inline-flex items-center gap-0.5"
              >
                Saxo developer portal
                <ExternalLink className="h-2.5 w-2.5" />
              </a>.
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground/40 leading-snug">
            Leave blank to use the detected URL above. Saxo requires an exact match.
          </p>
        </div>
      </Row>

      {/* Mock Saxo data toggle — development/debug only */}
      <Row label="Development">
        <div className="flex items-center gap-3">
          <button
            role="switch"
            aria-checked={status.useMockSaxoData}
            onClick={() => handleSetMock(!status.useMockSaxoData)}
            disabled={mockMutation.isPending}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 transition-colors focus-visible:outline-none disabled:opacity-50 ${
              status.useMockSaxoData
                ? "bg-amber-500/70 border-amber-500/70"
                : "bg-muted/40 border-muted/40"
            }`}
          >
            <span className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform mt-0 ${
              status.useMockSaxoData ? "translate-x-3.5" : "translate-x-0"
            }`} />
          </button>
          <div className="flex items-center gap-1.5">
            <FlaskConical className="h-3 w-3 text-amber-400/70" />
            <span className="text-xs text-foreground/70">Use mock Saxo data</span>
          </div>
        </div>
        <p className="text-[11px] text-amber-400/60 mt-1.5 leading-snug">
          Debug only — replaces Saxo API calls with simulated responses in Portfolio Manager.
          Not for production use.
        </p>
      </Row>

      {/* Error banner */}
      {status.error && (
        <div className="flex items-start gap-2 text-xs text-destructive/80 bg-destructive/8 border border-destructive/20 rounded-md px-3 py-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{status.error}</span>
        </div>
      )}

      {/* Action buttons */}
      <div className="pt-1 border-t border-border/30 flex items-center gap-2 flex-wrap">
        {status.connected ? (
          <Button
            size="sm"
            variant="outline"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            className="h-8 gap-1.5 border-destructive/30 text-destructive/70 hover:bg-destructive/10 disabled:opacity-50"
          >
            <LogOut className={`h-3.5 w-3.5 ${logoutMutation.isPending ? "animate-spin" : ""}`} />
            Logout
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={handleLogin}
            disabled={loginMutation.isPending || !status.configured}
            className="h-8 gap-1.5 border-primary/30 text-primary hover:bg-primary/10 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loginMutation.isPending
              ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              : <LogIn className="h-3.5 w-3.5" />}
            Login to Saxo
          </Button>
        )}
        {!status.configured && (
          <span className="text-[11px] text-muted-foreground/50">
            Configure App Key and App Secret first.
          </span>
        )}
      </div>

      {/* Debug: show generated auth URL before redirecting */}
      {loginMutation.isError && (
        <div className="flex items-start gap-2 text-xs text-destructive/80 bg-destructive/8 border border-destructive/20 rounded-md px-3 py-2 mt-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>Login-fejl: {String((loginMutation.error as Error)?.message ?? loginMutation.error)}</span>
        </div>
      )}
      {debugAuthUrl && (
        <div className="mt-2 space-y-2 bg-muted/20 border border-border/40 rounded-md p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            Debug — genereret auth-URL
          </p>
          <p className="text-[11px] text-muted-foreground/50 leading-snug">
            Klik på linket for at åbne Saxo-login, eller kopiér URL'en og inspicér parametrene.
          </p>
          <div className="flex items-start gap-2 min-w-0">
            <code className="text-[10px] text-primary/70 bg-background/60 border border-border/30 rounded px-2 py-1.5 break-all flex-1 leading-relaxed">
              {debugAuthUrl}
            </code>
            <CopyButton text={debugAuthUrl} />
          </div>
          {/* Parse and show individual params for easier debugging */}
          <div className="space-y-1 pt-1 border-t border-border/20">
            {(() => {
              try {
                const u = new URL(debugAuthUrl)
                const params = Array.from(u.searchParams.entries())
                return (
                  <>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40 mb-1">
                      Parametre
                    </p>
                    {params.map(([k, v]) => (
                      <div key={k} className="flex gap-2 text-[10px]">
                        <span className="text-muted-foreground/50 w-28 shrink-0">{k}</span>
                        <span className="text-foreground/60 break-all">{v}</span>
                      </div>
                    ))}
                  </>
                )
              } catch {
                return null
              }
            })()}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { window.location.href = debugAuthUrl }}
            className="h-8 gap-1.5 border-primary/30 text-primary hover:bg-primary/10 mt-1"
          >
            <LogIn className="h-3.5 w-3.5" />
            Gå til Saxo-login
          </Button>
        </div>
      )}

    </SectionCard>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Settings() {
  return (
    <div className="space-y-3 pb-8 animate-in fade-in duration-500">

      <Card className="bg-card/60 border-card-border/50">
        <CardContent className="p-4">
          <h2 className="text-xs font-bold tracking-widest uppercase text-muted-foreground">
            Settings
          </h2>
          <p className="text-sm text-muted-foreground/60 mt-1">
            Manage external integrations and application preferences.
          </p>
        </CardContent>
      </Card>

      <SaxoBankSection />

    </div>
  )
}
