// /chat and /chat/:id. A desktop's sidebar is the conversation list, so /chat goes straight to one. A phone has one pane at a
// time: /chat is the list, a conversation fills the screen, and a thread takes over from its channel.
import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { Hash, Layers, MessagesSquare, Plus, User, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, EmptyState, LoadError } from "@/components/kit";
import { AgentMark } from "@/components/workspace/agent-mark";
import { isGuest, useMe } from "@/base/session";
import { useIsMobile } from "@/hooks/use-mobile";
import { api, type ConversationRow } from "@/lib/api";
import { dmTitle, openNewChannel, openNewDm, useConversations } from "@/lib/chat/client";
import type { Row } from "@/lib/chat/log";
import { mySpaces, useEntityQuery, useMySpaceIds } from "@/lib/data";
import { shellToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Conversation } from "./conversation";

const LAST = "commons.chat.last";
const remember = (id: number) => { try { sessionStorage.setItem(LAST, String(id)); } catch { /* storage off */ } };
const recall = () => { try { return Number(sessionStorage.getItem(LAST)) || null; } catch { return null; } };

function Line({ c, me }: { c: ConversationRow; me: number }) {
  const others = c.members.filter((m) => m.user_id !== me);
  const agent = c.kind === "dm" && others.length === 1 && others[0].kind === "agent";
  const Icon = c.kind === "channel" ? Hash : others.length > 1 ? Users : User;
  return (
    <li>
      <Link to={`/chat/${c.id}`} data-testid="chat-line" className="focus-ring-inset flex min-h-11 items-center gap-2.5 px-4 hover:bg-muted/50">
        {agent ? <Avatar name={others[0].name} kind="agent" size="xs" decorative /> : <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
        <span className={cn("min-w-0 flex-1 truncate text-body", c.unread > 0 ? "font-medium" : "text-muted-foreground")}>{c.kind === "dm" ? dmTitle(c, me) : c.name}</span>
        {agent && <AgentMark />}
        {c.mentions > 0 ? <span className="rounded-full bg-primary px-1.5 text-micro font-medium text-primary-foreground tabular-nums">{c.mentions}</span>
          : c.unread > 0 ? <span className="text-caption text-muted-foreground tabular-nums">{c.unread}<span className="sr-only"> unread</span></span> : null}
      </Link>
    </li>
  );
}

function Heading({ children, action }: { children: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex min-h-9 items-center justify-between px-4 pt-3">
      <h2 className="min-w-0 truncate text-caption text-muted-foreground">{children}</h2>
      {action && <Button variant="ghost" size="icon-sm" aria-label={action.label} onClick={action.onClick} className="max-md:size-11"><Plus /></Button>}
    </div>
  );
}

function Nothing({ guest, inSpace }: { guest: boolean; inSpace: boolean }) {
  if (guest && !inSpace) return <div data-testid="chat-no-space" className="p-3"><EmptyState icon={Layers} className="border-0" title="You're not in a space yet" description="Ask whoever invited you to add you to one. Its channels will show up here." /></div>;
  return (
    <div data-testid="chat-empty" className="p-3">
      <EmptyState icon={MessagesSquare} className="border-0" title="No conversations yet" description="Start a channel in one of your spaces, or message someone directly."
        action={<div className="flex flex-wrap justify-center gap-2">{inSpace && <Button size="sm" onClick={() => openNewChannel()}>New channel</Button>}<Button size="sm" variant="outline" onClick={openNewDm}>New message</Button></div>} />
    </div>
  );
}

/** Every conversation, for a phone, and for a desktop with nowhere to go yet. */
function ConversationList() {
  const me = useMe()!;
  const list = useConversations();
  const spaces = useMySpaceIds();
  const known = useEntityQuery("space", ["list"], api.spaces);
  if (list.error && !list.data) return <div className="p-4"><LoadError title="Your conversations didn't load" error={list.error} onRetry={() => void list.refetch()} /></div>;
  if (!list.data) return <div aria-busy="true" aria-label="Loading conversations" className="space-y-3 p-4">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={`skeleton-${i}`} className="h-5 w-full" />)}</div>;
  const channels = list.data.filter((c) => c.kind === "channel" && spaces.includes(c.space_id));
  const dms = list.data.filter((c) => c.kind === "dm");
  if (!channels.length && !dms.length) return <Nothing guest={isGuest(me)} inSpace={spaces.length > 0} />;
  return (
    <nav aria-label="Conversations" data-testid="chat-list" className="h-full overflow-y-auto pb-3">
      <h1 className="sr-only">Chat</h1>
      {/* Every space has a "general", so a channel means nothing without its space. */}
      {(known.data ? mySpaces(known.data) : []).filter((s) => channels.some((c) => c.space_id === s.id)).map((s) => (
        <section key={s.id} aria-label={s.name}>
          <Heading action={{ label: `New channel in ${s.name}`, onClick: () => openNewChannel(s.id) }}>{s.name}</Heading>
          <ul>{channels.filter((c) => c.space_id === s.id).map((c) => <Line key={c.id} c={c} me={me.id} />)}</ul>
        </section>
      ))}
      <Heading action={{ label: "New message", onClick: openNewDm }}>Direct messages</Heading>
      {dms.length ? <ul>{dms.map((c) => <Line key={c.id} c={c} me={me.id} />)}</ul> : <p className="px-4 py-2 text-caption text-muted-foreground">Nothing yet. Press + to message someone.</p>}
    </nav>
  );
}

export function ChatIndexPage() {
  const mobile = useIsMobile();
  const list = useConversations();
  const spaces = useMySpaceIds();
  if (!mobile && list.data?.length) {
    const reachable = list.data.filter((c) => c.kind === "dm" || spaces.includes(c.space_id));
    const last = recall();
    const target = reachable.find((c) => c.id === last) ?? reachable[0];
    if (target) return <Navigate replace to={`/chat/${target.id}`} />;
  }
  return <div data-testid="chat-index" className="h-full"><ConversationList /></div>;
}

export function ChatPage() {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const mobile = useIsMobile();
  const thread = Number(params.get("thread")) || null;
  const seq = Number(params.get("seq")) || null;
  const [opening, setOpening] = useState(false);
  useEffect(() => { if (id) remember(id); }, [id]);

  const openThread = useCallback(async (row: Row) => {
    if (opening || !row.id) return;
    setOpening(true);
    try {
      const made = row.thread_id ? { id: row.thread_id } : await api.openThread("message", row.id);
      setParams((p) => { p.set("thread", String(made.id)); p.delete("seq"); return p; });
    } catch (e) {
      shellToast.error(`Couldn't open that thread. ${e instanceof Error ? e.message : "Try again."}`);
    } finally { setOpening(false); }
  }, [opening, setParams]);
  const closeThread = useCallback(() => setParams((p) => { p.delete("thread"); p.delete("seq"); return p; }), [setParams]);

  if (!Number.isInteger(id) || id <= 0) return <Navigate replace to="/chat" />;
  if (mobile && thread) return <Conversation key={`thread-${thread}`} id={thread} panel seq={seq} onClose={closeThread} />;
  return (
    <div className="grid h-full min-h-0 min-w-0" style={{ gridTemplateColumns: thread ? "minmax(0,1fr) minmax(20rem,26rem)" : "minmax(0,1fr)" }}>
      <Conversation key={id} id={id} seq={thread ? null : seq} onReply={(row) => void openThread(row)} backHref="/chat" />
      {thread && <div className="min-h-0 min-w-0 border-l"><Conversation key={`thread-${thread}`} id={thread} panel seq={seq} onClose={closeThread} /></div>}
    </div>
  );
}
