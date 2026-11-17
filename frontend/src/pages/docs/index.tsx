// /docs: the docs this person reaches, newest work first, narrowed by the space chosen in the sidebar. Every way the page can be
// empty says which way it is. No editor loads here: Tiptap comes with a doc.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Archive, Bot, FileText, Layers, Lock, MessageSquare, Plus, RotateCcw, SearchX, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Person } from "@/components/workspace/person";
import { Ago, DataList, EmptyState, KeyHint, LoadError, SearchInput, Segmented, useUrlState, type Column } from "@/components/kit";
import { useChannel } from "@/base/live";
import { PresenceAvatars } from "@/base/presence";
import { isGuest, useMe } from "@/base/session";
import { CATALOG, useCommands, type Command } from "@/lib/commands";
import { useSpaceScope } from "@/lib/data";
import { docsApi, type DocListItem } from "@/lib/docs/api";
import { useDocList } from "@/lib/docs/client";
import { bySpace, listState } from "@/lib/docs/model";
import { useTaskSetup } from "@/lib/tasks/client";
import { shellToast } from "@/lib/toast";

const DEFAULTS = { q: "", view: "docs" };
const statusOf = (e: unknown) => (e as { status?: number } | null)?.status;
const Wrap = ({ id, children }: { id: string; children: React.ReactNode }) => <div data-testid={id} className="flex min-h-0 flex-1 items-center justify-center p-4">{children}</div>;

/** Waiting for someone to look. Only people who can act on a suggestion are told. */
const Waiting = () => <span data-testid="doc-row-suggestion" title="An agent's suggestion is waiting" className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-agent-wash px-1 text-micro font-medium text-agent-text"><Bot aria-hidden className="size-3" />Suggestion</span>;

/** How much talk a doc has, from its own thread. Nothing at all when there's none, so the column stays quiet. */
const Comments = ({ n }: { n: number }) => (n > 0
  ? <span className="inline-flex items-center gap-1 text-muted-foreground tabular-nums" title={`${n} ${n === 1 ? "comment" : "comments"}`}><MessageSquare aria-hidden className="size-3.5" />{n}<span className="sr-only"> {n === 1 ? "comment" : "comments"}</span></span>
  : null);

const edited = (d: DocListItem) => <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">{d.editor_name && <Person name={d.editor_name} kind={d.editor_kind} className="shrink" />}<Ago value={d.updated_at} className="shrink-0" /></span>;

export function DocsPage() {
  const me = useMe()!;
  const space = useSpaceScope();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [url, setUrl] = useUrlState(DEFAULTS);
  const trash = url.view === "trash";
  const [page, setPage] = useState(1);
  const list = useDocList({ ...(space ? { space_id: space } : {}), ...(url.q ? { q: url.q } : {}), ...(trash ? { trash: true } : {}), page });
  const setup = useTaskSetup();
  useChannel(space ? `spaces/${space}` : null);
  useEffect(() => setPage(1), [space, url.q, url.view]);

  const spaces = setup.data?.spaces ?? [];
  const writable = spaces.filter((s) => s.can_create && (!space || s.id === space));
  const here = spaces.find((s) => s.id === space);
  const rows = list.data?.items ?? [];
  const failed = list.error ?? setup.error;
  const state = listState({ loaded: !!list.data && !!setup.data, error: failed, denied: statusOf(list.error) === 404, spaces: spaces.length, ever: list.data?.ever ?? 0, shown: rows.length, filtered: !!url.q, trash });

  const [starting, setStarting] = useState(false);
  const busy = useRef(false);
  const start = async (id: number) => {
    if (busy.current) return;
    busy.current = true;
    setStarting(true);
    try {
      const doc = await docsApi.create(id);
      navigate(`/docs/${doc.id}`);
    } catch (e) {
      shellToast.error(`Couldn't start a doc. ${e instanceof Error ? e.message : "Try again."}`);
    } finally {
      busy.current = false;
      setStarting(false);
    }
  };
  const canAdd = writable.length > 0;
  const [choosing, setChoosing] = useState(false);
  const newDoc = () => { if (writable.length === 1) void start(writable[0].id); else if (canAdd) setChoosing(true); };

  // ⌘K's New doc lands here from any screen.
  useEffect(() => {
    if (params.get("new") !== "1" || !setup.data) return;
    setParams((p) => { p.delete("new"); return p; }, { replace: true });
    newDoc();
  }, [params, setup.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // "n" means new on every screen, so docs take the same row of the table.
  const commands: Command[] = [{ id: "tasks.new", ...CATALOG["tasks.new"], label: "New doc", group: "Docs", icon: Plus, when: () => canAdd, run: newDoc }];
  useCommands(commands, "docs");

  const restore = async (d: DocListItem) => {
    try {
      await docsApi.restore(d.id);
      shellToast.show(`Brought back ${d.title}`);
      void list.refetch();
    } catch (e) { shellToast.error(`Couldn't bring that back. ${e instanceof Error ? e.message : "Try again."}`); }
  };

  // Everything in reach, as it is: grouped by space, the space with the newest work first. A search or the trash stays one list.
  const grouped = !space && !trash && !url.q;
  const shownRows = useMemo(() => (grouped ? bySpace(rows) : rows), [grouped, rows]);
  const columns: Column<DocListItem>[] = [
    // The title, a waiting suggestion, then as much of the opening line as fits, and the comment count at the end only when there is one.
    { id: "title", header: "Doc", primary: true, title: (d) => d.title, cell: (d) => <span className="flex min-w-0 items-center gap-2"><span className="max-w-[60%] shrink-0 truncate font-medium">{d.title}</span>{d.suggestions && <Waiting />}<span className="min-w-0 flex-1 truncate font-normal text-muted-foreground max-lg:hidden">{d.excerpt}</span>{!trash && d.comments > 0 && <span className="ml-auto shrink-0 pl-2"><Comments n={d.comments} /></span>}</span> },
    ...(space || grouped ? [] : [{ id: "space", header: "Space", className: "w-44", cell: (d: DocListItem) => <span className="truncate text-muted-foreground">{d.space_name}</span> }]),
    ...(trash ? [] : [{ id: "editor", header: "Last edited by", className: "w-44", hideBelow: "xl" as const, cell: (d: DocListItem) => <span className="flex min-w-0 text-muted-foreground">{d.editor_name ? <Person name={d.editor_name} kind={d.editor_kind} className="shrink" /> : "—"}</span> }]),
    { id: "edited", header: trash ? "Deleted" : "Edited", className: "w-32", cell: (d) => <span className="truncate text-muted-foreground"><Ago value={trash ? d.deleted_at : d.updated_at} /></span> },
  ];
  const mobileRow = (d: DocListItem) => (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2"><span className="truncate text-body font-medium">{d.title}</span>{d.suggestions && <Waiting />}</span>
      {d.excerpt && <span className="line-clamp-1 text-caption text-muted-foreground">{d.excerpt}</span>}
      <span className="flex min-w-0 items-center gap-1 text-caption text-muted-foreground">{!grouped && <><span className="truncate">{d.space_name}</span><span aria-hidden>·</span></>}<span className="min-w-0">{edited(d)}</span>{d.comments > 0 && <><span aria-hidden>·</span><Comments n={d.comments} /></>}</span>
    </span>
  );

  const addButton = (label: string, testId: string) => {
    const face = <><Plus /><span className={testId === "new-doc-button" ? "max-md:sr-only" : undefined}>{label}</span>{testId === "new-doc-button" && <KeyHint shortcut={CATALOG["tasks.new"].shortcut} className="max-md:hidden" />}</>;
    const size = testId === "new-doc-button" ? "max-md:size-11 max-md:px-0" : "max-md:min-h-11";
    if (writable.length < 2) return <Button size="sm" disabled={starting} onClick={newDoc} data-testid={testId} className={size}>{face}</Button>;
    return (
      <DropdownMenu open={choosing} onOpenChange={setChoosing}>
        <DropdownMenuTrigger asChild><Button size="sm" disabled={starting} data-testid={testId} className={size}>{face}</Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-caption text-muted-foreground">Which space is it for?</DropdownMenuLabel>
          {writable.map((s) => <DropdownMenuItem key={s.id} data-testid="new-doc-space" onSelect={() => void start(s.id)} className="max-md:min-h-11"><Layers />{s.name}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const reachable = state !== "no-space" && state !== "no-access";
  return (
    <section aria-label="Docs" data-testid="docs-page" className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5">
        <h1 className="min-w-0 truncate text-title max-md:flex-1">Docs{here && <span className="font-normal text-muted-foreground"> in {here.name}</span>}</h1>
        {space && <PresenceAvatars room={`space-${space}`} />}
        {reachable && <SearchInput value={url.q} onChange={(v) => setUrl({ q: v })} placeholder="Search docs" className="w-52 max-md:order-last max-md:w-full max-md:basis-full [&_input]:max-sm:h-11" />}
        <div className="ml-auto flex items-center gap-2">
          {reachable && <Segmented size="sm" label="Show" value={trash ? "trash" : "docs"} onChange={(v) => setUrl({ view: v })} options={[{ value: "docs", label: "Docs" }, { value: "trash", label: "Trash" }]} className="max-md:[&_button]:min-h-11" />}
          {canAdd && !trash && addButton("New doc", "new-doc-button")}
        </div>
      </header>
      {here && !here.can_create && !trash && <p role="status" data-testid="docs-read-only" className="flex shrink-0 items-center gap-2 border-b bg-muted/50 px-4 py-1.5 text-caption text-muted-foreground">{isGuest(me) ? <><Lock aria-hidden className="size-3.5 shrink-0" />You can read this space's docs. Its managers decide if guests can add one.</> : <><Archive aria-hidden className="size-3.5 shrink-0" />This space is archived, so its docs stay as they are.</>}</p>}
      {state === "loading" && <div aria-busy="true" aria-label="Loading docs" data-testid="docs-loading" className="space-y-2 p-3">{["w-3/5", "w-2/5", "w-1/2", "w-3/4", "w-1/3"].map((w) => <Skeleton key={w} className={`h-6 ${w}`} />)}</div>}
      {state === "failed" && <Wrap id="docs-failed"><LoadError title="Your docs didn't load" error={failed} onRetry={() => { void list.refetch(); void setup.refetch(); }} /></Wrap>}
      {state === "no-access" && <Wrap id="docs-no-access"><EmptyState icon={Lock} className="border-0" title="This space can't be opened" description="It may not exist, or you may not have access to it." action={<Button asChild size="sm" variant="outline" className="max-md:min-h-11"><Link to="/docs">All docs</Link></Button>} /></Wrap>}
      {state === "no-space" && <Wrap id="docs-no-space"><EmptyState icon={Layers} className="border-0" title={isGuest(me) ? "You're not in a space yet" : "Docs live in spaces"} description={isGuest(me) ? "Ask whoever invited you to add you to one." : "Join a space or start one, and its docs will show here."} /></Wrap>}
      {state === "never" && <Wrap id="docs-never"><EmptyState icon={FileText} className="border-0" title="No docs yet" description={canAdd ? "Write down what the team should know: a brief, a runbook, a decision. Agents can read it and suggest changes." : here ? "Nothing here yet. Docs appear once a member starts one." : "Nothing here yet."} action={canAdd ? addButton("Start a doc", "first-doc-button") : undefined} /></Wrap>}
      {state === "no-match" && <Wrap id="docs-no-match"><EmptyState icon={SearchX} className="border-0" title={`No ${trash ? "deleted docs" : "docs"} match that`} description="Check the spelling, or search for something else." action={<Button size="sm" variant="outline" onClick={() => setUrl({ q: "" })} data-testid="docs-clear-search" className="max-md:min-h-11">Clear search</Button>} /></Wrap>}
      {state === "trash-empty" && <Wrap id="docs-trash-empty"><EmptyState icon={Trash2} className="border-0" title="The trash is empty" description="A deleted doc stays here for 30 days." /></Wrap>}
      {state === "ready" && (
        <DataList<DocListItem> flush label="Docs" rows={shownRows} columns={columns} {...(grouped ? { group: (d: DocListItem) => d.space_name } : {})} rowKey={(d) => d.id} mobileRow={mobileRow} empty={null} busy={list.isFetching && !list.isPending && list.isPlaceholderData} pageSize={30} className="min-h-0 flex-1 overflow-y-auto"
          {...(trash ? {} : { rowHref: (d: DocListItem) => `/docs/${d.id}` })}
          rowActions={trash ? (d) => <Button size="xs" variant="outline" data-testid="doc-restore" onClick={() => void restore(d)} className="max-md:min-h-11"><RotateCcw />Restore</Button> : undefined}
          footer={list.data?.next_page ? <div className="px-3 py-2"><Button variant="ghost" size="sm" onClick={() => setPage(list.data!.next_page!)} data-testid="docs-more" className="text-muted-foreground max-md:min-h-11">Next page</Button></div> : undefined} />
      )}
    </section>
  );
}
