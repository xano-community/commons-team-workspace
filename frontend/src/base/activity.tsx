// Activity (BASELINE.md): what people and their agents did, from the rows app/changed writes. The overview's feed,
// /activity, and a record's timeline (`<RecordTimeline entity="job" id={12} />`). All three update live.
import { History } from "lucide-react";
import { Ago, Avatar, EmptyState, PageHeader, Pager, Panel, PanelList, PanelRow, useUrlState } from "@/components/kit";
import { AgentMark } from "@/components/workspace/agent-mark";
import { useEntityQuery } from "@/lib/data";
import { baseApi, type Activity } from "./api";
import { useLive } from "./live";
import { useWorkspace } from "./workspace";

function Item({ a }: { a: Activity }) {
  const { nameOf, isAgent } = useWorkspace();
  const who = a.actor_name || nameOf(a.actor_id);
  const agent = isAgent(a.actor_id);
  const body = (
    <>
      <Avatar name={a.via || who} kind={a.via || agent ? "agent" : "human"} size="sm" className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block text-body" title={`${who} ${a.title}`}><span className="font-medium">{who}</span>{agent && <> <AgentMark /></>}{a.via && <span className="text-muted-foreground"> via {a.via} <AgentMark /></span>} {a.title}</span>
        <span className="text-caption text-muted-foreground"><Ago value={a.created_at} />{a.approved_by > 0 && <span data-testid="activity-approved-by"> · approved by {nameOf(a.approved_by)}</span>}</span>
      </span>
    </>
  );
  return <PanelRow href={a.link || undefined} className="items-start" data-kit="activity-item">{body}</PanelRow>;
}

function useActivity(q: { entity?: string; entity_id?: number; page?: number; per_page?: number; by?: number }, liveOn: string[]) {
  const list = useEntityQuery("activity", [q], () => baseApi.activity(q));
  // Anything people do lands here, so this follows other entities' events as well as its own.
  useLive(liveOn, () => void list.refetch());
  return list;
}

function Rows({ list, empty }: { list: ReturnType<typeof useActivity>; empty: string }) {
  return (
    <PanelList loading={!list.data && !list.error} error={list.error} onRetry={() => void list.refetch()} empty={empty}>
      {list.data?.items.map((a) => <Item key={a.id} a={a} />)}
    </PanelList>
  );
}

/**
 * The overview's "what happened" card: people's and agents' latest actions. `entities` are what it listens to
 * live (the domain's tables); it always listens to the base's own.
 */
export function ActivityFeed({ limit = 6, entities = [], title = "Recent activity" }: { limit?: number; entities?: string[]; title?: string }) {
  const list = useActivity({ per_page: limit }, ["user", "settings", "invite", ...entities, "*"]);
  return (
    <Panel title={title} action={{ href: "/activity", label: "All activity" }} data-kit="activity-feed">
      <Rows list={list} empty="Nothing yet. What people and their agents do shows up here, as it happens." />
    </Panel>
  );
}

/** A record's history, on its detail page or sheet: `<RecordTimeline entity="job" id={job.id} />`. */
export function RecordTimeline({ entity, id, title = "History" }: { entity: string; id: number; title?: string }) {
  const list = useActivity({ entity, entity_id: id, per_page: 20 }, [entity]);
  return (
    <section aria-label={title} data-kit="record-timeline">
      <h3 className="mb-1 text-caption font-medium text-muted-foreground">{title}</h3>
      <div className="-mx-4"><Rows list={list} empty="No changes recorded yet." /></div>
    </section>
  );
}

/** What one member did, newest first: an agent's page lists its own work here. */
export function MemberActivity({ id, empty }: { id: number; empty: string }) {
  const list = useActivity({ by: id, per_page: 15 }, ["*"]);
  return <Rows list={list} empty={empty} />;
}

/** /activity: everything people and their agents did, newest first, paged. */
export function ActivityPage() {
  const [q, setQ] = useUrlState({ page: "1" });
  const list = useActivity({ page: Number(q.page) || 1, per_page: 30 }, ["*"]);
  return (
    <div className="flex flex-col gap-4" data-testid="activity-page">
      <PageHeader title="Activity" description="What people and their agents did, newest first. It updates as it happens." />
      {list.data && list.data.items.length === 0 ? (
        <EmptyState icon={History} title="No activity yet" description="Changes to records, invites and settings show up here as they happen." />
      ) : (
        <div className="rounded-lg border bg-card">
          <Rows list={list} empty="" />
          {list.data && list.data.pageTotal > 1 && <div className="border-t px-4 py-2"><Pager page={list.data.curPage} pageTotal={list.data.pageTotal} onPage={(p) => setQ({ page: String(p) })} /></div>}
        </div>
      )}
    </div>
  );
}
