import { useRef } from "react";
import { useGetRepositoryEntry } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo, sentimentColor, safeText } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot, ScoreBar } from "@/lib/widget-components";

export function RiskAnalyzerWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  const { data: entry, isLoading } = useGetRepositoryEntry("risk-analyzer");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (entry as any)?.result as any;
  const updatedAt = (entry as any)?.updatedAt as string | undefined;

  const score: number = d?.riskScore ?? 0;
  const level: string = d?.overallRiskLevel ?? "";
  const risks: any[] = d?.risks ?? [];
  const scoreColor = score >= 70 ? "bg-red-400" : score >= 40 ? "bg-yellow-400" : "bg-green-400";
  const levelColor = sentimentColor(`${level} risk`);

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !d && <WidgetNoData />}
      {d && (
        <>
          {size === "xs" && (
            <div className="h-full flex items-center gap-2">
              <span className={`text-sm font-bold ${levelColor}`}>{score}</span>
              <span className="text-[10px] text-muted-foreground">/100</span>
              <Dot color={levelColor} />
              <span className={`text-[10px] ${levelColor}`}>{level}</span>
            </div>
          )}

          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              <div className="flex items-baseline gap-1.5">
                <span className={`text-lg font-bold ${levelColor}`}>{score}</span>
                <span className="text-[10px] text-muted-foreground">/100</span>
                <span className={`text-[11px] ml-1 ${levelColor}`}>{level}</span>
              </div>
              <ScoreBar score={score} color={scoreColor} />
              <span className="text-[10px] text-muted-foreground">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <div className="flex items-baseline gap-1.5 shrink-0">
                <span className={`text-2xl font-bold ${levelColor}`}>{score}</span>
                <span className="text-xs text-muted-foreground">/100 risk</span>
                <Dot color={levelColor} />
                <span className={`text-[11px] ${levelColor}`}>{level}</span>
              </div>
              <ScoreBar score={score} color={scoreColor} />
              {d.mainConclusion && <p className="text-[11px] text-muted-foreground line-clamp-2 shrink-0">{safeText(d.mainConclusion)}</p>}
              <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
                {risks.slice(0, 3).map((r: any, i: number) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px]">
                    <Dot color={r.severity === "High" ? "text-red-400" : r.severity === "Medium" ? "text-yellow-400" : "text-green-400"} />
                    <span className="text-foreground/80 truncate">{r.title}</span>
                  </div>
                ))}
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {size === "lg" && (
            <div className="h-full flex flex-col gap-2 overflow-hidden">
              <div className="flex items-center justify-between shrink-0">
                <div className="flex items-baseline gap-1.5">
                  <span className={`text-3xl font-bold ${levelColor}`}>{score}</span>
                  <span className="text-xs text-muted-foreground">/100</span>
                </div>
                <div className="text-right">
                  <p className={`text-xs font-semibold ${levelColor}`}>{level} Risk</p>
                  {d.previousRiskScore !== undefined && (
                    <p className="text-[10px] text-muted-foreground">
                      Prev: {d.previousRiskScore} ({score - d.previousRiskScore > 0 ? "+" : ""}{score - d.previousRiskScore})
                    </p>
                  )}
                </div>
              </div>
              <ScoreBar score={score} color={scoreColor} />
              {d.mainConclusion && <p className="text-[11px] text-muted-foreground line-clamp-2 shrink-0">{safeText(d.mainConclusion)}</p>}
              <p className="text-[10px] text-muted-foreground font-medium shrink-0">Top Risks</p>
              <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                {risks.map((r: any, i: number) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <Dot color={r.severity === "High" ? "text-red-400" : r.severity === "Medium" ? "text-yellow-400" : "text-green-400"} />
                    <div className="min-w-0">
                      <p className="text-[11px] text-foreground/90 truncate">{r.title}</p>
                      <p className="text-[10px] text-muted-foreground">{r.category} · {r.probability} prob · {r.timeHorizon}</p>
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
