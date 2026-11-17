import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { checklistShows } from "@/lib/first-run";
import { cn } from "@/lib/utils";

export interface FirstRunStep {
  id: string;
  title: string;
  /** Why it's worth doing, in one line. */
  description?: string;
  /** Where the step happens, or what it does. */
  href?: string;
  onClick?: () => void;
  /** Done is read from real data (a key exists, a record moved), not from a click. */
  done: boolean;
}

/**
 * The first-run checklist on the overview: the three to five things that show what the app can do, in
 * order, each one click from where it happens (CRAFT.md §18). Dismissing it is remembered per person.
 */
export function FirstRun({ storageKey, title = "Get to know the app", steps, className }: {
  /** Unique per person: `first-run:${me.id}`. */
  storageKey: string; title?: string; steps: FirstRunStep[]; className?: string;
}) {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(storageKey) === "dismissed"; } catch { return false; } });
  const done = steps.filter((s) => s.done).length;
  const [openedBefore] = useState(() => { try { return localStorage.getItem(`${storageKey}:open`) === "1"; } catch { return false; } });
  const unfinished = done < steps.length;
  // Open in full on the first visit only; after that (or once a step is done) it's one line with the next
  // step, expandable, so it never owns the screen.
  const [expanded, setExpanded] = useState(() => {
    if (done > 0) return false;
    try { return localStorage.getItem(`${storageKey}:seen`) !== "1"; } catch { return true; }
  });
  // Mark it seen after it shows, not while working out the first state (StrictMode runs that twice).
  useEffect(() => { if (!hidden && steps.length) { try { localStorage.setItem(`${storageKey}:seen`, "1"); } catch { /* storage off */ } } }, [storageKey, hidden, steps.length]);
  // Remembered while a step is left, so finishing the last one here still shows the finished card.
  useEffect(() => { if (unfinished && steps.length) { try { localStorage.setItem(`${storageKey}:open`, "1"); } catch { /* storage off */ } } }, [storageKey, unfinished, steps.length]);
  if (hidden || !checklistShows({ total: steps.length, done, openedBefore: openedBefore || unfinished })) return null;
  const dismiss = () => { try { localStorage.setItem(storageKey, "dismissed"); } catch { /* storage off */ } setHidden(true); };
  const next = steps.find((s) => !s.done);
  return (
    <section data-kit="first-run" aria-label={title} className={cn("rounded-lg border bg-card", className)}>
      {/* The title and its two buttons share one line, and the progress and the next step the line under it, so the card is
          two lines tall on a phone too. Not a <header>: a phone gives a panel header's links a 44 px row, which would double it. */}
      <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2 pr-2 pl-4 sm:py-3", expanded && "border-b")}>
        <h2 className="min-w-0 truncate text-heading">{done === steps.length ? "You've seen the best of it" : title}</h2>
        <div className="flex items-center">
          {done > 0 && done < steps.length && (
            <Button variant="ghost" size="icon-sm" aria-label={expanded ? "Show only the next step" : "Show every step"} aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
              <ChevronDown className={cn("transition-transform", expanded && "rotate-180")} />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Hide this checklist" onClick={dismiss}><X /></Button>
        </div>
        <div className="col-span-2 flex min-w-0 items-center gap-2 pr-2 pb-1 text-caption text-muted-foreground">
          <div aria-hidden className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(done / steps.length) * 100}%` }} />
          </div>
          <span className="shrink-0 tabular-nums">{done} of {steps.length} done</span>
          {!expanded && next && (
            <span className="min-w-0 truncate max-sm:-my-3.5 max-sm:py-3.5"><span aria-hidden>· </span>Next:{" "}
              {next.href ? <Link to={next.href} className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-ring max-sm:py-3.5">{next.title}</Link>
                : <button type="button" onClick={next.onClick} className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-ring max-sm:py-3.5">{next.title}</button>}
            </span>
          )}
        </div>
      </div>
      <ol className={cn("divide-y", !expanded && "hidden")}>
        {steps.map((s, i) => {
          if (!expanded) return null;
          const inner = (
            <>
              <span aria-hidden className={cn("grid size-6 shrink-0 place-items-center rounded-full border text-caption tabular-nums",
                s.done ? "border-primary bg-primary text-primary-foreground" : s === next ? "border-primary-text text-primary-text" : "text-muted-foreground")}>
                {s.done ? <Check className="size-3.5" /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-body font-medium", s.done && "text-muted-foreground line-through decoration-muted-foreground/40")}>{s.title}</span>
                {s.description && <span className="block text-caption text-muted-foreground">{s.description}</span>}
              </span>
              {!s.done && <ArrowRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
              <span className="sr-only">{s.done ? "(done)" : ""}</span>
            </>
          );
          const cls = "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 active:bg-muted focus-ring-inset";
          return (
            <li key={s.id} data-first-run-step={s.id} data-done={s.done || undefined}>
              {s.href ? <Link to={s.href} className={cls}>{inner}</Link>
                : <button type="button" onClick={s.onClick} className={cls}>{inner}</button>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
