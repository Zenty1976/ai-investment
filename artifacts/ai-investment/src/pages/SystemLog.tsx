/**
 * System Log Page
 *
 * Console-like view of all module operational messages.
 * Polls the backend every 3 s.
 * Auto-scrolls to the newest message unless the user has scrolled up.
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetSystemLog,
  useClearSystemLog,
  getGetSystemLogQueryKey,
} from '@workspace/api-client-react';
import type { SystemLogLevel } from '@workspace/api-client-react';

// ── Level display config ──────────────────────────────────────────────────────

const LEVEL_CONFIG: Record<
  SystemLogLevel,
  { label: string; textColor: string; badgeColor: string }
> = {
  user:     { label: 'USER',  textColor: 'text-emerald-400', badgeColor: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30' },
  info:     { label: 'INFO',  textColor: 'text-blue-400',    badgeColor: 'text-blue-400    bg-blue-400/10    border-blue-400/30'    },
  warning:  { label: 'WARN',  textColor: 'text-amber-400',   badgeColor: 'text-amber-400   bg-amber-400/10   border-amber-400/30'   },
  error:    { label: 'ERROR', textColor: 'text-red-400',     badgeColor: 'text-red-400     bg-red-400/10     border-red-400/30'     },
  internal: { label: 'INT',   textColor: 'text-zinc-400',    badgeColor: 'text-zinc-400    bg-zinc-400/10    border-zinc-400/30'    },
};

const ALL_LEVELS = Object.keys(LEVEL_CONFIG) as SystemLogLevel[];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('da-DK', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso.slice(11, 19);
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SystemLog() {
  const [moduleFilter, setModuleFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<SystemLogLevel[]>([]);
  const [search, setSearch] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  const { data: entries = [] } = useGetSystemLog({
    query: { refetchInterval: 3000 },
  });

  const queryClient = useQueryClient();
  const { mutate: doClear } = useClearSystemLog({
    mutation: {
      onSuccess: () => {
        setExpandedIds(new Set());
        queryClient.invalidateQueries({ queryKey: getGetSystemLogQueryKey() });
      },
    },
  });

  // Unique module names from all entries
  const modules = useMemo(
    () => Array.from(new Set(entries.map((e) => e.module))).sort(),
    [entries]
  );

  // Apply filters
  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (moduleFilter && e.module !== moduleFilter) return false;
      if (levelFilter.length > 0 && !levelFilter.includes(e.level)) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !e.message.toLowerCase().includes(q) &&
          !e.module.toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [entries, moduleFilter, levelFilter, search]);

  // Track whether the user has manually scrolled away from the bottom
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distanceFromBottom > 60;
  };

  // Auto-scroll to bottom on new entries unless user scrolled up
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || userScrolledUpRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered]);

  const toggleLevel = (level: SystemLogLevel) => {
    setLevelFilter((prev) =>
      prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level]
    );
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full gap-3 min-h-0">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-base font-bold tracking-widest uppercase text-foreground">
            System Log
          </h1>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {entries.length} entr{entries.length === 1 ? 'y' : 'ies'} · auto-refreshes every 3 s
          </p>
        </div>

        {confirmClear ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Clear all entries?</span>
            <button
              className="px-3 py-1 rounded text-xs font-medium bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 transition-colors"
              onClick={() => { doClear(); setConfirmClear(false); }}
            >
              Confirm
            </button>
            <button
              className="px-3 py-1 rounded text-xs font-medium bg-muted/40 text-muted-foreground border border-border hover:bg-muted/60 transition-colors"
              onClick={() => setConfirmClear(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="px-3 py-1.5 rounded text-xs font-medium border border-border text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
            onClick={() => setConfirmClear(true)}
          >
            Clear log
          </button>
        )}
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        {/* Module dropdown */}
        <select
          className="h-7 px-2 rounded text-xs bg-muted/30 border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
          value={moduleFilter}
          onChange={(e) => setModuleFilter(e.target.value)}
        >
          <option value="">All modules</option>
          {modules.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        {/* Level toggles */}
        <div className="flex items-center gap-1">
          {ALL_LEVELS.map((level) => {
            const cfg = LEVEL_CONFIG[level];
            const active = levelFilter.includes(level);
            return (
              <button
                key={level}
                onClick={() => toggleLevel(level)}
                className={`px-2 py-0.5 rounded text-[9px] font-mono font-bold tracking-widest border transition-all ${
                  active
                    ? cfg.badgeColor
                    : 'text-muted-foreground bg-transparent border-border/50 hover:border-border'
                }`}
              >
                {cfg.label}
              </button>
            );
          })}
        </div>

        {/* Text search */}
        <input
          type="text"
          placeholder="Search…"
          className="h-7 px-2 rounded text-xs bg-muted/30 border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50 flex-1 min-w-[100px] max-w-[220px]"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <span className="text-[11px] text-muted-foreground ml-auto tabular-nums">
          {filtered.length} shown
        </span>
      </div>

      {/* ── Log area ───────────────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto rounded-lg border border-border bg-zinc-950 min-h-0"
      >
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-[11px] font-mono">
            {entries.length === 0
              ? 'No log entries yet. Trigger a module update to see messages here.'
              : 'No entries match the current filters.'}
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {filtered.map((entry) => {
              const cfg = LEVEL_CONFIG[entry.level] ?? LEVEL_CONFIG.internal;
              const expanded = expandedIds.has(entry.id);
              const hasDetails = entry.details != null;

              return (
                <div
                  key={entry.id}
                  className={`px-3 py-1.5 font-mono text-xs ${hasDetails ? 'cursor-pointer hover:bg-white/[0.02]' : ''}`}
                  onClick={() => hasDetails && toggleExpanded(entry.id)}
                >
                  <div className="flex items-baseline gap-2 min-w-0">
                    {/* Timestamp */}
                    <span className="text-[10px] text-zinc-500 tabular-nums shrink-0">
                      {formatTimestamp(entry.timestamp)}
                    </span>

                    {/* Level badge */}
                    <span
                      className={`text-[9px] font-bold tracking-widest shrink-0 w-[30px] inline-block ${cfg.textColor}`}
                    >
                      {cfg.label}
                    </span>

                    {/* Module */}
                    <span className="text-zinc-500 shrink-0 max-w-[120px] truncate text-[10px]">
                      [{entry.module}]
                    </span>

                    {/* Message */}
                    <span className={`flex-1 break-words leading-relaxed ${cfg.textColor}`}>
                      {entry.message}
                    </span>

                    {/* Expand indicator */}
                    {hasDetails && (
                      <span className="text-zinc-600 shrink-0 text-[9px]">
                        {expanded ? '▼' : '▶'}
                      </span>
                    )}
                  </div>

                  {/* Details panel */}
                  {expanded && hasDetails && (
                    <div className="mt-1.5 ml-[110px] p-2 rounded bg-white/[0.03] border border-white/[0.06] text-zinc-400 text-[10px] whitespace-pre-wrap break-all leading-relaxed">
                      {typeof entry.details === 'string'
                        ? entry.details
                        : JSON.stringify(entry.details, null, 2)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
