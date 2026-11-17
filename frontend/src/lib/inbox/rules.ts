// What the inbox list shows, apart from how it looks. What leaves and when is the server's: this only arranges the page.
export type InboxLine = { id: number; needs_action: boolean; done_at: number | null; read_at: number | null };
export type InboxSection<T> = { label: string; items: T[] };
export type EmptyKind = "never" | "done" | "no-match" | "no-space";

/** A cleared line goes at once, before the server has answered. */
export const visibleItems = <T extends InboxLine>(items: T[]) => items.filter((i) => !i.done_at);

/** What needs a decision goes first, under a heading. With nothing to set apart, the list needs no heading at all. */
export function sections<T extends InboxLine>(items: T[]): InboxSection<T>[] {
  const needs = items.filter((i) => i.needs_action);
  const rest = items.filter((i) => !i.needs_action);
  if (!needs.length) return rest.length ? [{ label: "", items: rest }] : [];
  return [{ label: "Needs a decision", items: needs }, ...(rest.length ? [{ label: "Recent", items: rest }] : [])];
}

type Named = { kind: string; title: string; actor_name?: string | null };
type RecordName = { state: string; title: string };
/** How a record's name joins each kind of line. Any other line says what it's about after a colon. */
const JOINS: Record<string, string> = { agent_result: "", reply: " in", mention: " in" };

/**
 * A line in words: who, what they did, and to what. The row holds only its phrase, because a record's name is the reader's to see,
 * so `what` comes from the resolver at read time and is empty for anything it won't name. A direct message has no name to give.
 */
export function lineOf(n: Named, record?: RecordName): { who: string; did: string; what: string } {
  const who = n.actor_name ?? "";
  const phrase = who && n.title.startsWith(`${who} `) ? n.title.slice(who.length + 1) : n.title;
  const what = record && (record.state === "live" || record.state === "archived") && n.kind !== "dm" ? record.title : "";
  if (!what) return { who, did: phrase, what };
  const join = JOINS[n.kind] ?? ":";
  return { who, did: `${phrase.replace(/ in a doc$/, "")}${join}`, what: join === " in" ? what.replace(/^(?:Thread|Message) in /, "") : what };
}

type Grouped = InboxLine & { entity: string; entity_id: number; group_count: number };
export type RecordGroup<T> = { line: T; lines: T[]; count: number; unread: boolean };

/**
 * The bell's rows: everything about one thread or record under its newest line, as the inbox counts a group, so a run that replied
 * and finished is one row. What waits for a decision stands alone, and a line about no record has nothing to share.
 */
export function byRecord<T extends Grouped>(items: T[]): RecordGroup<T>[] {
  const groups = new Map<string, RecordGroup<T>>();
  items.forEach((n, at) => {
    const key = n.entity && !n.needs_action ? `${n.entity}:${n.entity_id}` : `line:${at}`;
    const group = groups.get(key);
    if (!group) groups.set(key, { line: n, lines: [n], count: n.group_count, unread: !n.read_at });
    else {
      group.lines.push(n);
      group.count += n.group_count;
      group.unread ||= !n.read_at;
    }
  });
  return [...groups.values()];
}

/** Where the selection goes when a line leaves: the next one, or the one before the last. */
export function neighbour<T extends InboxLine>(items: T[], id: number): number | null {
  const at = items.findIndex((i) => i.id === id);
  return (items[at + 1] ?? items[at - 1])?.id ?? null;
}

/** Reading a DM takes it out of the list, so the open line outlives its row until the person moves on. */
export function heldLine<T extends InboxLine>(items: T[], selectedId: number | null, last: T | null): T | null {
  if (selectedId === null) return null;
  return items.find((i) => i.id === selectedId) ?? (last?.id === selectedId ? last : null);
}

/** Enter opens the line, unless focus is on a button or link that has its own Enter. */
export const enterOpens = (focused: Element | null) => !focused?.closest("a, button, [role=tab]") || !!focused.closest('[data-kit="notification"]');

/** Never had any, all done, nothing matched and not in a space each read differently. */
export function emptyState(o: { ever: number; open: number; shown: number; filtered: boolean; guestWithoutSpaces: boolean }): EmptyKind | null {
  if (o.shown > 0) return null;
  if (o.guestWithoutSpaces) return "no-space";
  if (o.filtered && o.open > 0) return "no-match";
  return o.ever > 0 ? "done" : "never";
}
