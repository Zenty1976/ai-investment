import { useRef, useState, useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { useGetRepositoryEntry } from "@workspace/api-client-react";
import { useGetMarketMonitorHistory } from "@workspace/api-client-react";
import type { MarketAnalysis, MarketMonitorHistoryEntry } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo, sentimentColor } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot } from "@/lib/widget-components";

// ── Period config ─────────────────────────────────────────────────────────────

type Period = "1W" | "1M" | "3M" | "1Y";
const PERIODS: { label: string; key: Period; days: number }[] = [
  { label: "1U",  key: "1W", days: 7   },
  { label: "1M",  key: "1M", days: 30  },
  { label: "3M",  key: "3M", days: 90  },
  { label: "1Å",  key: "1Y", days: 365 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreColor(score: number) {
  if (score > 0) return "#4ade80"; // green-400
  if (score < 0) return "#f87171"; // red-400
  return "#94a3b8"; // slate-400
}

function formatAxisDate(isoTs: string, days: number): string {
  const d = new Date(isoTs);
  if (days <= 7)  return d.toLocaleDateString("da-DK", { weekday: "short" });
  if (days <= 31) return d.toLocaleDateString("da-DK", { day: "numeric", month: "short" });
  return d.toLocaleDateString("da-DK", { month: "short" });
}

function filterByPeriod(entries: MarketMonitorHistoryEntry[], days: number) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return entries
    .filter(e => new Date(e.timestamp).getTime() >= cutoff)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()); // oldest → newest (right = newest)
}

// ── Custom tooltip ─────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: MarketMonitorHistoryEntry }[] }) {
  if (!active || !payload?.length) return null;
  const e = payload[0].payload;
  const d = new Date(e.timestamp);
  return (
    <div className="rounded border border-border bg-background/95 px-2 py-1.5 text-[11px] shadow">
      <p className="text-muted-foreground">{d.toLocaleDateString("da-DK", { day: "numeric", month: "short", year: "numeric" })}</p>
      <p style={{ color: scoreColor(e.score) }} className="font-medium">{e.sentiment}</p>
      <p className="text-muted-foreground">{e.riskLevel} Risk</p>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function MarketMonitorWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  const { data: entry, isLoading } = useGetRepositoryEntry("market-monitor");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (entry as any)?.result as MarketAnalysis | undefined;
  const updatedAt = (entry as any)?.updatedAt as string | undefined;

  const { data: historyEntry } = useGetMarketMonitorHistory();
  const allEntries: MarketMonitorHistoryEntry[] = historyEntry?.result?.entries ?? [];

  const [period, setPeriod] = useState<Period>("3M");
  const activeDays = PERIODS.find(p => p.key === period)!.days;

  const chartData = useMemo(() => filterByPeriod(allEntries, activeDays), [allEntries, activeDays]);

  // Dominant colour: based on avg score over the period
  const avgScore = chartData.length
    ? chartData.reduce((s, e) => s + e.score, 0) / chartData.length
    : 0;
  const lineColor = scoreColor(avgScore);

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !d && <WidgetNoData />}

      {d && (
        <>
          {/* ── xs ── */}
          {size === "xs" && (
            <div className="h-full flex items-center gap-1.5">
              <Dot color={sentimentColor(d.marketSentiment)} />
              <span className={`text-xs font-medium truncate ${sentimentColor(d.marketSentiment)}`}>{d.marketSentiment}</span>
              <span className={`text-[10px] truncate ${sentimentColor(d.riskLevel)}`}>· {d.riskLevel} Risk</span>
            </div>
          )}

          {/* ── sm ── */}
          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              <div className="flex items-center gap-1.5">
                <Dot color={sentimentColor(d.marketSentiment)} />
                <span className={`text-xs font-semibold ${sentimentColor(d.marketSentiment)}`}>{d.marketSentiment}</span>
                <span className={`text-[11px] ${sentimentColor(d.riskLevel)}`}>· {d.riskLevel} risk</span>
              </div>
              <span className="text-[10px] text-muted-foreground">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {/* ── md ── */}
          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <div className="flex items-center gap-1.5 shrink-0">
                <Dot color={sentimentColor(d.marketSentiment)} />
                <span className={`text-xs font-semibold ${sentimentColor(d.marketSentiment)}`}>{d.marketSentiment}</span>
                <span className={`text-[11px] ${sentimentColor(d.riskLevel)}`}>· {d.riskLevel} risk</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-3 shrink-0">{d.summary}</p>
              <span className="text-[10px] text-muted-foreground mt-auto">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {/* ── lg — chart view ── */}
          {size === "lg" && (
            <div className="h-full flex flex-col gap-2 overflow-hidden">
              {/* Header row */}
              <div className="flex items-center gap-2 shrink-0">
                <Dot color={sentimentColor(d.marketSentiment)} />
                <span className={`text-sm font-semibold uppercase tracking-wide ${sentimentColor(d.marketSentiment)}`}>
                  {d.marketSentiment}
                </span>
                <span className={`text-[11px] ${sentimentColor(d.riskLevel)}`}>· {d.riskLevel} Risk</span>
                <span className="text-[10px] text-muted-foreground ml-auto">{timeAgo(updatedAt)}</span>
              </div>

              {/* Period selector */}
              <div className="flex items-center gap-1 shrink-0">
                {PERIODS.map(p => (
                  <button
                    key={p.key}
                    onClick={() => setPeriod(p.key)}
                    className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                      period === p.key
                        ? "bg-foreground/10 text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Chart */}
              <div className="flex-1 min-h-0">
                {chartData.length === 0 ? (
                  <div className="h-full flex items-center justify-center">
                    <p className="text-[11px] text-muted-foreground">Ingen historik endnu for denne periode</p>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
                      <defs>
                        <linearGradient id="mmGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor={lineColor} stopOpacity={0.25} />
                          <stop offset="95%" stopColor={lineColor} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <ReferenceLine y={0} stroke="#334155" strokeDasharray="3 3" />
                      <XAxis
                        dataKey="timestamp"
                        tickFormatter={ts => formatAxisDate(ts, activeDays)}
                        tick={{ fontSize: 10, fill: "#64748b" }}
                        tickLine={false}
                        axisLine={false}
                        interval="preserveStartEnd"
                        minTickGap={40}
                      />
                      <YAxis
                        domain={[-1.2, 1.2]}
                        ticks={[-1, 0, 1]}
                        tickFormatter={v => v === 1 ? "+Pos" : v === -1 ? "−Neg" : "0"}
                        tick={{ fontSize: 9, fill: "#64748b" }}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip content={<ChartTooltip />} />
                      <Area
                        type="monotone"
                        dataKey="score"
                        stroke={lineColor}
                        strokeWidth={1.5}
                        fill="url(#mmGrad)"
                        dot={false}
                        activeDot={{ r: 3, fill: lineColor }}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
