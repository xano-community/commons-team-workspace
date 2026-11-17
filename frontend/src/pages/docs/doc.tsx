// /docs/:id: a doc, who's in it, what's linked, and its thread beside it. People don't type together here: everyone sees who else
// is in, a save that loses a race asks what to do, and an agent's change waits at the foot of the doc for a person to decide.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { DocEditor, DocsProvider } from "@xano-sdk/docs/react";
import type { Editor } from "@tiptap/react";
import { Archive, Copy, Lock, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, EmptyState, LoadError, Segmented, rememberedHref } from "@/components/kit";
import { FirstComment } from "@/components/workspace/first-comment";
import { Attachments } from "@/components/workspace/attachments";
import { LinksPanel } from "@/components/workspace/links-panel";
import { AppliedNote, SuggestionBar } from "@/components/workspace/suggestion-bar";
import { roomOf, useChannel, useLive } from "@/base/live";
import { PresenceAvatars } from "@/base/presence";
import { isGuest, useMe } from "@/base/session";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSpacePeople } from "@/lib/tasks/client";
import { CATALOG, useCommands, type Command } from "@/lib/commands";
import { docsApi, type DocContext, type DocSuggestion } from "@/lib/docs/api";
import { useDocContext, useDocRun } from "@/lib/docs/client";
import { createPulse, goneNotice, queueOf } from "@/lib/docs/model";
import { mySpaces, useAllSpaces } from "@/lib/data";
import { applySuggestion, findTarget } from "@/lib/docs/target";
import { runLine } from "@/lib/agents/model";
import { shellToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { channelPath } from "../../../../xano/routes.gen.js";
import { useWorkspace } from "@/base/workspace";
import { AgentMark } from "@/components/workspace/agent-mark";
import { Person } from "@/components/workspace/person";
import { Conversation } from "../chat/conversation";
import { taskRecordOptions } from "../tasks/records";
import { docsClient, savedHere } from "./docs-client";
import { RecordPicker, highlight, reveal, useDocExtensions, type Picker, type SuggestionKeys } from "./extensions";
import "./docs.css";

const RunChip = lazy(() => import("@/components/workspace/run-chip"));
const RecordApprovals = lazy(() => import("@/components/workspace/approval-card"));

/** Keystrokes hold an agent's change back for 15 seconds on the server, so a beat this often covers anyone still typing. */
const TYPING_BEAT_MS = 5_000;
const statusOf = (e: unknown) => (e as { status?: number } | null)?.status;
const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => shellToast.show("Copied"), () => shellToast.error("Your browser wouldn't copy that. Select the text instead."));

function Band({ icon: Icon, id, children }: { icon: typeof Lock; id: string; children: React.ReactNode }) {
  return <p role="status" data-testid={id} className="flex shrink-0 items-center gap-2 border-b bg-muted/50 px-4 py-1.5 text-caption text-muted-foreground"><Icon aria-hidden className="size-3.5 shrink-0" /><span className="min-w-0">{children}</span></p>;
}

/** "An agent is working here", from the run's own row. It stays out of the way: a mark in the header, and the run behind a click. */
function AgentHere({ id }: { id: number }) {
  const { run, modelReady, keyName } = useDocRun(id);
  const { nameOf } = useWorkspace();
  const me = useMe();
  if (!run) return null;
  const line = runLine(run, { modelReady, nameOf, guest: isGuest(me) });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-testid="agent-here" data-state={run.status} className="focus-ring inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-caption hover:bg-muted max-md:h-11">
          <Avatar name={run.agent_name} kind="agent" size="xs" decorative />
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", line.tone === "live" ? "bg-agent-text motion-safe:animate-pulse" : line.tone === "failed" ? "bg-destructive" : "bg-muted-foreground")} />
          <span className="max-w-44 truncate text-muted-foreground max-md:sr-only">{line.tone === "live" ? `${run.agent_name} is working here` : `${run.agent_name}: ${line.label}`}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-1rem)] p-1.5"><Suspense fallback={<Skeleton className="h-8 w-full" />}><RunChip run={run} modelReady={modelReady} keyName={keyName} className="max-w-none border-0" /></Suspense></PopoverContent>
    </Popover>
  );
}

/**
 * Who wrote this and who last touched it. The module draws the byline with a round face that can't tell an agent, so the app draws
 * the name in its place: into the module's own row, which keeps its live "Edited" line. Its name goes, by docs.css.
 */
function Byline({ editor, context }: { editor: Editor | null; context: DocContext }) {
  const me = useMe();
  const [row, setRow] = useState<Element | null>(null);
  useEffect(() => { setRow(editor?.view.dom.closest(".doc-editor")?.querySelector(":scope > article > .mb-6") ?? null); }, [editor]);
  if (!row || !context.owner_name) return null;
  const agentEdited = context.editor_kind === "agent" && context.editor_id !== context.owner_id;
  return createPortal(<>
    <Person name={context.owner_name} kind={context.owner_kind} label={context.owner_id === me.id ? "You" : undefined} className="doc-byline-owner" />
    {agentEdited && <span className="doc-byline-editor"><AgentMark /></span>}
  </>, row);
}

/**
 * Where the doc lives, ahead of its title in the module's header: its space, then the project of the task it's for. The module
 * draws the header, so these go in through a slot this inserts before its title.
 */
function Crumbs({ editor, context }: { editor: Editor | null; context: DocContext }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const header = editor?.view.dom.closest(".doc-editor")?.querySelector(":scope > header");
    const title = header?.querySelector(":scope > span[aria-hidden]");
    if (!header || !title) return;
    const el = document.createElement("nav");
    el.className = "doc-crumbs";
    el.setAttribute("aria-label", "Where this doc lives");
    el.dataset.testid = "doc-crumbs";
    header.insertBefore(el, title);
    setSlot(el);
    return () => { el.remove(); setSlot(null); };
  }, [editor]);
  if (!slot) return null;
  const crumb = "focus-ring min-w-0 shrink truncate rounded-sm text-muted-foreground hover:text-foreground hover:underline max-md:hidden";
  return createPortal(<>
    <Link to={`/docs?space=${context.space_id}`} className={crumb}>{context.space_name}</Link>
    <span aria-hidden className="text-muted-foreground/60 max-md:hidden">/</span>
    {context.project_id > 0 && context.project_name && <>
      <Link to={`/tasks?project=${context.project_id}`} className={crumb}>{context.project_name}</Link>
      <span aria-hidden className="text-muted-foreground/60 max-md:hidden">/</span>
    </>}
  </>, slot);
}

/** Everything about a doc's suggestions. It lives apart so the keystrokes it watches don't re-render the editor around it. */
function Suggestions({ context, editor, keys, onChanged }: { context: DocContext; editor: Editor | null; keys: SuggestionKeys; onChanged: () => void }) {
  const [, setTick] = useState(0);
  const [deciding, setDeciding] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [closed, setClosed] = useState(0);

  useEffect(() => {
    if (!editor) return;
    const moved = ({ transaction }: { transaction: { docChanged: boolean } }) => { if (transaction.docChanged) setTick((n) => n + 1); };
    editor.on("transaction", moved);
    return () => { editor.off("transaction", moved); };
  }, [editor]);

  const canApply = editor ? (s: DocSuggestion) => !s.find || !!findTarget(editor.state.doc, s.find) : null;
  const queue = queueOf(context.suggestions, canApply, deciding);
  const head = queue?.head;
  const find = queue && !queue.stale ? queue.head.find : "";
  useEffect(() => { if (editor) highlight(editor, find); }, [editor, find]);
  useEffect(() => setProblem(""), [head?.id]);

  const settle = (id: number) => { onChanged(); setDeciding((now) => { const next = new Set(now); next.delete(id); return next; }); };
  const hide = (id: number) => setDeciding((now) => new Set(now).add(id));

  const dismiss = async () => {
    if (!head) return;
    hide(head.id);
    try {
      await docsApi.decide(head.id, "dismiss");
      settle(head.id);
    } catch (e) {
      setDeciding((now) => { const next = new Set(now); next.delete(head.id); return next; });
      setProblem(`Couldn't dismiss that. ${e instanceof Error ? e.message : "Try again."}`);
    }
  };

  /** The decision first, so two windows can't both apply. The edit lands in this editor, where any unsaved typing is, and saves as this person's. */
  const apply = async () => {
    if (!head || !editor || busy) return;
    setBusy(true);
    setProblem("");
    try {
      const decided = await docsApi.decide(head.id, "apply");
      if (decided.text_changed) { setProblem("Those words have just changed, so this can't be applied."); onChanged(); return; }
      if (!decided.changed) { onChanged(); return; }
      const edit = applySuggestion(editor.state, head);
      if (edit) editor.view.dispatch(edit);
      else await docsApi.decide(head.id, "reopen");
      onChanged();
    } catch (e) {
      setProblem(`Couldn't apply that. ${e instanceof Error ? e.message : "Try again."}`);
    } finally { setBusy(false); }
  };

  keys.apply = queue && !queue.stale ? () => void apply() : null;
  keys.dismiss = queue ? () => void dismiss() : null;
  const commands: Command[] = [
    { id: "docs.apply", ...CATALOG["docs.apply"], group: "Doc", when: () => !!keys.apply, run: () => keys.apply?.() },
    { id: "docs.dismiss", ...CATALOG["docs.dismiss"], group: "Doc", when: () => !!keys.dismiss, run: () => keys.dismiss?.() },
  ];
  useCommands(commands, "doc-suggestions");

  const applied = context.applied[0];
  return (
    // In the page's flow, held to the bottom while the doc scrolls under it: it never sits over the last lines with no way past.
    <div className="pointer-events-none sticky bottom-0 z-20 flex flex-col items-center gap-1.5 px-3 pb-3 max-md:px-2 max-md:pb-2">
      {!queue && applied && applied.id !== closed && <AppliedNote applied={applied} onClose={() => setClosed(applied.id)} />}
      {queue && <SuggestionBar suggestion={queue.head} total={queue.total} stale={queue.stale} busy={busy} problem={problem} onApply={() => void apply()} onDismiss={() => void dismiss()} onShow={() => editor && reveal(editor)} />}
    </div>
  );
}

/** The module's provider, on this app's client. "@" offers the people in the doc's space: nobody else could read it. */
function InSpace({ spaceId, children }: { spaceId: number; children: React.ReactNode }) {
  const me = useMe()!;
  const navigate = useNavigate();
  const space = useSpacePeople(spaceId);
  const { isAgent } = useWorkspace();
  const agentAuthor = useRef(isAgent);
  agentAuthor.current = isAgent;
  const client = useMemo(() => {
    // The module writes a version's author straight into its row, so an agent's author can be the app's own Person.
    const marked = <V extends { author_id: number | null; author_name?: string | null }>(v: V): V => (agentAuthor.current(v.author_id) ? { ...v, author_name: <Person name={v.author_name ?? "Agent"} kind="agent" face={false} /> as unknown as string } : v);
    return { ...docsClient, versions: async (doc: number) => (await docsClient.versions(doc)).map(marked), version: async (doc: number, version: number) => marked(await docsClient.version(doc, version)) };
  }, []);
  const members = useRef<{ id: number; name: string }[]>([]);
  members.current = (space.data?.people ?? []) as { id: number; name: string }[];
  const people = useCallback(async (q: string) => members.current.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8).map((p) => ({ id: p.id, name: p.name })), []);
  // The "@" menu writes the name beside the face, so the face is decorative: an agent's square, a person's circle.
  const face = useCallback((p: { id: number; name: string }) => <Avatar name={p.name} kind={agentAuthor.current(p.id) ? "agent" : null} size="xs" decorative />, []);
  return <DocsProvider client={client} userKey={me.id} onNavigate={navigate} people={people} mentionAvatar={face} fallback={<Skeleton className="m-6 h-8 w-2/3" />}>{children}</DocsProvider>;
}

function Editing({ id, context, onLeave, held }: { id: number; context: DocContext; onLeave: () => void; held: React.RefObject<string> }) {
  const client = useQueryClient();
  const { extensions, keys, picker } = useDocExtensions(taskRecordOptions);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const frameFrom = useRef(0);

  // Someone else's save. This tab's own frame is one it already holds, and an open editor with unsaved typing ignores the rest.
  useChannel(channelPath("docs/{doc_id}", { doc_id: id }), (m) => {
    if (m.type !== "doc_saved") return;
    const version = Number(m.payload.version);
    if (version > (savedHere.get(id) ?? 0) && version > frameFrom.current) { frameFrom.current = version; setRefreshKey((n) => n + 1); }
    if (Number(m.payload.actor_id) !== context.editor_id) refreshContext();
  });
  useEffect(() => {
    const back = () => { if (document.visibilityState === "visible") setRefreshKey((n) => n + 1); };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);
  useLive("doc", () => setRefreshKey((n) => n + 1));

  const onEditor = useCallback((e: Editor) => setEditor(e), []);
  useEffect(() => {
    if (!editor) return;
    const pulse = createPulse(() => void docsApi.editing(id).catch(() => {}), TYPING_BEAT_MS);
    const typed = ({ transaction }: { transaction: { docChanged: boolean; getMeta: (k: string) => unknown } }) => {
      if (!transaction.docChanged) return;
      held.current = editor.getText();
      if (!transaction.getMeta("preventUpdate") && editor.isEditable) pulse();
    };
    editor.on("transaction", typed);
    return () => { editor.off("transaction", typed); };
  }, [editor, id, held]);

  const refreshContext = useCallback(() => void client.invalidateQueries({ queryKey: ["doc", "context", id] }), [client, id]);
  const actions = useMemo(() => <><AgentHere id={id} /><PresenceAvatars room={roomOf("doc", id)} label="Also in this doc" /></>, [id]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {context.archived && <Band icon={Archive} id="doc-archived">This space is archived, so this doc stays as it is.</Band>}
      {!context.archived && !context.can_edit && <Band icon={Lock} id="doc-read-only">You can read this doc. Its author and this space's members can change it.</Band>}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="doc-scroller">
        <Suspense fallback={null}><RecordApprovals type="doc" id={id} className="mx-auto w-full max-w-[44rem] px-5 pt-3 max-md:px-4" /></Suspense>
        <DocEditor docId={id} className="doc-editor" backHref={rememberedHref("/docs")} readOnly={!context.can_edit} refreshKey={refreshKey} extensions={extensions} onEditor={onEditor} actions={actions}
          onDeleted={(d) => { onLeave(); shellToast.show(`Moved ${d.title} to the trash`, { label: "Undo", onClick: () => void docsClient.undelete(id).then(() => shellToast.show("Brought back"), () => shellToast.error("Couldn't bring that back. Try again from the trash.")) }); }} />
        {/* Right under the words it's about: a short doc shows it there, a long one keeps it at the bottom of the screen until
            the body ends, and neither puts it over the files and links below. */}
        {context.can_edit && <Suggestions context={context} editor={editor} keys={keys} onChanged={refreshContext} />}
        <div className="mx-auto flex max-w-[44rem] flex-col gap-4 px-5 pb-6 max-md:px-4"><Attachments record={{ type: "doc", id }} className="border-t pt-4" /><LinksPanel type="doc" id={id} editable={context.can_edit} filesShown /></div>
        <div aria-hidden className="h-16" />
      </div>
      <Byline editor={editor} context={context} />
      <Crumbs editor={editor} context={context} />
      <RecordPicker picker={picker as Picker} />
    </div>
  );
}

export function DocPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const seq = Number(params.get("seq")) || null;
  const pane = params.get("pane") === "thread" || (mobile && seq) ? "thread" : "doc";
  const context = useDocContext(id);
  const ready = context.data && context.data.id === id ? context.data : undefined;
  useChannel(ready ? `spaces/${ready.space_id}` : null);

  const seen = useRef(false);
  if (ready) seen.current = true;
  const spaceOf = useRef<number | null>(null);
  if (ready) spaceOf.current = ready.space_id;
  const spaces = useAllSpaces().data;
  const held = useRef("");
  useEffect(() => { seen.current = false; held.current = ""; spaceOf.current = null; }, [id]);

  // Opening is what reads it, wherever someone came from.
  const read = useRef(0);
  useEffect(() => {
    if (!ready || read.current === id) return;
    read.current = id;
    void docsApi.read(id).catch(() => { read.current = 0; });
  }, [ready, id]);

  const leave = useCallback(() => navigate(rememberedHref("/docs")), [navigate]);
  const failed = context.error;
  if (failed && statusOf(failed) === 404) {
    const was = seen.current;
    const gone = goneNotice({ spaceId: spaceOf.current, mySpaces: spaces ? mySpaces(spaces).map((s) => s.id) : null });
    return (
      <div data-testid={was ? "doc-removed" : "doc-not-found"} className="flex h-full flex-col items-center justify-center gap-4 p-6">
        <EmptyState icon={was ? Lock : SearchX} className="flex-none border-0" title={was ? gone.title : "This doc can't be opened"} description={was ? gone.description : "It may have been deleted, or you may not have access to it."} action={<Button asChild size="sm" variant="outline" className="max-md:min-h-11"><Link to="/docs">Back to docs</Link></Button>} />
        {held.current && (
          <div className="w-full max-w-lg rounded-lg border bg-card p-3">
            <p className="max-h-40 overflow-y-auto text-body wrap-anywhere whitespace-pre-wrap" data-testid="doc-held-text">{held.current}</p>
            <div className="mt-2 flex items-center justify-between gap-2"><span className="text-caption text-muted-foreground">Your last words, in case they weren't saved.</span><Button size="sm" variant="outline" onClick={() => copy(held.current)} className="max-sm:min-h-11"><Copy />Copy</Button></div>
          </div>
        )}
      </div>
    );
  }
  if (failed && !ready) return <div className="p-4"><LoadError title="This doc didn't load" error={failed} onRetry={() => void context.refetch()} /></div>;

  return (
    <section aria-label="Doc" data-testid="doc-page" className="flex h-full min-h-0 min-w-0 flex-col">
      {mobile && ready && <div className="flex shrink-0 justify-center border-b p-1.5"><Segmented size="sm" label="Show" value={pane} onChange={(v) => setParams((p) => { if (v === "thread") p.set("pane", "thread"); else { p.delete("pane"); p.delete("seq"); } return p; }, { replace: true })} options={[{ value: "doc", label: "Doc" }, { value: "thread", label: "Comments" }]} className="[&_button]:min-h-11 [&_button]:px-6" /></div>}
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_minmax(18rem,23rem)]">
        <div className={cn("min-h-0 min-w-0", pane === "thread" && "max-md:hidden")}>
          {!ready ? <div aria-busy="true" aria-label="Loading doc" data-testid="doc-loading" className="mx-auto max-w-[44rem] space-y-3 p-6"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-4 w-40" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-11/12" /></div>
            : <InSpace spaceId={ready.space_id}><Editing id={id} context={ready} onLeave={leave} held={held} /></InSpace>}
        </div>
        <aside aria-labelledby="doc-comments" data-testid="doc-thread" className={cn("flex min-h-0 min-w-0 flex-col md:border-l", pane === "doc" && "max-md:hidden")}>
          {/* The same rail as a task's: a heading, then the thread or the way to start one. */}
          <h2 id="doc-comments" className="flex h-11 shrink-0 items-center border-b px-4 text-caption font-medium text-muted-foreground max-md:sr-only">Comments</h2>
          <div className="min-h-0 flex-1">
            {!ready ? <Skeleton className="m-4 h-10" /> : ready.thread_id > 0 ? <Conversation key={ready.thread_id} id={ready.thread_id} panel embedded seq={seq} />
              : ready.archived ? <p className="p-4 text-body text-muted-foreground">No comments, and this space is archived.</p> : <FirstComment record={{ type: "doc", id }} spaceId={ready.space_id} refresh={["doc", "context", id]} searchRecords={taskRecordOptions} testId="doc-thread-empty" />}
          </div>
        </aside>
      </div>
    </section>
  );
}
