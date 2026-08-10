import { useRef } from "react";
import { useGetRepositoryEntry } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo, sentimentColor } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot } from "@/lib/widget-components";

export function NewsMonitorWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  const { data: entry, isLoading } = useGetRepositoryEntry("news-monitor");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (entry as any)?.result as any;
  const updatedAt = (entry as any)?.updatedAt as string | undefined;

  const topStory = d?.topStory;
  // API returns field "news", not "items"
  const items: any[] = d?.news ?? d?.items ?? [];
  const highImpact = items.filter((i: any) => i.importance === "High").length;

  function impactColor(impact: string | undefined): string {
    if (!impact) return "text-muted-foreground";
    if (/positive/i.test(impact)) return "text-green-400";
    if (/negative/i.test(impact)) return "text-red-400";
    return "text-yellow-400";
  }

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !d && <WidgetNoData />}
      {d && (
        <>
          {size === "xs" && (
            <div className="h-full flex items-center gap-1.5">
              <span className="text-xs text-foreground font-medium">{items.length} stories</span>
              {highImpact > 0 && <span className="text-[10px] text-orange-400">· {highImpact} high-impact</span>}
            </div>
          )}

          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              {topStory && <p className="text-[11px] text-foreground font-medium line-clamp-2">{topStory.title}</p>}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground">{items.length} items</span>
                {highImpact > 0 && <span className="text-[10px] text-orange-400">{highImpact} high-impact</span>}
              </div>
            </div>
          )}

          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <span className="text-[10px] text-muted-foreground shrink-0 self-end">{timeAgo(updatedAt)}</span>
              {topStory && (
                <div className="shrink-0">
                  <div className="flex items-center gap-1 mb-0.5">
                    <Dot color="text-orange-400" />
                    <span className="text-[10px] text-orange-400 font-medium">Top Story</span>
                  </div>
                  <p className="text-[11px] text-foreground font-medium line-clamp-2 leading-tight">{topStory.title}</p>
                </div>
              )}
              <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
                {items.slice(0, 4).map((item: any, i: number) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px]">
                    <Dot color={sentimentColor(item.marketImpact?.toLowerCase?.().includes("positive") ? "positive" : item.marketImpact?.toLowerCase?.().includes("negative") ? "negative" : "neutral")} />
                    <span className="text-foreground/80 truncate">{item.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {size === "lg" && (
            <div className="h-full flex flex-col gap-2 overflow-hidden">
              <span className="text-[10px] text-muted-foreground shrink-0 self-end">{timeAgo(updatedAt)}</span>
              {/* Top story card */}
              {topStory && (
                <div className="rounded border border-orange-400/20 bg-orange-400/5 p-2 shrink-0">
                  <p className="text-[10px] text-orange-400 font-medium mb-1">Top Story</p>
                  <p className="text-[11px] text-foreground font-medium leading-tight">{topStory.title}</p>
                  {topStory.summary && (
                    <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">{topStory.summary}</p>
                  )}
                  {topStory.whyItMatters && (
                    <p className="text-[10px] text-foreground/60 mt-0.5 line-clamp-1 italic">{topStory.whyItMatters}</p>
                  )}
                </div>
              )}

              {d.executiveSummary && (
                <p className="text-[11px] text-muted-foreground line-clamp-2 shrink-0">{d.executiveSummary}</p>
              )}

              {/* News list */}
              <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                {items.map((item: any, i: number) => (
                  <div key={i} className="border-t border-border/30 pt-1">
                    <div className="flex items-start gap-1.5">
                      <Dot color={impactColor(item.marketImpact)} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] text-foreground/90 leading-tight">{item.title}</p>
                        {item.summary && (
                          <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">{item.summary}</p>
                        )}
                        {item.whyItMatters && !item.summary && (
                          <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">{item.whyItMatters}</p>
                        )}
                      </div>
                      <span className="text-[9px] text-muted-foreground shrink-0">{item.category}</span>
                    </div>
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
