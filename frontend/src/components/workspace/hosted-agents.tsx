// The agents on the Team screen: who each is, what it's been asked to do, and whether it can work yet. Each hosted brief is written
// here in plain words, and the same words open every run. A connected agent runs somewhere else, so what matters is when it was last
// seen, and that work waits for it.
import { useState } from "react";
import { Link } from "react-router";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Ago, Avatar } from "@/components/kit";
import { useCan } from "@/base/access";
import { AgentMark } from "@/components/workspace/agent-mark";
import { useWorkspace } from "@/base/workspace";
import { useConnectedAgents, useHostedAgents, usePauseAgents, usePickups } from "@/lib/agents/client";
import { PickupChip } from "@/components/workspace/run-chip";

/** "Last seen 5 minutes ago", or a plain word for an agent that's never called in. */
function LastSeen({ at, hasKey }: { at: number | null; hasKey: boolean }) {
  if (at) return <>Last seen <Ago value={at} />.</>;
  return <>{hasKey ? "It hasn't called in yet." : "It has no key yet."}</>;
}

/** Under a task given to a connected agent, so nobody waits for a run that can't start here. */
export function ConnectedNote({ id, taskId }: { id: number; taskId: number }) {
  const { data } = useConnectedAgents();
  const agent = data?.items.find((a) => a.id === id);
  const pickups = usePickups("task", taskId, !!agent);
  const item = pickups.data?.items.find((i) => i.user_id === id);
  if (!agent) return null;
  return (
    <div className="flex flex-col gap-1">
      {item && <PickupChip name={agent.name} agentId={agent.id} item={item} />}
      <p data-testid="connected-note" className="text-caption text-muted-foreground">{!item && `${agent.name} picks this up when it next runs. `}<LastSeen at={agent.last_seen} hasKey={agent.has_key} /></p>
    </div>
  );
}

function ConnectedAgents() {
  const { nameOf } = useWorkspace();
  const { data } = useConnectedAgents();
  if (!data?.items.length) return null;
  return (
    <section aria-label="Connected agents" data-testid="connected-agents" className="mt-6 flex flex-col gap-2">
      <h2 className="text-heading">Connected agents</h2>
      <ul className="flex flex-col divide-y rounded-lg border bg-card">
        {data.items.map((a) => (
          <li key={a.id} className="flex items-start gap-3 p-3">
            <Avatar name={a.name} kind="agent" size="md" decorative />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link to={`/team/agents/${a.id}`} data-testid="agent-link" className="focus-ring rounded-sm text-body font-medium text-agent-text underline-offset-2 hover:underline">{a.name}</Link>
                <AgentMark />
                <span className="text-caption text-muted-foreground">Sponsor: {nameOf(a.sponsor_id)}</span>
              </div>
              <p className="mt-1 text-body text-pretty text-muted-foreground">{a.brief}</p>
              <p data-testid="agent-last-seen" className="mt-1 text-caption text-muted-foreground"><LastSeen at={a.last_seen} hasKey={a.has_key} /> It picks up work when it next runs.</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One switch for every agent. What's queued stays queued, and says why on its record. */
function PauseAll({ paused }: { paused: boolean }) {
  const admin = useCan("team.manage");
  const pause = usePauseAgents();
  const [busy, setBusy] = useState(false);
  if (!admin) return null;
  const go = () => { setBusy(true); void pause(!paused).finally(() => setBusy(false)); };
  return <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="agents-pause" onClick={go} className="max-md:min-h-11">{paused ? <Play /> : <Pause />}{paused ? "Turn agents back on" : "Pause all agents"}</Button>;
}

export default function HostedAgents() {
  const { nameOf } = useWorkspace();
  const { data } = useHostedAgents();
  if (!data?.items.length) return <ConnectedAgents />;
  return (
    <>
    <section aria-label="Hosted agents" data-testid="hosted-agents" className="mt-6 flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-heading">Hosted agents</h2>
        <PauseAll paused={data.paused} />
      </div>
      {data.paused && <p data-testid="agents-paused" role="status" className="text-caption text-muted-foreground">Agents are paused. New requests wait here, and nothing starts until they're back on.</p>}
      <ul className="flex flex-col divide-y rounded-lg border bg-card">
        {data.items.map((a) => (
          <li key={a.id} className="flex items-start gap-3 p-3">
            <Avatar name={a.name} kind="agent" size="md" decorative />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link to={`/team/agents/${a.id}`} data-testid="agent-link" className="focus-ring rounded-sm text-body font-medium text-agent-text underline-offset-2 hover:underline">{a.name}</Link>
                <AgentMark />
                <span className="text-caption text-muted-foreground">Sponsor: {nameOf(a.sponsor_id)}</span>
              </div>
              <p data-testid="agent-brief" className="mt-1 text-body text-pretty text-muted-foreground">{a.brief}</p>
              {!data.model_ready && <p data-testid="agent-no-model" className="mt-1 text-caption text-muted-foreground">Waiting for a model key. Mentions and assignments queue until {data.key_name} is set.</p>}
            </div>
          </li>
        ))}
      </ul>
    </section>
    <ConnectedAgents />
    </>
  );
}
