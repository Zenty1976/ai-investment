import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, ScoreBar } from "@/lib/widget-components";

// ── Helpers ──────────────────────────────────────────────────────────────────

function ratingColor(r: string | undefined) {
  if (!r) return "text-muted-foreground";
  const v = r.toLowerCase();
  if (v.includes("strong buy")) return "text-green-400";
  if (v.includes("buy"))        return "text-green-300";
  if (v.includes("watch"))      return "text-yellow-400";
  if (v.includes("avoid"))      return "text-red-400";
  return "text-muted-foreground";
}

function ratingBadgeStyle(r: string | undefined): string {
  if (!r) return "text-muted-foreground border-muted-foreground/30";
  const v = r.toLowerCase();
  if (v.includes("strong buy")) return "text-green-400 border-green-400/40 bg-green-400/10";
  if (v.includes("buy"))        return "text-green-300 border-green-300/40 bg-green-300/10";
  if (v.includes("watch"))      return "text-yellow-400 border-yellow-400/40 bg-yellow-400/10";
  if (v.includes("review"))     return "text-orange-400 border-orange-400/40 bg-orange-400/10";
  if (v.includes("avoid"))      return "text-red-400 border-red-400/40 bg-red-400/10";
  return "text-muted-foreground border-muted-foreground/30";
}

function scoreCircleColor(score: number | null): string {
  if (score === null) return "#6b7280";
  if (score >= 70) return "#4ade80";
  if (score >= 50) return "#facc15";
  return "#f87171";
}

// SVG circular score indicator
function ScoreCircle({ score }: { score: number | null }) {
  const r = 18;
  const circ = 2 * Math.PI * r;
  const pct = score !== null ? Math.max(0, Math.min(100, score)) / 100 : 0;
  const color = scoreCircleColor(score);
  return (
    <svg width={44} height={44} viewBox="0 0 44 44">
      <circle cx={22} cy={22} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={4} />
      <circle
        cx={22} cy={22} r={r}
        fill="none"
        stroke={color}
        strokeWidth={4}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - pct)}
        transform="rotate(-90 22 22)"
        style={{ transition: "stroke-dashoffset 0.5s ease" }}
      />
      <text x={22} y={26} textAnchor="middle" fontSize={11} fontWeight="bold" fill={color}>
        {score !== null ? score : "—"}
      </text>
    </svg>
  );
}

// Company logo via Financial Modeling Prep (free, ticker-based)
function CompanyLogo({ ticker }: { ticker: string }) {
  const [failed, setFailed] = useState(false);
  const src = `https://financialmodelingprep.com/image-stock/${ticker}.png`;

  if (failed) {
    return (
      <div className="w-10 h-10 rounded flex items-center justify-center bg-white/5 text-[10px] font-bold text-muted-foreground">
        {ticker.slice(0, 3)}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={ticker}
      className="w-10 h-10 object-contain rounded"
      onError={() => setFailed(true)}
    />
  );
}

// ── Toggle icon components ────────────────────────────────────────────────────
function ListIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <line x1={1} y1={3.5} x2={13} y2={3.5} />
      <line x1={1} y1={7}   x2={13} y2={7} />
      <line x1={1} y1={10.5} x2={13} y2={10.5} />
    </svg>
  );
}
function GridIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x={1} y={1} width={5} height={5} rx={1} />
      <rect x={8} y={1} width={5} height={5} rx={1} />
      <rect x={1} y={8} width={5} height={5} rx={1} />
      <rect x={8} y={8} width={5} height={5} rx={1} />
    </svg>
  );
}

// ── Widget ────────────────────────────────────────────────────────────────────

export function CompanyMonitorWidget() {
  const ref  = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  const [viewMode, setViewMode] = useState<"list" | "card">("list");

  const { data: allEntries, isLoading } = useQuery<any[]>({
    queryKey: ["repository/all-entries"],
    queryFn: () => customFetch<any[]>("/api/repository"),
    refetchInterval: 60_000,
    select: (entries) =>
      (entries ?? []).filter((e: any) => e.moduleName?.startsWith("company-monitor:")),
  });

  const entries = allEntries ?? [];

  const companies = entries
    .map((e: any) => {
      const result = e.result as any;
      return {
        ticker:    result?.company?.ticker ?? e.moduleName.replace("company-monitor:", ""),
        name:      result?.company?.name ?? "",
        rating:    result?.investmentView?.rating ?? "",
        strength:  result?.investmentCaseStrength ?? null,
        updatedAt: e.updatedAt,
      };
    })
    .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0));

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && entries.length === 0 && <WidgetNoData label="No companies analyzed yet" />}
      {entries.length > 0 && (
        <>
          {/* xs */}
          {size === "xs" && (
            <div className="h-full flex items-center gap-1.5">
              <span className="text-xs font-medium text-foreground">{companies.length}</span>
              <span className="text-[10px] text-muted-foreground">companies analyzed</span>
            </div>
          )}

          {/* sm */}
          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              <p className="text-[10px] text-muted-foreground">{companies.length} analyzed</p>
              <div className="space-y-0.5">
                {companies.slice(0, 2).map(c => (
                  <div key={c.ticker} className="flex items-center gap-1.5 text-[10px]">
                    <span className="font-medium text-foreground w-12 truncate">{c.ticker}</span>
                    <span className={`truncate flex-1 ${ratingColor(c.rating)}`}>{c.rating}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* md */}
          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <p className="text-[10px] text-muted-foreground shrink-0">{companies.length} companies</p>
              <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
                {companies.map(c => (
                  <div key={c.ticker} className="flex items-center gap-1.5 text-[10px]">
                    <span className="font-semibold text-foreground w-14 shrink-0 truncate">{c.ticker}</span>
                    {c.strength !== null && (
                      <div className="w-16 shrink-0">
                        <ScoreBar
                          score={c.strength}
                          color={c.strength >= 70 ? "bg-green-400/60" : c.strength >= 50 ? "bg-yellow-400/60" : "bg-red-400/40"}
                        />
                      </div>
                    )}
                    <span className={`truncate flex-1 ${ratingColor(c.rating)}`}>{c.rating}</span>
                    <span className="text-muted-foreground shrink-0">{timeAgo(c.updatedAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* lg — list or card view */}
          {size === "lg" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">

              {/* Header with toggle */}
              <div className="flex items-center justify-between shrink-0">
                <p className="text-[10px] text-muted-foreground font-medium">{companies.length} companies analyzed</p>
                <div className="flex items-center gap-0.5 rounded-md border border-border/50 p-0.5">
                  <button
                    onClick={() => setViewMode("list")}
                    className={`p-1 rounded transition-colors ${viewMode === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    title="List view"
                  >
                    <ListIcon />
                  </button>
                  <button
                    onClick={() => setViewMode("card")}
                    className={`p-1 rounded transition-colors ${viewMode === "card" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    title="Card view"
                  >
                    <GridIcon />
                  </button>
                </div>
              </div>

              {/* ── List view ── */}
              {viewMode === "list" && (
                <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                  {companies.map(c => (
                    <div key={c.ticker} className="rounded border border-border/50 px-2 py-1.5 flex items-center gap-2">
                      <div className="w-16 shrink-0">
                        <p className="text-[11px] font-bold text-foreground truncate">{c.ticker}</p>
                        <p className="text-[9px] text-muted-foreground truncate">{c.name}</p>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-[10px] font-medium ${ratingColor(c.rating)} truncate`}>{c.rating}</p>
                        {c.strength !== null && (
                          <div className="mt-0.5">
                            <ScoreBar
                              score={c.strength}
                              color={c.strength >= 70 ? "bg-green-400/60" : c.strength >= 50 ? "bg-yellow-400/60" : "bg-red-400/40"}
                            />
                          </div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        {c.strength !== null && <p className="text-[10px] text-muted-foreground">{c.strength}/100</p>}
                        <p className="text-[9px] text-muted-foreground">{timeAgo(c.updatedAt)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Card view ── */}
              {viewMode === "card" && (
                <div className="flex-1 overflow-y-auto min-h-0">
                  <div className="grid grid-cols-3 gap-2 pb-1">
                    {companies.map(c => (
                      <div
                        key={c.ticker}
                        className="rounded-lg border border-border/50 bg-card/40 p-2.5 flex flex-col items-center gap-1.5 text-center"
                      >
                        {/* Logo */}
                        <CompanyLogo ticker={c.ticker} />

                        {/* Ticker */}
                        <span className="text-[11px] font-bold text-foreground leading-none truncate w-full text-center">
                          {c.ticker}
                        </span>

                        {/* Rating badge */}
                        {c.rating && (
                          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border leading-none ${ratingBadgeStyle(c.rating)}`}>
                            {c.rating}
                          </span>
                        )}

                        {/* Score circle */}
                        <ScoreCircle score={c.strength} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
