/**
 * Catalyst Watch — Pre-Event Intelligence Dashboard (spec §21)
 *
 * Compact two-section view:
 *   1. UPCOMING CATALYSTS  — known scheduled events (PATH A)
 *   2. EMERGING SETUPS    — signal accumulation setups (PATH B)
 *
 * Click-for-details on each row.
 */

import { useState, useEffect } from "react";
import {
  Crosshair, Calendar, TrendingUp, TrendingDown, Minus,
  ChevronDown, ChevronRight, RefreshCw, Loader2,
  Zap, AlertTriangle, CheckCircle2, Eye, Target,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CatalystStatus {
  ticker: string;
  company: string;
  eligible: boolean;
  screeningLevel: string;
  daysUntilEvent: number | null;
  preliminaryState: string;
  priceAsymmetry: string;
  lastScreenedAt: string | null;
  lastAnalysedAt: string | null;
  eventPassed: boolean;
  hasAnalysis: boolean;
  // Part 2
  triggerType?: string | null;
  signalAccumulation?: {
    window14D?: { independentPositiveGroups: number; independentNegativeGroups: number };
    momentum?: string;
    direction?: string;
    evidenceConfidence?: string;
  } | null;
  emergingSetup?: {
    state: string;
    reasons?: string[];
    keyDrivers?: string[];
  } | null;
}

interface CatalystAnalysis {
  ticker: string;
  company: string;
  triggerType: string;
  analysisUpdateType: string | null;
  opportunityState: string | null;
  catalystDirection: string | null;
  thesis: string | null;
  promoted: boolean;
  signalAccumulation: {
    window14D?: { independentPositiveGroups: number };
    momentum?: string;
    direction?: string;
    evidenceConfidence?: string;
  } | null;
  emergingSetup: {
    state: string;
    reasons?: string[];
    keyDrivers?: string[];
  } | null;
  _debug?: {
    aiCalled?: boolean;
    skipped?: boolean;
    skipReason?: string;
    tokensUsed?: number;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_URL = (import.meta as Record<string, unknown>).env?.BASE_URL ?? "/ai-investment/";

function apiUrl(path: string): string {
  const base = String(BASE_URL).replace(/\/+$/, "");
  return `${base}/api${path}`;
}

function opportunityStateColor(state: string): string {
  switch (state) {
    case "CandidateForTradeDecision": return "text-emerald-400";
    case "HighInterest":              return "text-green-400";
    case "Investigate":               return "text-yellow-400";
    case "Monitor":                   return "text-blue-400";
    default:                          return "text-muted-foreground";
  }
}

function opportunityStateLabel(state: string): string {
  switch (state) {
    case "CandidateForTradeDecision": return "Trade Candidate";
    case "HighInterest":              return "High Interest";
    case "Investigate":               return "Investigate";
    case "Monitor":                   return "Monitor";
    case "NotInteresting":            return "Not Interesting";
    default:                          return state;
  }
}

function catalystDirectionIcon(direction: string | null) {
  if (!direction) return <Minus className="w-3 h-3 text-muted-foreground" />;
  if (direction.includes("POSITIVE")) return <TrendingUp className="w-3 h-3 text-green-400" />;
  if (direction.includes("NEGATIVE")) return <TrendingDown className="w-3 h-3 text-red-400" />;
  return <Minus className="w-3 h-3 text-muted-foreground" />;
}

function priceAsymmetryBadge(pa: string) {
  const colors: Record<string, string> = {
    VeryAttractive: "bg-emerald-900/50 text-emerald-300 border-emerald-700",
    Attractive:     "bg-green-900/50 text-green-300 border-green-700",
    Neutral:        "bg-zinc-800 text-zinc-300 border-zinc-600",
    Weak:           "bg-orange-900/50 text-orange-300 border-orange-700",
    Poor:           "bg-red-900/50 text-red-300 border-red-700",
  };
  return (
    <span className={cn("px-1.5 py-0.5 text-[10px] font-medium rounded border", colors[pa] ?? "bg-zinc-800 text-zinc-300 border-zinc-600")}>
      {pa === "VeryAttractive" ? "V.Attractive" : pa}
    </span>
  );
}

function emergingSetupBadge(state: string) {
  const colors: Record<string, string> = {
    URGENT_REVIEW: "bg-red-900/50 text-red-300 border-red-700",
    STRONG:        "bg-orange-900/50 text-orange-300 border-orange-700",
    DEVELOPING:    "bg-yellow-900/50 text-yellow-300 border-yellow-700",
    EARLY:         "bg-blue-900/50 text-blue-300 border-blue-700",
    NONE:          "bg-zinc-800/50 text-zinc-400 border-zinc-600",
  };
  const labels: Record<string, string> = {
    URGENT_REVIEW: "Urgent Review",
    STRONG:        "Strong Setup",
    DEVELOPING:    "Developing",
    EARLY:         "Early Signals",
    NONE:          "None",
  };
  return (
    <span className={cn("px-1.5 py-0.5 text-[10px] font-medium rounded border", colors[state] ?? "bg-zinc-800 text-zinc-400")}>
      {labels[state] ?? state}
    </span>
  );
}

// ── Analysis Detail Modal ──────────────────────────────────────────────────────

function AnalysisDetail({ analysis, onClose }: { analysis: CatalystAnalysis; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-lg p-5 max-w-lg w-full mx-4 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">{analysis.company}</h3>
            <span className="text-xs text-muted-foreground">{analysis.ticker} · {analysis.triggerType?.replace("_", " ")}</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
        </div>

        {analysis.opportunityState && (
          <div className={cn("text-sm font-medium mb-3", opportunityStateColor(analysis.opportunityState))}>
            {opportunityStateLabel(analysis.opportunityState)}
            {analysis.promoted && <span className="ml-2 text-emerald-400 text-xs">(promoted to OF)</span>}
          </div>
        )}

        {analysis.thesis && (
          <div className="bg-zinc-800/50 border border-zinc-700 rounded p-3 mb-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Thesis</div>
            <p className="text-sm text-foreground">{analysis.thesis}</p>
          </div>
        )}

        {analysis.emergingSetup && analysis.emergingSetup.state !== "NONE" && (
          <div className="mb-3">
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Emerging Setup</div>
            <div className="flex items-center gap-2 mb-2">
              {emergingSetupBadge(analysis.emergingSetup.state)}
            </div>
            {analysis.emergingSetup.reasons && analysis.emergingSetup.reasons.length > 0 && (
              <ul className="text-xs text-zinc-400 space-y-0.5">
                {analysis.emergingSetup.reasons.slice(0, 4).map((r, i) => (
                  <li key={i}>• {r}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {analysis.signalAccumulation && (
          <div className="text-xs text-muted-foreground space-y-0.5">
            <span>Signal momentum: {analysis.signalAccumulation.momentum ?? "?"}</span>
            <span className="mx-2">|</span>
            <span>Direction: {analysis.signalAccumulation.direction ?? "?"}</span>
            <span className="mx-2">|</span>
            <span>Confidence: {analysis.signalAccumulation.evidenceConfidence ?? "?"}</span>
          </div>
        )}

        {analysis._debug?.tokensUsed !== undefined && analysis._debug.tokensUsed > 0 && (
          <div className="text-[10px] text-zinc-600 mt-3">
            AI tokens: {analysis._debug.tokensUsed.toLocaleString()}
            {analysis._debug.skipped && <span className="ml-2">(fingerprint skip: {analysis._debug.skipReason})</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Row Components ─────────────────────────────────────────────────────────────

function CatalystRow({ state, onAnalyze }: { state: CatalystStatus; onAnalyze: (ticker: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [analysis, setAnalysis] = useState<CatalystAnalysis | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  const handleAnalyzeClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    onAnalyze(state.ticker);
    const res = await fetch(apiUrl(`/catalyst-intelligence/analyze/${state.ticker}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      setAnalysis(data as CatalystAnalysis);
      if (data.opportunityState) setShowDetail(true);
    }
  };

  return (
    <>
      <tr
        className="border-b border-zinc-800/60 hover:bg-zinc-800/20 cursor-pointer transition-colors"
        onClick={() => setExpanded(p => !p)}
      >
        <td className="py-2 px-3">
          <div className="flex items-center gap-2">
            {expanded ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
            <span className="font-mono text-xs font-semibold text-foreground">{state.ticker}</span>
          </div>
        </td>
        <td className="py-2 px-3 text-xs text-zinc-300 max-w-[160px] truncate">{state.company}</td>
        <td className="py-2 px-3 text-xs text-center">
          {state.daysUntilEvent !== null
            ? <span className={cn("font-mono", state.daysUntilEvent <= 7 ? "text-red-400 font-bold" : state.daysUntilEvent <= 21 ? "text-yellow-400" : "text-zinc-300")}>{state.daysUntilEvent}D</span>
            : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="py-2 px-3 text-center">{priceAsymmetryBadge(state.priceAsymmetry)}</td>
        <td className="py-2 px-3 text-xs text-center">
          {state.hasAnalysis ? (
            <span className="text-green-400 flex items-center justify-center gap-1">
              <CheckCircle2 className="w-3 h-3" />AI
            </span>
          ) : (
            <span className="text-zinc-600">—</span>
          )}
        </td>
        <td className="py-2 px-3 text-center">
          <button
            onClick={handleAnalyzeClick}
            className="px-2 py-0.5 text-[10px] rounded bg-blue-900/40 hover:bg-blue-800/60 text-blue-300 border border-blue-700/50 transition-colors"
          >
            Analyze
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-zinc-900/40">
          <td colSpan={6} className="px-6 py-2 text-xs text-zinc-400">
            <div className="flex gap-6 py-1">
              <span>Screening: <span className="text-zinc-200">{state.screeningLevel}</span></span>
              <span>Preliminary: <span className="text-zinc-200">{state.preliminaryState}</span></span>
              {state.lastScreenedAt && <span>Screened: <span className="text-zinc-200">{state.lastScreenedAt.slice(0, 10)}</span></span>}
            </div>
          </td>
        </tr>
      )}
      {showDetail && analysis && (
        <AnalysisDetail analysis={analysis} onClose={() => setShowDetail(false)} />
      )}
    </>
  );
}

function EmergingSetupRow({ state, onAnalyze }: { state: CatalystStatus; onAnalyze: (ticker: string) => void }) {
  const [showDetail, setShowDetail] = useState(false);
  const [analysis, setAnalysis] = useState<CatalystAnalysis | null>(null);

  const handleClick = async () => {
    const res = await fetch(apiUrl(`/catalyst-intelligence/analyze/${state.ticker}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      setAnalysis(data as CatalystAnalysis);
      if (data.emergingSetup?.state !== "NONE") setShowDetail(true);
    }
    onAnalyze(state.ticker);
  };

  const setup = state.emergingSetup;

  return (
    <>
      <tr
        className="border-b border-zinc-800/60 hover:bg-zinc-800/20 cursor-pointer transition-colors"
        onClick={handleClick}
      >
        <td className="py-2 px-3 font-mono text-xs font-semibold text-foreground">{state.ticker}</td>
        <td className="py-2 px-3 text-xs text-zinc-300 max-w-[160px] truncate">{state.company}</td>
        <td className="py-2 px-3 text-center">
          {setup && emergingSetupBadge(setup.state)}
        </td>
        <td className="py-2 px-3 text-xs text-zinc-400">
          {state.signalAccumulation?.momentum ?? "—"}
        </td>
        <td className="py-2 px-3 text-xs text-zinc-400">
          {state.signalAccumulation?.window14D?.independentPositiveGroups ?? 0} pos. sources
        </td>
        <td className="py-2 px-3 text-center">
          <Eye className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-200 transition-colors" />
        </td>
      </tr>
      {showDetail && analysis && (
        <AnalysisDetail analysis={analysis} onClose={() => setShowDetail(false)} />
      )}
    </>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function CatalystWatch() {
  const [states, setStates] = useState<CatalystStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [screening, setScreening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyzingTicker, setAnalyzingTicker] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const loadStatus = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(apiUrl("/catalyst-intelligence/status"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.states) setStates(data.states as CatalystStatus[]);
      setLastRefreshed(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const runScreening = async () => {
    try {
      setScreening(true);
      setError(null);
      const res = await fetch(apiUrl("/catalyst-intelligence/screen"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScreening(false);
    }
  };

  useEffect(() => { loadStatus(); }, []);

  // Separate PATH A (scheduled event) from PATH B (emerging setup)
  const scheduledCatalysts = states.filter(s =>
    s.eligible && !s.eventPassed &&
    s.daysUntilEvent !== null &&
    s.triggerType !== "EMERGING_SETUP"
  ).sort((a, b) => (a.daysUntilEvent ?? 999) - (b.daysUntilEvent ?? 999));

  const emergingSetups = states.filter(s =>
    s.emergingSetup && s.emergingSetup.state !== "NONE" &&
    (s.emergingSetup.state === "DEVELOPING" ||
     s.emergingSetup.state === "STRONG" ||
     s.emergingSetup.state === "URGENT_REVIEW")
  );

  const allEligible = states.filter(s => s.eligible && !s.eventPassed);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-zinc-950/50 sticky top-0 z-10">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Crosshair className="w-5 h-5 text-blue-400" />
            <div>
              <h1 className="text-base font-semibold tracking-tight">Catalyst Watch</h1>
              <p className="text-xs text-muted-foreground">Pre-Event Intelligence · {states.length} tracked tickers</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {lastRefreshed && (
              <span className="text-[11px] text-zinc-600">
                Updated {lastRefreshed.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
            <button
              onClick={runScreening}
              disabled={screening}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-blue-900/50 hover:bg-blue-800/60 text-blue-300 border border-blue-700/50 transition-colors disabled:opacity-50"
            >
              {screening ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Screen All
            </button>
            <button
              onClick={loadStatus}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition-colors disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="px-6 py-6 space-y-6 max-w-6xl">
        {error && (
          <div className="flex items-center gap-2 text-sm text-red-400 bg-red-950/30 border border-red-800/40 rounded px-3 py-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Stats bar */}
        {states.length > 0 && (
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: "Tracked", value: states.length, color: "text-zinc-300" },
              { label: "Eligible", value: allEligible.length, color: "text-blue-400" },
              { label: "Path A (Scheduled)", value: scheduledCatalysts.length, color: "text-green-400" },
              { label: "Path B (Emerging)", value: emergingSetups.length, color: "text-yellow-400" },
            ].map(stat => (
              <div key={stat.label} className="bg-zinc-900/60 border border-zinc-800 rounded-lg px-4 py-3">
                <div className={cn("text-2xl font-mono font-bold", stat.color)}>{stat.value}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">{stat.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* PATH A: Upcoming Catalysts */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Calendar className="w-4 h-4 text-green-400" />
            <h2 className="text-sm font-semibold">Upcoming Catalysts (PATH A)</h2>
            <span className="text-xs text-muted-foreground">Scheduled events · sorted by proximity</span>
          </div>

          {scheduledCatalysts.length === 0 ? (
            <div className="text-sm text-muted-foreground bg-zinc-900/40 border border-zinc-800 rounded-lg px-4 py-8 text-center">
              {states.length === 0
                ? "Run screening to find upcoming catalyst events."
                : "No eligible upcoming catalysts. Run screening to refresh."}
            </div>
          ) : (
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-lg overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-950/50">
                    <th className="text-left py-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Ticker</th>
                    <th className="text-left py-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Company</th>
                    <th className="text-center py-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Days</th>
                    <th className="text-center py-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Asymmetry</th>
                    <th className="text-center py-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">AI</th>
                    <th className="text-center py-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {scheduledCatalysts.map(s => (
                    <CatalystRow
                      key={s.ticker}
                      state={s}
                      onAnalyze={ticker => setAnalyzingTicker(ticker)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* PATH B: Emerging Setups */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Zap className="w-4 h-4 text-yellow-400" />
            <h2 className="text-sm font-semibold">Emerging Setups (PATH B)</h2>
            <span className="text-xs text-muted-foreground">Signal accumulation · no scheduled event required</span>
          </div>

          {emergingSetups.length === 0 ? (
            <div className="text-sm text-muted-foreground bg-zinc-900/40 border border-zinc-800 rounded-lg px-4 py-8 text-center">
              No DEVELOPING or stronger emerging setups detected. Run analysis on screened tickers to compute signal accumulation.
            </div>
          ) : (
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-lg overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-950/50">
                    <th className="text-left py-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Ticker</th>
                    <th className="text-left py-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Company</th>
                    <th className="text-center py-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Setup</th>
                    <th className="text-left py-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Momentum</th>
                    <th className="text-left py-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Evidence</th>
                    <th className="text-center py-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {emergingSetups.map(s => (
                    <EmergingSetupRow
                      key={s.ticker}
                      state={s}
                      onAnalyze={ticker => setAnalyzingTicker(ticker)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* All screened — eligible but no event */}
        {allEligible.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Target className="w-4 h-4 text-zinc-400" />
              <h2 className="text-sm font-semibold text-zinc-400">All Eligible Tickers</h2>
              <span className="text-xs text-muted-foreground">{allEligible.length} tickers passed screening</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {allEligible.map(s => (
                <div
                  key={s.ticker}
                  className="flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800/60 border border-zinc-700/50 text-xs"
                >
                  {catalystDirectionIcon(null)}
                  <span className="font-mono font-medium">{s.ticker}</span>
                  {s.daysUntilEvent !== null && (
                    <span className="text-muted-foreground text-[10px]">{s.daysUntilEvent}D</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!loading && states.length === 0 && (
          <div className="text-center py-16">
            <Crosshair className="w-12 h-12 text-zinc-700 mx-auto mb-4" />
            <p className="text-muted-foreground mb-4">No catalyst intelligence data found.</p>
            <button
              onClick={runScreening}
              disabled={screening}
              className="px-4 py-2 text-sm rounded bg-blue-900/50 hover:bg-blue-800/60 text-blue-300 border border-blue-700/50 transition-colors disabled:opacity-50"
            >
              {screening ? "Screening..." : "Run Initial Screening"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
