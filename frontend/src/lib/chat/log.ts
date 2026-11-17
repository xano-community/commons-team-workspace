// One conversation's messages, as plain data. Nothing here touches the network or React, so every rule that keeps a message
// from vanishing, doubling or jumping can be tested alone. The answers to a send, a hint and a catch-up can land in any
// order, so each merge is idempotent: rows are matched on `client_msg_id`, ordered by `seq`, and the highest version wins.
import type { MessageView } from "../../../../xano/query/messages.js";
import type { Outgoing } from "./outbox";

export type ServerMessage = MessageView;
export type Page = { items: ServerMessage[]; last_seq: number; last_version: number; has_older: boolean; has_newer: boolean };

export type Row = {
  /** Stable from pending to confirmed, so a row never remounts and the list never jumps. */
  key: string;
  id: number | null;
  seq: number | null;
  version: number;
  author_id: number;
  author_name: string;
  author_kind: "human" | "agent";
  body: string;
  /** The files it carries. */
  files: number[];
  created_at: number;
  edited: boolean;
  deleted: boolean;
  thread_id: number;
  reply_count: number;
  /** A progress note from an agent's run: it reads quieter than something said to the room. */
  note: boolean;
  /** Who said yes to an agent's message, and the app a person's connection speaks through. */
  approver: string;
  via: string;
  /** Set while it exists only here. */
  local?: Outgoing["state"];
  reason?: string;
};

export type Log = { rows: Row[]; lastSeq: number; version: number; hasOlder: boolean; hasNewer: boolean };
export const emptyLog = (): Log => ({ rows: [], lastSeq: 0, version: 0, hasOlder: false, hasNewer: false });

export const toRow = (m: ServerMessage): Row => ({
  key: m.client_msg_id, id: m.id, seq: m.seq, version: m.version, author_id: m.author_id, author_name: m.author_name ?? "Someone", author_kind: m.author_kind ?? "human",
  body: m.body, files: Array.isArray(m.file_ids) ? (m.file_ids as number[]) : [], created_at: Number(m.created_at), edited: !!m.edited_at, deleted: !!m.deleted_at, thread_id: m.thread_id, reply_count: m.reply_count, note: !!m.run_note, approver: m.approver_name ?? "", via: m.via ?? "",
});

function upsert(rows: Row[], incoming: Row[]): Row[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const row of incoming) {
    const held = byKey.get(row.key);
    if (!held || row.version >= held.version) byKey.set(row.key, row);
  }
  return [...byKey.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/** A fresh window: the newest page, or the one around a message. What's loaded is replaced. */
export const mergePage = (_log: Log, page: Page): Log => ({
  rows: upsert([], page.items.map(toRow)), lastSeq: page.last_seq, version: page.last_version, hasOlder: page.has_older, hasNewer: page.has_newer,
});

export const mergeOlder = (log: Log, page: Page): Log => ({
  ...log, rows: upsert(log.rows, page.items.map(toRow)), hasOlder: page.has_older, lastSeq: Math.max(log.lastSeq, page.last_seq),
});

export const mergeNewer = (log: Log, page: Page): Log => ({
  ...log, rows: upsert(log.rows, page.items.map(toRow)), hasNewer: page.has_newer, lastSeq: Math.max(log.lastSeq, page.last_seq),
});

/** Everything changed since `log.version`. A row outside the window that's loaded waits until someone scrolls to it. */
export function mergeDelta(log: Log, page: Pick<Page, "items" | "last_seq">): Log {
  const oldest = log.rows[0]?.seq ?? 0;
  const newest = log.rows.at(-1)?.seq ?? 0;
  const inWindow = page.items.filter((m) => !(log.hasOlder && m.seq < oldest) && !(log.hasNewer && m.seq > newest));
  return {
    ...log,
    rows: upsert(log.rows, inWindow.map(toRow)),
    lastSeq: Math.max(log.lastSeq, page.last_seq),
    version: Math.max(log.version, ...page.items.map((m) => m.version)),
  };
}

/** The sender's own answer, which may land before or after the hint for it. */
export const mergeOne = (log: Log, m: ServerMessage): Log => (log.hasNewer ? { ...log, lastSeq: Math.max(log.lastSeq, m.seq) } : {
  ...log, rows: upsert(log.rows, [toRow(m)]), lastSeq: Math.max(log.lastSeq, m.seq),
});

/** An optimistic change to one confirmed row. */
export const patchRow = (log: Log, key: string, patch: Partial<Row>): Log => ({ ...log, rows: log.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });

/** What the list draws: what's confirmed, then what's still leaving, in send order. A row that has landed shows once. */
export function visibleRows(log: Log, outgoing: Outgoing[], me: { id: number; name: string }): Row[] {
  const known = new Set(log.rows.map((r) => r.key));
  const pending = outgoing.filter((o) => !known.has(o.key)).map((o): Row => ({
    key: o.key, id: null, seq: null, version: 0, author_id: me.id, author_name: me.name, author_kind: "human", body: o.body, files: o.fileIds ?? [], created_at: o.at,
    edited: false, deleted: false, thread_id: 0, reply_count: 0, note: false, approver: "", via: "", local: o.state, reason: o.reason,
  }));
  return pending.length ? [...log.rows, ...pending] : log.rows;
}

/** Where the unread line goes, fixed for the visit: only if someone else wrote after what this person had read. */
export const unreadDivider = (rows: Row[], lastRead: number, me: number): number | null =>
  rows.some((r) => r.seq !== null && r.seq > lastRead && r.author_id !== me && !r.deleted) ? lastRead : null;

const GROUP_MS = 5 * 60_000;
const dayOf = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

export type ListItem =
  | { kind: "day"; key: string; at: number }
  | { kind: "unread"; key: "unread" }
  | { kind: "beginning"; key: "beginning" }
  | { kind: "message"; key: string; row: Row; grouped: boolean };

/** Rows, with day lines, the unread line and grouping worked out at render, so nothing derived is ever stored. */
export function buildRows(rows: Row[], dividerSeq: number | null, atBeginning = false): ListItem[] {
  // A row like any other, so arriving at the very top moves nothing on screen.
  const items: ListItem[] = atBeginning ? [{ kind: "beginning", key: "beginning" }] : [];
  let previous: Row | null = null;
  let dividerDone = dividerSeq === null;
  for (const row of rows) {
    let broken = false;
    const day = dayOf(row.created_at);
    if (!previous || dayOf(previous.created_at) !== day) { items.push({ kind: "day", key: `day-${day}`, at: row.created_at }); broken = true; }
    if (!dividerDone && row.seq !== null && row.seq > dividerSeq!) { items.push({ kind: "unread", key: "unread" }); dividerDone = true; broken = true; }
    const grouped = !broken && !!previous && previous.author_id === row.author_id && row.created_at - previous.created_at < GROUP_MS && !previous.deleted && !row.deleted;
    items.push({ kind: "message", key: row.key, row, grouped });
    previous = row;
  }
  return items;
}
