import { useRef } from "react";
import { useGetRepositoryEntry } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo, sentimentColor, safeText } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot, ScoreBar } from "@/lib/widget-components";

function postureColor(p: string) {
  if (/active|buy/i.test(p)) return "text-green-400";
  if (/wait|watch|neutral/i.test(p)) return "text-yellow-400";
  if (/reduce|sell|avoid/i.test(p)) return "text-red-400";
  return "text-muted-foreground";
}

function decisionIcon(type: string) {
  if (/buy|prepare.*buy/i.test(type)) return "↑";
  if (/sell|reduce/i.test(type)) return "↓";
  if (/hold|no.?action/i.test(type)) return "→";
  return "·";
}

function decisionColor(type: string) {
  if (/buy/i.test(type)) return "text-green-400";
  if (/sell|reduce/i.test(type)) return "text-red-400";
  return "text-muted-foreground";
}

export function TradeDecisionWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  const { data: entry, isLoading } = useGetRepositoryEntry("trade-decision-engine");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (entry as any)?.result as any;
  const updatedAt = (entry as any)?.updatedAt as string | undefined;

  const posture: string = d?.overallDecisionPosture ?? "";
  const score: number = d?.decisionReadinessScore ?? 0;
  const decisions: any[] = d?.decisions ?? [];
  const scoreColor = score >= 70 ? "bg-green-400" : score >= 40 ? "bg-yellow-400" : "bg-red-400";
  const pColor = postureColor(posture);

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !d && <WidgetNoData />}
      {d && (
        <>
          {size === "xs" && (
            <div className="h-full flex items-center gap-2">
              <span className={`text-sm font-bold ${pColor}`}>{score}</span>
              <span className="text-[10px] text-muted-foreground">/100</span>
              <Dot color={pColor} />
              <span className={`text-[10px] truncate ${pColor}`}>{posture}</span>
            </div>
          )}

          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              <div className="flex items-baseline gap-1.5">
                <span className={`text-xl font-bold ${pColor}`}>{score}</span>
                <span className="text-[10px] text-muted-foreground">/100 ready</span>
              </div>
              <ScoreBar score={score} color={scoreColor} />
              <div className="flex items-center gap-1.5">
                <Dot color={pColor} />
                <span className={`text-[11px] truncate ${pColor}`}>{posture}</span>
              </div>
            </div>
          )}

          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <div className="flex items-center justify-between shrink-0">
                <div className="flex items-baseline gap-1">
                  <span className={`text-2xl font-bold ${pColor}`}>{score}</span>
                  <span className="text-xs text-muted-foreground">/100</span>
                </div>
                <div className="text-right">
                  <p className={`text-[11px] font-medium ${pColor}`}>{posture}</p>
                  <p className="text-[10px] text-muted-foreground">{decisions.length} decisions · {timeAgo(updatedAt)}</p>
                </div>
              </div>
              <ScoreBar score={score} color={scoreColor} />
              <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
                {decisions.map((dec: any, i: number) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px]">
                    <span className={`shrink-0 font-bold ${decisionColor(dec.decisionType ?? dec.decision ?? "")}`}>
                      {decisionIcon(dec.decisionType ?? dec.decision ?? "")}
                    </span>
                    <span className="font-medium text-foreground w-12 truncate">{dec.ticker}</span>
                    <span className="text-muted-foreground truncate flex-1">{dec.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {size === "lg" && (
            <div className="h-full flex flex-col gap-2 overflow-hidden">
              {/* Score header */}
              <div className="flex items-center justify-between shrink-0">
                <div className="flex items-baseline gap-1.5">
                  <span className={`text-3xl font-bold ${pColor}`}>{score}</span>
                  <span className="text-xs text-muted-foreground">/100 ready</span>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-semibold ${pColor}`}>{posture}</p>
                  <p className="text-[10px] text-muted-foreground">{decisions.length} decisions · {timeAgo(updatedAt)}</p>
                </div>
              </div>
              <ScoreBar score={score} color={scoreColor} />

              {d.mainConclusion && (
                <p className="text-[11px] text-muted-foreground line-clamp-2 shrink-0">{safeText(d.mainConclusion)}</p>
              )}

              {/* Decision list with reason */}
              <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                {decisions.map((dec: any, i: number) => {
                  const dtype = dec.decisionType ?? dec.decision ?? "";
                  return (
                    <div key={i} className="border-t border-border/30 pt-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-base font-bold shrink-0 w-4 ${decisionColor(dtype)}`}>
                          {decisionIcon(dtype)}
                        </span>
                        <span className="text-[11px] font-semibold text-foreground">{dec.ticker}</span>
                        <span className="text-[10px] text-muted-foreground truncate flex-1">{dtype}</span>
                        <span className={`text-[10px] shrink-0 ${
                          dec.confidence === "High" ? "text-green-400"
                          : dec.confidence === "Medium" ? "text-yellow-400"
                          : "text-muted-foreground"
                        }`}>{dec.confidence}</span>
                      </div>
                      {dec.title && (
                        <p className="text-[10px] text-foreground/80 mt-0.5 ml-5 font-medium line-clamp-1">{dec.title}</p>
                      )}
                      {dec.reason && (
                        <p className="text-[10px] text-muted-foreground mt-0.5 ml-5 line-clamp-2">{dec.reason}</p>
                      )}
                      {dec.readiness && dec.readiness !== "Ready" && (
                        <p className="text-[9px] text-yellow-400/70 mt-0.5 ml-5">{dec.readinessReason ?? dec.readiness}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
