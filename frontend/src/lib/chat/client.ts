// The part of chat the shell needs on every screen: the conversation list behind the sidebar, and the doors to a new channel
// or DM. It stays small: the list, the composer, the outbox and the virtualizer all load with /chat.
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { Hash, Plus } from "lucide-react";
import type { PaletteItem } from "@/components/kit";
import { api, type ConversationRow } from "@/lib/api";
import { useLive } from "@/base/live";
import { useMe } from "@/base/session";
import { useEntityQuery } from "@/lib/data/hooks";
import { readStore, writeStore } from "@/lib/data/store";

export const chatLogKey = (id: number) => ["chat-log", id] as const;

type Unsent = { spaceId?: number };
const OUTBOX = "chat-outbox";
const outgoing = () => import("./outgoing");

/** Sends what's left, on any screen. With nothing on disk, which is nearly always, the outbox doesn't load at all. */
export function resumeOutbox(userId: number, name: string) {
  if (readStore<Unsent[]>(OUTBOX, userId, []).length) void outgoing().then((m) => m.chatOutboxFor(userId, name).resume());
}

/**
 * This person lost a space, or everything. Its text leaves the disk here and now, whatever else happens, and an open
 * screen's copy turns blocked so it can still be copied. With no `spaceId` that's everything.
 */
export function blockOutbox(userId: number, spaceId?: number) {
  writeStore(OUTBOX, userId, readStore<Unsent[]>(OUTBOX, userId, []).filter((o) => spaceId !== undefined && o.spaceId !== spaceId));
  void outgoing().then((m) => m.chatOutboxFor(userId).blockSpace(spaceId));
}

export type NewConversation = { kind: "channel"; spaceId?: number } | { kind: "dm" };
const NEW_CONVERSATION = "commons:new-conversation";
const ask = (detail: NewConversation) => window.dispatchEvent(new CustomEvent(NEW_CONVERSATION, { detail }));
export const openNewChannel = (spaceId?: number) => ask({ kind: "channel", spaceId });
export const openNewDm = () => ask({ kind: "dm" });
export function onNewConversation(fn: (asked: NewConversation) => void) {
  const on = (e: Event) => fn((e as CustomEvent<NewConversation>).detail);
  window.addEventListener(NEW_CONVERSATION, on);
  return () => window.removeEventListener(NEW_CONVERSATION, on);
}

/** A DM is called by who else is in it. */
export function dmTitle(c: Pick<ConversationRow, "members">, me: number): string {
  const others = c.members.filter((m) => m.user_id !== me).map((m) => m.name);
  if (!others.length) return "Just you";
  return others.length <= 2 ? others.join(", ") : `${others[0]}, ${others[1]} and ${others.length - 2} more`;
}
export const conversationTitle = (c: ConversationRow, me: number) => (c.kind === "dm" ? dmTitle(c, me) : c.name);

/** Every channel and DM this person reaches, with unread counts. Any message in them refreshes it. */
export function useConversations() {
  const list = useEntityQuery("conversation", ["list"], api.conversations);
  useLive(["message", "conversation_read", "space_member"], () => void list.refetch());
  return list;
}

/** The phone's Chat tab: how many conversations have something unread. */
export const useChatUnread = () => (useConversations().data ?? []).filter((c) => c.unread > 0).length;

/** Each conversation in ⌘K, and the two ways to start one. */
export function useChatPalette(): PaletteItem[] {
  const navigate = useNavigate();
  const me = useMe()?.id ?? 0;
  const { data } = useConversations();
  return useMemo(() => [
    { id: "chat.new-dm", label: "New message", group: "Actions", icon: Plus, run: openNewDm },
    { id: "chat.new-channel", label: "New channel", group: "Actions", icon: Plus, run: () => openNewChannel() },
    ...(data ?? []).map((c): PaletteItem => ({ id: `chat.open.${c.id}`, label: conversationTitle(c, me), group: "Conversations", icon: Hash, keywords: ["chat", "channel"], run: () => navigate(`/chat/${c.id}`) })),
  ], [data, me, navigate]);
}
