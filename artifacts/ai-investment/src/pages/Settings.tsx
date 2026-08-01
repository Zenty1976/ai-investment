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
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { format, formatDistanceToNow } from "date-fns"

// ── Helpers ───────────────────────────────────────────────────────────────────

function envLabel(env: SaxoStatus["environment"]) {
  return env === "live" ? "Live" : "Simulation"
}

function envBadgeVariant(env: SaxoStatus["environment"]): "positive" | "warning" {
  return env === "live" ? "positive" : "warning"
}

/** Builds the auto-detected callback URL from the current browser origin. */
function autoDetectCallbackUrl(): string {
  return `${window.location.origin}/api/settings/saxo/callback`
}

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
      title="Copy"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

// ── Saxo status indicator ─────────────────────────────────────────────────────

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

// ── Section wrapper ───────────────────────────────────────────────────────────

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

  const detectedUrl = autoDetectCallbackUrl()

  // Redirect URL override — local state so the user can edit before saving
  const [redirectOverride, setRedirectOverride] = useState<string>("")
  const [overrideSaved, setOverrideSaved] = useState(false)

  // Populate from server data on first load
  useEffect(() => {
    if (status?.redirectUrlOverride !== undefined) {
      setRedirectOverride(status.redirectUrlOverride ?? "")
    }
  }, [status?.redirectUrlOverride])

  // Handle saxo_success / saxo_error query params after OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const success = params.get("saxo_success")
    const error = params.get("saxo_error")
    if (success || error) {
      // Clean up URL without page reload
      const clean = window.location.pathname
      window.history.replaceState({}, "", clean)
      refetch()
    }
  }, [refetch])

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
    const returnUrl = window.location.href.split("?")[0]
    loginMutation.mutate(
      { redirectUrl: activeRedirectUrl, returnUrl },
      {
        onSuccess: (data) => {
          // Navigate to Saxo authorization page
          window.location.href = data.authUrl
        },
      }
    )
  }

  const handleLogout = () => {
    logoutMutation.mutate(undefined, { onSuccess: () => refetch() })
  }

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

  return (
    <SectionCard title="Saxo Bank">

      {/* Status + env row */}
      <Row label="Status">
        <div className="flex items-center gap-2 flex-wrap">
          <SaxoStatusBadge status={status} />
          <Badge
            variant={envBadgeVariant(status.environment)}
            className="text-[10px] uppercase tracking-wider px-1.5 py-0"
          >
            {envLabel(status.environment)}
          </Badge>
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

      {/* Credentials configured */}
      <Row label="Credentials">
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <span className={`flex items-center gap-1 ${status.appKeyConfigured ? "text-green-500/80" : "text-muted-foreground/50"}`}>
            {status.appKeyConfigured
              ? <CheckCircle2 className="h-3.5 w-3.5" />
              : <XCircle className="h-3.5 w-3.5" />}
            App Key
          </span>
          <span className={`flex items-center gap-1 ${status.appSecretConfigured ? "text-green-500/80" : "text-muted-foreground/50"}`}>
            {status.appSecretConfigured
              ? <CheckCircle2 className="h-3.5 w-3.5" />
              : <XCircle className="h-3.5 w-3.5" />}
            App Secret
          </span>
        </div>
        {(!status.appKeyConfigured || !status.appSecretConfigured) && (
          <p className="text-[11px] text-muted-foreground/50 mt-1">
            Set <code className="text-primary/70">SAXO_APP_KEY</code> and{" "}
            <code className="text-primary/70">SAXO_APP_SECRET</code> as Replit secrets.
          </p>
        )}
      </Row>

      {/* Token expiry (connected only) */}
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

      {/* Connected at (connected only) */}
      {status.connected && status.connectedAt && (
        <Row label="Connected">
          <span className="text-xs text-muted-foreground/60">
            {format(new Date(status.connectedAt), "HH:mm 'd.' d MMM yyyy")}
          </span>
        </Row>
      )}

      {/* Auto-detected redirect URL */}
      <Row label="Detected URL">
        <div className="flex items-center gap-2 min-w-0">
          <code className="text-[11px] text-primary/70 bg-muted/30 rounded px-1.5 py-0.5 break-all">
            {detectedUrl}
          </code>
          <CopyButton text={detectedUrl} />
        </div>
      </Row>

      {/* Redirect URL override */}
      <Row label="Redirect URL">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Input
              value={redirectOverride}
              onChange={(e) => setRedirectOverride(e.target.value)}
              placeholder={detectedUrl}
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

      {/* Error banner */}
      {status.error && (
        <div className="flex items-start gap-2 text-xs text-destructive/80 bg-destructive/8 border border-destructive/20 rounded-md px-3 py-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{status.error}</span>
        </div>
      )}

      {/* Divider + action buttons */}
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
            {loginMutation.isPending ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LogIn className="h-3.5 w-3.5" />
            )}
            Login to Saxo
          </Button>
        )}
        {!status.configured && (
          <span className="text-[11px] text-muted-foreground/50">
            Configure App Key and App Secret first.
          </span>
        )}
      </div>

    </SectionCard>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Settings() {
  return (
    <div className="space-y-3 pb-8 animate-in fade-in duration-500">

      {/* Page header */}
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

      {/* Saxo Bank integration */}
      <SaxoBankSection />

    </div>
  )
}
