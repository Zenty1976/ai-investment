import { useRunMarketAnalysis } from "@workspace/api-client-react"
import {
  AlertCircle,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Activity,
  AlertTriangle,
  ShieldAlert,
  BarChart3,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { format } from "date-fns"

export default function MarketMonitor() {
  const { mutate: runAnalysis, data: analysis, isPending, error } = useRunMarketAnalysis({
    mutation: {
      onSuccess: () => {
        window.dispatchEvent(new CustomEvent("market-updated", { detail: new Date() }))
      },
    },
  })

  const handleRefresh = () => {
    runAnalysis()
  }

  if (isPending && !analysis) {
    return (
      <div className="space-y-4 animate-in fade-in duration-500">
        <div className="flex gap-4">
          <Skeleton className="h-28 flex-1" />
          <Skeleton className="h-28 flex-1" />
          <Skeleton className="h-28 flex-1" />
        </div>
        <Skeleton className="h-20 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      </div>
    )
  }

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
        <Button onClick={handleRefresh} variant="outline">
          <RefreshCw className="h-4 w-4 mr-2" />
          Try Again
        </Button>
      </div>
    )
  }

  if (!analysis) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center max-w-lg mx-auto">
        <div className="h-20 w-20 bg-primary/10 rounded-full flex items-center justify-center mb-6 ring-1 ring-primary/20 shadow-[0_0_40px_rgba(37,99,235,0.2)]">
          <Activity className="h-10 w-10 text-primary" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight mb-3 text-foreground">Market Intelligence</h2>
        <p className="text-muted-foreground mb-8 leading-relaxed">
          Initialize the AI investment engine to process real-time market sentiment,
          sector strength, and emerging risks.
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

  const sentimentVariant =
    analysis.marketSentiment === "Positive"
      ? "positive"
      : analysis.marketSentiment === "Negative"
      ? "negative"
      : "warning"

  const riskVariant =
    analysis.riskLevel === "Low"
      ? "positive"
      : analysis.riskLevel === "High"
      ? "negative"
      : "warning"

  return (
    <div className="space-y-4 pb-8 animate-in fade-in slide-in-from-bottom-2 duration-500">

      {/* ── Page title + Refresh ── */}
      <div className="flex items-center justify-between mb-1">
        <div>
          <h2 className="text-base font-bold tracking-wide uppercase text-foreground">
            Market Monitor
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Opdateret: {format(new Date(analysis.timestamp), "HH:mm")}
          </p>
        </div>
        <Button
          size="sm"
          onClick={handleRefresh}
          disabled={isPending}
          className="h-8 gap-2"
          data-testid="button-refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
          Opdater analyse
        </Button>
      </div>

      {/* ── Top metric cards ── */}
      <div className="grid grid-cols-3 gap-3">
        {/* Sentiment */}
        <Card className="bg-card/60 border-card-border/50">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2 flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5" /> Markedsstemning
            </p>
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold tracking-tight">{analysis.marketSentiment}</span>
              <Badge variant={sentimentVariant} className="text-[10px] uppercase tracking-wider px-1.5 py-0.5">
                {analysis.marketSentiment === "Positive" ? (
                  <TrendingUp className="h-3 w-3 mr-1" />
                ) : analysis.marketSentiment === "Negative" ? (
                  <TrendingDown className="h-3 w-3 mr-1" />
                ) : null}
                {analysis.marketSentiment}
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Risk */}
        <Card className="bg-card/60 border-card-border/50">
          <CardContent className="p-4">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2 flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5" /> Risikoniveau
            </p>
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold tracking-tight">{analysis.riskLevel}</span>
              <Badge variant={riskVariant} className="text-[10px] uppercase tracking-wider px-1.5 py-0.5">
                {analysis.riskLevel}
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Confidence */}
        <Card className="bg-card/60 border-card-border/50">
          <CardContent className="p-4">
            <div className="flex justify-between items-center mb-2">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest flex items-center gap-1.5">
                <BarChart3 className="h-3.5 w-3.5" /> AI Konfidens
              </p>
              <span className="text-xl font-bold">{analysis.confidence}%</span>
            </div>
            <Progress
              value={analysis.confidence}
              className="h-2 bg-secondary/50"
              indicatorClassName={
                analysis.confidence > 80
                  ? "bg-emerald-500"
                  : analysis.confidence > 50
                  ? "bg-primary"
                  : "bg-amber-500"
              }
            />
          </CardContent>
        </Card>
      </div>

      {/* ── Summary ── */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4">
          <p className="text-sm leading-relaxed text-foreground/90">{analysis.summary}</p>
        </CardContent>
      </Card>

      {/* ── 2×2 detail grid ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

        {/* Positive factors */}
        <Card className="border-card-border/50">
          <CardHeader className="py-3 px-4 border-b border-border/50">
            <CardTitle className="text-xs font-bold uppercase tracking-widest flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-emerald-500" /> Positive faktorer
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

        {/* Negative factors */}
        <Card className="border-card-border/50">
          <CardHeader className="py-3 px-4 border-b border-border/50">
            <CardTitle className="text-xs font-bold uppercase tracking-widest flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-rose-500" /> Negative faktorer
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

        {/* Sectors */}
        <Card className="border-card-border/50">
          <CardHeader className="py-3 px-4 border-b border-border/50">
            <CardTitle className="text-xs font-bold uppercase tracking-widest">
              Sektorrotation
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 grid grid-cols-2 gap-4">
            <div>
              <h4 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">
                Stærke sektorer
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
                Svage sektorer
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

        {/* Key risks */}
        <Card className="border-amber-500/20 bg-amber-500/5">
          <CardHeader className="py-3 px-4 border-b border-amber-500/10">
            <CardTitle className="text-xs font-bold uppercase tracking-widest flex items-center gap-2 text-amber-400">
              <AlertTriangle className="h-4 w-4" /> Nøglerisici
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
  )
}
