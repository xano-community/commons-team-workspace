// One conversation: its header, its messages and its composer. A channel, a DM and a thread are all this, and a thread is
// this again in a pane beside its channel. Every way it can't work has its own words, and none of them loses what someone wrote.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ChevronLeft, Copy, Hash, Lock, MessagesSquare, SearchX, Users, WifiOff, X } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, EmptyState, LoadError } from "@/components/kit";
import { Composer, type ComposerHandle } from "@/components/workspace/composer";
import { DropArea } from "@/components/workspace/uploader";
import { LinkChip } from "@/components/workspace/link-chip";
import { MessageList, type MessageActions, type MessageListHandle } from "@/components/workspace/message-list";
import { useBroadcast, useChannel, useLiveChange, useLiveState } from "@/base/live";
import { isGuest, useMe } from "@/base/session";
import { useWorkspace } from "@/base/workspace";
import { api, type ChatPerson } from "@/lib/api";
import { useConnectedAgents, useHostedAgents, usePickups, useRuns } from "@/lib/agents/client";
import { askedOf, newestBySource, queuedStandIn } from "@/lib/agents/model";
import { conversationTitle, dmTitle, useConversations } from "@/lib/chat/client";
import { chatOutboxFor } from "@/lib/chat/outgoing";
import { buildRows, unreadDivider, visibleRows, type Row } from "@/lib/chat/log";
import { pull, useChatLog, useMessageActions, useOutgoing } from "@/lib/chat/store";
import { TYPING_MOST_MEMBERS, createTypingList, createTypingSender, typingLine } from "@/lib/chat/typing";
import { decodeBody } from "@/lib/chat/tokens";
import { CATALOG, useCommands, type Command } from "@/lib/commands";
import { useEntityQuery } from "@/lib/data";
import type { RecordView } from "@/lib/links/resolver";
import { shellToast } from "@/lib/toast";
import { openSpaceMembers } from "@/lib/data";
import { cn } from "@/lib/utils";
import { taskRecordOptions } from "../tasks/records";

const RunChip = lazy(() => import("@/components/workspace/run-chip"));
const RecordApprovals = lazy(() => import("@/components/workspace/approval-card"));

const READ_AFTER_MS = 1000;
const READ_EVERY_MS = 2000;
const POLL_MS = 4000;
const OFFLINE_NOTICE_MS = 5000;
const statusOf = (e: unknown) => (e as { status?: number } | null)?.status;
const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => shellToast.show("Copied"), () => shellToast.error("Your browser wouldn't copy that. Select the text instead."));

/** Marks read once the newest message has been on screen, in a focused window, for a second. */
function useMarkRead(id: number, lastSeq: number, pinned: boolean, hasNewer: boolean) {
  const client = useQueryClient();
  const sent = useRef(0);
  const at = useRef(0);
  useEffect(() => { sent.current = 0; at.current = 0; }, [id]);
  useEffect(() => {
    if (!pinned || hasNewer || !lastSeq || lastSeq <= sent.current) return;
    const mark = () => {
      if (!document.hasFocus() || document.visibilityState !== "visible") return;
      sent.current = lastSeq;
      at.current = Date.now();
      api.markRead(id, lastSeq).then(() => void client.invalidateQueries({ queryKey: ["conversation", "list"] }), () => { sent.current = 0; });
    };
    const t = setTimeout(mark, Math.max(READ_AFTER_MS, at.current + READ_EVERY_MS - Date.now()));
    window.addEventListener("focus", mark);
    return () => { clearTimeout(t); window.removeEventListener("focus", mark); };
  }, [client, id, lastSeq, pinned, hasNewer]);
}

/** Who's typing here, and a function to say this person is. */
function useTyping(id: number, me: number, enabled: boolean, nameOf: (id: number) => string) {
  const [ids, setIds] = useState<number[]>([]);
  const list = useMemo(() => {
    const made = createTypingList(me, () => setIds(made.ids()));
    return made;
  }, [me, id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { list.clear(); setIds([]); }, [list]);
  const channel = enabled ? `typing/${id}` : null;
  useChannel(channel, (m) => { if (m.type === "typing") list.frame(Number(m.payload.from), String(m.payload.state)); });
  const broadcast = useBroadcast();
  const sender = useMemo(() => createTypingSender((state) => { if (channel) broadcast?.(channel, "typing", { state }); }), [channel, broadcast]);
  useEffect(() => () => sender.stop(), [sender]);
  return { line: typingLine(ids.map(nameOf)), sender, list };
}

/**
 * Where a conversation starts. A channel introduces itself: its name, what it's for, its space and who's in it, so a short one
 * reads as a room with a few lines in it rather than a gap above them. A DM and a thread say so in a line.
 */
function Beginning({ kind, title, spaceName, purpose, people, isPrivate, empty, onMembers }: {
  kind: string; title: string; spaceName: string; purpose: string; people: ChatPerson[]; isPrivate: boolean; empty: boolean; onMembers?: () => void;
}) {
  // A thread opens with what it's about, so it says nothing once it has something to show.
  if (kind === "thread" && !empty) return null;
  if (kind !== "channel") {
    const text = kind === "dm" ? `This is the start of your conversation with ${title}.` : "No replies yet.";
    return <div data-testid="conversation-beginning" className="px-4 pt-6 pb-2"><p className="text-body text-muted-foreground">{text}</p></div>;
  }
  const Icon = isPrivate ? Lock : Hash;
  // A short channel's start fills the space above its first lines, so the room never reads as a gap.
  const members = people.length > 0 && (
    <button type="button" onClick={onMembers} disabled={!onMembers} data-testid="channel-intro-members"
      className="focus-ring -ml-1 flex w-fit items-center gap-2 rounded-md px-1 py-0.5 text-caption text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground max-md:min-h-11">
      <span className="flex items-center gap-0.5">{people.slice(0, 6).map((p) => <Avatar key={p.id} name={p.name} kind={p.kind} size="xs" decorative />)}</span>
      <span>{spaceName ? `${spaceName} · ` : ""}{people.length} {people.length === 1 ? "member" : "members"}</span>
    </button>
  );
  return (
    <div data-testid="conversation-beginning" className="flex flex-col gap-1.5 px-4 pt-6 pb-4">
      <span aria-hidden className="mb-1 grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-4" /></span>
      <p className="text-heading">#{title}</p>
      <p className="max-w-prose text-body text-pretty text-muted-foreground">{purpose || `This is the start of #${title}${spaceName ? ` in ${spaceName}` : ""}.`}</p>
      {members}
    </div>
  );
}

function LoadingList() {
  return (
    <div aria-busy="true" aria-label="Loading messages" className="flex min-h-0 flex-1 flex-col justify-end gap-3 p-4">
      {["w-2/5", "w-3/5", "w-1/3", "w-1/2"].map((w) => <div key={w} className="flex gap-2.5"><Skeleton className="size-8 shrink-0 rounded-full" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3 w-24" /><Skeleton className={cn("h-3.5", w)} /></div></div>)}
    </div>
  );
}

function Closed({ held, children }: { held: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      {children}
      {held && (
        <div className="w-full max-w-lg rounded-lg border bg-card p-3">
          <p className="max-h-40 overflow-y-auto text-body wrap-anywhere whitespace-pre-wrap" data-testid="held-text">{held}</p>
          <div className="mt-2 flex items-center justify-between gap-2"><span className="text-caption text-muted-foreground">This wasn't sent.</span><Button size="sm" variant="outline" onClick={() => copy(held)} className="max-sm:min-h-11"><Copy />Copy</Button></div>
        </div>
      )}
    </div>
  );
}

const iconOf = (kind: string, isPrivate: boolean) => (kind === "dm" ? Users : kind === "thread" ? MessagesSquare : isPrivate ? Lock : Hash);

export function Conversation({ id, panel = false, embedded = false, seq = null, onClose, onReply, backHref }: {
  id: number;
  /** Beside a channel, where its thread opens. */
  panel?: boolean;
  /** Inside its record's own screen, which says what it's about, so it has no header. */
  embedded?: boolean;
  /** A message to open at, from a link. */
  seq?: number | null;
  onClose?: () => void;
  onReply?: (row: Row) => void;
  /** A phone's way back. */
  backHref?: string;
}) {
  const me = useMe()!;
  const { nameOf, isAgent, people: everyone } = useWorkspace();
  const navigate = useNavigate();
  const client = useQueryClient();
  const details = useEntityQuery("conversation", ["details", id], () => api.conversation(id));
  const people = useEntityQuery("conversation", ["people", id], () => api.conversationPeople(id));
  const conversations = useConversations();
  const { log, older, newer, loadOlder, loadNewer, toLatest, jumpTo } = useChatLog(id, seq);
  const outgoing = useOutgoing(me.id, id);
  const box = chatOutboxFor(me.id, me.name);
  const actionsOf = useMessageActions(id);
  const live = useLiveState();
  const { runs, modelReady, keyName } = useRuns({ conversation_id: id });
  const hosted = useHostedAgents();
  const connected = useConnectedAgents();
  const runsByMessage = useMemo(() => newestBySource(runs, "message"), [runs]);
  // A run writing in this thread, shown above the composer, where its notes are arriving.
  const hereRun = runs.find((r) => r.thread_id === id && r.conversation_id !== id && ["queued", "claimed", "working", "waiting", "failed"].includes(r.status) && !embedded);

  const info = details.data;
  const conv = info?.conversation;
  // Agents who can't read this conversation, still offered by "@", so naming one can ask to add it first (KTD7).
  const outsiders = useMemo(() => {
    if (isGuest(me) || !conv || conv.kind === "dm" || conv.crm || !conv.space_id || !people.data) return [];
    const all = [...(hosted.data?.items ?? []), ...(connected.data?.items ?? [])];
    return all.filter((a) => !people.data!.some((p) => p.id === a.id)).map((a) => ({ id: a.id, name: a.name }));
  }, [me, conv, people.data, hosted.data, connected.data]);
  // Whether connected agents named here have picked their work up yet (KTD4).
  const connectedHere = useMemo(() => (connected.data?.items ?? []).filter((a) => people.data?.some((p) => p.id === a.id)), [connected.data, people.data]);
  const pickups = usePickups("conversation", id, connectedHere.length > 0 && !isGuest(me));
  const data = log.data;
  const rows = useMemo(() => (data ? visibleRows(data, outgoing, { id: me.id, name: me.name }) : []), [data, outgoing, me.id, me.name]);

  // The unread line stays where it was on opening, for the whole visit, however far reading moves on.
  const divider = useRef<{ id: number; seq: number | null } | null>(null);
  if (divider.current?.id !== id && info && data && info.conversation.id === id) divider.current = { id, seq: unreadDivider(data.rows, info.last_read_seq, me.id) };
  const dividerSeq = divider.current?.id === id ? divider.current.seq : null;
  const items = useMemo(() => buildRows(rows, dividerSeq, !!data && !data.hasOlder), [rows, dividerSeq, data]);

  // A screen reader hears what others send, gathered up, and never the person's own.
  const [announcement, setAnnouncement] = useState("");
  const heardUpTo = useRef<{ id: number; seq: number } | null>(null);
  useEffect(() => {
    if (!data) return;
    const newest = data.rows.at(-1)?.seq ?? 0;
    const heard = heardUpTo.current;
    heardUpTo.current = { id, seq: Math.max(newest, heard?.id === id ? heard.seq : 0) };
    if (heard?.id !== id) return;
    const fresh = data.rows.filter((r) => r.seq !== null && r.seq > heard.seq && r.author_id !== me.id && !r.deleted);
    if (fresh.length) setAnnouncement(fresh.length === 1 ? `New message from ${fresh[0].author_name}` : `${fresh.length} new messages`);
  }, [data, id, me.id]);

  const list = useRef<MessageListHandle>(null);
  const composer = useRef<ComposerHandle>(null);
  const [pinned, setPinned] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [offlineNotice, setOfflineNotice] = useState(false);
  useEffect(() => { setSelected(null); setEditing(null); setPinned(true); }, [id]);

  useMarkRead(id, data?.lastSeq ?? 0, pinned, !!data?.hasNewer);
  const small = (people.data?.length ?? 0) <= TYPING_MOST_MEMBERS;
  const typing = useTyping(id, me.id, !!info?.can_post && small, nameOf);

  // A hint carries ids alone. Reading what moved is one request, and a frame that's lost is repaired by the change log.
  useLiveChange((c) => {
    if (c.entity === "*" || (c.entity === "message" && c.id === id)) {
      void pull(client, id);
      if (c.op === "created" && c.actor_id) typing.list.sent(c.actor_id);
    }
  });
  // A viewer who isn't in this space, such as an admin, still needs its channel while they're here.
  const home = conv?.space_id ? `spaces/${conv.space_id}` : null;
  useChannel(home);

  // No socket: poll while the screen is open, and say so once it's clearly not coming back.
  useEffect(() => {
    if (live !== "offline") { setOfflineNotice(false); return; }
    const poll = setInterval(() => { if (document.visibilityState === "visible") void pull(client, id); }, POLL_MS);
    const notice = setTimeout(() => setOfflineNotice(true), OFFLINE_NOTICE_MS);
    return () => { clearInterval(poll); clearTimeout(notice); };
  }, [live, client, id]);
  useEffect(() => {
    const back = () => { if (document.visibilityState === "visible") void pull(client, id); };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => { window.removeEventListener("focus", back); document.removeEventListener("visibilitychange", back); };
  }, [client, id]);

  // A link to a message outside what's loaded brings its window.
  useEffect(() => {
    if (!seq || !data) return;
    if (!list.current?.toSeq(seq) && !data.rows.some((r) => r.seq === seq)) void jumpTo(seq);
    const hit = data.rows.find((r) => r.seq === seq);
    if (hit) setSelected(hit.key);
  }, [seq, !!data]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = useMemo(() => ({
    person: (pid: number) => people.data?.find((p) => p.id === pid)?.name ?? everyone.find((p) => p.id === pid)?.name ?? null,
    record: (type: string, rid: number) => (type === "conversation" ? conversations.data?.find((c) => c.id === rid)?.name ?? null : null),
  }), [people.data, everyone, conversations.data]);

  const place = useMemo(() => ({ type: "conversation" as const, id }), [id]);
  const send = useCallback((body: string, fileIds?: number[]) => {
    typing.sender.stop();
    box.send(id, body, conv?.space_id || undefined, fileIds);
    // Your own message always shows, wherever you'd scrolled to.
    if (data?.hasNewer) void toLatest();
    requestAnimationFrame(() => list.current?.toEnd());
  }, [box, conv?.space_id, data?.hasNewer, id, toLatest, typing.sender]);

  const ownRows = useMemo(() => rows.filter((r) => r.author_id === me.id && r.seq !== null && !r.deleted), [rows, me.id]);
  const selectedRow = rows.find((r) => r.key === selected) ?? null;
  const fail = (what: string) => (e: unknown) => shellToast.error(`Couldn't ${what}. ${e instanceof Error ? e.message : "Try again."}`);

  const actions: MessageActions = useMemo(() => ({
    me: me.id, canModerate: !!info?.can_moderate, canPost: !!info?.can_post, canReply: !panel && !!onReply && conv?.kind !== "thread",
    nameOf: (pid) => people.data?.find((p) => p.id === pid)?.name ?? nameOf(pid), isAgent: (pid) => isAgent(pid) || people.data?.find((p) => p.id === pid)?.kind === "agent",
    onReply: (row) => onReply?.(row), onEdit: (row) => { setSelected(null); setEditing(row.key); }, onDelete: setDeleting,
    onRetry: (row) => box.retry(row.key), onDiscard: (row) => box.discard(row.key), onCopy: (row) => copy(decodeBody(row.body, names).text),
    runOf: (row) => {
      const run = row.id ? runsByMessage.get(row.id) : undefined;
      if (run) return { run, modelReady, keyName };
      // Your own mention says Queued the moment it's sent, before the server has answered.
      const asked = row.author_id === me.id && !isGuest(me) ? askedOf(row, (hosted.data?.items ?? []).filter((a) => people.data?.some((p) => p.id === a.id)), Date.now()) : undefined;
      return asked && { run: queuedStandIn(asked, me.id), modelReady, keyName };
    },
    pickupOf: (row) => {
      if (!row.seq || !row.body.includes("<@")) return undefined;
      const agent = connectedHere.find((a) => row.body.includes(`<@${a.id}>`));
      const item = agent && pickups.data?.items.find((i) => i.user_id === agent.id && i.seq === row.seq);
      return agent && item ? { name: agent.name, agentId: agent.id, item } : undefined;
    },
  }), [me, info?.can_moderate, info?.can_post, panel, onReply, conv?.kind, people.data, nameOf, isAgent, box, names, runsByMessage, modelReady, keyName, hosted.data, connectedHere, pickups.data]);

  const step = (by: 1 | -1) => {
    const keys = rows.filter((r) => r.seq !== null).map((r) => r.key);
    const at = selected ? keys.indexOf(selected) : -1;
    const next = keys[at < 0 ? (by > 0 ? 0 : keys.length - 1) : Math.min(keys.length - 1, Math.max(0, at + by))];
    if (next) setSelected(next);
  };
  const canEditSelected = !!selectedRow && selectedRow.author_id === me.id && selectedRow.seq !== null && !selectedRow.deleted && !!info?.can_post;
  const canDeleteSelected = !!selectedRow && selectedRow.seq !== null && !selectedRow.deleted && (selectedRow.author_id === me.id || !!info?.can_moderate) && !!info?.can_post;
  const nextUnread = () => {
    const next = (conversations.data ?? []).find((c) => c.unread > 0 && c.id !== id);
    if (next) navigate(`/chat/${next.id}`);
  };
  const commands: Command[] = panel ? [] : [
    { id: "list.next", ...CATALOG["list.next"], run: () => step(1) },
    { id: "list.previous", ...CATALOG["list.previous"], run: () => step(-1) },
    { id: "list.close", ...CATALOG["list.close"], when: () => !!selected, run: () => setSelected(null) },
    { id: "chat.compose", ...CATALOG["chat.compose"], group: "Chat", icon: MessagesSquare, when: () => !!info?.can_post, run: () => composer.current?.focus() },
    { id: "chat.reply", ...CATALOG["chat.reply"], group: "Chat", when: () => !!selectedRow && selectedRow.seq !== null && actions.canReply, run: () => selectedRow && onReply?.(selectedRow) },
    { id: "chat.edit", ...CATALOG["chat.edit"], group: "Chat", when: () => canEditSelected, run: () => selectedRow && actions.onEdit(selectedRow) },
    { id: "chat.delete", ...CATALOG["chat.delete"], group: "Chat", when: () => canDeleteSelected, run: () => selectedRow && setDeleting(selectedRow) },
    { id: "chat.latest", ...CATALOG["chat.latest"], group: "Chat", run: () => { setSelected(null); if (data?.hasNewer) void toLatest(); list.current?.toEnd(); } },
    { id: "chat.next-unread", ...CATALOG["chat.next-unread"], group: "Chat", when: () => (conversations.data ?? []).some((c) => c.unread > 0 && c.id !== id), run: nextUnread },
  ];
  useCommands(commands, panel ? "chat-panel" : "chat");

  const held = [...outgoing.map((o) => o.body), composer.current?.text() ?? ""].filter(Boolean).join("\n\n");
  const heldRef = useRef("");
  if (held) heldRef.current = held;
  const wasOpen = useRef(false);
  if (info) wasOpen.current = true;
  useEffect(() => { wasOpen.current = false; heldRef.current = ""; }, [id]);

  const failed = details.error ?? (log.error && !data ? log.error : null);
  if (failed && statusOf(failed) === 404) {
    return wasOpen.current
      ? <Closed held={heldRef.current}><div data-testid="chat-removed"><EmptyState icon={Lock} className="border-0" title="You no longer have access to this space" description="Someone removed you, so its messages have left this screen." action={<Button asChild size="sm" variant="outline"><Link to="/chat">Back to chat</Link></Button>} /></div></Closed>
      : <Closed held=""><div data-testid="chat-not-found"><EmptyState icon={SearchX} className="border-0" title="This conversation can't be opened" description="It may not exist, or you may not have access to it." action={<Button asChild size="sm" variant="outline"><Link to="/chat">Back to chat</Link></Button>} /></div></Closed>;
  }
  if (failed && !info) return <div className="p-4"><LoadError title="This conversation didn't load" error={failed} onRetry={() => { void details.refetch(); void log.refetch(); }} /></div>;

  const row = conversations.data?.find((c) => c.id === id);
  const title = !conv ? "" : conv.kind === "dm" ? (row ? conversationTitle(row, me.id) : dmTitle({ members: info!.members.map((p: ChatPerson) => ({ user_id: p.id, name: p.name, kind: p.kind, status: p.status, id: p.id, conversation_id: id, created_at: 0 })) }, me.id)) : conv.kind === "thread" ? "Thread" : conv.name;
  const Icon = iconOf(conv?.kind ?? "channel", false);
  const placeholder = !conv ? "" : conv.kind === "dm" ? `Message ${title}` : embedded ? "Add a comment" : conv.kind === "thread" ? "Reply" : `Message #${title}`;
  const agentDm = conv?.kind === "dm" && info!.members.filter((p: ChatPerson) => p.id !== me.id).every((p: ChatPerson) => p.kind === "agent");

  return (
    <section aria-label={title || "Conversation"} data-testid={panel ? "thread-panel" : "conversation"} className="flex h-full min-h-0 min-w-0 flex-col">
      {!embedded && <h1 className="sr-only">{title}</h1>}
      <p className="sr-only" aria-live="polite" data-testid="chat-announcer">{announcement}</p>
      <DropArea onFiles={(files) => composer.current?.addFiles(files)} disabled={!info?.can_post} label="Drop to attach to your message" className="flex min-h-0 flex-1 flex-col">
      <header hidden={embedded} className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        {backHref && <Button asChild variant="ghost" size="icon-sm" className="md:hidden max-md:size-11"><Link to={backHref} aria-label="Back" data-testid="chat-back"><ChevronLeft /></Link></Button>}
        {conv ? <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", agentDm && "text-agent-text")} /> : <Skeleton className="size-4" />}
        {/* A conversation's name is its page's title, in the same role as every other page's; a thread beside it stays quieter. */}
        {conv ? <span className={cn("truncate", panel ? "text-body font-medium" : "text-title")}>{title}</span> : <Skeleton className="h-4 w-32" />}
        {info?.record && <LinkChip view={info.record as RecordView} className="ml-1" />}
        {!panel && conv?.purpose ? <span className="min-w-0 truncate text-caption text-muted-foreground max-sm:hidden" title={conv.purpose} data-testid="channel-purpose"><span className="text-foreground/80">{info?.space_name}</span><span aria-hidden className="mx-1.5">·</span>{conv.purpose}</span>
          : info?.space_name && !panel && <span className="truncate text-caption text-muted-foreground max-sm:hidden">{info.space_name}</span>}
        <div className="ml-auto flex items-center gap-1">
          {conv?.kind === "channel" && !!conv.space_id && <Button variant="ghost" size="sm" className="max-md:size-11 max-md:px-0" aria-label={`Members of ${info!.space_name}: ${people.data?.length ?? ""}`} onClick={() => openSpaceMembers(conv.space_id)}><Users /><span className="tabular-nums max-md:sr-only">{people.data?.length ?? ""}</span></Button>}
          {conv?.kind === "dm" && info!.members.filter((p: ChatPerson) => p.id !== me.id).slice(0, 3).map((p: ChatPerson) => <Avatar key={p.id} name={p.name} kind={p.kind} size="sm" />)}
          {onClose && <Button variant="ghost" size="icon-sm" aria-label="Close thread" data-testid="thread-close" onClick={onClose} className="max-md:size-11"><X /></Button>}
        </div>
      </header>
      {offlineNotice && <div role="status" data-testid="chat-offline" className="flex items-center gap-2 border-b bg-muted/50 px-4 py-1.5 text-caption text-muted-foreground"><WifiOff aria-hidden className="size-3.5" />Live updates are off here. New messages appear every few seconds.</div>}
      {!data || !conv ? <LoadingList /> : (
        <MessageList ref={list} items={items} conversationKey={id} label={title} fromTop={conv.kind === "thread" || embedded} hasOlder={data.hasOlder} hasNewer={data.hasNewer} older={older} newer={newer} onOlder={() => void loadOlder()} onNewer={() => void loadNewer()}
          onLatest={() => { if (data.hasNewer) void toLatest(); list.current?.toEnd(); }} onPinned={setPinned} actions={actions} selected={selected} onSelect={(key) => setSelected((s) => (s === key ? null : key))}
          openAt={dividerSeq !== null ? "unread" : null}
          beginning={<Beginning kind={conv.kind} title={title} spaceName={info!.space_name} purpose={conv.purpose ?? ""} people={people.data ?? []} isPrivate={false} empty={!rows.length}
            onMembers={conv.kind === "channel" && conv.space_id ? () => openSpaceMembers(conv.space_id) : undefined} />}
          editing={(r) => (r.key === editing ? (
            <div className="py-1" data-testid="message-editing">
              <Composer autoFocus placeholder="Edit message" initial={r.body} submitLabel="Save" audience={conv?.crm ? { type: "crm", id: 0 } : { type: "conversation", id }} people={people.data ?? []} channels={conversations.data ?? []} names={names} userId={me.id}
                onCancel={() => setEditing(null)} onSubmit={(body) => { setEditing(null); if (body !== r.body) void actionsOf.edit(r, body, fail("save that edit")); }} />
            </div>
          ) : null)} />
      )}
      {hereRun && <Suspense fallback={null}><RunChip run={hereRun} modelReady={modelReady} keyName={keyName} className="mx-3 mt-1 max-w-none shrink-0" /></Suspense>}
      {!embedded && <Suspense fallback={null}><RecordApprovals type="conversation" id={id} className="mx-3 mt-2 max-h-[50vh] shrink-0 overflow-y-auto" /></Suspense>}
      <div aria-live="polite" className="h-5 shrink-0 truncate px-4 text-caption text-muted-foreground" data-testid="typing-line">{typing.line}</div>
      {info && !info.can_post ? (
        <div data-testid="composer-archived" className="mx-3 mb-3 flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-body text-muted-foreground"><Archive aria-hidden className="size-4 shrink-0" />This space is archived. You can read it, and nobody can post here.</div>
      ) : (
        <div className="px-3 pb-3 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {conv ? <Composer ref={composer} key={id} autoFocus={!panel && !seq} draftId={`chat-${id}`} outsiders={outsiders} spaceId={conv.space_id || undefined} placeholder={placeholder} audience={conv.crm ? { type: "crm", id: 0 } : { type: "conversation", id }} people={people.data ?? []} channels={conversations.data ?? []} names={names} userId={me.id}
            searchRecords={taskRecordOptions} attach={place} onSubmit={send} onInput={() => typing.sender.input()} onEditLast={() => { const last = ownRows.at(-1); if (last) actions.onEdit(last); }} /> : <Skeleton className="h-10 w-full rounded-lg" />}
        </div>
      )}
      <AlertDialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this message?</AlertDialogTitle>
            <AlertDialogDescription>Its text goes for everyone, and that can't be undone. A note stays in its place.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction data-testid="confirm-delete" onClick={() => { if (deleting) void actionsOf.remove(deleting, fail("delete that message")); setDeleting(null); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </DropArea>
    </section>
  );
}
