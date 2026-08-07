import { useRef } from "react";
import { useGetRepositoryEntry } from "@workspace/api-client-react";
import type { MarketAnalysis } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo, sentimentColor } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot, Metric } from "@/lib/widget-components";

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
          {size === "xs" && (
            <div className="h-full flex items-center gap-1.5">
              <Dot color={sentimentColor(d.marketSentiment)} />
              <span className={`text-xs font-medium truncate ${sentimentColor(d.marketSentiment)}`}>{d.marketSentiment}</span>
              <span className={`text-[10px] truncate ${sentimentColor(d.riskLevel)}`}>· {d.riskLevel} Risk</span>
            </div>
          )}

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

          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <div className="flex items-center gap-1.5 shrink-0">
                <Dot color={sentimentColor(d.marketSentiment)} />
                <span className={`text-xs font-semibold ${sentimentColor(d.marketSentiment)}`}>{d.marketSentiment}</span>
                <span className={`text-[11px] ${sentimentColor(d.riskLevel)}`}>· {d.riskLevel} risk</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-3 shrink-0">{d.summary}</p>
              {d.strongSectors?.length > 0 && (
                <Metric label="↑ Strong" value={d.strongSectors.slice(0, 2).join(", ")} color="text-green-400" />
              )}
              {d.weakSectors?.length > 0 && (
                <Metric label="↓ Weak" value={d.weakSectors.slice(0, 2).join(", ")} color="text-red-400" />
              )}
              <span className="text-[10px] text-muted-foreground mt-auto">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {size === "lg" && (
            <div className="h-full flex flex-col gap-2 overflow-hidden">
              {/* Header */}
              <div className="flex items-center gap-1.5 shrink-0">
                <Dot color={sentimentColor(d.marketSentiment)} />
                <span className={`text-xs font-semibold ${sentimentColor(d.marketSentiment)}`}>{d.marketSentiment}</span>
                <span className={`text-[11px] ${sentimentColor(d.riskLevel)}`}>· {d.riskLevel} risk</span>
                <span className="text-[10px] text-muted-foreground ml-auto">{timeAgo(updatedAt)}</span>
              </div>

              {/* Summary */}
              <p className="text-[11px] text-muted-foreground leading-relaxed shrink-0">{d.summary}</p>

              {/* Sectors side-by-side */}
              {(d.strongSectors?.length > 0 || d.weakSectors?.length > 0) && (
                <div className="grid grid-cols-2 gap-x-3 shrink-0">
                  {d.strongSectors?.length > 0 && (
                    <div>
                      <p className="text-[10px] text-muted-foreground mb-0.5 font-medium">Strong</p>
                      {d.strongSectors.map((s: string) => (
                        <p key={s} className="text-[10px] text-green-400 truncate">↑ {s}</p>
                      ))}
                    </div>
                  )}
                  {d.weakSectors?.length > 0 && (
                    <div>
                      <p className="text-[10px] text-muted-foreground mb-0.5 font-medium">Weak</p>
                      {d.weakSectors.map((s: string) => (
                        <p key={s} className="text-[10px] text-red-400 truncate">↓ {s}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Positive / Negative factors */}
              <div className="flex-1 overflow-y-auto min-h-0 space-y-0.5">
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {(d as any).positiveFactors?.map((f: string, i: number) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px]">
                    <Dot color="text-green-400" />
                    <span className="text-foreground/80">{f}</span>
                  </div>
                ))}
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {(d as any).negativeFactors?.map((f: string, i: number) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px]">
                    <Dot color="text-red-400" />
                    <span className="text-foreground/80">{f}</span>
                  </div>
                ))}
                {d.keyRisks?.map((r: string, i: number) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px]">
                    <Dot color="text-orange-400" />
                    <span className="text-foreground/70">{r}</span>
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
