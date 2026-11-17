import { shortcutKeys } from "@/lib/commands";
import { cn } from "@/lib/utils";

/** A shortcut as keycaps, wherever a command is shown: a tooltip, a menu row, the "?" sheet. */
export function KeyHint({ shortcut, className }: { shortcut: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {shortcutKeys(shortcut).map((k, i) => (
        <span key={k + i} className="contents">
          {i > 0 && <span className="text-caption text-muted-foreground">then</span>}
          <kbd className="rounded border bg-muted px-1.5 font-mono text-micro text-foreground">{k}</kbd>
        </span>
      ))}
    </span>
  );
}
