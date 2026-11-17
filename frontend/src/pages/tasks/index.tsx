// /tasks: one scope's tasks as a list or a board, narrowed by filters that live in the URL. Everything here runs from the
// keyboard through the command registry, and every change shows at once and rolls back by name.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useMatch, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Bookmark, CheckCheck, CircleCheck, Columns3, FolderPlus, Layers, List, ListFilter, Lock, Plus, SearchX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, FilterSelect, KeyHint, LoadError, SearchInput, Segmented, useUrlState } from "@/components/kit";
import { useChannel } from "@/base/live";
import { PresenceAvatars } from "@/base/presence";
import { isGuest, useMe } from "@/base/session";
import { useWorkspace } from "@/base/workspace";
import { useIsMobile } from "@/hooks/use-mobile";
import { tasksApi as api, type TaskView } from "@/lib/tasks/api";
import { CATALOG, useCommands, type Command } from "@/lib/commands";
import { useSpaceScope } from "@/lib/data";
import { shellToast } from "@/lib/toast";
import { prefetchTask, useTaskActions, useTaskPage, useTaskSetup, type NewTask, type SavedView } from "@/lib/tasks/client";
import { BOARD_STATUSES, DUE_LABELS, LIST_ORDER, isOpen, EMPTY_FILTERS, PRIORITIES, PRIORITY_LABELS, STATUSES, STATUS_LABELS, activeFilters, filtersFromQuery, listGroups, projectsIn, queryOf, screenState, toRequest, type TaskStatus } from "@/lib/tasks/model";
import { columnOf, moveAcross, moveWithin, neighbour, step, type Direction } from "@/lib/tasks/order";
import { cn } from "@/lib/utils";
import { NewProjectDialog, NewTaskDialog, SaveViewDialog, type TaskDraft } from "./dialogs";
import { StatusIcon } from "./marks";
import { TaskBoard } from "./task-board";
import { TaskList } from "./task-list";
import { TaskMenu, useTaskMenu, type MenuKind } from "./task-menu";

const A_PAGE = 100;
const MOST_AT_ONCE = 500;
const statusOf = (e: unknown) => (e as { status?: number } | null)?.status;
const DEFAULTS = { ...EMPTY_FILTERS, view: "list", finished: "" };
const FILTER_WIDTH = "w-36 shrink-0 sm:w-36 [&_[data-slot=select-trigger]]:max-sm:!h-11 [&_button[role=combobox]]:max-sm:!h-11";

function Loading({ board }: { board: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading tasks" data-testid="tasks-loading" className={cn("min-h-0 flex-1 p-3", board ? "flex gap-3 overflow-hidden" : "space-y-2")}>
      {board ? [0, 1, 2, 3].map((i) => <Skeleton key={`skeleton-${i}`} className="h-64 w-64 shrink-0 rounded-lg" />) : ["w-3/5", "w-2/5", "w-1/2", "w-3/4", "w-1/3", "w-2/3"].map((w) => <Skeleton key={w} className={cn("h-6", w)} />)}
    </div>
  );
}

const Wrap = ({ id, children }: { id: string; children: React.ReactNode }) => <div data-testid={id} className="flex min-h-0 flex-1 items-center justify-center p-4">{children}</div>;

export function TasksPage() {
  const me = useMe()!;
  const { people } = useWorkspace();
  const space = useSpaceScope();
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useUrlState(DEFAULTS);
  const filters = useMemo(() => filtersFromQuery(q), [q]);
  const board = q.view === "board";
  const finished = q.finished === "1";
  const [limit, setLimit] = useState(A_PAGE);
  const request = useMemo(() => toRequest(filters, { space, me: me.id, limit }, new Date()), [filters, space, me.id, limit]);
  const page = useTaskPage(request);
  const setup = useTaskSetup();
  const actions = useTaskActions();
  const menu = useTaskMenu();
  useChannel(space ? `spaces/${space}` : null);

  const rows = useMemo(() => (page.data?.items ?? []).filter((t) => !t.deleted_at), [page.data]);
  const totals = page.data?.totals ?? {};
  const statuses = useMemo(() => (filters.status ? BOARD_STATUSES.filter((s) => s === filters.status) : BOARD_STATUSES), [filters.status]);
  const order = useMemo(() => (board ? statuses.flatMap((s) => columnOf(rows, s)) : listGroups(rows, finished || !!filters.status).flatMap((g) => g.items)).map((t) => t.id), [board, statuses, rows, finished, filters.status]);

  const spaces = setup.data?.spaces ?? [];
  // Only this space's projects count here: a space with none of its own asks for one, whatever other spaces hold.
  const projects = projectsIn(setup.data?.projects ?? [], space);
  const here = spaces.find((s) => s.id === space);
  const archived = !!page.data?.archived;
  const canEdit = useCallback((t: TaskView) => !!spaces.find((s) => s.id === t.space_id)?.can_create, [spaces]);
  const writable = projects.filter((p) => spaces.find((s) => s.id === p.space_id)?.can_create);
  const canAdd = writable.length > 0 && !archived;
  const canStart = !isGuest(me) && !archived;

  const [selected, setSelected] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [newTask, setNewTask] = useState<Partial<TaskDraft> | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const task = rows.find((t) => t.id === selected);

  // A task that left the view hands selection to its neighbour, so the keyboard stays where it was.
  const lastOrder = useRef<number[]>([]);
  useEffect(() => {
    if (selected !== null && !order.includes(selected)) setSelected(neighbour(lastOrder.current, selected));
    lastOrder.current = order;
  }, [order, selected]);

  // ⌘K's New task lands here from any screen.
  useEffect(() => {
    if (params.get("new") !== "1" || !setup.data) return;
    const title = params.get("title") ?? "";
    setParams((p) => { p.delete("new"); p.delete("title"); return p; }, { replace: true });
    if (canAdd) start(title ? { title } : {});
    else setNewProject(canStart);
  }, [params, setup.data, canAdd, canStart, setParams]);

  // A task starts where the person is looking, so it can't land out of view.
  const startingProject = filters.project || (space && writable[0] ? String(writable[0].id) : "");
  const start = (draft: Partial<TaskDraft> = {}) => setNewTask({ ...(startingProject ? { project: startingProject } : {}), ...draft });
  const create = (t: NewTask, draft: TaskDraft) => {
    setNewTask(null);
    void actions.create(t, rows).then((ended) => { if (ended === "failed") setNewTask(draft); });
  };
  // A task opens over the list, which stays as it was behind it. Only a pointer slides it in: a key opens it at once.
  const { search } = useLocation();
  const sheet = useMatch("/tasks/:id");
  // The list stays mounted under a task, so coming back to it reads it again, as a fresh visit would.
  const hadSheet = useRef(false);
  useEffect(() => {
    if (hadSheet.current && !sheet) void page.refetch();
    hadSheet.current = !!sheet;
  }, [sheet]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = useCallback((t: TaskView, by: "pointer" | "keyboard" = "pointer") => { if (t.id > 0) navigate(`/tasks/${t.id}${search}`, { state: { opened: by } }); }, [navigate, search]);
  const menuFor = useCallback((kind: MenuKind, t: TaskView, el: HTMLElement) => menu.open(kind, t, el), [menu.open]); // eslint-disable-line react-hooks/exhaustive-deps
  const client = useQueryClient();
  // A press selects the row and starts reading the task, so the sheet the click opens has its content ready.
  const pick = useCallback((id: number) => { setKeyboard(false); setSelected(id); prefetchTask(client, id); }, [client]);
  // The sheet's code arrives with the list, so the first open doesn't wait on it.
  useEffect(() => { void import("./detail"); }, []);
  const anchorOf = (t: TaskView, kind: MenuKind) => document.querySelector<HTMLElement>(`[data-task-row="${t.id}"] [data-menu="${kind}"]`) ?? document.querySelector<HTMLElement>(`[data-kanban-card="${t.id}"]`) ?? document.querySelector<HTMLElement>(`[data-task-row="${t.id}"]`);

  const walk = (direction: Direction) => {
    setKeyboard(true);
    if (board) { setSelected(step(rows.filter((r) => statuses.includes(r.status as TaskStatus)), statuses, selected, direction)); return; }
    const at = selected === null ? -1 : order.indexOf(selected);
    setSelected(order[Math.min(order.length - 1, Math.max(0, at + (direction === "down" ? 1 : -1)))] ?? null);
  };
  const editing = () => !!task && task.id > 0 && canEdit(task);
  const nudge = (m: ReturnType<typeof moveWithin> | undefined) => { if (m && task) void actions.move(task, m); };
  const property = (kind: MenuKind) => () => { if (task) menu.open(kind, task, anchorOf(task, kind)); };
  const commands: Command[] = [
    { id: "list.next", ...CATALOG["list.next"], run: () => walk("down") },
    { id: "list.previous", ...CATALOG["list.previous"], run: () => walk("up") },
    { id: "list.next-arrow", ...CATALOG["list.next-arrow"], run: () => walk("down") },
    { id: "list.previous-arrow", ...CATALOG["list.previous-arrow"], run: () => walk("up") },
    { id: "list.open", ...CATALOG["list.open"], when: () => !!task && task.id > 0, run: () => task && open(task, "keyboard") },
    { id: "list.close", ...CATALOG["list.close"], when: () => selected !== null, run: () => setSelected(null) },
    { id: "tasks.new", ...CATALOG["tasks.new"], group: "Tasks", icon: Plus, when: () => canAdd, run: () => start() },
    { id: "tasks.toggle-view", ...CATALOG["tasks.toggle-view"], group: "Tasks", icon: Columns3, run: () => setQ({ view: board ? "list" : "board" }) },
    { id: "tasks.status", ...CATALOG["tasks.status"], group: "Tasks", when: editing, run: property("status") },
    { id: "tasks.priority", ...CATALOG["tasks.priority"], group: "Tasks", when: editing, run: property("priority") },
    { id: "tasks.assign", ...CATALOG["tasks.assign"], group: "Tasks", when: editing, run: property("assignee") },
    { id: "tasks.assign-me", ...CATALOG["tasks.assign-me"], group: "Tasks", when: editing, run: () => task && actions.assign(task, { id: me.id, name: me.name, kind: "human" }) },
    { id: "tasks.due", ...CATALOG["tasks.due"], group: "Tasks", when: editing, run: property("due") },
    { id: "tasks.delete", ...CATALOG["tasks.delete"], group: "Tasks", when: editing, run: () => task && void actions.remove(task) },
    { id: "tasks.move-up", ...CATALOG["tasks.move-up"], when: editing, run: () => nudge(task && moveWithin(rows, task.id, -1)) },
    { id: "tasks.move-down", ...CATALOG["tasks.move-down"], when: editing, run: () => nudge(task && moveWithin(rows, task.id, 1)) },
    { id: "tasks.move-left", ...CATALOG["tasks.move-left"], when: () => board && editing(), run: () => nudge(task && moveAcross(rows, task.id, -1, statuses)) },
    { id: "tasks.move-right", ...CATALOG["tasks.move-right"], when: () => board && editing(), run: () => nudge(task && moveAcross(rows, task.id, 1, statuses)) },
    { id: "tasks.column-left", ...CATALOG["tasks.column-left"], when: () => board, run: () => walk("left") },
    { id: "tasks.column-right", ...CATALOG["tasks.column-right"], when: () => board, run: () => walk("right") },
    ...(setup.data?.views ?? []).map((v): Command => ({ id: `tasks.view.${v.id}`, label: `Show ${v.name}`, scope: "screen", group: "Saved filters", icon: Bookmark, run: () => apply(v) })),
  ];
  // With a task open over the list, its keys are the task's: the list's step aside until it closes.
  useCommands(sheet ? [] : commands, `tasks-${sheet ? "sheet" : "list"}-${(setup.data?.views ?? []).map((v) => v.id).join()}`);

  const filtered = activeFilters(filters) > 0;
  const shown = rows.length;
  const state = screenState({ error: page.error ?? setup.error, loaded: !!page.data && !!setup.data, denied: statusOf(page.error) === 404, spaces: spaces.length, projects: projects.length, ever: page.data?.ever ?? 0, open: page.data?.open ?? 0, shown, filtered, archived });

  const clear = () => setQ({ q: "", status: "", priority: "", assignee: "", project: "", due: "" });
  const apply = (v: SavedView) => {
    const query = (v.query ?? {}) as Record<string, string>;
    const next = new URLSearchParams(queryOf(filtersFromQuery(query)) as Record<string, string>);
    if (query.view === "board") next.set("view", "board");
    if (query.space) next.set("space", query.space);
    navigate(`/tasks?${next}`);
  };
  const saved = (v: SavedView) => {
    const query = (v.query ?? {}) as Record<string, string>;
    return JSON.stringify(queryOf(filtersFromQuery(query))) === JSON.stringify(queryOf(filters)) && (query.space ?? "") === String(space ?? "");
  };
  const remove = async (v: SavedView) => {
    try { await api.deleteView(v.id); void setup.refetch(); }
    catch (e) { shellToast.error(`Couldn't delete ${v.name}. ${e instanceof Error ? e.message : "Try again."}`); }
  };
  const save = async (name: string) => {
    await api.saveView(name, { ...queryOf(filters), view: q.view, ...(space ? { space: String(space) } : {}) });
    await setup.refetch();
    setSaving(false);
  };

  // All tasks, mine, and each saved filter, as one tab control. A filter of someone's own raises none of them.
  const views = setup.data?.views ?? [];
  const mine = filters.assignee === "me" && activeFilters(filters) === 1;
  const shownView = !filtered ? "all" : mine ? "mine" : (views.find(saved) ? `view-${views.find(saved)!.id}` : "");
  const viewOptions = [{ value: "all", label: "All tasks", testId: "view-pill" }, { value: "mine", label: "My tasks", testId: "view-pill" },
    ...views.map((v) => ({ value: `view-${v.id}`, label: v.name, testId: "view-pill", onRemove: () => void remove(v) }))];
  const pickView = (v: string) => {
    if (v === "all") clear();
    else if (v === "mine") setQ({ ...EMPTY_FILTERS, assignee: "me" });
    else { const view = views.find((x) => `view-${x.id}` === v); if (view) apply(view); }
  };
  const assignees = useMemo(() => [{ value: "me", label: "Me" }, { value: "none", label: "Nobody" }, ...people.filter((p) => p.id !== me.id).map((p) => ({ value: String(p.id), label: p.kind === "agent" ? `${p.name} (agent)` : p.name }))], [people, me.id]);
  const projectOptions = useMemo(() => projects.filter((p) => !space || p.space_id === space).map((p) => ({ value: String(p.id), label: p.name })), [projects, space]);
  const newButton = (label = "New task") => (
    <Button size="sm" onClick={() => start()} data-testid="new-task-button" className="max-md:min-h-11"><Plus />{label}<KeyHint shortcut={CATALOG["tasks.new"].shortcut} className="max-md:hidden" /></Button>
  );
  const headerNew = (
    <Button size="sm" onClick={() => start()} data-testid="new-task-button" className="max-md:size-11 max-md:px-0"><Plus /><span className="max-md:sr-only">New task</span><KeyHint shortcut={CATALOG["tasks.new"].shortcut} className="max-md:hidden" /></Button>
  );

  return (
    <section aria-label="Tasks" data-testid="tasks-page" className="relative flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5">
        <h1 className="min-w-0 truncate text-title max-md:flex-1">Tasks{page.data?.space_name && <span className="font-normal text-muted-foreground"> in {page.data.space_name}</span>}</h1>
        {space && <PresenceAvatars room={`space-${space}`} />}
        {state !== "no-space" && state !== "no-access" && (
          <nav aria-label="Saved filters" className="kit-scroll-x order-last flex min-w-0 items-center gap-1 max-md:basis-full md:order-none">
            <Segmented size="sm" label="Show" value={shownView} onChange={pickView} options={viewOptions} className="max-md:[&_button[role=radio]]:min-h-11" />
            {filtered && !(setup.data?.views ?? []).some(saved) && <Button variant="ghost" size="sm" onClick={() => setSaving(true)} data-testid="save-view-button" className="shrink-0 text-muted-foreground max-md:min-h-11"><Bookmark />Save filter</Button>}
            <Button variant="ghost" size="icon-sm" aria-label="Filters" aria-expanded={showFilters} data-testid="filters-toggle" onClick={() => setShowFilters((s) => !s)} className="ml-auto size-11 shrink-0 text-muted-foreground md:hidden"><ListFilter /></Button>
          </nav>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Segmented size="sm" label="View" value={board ? "board" : "list"} onChange={(v) => setQ({ view: v })} options={[{ value: "list", label: "List", icon: List, iconOnly: mobile }, { value: "board", label: "Board", icon: Columns3, iconOnly: mobile }]} className="max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11" />
          {canAdd && headerNew}
          {!canAdd && canStart && (state === "ready" || state === "no-match") && <Button size="sm" variant="outline" onClick={() => setNewProject(true)} className="max-md:min-h-11"><FolderPlus />New project</Button>}
        </div>
      </header>
      {state !== "no-space" && state !== "no-access" && (
        <div className={cn("shrink-0 border-b", !showFilters && !filtered && "max-md:hidden")}>
          <div className="kit-scroll-x flex items-center gap-2 px-3 py-1.5">
            <SearchInput value={filters.q} onChange={(v) => setQ({ q: v })} placeholder="Search tasks" className="w-44 shrink-0 flex-none [&_input]:max-sm:h-11" />
            <FilterSelect label="Status" allLabel="Any status" value={filters.status} onChange={(v) => setQ({ status: v })} options={STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} className={FILTER_WIDTH} />
            <FilterSelect label="Priority" allLabel="Any priority" value={filters.priority} onChange={(v) => setQ({ priority: v })} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} className={FILTER_WIDTH} />
            <FilterSelect label="Assignee" allLabel="Anyone" value={filters.assignee} onChange={(v) => setQ({ assignee: v })} options={assignees} className={FILTER_WIDTH} />
            <FilterSelect label="Project" allLabel="Any project" value={filters.project} onChange={(v) => setQ({ project: v })} options={projectOptions} className={FILTER_WIDTH} />
            <FilterSelect label="Due" allLabel="Any due date" value={filters.due} onChange={(v) => setQ({ due: v })} options={Object.entries(DUE_LABELS).map(([value, label]) => ({ value, label }))} className={FILTER_WIDTH} />
            {filtered && <Button variant="ghost" size="sm" onClick={clear} data-testid="clear-filters" className="shrink-0 text-muted-foreground max-md:min-h-11">Clear</Button>}
          </div>
        </div>
      )}
      {mobile && !board && (state === "ready" || state === "no-match") && (
        <StatusChips value={filters.status} totals={totals} onChange={(v) => setQ({ status: v, finished: v === "done" || v === "cancelled" ? "1" : "" })} />
      )}
      {archived && <p role="status" data-testid="tasks-archived" className="flex shrink-0 items-center gap-2 border-b bg-muted/50 px-4 py-1.5 text-caption text-muted-foreground"><Archive aria-hidden className="size-3.5" />This space is archived. You can read its tasks, and nobody can change them.</p>}
      {!archived && here && !here.can_create && <p role="status" data-testid="tasks-read-only" className="flex shrink-0 items-center gap-2 border-b bg-muted/50 px-4 py-1.5 text-caption text-muted-foreground"><Lock aria-hidden className="size-3.5" />You can read tasks and comment here. Only this space's managers can let guests add or change them.</p>}
      {state === "loading" && <Loading board={board} />}
      {state === "failed" && <Wrap id="tasks-failed"><LoadError title="Your tasks didn't load" error={page.error ?? setup.error} onRetry={() => { void page.refetch(); void setup.refetch(); }} /></Wrap>}
      {state === "no-access" && <Wrap id="tasks-no-access"><EmptyState icon={Lock} className="border-0" title="This space can't be opened" description="It may not exist, or you may not have access to it." action={<Button asChild size="sm" variant="outline" className="max-md:min-h-11"><Link to="/tasks">Show all your tasks</Link></Button>} /></Wrap>}
      {state === "no-space" && <Wrap id="tasks-no-space"><EmptyState icon={Layers} className="border-0" title={isGuest(me) ? "You're not in a space yet" : "Tasks live in spaces"} description={isGuest(me) ? "Ask whoever invited you to add you to one. Its tasks will show up here." : "Start a space and a first project, or ask a teammate to add you to theirs."} action={canStart ? <Button size="sm" onClick={() => setNewProject(true)} className="max-md:min-h-11"><Plus />Start a space</Button> : undefined} /></Wrap>}
      {state === "no-project" && <Wrap id="tasks-no-project"><EmptyState icon={FolderPlus} className="border-0" title="No projects yet" description={canStart ? "A project groups related tasks. Start one, then add what needs doing." : "Nobody has started a project in your spaces yet."} action={canStart ? <Button size="sm" onClick={() => setNewProject(true)} className="max-md:min-h-11"><Plus />New project</Button> : undefined} /></Wrap>}
      {state === "never" && <Wrap id="tasks-never"><EmptyState icon={CircleCheck} className="border-0" title="No tasks yet" description={canAdd ? "Add the first thing that needs doing." : "Nothing here yet. Tasks will show up as your team adds them."} action={canAdd ? newButton("Add a task") : undefined} /></Wrap>}
      {state === "all-done" && !board && !finished && <Wrap id="tasks-all-done"><EmptyState icon={CheckCheck} className="border-0" title="All done" description="Nothing is open here. Everything has been finished or cancelled." action={<div className="flex flex-wrap justify-center gap-2">{canAdd && newButton()}<Button size="sm" variant="outline" onClick={() => setQ({ finished: "1" })} data-testid="show-finished" className="max-md:min-h-11">Show finished</Button></div>} /></Wrap>}
      {state === "no-match" && <Wrap id="tasks-no-match"><EmptyState icon={SearchX} className="border-0" title="No tasks match these filters" description="Clear them to see everything in this view." action={<Button size="sm" variant="outline" onClick={clear} className="max-md:min-h-11"><X />Clear filters</Button>} /></Wrap>}
      {(state === "ready" || (state === "all-done" && (board || finished))) && (board
        ? <TaskBoard rows={rows} totals={totals} selected={selected} canEdit={canEdit} canAdd={canAdd} statuses={statuses} onOpen={open} onSelect={setSelected} onAdd={(status) => start({ status })} onMore={() => setLimit((l) => Math.min(MOST_AT_ONCE, l + A_PAGE))} />
        : <TaskList rows={rows} totals={totals} showFinished={finished || !!filters.status} selected={selected} canEdit={canEdit} canAdd={canAdd} keyboard={keyboard} onMenu={menuFor} onSelect={pick} onAdd={(status) => start({ status })} onMore={() => setLimit((l) => Math.min(MOST_AT_ONCE, l + A_PAGE))} onShowFinished={() => setQ({ finished: "1" })} />)}
      {!mobile && state === "ready" && canAdd && (
        <footer className="flex shrink-0 items-center gap-4 border-t px-3 py-1 text-caption text-muted-foreground">
          <span className="tabular-nums">{page.data?.open ?? 0} open</span>
          <span className="ml-auto flex items-center gap-1"><KeyHint shortcut="n" />new</span>
          <span className="flex items-center gap-1"><KeyHint shortcut="s" />status</span>
          <span className="flex items-center gap-1"><KeyHint shortcut="a" />assign</span>
          <span className="flex items-center gap-1"><KeyHint shortcut="shift+arrowup" />move</span>
          <span className="flex items-center gap-1"><KeyHint shortcut="?" />all keys</span>
        </footer>
      )}
      <TaskMenu request={menu.request} close={menu.close} rows={rows} />
      <Outlet />
      {newTask && setup.data && <NewTaskDialog setup={setup.data} start={newTask} onCreate={create} onClose={() => setNewTask(null)} />}
      {newProject && setup.data && <NewProjectDialog setup={setup.data} space={space} onClose={() => setNewProject(false)} onMade={(p) => { setNewProject(false); void setup.refetch(); navigate(`/tasks?project=${p.id}`); }} />}
      {saving && <SaveViewDialog onSave={save} onClose={() => setSaving(false)} />}
    </section>
  );
}

/** The phone's way to narrow by status: one row of chips that scrolls sideways, each with its count, over one-line rows. */
function StatusChips({ value, totals, onChange }: { value: string; totals: Partial<Record<TaskStatus, number>>; onChange: (v: string) => void }) {
  // Counts come from the list with no status picked, so picking one doesn't empty the others.
  const all = useRef(totals);
  if (!value) all.current = totals;
  const count = (st: TaskStatus) => all.current[st] ?? 0;
  const open = LIST_ORDER.filter(isOpen).reduce((n, st) => n + count(st), 0);
  const chips = [{ value: "", label: "Open", count: open }, ...LIST_ORDER.map((st) => ({ value: st, label: STATUS_LABELS[st], count: count(st) }))];
  return (
    <div data-testid="status-chips" className="kit-scroll-x flex shrink-0 items-center border-b px-3 py-1.5">
      <Segmented size="sm" label="Status" value={value || "open"} onChange={(v) => onChange(v === "open" ? "" : v)} className="[&_button[role=radio]]:min-h-11"
        options={chips.map((c) => ({ value: c.value || "open", label: c.label, count: c.count, mark: c.value ? <StatusIcon status={c.value as TaskStatus} className="size-3.5" /> : undefined }))} />
    </div>
  );
}
