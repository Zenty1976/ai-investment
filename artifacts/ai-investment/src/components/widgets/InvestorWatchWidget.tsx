import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { formatDistanceToNowStrict } from "date-fns";
import { useTileSize } from "@/hooks/useTileSize";
import { WidgetSpinner, WidgetNoData, Dot } from "@/lib/widget-components";

interface InvestorResult {
  person: { id: string; name: string; focusLabel: string };
  updateType: string;
  headline: string;
  shortSummary: string;
  currentView: { overallTone: string; summary: string; confidence: string };
  lastCheckedAt: string;
  lastMaterialUpdateAt: string;
}

function toneColor(tone: string): string {
  if (tone === "Bullish")  return "text-green-400";
  if (tone === "Bearish")  return "text-red-400";
  if (tone === "Cautious") return "text-yellow-400";
  if (tone === "Mixed")    return "text-blue-400";
  return "text-muted-foreground";
}

function dotColor(tone: string): string {
  if (tone === "Bullish")  return "text-green-400";
  if (tone === "Bearish")  return "text-red-400";
  if (tone === "Cautious") return "text-yellow-400";
  return "text-muted-foreground";
}

function timeAgo(iso: string | undefined): string {
  if (!iso) return "—";
  try { return formatDistanceToNowStrict(new Date(iso), { addSuffix: true }); }
  catch { return "—"; }
}

function shortName(name: string): string {
  // "Warren Buffett" → "Buffett", "Howard Marks" → "Marks", etc.
  const parts = name.split(" ");
  return parts[parts.length - 1];
}

export function InvestorWatchWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);

  const { data, isLoading } = useQuery({
    queryKey: ["investor-watch-results"],
    queryFn: () =>
      customFetch("/api/investor-watch/results") as Promise<{
        results: Record<string, InvestorResult>;
      }>,
    refetchInterval: 120_000,
  });

  const results = data?.results ?? {};
  const entries = Object.values(results) as InvestorResult[];
  const analyzed = entries.filter(e => e.currentView?.overallTone);
  const hasNew = entries.some(e => e.updateType === "MaterialUpdate");

  // Order: Bearish first, then Cautious, then Mixed, then Bullish — most relevant for risk awareness
  const toneOrder: Record<string, number> = { Bearish: 0, Cautious: 1, Mixed: 2, Bullish: 3, Unclear: 4 };
  const sorted = [...analyzed].sort(
    (a, b) => (toneOrder[a.currentView.overallTone] ?? 9) - (toneOrder[b.currentView.overallTone] ?? 9)
  );

  const noData = !isLoading && analyzed.length === 0;

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {noData && <WidgetNoData label="Run first analysis on Investors page" />}

      {!isLoading && analyzed.length > 0 && (
        <>
          {/* xs — just tone dots */}
          {size === "xs" && (
            <div className="h-full flex items-center gap-1.5 flex-wrap">
              {sorted.map(e => (
                <Dot key={e.person.id} color={dotColor(e.currentView.overallTone)} />
              ))}
              {hasNew && <span className="text-[9px] text-blue-400 font-semibold">NEW</span>}
            </div>
          )}

          {/* sm — names + tones */}
          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              <div className="space-y-0.5">
                {sorted.slice(0, 4).map(e => (
                  <div key={e.person.id} className="flex items-center gap-1.5 text-[10px]">
                    <Dot color={dotColor(e.currentView.overallTone)} />
                    <span className="text-foreground/80">{shortName(e.person.name)}</span>
                    <span className={`ml-auto ${toneColor(e.currentView.overallTone)}`}>
                      {e.currentView.overallTone}
                    </span>
                  </div>
                ))}
              </div>
              <span className="text-[9px] text-muted-foreground">{analyzed.length} investors</span>
            </div>
          )}

          {/* md — name + tone + headline */}
          {size === "md" && (
            <div className="h-full flex flex-col gap-1 overflow-hidden">
              <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
                {sorted.map(e => (
                  <div key={e.person.id} className="flex items-start gap-1.5 text-[10px]">
                    <Dot color={dotColor(e.currentView.overallTone)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-foreground font-medium truncate">{e.person.name}</span>
                        <span className={`shrink-0 text-[9px] ${toneColor(e.currentView.overallTone)}`}>
                          {e.currentView.overallTone}
                        </span>
                        {e.updateType === "MaterialUpdate" && (
                          <span className="text-[9px] text-blue-400 font-semibold shrink-0">NEW</span>
                        )}
                      </div>
                      <p className="text-muted-foreground truncate">{e.headline}</p>
                    </div>
                  </div>
                ))}
              </div>
              <span className="text-[9px] text-muted-foreground shrink-0">
                {timeAgo(entries[0]?.lastCheckedAt)}
              </span>
            </div>
          )}

          {/* lg — full compact briefing */}
          {size === "lg" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <div className="flex items-center justify-between shrink-0">
                <span className="text-[10px] text-muted-foreground font-medium">Smart Money Briefing</span>
                <span className="text-[9px] text-muted-foreground">{timeAgo(entries[0]?.lastCheckedAt)}</span>
              </div>

              <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                {sorted.map(e => (
                  <div key={e.person.id} className="border-t border-border/30 pt-1">
                    <div className="flex items-center gap-1.5">
                      <Dot color={dotColor(e.currentView.overallTone)} />
                      <span className="text-[11px] font-semibold text-foreground flex-1 truncate">
                        {e.person.name}
                      </span>
                      <span className={`text-[10px] shrink-0 font-medium ${toneColor(e.currentView.overallTone)}`}>
                        {e.currentView.overallTone}
                      </span>
                      {e.updateType === "MaterialUpdate" && (
                        <span className="text-[9px] text-blue-400 font-semibold shrink-0 ml-1">NEW</span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 ml-3 line-clamp-1">{e.headline}</p>
                    {e.updateType !== "MaterialUpdate" && e.updateType !== "FullAnalysis" && (
                      <p className="text-[9px] text-muted-foreground/50 ml-3">No material change</p>
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
