// The agent's change, beside a person's work. It never takes focus, never covers the line being typed, and never moves the
// cursor: it sits at the foot of the doc and waits. Violet marks whose it is and nothing else, so Apply reads like any other
// button. A change whose words have gone shows what it wanted and offers Dismiss alone: Apply isn't there to press.
import { ArrowRight, Crosshair, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Ago, Avatar, KeyHint } from "@/components/kit";
import { AgentMark } from "./agent-mark";
import { CATALOG } from "@/lib/commands";
import type { DocApplied, DocSuggestion } from "@/lib/docs/api";
import { cn } from "@/lib/utils";

const FRAME = "pointer-events-auto relative flex w-full max-w-[44rem] min-w-0 flex-col gap-1 overflow-hidden rounded-lg border bg-popover py-2 pr-2 pl-3.5 text-popover-foreground shadow-md motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-150";
const SPINE = "absolute inset-y-0 left-0 w-0.5 bg-agent";

/** What it would change. Old words struck through, new words plain: the eye goes to what would be there. */
function Change({ suggestion, stale }: { suggestion: DocSuggestion; stale: boolean }) {
  if (!suggestion.find) return <p data-testid="suggestion-added" className="line-clamp-3 text-body wrap-anywhere whitespace-pre-line"><span className="text-caption text-muted-foreground">Add at the end: </span>{suggestion.text}</p>;
  return (
    <p data-testid="suggestion-change" className={cn("flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-body wrap-anywhere", stale && "text-muted-foreground")}>
      <del className="text-muted-foreground decoration-muted-foreground/60">{suggestion.find}</del>
      <ArrowRight aria-label="becomes" className="size-3 shrink-0 self-center text-muted-foreground" />
      <ins className="no-underline">{suggestion.text}</ins>
    </p>
  );
}

export function SuggestionBar({ suggestion, total, stale, busy, problem, onApply, onDismiss, onShow }: {
  suggestion: DocSuggestion; total: number; stale: boolean; busy: boolean; problem: string; onApply: () => void; onDismiss: () => void; onShow: () => void;
}) {
  return (
    <aside aria-label={`${suggestion.agent_name}'s suggestion`} data-testid="suggestion-bar" data-state={stale ? "stale" : "open"} className={FRAME}>
      <span aria-hidden className={SPINE} />
      <div className="flex min-w-0 items-center gap-1.5">
        <Avatar name={suggestion.agent_name} kind="agent" size="xs" decorative />
        <span role="status" className="min-w-0 truncate text-caption">
          <span className="font-medium text-agent-text">{suggestion.agent_name}</span>
          <span className="text-muted-foreground"> suggests a change</span>
        </span>
        <AgentMark />
        {total > 1 && <span data-testid="suggestion-count" className="shrink-0 text-caption text-muted-foreground tabular-nums">1 of {total}</span>}
        {stale && <span data-testid="suggestion-stale" className="inline-flex shrink-0 items-center gap-1 text-caption font-medium text-foreground"><TriangleAlert aria-hidden className="size-3 text-warning" />Text changed</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {!stale && !!suggestion.find && <Button type="button" size="xs" variant="ghost" aria-label="Show where in the doc" data-testid="suggestion-show" onClick={onShow} className="text-muted-foreground max-md:hidden"><Crosshair />Show</Button>}
          <Button type="button" size="xs" variant="ghost" disabled={busy} data-testid="suggestion-dismiss" onClick={onDismiss} className="max-md:min-h-11 max-md:px-3">Dismiss{!stale && <KeyHint shortcut={CATALOG["docs.dismiss"].shortcut} className="max-md:hidden" />}</Button>
          {!stale && <Button type="button" size="xs" disabled={busy} data-testid="suggestion-apply" onClick={onApply} className="max-md:min-h-11 max-md:px-4">{busy ? "Applying…" : "Apply"}<KeyHint shortcut={CATALOG["docs.apply"].shortcut} className="max-md:hidden" /></Button>}
        </span>
      </div>
      <Change suggestion={suggestion} stale={stale} />
      {stale
        ? <p className="text-caption text-pretty text-muted-foreground">The words it wanted to change have been edited, so it can't be applied.</p>
        : suggestion.note && <p data-testid="suggestion-note" className="line-clamp-2 text-caption text-pretty wrap-anywhere text-muted-foreground">{suggestion.note}</p>}
      {problem && <p role="alert" data-testid="suggestion-problem" className="text-caption text-pretty text-destructive">{problem}</p>}
    </aside>
  );
}

/** A change that went in by itself while nobody was working here. It says so once, and steps away when told. */
export function AppliedNote({ applied, onClose }: { applied: DocApplied; onClose: () => void }) {
  return (
    <aside aria-label={`${applied.agent_name}'s change`} data-testid="suggestion-applied" className={cn(FRAME, "flex-row items-center gap-1.5 py-1.5")}>
      <span aria-hidden className={SPINE} />
      <Avatar name={applied.agent_name} kind="agent" size="xs" decorative />
      <p role="status" className="min-w-0 flex-1 truncate text-caption">
        <span className="font-medium text-agent-text">{applied.agent_name}</span>
        <span className="text-muted-foreground"> changed this doc <Ago value={applied.decided_at} />{applied.note ? `: ${applied.note}` : ". It's in the history."}</span>
      </p>
      <Button type="button" size="icon-xs" variant="ghost" aria-label="Close" onClick={onClose} className="text-muted-foreground max-md:size-11"><X /></Button>
    </aside>
  );
}
