import { useRef } from "react";
import { useGetRepositoryEntry } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo, sentimentColor, safeText } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot, ScoreBar } from "@/lib/widget-components";

export function PortfolioAnalyzerWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  const { data: entry, isLoading } = useGetRepositoryEntry("portfolio-analyzer");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (entry as any)?.result as any;
  const updatedAt = (entry as any)?.updatedAt as string | undefined;

  const score: number = d?.portfolioScore ?? 0;
  const rating: string = d?.overallRating ?? "";
  const outlook: string = d?.overallOutlook ?? "";
  const scoreColor = score >= 70 ? "bg-green-400" : score >= 50 ? "bg-yellow-400" : "bg-red-400";
  const ratingColor = sentimentColor(rating);

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !d && <WidgetNoData />}
      {d && (
        <>
          {size === "xs" && (
            <div className="h-full flex items-center gap-2">
              <span className={`text-sm font-bold ${ratingColor}`}>{score}</span>
              <span className="text-[10px] text-muted-foreground">/100</span>
              <Dot color={ratingColor} />
              <span className={`text-[10px] truncate ${ratingColor}`}>{rating}</span>
            </div>
          )}

          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              <div className="flex items-baseline gap-1.5">
                <span className={`text-xl font-bold ${ratingColor}`}>{score}</span>
                <span className="text-[10px] text-muted-foreground">/100</span>
              </div>
              <ScoreBar score={score} color={scoreColor} />
              <div className="flex items-center gap-1.5">
                <Dot color={ratingColor} />
                <span className={`text-[11px] ${ratingColor}`}>{rating}</span>
                <span className="text-muted-foreground">·</span>
                <span className={`text-[11px] ${sentimentColor(outlook)}`}>{outlook}</span>
              </div>
            </div>
          )}

          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <div className="flex items-center justify-between shrink-0">
                <div className="flex items-baseline gap-1">
                  <span className={`text-2xl font-bold ${ratingColor}`}>{score}</span>
                  <span className="text-xs text-muted-foreground">/100</span>
                </div>
                <div className="text-right">
                  <p className={`text-[11px] font-medium ${ratingColor}`}>{rating}</p>
                  <p className={`text-[10px] ${sentimentColor(outlook)}`}>{outlook}</p>
                </div>
              </div>
              <ScoreBar score={score} color={scoreColor} />
              {d.mainConclusion && (
                <p className="text-[11px] text-muted-foreground line-clamp-2 shrink-0">{safeText(d.mainConclusion)}</p>
              )}
              {d.recommendedActions?.length > 0 && (
                <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
                  <p className="text-[10px] text-muted-foreground">Actions</p>
                  {d.recommendedActions.slice(0, 3).map((a: any, i: number) => (
                    <p key={i} className="text-[10px] text-foreground/80 truncate">• {typeof a === "string" ? a : a.action ?? a.title ?? ""}</p>
                  ))}
                </div>
              )}
              <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {size === "lg" && (
            <div className="h-full flex flex-col gap-2 overflow-hidden">
              <div className="flex items-center justify-between shrink-0">
                <div className="flex items-baseline gap-1.5">
                  <span className={`text-3xl font-bold ${ratingColor}`}>{score}</span>
                  <span className="text-xs text-muted-foreground">/100</span>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-semibold ${ratingColor}`}>{rating}</p>
                  <p className={`text-[11px] ${sentimentColor(outlook)}`}>{outlook}</p>
                </div>
              </div>
              <ScoreBar score={score} color={scoreColor} />
              {d.mainConclusion && (
                <p className="text-[11px] text-muted-foreground line-clamp-2 shrink-0">{safeText(d.mainConclusion)}</p>
              )}
              {d.executiveSummary && (
                <p className="text-[11px] text-muted-foreground line-clamp-3 shrink-0">{safeText(d.executiveSummary)}</p>
              )}
              {d.recommendedActions?.length > 0 && (
                <div className="flex-1 overflow-y-auto min-h-0">
                  <p className="text-[10px] text-muted-foreground font-medium mb-1">Recommended Actions</p>
                  {d.recommendedActions.map((a: any, i: number) => (
                    <p key={i} className="text-[11px] text-foreground/80 truncate py-0.5 border-t border-border/30">
                      → {typeof a === "string" ? a : a.action ?? a.title ?? ""}
                    </p>
                  ))}
                </div>
              )}
              <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(updatedAt)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
