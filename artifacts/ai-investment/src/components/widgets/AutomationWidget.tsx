import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import type { OrchestratorStatus } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo, freshnessColor } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot } from "@/lib/widget-components";

const FRESHNESS_ORDER = ["Running", "Failed", "Stale", "DueSoon", "NeverRun", "WaitingForDependency", "Disabled", "Fresh"];

export function AutomationWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);

  const { data: status, isLoading } = useQuery<OrchestratorStatus>({
    queryKey: ["automation/status/widget"],
    queryFn: () => customFetch<OrchestratorStatus>("/api/automation/status"),
    refetchInterval: 5_000,
  });

  const modules = status?.modules ?? [];
  const stats = status?.stats;
  const fresh = modules.filter(m => m.freshness === "Fresh").length;
  const stale = modules.filter(m => m.freshness === "Stale").length;
  const failed = modules.filter(m => m.freshness === "Failed").length;
  const running = modules.filter(m => m.freshness === "Running").length;

  const modeLabel = status?.paused ? "Paused" : status?.mode === "FullAutomatic" ? "Auto" : status?.mode === "SemiAutomatic" ? "Semi-Auto" : "Manual";
  const modeColor = status?.paused ? "text-yellow-400" : status?.mode === "FullAutomatic" ? "text-green-400" : "text-muted-foreground";

  // Sort modules by severity of freshness
  const sortedModules = [...modules].sort(
    (a, b) => FRESHNESS_ORDER.indexOf(a.freshness) - FRESHNESS_ORDER.indexOf(b.freshness)
  );

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !status && <WidgetNoData label="Automation not running" />}
      {status && (
        <>
          {size === "xs" && (
            <div className="h-full flex items-center gap-1.5">
              <span className="text-xs font-medium text-green-400">{fresh}</span>
              <span className="text-[10px] text-muted-foreground">/ {modules.length} fresh</span>
              {failed > 0 && <span className="text-[10px] text-red-400">· {failed} fail</span>}
            </div>
          )}

          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              <div className="flex items-center gap-1.5">
                <Dot color={modeColor} />
                <span className={`text-[11px] font-medium ${modeColor}`}>{modeLabel}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-green-400">{fresh} fresh</span>
                {stale > 0 && <span className="text-orange-400">{stale} stale</span>}
                {failed > 0 && <span className="text-red-400">{failed} failed</span>}
                {running > 0 && <span className="text-blue-400 animate-pulse">{running} running</span>}
              </div>
              <span className="text-[10px] text-muted-foreground">{modules.length} modules</span>
            </div>
          )}

          {size === "md" && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              {/* Header stats */}
              <div className="flex items-center justify-between shrink-0">
                <div className="flex items-center gap-1.5">
                  <Dot color={modeColor} />
                  <span className={`text-xs font-semibold ${modeColor}`}>{modeLabel}</span>
                </div>
                <div className="flex items-center gap-1.5 text-[10px]">
                  {running > 0 && <span className="text-blue-400 animate-pulse">{running} ●</span>}
                  {failed > 0 && <span className="text-red-400">{failed} ✗</span>}
                  {stale > 0 && <span className="text-orange-400">{stale} ⚠</span>}
                  <span className="text-green-400">{fresh} ✓</span>
                </div>
              </div>
              {/* Module freshness grid */}
              <div className="flex-1 overflow-y-auto min-h-0">
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                  {sortedModules.map(m => (
                    <div key={m.moduleId} className="flex items-center gap-1 text-[10px]">
                      <Dot color={freshnessColor(m.freshness)} />
                      <span className="text-foreground/80 truncate flex-1">{m.displayName}</span>
                    </div>
                  ))}
                </div>
              </div>
              {stats?.nextScheduledJobAt && (
                <span className="text-[10px] text-muted-foreground shrink-0">
                  Next: {timeAgo(stats.nextScheduledJobAt)}
                </span>
              )}
            </div>
          )}

          {size === "lg" && (
            <div className="h-full flex flex-col gap-2 overflow-hidden">
              {/* Stats row */}
              <div className="grid grid-cols-4 gap-1.5 shrink-0">
                {[
                  { label: "Fresh", value: fresh, color: "text-green-400 border-green-400/20" },
                  { label: "Stale", value: stale, color: "text-orange-400 border-orange-400/20" },
                  { label: "Failed", value: failed, color: "text-red-400 border-red-400/20" },
                  { label: "Today", value: stats?.analysesToday ?? 0, color: "text-muted-foreground border-border/50" },
                ].map(({ label, value, color }) => (
                  <div key={label} className={`rounded border p-1.5 text-center ${color}`}>
                    <p className={`text-base font-bold ${color.split(" ")[0]}`}>{value}</p>
                    <p className="text-[9px] text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>
              {/* Mode + cycle */}
              <div className="flex items-center gap-2 shrink-0">
                <Dot color={modeColor} />
                <span className={`text-[11px] font-medium ${modeColor}`}>{modeLabel}</span>
                {status.cycleInProgress && <span className="text-[10px] text-blue-400 animate-pulse">Cycle running</span>}
                {status.lastFullCycleAt && (
                  <span className="text-[10px] text-muted-foreground ml-auto">Last cycle {timeAgo(status.lastFullCycleAt)}</span>
                )}
              </div>
              {/* Module table */}
              <div className="flex-1 overflow-y-auto min-h-0">
                {sortedModules.map(m => (
                  <div key={m.moduleId} className="flex items-center gap-2 py-0.5 border-t border-border/30 text-[10px]">
                    <Dot color={freshnessColor(m.freshness)} />
                    <span className="text-foreground/80 flex-1 truncate">{m.displayName}</span>
                    <span className={`shrink-0 ${freshnessColor(m.freshness)}`}>{m.freshness}</span>
                    <span className="text-muted-foreground shrink-0 w-12 text-right">{timeAgo(m.lastUpdatedAt)}</span>
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
