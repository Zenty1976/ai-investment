import { useState, useCallback } from "react";
import type { LayoutItem } from "react-grid-layout";

// Bump version to clear any stale localStorage from previous layouts
const STORAGE_KEY = "ai-dashboard-layout-v5";
const MODULES_KEY = "ai-dashboard-modules-v5";

// Row height is 40px. Default h values are doubled vs the old 80px row height
// so the visual tile size is identical — but each resize step is now 40px (half as coarse).
/** Default tile sizes when a module is first added. */
const DEFAULT_SIZES: Record<string, { w: number; h: number }> = {
  "automation":          { w: 6, h: 8 },
  "portfolio-manager":   { w: 6, h: 8 },
  "market-monitor":      { w: 4, h: 8 },
  "event-monitor":       { w: 4, h: 8 },
  "news-monitor":        { w: 4, h: 8 },
  "sector-monitor":      { w: 4, h: 8 },
  "market-alerts":       { w: 4, h: 8 },
  "risk-analyzer":       { w: 4, h: 8 },
  "portfolio-analyzer":  { w: 6, h: 10 },
  "opportunity-finder":  { w: 6, h: 10 },
  "company-monitor":     { w: 6, h: 10 },
  "trade-decision":      { w: 6, h: 10 },
  "investor-watch":      { w: 6, h: 8 },
};

/** All 13 modules active by default. */
export const DEFAULT_MODULES = [
  "automation", "portfolio-manager",
  "market-monitor", "event-monitor", "news-monitor",
  "sector-monitor", "market-alerts", "risk-analyzer",
  "portfolio-analyzer", "opportunity-finder",
  "company-monitor", "trade-decision",
  "investor-watch",
];

/**
 * Default 12-column layout.
 * Row height = 40 px · h:8 = 320 px tile → 292 px inner content → "lg" view.
 * All h/y values are ×2 vs the old 80px row height — same visual size, finer steps.
 */
export const DEFAULT_LAYOUT: LayoutItem[] = [
  // Row 0 — overview panels
  { i: "automation",         x: 0, y: 0,  w: 6, h: 8,  minW: 2, minH: 3 },
  { i: "portfolio-manager",  x: 6, y: 0,  w: 6, h: 8,  minW: 2, minH: 3 },
  // Row 8 — market intelligence
  { i: "market-monitor",     x: 0, y: 8,  w: 4, h: 8,  minW: 2, minH: 3 },
  { i: "event-monitor",      x: 4, y: 8,  w: 4, h: 8,  minW: 2, minH: 3 },
  { i: "news-monitor",       x: 8, y: 8,  w: 4, h: 8,  minW: 2, minH: 3 },
  // Row 16 — sector & risk
  { i: "sector-monitor",     x: 0, y: 16, w: 4, h: 8,  minW: 2, minH: 3 },
  { i: "market-alerts",      x: 4, y: 16, w: 4, h: 8,  minW: 2, minH: 3 },
  { i: "risk-analyzer",      x: 8, y: 16, w: 4, h: 8,  minW: 2, minH: 3 },
  // Row 24 — deep analysis
  { i: "portfolio-analyzer", x: 0, y: 24, w: 6, h: 10, minW: 2, minH: 3 },
  { i: "opportunity-finder", x: 6, y: 24, w: 6, h: 10, minW: 2, minH: 3 },
  // Row 34 — decisions
  { i: "company-monitor",    x: 0, y: 34, w: 6, h: 10, minW: 2, minH: 3 },
  { i: "trade-decision",     x: 6, y: 34, w: 6, h: 10, minW: 2, minH: 3 },
  // Row 44 — informational
  { i: "investor-watch",     x: 0, y: 44, w: 6, h: 8,  minW: 2, minH: 3 },
];

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function useDashboardLayout() {
  const [activeModules, setActiveModules] = useState<string[]>(() =>
    readStorage(MODULES_KEY, DEFAULT_MODULES)
  );

  const [layout, setLayout] = useState<LayoutItem[]>(() =>
    readStorage(STORAGE_KEY, DEFAULT_LAYOUT)
  );

  const saveLayout = useCallback((newLayout: LayoutItem[]) => {
    setLayout(newLayout);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newLayout));
  }, []);

  const addModule = useCallback((moduleId: string) => {
    setActiveModules(prev => {
      if (prev.includes(moduleId)) return prev;
      const next = [...prev, moduleId];
      localStorage.setItem(MODULES_KEY, JSON.stringify(next));
      return next;
    });
    setLayout(prev => {
      if (prev.find(l => l.i === moduleId)) return prev;
      const { w, h } = DEFAULT_SIZES[moduleId] ?? { w: 4, h: 4 };
      const bottomY = prev.reduce((max, l) => Math.max(max, l.y + l.h), 0);
      const next: LayoutItem[] = [
        ...prev,
        { i: moduleId, x: 0, y: bottomY, w, h, minW: 2, minH: 2 } as LayoutItem,
      ];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const removeModule = useCallback((moduleId: string) => {
    setActiveModules(prev => {
      const next = prev.filter(id => id !== moduleId);
      localStorage.setItem(MODULES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const resetLayout = useCallback(() => {
    setActiveModules(DEFAULT_MODULES);
    setLayout(DEFAULT_LAYOUT);
    localStorage.setItem(MODULES_KEY, JSON.stringify(DEFAULT_MODULES));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_LAYOUT));
  }, []);

  return { activeModules, layout, saveLayout, addModule, removeModule, resetLayout };
}
