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
  const items: any[] = d?.items ?? [];
  const highImpact = items.filter(i => i.importance === "High" || i.marketImpact === "High").length;

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
              {topStory && (
                <div className="shrink-0">
                  <div className="flex items-center gap-1 mb-0.5">
                    <Dot color="text-orange-400" />
                    <span className="text-[10px] text-orange-400 font-medium">Top Story</span>
                  </div>
                  <p className="text-[11px] text-foreground font-medium line-clamp-2 leading-tight">{topStory.title}</p>
                </div>
              )}
              {d.executiveSummary && (
                <p className="text-[11px] text-muted-foreground line-clamp-2 shrink-0">{d.executiveSummary}</p>
              )}
              <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
                {items.slice(0, 3).map((item: any, i: number) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px]">
                    <Dot color={sentimentColor(item.marketImpact === "Positive" ? "positive" : item.marketImpact === "Negative" ? "negative" : "neutral")} />
                    <span className="text-foreground/80 truncate">{item.title}</span>
                  </div>
                ))}
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {size === "lg" && (
            <div className="h-full flex flex-col gap-2 overflow-hidden">
              {topStory && (
                <div className="rounded border border-orange-400/20 bg-orange-400/5 p-2 shrink-0">
                  <p className="text-[10px] text-orange-400 font-medium mb-1">Top Story</p>
                  <p className="text-[11px] text-foreground font-medium leading-tight">{topStory.title}</p>
                  {topStory.summary && <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">{topStory.summary}</p>}
                </div>
              )}
              {d.executiveSummary && (
                <p className="text-[11px] text-muted-foreground line-clamp-2 shrink-0">{d.executiveSummary}</p>
              )}
              <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                {items.slice(0, 6).map((item: any, i: number) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <Dot color={item.marketImpact === "Positive" ? "text-green-400" : item.marketImpact === "Negative" ? "text-red-400" : "text-yellow-400"} />
                    <div className="min-w-0">
                      <p className="text-[11px] text-foreground/90 truncate">{item.title}</p>
                      <p className="text-[10px] text-muted-foreground">{item.category} · {item.publishedAt ? timeAgo(item.publishedAt) : ""}</p>
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
