import { useState, useCallback } from "react";
import type { LayoutItem } from "react-grid-layout";

// Bump version to clear any stale localStorage from previous layouts
const STORAGE_KEY = "ai-dashboard-layout-v4";
const MODULES_KEY = "ai-dashboard-modules-v4";

/** Default tile sizes when a module is first added. */
const DEFAULT_SIZES: Record<string, { w: number; h: number }> = {
  "automation":          { w: 6, h: 4 },
  "portfolio-manager":   { w: 6, h: 4 },
  "market-monitor":      { w: 4, h: 4 },
  "event-monitor":       { w: 4, h: 4 },
  "news-monitor":        { w: 4, h: 4 },
  "sector-monitor":      { w: 4, h: 4 },
  "market-alerts":       { w: 4, h: 4 },
  "risk-analyzer":       { w: 4, h: 4 },
  "portfolio-analyzer":  { w: 6, h: 5 },
  "opportunity-finder":  { w: 6, h: 5 },
  "company-monitor":     { w: 6, h: 5 },
  "trade-decision":      { w: 6, h: 5 },
  "investor-watch":      { w: 6, h: 4 },
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
 * Row height = 80 px · h:4 = 320 px tile → 292 px inner content → "lg" view.
 */
export const DEFAULT_LAYOUT: LayoutItem[] = [
  // Row 0 — overview panels
  { i: "automation",         x: 0, y: 0,  w: 6, h: 4, minW: 2, minH: 2 },
  { i: "portfolio-manager",  x: 6, y: 0,  w: 6, h: 4, minW: 2, minH: 2 },
  // Row 4 — market intelligence
  { i: "market-monitor",     x: 0, y: 4,  w: 4, h: 4, minW: 2, minH: 2 },
  { i: "event-monitor",      x: 4, y: 4,  w: 4, h: 4, minW: 2, minH: 2 },
  { i: "news-monitor",       x: 8, y: 4,  w: 4, h: 4, minW: 2, minH: 2 },
  // Row 8 — sector & risk
  { i: "sector-monitor",     x: 0, y: 8,  w: 4, h: 4, minW: 2, minH: 2 },
  { i: "market-alerts",      x: 4, y: 8,  w: 4, h: 4, minW: 2, minH: 2 },
  { i: "risk-analyzer",      x: 8, y: 8,  w: 4, h: 4, minW: 2, minH: 2 },
  // Row 12 — deep analysis
  { i: "portfolio-analyzer", x: 0, y: 12, w: 6, h: 5, minW: 2, minH: 2 },
  { i: "opportunity-finder", x: 6, y: 12, w: 6, h: 5, minW: 2, minH: 2 },
  // Row 17 — decisions
  { i: "company-monitor",    x: 0, y: 17, w: 6, h: 5, minW: 2, minH: 2 },
  { i: "trade-decision",     x: 6, y: 17, w: 6, h: 5, minW: 2, minH: 2 },
  // Row 22 — informational
  { i: "investor-watch",     x: 0, y: 22, w: 6, h: 4, minW: 2, minH: 2 },
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
