/** Format an ISO timestamp as a human-readable relative time. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Map a freshness enum to a Tailwind text-color class. */
export function freshnessColor(f: string | undefined): string {
  switch (f) {
    case "Fresh":                return "text-green-400";
    case "DueSoon":             return "text-yellow-400";
    case "Stale":               return "text-orange-400";
    case "Running":             return "text-blue-400";
    case "Failed":              return "text-red-400";
    case "NeverRun":            return "text-slate-400";
    case "Disabled":            return "text-slate-500";
    case "WaitingForDependency":return "text-purple-400";
    default:                    return "text-muted-foreground";
  }
}

/**
 * Safely coerce an API field that might be a string OR a {title, reason} object
 * into a displayable string. Renders `.title` first, then `.reason`, then JSON.
 */
export function safeText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return String(o["title"] ?? o["reason"] ?? o["summary"] ?? o["conclusion"] ?? JSON.stringify(v));
  }
  return String(v);
}

/** Map a sentiment/rating/risk string to a Tailwind text-color class. */
export function sentimentColor(val: string | undefined): string {
  if (!val) return "text-muted-foreground";
  const v = val.toLowerCase();
  if (/positive|low\s*risk|excellent|strong buy|^buy$|bullish|improving|high opportunity/.test(v))
    return "text-green-400";
  if (/neutral|medium|mixed|watch|stable|moderate|fair|due soon/.test(v))
    return "text-yellow-400";
  if (/negative|high\s*risk|avoid|bearish|weakening|poor|low opportunity|failed|stale/.test(v))
    return "text-red-400";
  if (/running/.test(v)) return "text-blue-400";
  return "text-muted-foreground";
}
