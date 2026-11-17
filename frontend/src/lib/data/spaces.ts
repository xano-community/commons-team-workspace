// The sidebar's Spaces section, and which space the tool views are scoped to. A space is a URL parameter on the current
// tool: choosing one keeps you on Tasks and narrows it, choosing it again clears it, and a link or a refresh keeps it.
import { useMemo } from "react";
import { Bot, Hash, Layers, Lock, Plus, User, Users } from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import type { NavGroup, NavItem } from "@/components/kit";
import { api, type ConversationRow, type SpaceList } from "@/lib/api";
import { useLive } from "@/base/live";
import { useMe } from "@/base/session";
import { dmTitle, openNewChannel, openNewDm, useConversations } from "@/lib/chat/client";
import { useEntityQuery } from "./hooks";

const PARAM = "space";
/** A private space is private from its non-members, not from the workspace's admins. People should know that. */
export const PRIVATE_SPACE_LABEL = "Admins can see this space";

const OPEN_MEMBERS = "commons:space-members";
export const openSpaceMembers = (id: number) => window.dispatchEvent(new CustomEvent(OPEN_MEMBERS, { detail: id }));
export function onOpenSpaceMembers(fn: (id: number) => void) {
  const on = (e: Event) => fn((e as CustomEvent<number>).detail);
  window.addEventListener(OPEN_MEMBERS, on);
  return () => window.removeEventListener(OPEN_MEMBERS, on);
}

type AddResult = { added: boolean; warning: string | null };
/**
 * Adding a guest can show them a space's past, so the server won't do it until someone has seen why. It answers with a
 * `warning` and changes nothing; `confirm` shows that, and only a yes sends `history_ok`.
 */
export async function addSpaceMember(post: (historyOk?: boolean) => Promise<AddResult>, confirm: (warning: string) => Promise<boolean>): Promise<boolean> {
  const first = await post();
  if (first.added || !first.warning) return first.added;
  if (!(await confirm(first.warning))) return false;
  return (await post(true)).added;
}

/** The space the screen is scoped to, or null for all of them. */
export function useSpaceScope(): number | null {
  const [params] = useSearchParams();
  const id = Number(params.get(PARAM));
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function spaceHref(pathname: string, search: string, id: number): string {
  const params = new URLSearchParams(search);
  if (params.get(PARAM) === String(id)) params.delete(PARAM);
  else params.set(PARAM, String(id));
  params.delete("page");
  const q = params.toString();
  return q ? `${pathname}?${q}` : pathname;
}

/** The sidebar lists the spaces this person is in. Open spaces they could join aren't theirs yet. */
export const mySpaces = ({ spaces, memberships }: SpaceList) => {
  const joined = new Set(memberships.map((m) => m.space_id));
  return spaces.filter((s) => joined.has(s.id) && !s.archived_at);
};

/** One conversation's row in the sidebar: bold while unread, and the count is what's waiting for this person. */
const conversationItem = (c: ConversationRow, label: string, icon: NavItem["icon"]): NavItem => ({ href: `/chat/${c.id}`, label, icon, unread: c.unread > 0, badge: c.mentions });

export const spaceSection = (list: SpaceList | undefined, scope: number | null, loading: boolean, choose: (id: number) => void, conversations: ConversationRow[] = []): NavGroup => ({
  key: "spaces",
  label: "Spaces",
  loading,
  items: (list ? mySpaces(list) : []).map((s) => ({
    href: `?${PARAM}=${s.id}`, label: s.name, icon: Layers, active: s.id === scope, onSelect: () => choose(s.id),
    mark: s.visibility === "private" ? { icon: Lock, label: PRIVATE_SPACE_LABEL } : undefined,
    action: { label: "Members", icon: Users, onClick: () => openSpaceMembers(s.id) },
    extra: { label: "New channel", icon: Plus, onClick: () => openNewChannel(s.id) },
    children: conversations.filter((c) => c.kind === "channel" && c.space_id === s.id).map((c) => conversationItem(c, c.name, Hash)),
  })),
});

/** Newest first. A DM names the others, and an agent's shows as one. */
export const dmSection = (conversations: ConversationRow[], me: number): NavGroup => ({
  key: "dms",
  label: "Direct messages",
  action: { label: "New message", icon: Plus, onClick: openNewDm },
  items: conversations.filter((c) => c.kind === "dm").sort((a, b) => Number(b.last_message_at ?? b.created_at) - Number(a.last_message_at ?? a.created_at)).map((c) => {
    const others = c.members.filter((m) => m.user_id !== me);
    const agent = others.length === 1 && others[0].kind === "agent";
    return { ...conversationItem(c, dmTitle(c, me), agent ? Bot : others.length > 1 ? Users : User), agent };
  }),
});

const useSpaces = () => useEntityQuery("space", ["list"], api.spaces);
/** Every space this person can see: an admin sees them all. */
export const useAllSpaces = useSpaces;

/** The spaces whose live channels this tab keeps open. */
export function useMySpaceIds(): number[] {
  const { data } = useSpaces();
  return useMemo(() => (data ? mySpaces(data).map((s) => s.id) : []), [data]);
}

export function useSpacesSection(): NavGroup {
  const spaces = useSpaces();
  useLive("space_member", () => void spaces.refetch());
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const conversations = useConversations();
  return spaceSection(spaces.data, useSpaceScope(), spaces.isPending, (id) => navigate(spaceHref(pathname, search, id)), conversations.data);
}

export function useDmSection(): NavGroup {
  return dmSection(useConversations().data ?? [], useMe()?.id ?? 0);
}
