// The first minute (F1): where a sign-in lands, who sees the model key command, and opening a second demo person in a second
// window. The rules are plain functions, so each is tested alone; the hooks are the few lines that read them into a screen.
import { useEffect, useState } from "react";
import { AppWindow } from "lucide-react";
import { baseApi, type Me, type Persona } from "@/base/api";
import type { DemoData } from "../../../xano/query/members.js";
import { useCan } from "@/base/access";
import { useWorkspace } from "@/base/workspace";

/**
 * Where a sign-in goes. An address someone was sent to wins. Otherwise a demo opens on the inbox, where the agent's request is
 * waiting, and a real account on the overview.
 */
export function landingAfterSignIn(from: string | null | undefined, demo: boolean): string {
  if (from && from !== "/" && from.startsWith("/") && !from.startsWith("/sign-in")) return from;
  return demo ? "/inbox?item=first" : "/";
}

/** The model key command shows to everyone while the workspace is a demo, and to admins only afterwards. */
export const showsKeyCommand = (o: { demoMode: boolean; admin: boolean }) => o.demoMode || o.admin;

/** Reads the key command rule for the person signed in. A guest reads no settings, so a guest never gets the command. */
export function useShowsKeyCommand(): boolean {
  const { settings } = useWorkspace();
  const admin = useCan("team.manage");
  return showsKeyCommand({ demoMode: !!settings?.demo_mode, admin });
}

/** The sign-in page's address that signs this window in as `persona`, then opens `to`. */
export function openAsHref(persona: string, to: string): string {
  const q = new URLSearchParams({ as: persona });
  if (to && to !== "/") q.set("to", to);
  return `/sign-in?${q}`;
}

/** Reads `?as=` and `?to=` off the sign-in page's address. */
export function readOpenAs(search: string): { as: string; to: string } | null {
  const q = new URLSearchParams(search);
  const as = q.get("as");
  if (!as) return null;
  const to = q.get("to") ?? "";
  return { as, to: to.startsWith("/") && !to.startsWith("//") ? to : "" };
}

/** The other demo people this one can open beside them: everyone but themselves. */
export const otherPersonas = (personas: readonly Persona[], me: Pick<Me, "name">) => personas.filter((p) => p.label !== me.name);

/**
 * A new window on its own session, so two windows of one browser are two people (R33). `noopener` gives it empty session
 * storage, so it can't start as whoever opened it.
 */
export function openAs(persona: string, to: string) {
  window.open(openAsHref(persona, to), "_blank", "noopener");
}

/** "Open as Avery in a new window", for each other demo person, while this person is a demo person. */
export function useOpenAsItems(me: Me | null) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const demo = !!me?.is_demo;
  useEffect(() => {
    if (!demo) { setPersonas([]); return; }
    let live = true;
    baseApi.personas().then((list) => { if (live) setPersonas(list); }, () => { if (live) setPersonas([]); });
    return () => { live = false; };
  }, [demo]);
  if (!me || !demo) return [];
  return otherPersonas(personas, me).map((p) => ({
    // The menu is as narrow as the sidebar, so it says the short form, beside a window icon. The command palette says it in full.
    label: `Open as ${p.label.split(" ")[0]}`, longLabel: `Open as ${p.label.split(" ")[0]} in a new window`, icon: AppWindow, kit: `open-as-${p.key}`,
    onSelect: () => openAs(p.key, `${location.pathname}${location.search}`),
  }));
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const listed = (parts: string[]) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);
const some = (pairs: [n: number, one: string, many: string][]) => listed(pairs.filter(([n]) => n > 0).map(([n, one, many]) => counted(n, one, many)));

/** What Clear demo data will do, a line per kind, for its confirm dialog. Empty when there's nothing left to clear. */
export function demoDataLines(d: DemoData): string[] {
  const lines = [
    some([[d.spaces, "space", "spaces"], [d.conversations, "conversation", "conversations"], [d.messages, "message", "messages"]]),
    some([[d.tasks, "task", "tasks"], [d.docs, "doc", "docs"], [d.files, "file", "files"]]),
    some([[d.customers, "customer record", "customer records"]]),
  ].filter(Boolean).map((l) => `${l} removed`);
  const off = some([[d.people, "demo person", "demo people"], [d.agents, "demo agent", "demo agents"]]);
  if (off) lines.push(`${off} switched off`);
  return lines;
}

/**
 * Whether the overview's checklist shows. Someone who arrives with every step already done has nothing to learn from it, so
 * it stays away. Someone who finishes it here sees it complete, once, until they hide it.
 */
export const checklistShows = (o: { total: number; done: number; openedBefore: boolean }) => o.total > 0 && (o.done < o.total || o.openedBefore);
