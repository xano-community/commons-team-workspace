import { describe, expect, it } from "vitest";
import { buildRows, emptyLog, mergeDelta, mergeOlder, mergePage, toRow, unreadDivider, visibleRows, type Row, type ServerMessage } from "./log";

const at = (minute: number, day = 1) => Date.UTC(2026, 10, day, 9, minute);
const msg = (seq: number, over: Partial<ServerMessage> = {}): ServerMessage => ({
  id: seq + 100, seq, version: seq, client_msg_id: `c${seq}`, conversation_id: 1, author_id: 1, author_name: "Ada", author_kind: "human", body: `m${seq}`,
  created_at: at(seq), edited_at: null, deleted_at: null, thread_id: 0, reply_count: 0, last_reply_at: null, run_id: 0, run_note: false, approved_by: 0, via: "", held: false, is_demo: false, ...over,
});
const page = (items: ServerMessage[], extra = {}) => ({ items, last_seq: items.at(-1)?.seq ?? 0, last_version: items.at(-1)?.version ?? 0, has_older: false, has_newer: false, ...extra });
const seqs = (rows: Row[]) => rows.map((r) => r.seq);

describe("merging what the server says", () => {
  it("keeps one row per message, however often it's told, ordered by seq", () => {
    let log = mergePage(emptyLog(), page([msg(2), msg(3)]));
    log = mergeDelta(log, page([msg(1, { version: 9 }), msg(3)]));
    log = mergeDelta(log, page([msg(3)]));
    expect(seqs(log.rows)).toEqual([1, 2, 3]);
  });

  it("lets the highest version win, whichever order the answers land in", () => {
    let log = mergePage(emptyLog(), page([msg(1)]));
    log = mergeDelta(log, page([msg(1, { version: 5, body: "newest" })]));
    log = mergeDelta(log, page([msg(1, { version: 3, body: "stale" })]));
    expect(log.rows[0].body).toBe("newest");
    expect(log.version).toBe(5);
  });

  it("shows a delete as a tombstone with no text", () => {
    let log = mergePage(emptyLog(), page([msg(1)]));
    log = mergeDelta(log, page([msg(1, { version: 2, body: "", deleted_at: at(9) })]));
    expect(log.rows[0]).toMatchObject({ body: "", deleted: true });
  });

  it("leaves out a change to something older than what's loaded, and keeps paging from where it was", () => {
    let log = mergePage(emptyLog(), page([msg(5), msg(6)], { has_older: true }));
    log = mergeDelta(log, page([msg(2, { version: 9 })]));
    expect(seqs(log.rows)).toEqual([5, 6]);
    expect(log.version).toBe(9);
    expect(log.hasOlder).toBe(true);
  });

  it("adds older rows in front, and stops when there are none", () => {
    let log = mergePage(emptyLog(), page([msg(3), msg(4)], { has_older: true }));
    log = mergeOlder(log, page([msg(1), msg(2)], { has_older: false }));
    expect(seqs(log.rows)).toEqual([1, 2, 3, 4]);
    expect(log.hasOlder).toBe(false);
  });

  it("while reading an old window, notes newer messages without jumping to them", () => {
    let log = mergePage(emptyLog(), page([msg(5)], { has_newer: true, last_seq: 9 }));
    log = mergeDelta(log, page([msg(10, { version: 10 })], { last_seq: 10 }));
    expect(seqs(log.rows)).toEqual([5]);
    expect(log.lastSeq).toBe(10);
    expect(log.hasNewer).toBe(true);
  });
});

describe("what a screen shows", () => {
  const sending = { key: "c9", conversationId: 1, body: "typed", at: at(20), state: "sending" as const };

  it("puts a pending message after confirmed ones, in send order", () => {
    const log = mergePage(emptyLog(), page([msg(1), msg(2)]));
    const rows = visibleRows(log, [sending, { ...sending, key: "c10", body: "next" }], { id: 1, name: "Ada" });
    expect(rows.map((r) => r.key)).toEqual(["c1", "c2", "c9", "c10"]);
    expect(rows[2]).toMatchObject({ local: "sending", author_id: 1 });
  });

  it("never shows a message twice once its confirmed row has arrived, and keeps the same key", () => {
    const log = mergePage(emptyLog(), page([msg(1), msg(9, { client_msg_id: "c9" })]));
    const rows = visibleRows(log, [sending], { id: 1, name: "Ada" });
    expect(rows.map((r) => r.key)).toEqual(["c1", "c9"]);
    expect(rows[1].local).toBeUndefined();
  });

  it("groups by author within five minutes, and an agent never merges into a person", () => {
    const rows = [msg(1), msg(2), msg(3, { created_at: at(9) }), msg(4, { author_id: 2, author_kind: "agent", created_at: at(9) })].map(toRow);
    const built = buildRows(rows, null).filter((r) => r.kind === "message");
    expect(built.map((r) => r.kind === "message" && r.grouped)).toEqual([false, true, false, false]);
  });

  it("starts a new group on a new day, and puts a day line there", () => {
    const rows = [msg(1), msg(2, { created_at: at(2, 2) })].map(toRow);
    const built = buildRows(rows, null);
    expect(built.map((r) => r.kind)).toEqual(["day", "message", "day", "message"]);
    expect(built[3]).toMatchObject({ grouped: false });
  });

  it("puts the unread line before the first unread message, and it breaks a group", () => {
    const rows = [msg(1), msg(2), msg(3)].map(toRow);
    const built = buildRows(rows, 1);
    expect(built.map((r) => r.kind)).toEqual(["day", "message", "unread", "message", "message"]);
    expect(built[3]).toMatchObject({ grouped: false });
  });

  it("starts with the conversation's beginning only once the top is loaded, as a row, so its arrival can't shift the list", () => {
    const rows = [msg(1)].map(toRow);
    expect(buildRows(rows, null, true)[0]).toEqual({ kind: "beginning", key: "beginning" });
    expect(buildRows(rows, null, false)[0].kind).toBe("day");
    expect(buildRows([], null, true)).toEqual([{ kind: "beginning", key: "beginning" }]);
  });

  it("keeps a row's key from pending to confirmed, so it never remounts", () => {
    const pending = visibleRows(emptyLog(), [sending], { id: 1, name: "Ada" });
    const confirmed = visibleRows(mergePage(emptyLog(), page([msg(9, { client_msg_id: "c9" })])), [], { id: 1, name: "Ada" });
    const key = (rows: Row[]) => buildRows(rows, null).at(-1)!.key;
    expect(key(pending)).toBe(key(confirmed));
  });
});

describe("the unread line's place", () => {
  it("is fixed from the position on opening, and only when someone else wrote after it", () => {
    const rows = [msg(1), msg(2, { author_id: 2 })].map(toRow);
    expect(unreadDivider(rows, 1, 1)).toBe(1);
    expect(unreadDivider(rows, 2, 1)).toBeNull();
    expect(unreadDivider([msg(1), msg(2)].map(toRow), 1, 1)).toBeNull();
  });
});
