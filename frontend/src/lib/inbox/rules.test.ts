import { describe, expect, it } from "vitest";
import { byRecord, emptyState, enterOpens, heldLine, lineOf, neighbour, sections, visibleItems, type InboxLine } from "./rules";

const line = (id: number, extra: Partial<InboxLine> = {}): InboxLine => ({ id, needs_action: false, done_at: null, read_at: null, ...extra });

describe("the inbox list", () => {
  it("puts what needs a decision first, under its own heading", () => {
    const out = sections([line(1), line(2, { needs_action: true }), line(3)]);
    expect(out.map((s) => s.label)).toEqual(["Needs a decision", "Recent"]);
    expect(out[0].items.map((i) => i.id)).toEqual([2]);
    expect(out[1].items.map((i) => i.id)).toEqual([1, 3]);
  });

  it("drops an empty section, and leaves one heading out when there's only one kind", () => {
    expect(sections([line(1)])).toEqual([{ label: "", items: [line(1)] }]);
    expect(sections([])).toEqual([]);
  });

  it("hides a line the moment it's cleared, before the server answers", () => {
    expect(visibleItems([line(1, { done_at: 5 }), line(2)]).map((i) => i.id)).toEqual([2]);
  });

  it("moves to the next line when one is cleared, or back from the last", () => {
    const items = [line(1), line(2), line(3)];
    expect(neighbour(items, 2)).toBe(3);
    expect(neighbour(items, 3)).toBe(2);
    expect(neighbour([line(1)], 1)).toBeNull();
  });
});

describe("the open line", () => {
  it("stays on screen when reading it took it out of the list, as a DM does", () => {
    const dm = line(7);
    expect(heldLine([], 7, dm)).toBe(dm);
  });
  it("prefers the fresh row, and lets go of a line that's no longer selected", () => {
    const fresh = line(7, { read_at: 5 });
    expect(heldLine([fresh], 7, line(7))).toBe(fresh);
    expect(heldLine([], 8, line(7))).toBeNull();
    expect(heldLine([], null, line(7))).toBeNull();
  });
});

describe("Enter", () => {
  const el = (html: string) => { const box = document.createElement("div"); box.innerHTML = html; return box.firstElementChild; };
  it("opens from a row or from nowhere in particular", () => {
    expect(enterOpens(document.body)).toBe(true);
    expect(enterOpens(el('<button data-kit="notification"></button>'))).toBe(true);
  });
  it("leaves a focused button or link to do its own job", () => {
    expect(enterOpens(el("<button>Clear</button>"))).toBe(false);
    expect(enterOpens(el('<a href="/x">x</a>'))).toBe(false);
  });
});

describe("which empty state a person sees", () => {
  const base = { ever: 0, open: 0, shown: 0, filtered: false, guestWithoutSpaces: false };
  it("tells never having had anything from having finished everything", () => {
    expect(emptyState(base)).toBe("never");
    expect(emptyState({ ...base, ever: 4 })).toBe("done");
  });
  it("says nothing matched when a filter hides what's there", () => {
    expect(emptyState({ ...base, ever: 4, open: 2, filtered: true })).toBe("no-match");
  });
  it("says so when a guest isn't in a space yet", () => {
    expect(emptyState({ ...base, guestWithoutSpaces: true })).toBe("no-space");
  });
  it("is nothing while there are rows to show", () => {
    expect(emptyState({ ...base, ever: 4, open: 2, shown: 2 })).toBeNull();
  });
});

describe("what a line says", () => {
  const n = (kind: string, title: string, actor_name: string | null = "Scout") => ({ kind, title, actor_name });
  const said = (l: { who: string; did: string; what: string }) => [l.who, l.did, l.what].filter(Boolean).join(" ");
  const live = (title: string) => ({ state: "live" as const, title });

  it("says what finished", () => {
    expect(said(lineOf(n("agent_result", "Scout finished"), live("Renewal summary")))).toBe("Scout finished Renewal summary");
    expect(said(lineOf(n("agent_result", "Scout couldn't finish"), live("Renewal summary")))).toBe("Scout couldn't finish Renewal summary");
  });
  it("says where something was said", () => {
    expect(said(lineOf(n("reply", "Scout replied"), live("marlow-oakline")))).toBe("Scout replied in marlow-oakline");
    expect(said(lineOf(n("mention", "Scout mentioned you"), live("Renewal summary")))).toBe("Scout mentioned you in Renewal summary");
  });
  it("says a thread's channel once", () => {
    expect(said(lineOf(n("reply", "Scout replied"), live("Thread in marlow-launch")))).toBe("Scout replied in marlow-launch");
  });
  it("puts a doc's name where a phrase said only a doc, which stores no actor's name", () => {
    expect(said(lineOf(n("mention", "mentioned you in a doc"), live("Renewal summary")))).toBe("Scout mentioned you in Renewal summary");
  });
  it("names what was given", () => {
    expect(said(lineOf(n("assigned", "Ada assigned you a task", "Ada"), live("Call Riley")))).toBe("Ada assigned you a task: Call Riley");
  });
  it("adds no name to a direct message, whose record is only called that", () => {
    expect(said(lineOf(n("dm", "Scout sent you a message"), live("Direct message")))).toBe("Scout sent you a message");
  });
  it("keeps the words of a line nobody did", () => {
    expect(lineOf(n("space", "You were added to a space", null), live("Marlow"))).toMatchObject({ who: "", did: "You were added to a space:", what: "Marlow" });
  });
  it("says no name for a record that has none for this reader", () => {
    for (const state of ["locked", "deleted", "tombstone"] as const) expect(lineOf(n("agent_result", "Scout finished"), { state, title: "" }).what).toBe("");
    expect(said(lineOf(n("agent_result", "Scout finished")))).toBe("Scout finished");
  });
  it("says an archived record's name", () => {
    expect(lineOf(n("agent_result", "Scout finished"), { state: "archived", title: "Old brief" }).what).toBe("Old brief");
  });
});

describe("grouping the bell", () => {
  const item = (id: number, entity: string, entity_id: number, extra: Partial<InboxLine & { group_count: number; kind: string }> = {}) => ({ ...line(id), entity, entity_id, group_count: 1, kind: "reply", ...extra });

  it("folds what happened to one record into its newest line, with the count", () => {
    const out = byRecord([item(9, "conversation", 4, { kind: "agent_result" }), item(8, "conversation", 4, { group_count: 2 }), item(7, "conversation", 4, { kind: "mention" })]);
    expect(out).toHaveLength(1);
    expect(out[0].line.id).toBe(9);
    expect(out[0].count).toBe(4);
    expect(out[0].lines.map((l) => l.id)).toEqual([9, 8, 7]);
  });
  it("keeps the order of what's left, and records apart", () => {
    const out = byRecord([item(9, "doc", 1), item(8, "task", 1), item(7, "doc", 1), item(6, "doc", 2)]);
    expect(out.map((g) => g.line.id)).toEqual([9, 8, 6]);
  });
  it("counts a group as unread while any line in it is", () => {
    const out = byRecord([item(9, "doc", 1, { read_at: 5 }), item(8, "doc", 1)]);
    expect(out[0].unread).toBe(true);
    expect(byRecord([item(9, "doc", 1, { read_at: 5 })])[0].unread).toBe(false);
  });
  it("never folds what needs a decision, or a line about no record", () => {
    expect(byRecord([item(9, "doc", 1, { needs_action: true }), item(8, "doc", 1)])).toHaveLength(2);
    expect(byRecord([item(9, "", 0), item(8, "", 0)])).toHaveLength(2);
  });
});
