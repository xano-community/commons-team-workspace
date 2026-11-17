import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { dayKey, toDate } from "./dates";
import { fullDate, shortDate } from "./time";

const BAR_HEIGHTS = ["h-[37.5%]", "h-[62.5%]", "h-[87.5%]"];

/**
 * Low, medium and high as three rising bars, of which one, two or three are filled: the empty ones stay faintly drawn, so a
 * low priority still reads as a priority at 14 px, not as a stray dot. It takes the size it's given (16 px by default).
 */
export function PriorityBars({ level, className }: { level: 1 | 2 | 3; className?: string }) {
  return (
    <span aria-hidden data-slot="priority-bars" data-level={level} className={cn("inline-flex size-4 shrink-0 items-end justify-center gap-0.5 p-px", className)}>
      {BAR_HEIGHTS.map((h, i) => <span key={h} className={cn("w-[18.75%] rounded-[1px] bg-current", h, i >= level && "opacity-25")} />)}
    </span>
  );
}

/**
 * Priority's own mark (CRAFT.md §9: other scales get their own mark, not a status pill). Only what's above
 * normal shows: "high" is bars in the muted foreground, "urgent" a warning triangle in destructive; anything
 * else renders nothing, so a mark always means "look at this". It takes the size of the text around it.
 *
 *   <PriorityMark level={deal.priority} />            // "urgent" | "high" | anything else
 *   <PriorityMark level="urgent" label="P1" />
 */
export function PriorityMark({ level, label, className }: { level: string | null | undefined; label?: string; className?: string }) {
  const l = level?.toLowerCase();
  if (l !== "urgent" && l !== "high") return null;
  return (
    <span data-slot="priority-mark" data-priority={l}
      className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap", l === "urgent" ? "font-medium text-destructive" : "text-muted-foreground", className)}>
      {l === "urgent" ? <TriangleAlert aria-hidden className="size-3.5 shrink-0" strokeWidth={2.25} /> : <PriorityBars level={3} className="size-3.5" />}
      {label ?? (l === "urgent" ? "Urgent" : "High")}
    </span>
  );
}

/**
 * A due date: "Tue 6 Oct", "Today", or, when it has passed and the thing isn't done, "Overdue · Mon 5 Oct" in
 * warning (CRAFT.md §17). A bare "2026-10-06" is that local day. The full date is on hover; empty → nothing.
 */
export function DueLabel({ value, done = false, className }: { value: string | number | Date | null | undefined; done?: boolean; className?: string }) {
  if (value === null || value === undefined || value === "") return null;
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return null;
  const day = dayKey(d), today = dayKey(new Date());
  const late = !done && day < today;
  return (
    <time dateTime={day} title={`Due ${fullDate(d)}`} data-slot="due-label" data-overdue={late || undefined}
      // The state's colour wins over a muted className from the row it sits in.
      className={cn("whitespace-nowrap tabular-nums", className, late && "font-medium text-warning", day === today && !done && "font-medium text-foreground")}>
      {!late && <span className="sr-only">Due </span>}
      {late ? `Overdue · ${shortDate(d)}` : day === today ? "Today" : shortDate(d)}
    </time>
  );
}
