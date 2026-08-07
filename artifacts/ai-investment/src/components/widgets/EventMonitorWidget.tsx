import { useRef } from "react";
import { useGetRepositoryEntry } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo, sentimentColor } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot } from "@/lib/widget-components";

function daysUntil(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const diff = new Date(dateStr).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0);
  return Math.round(diff / 86_400_000);
}

function countdownText(days: number | null): string {
  if (days === null) return "—";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 0) return `${Math.abs(days)}d ago`;
  return `in ${days}d`;
}

export function EventMonitorWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  const { data: entry, isLoading } = useGetRepositoryEntry("event-monitor");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (entry as any)?.result as any;
  const updatedAt = (entry as any)?.updatedAt as string | undefined;

  const nextEvent = d?.nextMajorEvent;
  const events: any[] = d?.events ?? [];
  const highCount = events.filter((e: any) => e.importance === "High").length;

  const countdownLabel = nextEvent
    ? countdownText(nextEvent.countdownDays ?? daysUntil(nextEvent.date))
    : null;

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !d && <WidgetNoData />}
      {d && (
        <>
          {size === "xs" && (
            <div className="h-full flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Next:</span>
              <span className={`text-xs font-medium ${countdownLabel === "Today" ? "text-orange-400" : "text-foreground"}`}>
                {countdownLabel ?? "—"}
              </span>
            </div>
          )}

          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              {nextEvent && (
                <div>
                  <p className="text-[11px] font-medium text-foreground truncate">{nextEvent.title}</p>
                  <p className={`text-[10px] ${countdownLabel === "Today" ? "text-orange-400" : "text-muted-foreground"}`}>{countdownLabel}</p>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground">{events.length} events</span>
                {highCount > 0 && <span className="text-[10px] text-orange-400">{highCount} high</span>}
              </div>
            </div>
          )}

          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              {nextEvent && (
                <div className="rounded border border-border/50 p-1.5 shrink-0">
                  <div className="flex items-center gap-1 mb-0.5">
                    <span className="text-[10px] text-muted-foreground">Next major event</span>
                    <span className={`text-[10px] ml-auto font-medium ${countdownLabel === "Today" ? "text-orange-400" : "text-yellow-400"}`}>
                      {countdownLabel}
                    </span>
                  </div>
                  <p className="text-[11px] font-medium text-foreground leading-tight">{nextEvent.title}</p>
                </div>
              )}
              <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
                {events.slice(0, 5).map((ev: any, i: number) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px]">
                    <Dot color={sentimentColor(ev.importance === "High" ? "negative" : ev.importance === "Medium" ? "neutral" : "positive")} />
                    <span className="text-foreground/80 truncate flex-1">{ev.title}</span>
                    <span className="text-muted-foreground shrink-0">{countdownText(ev.countdownDays ?? daysUntil(ev.date))}</span>
                  </div>
                ))}
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {size === "lg" && (
            <div className="h-full flex flex-col gap-2 overflow-hidden">
              {/* Next major event card */}
              {nextEvent && (
                <div className="rounded border border-yellow-400/20 bg-yellow-400/5 p-2 shrink-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-muted-foreground font-medium">Next major event</span>
                    <span className={`text-[10px] font-semibold ${countdownLabel === "Today" ? "text-orange-400" : "text-yellow-400"}`}>
                      {countdownLabel}
                    </span>
                  </div>
                  <p className="text-xs font-semibold text-foreground">{nextEvent.title}</p>
                  {nextEvent.expectedImpact && (
                    <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{nextEvent.expectedImpact}</p>
                  )}
                </div>
              )}

              {d.summary && <p className="text-[11px] text-muted-foreground line-clamp-2 shrink-0">{d.summary}</p>}

              {/* Full event list */}
              <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                {events.map((ev: any, i: number) => {
                  const days = ev.countdownDays ?? daysUntil(ev.date);
                  const isHigh = ev.importance === "High";
                  return (
                    <div key={i} className="border-t border-border/30 pt-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[10px] shrink-0 w-14 text-right font-medium ${isHigh ? "text-orange-400" : "text-muted-foreground"}`}>
                          {countdownText(days)}
                        </span>
                        <p className="text-[11px] text-foreground/90 truncate flex-1">{ev.title}</p>
                        <span className="text-[9px] text-muted-foreground shrink-0">{ev.category}</span>
                      </div>
                      {ev.expectedImpact && (
                        <p className="text-[10px] text-muted-foreground ml-14 mt-0.5 line-clamp-1">{ev.expectedImpact}</p>
                      )}
                    </div>
                  );
                })}
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(updatedAt)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
