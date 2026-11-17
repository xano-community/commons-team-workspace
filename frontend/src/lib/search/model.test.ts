import { describe, expect, it } from "vitest";
import { addRecent, groupHits, marks, matches, placeOf, rankHits, snippet, toolOf, type Hit } from "./model";

const hit = (over: Partial<Hit>): Hit => ({ key: "task-1", entity: "task", entity_id: 1, title: "", body: "", href: "/tasks/1", scope: "space-1", changed_at: 0, place: null, place_kind: null, ...over });

describe("search order", () => {
  it("puts the exact title first, then a title that starts with it, then the newest", () => {
    const ranked = rankHits([
      hit({ key: "a", title: "Notes on the launch plan", changed_at: 9 }),
      hit({ key: "b", title: "something else", body: "launch plan", changed_at: 10 }),
      hit({ key: "c", title: "Launch plan B", changed_at: 1 }),
      hit({ key: "d", title: "Launch plan", changed_at: 2 }),
    ], "launch plan");
    expect(ranked.map((h) => h.key)).toEqual(["d", "c", "a", "b"]);
  });
  it("keeps the five tools in one order, whatever came first", () => {
    const groups = groupHits([hit({ entity: "file" }), hit({ entity: "deal" }), hit({ entity: "doc" }), hit({ entity: "task" }), hit({ entity: "message" })]);
    expect(groups.map(([g]) => g)).toEqual(["Chat", "Tasks", "Docs", "Customers", "Files"]);
  });
  it("files every record under the tool that shows it", () => {
    expect(["conversation", "project", "contact", "crm_note", "space"].map(toolOf)).toEqual(["Chat", "Tasks", "Customers", "Customers", "Spaces"]);
  });
});

describe("what a row says", () => {
  it("shows the words around a match, marked where it was cut", () => {
    const body = `${"x ".repeat(60)}the needle is here ${"y ".repeat(60)}`;
    const line = snippet(hit({ title: "A doc", body }), "needle");
    expect(line).toContain("needle");
    expect(line.startsWith("…")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
  });
  it("says nothing when the title already is the body, or the match was in the title", () => {
    expect(snippet(hit({ title: "Same words", body: "Same words here" }), "same")).toBe("");
    expect(snippet(hit({ title: "Needle", body: "other words" }), "needle")).toBe("");
  });
  it("marks each word, and a search full of regex can't break it", () => {
    expect(marks("Fix the Hero crop", "hero crop").filter((m) => m.hit).map((m) => m.text)).toEqual(["Hero", "crop"]);
    expect(marks("a (b) c", "(b")).toEqual(expect.arrayContaining([{ text: "(b", hit: true }]));
  });
  it("names a channel, and calls a DM and a thread what they are", () => {
    expect(placeOf({ entity: "message", place: "general", place_kind: "channel" })).toBe("#general");
    expect(placeOf({ entity: "message", place: "", place_kind: "dm" })).toBe("Direct message");
    expect(placeOf({ entity: "message", place: "Thread", place_kind: "thread" })).toBe("In a thread");
    expect(placeOf({ entity: "task", place: null, place_kind: null })).toBeUndefined();
  });
  it("finds a static command by every word, in any field", () => {
    expect(matches("new task", "New task", "Actions")).toBe(true);
    expect(matches("task go", "Tasks", "Go to")).toBe(true);
    expect(matches("nothing", "Tasks")).toBe(false);
  });
});

describe("recents", () => {
  it("keeps the newest first, each record once, and only a handful", () => {
    let list = addRecent([], { type: "task", id: 1, href: "/tasks/1" });
    for (let i = 2; i < 10; i++) list = addRecent(list, { type: "task", id: i, href: `/tasks/${i}` });
    list = addRecent(list, { type: "task", id: 7, href: "/tasks/7" });
    expect(list[0].id).toBe(7);
    expect(list.filter((r) => r.id === 7)).toHaveLength(1);
    expect(list).toHaveLength(6);
  });
});
