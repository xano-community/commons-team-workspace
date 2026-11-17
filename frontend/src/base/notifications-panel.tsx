// What the bell opens, and the writes behind reading and clearing a line. Loaded the first time it's needed, so none of it
// is in the shell: the bell itself only has to show a number.
import { useCallback, useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { CheckCheck, Inbox as InboxIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { Ago, Avatar, LoadError } from "@/components/kit";
import { AgentMark } from "@/components/workspace/agent-mark";
import { useEntityQuery, useWrite, type EntityChange } from "@/lib/data";
import { byRecord, lineOf, visibleItems, type RecordGroup } from "@/lib/inbox/rules";
import type { RecordView } from "@/lib/links/resolver";
import { cn } from "@/lib/utils";
import { routePath } from "../../../xano/routes.gen.js";
import { baseApi, type Notification, type NotificationPage } from "./api";
import { UNREAD, useUnreadCount } from "./notifications";
import { useMe } from "./session";

const unreadChange = (count: number): EntityChange => ({ entity: UNREAD, id: "unread", patch: { count: Math.max(0, count) } });

/** Who a line came from. An agent is the rounded violet square, and something the workspace said has a plain mark. */
export function ActorFace({ n, size = "sm" }: { n: Notification; size?: "sm" | "md" }) {
  if (!n.actor_name) return <span aria-hidden className={cn("grid shrink-0 place-items-center rounded-full bg-muted text-muted-foreground", size === "sm" ? "size-6" : "size-8")}><InboxIcon className="size-3.5" /></span>;
  return <Avatar name={n.actor_name} kind={n.actor_kind} size={size} />;
}

/** What the record has become, when it can't be named here. */
const GONE: Partial<Record<RecordView["state"], string>> = { locked: "No access", deleted: "Deleted", tombstone: "Message deleted" };

/** One thread or record: what happened last, who did it, and how much more there is. Opening it reads all of it. */
function Row({ group, record, onOpen }: { group: RecordGroup<Notification>; record?: RecordView; onOpen: () => void }) {
  const n = group.line;
  const { who, did, what } = lineOf(n, record);
  const gone = record && GONE[record.state];
  return (
    <li>
      <button type="button" onClick={onOpen} data-kit="notification" data-unread={group.unread || undefined}
        className="flex w-full min-w-0 items-start gap-2.5 px-3 py-2 text-left hover:bg-muted/50 active:bg-muted focus-ring-inset">
        <span aria-hidden className={cn("mt-2 size-1.5 shrink-0 rounded-full", group.unread ? "bg-primary" : "bg-transparent")} />
        <ActorFace n={n} />
        <span className="min-w-0 flex-1">
          <span data-testid="notification-line" className={cn("line-clamp-2 text-body wrap-anywhere", !group.unread && "text-muted-foreground")} title={[who, did, what].filter(Boolean).join(" ")}>
            {who && <span className={cn("font-medium", group.unread && "text-foreground")}>{who} </span>}
            {n.actor_kind === "agent" && <><AgentMark /> </>}
            {did}
            {what && <span className={cn("font-medium", group.unread && "text-foreground")}> {what}</span>}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
            <Ago value={n.created_at} className="shrink-0" />
            {gone && <span className="truncate">· {gone}</span>}
          </span>
        </span>
        {group.count > 1 && <span className="mt-0.5 shrink-0 rounded-sm bg-muted px-1 text-micro text-muted-foreground tabular-nums" title={`${group.count} items`}>{group.count}</span>}
        {group.unread && <span className="sr-only">Unread</span>}
      </button>
    </li>
  );
}

/** Marking read shows at once on every row and on the bell, and the server catches up. */
export function useMarkRead() {
  const me = useMe();
  const client = useQueryClient();
  const write = useWrite(me.id);
  const unreadNow = () => client.getQueryData<{ count: number }>([UNREAD, "count"])?.count ?? 0;
  const one = useCallback((n: Notification) => write({
    label: "mark that notification read", verb: "POST", path: routePath("POST app/notifications/{id}/read", { id: n.id }),
    changes: [{ entity: "notification", id: n.id, patch: { read_at: Date.now() } }, unreadChange(unreadNow() - 1)],
  }), [write]); // eslint-disable-line react-hooks/exhaustive-deps
  const clear = useCallback((n: Notification) => write({
    label: "clear that item", verb: "POST", path: routePath("POST app/notifications/{id}/done", { id: n.id }),
    changes: [{ entity: "notification", id: n.id, patch: { done_at: Date.now() } }, ...(n.read_at ? [] : [unreadChange(unreadNow() - 1)])],
  }), [write]); // eslint-disable-line react-hooks/exhaustive-deps
  /** What waits for a decision stays unread, so the number falls to those and no further. */
  const all = useCallback(() => {
    const rows = client.getQueriesData<NotificationPage>({ queryKey: ["notification"] }).flatMap(([, page]) => page?.items ?? []);
    const unread = [...new Map(rows.filter((n) => !n.read_at).map((n) => [n.id, n])).values()];
    return write({
      label: "mark everything read", verb: "POST", path: routePath("POST app/notifications/read-all"),
      changes: [...unread.filter((n) => !n.needs_action).map((n) => ({ entity: "notification", id: n.id, patch: { read_at: Date.now() } })), unreadChange(unread.filter((n) => n.needs_action).length)],
    });
  }, [write, client]);
  return { one, clear, all };
}

/** Opening a row reads every line under it. A record that can't be opened any more goes to its line in the inbox, which says why. */
function useOpenGroup() {
  const navigate = useNavigate();
  const { one } = useMarkRead();
  return useCallback((group: RecordGroup<Notification>, record?: RecordView) => {
    group.lines.filter((n) => !n.read_at).forEach((n) => void one(n));
    const opens = !record || record.state === "live" || record.state === "archived";
    if (!opens) navigate(`/inbox?item=${group.line.id}`);
    else if (group.line.link) navigate(group.line.link);
  }, [navigate, one]);
}

/** The latest eight threads and records, Mark all read, and See all. */
export default function NotificationPanel({ onClose }: { onClose: () => void }) {
  const unread = useUnreadCount();
  const latest = useEntityQuery("notification", ["latest"], () => baseApi.notifications());
  const open = useOpenGroup();
  const { all } = useMarkRead();
  const groups = useMemo(() => byRecord(visibleItems(latest.data?.items ?? [])).slice(0, 8), [latest.data]);
  const records = useMemo(() => new Map((latest.data?.records ?? []).map((r) => [`${r.type}:${r.id}`, r as RecordView])), [latest.data]);
  const recordOf = (n: Notification) => records.get(`${n.entity}:${n.entity_id}`);
  return (
    <>
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-heading">Inbox</span>
        <Button variant="ghost" size="sm" disabled={!unread.count} onClick={() => void all()}><CheckCheck />Mark all read</Button>
      </div>
      {latest.error ? <LoadError error={latest.error} onRetry={() => void latest.refetch()} className="m-3" />
        : !latest.data ? <div className="space-y-2 p-3">{[0, 1, 2].map((i) => <Skeleton key={`skeleton-${i}`} className="h-9 w-full" />)}</div>
        : groups.length === 0 ? <p className="px-3 py-6 text-center text-body text-muted-foreground">You're all caught up.</p>
        : <ul className="max-h-96 min-h-0 divide-y overflow-y-auto">{groups.map((g) => <Row key={g.line.id} group={g} record={recordOf(g.line)} onOpen={() => { onClose(); open(g, recordOf(g.line)); }} />)}</ul>}
      <div className="border-t p-1">
        <Button asChild variant="ghost" size="sm" className="w-full"><Link to="/inbox" onClick={onClose}>See all</Link></Button>
      </div>
    </>
  );
}
