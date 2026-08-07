import { useState, useCallback } from "react";
import type { LayoutItem } from "react-grid-layout";

const STORAGE_KEY = "ai-dashboard-layout-v2";
const MODULES_KEY = "ai-dashboard-modules-v2";

/** Default tile sizes when a module is first added. */
const DEFAULT_SIZES: Record<string, { w: number; h: number }> = {
  "automation":          { w: 6, h: 3 },
  "portfolio-manager":   { w: 6, h: 3 },
  "market-monitor":      { w: 4, h: 3 },
  "event-monitor":       { w: 4, h: 3 },
  "news-monitor":        { w: 4, h: 3 },
  "sector-monitor":      { w: 4, h: 3 },
  "market-alerts":       { w: 4, h: 3 },
  "risk-analyzer":       { w: 4, h: 3 },
  "portfolio-analyzer":  { w: 6, h: 4 },
  "opportunity-finder":  { w: 6, h: 4 },
  "company-monitor":     { w: 6, h: 4 },
  "trade-decision":      { w: 6, h: 4 },
};

/** All 12 modules active by default. */
export const DEFAULT_MODULES = [
  "automation", "portfolio-manager",
  "market-monitor", "event-monitor", "news-monitor",
  "sector-monitor", "market-alerts", "risk-analyzer",
  "portfolio-analyzer", "opportunity-finder",
  "company-monitor", "trade-decision",
];

/** Default 12-column layout (row height = 80 px). */
export const DEFAULT_LAYOUT: LayoutItem[] = [
  // Row 0
  { i: "automation",         x: 0, y: 0,  w: 6, h: 3, minW: 2, minH: 2 },
  { i: "portfolio-manager",  x: 6, y: 0,  w: 6, h: 3, minW: 2, minH: 2 },
  // Row 3
  { i: "market-monitor",     x: 0, y: 3,  w: 4, h: 3, minW: 2, minH: 2 },
  { i: "event-monitor",      x: 4, y: 3,  w: 4, h: 3, minW: 2, minH: 2 },
  { i: "news-monitor",       x: 8, y: 3,  w: 4, h: 3, minW: 2, minH: 2 },
  // Row 6
  { i: "sector-monitor",     x: 0, y: 6,  w: 4, h: 3, minW: 2, minH: 2 },
  { i: "market-alerts",      x: 4, y: 6,  w: 4, h: 3, minW: 2, minH: 2 },
  { i: "risk-analyzer",      x: 8, y: 6,  w: 4, h: 3, minW: 2, minH: 2 },
  // Row 9
  { i: "portfolio-analyzer", x: 0, y: 9,  w: 6, h: 4, minW: 2, minH: 2 },
  { i: "opportunity-finder", x: 6, y: 9,  w: 6, h: 4, minW: 2, minH: 2 },
  // Row 13
  { i: "company-monitor",    x: 0, y: 13, w: 6, h: 4, minW: 2, minH: 2 },
  { i: "trade-decision",     x: 6, y: 13, w: 6, h: 4, minW: 2, minH: 2 },
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
      const { w, h } = DEFAULT_SIZES[moduleId] ?? { w: 4, h: 3 };
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
