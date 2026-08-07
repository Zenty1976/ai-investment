import { useRef } from "react";
import { useGetRepositoryEntry } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo, sentimentColor } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot } from "@/lib/widget-components";

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

  function ratingColor(rating: string) {
    if (/strong/i.test(rating)) return "text-green-400";
    if (/neutral/i.test(rating)) return "text-yellow-400";
    if (/weak/i.test(rating)) return "text-red-400";
    return "text-muted-foreground";
  }

  function trendArrow(trend: string | undefined) {
    if (!trend) return "→";
    if (/improv/i.test(trend)) return "↑";
    if (/weaken/i.test(trend)) return "↓";
    return "→";
  }

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !d && <WidgetNoData />}
      {d && (
        <>
          {size === "xs" && (
            <div className="h-full flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">Top:</span>
              <span className="text-xs font-medium text-foreground truncate">{topSector?.name ?? "—"}</span>
            </div>
          )}

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

          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <div className="flex items-center gap-1.5 shrink-0">
                <Dot color={sentimentColor(outlook)} />
                <span className={`text-xs font-semibold ${sentimentColor(outlook)}`}>{outlook || "—"}</span>
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
              <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {size === "lg" && (
            <div className="h-full flex flex-col gap-2 overflow-hidden">
              <div className="flex items-center justify-between shrink-0">
                <div className="flex items-center gap-1.5">
                  <Dot color={sentimentColor(outlook)} />
                  <span className={`text-xs font-semibold ${sentimentColor(outlook)}`}>{outlook || "—"}</span>
                </div>
                <span className="text-[10px] text-muted-foreground">{timeAgo(updatedAt)}</span>
              </div>

              {d.executiveSummary && (
                <p className="text-[11px] text-muted-foreground line-clamp-2 shrink-0">{d.executiveSummary}</p>
              )}

              {/* Per-sector cards */}
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
