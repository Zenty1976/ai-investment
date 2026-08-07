import { useState, useCallback, useEffect } from "react";
import type { LayoutItem } from "react-grid-layout";

// Grid: cols=24, rowHeight=12px, margin=[6,0].
// margin[1]=0 means element height = h*12 exactly, so snap formula has
// zero accumulated error at any tile size (each step is always ~6 px drag).
// w values are 2× the original 12-col values; h values give 12px per row.
const STORAGE_KEY_BASE = "ai-dashboard-layout-v10";
const MODULES_KEY_BASE = "ai-dashboard-modules-v10";
export const ACTIVE_LAYOUT_KEY = "ai-dashboard-active-v10";
/** Default tile sizes when a module is first added. */
const DEFAULT_SIZES: Record<string, { w: number; h: number }> = {
  "automation":          { w: 12, h: 32 },
  "portfolio-manager":   { w: 12, h: 32 },
  "market-monitor":      { w:  8, h: 32 },
  "event-monitor":       { w:  8, h: 32 },
  "news-monitor":        { w:  8, h: 32 },
  "sector-monitor":      { w:  8, h: 32 },
  "market-alerts":       { w:  8, h: 32 },
  "risk-analyzer":       { w:  8, h: 32 },
  "portfolio-analyzer":  { w: 12, h: 40 },
  "opportunity-finder":  { w: 12, h: 40 },
  "company-monitor":     { w: 12, h: 40 },
  "trade-decision":      { w: 12, h: 40 },
  "investor-watch":      { w: 12, h: 32 },
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
 * Default 24-column layout, rowHeight=10px.
 * 10px × h:32 = 320px tile — same visual size as the original.
 * Each resize step is now 10px tall × ~56px wide.
 */
export const DEFAULT_LAYOUT: LayoutItem[] = [
  // Row 0 — overview panels
  { i: "automation",         x:  0, y:   0, w: 12, h: 32, minW: 2, minH: 2 },
  { i: "portfolio-manager",  x: 12, y:   0, w: 12, h: 32, minW: 2, minH: 2 },
  // Row 32 — market intelligence
  { i: "market-monitor",     x:  0, y:  32, w:  8, h: 32, minW: 2, minH: 2 },
  { i: "event-monitor",      x:  8, y:  32, w:  8, h: 32, minW: 2, minH: 2 },
  { i: "news-monitor",       x: 16, y:  32, w:  8, h: 32, minW: 2, minH: 2 },
  // Row 64 — sector & risk
  { i: "sector-monitor",     x:  0, y:  64, w:  8, h: 32, minW: 2, minH: 2 },
  { i: "market-alerts",      x:  8, y:  64, w:  8, h: 32, minW: 2, minH: 2 },
  { i: "risk-analyzer",      x: 16, y:  64, w:  8, h: 32, minW: 2, minH: 2 },
  // Row 96 — deep analysis
  { i: "portfolio-analyzer", x:  0, y:  96, w: 12, h: 40, minW: 2, minH: 2 },
  { i: "opportunity-finder", x: 12, y:  96, w: 12, h: 40, minW: 2, minH: 2 },
  // Row 136 — decisions
  { i: "company-monitor",    x:  0, y: 136, w: 12, h: 40, minW: 2, minH: 2 },
  { i: "trade-decision",     x: 12, y: 136, w: 12, h: 40, minW: 2, minH: 2 },
  // Row 176 — informational
  { i: "investor-watch",     x:  0, y: 176, w: 12, h: 32, minW: 2, minH: 2 },
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
  const maxW = Math.max(...layout.map(l => l.w));
  return maxW >= 8; // 24-col grid: smallest tile is w:8 (1/3 width)
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
