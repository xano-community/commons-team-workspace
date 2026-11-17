// The inbox: everything that wants this person, in one list. What needs a decision sits first, and a line opens beside
// the list. Selecting a line opens it, so j and k read as they go. Nothing here animates: a key press lands at once.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Link, useNavigate } from "react-router";
import { lazy, Suspense } from "react";
import { Check, CheckCheck, CornerDownLeft, Inbox as InboxIcon, Layers, ListFilter, SearchX, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Ago, EmptyState, KeyHint, LoadError, Pager, Segmented, SplitView, useUrlState } from "@/components/kit";
import { AgentMark } from "@/components/workspace/agent-mark";
import { LinkChip } from "@/components/workspace/link-chip";
import { LinksPanel } from "@/components/workspace/links-panel";
import { baseApi, type Notification } from "@/base/api";
import { useUnreadCount } from "@/base/notifications";
import { ActorFace, useMarkRead } from "@/base/notifications-panel";
import { isGuest, useMe } from "@/base/session";
import { CATALOG, useCommands, type Command } from "@/lib/commands";
import { useEntityQuery, useMySpaceIds, useSpaceScope } from "@/lib/data";
import { emptyState, enterOpens, heldLine, neighbour, sections, visibleItems, type EmptyKind } from "@/lib/inbox/rules";
import type { RecordView } from "@/lib/links/resolver";
import { cn } from "@/lib/utils";

type View = "all" | "unread" | "needs";
const VIEWS: { value: View; label: string }[] = [{ value: "all", label: "All" }, { value: "unread", label: "Unread" }, { value: "needs", label: "Needs a decision" }];
const asView = (v: string): View => (VIEWS.some((x) => x.value === v) ? (v as View) : "all");

// Its own chunk: most people open a mention before they open a decision.
const InboxApproval = lazy(() => import("@/components/workspace/approval-card").then((m) => ({ default: m.InboxApproval })));

const WAITS: Record<string, string> = {
  agent_question: "This stays until the question is answered.",
  assigned: "This leaves when the task is finished or reassigned.",
};

export const InboxPage = () => <Inbox testId="inbox-page" />;
/** The old address. The bell's page is the inbox now. */
export const NotificationsRoute = () => <Inbox testId="notifications-page" />;

function Inbox({ testId }: { testId: string }) {
  const [q, setQ] = useUrlState({ view: "all", item: "", page: "1" });
  const view = asView(q.view);
  const page = Number(q.page) || 1;
  const space = useSpaceScope();
  const me = useMe();
  const spaces = useMySpaceIds();
  const list = useEntityQuery("notification", [{ view, space, page }], () => baseApi.notifications({ view, space_id: space, page }));
  const unread = useUnreadCount();
  const { one, clear, all } = useMarkRead();
  const navigate = useNavigate();

  const items = useMemo(() => visibleItems(list.data?.items ?? []), [list.data]);
  const records = useMemo(() => new Map((list.data?.records ?? []).map((r) => [`${r.type}:${r.id}`, r as RecordView])), [list.data]);
  const recordOf = (n: Notification) => records.get(`${n.entity}:${n.entity_id}`);
  const selectedId = Number(q.item) || null;
  const held = useRef<Notification | null>(null);
  const selected = heldLine(items, selectedId, held.current);
  held.current = selected;

  // A demo signs in to ?item=first: whatever waits for a decision opens at once, so the agent's request is the first thing in view.
  const wantsFirst = q.item === "first";
  useEffect(() => {
    if (!wantsFirst || !list.data) return;
    const first = items.find((n) => n.needs_action) ?? items[0];
    setQ({ item: first ? String(first.id) : "", page: String(page) });
  }, [wantsFirst, list.data, items, setQ, page]);

  const rows = useRef<HTMLUListElement>(null);
  // Opening is what reads a line. One opened by address reads too, so a link from elsewhere leaves nothing behind.
  const opened = useRef(0);
  useEffect(() => {
    if (!selected || opened.current === selected.id) return;
    opened.current = selected.id;
    if (!selected.read_at) void one(selected);
  }, [selected, one]);

  // The URL catches up after a render, and a held j repeats faster than that, so each step starts from the last step.
  const current = useRef(selectedId);
  current.current = selectedId;
  const select = useCallback((id: number | null) => {
    current.current = id;
    setQ({ item: id === null ? "" : String(id), page: String(page) });
    if (id !== null) rows.current?.querySelector(`[data-item="${id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [setQ, page]);
  const step = (by: 1 | -1) => {
    const at = items.findIndex((n) => n.id === current.current);
    const next = items[at < 0 ? (by > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, at + by))];
    if (next) select(next.id);
  };
  const clearSelected = () => {
    if (!selected?.clearable) return;
    select(neighbour(items, selected.id));
    void clear(selected);
  };
  const openSelected = () => { if (selected?.link && recordOpens(recordOf(selected))) navigate(selected.link); };

  const anySelected = !!selected;
  const commands: Command[] = [
    { id: "list.next", ...CATALOG["list.next"], run: () => step(1) },
    { id: "list.previous", ...CATALOG["list.previous"], run: () => step(-1) },
    { id: "list.close", ...CATALOG["list.close"], when: () => anySelected, run: () => select(null) },
    { id: "list.open", ...CATALOG["list.open"], when: () => anySelected && enterOpens(document.activeElement), run: openSelected },
    { id: "inbox.clear", ...CATALOG["inbox.clear"], group: "Inbox", icon: Check, when: () => !!selected?.clearable, run: clearSelected },
    { id: "inbox.read-all", ...CATALOG["inbox.read-all"], group: "Inbox", icon: CheckCheck, when: () => unread.count > 0, run: () => void all() },
  ];
  useCommands(commands, "inbox");

  const empty = list.data ? emptyState({
    ever: list.data.ever ?? 0, open: list.data.open ?? 0, shown: items.length, filtered: view !== "all" || space !== null,
    guestWithoutSpaces: isGuest(me) && !spaces.length,
  }) : null;
  const groups = sections(items);
  const pageTotal = list.data?.pageTotal ?? 0;

  return (
    <div data-testid={testId} className="flex h-full min-h-0 flex-col">
      <p className="sr-only" aria-live="polite">{unread.count ? `${unread.count} unread` : "Nothing unread"}</p>
      <SplitView listLabel="Inbox" open={!!selectedId} onBack={() => select(null)} backLabel="Inbox" className="md:grid-cols-[minmax(20rem,30rem)_minmax(0,1fr)]"
        list={
          <div className="flex min-h-full flex-col">
            <div className="sticky top-0 z-10 flex h-11 items-center justify-between gap-3 border-b bg-background px-3 max-md:h-auto max-md:py-1.5">
              <h1 className="shrink-0 text-title">Inbox</h1>
              <div className="kit-scroll-x mr-auto flex min-w-0"><Segmented size="sm" value={view} onChange={(v) => setQ({ view: v, page: "1", item: "" })} options={VIEWS} label="Show" className="max-md:[&_button]:min-h-11" /></div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Mark all read" disabled={!unread.count} onClick={() => void all()} className="shrink-0 max-sm:size-11"><CheckCheck /></Button>
                </TooltipTrigger>
                <TooltipContent className="flex items-center gap-2">Mark all read<KeyHint shortcut={CATALOG["inbox.read-all"].shortcut} /></TooltipContent>
              </Tooltip>
            </div>
            {list.error && !list.data ? <LoadError error={list.error} onRetry={() => void list.refetch()} className="m-3" />
              : !list.data ? <Loading />
              : empty ? <Empty kind={empty} onClear={() => setQ({ view: "all", page: "1", item: "" })} scoped={space !== null} />
              : (
                <ul ref={rows} className="flex-1">
                  {groups.map((g) => (
                    <li key={g.label || "all"}>
                      {g.label && <h2 className="px-3 pt-3 pb-1 text-caption text-muted-foreground">{g.label}</h2>}
                      <ul>{g.items.map((n) => <Line key={n.id} n={n} record={recordOf(n)} selected={n.id === selectedId} onSelect={() => select(n.id)} />)}</ul>
                    </li>
                  ))}
                </ul>
              )}
            {pageTotal > 1 && <div className="border-t px-3 py-2"><Pager page={list.data?.curPage ?? 1} pageTotal={pageTotal} onPage={(p) => setQ({ page: String(p), item: "" })} /></div>}
            {items.length > 0 && <KeyBar />}
          </div>
        }
        detail={selected ? <Detail n={selected} record={recordOf(selected)} onOpen={openSelected} onClear={clearSelected} />
          : selectedId && list.data ? <CantOpen />
          : <Nothing />} />
    </div>
  );
}

/** A line can be opened unless what it's about is gone or out of reach. A line with no record just has its address. */
const recordOpens = (r: RecordView | undefined) => !r || r.state === "live" || r.state === "archived";

function Line({ n, record, selected, onSelect }: { n: Notification; record?: RecordView; selected: boolean; onSelect: () => void }) {
  const unread = !n.read_at;
  return (
    <li>
      <button type="button" onClick={onSelect} data-kit="notification" data-item={n.id} data-unread={unread || undefined} aria-current={selected || undefined}
        className={cn("focus-ring-inset flex min-h-11 w-full min-w-0 items-center gap-2.5 px-3 py-1.5 text-left", selected ? "bg-muted" : "hover:bg-muted/50")}>
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", unread ? "bg-foreground" : "bg-transparent")} />
        <ActorFace n={n} />
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-body", unread ? "font-medium" : !n.needs_action && "text-muted-foreground")} title={n.title}>{n.title}</span>
          {record && <span className="mt-0.5 flex min-w-0"><LinkChip view={record} className="pointer-events-none" /></span>}
        </span>
        {n.actor_kind === "agent" && <AgentMark />}
        {n.group_count > 1 && <span className="shrink-0 rounded-sm bg-muted px-1 text-micro text-muted-foreground tabular-nums" title={`${n.group_count} items`}>{n.group_count}</span>}
        <Ago value={n.created_at} className="shrink-0 text-caption text-muted-foreground tabular-nums" />
        {unread && <span className="sr-only">Unread</span>}
      </button>
    </li>
  );
}

function Detail({ n, record, onOpen, onClear }: { n: Notification; record?: RecordView; onOpen: () => void; onClear: () => void }) {
  const opens = recordOpens(record);
  const wait = WAITS[n.kind];
  return (
    <article className="mx-auto flex max-w-2xl flex-col gap-5 p-4 sm:p-6" data-testid="inbox-detail">
      {n.entity !== "approval" && <header className="flex items-start gap-3">
        <ActorFace n={n} size="md" />
        <div className="min-w-0 flex-1">
          <h2 className="text-title text-pretty wrap-anywhere">{n.title}</h2>
          <p className="mt-0.5 text-caption text-muted-foreground"><Ago value={n.created_at} />{n.group_count > 1 && ` · ${n.group_count} items`}</p>
        </div>
      </header>}
      {n.body && <p className="text-body text-pretty">{n.body}</p>}
      {n.entity === "approval" && <Suspense fallback={<Skeleton className="h-40 w-full rounded-lg" />}><InboxApproval id={n.entity_id} /></Suspense>}
      {record && <div><LinkChip view={record} /></div>}
      {!opens && <p className="text-body text-muted-foreground">This can't be opened. It may have been deleted, or you may not have access.</p>}
      <div className="flex flex-wrap items-center gap-2">
        {n.link && opens && <Button size="sm" variant={n.kind === "approval" ? "outline" : "default"} onClick={onOpen}>{n.kind === "approval" ? "See it in context" : "Open"}<CornerDownLeft /></Button>}
        {n.clearable && <Button size="sm" variant="outline" onClick={onClear}><Check />Clear<KeyHint shortcut={CATALOG["inbox.clear"].shortcut} /></Button>}
        {wait && <span className="text-caption text-muted-foreground">{wait}</span>}
      </div>
      {record && opens && n.entity && <LinksPanel type={n.entity} id={n.entity_id} />}
    </article>
  );
}

function Nothing() {
  return (
    <div className="hidden h-full place-items-center p-6 md:grid">
      <div className="flex flex-col items-center gap-2 text-center text-body text-muted-foreground">
        <p>Choose an item to read it here.</p>
        <p className="flex items-center gap-1.5 text-caption"><KeyHint shortcut={CATALOG["list.next"].shortcut} /><KeyHint shortcut={CATALOG["list.previous"].shortcut} />to move</p>
      </div>
    </div>
  );
}

/** Missing and forbidden read the same, so this can't confirm that something exists. */
function CantOpen() {
  return (
    <div className="p-6" data-testid="inbox-cant-open">
      <EmptyState icon={SearchX} className="border-0" title="This can't be opened" description="It may have been deleted, or you may not have access."
        action={<Button asChild size="sm" variant="outline"><Link to="/inbox">Back to the inbox</Link></Button>} />
    </div>
  );
}

const EMPTY: Record<EmptyKind, { icon: LucideIcon; title: string; description: string }> = {
  never: { icon: InboxIcon, title: "Nothing here yet", description: "Mentions, messages, tasks and what your agents need from you will arrive here." },
  done: { icon: Check, title: "All done", description: "You've cleared everything. New items will show up here." },
  "no-match": { icon: ListFilter, title: "Nothing matches", description: "There's more in your inbox outside this filter." },
  "no-space": { icon: Layers, title: "You're not in a space yet", description: "Ask whoever invited you to add you to one. What's meant for you will show up here." },
};

function Empty({ kind, onClear, scoped }: { kind: EmptyKind; onClear: () => void; scoped: boolean }) {
  const e = EMPTY[kind];
  return (
    <div className="flex flex-1 items-center p-3" data-testid={`inbox-empty-${kind}`}>
      <EmptyState icon={e.icon} title={e.title} description={e.description} className="border-0"
        action={kind === "no-match" ? (scoped ? <Button asChild size="sm" variant="outline"><Link to="/inbox">Show all spaces</Link></Button> : <Button size="sm" variant="outline" onClick={onClear}>Show everything</Button>) : undefined} />
    </div>
  );
}

function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading your inbox" className="flex-1">
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <div key={`skeleton-${i}`} className="flex h-11 items-center gap-2.5 px-3">
          <span className="size-1.5 shrink-0" />
          <Skeleton className="size-6 shrink-0 rounded-full" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3 w-10 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** The keys, where they're needed. A phone has none, so it goes there. */
function KeyBar() {
  const key = (id: "list.next" | "list.open" | "inbox.clear") => <KeyHint shortcut={CATALOG[id].shortcut} />;
  return (
    <div className="sticky bottom-0 mt-auto hidden items-center gap-3 border-t bg-background px-3 py-1.5 text-caption text-muted-foreground md:flex">
      <span className="flex items-center gap-1">{key("list.next")}<KeyHint shortcut={CATALOG["list.previous"].shortcut} />move</span>
      <span className="flex items-center gap-1">{key("list.open")}open</span>
      <span className="flex items-center gap-1">{key("inbox.clear")}clear</span>
    </div>
  );
}
