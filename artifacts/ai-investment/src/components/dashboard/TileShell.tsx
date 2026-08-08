import { GripVertical, ExternalLink, X } from "lucide-react";
import { Link } from "wouter";
import type { LucideIcon } from "lucide-react";

interface TileShellProps {
  label: string;
  icon: LucideIcon;
  route: string;
  editMode: boolean;
  onRemove: () => void;
  children: React.ReactNode;
}

/**
 * Chrome wrapper for every dashboard tile.
 *
 * - Edit bar (drag handle + × remove): only visible in edit mode, ultra-compact.
 * - Title row: icon + large bold label + navigate link, always visible.
 * - Content slot fills remaining height with overflow hidden.
 */
export function TileShell({ label, icon: Icon, route, editMode, onRemove, children }: TileShellProps) {
  return (
    <div className="h-full w-full flex flex-col rounded-lg border border-border bg-card overflow-hidden select-none">

      {/* Top bar — edit controls + external link, always rendered when needed */}
      <div className="flex items-center justify-between px-2 border-b border-border/40 bg-card shrink-0" style={{ height: 22 }}>
        {editMode ? (
          <div
            className="drag-handle cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors flex items-center gap-1"
            title="Drag to move"
          >
            <GripVertical className="h-3 w-3" />
            <span className="text-[9px] text-muted-foreground/30 uppercase tracking-widest leading-none">drag</span>
          </div>
        ) : (
          <div />
        )}
        <div className="flex items-center gap-1">
          <Link
            href={route}
            className="text-muted-foreground/30 hover:text-foreground/60 transition-colors shrink-0"
            title={`Open ${label}`}
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="h-2.5 w-2.5" />
          </Link>
          {editMode && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              className="text-muted-foreground/30 hover:text-red-400/80 transition-colors"
              title={`Remove ${label}`}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Title row — always visible */}
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 shrink-0 min-w-0">
        <Icon className="h-4 w-4 text-muted-foreground/60 shrink-0" />
        <span className="text-base text-foreground leading-tight truncate">
          {label}
        </span>
      </div>

      {/* Widget content — fills remaining height */}
      <div className="flex-1 overflow-hidden min-h-0">
        {children}
      </div>
    </div>
  );
}
