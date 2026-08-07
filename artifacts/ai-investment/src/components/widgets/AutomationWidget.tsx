import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import type { OrchestratorStatus } from "@workspace/api-client-react";
import { format } from "date-fns";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  PauseCircle,
  Loader2,
  Clock,
} from "lucide-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo, freshnessColor } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot } from "@/lib/widget-components";

const FRESHNESS_ORDER = [
  "Running", "Failed", "Stale", "DueSoon",
  "NeverRun", "WaitingForDependency", "Disabled", "Fresh",
];

// ── System-health computation ─────────────────────────────────────────────────
type HealthInfo = {
  label: string;
  sub: string;
  color: string;           // text-* class
  Icon: React.ComponentType<{ className?: string }>;
};

function getHealth(
  failed: number,
  stale: number,
  running: number,
  paused: boolean,
  total: number,
  fresh: number,
): HealthInfo {
  if (paused)
    return {
      label: "System Paused",
      sub: "Automation is paused",
      color: "text-yellow-400",
      Icon: PauseCircle,
    };
  if (failed > 0)
    return {
      label: "Issues Detected",
      sub: `${failed} module${failed > 1 ? "s" : ""} failed`,
      color: "text-red-400",
      Icon: XCircle,
    };
  if (running > 0)
    return {
      label: "Cycle Running",
      sub: `Analysing ${running} module${running > 1 ? "s" : ""}…`,
      color: "text-blue-400",
      Icon: Loader2,
    };
  if (stale > 0)
    return {
      label: "Some Modules Stale",
      sub: `${stale} module${stale > 1 ? "s" : ""} need refresh`,
      color: "text-yellow-400",
      Icon: AlertTriangle,
    };
  if (total === 0)
    return {
      label: "No Modules",
      sub: "Nothing is scheduled yet",
      color: "text-muted-foreground",
      Icon: AlertTriangle,
    };
  return {
    label: "System Healthy",
    sub: `All ${fresh} of ${total} modules running as planned`,
    color: "text-green-400",
    Icon: CheckCircle2,
  };
}

// ── StatusBar — always visible regardless of tile height ─────────────────────
function StatusBar({
  modeLabel,
  modeColor,
  health,
  nextTime,
  cycleRunning,
}: {
  modeLabel: string;
  modeColor: string;
  health: HealthInfo;
  nextTime: string | null;
  cycleRunning: boolean;
}) {
  const { Icon } = health;
  return (
    <div className="shrink-0 inline-flex flex-row items-stretch divide-x divide-border/40 rounded border border-border/40 bg-black/25 overflow-hidden">
      {/* ── Left: Mode ── */}
      <div className="px-4 py-3 flex flex-col justify-center gap-1 min-w-0">
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Mode
        </span>
        <span className={`text-lg font-bold uppercase tracking-wide truncate ${modeColor}`}>
          {modeLabel}
        </span>
      </div>

      {/* ── Center: System Health ── */}
      <div className="px-4 py-3 flex items-center gap-3 min-w-0">
        <Icon
          className={`h-7 w-7 shrink-0 ${health.color} ${
            health.label === "Cycle Running" ? "animate-spin" : ""
          }`}
        />
        <div className="min-w-0">
          <p className={`text-base font-bold uppercase tracking-wide truncate ${health.color}`}>
            {health.label}
          </p>
          <p className="text-xs text-muted-foreground truncate">{health.sub}</p>
        </div>
      </div>

      {/* ── Right: Next Update ── */}
      <div className="px-4 py-3 flex items-center gap-3 min-w-0">
        <Clock
          className={`h-6 w-6 shrink-0 ${cycleRunning ? "text-blue-400 animate-pulse" : "text-muted-foreground"}`}
        />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Next Update
          </p>
          <p className="text-lg font-bold text-foreground truncate">
            {cycleRunning ? "Running…" : nextTime ?? "—"}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Main widget ───────────────────────────────────────────────────────────────
export function AutomationWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);

  const { data: status, isLoading } = useQuery<OrchestratorStatus>({
    queryKey: ["automation/status/widget"],
    queryFn: () => customFetch<OrchestratorStatus>("/api/automation/status"),
    refetchInterval: 5_000,
  });

  const modules  = status?.modules ?? [];
  const stats    = status?.stats;
  const fresh    = modules.filter(m => m.freshness === "Fresh").length;
  const stale    = modules.filter(m => m.freshness === "Stale").length;
  const failed   = modules.filter(m => m.freshness === "Failed").length;
  const running  = modules.filter(m => m.freshness === "Running").length;

  const modeLabel =
    status?.paused            ? "Paused"     :
    status?.mode === "FullAutomatic"  ? "Full Auto"  :
    status?.mode === "SemiAutomatic"  ? "Semi-Auto"  : "Manual";

  const modeColor =
    status?.paused            ? "text-yellow-400" :
    status?.mode === "FullAutomatic"  ? "text-green-400"  :
    status?.mode === "SemiAutomatic"  ? "text-blue-400"   :
    "text-muted-foreground";

  const health = status
    ? getHealth(failed, stale, running, status.paused ?? false, modules.length, fresh)
    : null;

  const nextTime = stats?.nextScheduledJobAt
    ? format(new Date(stats.nextScheduledJobAt), "HH:mm")
    : null;

  const sortedModules = [...modules].sort(
    (a, b) => FRESHNESS_ORDER.indexOf(a.freshness) - FRESHNESS_ORDER.indexOf(b.freshness)
  );

  const statsCells = [
    { label: "Fresh",  value: fresh,  color: "text-green-400  border-green-400/20" },
    { label: "Stale",  value: stale,  color: "text-orange-400 border-orange-400/20" },
    { label: "Failed", value: failed, color: "text-red-400    border-red-400/20" },
  ];

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-2">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !status && <WidgetNoData label="Automation not running" />}

      {status && health && (
        <>
          {/* ── StatusBar: always shown ─────────────────────────────────── */}
          <StatusBar
            modeLabel={modeLabel}
            modeColor={modeColor}
            health={health}
            nextTime={nextTime}
            cycleRunning={!!status.cycleInProgress}
          />

          {/* ── Stats row: md and above ─────────────────────────────────── */}
          {(size === "md" || size === "lg") && (
            <div className="grid grid-cols-3 gap-1.5 shrink-0">
              {statsCells.map(({ label, value, color }) => (
                <div
                  key={label}
                  className={`rounded border p-1.5 text-center ${color}`}
                >
                  <p className={`text-base font-bold ${color.split(" ")[0]}`}>{value}</p>
                  <p className="text-[9px] text-muted-foreground">{label}</p>
                </div>
              ))}
            </div>
          )}

          {/* ── Module list: lg only ────────────────────────────────────── */}
          {size === "lg" && (
            <div className="flex-1 overflow-y-auto min-h-0">
              {/* Last cycle row */}
              {status.lastFullCycleAt && (
                <p className="text-[10px] text-muted-foreground mb-1 shrink-0">
                  Last cycle {timeAgo(status.lastFullCycleAt)}
                </p>
              )}
              {sortedModules.map(m => (
                <div
                  key={m.moduleId}
                  className="flex items-center gap-2 py-0.5 border-t border-border/30 text-[10px]"
                >
                  <Dot color={freshnessColor(m.freshness)} />
                  <span className="text-foreground/80 flex-1 truncate">{m.displayName}</span>
                  <span className={`shrink-0 ${freshnessColor(m.freshness)}`}>{m.freshness}</span>
                  <span className="text-muted-foreground shrink-0 w-12 text-right">
                    {timeAgo(m.lastUpdatedAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
