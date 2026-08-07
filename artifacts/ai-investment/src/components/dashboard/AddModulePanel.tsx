import { X, Plus } from "lucide-react";
import type { ModuleDef } from "./ModuleRegistry";

interface AddModulePanelProps {
  allModules: ModuleDef[];
  activeModules: string[];
  onAdd: (id: string) => void;
  onClose: () => void;
}

export function AddModulePanel({ allModules, activeModules, onAdd, onClose }: AddModulePanelProps) {
  const inactive = allModules.filter(m => !activeModules.includes(m.id));

  return (
    <div className="rounded-lg border border-border bg-card/80 backdrop-blur p-3 mb-2">
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-xs font-semibold text-foreground">Add Module</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {inactive.length === 0 ? (
        <p className="text-xs text-muted-foreground py-1">All modules are on the dashboard.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {inactive.map(mod => (
            <button
              key={mod.id}
              onClick={() => onAdd(mod.id)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border/60 hover:border-foreground/20 hover:bg-white/5 text-xs text-foreground transition-colors"
            >
              <mod.icon className="h-3 w-3 text-muted-foreground" />
              <span>{mod.label}</span>
              <Plus className="h-3 w-3 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
