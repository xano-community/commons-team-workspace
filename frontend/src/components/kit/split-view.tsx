import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Which pane a phone shows. Desktop shows both, whatever this says. */
export const phonePane = (open: boolean): "list" | "detail" => (open ? "detail" : "list");

/**
 * A list and its detail. Side by side with a hairline between them on a desktop; on a phone one pane at a time, list
 * then detail, with a way back. `open` is true when a record is chosen: keep that in the URL, so back works too. For a
 * full-bleed route (`handle: { bleed: true }`).
 */
export function SplitView({ list, detail, open, onBack, backLabel = "Back", listLabel, className }: {
  list: ReactNode;
  detail: ReactNode;
  open: boolean;
  onBack: () => void;
  backLabel?: string;
  /** Names the list for a screen reader: "Conversations", "Tasks". */
  listLabel: string;
  className?: string;
}) {
  const pane = phonePane(open);
  return (
    <div data-kit="split-view" data-pane={pane} className={cn("grid h-full min-h-0 min-w-0 md:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]", className)}>
      <section aria-label={listLabel} className={cn("min-h-0 min-w-0 overflow-y-auto md:border-r", pane === "detail" && "max-md:hidden")}>{list}</section>
      <section aria-label="Detail" className={cn("flex min-h-0 min-w-0 flex-col", pane === "list" && "max-md:hidden")}>
        <div className="flex h-11 shrink-0 items-center border-b px-1 md:hidden">
          <Button variant="ghost" size="sm" onClick={onBack} data-kit="split-back"><ChevronLeft />{backLabel}</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{detail}</div>
      </section>
    </div>
  );
}
