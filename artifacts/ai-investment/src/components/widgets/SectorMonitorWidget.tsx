import { useRef } from "react";
import { useGetRepositoryEntry } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo, sentimentColor } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot } from "@/lib/widget-components";

// ── Sector icon badge ─────────────────────────────────────────────────────────
// Returns an SVG path (viewBox 0 0 24 24) for each sector category.

function sectorSvgPath(name: string): string {
  const n = name.toLowerCase();
  // Healthcare — medical cross
  if (n.includes("health") || n.includes("pharma") || n.includes("biotech"))
    return "M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm1 13H11v-4H7v-2h4V5h2v4h4v2h-4v4z";
  // Technology — monitor/chip
  if (n.includes("tech") || n.includes("software") || n.includes("semi"))
    return "M4 4h16v10H4V4zm4 14h8m-4-4v4M9 4v10m6-10v10";
  // Financials — dollar sign
  if (n.includes("financ") || n.includes("bank") || n.includes("insur"))
    return "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6";
  // Energy — lightning bolt
  if (n.includes("energy") || n.includes("oil") || n.includes("gas"))
    return "M13 2L4 14h7l-1 8 10-12h-7z";
  // Industrials — gear/cog
  if (n.includes("industri") || n.includes("manufactur"))
    return "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7-3a7 7 0 0 0-.09-1l2.07-1.6-2-3.46-2.43.97A7 7 0 0 0 15 5.35l-.37-2.58h-5.2L9.06 5.35A7 7 0 0 0 7.45 6.9L5 5.94l-2 3.46L5.09 11A7 7 0 0 0 5 12a7 7 0 0 0 .09 1L3 14.6l2 3.46 2.43-.97A7 7 0 0 0 9 18.65l.37 2.58h5.2l.37-2.58A7 7 0 0 0 16.55 17.1l2.43.97 2-3.46L19.09 13A7 7 0 0 0 19 12z";
  // Materials — cube/box
  if (n.includes("material") || n.includes("mining") || n.includes("metal") || n.includes("chem"))
    return "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10";
  // Consumer Cyclical — shopping bag
  if (n.includes("consumer") && (n.includes("cycl") || n.includes("discret")))
    return "M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zm0 0h12M8 10a4 4 0 0 0 8 0";
  // Consumer Defensive / Staples — shield
  if (n.includes("consumer") || n.includes("staple") || n.includes("def"))
    return "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z";
  // Real Estate — house
  if (n.includes("real estate") || n.includes("reit") || n.includes("property"))
    return "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 0 0 1 1h3m10-11l2 2m-2-2v10a1 1 0 0 0-1 1h-3m-6 0a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1m6 0h-6";
  // Utilities — power plug / bolt
  if (n.includes("util"))
    return "M9 3v10a3 3 0 0 0 6 0V3M9 21h6m-3-8v4";
  // Communication / Telecom / Media — signal waves
  if (n.includes("communic") || n.includes("telecom") || n.includes("media"))
    return "M8.5 5.5A8.5 8.5 0 0 0 3.5 12a8.5 8.5 0 0 0 5 7.6M15.5 5.5A8.5 8.5 0 0 1 20.5 12a8.5 8.5 0 0 1-5 7.6M5.5 8.5A6 6 0 0 0 6 12a6 6 0 0 0 .5 3.5M18.5 8.5A6 6 0 0 1 18 12a6 6 0 0 1-.5 3.5M12 12h.01";
  // Transport / Logistics
  if (n.includes("transport") || n.includes("logistic"))
    return "M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v3m-4 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0zm6 0a2 2 0 1 0 4 0 2 2 0 0 0-4 0zm-6-4h8a2 2 0 0 1 2 2v1H9v-1a2 2 0 0 1 2-2zm3-10v6";
  // Aerospace / Defense
  if (n.includes("aerospace") || n.includes("defense"))
    return "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5";
  // Fallback — bar chart
  return "M18 20V10M12 20V4M6 20v-6";
}

interface SectorIconBadgeProps {
  name: string;
  color: string;
}

function SectorIconBadge({ name, color }: SectorIconBadgeProps) {
  const path = sectorSvgPath(name);
  const bg = `${color}22`; // ~13% opacity fill
  return (
    <div
      className="shrink-0 w-[18px] h-[18px] rounded-full flex items-center justify-center"
      style={{ border: `1.5px solid ${color}`, backgroundColor: bg }}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={path} />
      </svg>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ratingColor(rating: string) {
  if (/strong/i.test(rating)) return "text-green-400";
  if (/neutral/i.test(rating)) return "text-yellow-400";
  if (/weak/i.test(rating))   return "text-red-400";
  return "text-muted-foreground";
}

function trendArrow(trend: string | undefined) {
  if (!trend) return "→";
  if (/improv/i.test(trend))  return "↑";
  if (/weaken/i.test(trend))  return "↓";
  return "→";
}

function barStyle(rating: string): { width: string; color: string } {
  const r = rating.toLowerCase();
  if (r.includes("strong") && r.includes("moderate")) return { width: "72%",  color: "#86efac" };
  if (r.includes("strong"))                            return { width: "100%", color: "#4ade80" };
  if (r.includes("weak")   && r.includes("moderate")) return { width: "28%",  color: "#f97316" };
  if (r.includes("weak"))                              return { width: "14%",  color: "#f87171" };
  return { width: "50%", color: "#facc15" };
}

// ── Widget ────────────────────────────────────────────────────────────────────

export function SectorMonitorWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  const { data: entry, isLoading } = useGetRepositoryEntry("sector-monitor");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (entry as any)?.result as any;
  const updatedAt = (entry as any)?.updatedAt as string | undefined;

  const sectors: any[] = d?.sectors ?? [];
  const topSector = d?.topSector ?? sectors[0];
  const outlook = d?.overallOutlook ?? "";

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !d && <WidgetNoData />}
      {d && (
        <>
          {/* ── xs ── */}
          {size === "xs" && (
            <div className="h-full flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">Top:</span>
              <span className="text-xs font-medium text-foreground truncate">{topSector?.name ?? "—"}</span>
            </div>
          )}

          {/* ── sm ── */}
          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              <div className="flex items-center gap-1.5">
                <Dot color={sentimentColor(outlook)} />
                <span className={`text-[11px] font-medium ${sentimentColor(outlook)}`}>{outlook || "—"}</span>
              </div>
              {topSector && (
                <p className="text-[10px] text-muted-foreground truncate">
                  Top: <span className="text-foreground">{topSector.name}</span>
                </p>
              )}
              <span className="text-[10px] text-muted-foreground">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {/* ── md ── */}
          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <div className="flex items-center gap-1.5 shrink-0">
                <Dot color={sentimentColor(outlook)} />
                <span className={`text-xs font-semibold ${sentimentColor(outlook)}`}>{outlook || "—"}</span>
                <span className="text-[10px] text-muted-foreground ml-auto">{timeAgo(updatedAt)}</span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
                {sectors.map((s: any, i: number) => (
                  <div key={`${s.name}-${i}`} className="flex items-center gap-1.5 text-[10px]">
                    <span className={`${ratingColor(s.rating ?? "")} shrink-0 w-3`}>{trendArrow(s.trend)}</span>
                    <span className="text-foreground/90 truncate flex-1">{s.name}</span>
                    <span className={`shrink-0 ${ratingColor(s.rating ?? "")}`}>{s.rating?.replace("Moderately ", "Mod. ") ?? ""}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── lg ── */}
          {size === "lg" && (
            <div className="h-full flex flex-col gap-2 overflow-hidden">

              {/* ── Bar strength overview ── */}
              {sectors.length > 0 && (
                <div className="shrink-0 flex flex-col gap-0.5">
                  <div className="flex items-center justify-between mb-0.5">
                    <p className="text-[9px] text-muted-foreground uppercase tracking-wider">
                      Strength (relative to market)
                    </p>
                    <span className="text-[10px] text-muted-foreground">{timeAgo(updatedAt)}</span>
                  </div>
                  {sectors.map((s: any, i: number) => {
                    const { width, color } = barStyle(s.rating ?? "Neutral");
                    const label = (s.rating ?? "").replace("Moderately ", "Mod. ");
                    return (
                      <div key={`bar-${s.name}-${i}`} className="flex items-center gap-2 min-w-0">
                        <SectorIconBadge name={s.name} color={color} />
                        <span className="text-[11px] font-medium text-foreground w-24 shrink-0 whitespace-nowrap overflow-hidden text-ellipsis">
                          {s.name}
                        </span>
                        <div className="flex-1 h-1 rounded-full bg-white/5 overflow-hidden min-w-0">
                          <div className="h-full rounded-full" style={{ width, backgroundColor: color }} />
                        </div>
                        <span className="text-[9px] font-semibold w-16 text-right shrink-0 whitespace-nowrap" style={{ color }}>
                          {label.toUpperCase()}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="shrink-0 border-t border-border/40" />

              {/* Overall outlook summary */}
              {d.executiveSummary && (
                <p className="text-[11px] text-muted-foreground leading-relaxed shrink-0 line-clamp-2">
                  {d.executiveSummary}
                </p>
              )}

              {/* Per-sector detail cards */}
              <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                {sectors.map((s: any, i: number) => (
                  <div key={`${s.name}-${i}`} className="border-t border-border/30 pt-1">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[11px] font-semibold ${ratingColor(s.rating ?? "")} w-4 shrink-0`}>
                        {trendArrow(s.trend)}
                      </span>
                      <span className="text-[11px] font-medium text-foreground/90 flex-1 truncate">{s.name}</span>
                      <span className={`text-[10px] shrink-0 ${ratingColor(s.rating ?? "")}`}>
                        {s.rating?.replace("Moderately ", "Mod. ") ?? ""}
                      </span>
                    </div>
                    {s.summary && (
                      <p className="text-[10px] text-muted-foreground mt-0.5 ml-5 line-clamp-1">{s.summary}</p>
                    )}
                    {s.outlook && (
                      <p className="text-[10px] text-foreground/50 mt-0.5 ml-5 line-clamp-1 italic">{s.outlook}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
