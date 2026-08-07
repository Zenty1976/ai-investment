import { useRef } from "react";
import { useGetRepositoryEntry } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo, sentimentColor } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot } from "@/lib/widget-components";

export function MarketAlertsWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  const { data: entry, isLoading } = useGetRepositoryEntry("market-alerts");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (entry as any)?.result as any;
  const updatedAt = (entry as any)?.updatedAt as string | undefined;

  const alertLevel: string = d?.overallAlertLevel ?? "";
  const alerts: any[] = d?.alerts ?? [];
  const highAlerts = alerts.filter(a => a.importance === "High").length;
  const noChanges = d?.noNewDevelopmentsSinceLastCheck === true;

  const levelColor = alertLevel === "High" ? "text-red-400"
    : alertLevel === "Medium" ? "text-yellow-400"
    : alertLevel === "Low" ? "text-green-400"
    : "text-muted-foreground";

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !d && <WidgetNoData />}
      {d && (
        <>
          {size === "xs" && (
            <div className="h-full flex items-center gap-1.5">
              <Dot color={levelColor} />
              <span className={`text-xs font-medium ${levelColor}`}>{alerts.length} alert{alerts.length !== 1 ? "s" : ""}</span>
              <span className={`text-[10px] ${levelColor}`}>· {alertLevel}</span>
            </div>
          )}

          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              <div className="flex items-center gap-1.5">
                <Dot color={levelColor} />
                <span className={`text-[11px] font-semibold ${levelColor}`}>{alertLevel} Alert Level</span>
              </div>
              {noChanges
                ? <p className="text-[10px] text-muted-foreground">No new developments</p>
                : <p className="text-[10px] text-foreground/70 truncate">{d.headline}</p>
              }
              <span className="text-[10px] text-muted-foreground">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <div className="flex items-center gap-1.5 shrink-0">
                <Dot color={levelColor} />
                <span className={`text-xs font-semibold ${levelColor}`}>{alertLevel}</span>
                <span className="text-muted-foreground mx-0.5 text-[10px]">·</span>
                <span className="text-[10px] text-muted-foreground">{alerts.length} alert{alerts.length !== 1 ? "s" : ""}</span>
              </div>
              {noChanges
                ? <p className="text-[11px] text-muted-foreground">No new developments since last check</p>
                : <p className="text-[11px] text-muted-foreground line-clamp-2 shrink-0">{d.headline}</p>
              }
              <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
                {alerts.slice(0, 4).map((a: any, i: number) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px]">
                    <Dot color={a.importance === "High" ? "text-red-400" : a.importance === "Medium" ? "text-yellow-400" : "text-muted-foreground"} />
                    <span className="text-foreground/80 truncate">{a.title}</span>
                    {a.status === "New" && <span className="text-blue-400 shrink-0">New</span>}
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
                  <Dot color={levelColor} />
                  <span className={`text-xs font-semibold ${levelColor}`}>{alertLevel} Alert Level</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  {highAlerts > 0 && <span className="text-red-400">{highAlerts} high</span>}
                  <span>{alerts.length} total</span>
                </div>
              </div>
              {noChanges
                ? <p className="text-[11px] text-green-400">✓ No new developments since last check</p>
                : <p className="text-[11px] text-muted-foreground line-clamp-2 shrink-0">{d.headline}</p>
              }
              <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                {alerts.map((a: any, i: number) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <Dot color={a.importance === "High" ? "text-red-400" : a.importance === "Medium" ? "text-yellow-400" : "text-green-400"} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <p className="text-[11px] text-foreground/90 truncate">{a.title}</p>
                        {a.status === "New" && <span className="text-[9px] text-blue-400 shrink-0 font-medium">NEW</span>}
                      </div>
                      {a.category && <p className="text-[10px] text-muted-foreground">{a.category}</p>}
                    </div>
                  </div>
                ))}
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(updatedAt)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
