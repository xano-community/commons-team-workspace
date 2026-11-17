import { describe, expect, it } from "vitest";
import { BOARD_STATUSES, EMPTY_FILTERS, activeFilters, dueRange, filtersFromQuery, hasMore, isOpen, listGroups, projectsIn, queryOf, screenState, toRequest } from "./model";

const row = (id: number, status: string, rank: number) => ({ id, status, rank } as never);

describe("what a screen shows", () => {
  const base = { error: null, loaded: true, spaces: 1, projects: 1, ever: 3, open: 2, shown: 2, filtered: false, denied: false, archived: false };
  it("tells never had any from all done from nothing matched", () => {
    expect(screenState({ ...base, ever: 0, open: 0, shown: 0 })).toBe("never");
    expect(screenState({ ...base, open: 0, shown: 3 })).toBe("all-done");
    expect(screenState({ ...base, shown: 0, filtered: true })).toBe("no-match");
    expect(screenState(base)).toBe("ready");
  });
  it("needs a space, then a project, before anything else", () => {
    expect(screenState({ ...base, spaces: 0, projects: 0, ever: 0, open: 0, shown: 0 })).toBe("no-space");
    expect(screenState({ ...base, projects: 0, ever: 0, open: 0, shown: 0 })).toBe("no-project");
  });
  it("asks for a project in a space with none of its own, whatever other spaces hold", () => {
    const all = [{ id: 1, space_id: 2 }, { id: 2, space_id: 3 }];
    expect(projectsIn(all, 9)).toEqual([]);
    expect(projectsIn(all, 2)).toEqual([{ id: 1, space_id: 2 }]);
    expect(projectsIn(all, null)).toEqual(all);
    expect(screenState({ ...base, projects: projectsIn(all, 9).length, ever: 0, open: 0, shown: 0 })).toBe("no-project");
  });
  it("says no access before it says failed, and failed before anything cached", () => {
    expect(screenState({ ...base, denied: true, error: new Error("x") })).toBe("no-access");
    expect(screenState({ ...base, error: new Error("x"), loaded: false })).toBe("failed");
    expect(screenState({ ...base, loaded: false })).toBe("loading");
  });
  it("keeps showing what it has when a refresh fails", () => {
    expect(screenState({ ...base, error: new Error("x") })).toBe("ready");
  });
  it("never reports all done through a filter", () => {
    expect(screenState({ ...base, open: 0, shown: 1, filtered: true })).toBe("ready");
  });
});

describe("filters", () => {
  it("round-trips through the URL's words, and a saved filter's query", () => {
    const f = { ...EMPTY_FILTERS, q: "brief", assignee: "12", due: "overdue", project: "3" };
    expect(filtersFromQuery(queryOf(f))).toEqual(f);
    expect(queryOf(EMPTY_FILTERS)).toEqual({});
  });
  it("ignores anything a saved filter or a link shouldn't hold", () => {
    expect(filtersFromQuery({ due: "someday", priority: "huge", status: "gone", assignee: "x", project: "-1", q: 7 } as never)).toEqual(EMPTY_FILTERS);
  });
  it("counts what's on, and not the space or the view", () => {
    expect(activeFilters(EMPTY_FILTERS)).toBe(0);
    expect(activeFilters({ ...EMPTY_FILTERS, q: "a", priority: "high" })).toBe(2);
  });
  it("turns due words into this person's own days", () => {
    const now = new Date(2026, 10, 5, 23, 30);
    expect(dueRange("overdue", now)).toEqual({ due_to: "2026-11-04" });
    expect(dueRange("today", now)).toEqual({ due_from: "2026-11-05", due_to: "2026-11-05" });
    expect(dueRange("week", now)).toEqual({ due_from: "2026-11-05", due_to: "2026-11-12" });
    expect(dueRange("none", now)).toEqual({ no_due: true });
    expect(dueRange("", now)).toEqual({});
  });
  it("asks for me as this person, and nobody as -1", () => {
    expect(toRequest({ ...EMPTY_FILTERS, assignee: "me" }, { space: 4, me: 9, limit: 100 }, new Date()).assignee_id).toBe(9);
    expect(toRequest({ ...EMPTY_FILTERS, assignee: "none" }, { space: null, me: 9, limit: 100 }, new Date()).assignee_id).toBe(-1);
    expect(toRequest({ ...EMPTY_FILTERS, project: "7" }, { space: 4, me: 9, limit: 100 }, new Date())).toMatchObject({ project_id: 7, space_id: 4 });
  });
});

describe("the list's groups", () => {
  const rows = [row(1, "done", 1), row(2, "todo", 5), row(3, "todo", 2), row(4, "in_progress", 1), row(5, "cancelled", 1)];
  it("puts work under way first, in rank order, and holds finished work back until asked", () => {
    const groups = listGroups(rows, false);
    expect(groups.map((g) => g.status)).toEqual(["in_progress", "todo"]);
    expect(groups[1].items.map((t) => t.id)).toEqual([3, 2]);
    expect(listGroups(rows, true).map((g) => g.status)).toEqual(["in_progress", "todo", "done", "cancelled"]);
  });
  it("knows what's open, and that the board has no cancelled column", () => {
    expect(isOpen("todo")).toBe(true);
    expect(isOpen("done")).toBe(false);
    expect(BOARD_STATUSES).not.toContain("cancelled");
  });
  it("says a column has more when the server counted more than it sent", () => {
    expect(hasMore([row(1, "todo", 1)], { todo: 2 })).toBe(true);
    expect(hasMore([row(1, "todo", 1)], { todo: 1 })).toBe(false);
  });
});
