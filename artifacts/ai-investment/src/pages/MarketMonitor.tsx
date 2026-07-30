import { useState, useEffect } from "react"
import { createPortal } from "react-dom"
import { useRunMarketAnalysis } from "@workspace/api-client-react"
import { AlertCircle, RefreshCw, TrendingUp, TrendingDown, Activity, AlertTriangle, ShieldAlert, BarChart3 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { format } from "date-fns"

export default function MarketMonitor() {
  const { mutate: runAnalysis, data: analysis, isPending, error } = useRunMarketAnalysis()

  const handleRefresh = () => {
    runAnalysis()
  }

  // Header Extra Portal for Last Updated & Refresh
  const [headerNode, setHeaderNode] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setHeaderNode(document.getElementById("header-extra"))
  }, [])

  const headerExtra = headerNode && (
    <div className="flex items-center gap-4">
      {analysis && (
        <span className="hidden md:inline-flex text-xs text-muted-foreground">
          Last updated: {format(new Date(analysis.timestamp), "HH:mm:ss 'UTC'")}
        </span>
      )}
      <Button 
        size="sm" 
        onClick={handleRefresh} 
        disabled={isPending}
        className="h-8 gap-2"
      >
        <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
        <span className="hidden sm:inline">{analysis ? "Refresh" : "Run Analysis"}</span>
      </Button>
    </div>
  )

  if (isPending && !analysis) {
    return (
      <div className="space-y-6 animate-in fade-in duration-500">
        {headerExtra && createPortal(headerExtra, headerNode)}
        <div className="flex gap-4 mb-6">
          <Skeleton className="h-32 flex-1" />
          <Skeleton className="h-32 flex-1" />
          <Skeleton className="h-32 flex-1" />
        </div>
        <Skeleton className="h-48 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    )
  }

  if (error && !analysis) {
    return (
      <div className="max-w-2xl mx-auto mt-12">
        {headerExtra && createPortal(headerExtra, headerNode)}
        <Alert variant="destructive" className="bg-destructive/10 border-destructive/20">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Analysis Failed</AlertTitle>
          <AlertDescription className="mt-2 text-destructive/80">
            {(error as any)?.error || "An unexpected error occurred while fetching market intelligence."}
          </AlertDescription>
        </Alert>
        <Button onClick={handleRefresh} className="mt-6" variant="outline">
          Try Again
        </Button>
      </div>
    )
  }

  if (!analysis) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center max-w-xl mx-auto">
        {headerExtra && createPortal(headerExtra, headerNode)}
        <div className="h-20 w-20 bg-primary/10 rounded-full flex items-center justify-center mb-6 ring-1 ring-primary/20 shadow-[0_0_40px_rgba(37,99,235,0.2)]">
          <Activity className="h-10 w-10 text-primary" />
        </div>
        <h2 className="text-3xl font-bold tracking-tight mb-4 text-foreground">Market Intelligence</h2>
        <p className="text-muted-foreground mb-8 text-lg">
          Initialize the AI investment engine to process real-time market sentiment, sector strength, and emerging risks.
        </p>
        <Button onClick={handleRefresh} size="lg" className="h-12 px-8 text-md font-medium shadow-lg hover:shadow-primary/25 transition-all">
          <RefreshCw className="mr-2 h-5 w-5" />
          Initialize Monitor
        </Button>
      </div>
    )
  }

  const sentimentColor = {
    Positive: "positive",
    Neutral: "warning",
    Negative: "negative"
  } as const

  const riskColor = {
    Low: "positive",
    Moderate: "warning",
    High: "negative"
  } as const

  return (
    <div className="space-y-6 pb-12 animate-in fade-in slide-in-from-bottom-4 duration-700">
      {headerExtra && createPortal(headerExtra, headerNode)}
      
      {/* Top Metrics Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Sentiment */}
        <Card className="bg-card/50 backdrop-blur-sm border-card-border/50 hover:bg-card/80 transition-colors">
          <CardContent className="p-6 flex flex-col justify-center h-full">
            <p className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2">
              <Activity className="h-4 w-4" /> Market Sentiment
            </p>
            <div className="flex items-end gap-3">
              <span className="text-3xl font-bold tracking-tight">{analysis.marketSentiment}</span>
              <Badge variant={sentimentColor[analysis.marketSentiment] || "default"} className="mb-1.5 uppercase tracking-wider text-[10px] px-2">
                {analysis.marketSentiment === "Positive" ? <TrendingUp className="h-3 w-3 mr-1" /> : analysis.marketSentiment === "Negative" ? <TrendingDown className="h-3 w-3 mr-1" /> : null}
                Status
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Risk Level */}
        <Card className="bg-card/50 backdrop-blur-sm border-card-border/50 hover:bg-card/80 transition-colors">
          <CardContent className="p-6 flex flex-col justify-center h-full">
            <p className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" /> Systemic Risk
            </p>
            <div className="flex items-end gap-3">
              <span className="text-3xl font-bold tracking-tight">{analysis.riskLevel}</span>
              <Badge variant={riskColor[analysis.riskLevel] || "default"} className="mb-1.5 uppercase tracking-wider text-[10px] px-2">
                Risk
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Confidence */}
        <Card className="bg-card/50 backdrop-blur-sm border-card-border/50 hover:bg-card/80 transition-colors">
          <CardContent className="p-6 flex flex-col justify-center h-full">
            <div className="flex justify-between items-center mb-2">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <BarChart3 className="h-4 w-4" /> AI Confidence
              </p>
              <span className="text-xl font-bold">{analysis.confidence}%</span>
            </div>
            <Progress 
              value={analysis.confidence} 
              className="h-2.5 mt-2 bg-secondary/50" 
              indicatorClassName={
                analysis.confidence > 80 ? "bg-emerald-500" : analysis.confidence > 50 ? "bg-primary" : "bg-amber-500"
              }
            />
          </CardContent>
        </Card>
      </div>

      {/* Summary */}
      <Card className="border-primary/20 bg-primary/5 shadow-inner">
        <CardContent className="p-6">
          <p className="text-lg leading-relaxed text-foreground/90 font-medium">
            {analysis.summary}
          </p>
        </CardContent>
      </Card>

      {/* Two Column Layout: Factors & Sectors */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Market Factors */}
        <div className="space-y-6">
          <Card className="h-full border-card-border/50">
            <CardHeader className="pb-3 border-b border-border/50">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-emerald-500" />
                Positive Catalysts
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <ul className="space-y-3">
                {analysis.positiveFactors.map((factor, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm">
                    <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
                    <span className="text-foreground/80 leading-snug">{factor}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="h-full border-card-border/50">
            <CardHeader className="pb-3 border-b border-border/50">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingDown className="h-5 w-5 text-rose-500" />
                Negative Pressures
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <ul className="space-y-3">
                {analysis.negativeFactors.map((factor, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm">
                    <div className="h-1.5 w-1.5 rounded-full bg-rose-500 mt-1.5 shrink-0" />
                    <span className="text-foreground/80 leading-snug">{factor}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        {/* Sectors */}
        <Card className="border-card-border/50">
          <CardHeader className="pb-3 border-b border-border/50">
            <CardTitle className="text-base">Sector Rotation</CardTitle>
          </CardHeader>
          <CardContent className="pt-5 grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">Outperforming</h4>
              <div className="flex flex-wrap gap-2">
                {analysis.strongSectors.map((sector, i) => (
                  <Badge key={i} variant="outline" className="bg-emerald-500/10 border-emerald-500/20 text-emerald-400">
                    {sector}
                  </Badge>
                ))}
              </div>
            </div>
            <div>
              <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">Underperforming</h4>
              <div className="flex flex-wrap gap-2">
                {analysis.weakSectors.map((sector, i) => (
                  <Badge key={i} variant="outline" className="bg-rose-500/10 border-rose-500/20 text-rose-400">
                    {sector}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Key Risks */}
        <Card className="border-amber-500/20 bg-amber-500/5">
          <CardHeader className="pb-3 border-b border-amber-500/10">
            <CardTitle className="text-base flex items-center gap-2 text-amber-500">
              <AlertTriangle className="h-5 w-5" />
              Key Risks to Monitor
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <ul className="space-y-4">
              {analysis.keyRisks.map((risk, i) => (
                <li key={i} className="flex items-start gap-3 bg-background/50 p-3 rounded-md border border-border/50">
                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  <span className="text-sm text-foreground/90 font-medium leading-relaxed">{risk}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

      </div>
    </div>
  )
}
