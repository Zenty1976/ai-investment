import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, ScoreBar } from "@/lib/widget-components";

function ratingColor(r: string | undefined) {
  if (!r) return "text-muted-foreground";
  const v = r.toLowerCase();
  if (v.includes("strong buy")) return "text-green-400";
  if (v.includes("buy")) return "text-green-300";
  if (v.includes("watch")) return "text-yellow-400";
  if (v.includes("avoid")) return "text-red-400";
  return "text-muted-foreground";
}

export function CompanyMonitorWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);

  // Fetch all repository entries and filter for company-monitor:* entries
  const { data: allEntries, isLoading } = useQuery<any[]>({
    queryKey: ["repository/all-entries"],
    queryFn: () => customFetch<any[]>("/api/repository"),
    refetchInterval: 60_000,
    select: (entries) =>
      (entries ?? []).filter((e: any) => e.moduleName?.startsWith("company-monitor:")),
  });

  const entries = allEntries ?? [];

  // Extract companies from results
  const companies = entries
    .map((e: any) => {
      const result = e.result as any;
      return {
        ticker: result?.company?.ticker ?? e.moduleName.replace("company-monitor:", ""),
        name: result?.company?.name ?? "",
        rating: result?.investmentView?.rating ?? "",
        strength: result?.investmentCaseStrength ?? null,
        updatedAt: e.updatedAt,
      };
    })
    .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0));

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && entries.length === 0 && <WidgetNoData label="No companies analyzed yet" />}
      {entries.length > 0 && (
        <>
          {size === "xs" && (
            <div className="h-full flex items-center gap-1.5">
              <span className="text-xs font-medium text-foreground">{companies.length}</span>
              <span className="text-[10px] text-muted-foreground">companies analyzed</span>
            </div>
          )}

          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              <p className="text-[10px] text-muted-foreground">{companies.length} analyzed</p>
              <div className="space-y-0.5">
                {companies.slice(0, 2).map(c => (
                  <div key={c.ticker} className="flex items-center gap-1.5 text-[10px]">
                    <span className="font-medium text-foreground w-12 truncate">{c.ticker}</span>
                    <span className={`truncate flex-1 ${ratingColor(c.rating)}`}>{c.rating}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <p className="text-[10px] text-muted-foreground shrink-0">{companies.length} companies</p>
              <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
                {companies.map(c => (
                  <div key={c.ticker} className="flex items-center gap-1.5 text-[10px]">
                    <span className="font-semibold text-foreground w-14 shrink-0 truncate">{c.ticker}</span>
                    {c.strength !== null && (
                      <div className="w-16 shrink-0">
                        <ScoreBar
                          score={c.strength}
                          color={c.strength >= 70 ? "bg-green-400/60" : c.strength >= 50 ? "bg-yellow-400/60" : "bg-red-400/40"}
                        />
                      </div>
                    )}
                    <span className={`truncate flex-1 ${ratingColor(c.rating)}`}>{c.rating}</span>
                    <span className="text-muted-foreground shrink-0">{timeAgo(c.updatedAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {size === "lg" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              <p className="text-[10px] text-muted-foreground shrink-0 font-medium">{companies.length} companies analyzed</p>
              <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                {companies.map(c => (
                  <div key={c.ticker} className="rounded border border-border/50 px-2 py-1.5 flex items-center gap-2">
                    <div className="w-16 shrink-0">
                      <p className="text-[11px] font-bold text-foreground truncate">{c.ticker}</p>
                      <p className="text-[9px] text-muted-foreground truncate">{c.name}</p>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-[10px] font-medium ${ratingColor(c.rating)} truncate`}>{c.rating}</p>
                      {c.strength !== null && (
                        <div className="mt-0.5">
                          <ScoreBar
                            score={c.strength}
                            color={c.strength >= 70 ? "bg-green-400/60" : c.strength >= 50 ? "bg-yellow-400/60" : "bg-red-400/40"}
                          />
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      {c.strength !== null && <p className="text-[10px] text-muted-foreground">{c.strength}/100</p>}
                      <p className="text-[9px] text-muted-foreground">{timeAgo(c.updatedAt)}</p>
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
