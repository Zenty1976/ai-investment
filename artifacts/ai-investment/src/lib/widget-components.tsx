/** Shared micro-components used by dashboard widget tiles. */

/** Inline colored dot bullet for status lines. */
export function Dot({ color }: { color: string }) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${color} bg-current`}
    />
  );
}

/** Full-height spinner — shown while data is loading. */
export function WidgetSpinner() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="h-4 w-4 border-2 border-muted border-t-foreground/50 rounded-full animate-spin" />
    </div>
  );
}

/** Shown when a module has never run or has no data. */
export function WidgetNoData({ label }: { label?: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-1.5 p-3 text-center">
      <p className="text-[11px] text-muted-foreground/60">{label ?? "Not yet analyzed"}</p>
    </div>
  );
}

/** Inline label + value row. */
export function Metric({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-[10px] text-muted-foreground shrink-0">{label}</span>
      <span className={`text-[11px] font-medium truncate ${color ?? "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}

/** Narrow horizontal bar showing a 0–100 score. */
export function ScoreBar({ score, color }: { score: number; color?: string }) {
  return (
    <div className="h-1 w-full rounded-full bg-white/10 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${color ?? "bg-foreground/50"}`}
        style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
      />
    </div>
  );
}
