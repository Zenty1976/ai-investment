import { useRef } from "react";
import { useGetRepositoryEntry } from "@workspace/api-client-react";
import { useTileSize } from "@/hooks/useTileSize";
import { timeAgo } from "@/lib/widget-utils";
import { WidgetSpinner, WidgetNoData, Dot } from "@/lib/widget-components";

type ItemSeverity = "positive" | "neutral" | "watch" | "warning" | "critical";
type OverallStatus = "normal" | "attention" | "action";
type ActionStatusCode = "none" | "monitor" | "review" | "trade_ready";

function severityColor(s: ItemSeverity): string {
  if (s === "positive") return "text-green-400";
  if (s === "watch")    return "text-blue-400";
  if (s === "warning")  return "text-yellow-400";
  if (s === "critical") return "text-red-400";
  return "text-muted-foreground";
}

function severityIcon(s: ItemSeverity): string {
  if (s === "positive") return "✓";
  if (s === "warning")  return "⚠";
  if (s === "critical") return "✕";
  if (s === "watch")    return "●";
  return "●";
}

function overallStatusColor(os: OverallStatus): string {
  if (os === "normal")    return "text-green-400";
  if (os === "attention") return "text-yellow-400";
  return "text-red-400";
}

function actionColor(status: ActionStatusCode): string {
  if (status === "none")    return "text-green-400";
  if (status === "monitor") return "text-muted-foreground";
  if (status === "review")  return "text-yellow-400";
  return "text-red-400";
}

export function CommandBriefWidget() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useTileSize(ref);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: entry, isLoading } = useGetRepositoryEntry("command-brief");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (entry as any)?.result as any;
  const updatedAt = (entry as any)?.updatedAt as string | undefined;

  const overallStatus: OverallStatus = d?.overallStatus ?? "normal";
  const headline: string = d?.headline ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = d?.items ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actionStatus: { status: ActionStatusCode; text: string } | undefined = d?.actionStatus;

  const osColor = overallStatusColor(overallStatus);

  return (
    <div ref={ref} className="h-full w-full overflow-hidden p-2 flex flex-col gap-1.5">
      {isLoading && <WidgetSpinner />}
      {!isLoading && !d && <WidgetNoData />}
      {d && (
        <>
          {/* XS: status dot + truncated headline */}
          {size === "xs" && (
            <div className="h-full flex items-center gap-1.5">
              <Dot color={osColor} />
              <span className={`text-xs font-semibold truncate ${osColor}`}>{headline}</span>
            </div>
          )}

          {/* SM: headline + action status + timestamp */}
          {size === "sm" && (
            <div className="h-full flex flex-col justify-between">
              <div className="flex items-start gap-1.5">
                <Dot color={osColor} />
                <span className={`text-sm font-semibold leading-snug ${osColor}`}>
                  {headline}
                </span>
              </div>
              {actionStatus && (
                <span className={`text-xs font-bold uppercase tracking-wide ${actionColor(actionStatus.status)}`}>
                  {actionStatus.text}
                </span>
              )}
              <span className="text-[11px] text-muted-foreground">{timeAgo(updatedAt)}</span>
            </div>
          )}

          {/* MD/LG: headline box + items + action status + timestamp */}
          {(size === "md" || size === "lg") && (
            <div className="h-full flex flex-col gap-1.5 overflow-hidden">
              {/* Headline — boxed status summary */}
              <div className={`shrink-0 rounded border px-2.5 py-1.5 flex items-center gap-2
                ${overallStatus === "normal"
                  ? "border-green-500/40 bg-green-500/10"
                  : overallStatus === "attention"
                  ? "border-yellow-500/40 bg-yellow-500/10"
                  : "border-red-500/40 bg-red-500/10"}`}>
                <Dot color={osColor} />
                <span className={`text-sm font-bold leading-snug ${osColor}`}>
                  {headline}
                </span>
              </div>

              {/* Items */}
              <div className="flex-1 overflow-hidden space-y-1 min-h-0">
                {items.map((item, i) => (
                  <div key={i} className="flex items-baseline gap-1.5 text-xs">
                    <span className={`shrink-0 leading-none ${severityColor(item.severity as ItemSeverity)}`}>
                      {severityIcon(item.severity as ItemSeverity)}
                    </span>
                    {item.symbol && (
                      <span className="text-foreground/80 font-semibold shrink-0">{item.symbol}</span>
                    )}
                    <span className="text-foreground/70 truncate">{item.text}</span>
                  </div>
                ))}
              </div>

              {/* Action status — prominent footer */}
              {actionStatus && (
                <div className="shrink-0 border-t border-border/30 pt-1">
                  <span className={`text-xs font-bold uppercase tracking-wide ${actionColor(actionStatus.status)}`}>
                    {actionStatus.text}
                  </span>
                </div>
              )}

              <span className="text-[11px] text-muted-foreground shrink-0">{timeAgo(updatedAt)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
