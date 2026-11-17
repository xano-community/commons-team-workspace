// "Worked for 42 s, 6 steps", which opens to what each step did. A step names its record only for someone who can open it, and never
// says what the agent wrote or read (KTD11). A guest sees the count and no steps, so for them it doesn't open.
import { useId, useState } from "react";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useRunSteps } from "@/lib/agents/client";
import { stepLine, workedText, type AgentRun } from "@/lib/agents/model";
import { cn } from "@/lib/utils";

export function RunSteps({ run, guest, className }: { run: Pick<AgentRun, "id" | "started_at" | "finished_at" | "tool_calls">; guest: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const list = useId();
  const steps = useRunSteps(run.id, open);
  const worked = workedText(run);
  // An empty list can arrive as {} from the engine.
  const rows = Array.isArray(steps.data?.steps) ? steps.data.steps : [];
  if (!worked) return null;
  if (guest || !run.tool_calls || run.id <= 0) return <p data-testid="run-worked" className={cn("text-caption text-muted-foreground tabular-nums", className)}>{worked}</p>;
  return (
    <div className={cn("min-w-0", className)}>
      <button type="button" data-testid="run-worked" aria-expanded={open} aria-controls={list} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className="focus-ring -mx-1 inline-flex min-h-6 items-center gap-0.5 rounded-sm px-1 text-caption text-muted-foreground tabular-nums transition-colors hover:text-foreground max-md:min-h-11">
        <ChevronRight aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-90")} />{worked}
      </button>
      {open && (
        <ol id={list} data-testid="run-steps" aria-label="What it did" className="mt-1 flex flex-col gap-1 border-l pl-3">
          {steps.error ? <li role="alert" className="text-caption text-muted-foreground">These steps didn't load. <button type="button" className="underline" onClick={() => void steps.refetch()}>Try again</button></li>
            : !steps.data ? Array.from({ length: Math.min(run.tool_calls, 3) }, (_, i) => <li key={i}><Skeleton className="h-4 w-48 max-w-full" /></li>)
            : rows.length === 0 ? <li className="text-caption text-muted-foreground">No steps were kept for this run.</li>
            : rows.map((step, i) => {
              const line = stepLine(step, step.record ?? undefined);
              return (
                <li key={i} data-testid="run-step" data-ok={line.ok || undefined} className="flex min-w-0 items-baseline gap-1.5 text-caption">
                  <span aria-hidden className={cn("size-1.5 shrink-0 translate-y-[-1px] rounded-full", line.ok ? "bg-muted-foreground/60" : "bg-destructive")} />
                  <span className={cn("min-w-0 wrap-anywhere", line.ok ? "text-foreground" : "text-muted-foreground")}>
                    {line.text}
                    {line.title && <> {line.href ? <Link to={line.href} className="font-medium underline-offset-2 hover:underline">{line.title}</Link> : <span className="text-muted-foreground italic">{line.title}</span>}</>}
                  </span>
                </li>
              );
            })}
        </ol>
      )}
    </div>
  );
}
