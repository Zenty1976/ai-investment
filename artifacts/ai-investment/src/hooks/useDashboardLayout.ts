import { useState, useCallback, useEffect } from "react";
import type { LayoutItem } from "react-grid-layout";

// Grid: cols=4, rowHeight=200px, margin=[8,8].
// w=2, h=2 → ~600×408px per tile (2 tiles per row).
const STORAGE_KEY_BASE = "ai-dashboard-layout-v12";
const MODULES_KEY_BASE = "ai-dashboard-modules-v12";
export const ACTIVE_LAYOUT_KEY = "ai-dashboard-active-v12";
/** Default tile sizes when a module is first added. */
const DEFAULT_SIZES: Record<string, { w: number; h: number }> = {
  "automation":          { w: 2, h: 2 },
  "portfolio-manager":   { w: 2, h: 2 },
  "market-monitor":      { w: 2, h: 2 },
  "event-monitor":       { w: 2, h: 2 },
  "news-monitor":        { w: 2, h: 2 },
  "sector-monitor":      { w: 2, h: 2 },
  "market-alerts":       { w: 2, h: 2 },
  "risk-analyzer":       { w: 2, h: 2 },
  "portfolio-analyzer":  { w: 2, h: 2 },
  "opportunity-finder":  { w: 2, h: 2 },
  "company-monitor":     { w: 2, h: 2 },
  "trade-decision":      { w: 2, h: 2 },
  "investor-watch":      { w: 2, h: 2 },
};

/** Layout 1 default: all 13 modules. Layouts 2 & 3 start empty. */
export const DEFAULT_MODULES = [
  "automation", "portfolio-manager",
  "market-monitor", "event-monitor", "news-monitor",
  "sector-monitor", "market-alerts", "risk-analyzer",
  "portfolio-analyzer", "opportunity-finder",
  "company-monitor", "trade-decision",
  "investor-watch",
];

/**
 * Default 4-column layout, rowHeight=200px, margin=[8,8].
 * w=2, h=2 → ~600×408px per tile. Two tiles per row.
 */
export const DEFAULT_LAYOUT: LayoutItem[] = [
  { i: "automation",         x: 0, y:  0, w: 2, h: 2, minW: 1, minH: 1 },
  { i: "portfolio-manager",  x: 2, y:  0, w: 2, h: 2, minW: 1, minH: 1 },
  { i: "market-monitor",     x: 0, y:  2, w: 2, h: 2, minW: 1, minH: 1 },
  { i: "event-monitor",      x: 2, y:  2, w: 2, h: 2, minW: 1, minH: 1 },
  { i: "news-monitor",       x: 0, y:  4, w: 2, h: 2, minW: 1, minH: 1 },
  { i: "sector-monitor",     x: 2, y:  4, w: 2, h: 2, minW: 1, minH: 1 },
  { i: "market-alerts",      x: 0, y:  6, w: 2, h: 2, minW: 1, minH: 1 },
  { i: "risk-analyzer",      x: 2, y:  6, w: 2, h: 2, minW: 1, minH: 1 },
  { i: "portfolio-analyzer", x: 0, y:  8, w: 2, h: 2, minW: 1, minH: 1 },
  { i: "opportunity-finder", x: 2, y:  8, w: 2, h: 2, minW: 1, minH: 1 },
  { i: "company-monitor",    x: 0, y: 10, w: 2, h: 2, minW: 1, minH: 1 },
  { i: "trade-decision",     x: 2, y: 10, w: 2, h: 2, minW: 1, minH: 1 },
  { i: "investor-watch",     x: 0, y: 12, w: 2, h: 2, minW: 1, minH: 1 },
];

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Validate that the saved layout uses 24-column scale (max w ≥ 8).
 * If all tiles have w ≤ 6, the layout was saved under the old 12-col grid
 * and must be discarded so DEFAULT_LAYOUT takes over.
 */
function isValidLayout(layout: LayoutItem[]): boolean {
  if (!Array.isArray(layout) || layout.length === 0) return false;
  // 4-col grid: valid tiles have w between 1 and 4
  const maxW = Math.max(...layout.map(l => l.w));
  return maxW >= 1 && maxW <= 4;
}

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

  const [layout, setLayout] = useState<LayoutItem[]>(() => {
    const saved = readStorage(storageKey, DEFAULT_LAYOUT);
    return isValidLayout(saved) ? saved : DEFAULT_LAYOUT;
  });

  const [activeModules, setActiveModules] = useState<string[]>(() => {
    const defaultMods = layoutId === 1 ? DEFAULT_MODULES : [];
    return readStorage(modulesKey, defaultMods);
  });

  // Re-read from the appropriate storage keys whenever the active layout changes
  useEffect(() => {
    const defaultMods = layoutId === 1 ? DEFAULT_MODULES : [];
    const saved = readStorage(storageKey, DEFAULT_LAYOUT);
    setLayout(isValidLayout(saved) ? saved : DEFAULT_LAYOUT);
    setActiveModules(readStorage(modulesKey, defaultMods));
  }, [storageKey, modulesKey, layoutId]);

  const saveLayout = useCallback((newLayout: LayoutItem[]) => {
    setLayout(newLayout);
    localStorage.setItem(storageKey, JSON.stringify(newLayout));
  }, [storageKey]);

  const addModule = useCallback((moduleId: string) => {
    setActiveModules(prev => {
      if (prev.includes(moduleId)) return prev;
      const next = [...prev, moduleId];
      localStorage.setItem(modulesKey, JSON.stringify(next));
      return next;
    });
    setLayout(prev => {
      if (prev.find(l => l.i === moduleId)) return prev;
      const { w, h } = DEFAULT_SIZES[moduleId] ?? { w: 8, h: 16 };
      const bottomY = prev.reduce((max, l) => Math.max(max, l.y + l.h), 0);
      const next: LayoutItem[] = [
        ...prev,
        { i: moduleId, x: 0, y: bottomY, w, h, minW: 4, minH: 6 } as LayoutItem,
      ];
      localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  }, [modulesKey, storageKey]);

  const removeModule = useCallback((moduleId: string) => {
    setActiveModules(prev => {
      const next = prev.filter(id => id !== moduleId);
      localStorage.setItem(modulesKey, JSON.stringify(next));
      return next;
    });
  }, [modulesKey]);

  const resetLayout = useCallback(() => {
    const defaultMods = layoutId === 1 ? DEFAULT_MODULES : [];
    setActiveModules(defaultMods);
    setLayout(DEFAULT_LAYOUT);
    localStorage.setItem(modulesKey, JSON.stringify(defaultMods));
    localStorage.setItem(storageKey, JSON.stringify(DEFAULT_LAYOUT));
  }, [layoutId, modulesKey, storageKey]);

  return { activeModules, layout, saveLayout, addModule, removeModule, resetLayout };
}
