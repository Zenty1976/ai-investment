import { useState, useCallback, useEffect } from "react";
import type { LayoutItem } from "react-grid-layout";

// ── Storage keys (localStorage — used as fast synchronous cache) ─────────────
const STORAGE_KEY_BASE  = "ai-dashboard-layout-v13";
const MODULES_KEY_BASE  = "ai-dashboard-modules-v13";
export const ACTIVE_LAYOUT_KEY = "ai-dashboard-active-v13";

// ── Default tile sizes ───────────────────────────────────────────────────────
const DEFAULT_SIZES: Record<string, { w: number; h: number }> = {
  "automation":          { w: 6, h: 4 },
  "portfolio-manager":   { w: 6, h: 4 },
  "market-monitor":      { w: 6, h: 4 },
  "event-monitor":       { w: 6, h: 4 },
  "news-monitor":        { w: 6, h: 4 },
  "sector-monitor":      { w: 6, h: 4 },
  "market-alerts":       { w: 6, h: 4 },
  "risk-analyzer":       { w: 6, h: 4 },
  "portfolio-analyzer":  { w: 6, h: 4 },
  "opportunity-finder":  { w: 6, h: 4 },
  "company-monitor":     { w: 6, h: 4 },
  "trade-decision":      { w: 6, h: 4 },
  "investor-watch":      { w: 6, h: 4 },
  "trade-review":        { w: 6, h: 4 },
  "command-brief":       { w: 6, h: 4 },
  "ai-chat":             { w: 6, h: 5 },
};

/** Layout 1 default: all modules. Layouts 2 & 3 start empty. */
export const DEFAULT_MODULES = [
  "automation", "portfolio-manager",
  "market-monitor", "event-monitor", "news-monitor",
  "sector-monitor", "market-alerts", "risk-analyzer",
  "portfolio-analyzer", "opportunity-finder",
  "company-monitor", "trade-decision",
  "investor-watch", "command-brief",
];

export const DEFAULT_LAYOUT: LayoutItem[] = [
  { i: "automation",         x: 0, y:  0, w: 6, h: 4, minW: 1, minH: 1 },
  { i: "portfolio-manager",  x: 6, y:  0, w: 6, h: 4, minW: 1, minH: 1 },
  { i: "market-monitor",     x: 0, y:  4, w: 6, h: 4, minW: 1, minH: 1 },
  { i: "event-monitor",      x: 6, y:  4, w: 6, h: 4, minW: 1, minH: 1 },
  { i: "news-monitor",       x: 0, y:  8, w: 6, h: 4, minW: 1, minH: 1 },
  { i: "sector-monitor",     x: 6, y:  8, w: 6, h: 4, minW: 1, minH: 1 },
  { i: "market-alerts",      x: 0, y: 12, w: 6, h: 4, minW: 1, minH: 1 },
  { i: "risk-analyzer",      x: 6, y: 12, w: 6, h: 4, minW: 1, minH: 1 },
  { i: "portfolio-analyzer", x: 0, y: 16, w: 6, h: 4, minW: 1, minH: 1 },
  { i: "opportunity-finder", x: 6, y: 16, w: 6, h: 4, minW: 1, minH: 1 },
  { i: "company-monitor",    x: 0, y: 20, w: 6, h: 4, minW: 1, minH: 1 },
  { i: "trade-decision",     x: 6, y: 20, w: 6, h: 4, minW: 1, minH: 1 },
  { i: "investor-watch",     x: 0, y: 24, w: 6, h: 4, minW: 1, minH: 1 },
  { i: "command-brief",      x: 6, y: 24, w: 6, h: 4, minW: 1, minH: 1 },
];

// ── localStorage helpers ─────────────────────────────────────────────────────

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function tryParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function isValidLayout(layout: LayoutItem[]): boolean {
  if (!Array.isArray(layout) || layout.length === 0) return false;
  const maxW = Math.max(...layout.map(l => l.w));
  return maxW >= 1 && maxW <= 12;
}

// ── Server sync ──────────────────────────────────────────────────────────────

interface ServerLayoutEntry {
  modules: string[];
  layout: LayoutItem[];
}

interface ServerLayoutState {
  active?: string;
  layouts?: Record<string, ServerLayoutEntry>;
}

/** Load from server → write to localStorage → return parsed state (or null on failure). */
async function loadFromServer(): Promise<ServerLayoutState | null> {
  try {
    const res = await fetch("/api/layouts");
    if (!res.ok) return null;
    const data = await res.json() as ServerLayoutState;
    if (!data || typeof data !== "object") return null;

    // Populate localStorage cache from server data
    if (data.active) {
      localStorage.setItem(ACTIVE_LAYOUT_KEY, data.active);
    }
    for (const id of ["1", "2", "3"] as const) {
      const entry = data.layouts?.[id];
      if (entry?.modules) {
        localStorage.setItem(`${MODULES_KEY_BASE}-${id}`, JSON.stringify(entry.modules));
      }
      if (entry?.layout) {
        localStorage.setItem(`${STORAGE_KEY_BASE}-${id}`, JSON.stringify(entry.layout));
      }
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Read the full state from localStorage and push to the server.
 * Fire-and-forget — UI never waits for the response.
 */
function pushToServer(): void {
  const state: ServerLayoutState = {
    active: localStorage.getItem(ACTIVE_LAYOUT_KEY) ?? "1",
    layouts: {
      "1": {
        modules: tryParse<string[]>(localStorage.getItem(`${MODULES_KEY_BASE}-1`)) ?? [],
        layout:  tryParse<LayoutItem[]>(localStorage.getItem(`${STORAGE_KEY_BASE}-1`)) ?? [],
      },
      "2": {
        modules: tryParse<string[]>(localStorage.getItem(`${MODULES_KEY_BASE}-2`)) ?? [],
        layout:  tryParse<LayoutItem[]>(localStorage.getItem(`${STORAGE_KEY_BASE}-2`)) ?? [],
      },
      "3": {
        modules: tryParse<string[]>(localStorage.getItem(`${MODULES_KEY_BASE}-3`)) ?? [],
        layout:  tryParse<LayoutItem[]>(localStorage.getItem(`${STORAGE_KEY_BASE}-3`)) ?? [],
      },
    },
  };
  fetch("/api/layouts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  }).catch(() => { /* silently ignore — localStorage is the fallback */ });
}

// ── Public API ───────────────────────────────────────────────────────────────

export type LayoutId = 1 | 2 | 3;

export function readActiveLayoutId(): LayoutId {
  try {
    const v = parseInt(localStorage.getItem(ACTIVE_LAYOUT_KEY) ?? "1", 10);
    return (v === 2 ? 2 : v === 3 ? 3 : 1) as LayoutId;
  } catch {
    return 1;
  }
}

export function useDashboardLayout(layoutId: LayoutId = 1) {
  const storageKey = `${STORAGE_KEY_BASE}-${layoutId}`;
  const modulesKey = `${MODULES_KEY_BASE}-${layoutId}`;

  // ── Initialise from localStorage synchronously (no flicker) ────────────────
  const [layout, setLayout] = useState<LayoutItem[]>(() => {
    const saved = readStorage(storageKey, DEFAULT_LAYOUT);
    return isValidLayout(saved) ? saved : DEFAULT_LAYOUT;
  });

  const [activeModules, setActiveModules] = useState<string[]>(() => {
    const defaultMods = layoutId === 1 ? DEFAULT_MODULES : [];
    return readStorage(modulesKey, defaultMods);
  });

  // ── One-time mount: load from server and override local state ────────────────
  // If the server has no data yet (first boot / new deployment), push what
  // localStorage already has so the server file is bootstrapped immediately.
  useEffect(() => {
    loadFromServer().then((state) => {
      const hasServerData = !!state?.layouts && Object.keys(state.layouts).some(
        id => (state.layouts![id]?.layout?.length ?? 0) > 0
      );

      if (!hasServerData) {
        // Bootstrap: push existing localStorage data up to the server
        pushToServer();
        return;
      }

      const id = String(layoutId) as "1" | "2" | "3";
      const entry = state!.layouts![id];
      if (entry?.layout && isValidLayout(entry.layout)) setLayout(entry.layout);
      if (entry?.modules) setActiveModules(entry.modules);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — run once on mount only

  // ── Re-read from localStorage whenever the active layout tab changes ─────────
  useEffect(() => {
    const defaultMods = layoutId === 1 ? DEFAULT_MODULES : [];
    const saved = readStorage(storageKey, DEFAULT_LAYOUT);
    setLayout(isValidLayout(saved) ? saved : DEFAULT_LAYOUT);
    setActiveModules(readStorage(modulesKey, defaultMods));
  }, [storageKey, modulesKey, layoutId]);

  // ── Write helpers — always write to localStorage then push to server ─────────

  const saveLayout = useCallback((newLayout: LayoutItem[]) => {
    setLayout(newLayout);
    localStorage.setItem(storageKey, JSON.stringify(newLayout));
    pushToServer();
  }, [storageKey]);

  const addModule = useCallback((moduleId: string) => {
    setActiveModules(prev => {
      if (prev.includes(moduleId)) return prev;
      const next = [...prev, moduleId];
      localStorage.setItem(modulesKey, JSON.stringify(next));
      pushToServer();
      return next;
    });
    setLayout(prev => {
      if (prev.find(l => l.i === moduleId)) return prev;
      const { w, h } = DEFAULT_SIZES[moduleId] ?? { w: 6, h: 4 };
      const bottomY = prev.reduce((max, l) => Math.max(max, l.y + l.h), 0);
      const next: LayoutItem[] = [
        ...prev,
        { i: moduleId, x: 0, y: bottomY, w, h, minW: 1, minH: 1 } as LayoutItem,
      ];
      localStorage.setItem(storageKey, JSON.stringify(next));
      pushToServer();
      return next;
    });
  }, [modulesKey, storageKey]);

  const removeModule = useCallback((moduleId: string) => {
    setActiveModules(prev => {
      const next = prev.filter(id => id !== moduleId);
      localStorage.setItem(modulesKey, JSON.stringify(next));
      pushToServer();
      return next;
    });
  }, [modulesKey]);

  const resetLayout = useCallback(() => {
    const defaultMods = layoutId === 1 ? DEFAULT_MODULES : [];
    setActiveModules(defaultMods);
    setLayout(DEFAULT_LAYOUT);
    localStorage.setItem(modulesKey, JSON.stringify(defaultMods));
    localStorage.setItem(storageKey, JSON.stringify(DEFAULT_LAYOUT));
    pushToServer();
  }, [layoutId, modulesKey, storageKey]);

  const clearLayout = useCallback(() => {
    setActiveModules([]);
    setLayout([]);
    localStorage.setItem(modulesKey, JSON.stringify([]));
    localStorage.setItem(storageKey, JSON.stringify([]));
    pushToServer();
  }, [modulesKey, storageKey]);

  return { activeModules, layout, saveLayout, addModule, removeModule, resetLayout, clearLayout };
}
