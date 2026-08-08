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

import {
  useDashboardLayout,
  readActiveLayoutId,
  ACTIVE_LAYOUT_KEY,
  type LayoutId,
} from "@/hooks/useDashboardLayout";
import { TileShell } from "./TileShell";
import { AddModulePanel } from "./AddModulePanel";
import { MODULE_REGISTRY } from "./ModuleRegistry";

/** Pill of three numbered layout-selector buttons shown in the toolbar. */
function LayoutSelector({
  active,
  onChange,
}: {
  active: LayoutId;
  onChange: (id: LayoutId) => void;
}) {
  return (
    <div
      className="flex items-center gap-0.5 rounded border border-border/60 p-0.5"
      title="Switch dashboard layout"
    >
      {([1, 2, 3] as const).map(id => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`w-6 h-6 rounded text-[11px] font-bold transition-colors select-none ${
            active === id
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground hover:bg-white/5"
          }`}
          title={`Layout ${id}`}
        >
          {id}
        </button>
      ))}
    </div>
  );
}

export function DashboardGrid() {
  // ── Active layout (persisted) ────────────────────────────────────────────
  const [activeLayout, setActiveLayout] = useState<LayoutId>(readActiveLayoutId);

  function handleSwitchLayout(id: LayoutId) {
    setActiveLayout(id);
    localStorage.setItem(ACTIVE_LAYOUT_KEY, String(id));
    // Leave edit mode when switching layouts
    setEditMode(false);
    setShowAdd(false);
  }

  // ── Per-layout data ──────────────────────────────────────────────────────
  const { activeModules, layout, saveLayout, addModule, removeModule, resetLayout } =
    useDashboardLayout(activeLayout);

  const [editMode, setEditMode] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  // ── Container width ──────────────────────────────────────────────────────
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

  // ── Layout computation ───────────────────────────────────────────────────
  const activeModuleDefs = MODULE_REGISTRY.filter(m => activeModules.includes(m.id));

  // Ensure every active module has a layout entry; add missing ones at bottom.
  // When NOT in edit mode, mark every item static so react-grid-layout
  // completely blocks drag and resize (isDraggable alone is unreliable).
  const effectiveLayout: LayoutItem[] = activeModuleDefs.map(m => {
    const existing = layout.find(l => l.i === m.id);
    const bottomY = layout.reduce((max, l) => Math.max(max, l.y + l.h), 0);
    const base: LayoutItem = existing
      ? { ...existing, minW: 1, minH: 1 } as LayoutItem
      : { i: m.id, x: 0, y: bottomY, w: 2, h: 2, minW: 1, minH: 1 } as LayoutItem;
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
        {/* Left: title + layout selector */}
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Dashboard</span>
          <LayoutSelector active={activeLayout} onChange={handleSwitchLayout} />
          {editMode && (
            <span className="text-[10px] text-muted-foreground hidden sm:inline">
              — grab handles to drag · resize from corners · × to remove
            </span>
          )}
        </div>

        {/* Right: edit controls */}
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
          <p className="text-sm text-muted-foreground">
            Layout {activeLayout} is empty — add modules to get started.
          </p>
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
            cols={4}
            rowHeight={200}
            margin={[8, 8]}
            containerPadding={[0, 0]}
            compactType={null}
            preventCollision={true}
            isDraggable={editMode}
            isResizable={editMode}
            resizeHandles={["s", "se", "e"]}
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
