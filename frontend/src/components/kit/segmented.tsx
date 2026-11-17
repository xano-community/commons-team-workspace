import { useRef, type ReactNode } from "react";
import { X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<V extends string> {
  value: V; label: string; icon?: LucideIcon;
  /** Show only the icon (the label becomes its name and tooltip). */ iconOnly?: boolean;
  /** A mark before the label that isn't a Lucide icon: a status, a face. */ mark?: ReactNode;
  /** How many are behind it, after the label. */ count?: number;
  /** A saved choice someone can delete: an ✕ shows on it while it's chosen. */ onRemove?: () => void;
  testId?: string;
}

/**
 * The one tab control: a small set of exclusive choices side by side, the chosen one a raised chip on a quiet track. Views (list /
 * board), filters (all / unread), saved filters and a trash all use it, at one height. A radio group with arrow keys. More than a
 * handful of options scroll sideways inside a `kit-scroll-x` parent. `value` may match none of them, as when a filter of someone's
 * own is on: then nothing is raised and the first takes the Tab stop.
 */
export function Segmented<V extends string>({ value, onChange, options, label, size = "sm", className, "data-kit": kit = "segmented" }: {
  value: V; onChange: (v: V) => void; options: SegmentedOption<V>[]; label: string; size?: "sm" | "xs"; className?: string; "data-kit"?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = options.findIndex((o) => o.value === value);
  return (
    <div role="radiogroup" aria-label={label} data-kit={kit}
      className={cn("inline-flex w-fit shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5", className)}>
      {options.map((o, i) => {
        const on = i === chosen;
        const face = cn("inline-flex items-center rounded-sm whitespace-nowrap transition-colors", on ? "bg-background text-foreground shadow-xs dark:bg-input" : "text-muted-foreground hover:text-foreground");
        const button = (
          <button key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={on} tabIndex={on || (chosen < 0 && i === 0) ? 0 : -1}
            aria-label={o.iconOnly ? o.label : undefined} title={o.iconOnly ? o.label : undefined} data-testid={o.testId}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!d) return;
              e.preventDefault();
              const n = (i + d + options.length) % options.length;
              onChange(options[n].value);
              refs.current[n]?.focus();
            }}
            className={cn("focus-ring inline-flex items-center justify-center gap-1.5 rounded-sm font-medium [&_svg]:size-4 [&_svg]:shrink-0",
              size === "sm" ? "h-7 px-2.5 text-body" : "h-6 px-2 text-caption",
              !(on && o.onRemove) && face)}>
            {o.mark}
            {o.icon && <o.icon aria-hidden />}
            {!o.iconOnly && o.label}
            {o.count !== undefined && <span className="text-caption font-normal text-muted-foreground tabular-nums">{o.count}</span>}
          </button>
        );
        if (!(on && o.onRemove)) return button;
        return (
          <span key={o.value} className={cn(face, "pr-0.5")}>
            {button}
            <button type="button" aria-label={`Delete ${o.label}`} data-testid="view-delete" onClick={o.onRemove}
              className="focus-ring grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground max-md:size-11"><X className="size-3" /></button>
          </span>
        );
      })}
    </div>
  );
}

/** A labelled control in a settings card: the label, the control, and a line of help under it. */
export function SettingRow({ label, id, hint, children }: { label: string; id: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-2" role="group" aria-labelledby={id}>
      <span id={id} className="text-body font-medium">{label}</span>
      {children}
      {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
    </div>
  );
}
