import { useRef } from "react";
import { useGetRepositoryEntry } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo, sentimentColor, safeText } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot, ScoreBar } from "@/lib/widget-components";

export function OpportunityFinderWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  const { data: entry, isLoading } = useGetRepositoryEntry("opportunity-finder");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (entry as any)?.result as any;
  const updatedAt = (entry as any)?.updatedAt as string | undefined;

  const level: string = d?.overallOpportunityLevel ?? "";
  const opps: any[] = d?.topOpportunities ?? [];
  const levelColor = sentimentColor(
    level === "High" ? "positive" : level === "Medium" ? "neutral" : level === "Low" ? "negative" : ""
  );

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !d && <WidgetNoData />}
      {d && (
        <>
          {size === "xs" && (
            <div className="h-full flex items-center gap-1.5">
              <Dot color={levelColor} />
              <span className={`text-xs font-medium ${levelColor}`}>{level}</span>
              <span className="text-[10px] text-muted-foreground">· {opps.length} picks</span>
            </div>
          )}

          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              <div className="flex items-center gap-1.5">
                <Dot color={levelColor} />
                <span className={`text-[11px] font-semibold ${levelColor}`}>{level} Opportunity</span>
              </div>
              {opps[0] && (
                <p className="text-[10px] text-foreground/80 truncate">
                  Top: <span className="font-medium">{opps[0].ticker}</span>
                  {opps[0].overallScore !== undefined && ` · ${opps[0].overallScore}/100`}
                </p>
              )}
              <span className="text-[10px] text-muted-foreground">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <div className="flex items-center gap-1.5 shrink-0">
                <Dot color={levelColor} />
                <span className={`text-xs font-semibold ${levelColor}`}>{level} Opportunity</span>
                <span className="text-muted-foreground text-[10px]">· {opps.length} candidates</span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                {opps.slice(0, 4).map((opp: any) => (
                  <div key={opp.ticker} className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium text-foreground w-14 shrink-0 truncate">{opp.ticker}</span>
                    <div className="flex-1 min-w-0">
                      <ScoreBar
                        score={opp.overallScore ?? 0}
                        color={opp.overallScore >= 70 ? "bg-green-400/60" : opp.overallScore >= 50 ? "bg-yellow-400/60" : "bg-red-400/40"}
                      />
                    </div>
                    <span className="text-[10px] text-muted-foreground w-8 text-right shrink-0">{opp.overallScore}</span>
                    <span className={`text-[10px] shrink-0 ${opp.priority === "High" ? "text-green-400" : opp.priority === "Medium" ? "text-yellow-400" : "text-muted-foreground"}`}>
                      {opp.priority}
                    </span>
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
                  <span className={`text-xs font-semibold ${levelColor}`}>{level} Opportunity</span>
                </div>
                <span className="text-[10px] text-muted-foreground">{opps.length} candidates · {timeAgo(updatedAt)}</span>
              </div>
              {d.executiveSummary && (
                <p className="text-[11px] text-muted-foreground line-clamp-2 shrink-0">{safeText(d.executiveSummary)}</p>
              )}
              <div className="flex-1 overflow-y-auto space-y-1.5 min-h-0">
                {opps.map((opp: any) => (
                  <div key={opp.ticker} className="rounded border border-border/50 p-1.5">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[11px] font-semibold text-foreground">{opp.ticker}</span>
                      <span className="text-[10px] text-muted-foreground truncate flex-1">{opp.company}</span>
                      <span className="text-[10px] font-medium text-foreground shrink-0">{opp.overallScore}/100</span>
                    </div>
                    <ScoreBar
                      score={opp.overallScore ?? 0}
                      color={opp.overallScore >= 70 ? "bg-green-400/60" : opp.overallScore >= 50 ? "bg-yellow-400/60" : "bg-red-400/40"}
                    />
                    {opp.catalystSummary && (
                      <p className="text-[10px] text-muted-foreground mt-1 truncate">{opp.catalystSummary}</p>
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
