import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { formatDistanceToNowStrict } from "date-fns";
import {
  ChevronDown, ChevronUp, RefreshCw, Eye, ExternalLink,
  AlertCircle, CheckCircle2, Info, TrendingUp, TrendingDown,
  Minus, HelpCircle, Clock, Zap
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InvestorConfig {
  id: string;
  name: string;
  organization: string;
  focusLabel: string;
  enabled: boolean;
  displayOrder: number;
}

interface InvestorResult {
  person: { id: string; name: string; organization: string; focusLabel: string };
  updateType: "FullAnalysis" | "MaterialUpdate" | "NoMaterialChange";
  headline: string;
  shortSummary: string;
  currentView: { overallTone: string; summary: string; confidence: string };
  keyThemes: Array<{ title: string; stance: string; summary: string }>;
  latestDevelopments: Array<{
    title: string;
    date: string;
    summary: string;
    evidenceType: string;
    confidence: string;
    sourceName: string;
    sourceUrl?: string;
  }>;
  positioning: {
    summary: string;
    filingDate: string;
    reportingPeriod: string;
    isDelayedData: boolean;
    notableChanges: Array<{ asset: string; action: string; summary: string }>;
  };
  sayVsDo: {
    statementsSummary: string;
    positioningSummary: string;
    consistency: string;
    explanation: string;
  };
  changeSincePrevious: { changed: boolean; severity: string; summary: string };
  thingsToWatch: string[];
  lastCheckedAt: string;
  lastMaterialUpdateAt: string;
  analysisDuration?: number;
  _debug?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string | undefined): string {
  if (!iso) return "never";
  try { return formatDistanceToNowStrict(new Date(iso), { addSuffix: true }); }
  catch { return "—"; }
}

function toneColor(tone: string): string {
  switch (tone) {
    case "Bullish": return "text-green-400";
    case "Bearish": return "text-red-400";
    case "Cautious": return "text-yellow-400";
    case "Mixed": return "text-blue-400";
    default: return "text-muted-foreground";
  }
}

function toneIcon(tone: string) {
  switch (tone) {
    case "Bullish": return <TrendingUp className="h-3.5 w-3.5 text-green-400" />;
    case "Bearish": return <TrendingDown className="h-3.5 w-3.5 text-red-400" />;
    case "Cautious": return <Minus className="h-3.5 w-3.5 text-yellow-400" />;
    default: return <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function stanceColor(stance: string): string {
  if (stance === "Bullish") return "text-green-400";
  if (stance === "Bearish") return "text-red-400";
  if (stance === "Cautious") return "text-yellow-400";
  return "text-muted-foreground";
}

function evidenceBadge(type: string) {
  const variants: Record<string, { label: string; cls: string }> = {
    Direct:            { label: "Direct",     cls: "bg-green-500/15 text-green-400 border-green-500/30" },
    Filing:            { label: "Filing",     cls: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
    ReliableReporting: { label: "Reporting",  cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
    Interpretation:    { label: "Interpreted", cls: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  };
  const v = variants[type] ?? { label: type, cls: "bg-muted text-muted-foreground" };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-semibold tracking-wide ${v.cls}`}>
      {v.label}
    </span>
  );
}

function consistencyIcon(c: string) {
  if (c === "Consistent") return <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />;
  if (c === "Conflicting") return <AlertCircle className="h-3.5 w-3.5 text-red-400" />;
  if (c === "PartlyConsistent") return <Info className="h-3.5 w-3.5 text-yellow-400" />;
  return <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />;
}

function actionColor(action: string): string {
  if (action === "New" || action === "Increased") return "text-green-400";
  if (action === "Exited" || action === "Reduced") return "text-red-400";
  return "text-muted-foreground";
}

// ---------------------------------------------------------------------------
// Detail Dialog
// ---------------------------------------------------------------------------

function InvestorDetailDialog({
  result,
  open,
  onClose,
}: {
  result: InvestorResult;
  open: boolean;
  onClose: () => void;
}) {
  const d = result;
  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto bg-background border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span>{d.person.name}</span>
            <span className="text-muted-foreground font-normal text-sm">· {d.person.organization}</span>
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground">{d.person.focusLabel}</p>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {/* Current view */}
          <div className="rounded-lg border border-border/50 p-3">
            <div className="flex items-center gap-2 mb-2">
              {toneIcon(d.currentView.overallTone)}
              <span className={`font-semibold ${toneColor(d.currentView.overallTone)}`}>
                {d.currentView.overallTone}
              </span>
              <span className="text-[10px] text-muted-foreground ml-auto">
                Confidence: {d.currentView.confidence}
              </span>
            </div>
            <p className="text-[12px] text-foreground/90 leading-relaxed">{d.currentView.summary}</p>
          </div>

          {/* Latest headline */}
          <div>
            <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider mb-1">Latest</p>
            <p className="text-[12px] text-foreground font-medium">{d.headline}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{d.shortSummary}</p>
          </div>

          {/* Key themes */}
          {d.keyThemes?.length > 0 && (
            <div>
              <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider mb-2">Key Themes</p>
              <div className="space-y-2">
                {d.keyThemes.map((t, i) => (
                  <div key={i} className="border-l-2 border-border pl-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-foreground/90">{t.title}</span>
                      <span className={`text-[10px] ${stanceColor(t.stance)}`}>{t.stance}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{t.summary}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Separator className="bg-border/50" />

          {/* Says vs Does */}
          <div>
            <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider mb-2">Says vs Does</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded border border-border/40 p-2">
                <p className="text-[9px] text-muted-foreground font-semibold uppercase mb-1">Says / Thinks</p>
                <p className="text-[11px] text-foreground/80">{d.sayVsDo.statementsSummary}</p>
              </div>
              <div className="rounded border border-border/40 p-2">
                <p className="text-[9px] text-muted-foreground font-semibold uppercase mb-1">Does / Positioning</p>
                <p className="text-[11px] text-foreground/80">{d.sayVsDo.positioningSummary}</p>
              </div>
            </div>
            <div className="flex items-start gap-2 mt-2 text-[10px] text-muted-foreground">
              {consistencyIcon(d.sayVsDo.consistency)}
              <span><span className="font-medium">{d.sayVsDo.consistency}</span> — {d.sayVsDo.explanation}</span>
            </div>
          </div>

          {/* Positioning */}
          {d.positioning?.summary && (
            <div>
              <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider mb-2">Positioning</p>
              <p className="text-[11px] text-foreground/80">{d.positioning.summary}</p>
              {d.positioning.filingDate && (
                <p className="text-[10px] text-yellow-400/80 mt-1 flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Filing: {d.positioning.filingDate} (period: {d.positioning.reportingPeriod}) — data may be delayed
                </p>
              )}
              {d.positioning.notableChanges?.length > 0 && (
                <div className="mt-2 space-y-1">
                  {d.positioning.notableChanges.map((c, i) => (
                    <div key={i} className="flex items-start gap-2 text-[10px]">
                      <span className={`font-semibold shrink-0 ${actionColor(c.action)}`}>{c.action}</span>
                      <span className="text-foreground font-medium shrink-0">{c.asset}</span>
                      <span className="text-muted-foreground">{c.summary}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <Separator className="bg-border/50" />

          {/* Latest developments */}
          {d.latestDevelopments?.length > 0 && (
            <div>
              <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider mb-2">
                Latest Developments
              </p>
              <div className="space-y-2">
                {d.latestDevelopments.map((dev, i) => (
                  <div key={i} className="border border-border/30 rounded p-2">
                    <div className="flex items-start gap-2 flex-wrap">
                      {evidenceBadge(dev.evidenceType)}
                      <span className="text-[10px] text-muted-foreground">{dev.date}</span>
                      <span className="text-[10px] text-muted-foreground">· {dev.confidence} confidence</span>
                    </div>
                    <p className="text-[11px] text-foreground/90 font-medium mt-1">{dev.title}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{dev.summary}</p>
                    <div className="flex items-center gap-1 mt-1">
                      <span className="text-[10px] text-muted-foreground/60">{dev.sourceName}</span>
                      {dev.sourceUrl && (
                        <a
                          href={dev.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 ml-1"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Change since previous */}
          {d.changeSincePrevious && (
            <div className="rounded border border-border/40 p-2">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Change Since Previous</p>
                {d.changeSincePrevious.severity !== "None" && (
                  <Badge variant="outline" className={`text-[9px] h-4 ${
                    d.changeSincePrevious.severity === "High" ? "border-red-400/50 text-red-400" :
                    d.changeSincePrevious.severity === "Medium" ? "border-yellow-400/50 text-yellow-400" :
                    "border-muted-foreground/50 text-muted-foreground"
                  }`}>
                    {d.changeSincePrevious.severity}
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-foreground/80">{d.changeSincePrevious.summary}</p>
            </div>
          )}

          {/* Things to watch */}
          {d.thingsToWatch?.length > 0 && (
            <div>
              <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider mb-1">Things to Watch</p>
              <ul className="space-y-0.5">
                {d.thingsToWatch.map((t, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[11px] text-foreground/70">
                    <Eye className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Freshness footer */}
          <div className="pt-1 border-t border-border/40 flex items-center gap-4 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Checked: {timeAgo(d.lastCheckedAt)}
            </span>
            <span className="flex items-center gap-1">
              <Zap className="h-3 w-3" />
              Last material update: {timeAgo(d.lastMaterialUpdateAt)}
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Compact investor card
// ---------------------------------------------------------------------------

function InvestorCard({
  config,
  result,
  onRunSingle,
  isRunning,
}: {
  config: InvestorConfig;
  result: InvestorResult | undefined;
  onRunSingle: (id: string) => void;
  isRunning: boolean;
}) {
  const [detailOpen, setDetailOpen] = useState(false);

  const isNew = result?.updateType === "MaterialUpdate" || result?.updateType === "FullAnalysis";
  const tone = result?.currentView.overallTone;
  const noChange = result?.updateType === "NoMaterialChange";

  return (
    <>
      <div className="rounded-lg border border-border/50 bg-card hover:border-border transition-colors p-3">
        <div className="flex items-start gap-3">
          {/* Left: tone indicator */}
          <div className="pt-0.5 shrink-0">
            {tone ? toneIcon(tone) : <HelpCircle className="h-3.5 w-3.5 text-muted-foreground/40" />}
          </div>

          {/* Center: content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-foreground">{config.name}</span>
              {tone && (
                <span className={`text-xs font-medium ${toneColor(tone)}`}>{tone}</span>
              )}
              {isNew && result && (
                <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 border text-[9px] h-4 px-1.5 font-semibold">
                  NEW
                </Badge>
              )}
              {noChange && (
                <span className="text-[10px] text-muted-foreground/60">No material change</span>
              )}
            </div>

            <p className="text-[10px] text-muted-foreground mt-0.5">{config.focusLabel}</p>

            {result ? (
              <p className="text-[11px] text-foreground/70 mt-1.5 leading-relaxed line-clamp-2">
                {result.shortSummary}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground/50 mt-1.5 italic">Not yet analyzed</p>
            )}

            {result && (
              <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Checked {timeAgo(result.lastCheckedAt)}
                </span>
                {result.lastMaterialUpdateAt !== result.lastCheckedAt && (
                  <span className="flex items-center gap-1">
                    <Zap className="h-3 w-3" />
                    Material: {timeAgo(result.lastMaterialUpdateAt)}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => onRunSingle(config.id)}
              disabled={isRunning}
              title="Update this investor"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRunning ? "animate-spin" : ""}`} />
            </Button>
            {result && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px] px-2"
                onClick={() => setDetailOpen(true)}
              >
                Details
              </Button>
            )}
          </div>
        </div>
      </div>

      {result && (
        <InvestorDetailDialog
          result={result}
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function InvestorWatch() {
  const qc = useQueryClient();
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [runningAll, setRunningAll] = useState(false);

  const { data: configData } = useQuery({
    queryKey: ["investor-watch-config"],
    queryFn: () => customFetch("/api/investor-watch/config") as Promise<{ investors: InvestorConfig[] }>,
  });

  const { data: resultsData, refetch: refetchResults } = useQuery({
    queryKey: ["investor-watch-results"],
    queryFn: () => customFetch("/api/investor-watch/results") as Promise<{ results: Record<string, InvestorResult> }>,
    refetchInterval: 30_000,
  });

  const investors = (configData?.investors ?? [])
    .filter(i => i.enabled)
    .sort((a, b) => a.displayOrder - b.displayOrder);

  const results = resultsData?.results ?? {};

  const runSingle = useCallback(async (investorId: string) => {
    setRunningIds(s => new Set([...s, investorId]));
    try {
      await customFetch("/api/investor-watch/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ investorId }),
      });
      await refetchResults();
      qc.invalidateQueries({ queryKey: ["investor-watch-results"] });
    } finally {
      setRunningIds(s => { const n = new Set(s); n.delete(investorId); return n; });
    }
  }, [refetchResults, qc]);

  const runAll = useCallback(async () => {
    setRunningAll(true);
    try {
      await customFetch("/api/investor-watch/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await refetchResults();
      qc.invalidateQueries({ queryKey: ["investor-watch-results"] });
    } finally {
      setRunningAll(false);
    }
  }, [refetchResults, qc]);

  const anyResult = Object.keys(results).length > 0;
  const lastChecked = anyResult
    ? Object.values(results).reduce((latest, r) =>
        r.lastCheckedAt > latest ? r.lastCheckedAt : latest, "")
    : null;

  return (
    <div className="p-4 space-y-4 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">Investor Watch</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Informational only — not connected to any investment decision pipeline
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastChecked && (
            <span className="text-[10px] text-muted-foreground">
              Updated {timeAgo(lastChecked)}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1.5"
            onClick={runAll}
            disabled={runningAll}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${runningAll ? "animate-spin" : ""}`} />
            {runningAll ? "Updating all…" : "Update all"}
          </Button>
        </div>
      </div>

      {/* Info banner */}
      <div className="rounded border border-border/40 bg-muted/30 px-3 py-2 flex items-start gap-2 text-[11px] text-muted-foreground">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-400" />
        <span>
          Investor Watch gives you a compact overview of what notable investors currently appear to think, say, or do.
          Evidence is classified as <strong className="text-foreground">Direct</strong>,{" "}
          <strong className="text-foreground">Filing</strong>,{" "}
          <strong className="text-foreground">Reporting</strong>, or{" "}
          <strong className="text-foreground">Interpretation</strong> — check the Details view to understand the strength of the evidence.
        </span>
      </div>

      {/* Investor cards */}
      <div className="space-y-2">
        {investors.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">No investors configured</p>
        )}
        {investors.map(inv => (
          <InvestorCard
            key={inv.id}
            config={inv}
            result={results[inv.id]}
            onRunSingle={runSingle}
            isRunning={runningIds.has(inv.id) || runningAll}
          />
        ))}
      </div>

      {!anyResult && investors.length > 0 && (
        <div className="text-center py-6">
          <p className="text-sm text-muted-foreground mb-3">No analyses yet. Run "Update all" to fetch the latest views.</p>
          <Button onClick={runAll} disabled={runningAll} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${runningAll ? "animate-spin" : ""}`} />
            {runningAll ? "Running…" : "Run first analysis"}
          </Button>
        </div>
      )}
    </div>
  );
}
