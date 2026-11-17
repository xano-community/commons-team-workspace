// A run, on the record it concerns: who's on it, one plain word for how it's going, and what can be done about it. Violet marks
// the agent and nothing else, so a failure reads as a failure and a finished run steps back.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, ChevronDown, Copy, RotateCw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/kit";
import { isGuest, useMe } from "@/base/session";
import { useWorkspace } from "@/base/workspace";
import { useHostedAgents, useRunActions } from "@/lib/agents/client";
import { keyCommand, pickupLine, refusedKey, runLine, type AgentRun, type Pickup } from "@/lib/agents/model";
import { shellToast } from "@/lib/toast";
import { useShowsKeyCommand } from "@/lib/first-run";
import { RunSteps } from "./run-steps";
import { cn } from "@/lib/utils";

const DOT = { live: "bg-agent-text motion-safe:animate-pulse", waiting: "bg-muted-foreground", done: "bg-muted-foreground/60", failed: "bg-destructive" } as const;

/**
 * The no-model state, in words an end user can act on. Whoever may see it (anyone in a demo, admins after it) gets the exact
 * command behind "How to add one"; everyone else is told who to ask. Either way, the run starts by itself once a key is set.
 */
function NoKey({ keyName, refused }: { keyName: string; refused: boolean }) {
  const shows = useShowsKeyCommand();
  const [open, setOpen] = useState(false);
  if (!shows) return refused ? null : <p className="text-caption text-muted-foreground" data-testid="run-no-key">Ask an admin to add one. It starts by itself once they have.</p>;
  const command = keyCommand(keyName);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="run-no-key">
      <p className="flex flex-wrap items-center gap-x-2 text-caption text-muted-foreground">
        <span>It starts by itself once a key is set.</span>
        <button type="button" aria-expanded={open} data-testid="run-key-how" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
          className="focus-ring inline-flex items-center gap-0.5 rounded-sm font-medium text-foreground underline-offset-2 hover:underline max-md:min-h-11">
          How to add one<ChevronDown aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
        </button>
      </p>
      {open && (
        <div className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/60 p-2">
          <span className="text-caption text-muted-foreground">Run this where the app's backend is deployed, with your provider's key in <span className="font-mono">$KEY</span>:</span>
          <div className="flex min-w-0 items-center gap-1">
            <code data-testid="run-key-command" title={command} tabIndex={0} className="focus-ring min-w-0 flex-1 overflow-x-auto rounded-sm bg-background px-1.5 py-1 font-mono text-caption whitespace-nowrap">{command}</code>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Copy command" className="size-6 max-md:size-11" onClick={() => void navigator.clipboard?.writeText(command).then(() => shellToast.show("Copied"), () => shellToast.error("Your browser wouldn't copy that. Select the text instead."))}><Copy /></Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The demo's seeded run says what it is: no model wrote it, and deciding it is its last step. */
export function SampleTag() {
  return <span data-testid="sample-run" title="Part of the demo: no model wrote this. Deciding it is real." className="shrink-0 rounded-sm border px-1 text-micro font-medium text-muted-foreground">Sample run</span>;
}

export default function RunChip({ run, modelReady, keyName, className }: { run: AgentRun; modelReady: boolean; keyName: string; className?: string }) {
  const { nameOf } = useWorkspace();
  const me = useMe();
  const actions = useRunActions();
  const [busy, setBusy] = useState(false);
  const paused = useHostedAgents().data?.paused ?? false;
  const line = runLine(run, { modelReady, nameOf, guest: isGuest(me), paused, me: me?.id });
  const refused = refusedKey(run, keyName);
  const act = (go: (id: number) => Promise<unknown>) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    void go(run.id).finally(() => setBusy(false));
  };
  return (
    <div data-testid="run-chip" data-state={run.status} data-reason={run.reason || undefined} onClick={(e) => e.stopPropagation()}
      className={cn("flex max-w-md min-w-0 flex-col gap-1 rounded-lg border bg-card px-2 py-1.5", className)}>
      <div className="flex min-w-0 items-center gap-1.5" role="status">
        <Avatar name={run.agent_name} kind="agent" size="xs" decorative />
        {isGuest(me) ? <span className="shrink-0 text-caption font-medium text-agent-text">{run.agent_name}</span>
          : <Link to={`/team/agents/${run.agent_id}`} data-testid="run-agent" className="focus-ring shrink-0 rounded-sm text-caption font-medium text-agent-text underline-offset-2 hover:underline">{run.agent_name}</Link>}
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[line.tone])} />
        <span data-testid="run-label" className={cn("min-w-0 truncate text-caption font-medium", line.tone === "failed" ? "text-destructive" : "text-foreground")}>{line.label}</span>
        {run.sample && <SampleTag />}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {line.canStop && run.id > 0 && !run.sample && <Button type="button" size="xs" variant="ghost" disabled={busy} data-testid="run-stop" aria-label={`Stop ${run.agent_name}'s run`} onClick={act(actions.stop)} className="max-md:min-h-11"><Square />Stop</Button>}
          {line.canRetry && <Button type="button" size="xs" variant="outline" disabled={busy} data-testid="run-retry" aria-label={`Retry ${run.agent_name}'s run`} onClick={act(actions.retry)} className="max-md:min-h-11"><RotateCw />Retry</Button>}
          {line.action === "agent" && <Button asChild size="xs" variant="outline" className="max-md:min-h-11"><Link to={`/team/agents/${run.agent_id}`} data-testid="run-open-agent">Open {run.agent_name}<ArrowRight /></Link></Button>}
        </span>
      </div>
      {line.note && <p data-testid="run-note" className="text-caption text-pretty wrap-anywhere text-muted-foreground">{line.note}</p>}
      {line.worked && <RunSteps run={run} guest={isGuest(me)} />}
      {((run.status === "queued" && !modelReady && !paused) || refused) && <NoKey keyName={keyName} refused={refused} />}
    </div>
  );
}

/** Work handed to a connected agent: waiting for it to pick up, picked up, or Stalled after 30 minutes with nothing (KTD4). */
export function PickupChip({ name, agentId, item, className }: { name: string; agentId: number; item: Pickup; className?: string }) {
  const me = useMe();
  const [now, setNow] = useState(() => Date.now());
  // Stalled arrives on its own, so a page left open says so without a reload.
  useEffect(() => {
    if (item.read_at) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [item.read_at]);
  const line = pickupLine(item, name, now);
  return (
    <div data-testid="pickup-chip" data-state={item.read_at ? "picked" : line.label === "Stalled" ? "stalled" : "waiting"} onClick={(e) => e.stopPropagation()}
      className={cn("flex max-w-md min-w-0 flex-col gap-1 rounded-lg border bg-card px-2 py-1.5", className)}>
      <div className="flex min-w-0 items-center gap-1.5" role="status">
        <Avatar name={name} kind="agent" size="xs" decorative />
        {isGuest(me) ? <span className="shrink-0 text-caption font-medium text-agent-text">{name}</span>
          : <Link to={`/team/agents/${agentId}`} className="focus-ring shrink-0 rounded-sm text-caption font-medium text-agent-text underline-offset-2 hover:underline">{name}</Link>}
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[line.tone])} />
        <span data-testid="pickup-label" className="min-w-0 truncate text-caption font-medium text-foreground">{line.short}</span>
      </div>
      {line.note && <p className="text-caption text-pretty wrap-anywhere text-muted-foreground">{line.note}</p>}
    </div>
  );
}
