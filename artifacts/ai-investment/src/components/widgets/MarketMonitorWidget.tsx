import { useRef } from "react";
import { useGetRepositoryEntry } from "@workspace/api-client-react";
import type { MarketAnalysis } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo, sentimentColor } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot, Metric, ScoreBar } from "@/lib/widget-components";

export function MarketMonitorWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  const { data: entry, isLoading } = useGetRepositoryEntry("market-monitor");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (entry as any)?.result as MarketAnalysis | undefined;
  const updatedAt = (entry as any)?.updatedAt as string | undefined;

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !d && <WidgetNoData />}
      {d && (
        <>
          {/* xs: single line */}
          {size === "xs" && (
            <div className="h-full flex items-center gap-1.5">
              <Dot color={sentimentColor(d.marketSentiment)} />
              <span className={`text-xs font-medium truncate ${sentimentColor(d.marketSentiment)}`}>{d.marketSentiment}</span>
              <span className="text-[10px] text-muted-foreground">·</span>
              <span className={`text-[10px] truncate ${sentimentColor(d.riskLevel)}`}>{d.riskLevel} Risk</span>
            </div>
          )}

          {/* sm: key metrics + timestamp */}
          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              <div className="flex items-center gap-1.5">
                <Dot color={sentimentColor(d.marketSentiment)} />
                <span className={`text-xs font-semibold ${sentimentColor(d.marketSentiment)}`}>{d.marketSentiment}</span>
                <span className="text-muted-foreground text-[10px]">·</span>
                <span className={`text-[11px] ${sentimentColor(d.riskLevel)}`}>{d.riskLevel} risk</span>
              </div>
              <span className="text-[10px] text-muted-foreground">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {/* md: summary excerpt + sectors */}
          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <div className="flex items-center gap-1.5 shrink-0">
                <Dot color={sentimentColor(d.marketSentiment)} />
                <span className={`text-xs font-semibold ${sentimentColor(d.marketSentiment)}`}>{d.marketSentiment}</span>
                <span className="text-muted-foreground mx-0.5">·</span>
                <span className={`text-[11px] ${sentimentColor(d.riskLevel)}`}>{d.riskLevel} risk</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2 shrink-0">{d.summary}</p>
              {d.strongSectors?.length > 0 && (
                <Metric label="↑ Strong" value={d.strongSectors.slice(0, 2).join(", ")} color="text-green-400" />
              )}
              {d.weakSectors?.length > 0 && (
                <Metric label="↓ Weak" value={d.weakSectors.slice(0, 2).join(", ")} color="text-red-400" />
              )}
              <span className="text-[10px] text-muted-foreground mt-auto">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {/* lg: full summary + sectors + key risks */}
          {size === "lg" && (
            <div className="h-full flex flex-col gap-2 overflow-hidden">
              <div className="flex items-center gap-1.5 shrink-0">
                <Dot color={sentimentColor(d.marketSentiment)} />
                <span className={`text-xs font-semibold ${sentimentColor(d.marketSentiment)}`}>{d.marketSentiment}</span>
                <span className="text-muted-foreground mx-0.5">·</span>
                <span className={`text-[11px] ${sentimentColor(d.riskLevel)}`}>{d.riskLevel} risk</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-3 shrink-0">{d.summary}</p>
              <div className="grid grid-cols-2 gap-1.5 shrink-0">
                {d.strongSectors?.length > 0 && (
                  <div>
                    <p className="text-[10px] text-muted-foreground mb-0.5">Strong</p>
                    {d.strongSectors.slice(0, 3).map(s => (
                      <p key={s} className="text-[11px] text-green-400 truncate">↑ {s}</p>
                    ))}
                  </div>
                )}
                {d.weakSectors?.length > 0 && (
                  <div>
                    <p className="text-[10px] text-muted-foreground mb-0.5">Weak</p>
                    {d.weakSectors.slice(0, 3).map(s => (
                      <p key={s} className="text-[11px] text-red-400 truncate">↓ {s}</p>
                    ))}
                  </div>
                )}
              </div>
              {d.keyRisks?.length > 0 && (
                <div className="shrink-0">
                  <p className="text-[10px] text-muted-foreground mb-0.5">Key Risks</p>
                  {d.keyRisks.slice(0, 2).map(r => (
                    <p key={r} className="text-[11px] text-muted-foreground truncate">• {r}</p>
                  ))}
                </div>
              )}
              <span className="text-[10px] text-muted-foreground mt-auto">{timeAgo(updatedAt)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
