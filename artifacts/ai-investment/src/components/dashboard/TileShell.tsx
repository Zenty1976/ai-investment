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
 * - In edit mode: shows drag handle (.drag-handle) and × remove button.
 * - Always: module icon, name, and → navigate link.
 * - Content slot fills remaining height with overflow hidden.
 */
export function TileShell({ label, icon: Icon, route, editMode, onRemove, children }: TileShellProps) {
  return (
    <div className="h-full w-full flex flex-col rounded-lg border border-border bg-card overflow-hidden select-none">
      {/* Header bar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/60 bg-card shrink-0" style={{ minHeight: 28 }}>
        {editMode && (
          <div
            className="drag-handle cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground/80 transition-colors"
            title="Drag to move"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </div>
        )}
        <Icon className="h-3 w-3 text-muted-foreground/70 shrink-0" />
        <span className="text-[11px] font-medium text-foreground/80 truncate flex-1 leading-none">
          {label}
        </span>
        <Link
          href={route}
          className="text-muted-foreground/40 hover:text-foreground/70 transition-colors shrink-0"
          title={`Open ${label}`}
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="h-2.5 w-2.5" />
        </Link>
        {editMode && (
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="text-muted-foreground/30 hover:text-red-400/80 transition-colors shrink-0 ml-0.5"
            title={`Remove ${label}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        )}
      </div>

      {/* Widget content — fills remaining height */}
      <div className="flex-1 overflow-hidden min-h-0">
        {children}
      </div>
    </div>
  );
}
