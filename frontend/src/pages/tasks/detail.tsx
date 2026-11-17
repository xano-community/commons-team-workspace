// /tasks/:id: a task, its links, and its thread beside it. On a phone the two are one pane at a time. Every way it can't work
// has its own words, and an editor that loses access keeps what was typed.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ChevronLeft, CircleUserRound, Copy, Lock, MessagesSquare, MoreHorizontal, Pencil, RotateCcw, SearchX, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { DueLabel, EmptyState, KeyHint, LoadError, Segmented, rememberedHref } from "@/components/kit";
import { AgentMark } from "@/components/workspace/agent-mark";
import { BodyText } from "@/components/workspace/body-text";
import { FirstComment } from "@/components/workspace/first-comment";
import { Composer, type ComposerHandle } from "@/components/workspace/composer";
import { Attachments } from "@/components/workspace/attachments";
import { LinksPanel } from "@/components/workspace/links-panel";
import { useChannel, roomOf } from "@/base/live";
import { PresenceAvatars } from "@/base/presence";
import { isGuest, useMe } from "@/base/session";
import { useWorkspace } from "@/base/workspace";
import { useIsMobile } from "@/hooks/use-mobile";
import { api, type ChatPerson } from "@/lib/api";
import { useTaskRun } from "@/lib/agents/client";
import { tasksApi } from "@/lib/tasks/api";
import { useConversations } from "@/lib/chat/client";
import { recordsIn } from "@/lib/chat/tokens";
import { CATALOG, useCommands, type Command } from "@/lib/commands";
import { shellToast } from "@/lib/toast";
import { taskFromLists, useSpacePeople, useTaskActions, useTaskDetails, type TaskFull } from "@/lib/tasks/client";
import { isOpen, type TaskStatus } from "@/lib/tasks/model";
import { prefersReducedMotion, useSettled } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Conversation } from "../chat/conversation";
import { Assignee, PriorityIcon, StatusIcon, priorityName, statusName } from "./marks";
import { taskRecordOptions } from "./records";
import { TaskMenu, useTaskMenu, type MenuKind } from "./task-menu";

// Fetched as soon as the task screen is, so a sheet never waits on them to draw.
const runChip = import("@/components/workspace/run-chip");
const approvalCard = import("@/components/workspace/approval-card");
const hostedAgents = import("@/components/workspace/hosted-agents");
const RunChip = lazy(() => runChip);
const RecordApprovals = lazy(() => approvalCard);
const ConnectedNote = lazy(() => hostedAgents.then((m) => ({ default: m.ConnectedNote })));

const statusOf = (e: unknown) => (e as { status?: number } | null)?.status;
const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => shellToast.show("Copied"), () => shellToast.error("Your browser wouldn't copy that. Select the text instead."));
/** A property's value: quiet until pointed at, so the four read as one aligned list, label by label. */
const FIELD = "focus-ring -ml-2 inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 justify-self-start rounded-md px-2 text-body hover:bg-muted disabled:opacity-100 disabled:hover:bg-transparent max-md:h-11";

function Notice({ icon: Icon, id, children, action }: { icon: typeof Lock; id: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <div role="status" data-testid={id} className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-body text-muted-foreground"><Icon aria-hidden className="size-4 shrink-0" /><span className="min-w-0 flex-1 basis-48">{children}</span>{action}</div>;
}

/** Where a run card lands, at the height of a finished run's (the usual one), so it fills in place. */
const RunSlot = () => <div aria-hidden data-testid="run-slot" className="h-[5.125rem] max-w-md rounded-lg border border-dashed border-border/60" />;

/** The title and the body, edited together. A mention warning is a notice here: the mention is already in. */
function Editor({ task, onDone, composer }: { task: TaskFull; onDone: (title: string, description: string) => void; composer: React.RefObject<ComposerHandle | null> }) {
  const me = useMe()!;
  const { nameOf } = useWorkspace();
  const people = useSpacePeople(task.space_id);
  const conversations = useConversations();
  const [title, setTitle] = useState(task.title);
  const [titles, setTitles] = useState<Map<string, string> | null>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    const wanted = recordsIn(task.description);
    if (!wanted.length) { setTitles(new Map()); return; }
    api.resolveRecords(wanted).then((views) => setTitles(new Map(views.filter((v) => v.title).map((v) => [`${v.type}:${v.id}`, v.title]))), () => setTitles(new Map()));
  }, [task.description]);
  const names = useMemo(() => ({ person: (id: number) => nameOf(id), record: (type: string, id: number) => titles?.get(`${type}:${id}`) ?? null }), [nameOf, titles]);
  if (!titles) return <Skeleton className="h-24 w-full" />;
  return (
    <div className="flex flex-col gap-2" data-testid="task-editor">
      <label className="sr-only" htmlFor="task-title-edit">Title</label>
      <Input id="task-title-edit" value={title} maxLength={200} data-testid="task-title-input" aria-invalid={!!problem} onChange={(e) => { setTitle(e.target.value); setProblem(""); }} className="h-9 text-heading" />
      {problem && <p role="alert" className="text-caption text-destructive">{problem}</p>}
      <Composer ref={composer} notice autoFocus submitLabel="Save" placeholder="Add a description. @ names someone, # links a channel or a task." initial={task.description} audience={{ type: "space", id: task.space_id }} people={(people.data?.people ?? []) as ChatPerson[]} channels={conversations.data ?? []} names={names} userId={me.id}
        searchRecords={taskRecordOptions} onCancel={() => onDone(task.title, task.description)} onSubmit={(body) => { if (title.trim()) onDone(title.trim(), body); else setProblem("Give the task a title."); }} />
    </div>
  );
}

export function TaskPage() {
  const id = Number(useParams().id);
  const me = useMe()!;
  const { isAgent, nameOf } = useWorkspace();
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const seq = Number(params.get("seq")) || null;
  const pane = params.get("pane") === "thread" || (mobile && seq) ? "thread" : "details";
  const details = useTaskDetails(id);
  const actions = useTaskActions();
  const menu = useTaskMenu();
  const client = useQueryClient();
  // The task's own read, or until it lands, the row the list already showed: the title and fields at once, never a skeleton.
  const loaded = !!details.data && details.data.id === id;
  const preview = useMemo(() => (loaded ? undefined : taskFromLists(client, id)), [loaded, client, id]);
  const task = loaded ? details.data : preview;
  useChannel(task ? `spaces/${task.space_id}` : null);
  const { run, modelReady, keyName, loaded: runsLoaded } = useTaskRun(id, task?.assignee_id ? { id: task.assignee_id, name: task.assignee_name ?? "Agent" } : null, me.id, isGuest(me));

  const [editing, setEditing] = useState(false);
  const editor = useRef<ComposerHandle>(null);
  const held = useRef("");
  if (editing && editor.current?.text()) held.current = editor.current.text();
  const seen = useRef(false);
  if (task) seen.current = true;
  useEffect(() => { seen.current = false; held.current = ""; setEditing(false); }, [id]);

  // Opening is what reads it, wherever someone came from.
  const read = useRef(0);
  useEffect(() => {
    if (!task?.unread_items || read.current === id) return;
    read.current = id;
    void tasksApi.readTask(id).catch(() => { read.current = 0; });
  }, [task?.unread_items, id]);

  const trashed = !!task?.deleted_at;
  const allowed = loaded && !!task && (task.can_edit || task.can_restore);
  const editable = allowed && !trashed && !task?.archived;
  const back = useCallback(() => navigate(rememberedHref("/tasks")), [navigate]);
  const openMenu = (kind: MenuKind) => () => { if (task) menu.open(kind, task, document.querySelector<HTMLElement>(`[data-field="${kind}"]`)); };
  const finish = (title: string, description: string) => {
    setEditing(false);
    if (task && (title !== task.title || description !== task.description)) void actions.update(task, title, description);
  };
  const onDelete = () => { if (task) void actions.remove(task); };
  const commands: Command[] = [
    { id: "list.close", ...CATALOG["list.close"], when: () => !editing, run: back },
    { id: "tasks.status", ...CATALOG["tasks.status"], group: "Task", when: () => editable, run: openMenu("status") },
    { id: "tasks.priority", ...CATALOG["tasks.priority"], group: "Task", when: () => editable, run: openMenu("priority") },
    { id: "tasks.assign", ...CATALOG["tasks.assign"], group: "Task", when: () => editable, run: openMenu("assignee") },
    { id: "tasks.assign-me", ...CATALOG["tasks.assign-me"], group: "Task", when: () => editable, run: () => task && actions.assign(task, { id: me.id, name: me.name, kind: "human" }) },
    { id: "tasks.due", ...CATALOG["tasks.due"], group: "Task", when: () => editable, run: openMenu("due") },
    { id: "tasks.edit", ...CATALOG["tasks.edit"], group: "Task", icon: Pencil, when: () => editable, run: () => setEditing(true) },
    { id: "tasks.delete", ...CATALOG["tasks.delete"], group: "Task", icon: Trash2, when: () => editable, run: onDelete },
    { id: "chat.reply", ...CATALOG["chat.reply"], label: "Comment on this task", group: "Task", icon: MessagesSquare, when: () => !task?.archived, run: () => {
      if (mobile) setParams((p) => { p.set("pane", "thread"); return p; }, { replace: true });
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="task-thread"] [data-testid="composer-input"]')?.focus());
    } },
  ];
  useCommands(commands, "task-detail");

  const failed = details.error;
  if (failed && statusOf(failed) === 404) {
    const was = seen.current;
    return (
      <div data-testid={was ? "task-removed" : "task-not-found"} className="flex h-full flex-col items-center justify-center gap-4 p-6">
        <EmptyState icon={was ? Lock : SearchX} className="border-0" title={was ? "You no longer have access to this task" : "This task can't be opened"} description={was ? "Someone removed you from its space, so it has left this screen." : "It may not exist, or you may not have access to it."} action={<Button asChild size="sm" variant="outline" className="max-md:min-h-11"><Link to="/tasks">Back to tasks</Link></Button>} />
        {held.current && (
          <div className="w-full max-w-lg rounded-lg border bg-card p-3">
            <p className="max-h-40 overflow-y-auto text-body wrap-anywhere whitespace-pre-wrap" data-testid="held-text">{held.current}</p>
            <div className="mt-2 flex items-center justify-between gap-2"><span className="text-caption text-muted-foreground">This wasn't saved.</span><Button size="sm" variant="outline" onClick={() => copy(held.current)} className="max-sm:min-h-11"><Copy />Copy</Button></div>
          </div>
        )}
      </div>
    );
  }
  if (failed && !task) return <div className="p-4"><LoadError title="This task didn't load" error={failed} onRetry={() => void details.refetch()} /></div>;

  const field = (kind: MenuKind, label: string, children: React.ReactNode) => (
    <>
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0"><button type="button" data-field={kind} disabled={!editable} onClick={openMenu(kind)} className={FIELD}><span className="sr-only">{label}: </span>{children}</button></dd>
    </>
  );

  return (
    <section aria-label={task?.title ?? "Task"} data-testid="task-detail" className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b px-2">
        <Button asChild variant="ghost" size="sm" className="max-md:min-h-11"><Link to={rememberedHref("/tasks")} data-testid="task-back"><ChevronLeft />Tasks</Link></Button>
        {task ? <span className="min-w-0 truncate text-caption text-muted-foreground">{[task.space_name, task.project_name].filter(Boolean).join(" / ")}</span> : <Skeleton className="h-4 w-40" />}
        <div className="ml-auto flex items-center gap-1">
          <PresenceAvatars room={roomOf("task", id)} />
          {editable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="More" data-testid="task-more-menu" className="max-md:size-11"><MoreHorizontal /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditing(true)}><Pencil />Edit</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => copy(location.href)}><Copy />Copy link</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" data-testid="task-delete" onSelect={onDelete}><Trash2 />Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>
      {mobile && <div className="flex shrink-0 justify-center border-b p-1.5"><Segmented size="sm" label="Show" value={pane} onChange={(v) => setParams((p) => { if (v === "thread") p.set("pane", "thread"); else { p.delete("pane"); p.delete("seq"); } return p; }, { replace: true })} options={[{ value: "details", label: "Details" }, { value: "thread", label: "Comments" }]} className="[&_button]:min-h-11 [&_button]:px-6" /></div>}
      <div className={cn("grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]")}>
        <div className={cn("min-h-0 overflow-y-auto", pane === "thread" && "max-md:hidden")}>
          <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 md:p-6">
            {!task ? <div aria-busy="true" aria-label="Loading task" className="space-y-3"><Skeleton className="h-7 w-2/3" /><Skeleton className="h-7 w-1/2" /><Skeleton className="h-24 w-full" /></div> : <>
              {loaded && trashed && <Notice icon={Trash2} id="task-trashed" action={task.can_edit || task.can_restore ? <Button size="sm" variant="outline" data-testid="task-restore" onClick={() => void actions.restore(task)} className="max-md:min-h-11"><RotateCcw />Restore</Button> : undefined}>This task is in the trash. It's removed for good 30 days after it was deleted.</Notice>}
              {loaded && task.archived && <Notice icon={Archive} id="task-archived">This space is archived. You can read this task, and nobody can change it.</Notice>}
              {loaded && !task.archived && !trashed && !allowed && <Notice icon={Lock} id="task-read-only">You can read this task and comment. Only this space's managers can let guests change it.</Notice>}
              {task.left_name && !task.assignee_id && <Notice icon={TriangleAlert} id="task-left">{task.left_name} left this space, so this task has nobody on it.{editable ? " Assign someone to pick it up." : ""}</Notice>}
              {editing ? <Editor task={task} composer={editor} onDone={finish} /> : <h1 className="text-title text-pretty wrap-anywhere" data-testid="task-title">{task.title}</h1>}
              <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 max-md:gap-y-0" data-testid="task-fields">
                {field("status", "Status", <><StatusIcon status={task.status as TaskStatus} className="size-4" />{statusName(task.status)}</>)}
                {field("priority", "Priority", <><PriorityIcon priority={task.priority} className="size-4" />{priorityName(task.priority)}</>)}
                {field("assignee", "Assignee", <>{task.assignee_name ? <Assignee task={task} decorative /> : <CircleUserRound aria-hidden className="size-4 text-muted-foreground" />}<span className={cn("truncate", !task.assignee_name && "text-muted-foreground")}>{task.assignee_name ?? "Nobody yet"}</span>{task.assignee_kind === "agent" && <AgentMark />}</>)}
                {field("due", "Due", task.due_on ? <DueLabel value={task.due_on} done={!isOpen(task.status)} /> : <span className="text-muted-foreground">No date</span>)}
              </dl>
              {/* A task with an agent on it nearly always has a run: hold a finished run's full height while it loads, so nothing below jumps. */}
              {run ? <Suspense fallback={<RunSlot />}><RunChip run={run} modelReady={modelReady} keyName={keyName} /></Suspense>
                : !runsLoaded && task.assignee_kind === "agent" ? <RunSlot /> : null}
              {task.assignee_id > 0 && <Suspense fallback={null}><ConnectedNote id={task.assignee_id} taskId={task.id} /></Suspense>}
              <Suspense fallback={null}><RecordApprovals type="task" id={id} threadId={task.thread_id} /></Suspense>
              {!editing && (task.description
                ? <div data-testid="task-description"><BodyText body={task.description} me={me.id} nameOf={nameOf} isAgent={isAgent} /></div>
                : editable ? <button type="button" onClick={() => setEditing(true)} data-testid="task-add-description" className="focus-ring self-start rounded-sm text-body text-muted-foreground hover:text-foreground max-md:min-h-11">Add a description…</button> : null)}
              {!editing && editable && task.description && <div className="hidden md:block"><Button variant="ghost" size="sm" onClick={() => setEditing(true)} className="-ml-2 text-muted-foreground"><Pencil />Edit<KeyHint shortcut={CATALOG["tasks.edit"].shortcut} /></Button></div>}
              <Attachments record={{ type: "task", id }} className="border-t pt-4" />
              <LinksPanel type="task" id={id} editable={editable} filesShown />
            </>}
          </div>
        </div>
        <aside aria-labelledby="task-comments" data-testid="task-thread" className={cn("flex min-h-0 min-w-0 flex-col md:border-l", pane === "details" && "max-md:hidden")}>
          <h2 id="task-comments" className="flex h-10 shrink-0 items-center px-4 text-caption font-medium text-muted-foreground max-md:sr-only">Comments</h2>
          <div className="min-h-0 flex-1">
            {/* Until the task itself lands the rail stays quiet, rather than flashing placeholder bars. */}
            {!loaded || !task ? <div aria-busy="true" aria-label="Loading comments" className="h-full" /> : task.thread_id > 0 ? <Conversation key={task.thread_id} id={task.thread_id} panel embedded seq={seq} />
              : task.archived ? <p className="p-4 text-body text-muted-foreground">No comments, and this space is archived.</p> : <FirstComment record={{ type: "task", id: task.id }} spaceId={task.space_id} refresh={["task", "details", task.id]} searchRecords={taskRecordOptions} testId="task-thread-empty" />}
          </div>
        </aside>
      </div>
      <TaskMenu request={menu.request} close={menu.close} rows={[]} />
    </section>
  );
}

/**
 * /tasks/:id, as a sheet over the list (the list's route renders it in its Outlet). A pointer slides it in from the edge at its
 * full width, opaque throughout, once its reads have landed (or 160 ms have passed), so it arrives drawn and nothing in it moves
 * after. A key, a link from elsewhere, or a step to another task shows it at once. Reduced motion shows it at once too.
 */
export function TaskSheet() {
  const { state } = useLocation();
  const client = useQueryClient();
  const [slide] = useState(() => (state as { opened?: string } | null)?.opened === "pointer" && !prefersReducedMotion());
  const settled = useSettled(client, slide);
  return (
    <div data-testid="task-sheet" data-settled={settled || undefined} className={cn("absolute inset-0 z-20 flex min-h-0 flex-col bg-background xl:left-72 xl:border-l xl:shadow-2xl",
      // Drawn but not shown until it's ready, then one move in from the right edge.
      !settled && "invisible",
      slide && settled && "animate-in slide-in-from-right duration-150 [animation-timing-function:var(--ease-out)]")}>
      <TaskPage />
    </div>
  );
}
