// react-grid-layout styles
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

import { useState, useRef, useEffect } from "react";
import GridLayoutBase from "react-grid-layout";
import type { LayoutItem } from "react-grid-layout";

// Cast to any to avoid overly-strict @types/react-grid-layout callback signatures
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GridLayout = GridLayoutBase as React.ComponentType<any>;
import { LayoutGrid, Pencil, Check, RotateCcw } from "lucide-react";

import { useDashboardLayout } from "@/hooks/useDashboardLayout";
import { TileShell } from "./TileShell";
import { AddModulePanel } from "./AddModulePanel";
import { MODULE_REGISTRY } from "./ModuleRegistry";

export function DashboardGrid() {
  const { activeModules, layout, saveLayout, addModule, removeModule, resetLayout } =
    useDashboardLayout();
  const [editMode, setEditMode] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  // Measure container width so GridLayout fills its parent without WidthProvider
  const containerRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(1200);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) =>
      setGridWidth(entry.contentRect.width)
    );
    obs.observe(el);
    setGridWidth(el.getBoundingClientRect().width || 1200);
    return () => obs.disconnect();
  }, []);

  const activeModuleDefs = MODULE_REGISTRY.filter(m => activeModules.includes(m.id));

  // Ensure every active module has a layout entry; add missing ones at bottom.
  // When NOT in edit mode, mark every item static so react-grid-layout
  // completely blocks drag and resize (isDraggable alone is unreliable).
  const effectiveLayout: LayoutItem[] = activeModuleDefs.map(m => {
    const existing = layout.find(l => l.i === m.id);
    const bottomY = layout.reduce((max, l) => Math.max(max, l.y + l.h), 0);
    const base: LayoutItem = existing
      ? { ...existing, minW: 2, minH: 2 } as LayoutItem
      : { i: m.id, x: 0, y: bottomY, w: 4, h: 4, minW: 2, minH: 2 } as LayoutItem;
    return editMode ? base : { ...base, static: true } as LayoutItem;
  });

  function handleToggleEdit() {
    setEditMode(v => !v);
    setShowAdd(false);
  }

  function handleReset() {
    resetLayout();
    setShowAdd(false);
  }

  return (
    <div className="flex flex-col gap-2">
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Dashboard</span>
          {editMode && (
            <span className="text-[10px] text-muted-foreground hidden sm:inline">
              — grab handles to drag · resize from corners · × to remove
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {editMode && (
            <>
              <button
                onClick={() => setShowAdd(v => !v)}
                className="text-[11px] px-2 py-1 rounded border border-border/60 hover:border-foreground/20 hover:bg-white/5 text-foreground transition-colors"
              >
                + Add Module
              </button>
              <button
                onClick={handleReset}
                title="Reset to default layout"
                className="text-[11px] px-2 py-1 rounded border border-border/60 hover:border-foreground/20 hover:bg-white/5 text-muted-foreground transition-colors flex items-center gap-1"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            </>
          )}
          <button
            onClick={handleToggleEdit}
            className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded border border-border/60 hover:border-foreground/20 hover:bg-white/5 text-foreground transition-colors"
          >
            {editMode
              ? <><Check className="h-3 w-3" /> Done</>
              : <><Pencil className="h-3 w-3" /> Edit Layout</>}
          </button>
        </div>
      </div>

      {/* ── Add module panel ─────────────────────────────────────────────── */}
      {editMode && showAdd && (
        <AddModulePanel
          allModules={MODULE_REGISTRY}
          activeModules={activeModules}
          onAdd={(id) => { addModule(id); setShowAdd(false); }}
          onClose={() => setShowAdd(false)}
        />
      )}

      {/* ── Empty state ──────────────────────────────────────────────────── */}
      {activeModules.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
          <LayoutGrid className="h-8 w-8 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No modules on the dashboard.</p>
          <button
            onClick={() => { setEditMode(true); setShowAdd(true); }}
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-white/5 transition-colors"
          >
            + Add Modules
          </button>
        </div>
      )}

      {/* ── Grid ────────────────────────────────────────────────────────── */}
      {activeModules.length > 0 && (
        <div ref={containerRef}>
          <GridLayout
            layout={effectiveLayout}
            width={gridWidth}
            cols={12}
            rowHeight={80}
            margin={[6, 6]}
            containerPadding={[0, 0]}
            isDraggable={editMode}
            isResizable={editMode}
            draggableHandle=".drag-handle"
            onDragStop={(newLayout: LayoutItem[]) => saveLayout(newLayout)}
            onResizeStop={(newLayout: LayoutItem[]) => saveLayout(newLayout)}
            useCSSTransforms
          >
            {activeModuleDefs.map(mod => (
              <div key={mod.id} style={{ overflow: "hidden" }}>
                <TileShell
                  label={mod.label}
                  icon={mod.icon}
                  route={mod.route}
                  editMode={editMode}
                  onRemove={() => removeModule(mod.id)}
                >
                  <mod.Widget />
                </TileShell>
              </div>
            ))}
          </GridLayout>
        </div>
      )}
    </div>
  );
}
