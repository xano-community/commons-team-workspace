// The overview: what needs me, then the agents' work, then what's been happening across my spaces. Every number opens the list
// behind it, and comes from the same rows as that list.
import { useMemo } from "react";
import { Link } from "react-router";
import { usePendingCount } from "@xano-sdk/agents/react";
import { CircleCheck, Plug, Users } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentMark } from "@/components/workspace/agent-mark";
import { useCan } from "@/base/access";
import { ActivityFeed } from "@/base/activity";
import { WithAgents } from "@/base/agents";
import { useLive } from "@/base/live";
import { useUnreadCount } from "@/base/notifications";
import { isGuest, useMe } from "@/base/session";
import { useWorkspace } from "@/base/workspace";
import { Ago, Avatar, DueLabel, EmptyState, FirstRun, LoadError, PageHeader, Panel, PanelList, PanelRow, StatCard, type FirstRunStep } from "@/components/kit";
import { dayKey } from "@/components/kit/dates";
import { StatusIcon, statusName } from "./tasks/marks";
import { useEntityQuery } from "@/lib/data";
import { request } from "@/base/request";
import { approvalLook, landing } from "@/lib/agents/approvals";
import { useApproval, usePendingApprovalIds } from "@/lib/agents/client";
import { usePendingApprovals as useWaitingCount } from "@/base/approvals-count";
import { money } from "@/lib/crm/model";
import { closingThisMonth, firstSteps, runHref, runLine, runTone, weekTrend, type Overview as OverviewData } from "@/lib/search/overview";
import { cn } from "@/lib/utils";
import { routePath } from "../../../xano/routes.gen.js";

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };

function useOverview() {
  // The person's own calendar day, so the server's "late" matches every due date on screen. Read per fetch, so a tab left open
  // overnight asks about the new day.
  const read = useEntityQuery("overview", [], () => request<OverviewData>("GET", `${routePath("GET overview")}?today=${dayKey(new Date())}`));
  useLive(["task", "agent_run", "message", "doc", "file", "space_member"], () => void read.refetch());
  return read;
}

export const OverviewPage = () => (isGuest(useMe()) ? <Screen guest /> : <WithAgents><Screen /></WithAgents>);

function Screen({ guest = false }: { guest?: boolean }) {
  const me = useMe();
  const { name, people } = useWorkspace();
  const overview = useOverview();
  const data = overview.data;
  const canInvite = useCan("team.manage");
  const waiting = useWaitingCount(!guest);
  // "Answer an agent" opens the run that's waiting where it was asked, with its draft beside the ask.
  const waitingRun = data?.agents.items.find((r) => r.status === "waiting");
  const answer = waitingRun ? runHref(waitingRun) : undefined;
  const steps: FirstRunStep[] = useMemo(() => (data ? firstSteps(data.started, { canInvite, guest, people: people.length, ...(guest ? {} : { waiting, answer }) }) : []), [data, canInvite, guest, people.length, waiting, answer]);
  return (
    <div className="flex flex-col gap-6" data-testid="overview">
      <PageHeader title={`${greeting()}, ${me.name.split(" ")[0]}`} description={guest ? "What needs you in your spaces." : "What needs you, what your agents are on, and what's been happening."} />
      {overview.error && !data ? <LoadError error={overview.error} onRetry={() => void overview.refetch()} /> : null}
      {data?.spaces === 0 ? (
        <EmptyState icon={Users} title="You're not in a space yet" description={guest ? "Whoever invited you can add you to one. It'll show up here." : "Spaces hold your team's chat, tasks, docs and files."}
          action={guest ? undefined : <Link to="/team" className="text-body font-medium underline underline-offset-2 focus-ring">See who's here</Link>} />
      ) : (
        <>
          {steps.length > 0 && <FirstRun storageKey={`first-run:${me.id}`} title={`Get started in ${name ?? "the app"}`} steps={steps} />}
          {guest ? <NeedsMe data={data} failed={!!overview.error && !data} guest /> : <StaffNeedsMe data={data} failed={!!overview.error && !data} />}
          {!(overview.error && !data) && (
            <div className={cn("grid items-start gap-3", !guest && "lg:grid-cols-2")}>
              <DueNext data={data} />
              {!guest && <AgentWork data={data} />}
            </div>
          )}
          <ActivityFeed limit={8} title="Recent activity in your spaces" />
        </>
      )}
    </div>
  );
}

/** The agents module's count needs its provider, which a guest's overview doesn't load. */
const StaffNeedsMe = ({ data, failed }: { data?: OverviewData; failed: boolean }) => <NeedsMe data={data} failed={failed} pending={usePendingCount()} />;

/** The four numbers that matter today: each opens the list behind it, and the two that move week to week say which way. */
function NeedsMe({ data, failed = false, guest = false, pending = 0 }: { data?: OverviewData; failed?: boolean; guest?: boolean; pending?: number }) {
  const unread = useUnreadCount();
  const late = data?.tasks.late ?? 0;
  const loading = !data && !failed;
  const done = useMemo(() => weekTrend(data?.trends?.done_at ?? []), [data]);
  const runs = useMemo(() => weekTrend(data?.trends?.runs_at ?? []), [data]);
  const deals = data?.deals ? closingThisMonth(data.deals) : null;
  const dash = failed ? "—" : undefined;
  const clear = !!data && !unread.loading && !unread.count && !pending && !data.tasks.open;
  const card = "max-sm:p-3";
  return (
    <section aria-labelledby="needs-me" className="flex flex-col gap-3" data-testid="needs-me">
      <h2 id="needs-me" className="text-heading">What needs you</h2>
      <div className={cn("grid grid-cols-2 gap-2 sm:gap-3", guest ? "lg:grid-cols-3" : "lg:grid-cols-4")}>
        <StatCard className={card} label="Your open tasks" value={dash ?? data?.tasks.open ?? 0} loading={loading} href={late ? "/tasks?assignee=me&due=overdue" : "/tasks?assignee=me"}
          hint={failed ? "Didn't load" : late ? <span className="text-warning">{late} past {late === 1 ? "its" : "their"} due date</span> : "Nothing late"} />
        <StatCard className={card} label="Tasks done" value={dash ?? done.week} loading={loading} href="/tasks?finished=1&status=done"
          trend={data ? done.days : undefined} delta={data ? { value: done.week - done.last, label: "the week before" } : undefined}
          hint={failed ? "Didn't load" : `This week · ${done.last} the week before`} />
        {deals ? (
          <StatCard className={card} label="Closing this month" value={money(deals.value)} href="/crm?close=month"
            hint={deals.late ? <span>{deals.count} {deals.count === 1 ? "deal" : "deals"} · <span className="text-warning">{deals.late} past {deals.late === 1 ? "its" : "their"} date</span></span> : `${deals.count} ${deals.count === 1 ? "deal" : "deals"} in the pipeline`} />
        ) : guest ? (
          <StatCard className={card} label="Unread" value={unread.count} hint="In your inbox" href="/inbox" loading={unread.loading} />
        ) : null}
        {!guest && (
          <StatCard className={card} label="Agent runs" value={dash ?? runs.week} loading={loading} href="/agents"
            trend={data ? runs.days : undefined} delta={data ? { value: runs.week - runs.last, label: "the week before" } : undefined}
            hint={failed ? "Didn't load" : pending ? <span className="text-agent-text">{pending} waiting for your OK</span> : `This week · ${runs.last} the week before`} />
        )}
        {!guest && !deals && !loading && <StatCard className={card} label="Unread" value={unread.count} hint="In your inbox" href="/inbox" loading={unread.loading} />}
      </div>
      {!guest && <WaitingForYou />}
      {clear && <p data-testid="all-clear" className="flex items-center gap-2 rounded-lg border bg-card px-4 py-3 text-body text-muted-foreground"><CircleCheck aria-hidden className="size-4 shrink-0" />Nothing needs you right now.</p>}
    </section>
  );
}

/** What agents are waiting on this person for, in plain words: who, what, and where it would land. */
function WaitingForYou() {
  const list = usePendingApprovalIds(true);
  const ids = (list.data?.items ?? []).map((a) => a.id);
  if (!ids.length) return null;
  return (
    <Panel title={ids.length === 1 ? "Waiting for your OK" : `${ids.length} waiting for your OK`} action={{ href: "/approvals", label: "Review" }} data-kit="waiting-for-you" className="border-agent-text/30">
      <PanelList>{ids.slice(0, 3).map((id) => <WaitingRow key={id} id={id} />)}</PanelList>
    </Panel>
  );
}

function WaitingRow({ id }: { id: number }) {
  const { nameOf } = useWorkspace();
  const card = useApproval(id);
  const v = card.data;
  if (!v) return <li className="px-4 py-2"><Skeleton className="h-5 w-2/3" /></li>;
  const look = approvalLook(v, nameOf);
  // A thread is named for its channel: "a thread in #marlow-oakline" reads as a place.
  const { asks, record } = landing(v.action, look.asks, v.record as { title: string } | null);
  const where = record && asks !== look.asks ? `#${record.title}` : record?.title;
  return (
    <PanelRow href="/approvals" className="items-start">
      <Avatar name={v.agent_name} kind="agent" size="sm" className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body"><span className="font-medium">{v.agent_name}</span> <AgentMark /> {asks}{where ? <span className="font-medium"> {where}</span> : null}</span>
        {(look.body || look.reason) && <span className="block truncate text-caption text-muted-foreground" title={look.body || look.reason}>{look.body || look.reason}</span>}
      </span>
      <Ago value={v.created_at} className="shrink-0 text-caption text-muted-foreground" />
    </PanelRow>
  );
}

/** The same row as on Tasks: its status, its name, when it's due, and who's on it. Late ones come first, in amber. */
function DueNext({ data }: { data?: OverviewData }) {
  const { people } = useWorkspace();
  return (
    <Panel title="Due next" action={{ href: "/tasks?assignee=me", label: "All your tasks" }} data-kit="due-next">
      <PanelList loading={!data} empty={<>Nothing with a due date. Tasks assigned to you show up here by when they're due.</>}>
        {data?.tasks.items.map((t) => {
          const who = people.find((p) => p.id === t.assignee_id);
          return (
            <PanelRow key={t.id} href={`/tasks/${t.id}`}>
              <span role="img" aria-label={statusName(t.status)} className="flex shrink-0"><StatusIcon status={t.status} /></span>
              <span className="min-w-0 flex-1 truncate" title={t.title}>{t.title}</span>
              <DueLabel value={t.due_on} className="ml-2 shrink-0 text-right text-caption text-muted-foreground" />
              {who && <Avatar name={who.name} kind={who.kind} size="xs" className="ml-1 shrink-0" />}
            </PanelRow>
          );
        })}
      </PanelList>
    </Panel>
  );
}

const RUN_WORD: Record<string, string> = { done: "Done", failed: "Failed", waiting: "Waiting", queued: "Queued", stopped: "Stopped" };

function AgentWork({ data }: { data?: OverviewData }) {
  const active = data?.agents.active ?? 0;
  return (
    <Panel title={active ? `Agent work · ${active} going` : "Agent work"} action={{ href: "/agents", label: "All agents" }} data-kit="agent-work"
      extra={<Link to="/agents" data-testid="connect-agent" className="inline-flex items-center gap-1 rounded-sm text-caption text-muted-foreground transition-colors hover:text-foreground focus-ring"><Plug aria-hidden className="size-3.5" />Connect an agent</Link>}>
      <PanelList loading={!data} empty={<>No agent work yet. Mention an agent in a conversation, or assign it a task, and you'll see it here.</>}>
        {data?.agents.items.map((run) => (
          <PanelRow key={run.id} href={runHref(run)} className="items-start">
            <Avatar name={run.agent_name ?? "Agent"} kind="agent" size="sm" className="mt-0.5" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body" title={runLine(run)}><span className="font-medium">{run.agent_name ?? "Agent"}</span> <AgentMark /> <span className="text-muted-foreground">{runLine(run)}</span></span>
              <Ago value={run.finished_at ?? run.created_at} className="text-caption text-muted-foreground" />
            </span>
            <span className={cn("shrink-0 text-caption", runTone(run) === "going" ? "font-medium text-agent-text" : "text-muted-foreground")}>{RUN_WORD[run.status] ?? "Working"}</span>
          </PanelRow>
        ))}
      </PanelList>
    </Panel>
  );
}
