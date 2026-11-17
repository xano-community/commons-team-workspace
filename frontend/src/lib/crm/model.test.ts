import { describe, expect, it } from "vitest";
import { CLOSE_LABELS, EMPTY_FILTERS, activeFilters, closeRange, columnsOf, filtersFromQuery, isOverdue, money, openValue, queryOf, screenState, toRequest } from "./model";
import { stripNames } from "@/lib/chat/tokens";

const stage = (id: number, name: string, kind: "open" | "won" | "lost", deals = 0, value = 0) => ({ id, name, kind, rank: id, deals, value } as never);

describe("what the pipeline shows", () => {
  const base = { error: null, loaded: true, denied: false, companies: 2, ever: 3, open: 2, shown: 3, filtered: false };
  it("tells no companies from no deals from all closed from nothing matched", () => {
    expect(screenState({ ...base, companies: 0, ever: 0, open: 0, shown: 0 })).toBe("no-companies");
    expect(screenState({ ...base, ever: 0, open: 0, shown: 0 })).toBe("no-deals");
    expect(screenState({ ...base, open: 0 })).toBe("all-closed");
    expect(screenState({ ...base, shown: 0, filtered: true })).toBe("no-match");
    expect(screenState(base)).toBe("ready");
  });
  it("says no access before it says failed, and failed only on a first load", () => {
    expect(screenState({ ...base, denied: true, error: new Error("x") })).toBe("no-access");
    expect(screenState({ ...base, loaded: false, error: new Error("x") })).toBe("failed");
    expect(screenState({ ...base, loaded: false })).toBe("loading");
    expect(screenState({ ...base, error: new Error("x") })).toBe("ready");
  });
  it("never reports all closed through a filter", () => {
    expect(screenState({ ...base, open: 0, filtered: true })).toBe("ready");
  });
});

describe("the board's columns", () => {
  it("are the stages in order, each with its value, and a win is the one quiet success", () => {
    const columns = columnsOf([stage(1, "Lead", "open", 2, 1500), stage(2, "Won", "won", 1, 48000), stage(3, "Lost", "lost")]);
    expect(columns.map((c) => c.id)).toEqual(["1", "2", "3"]);
    expect(columns[0]).toMatchObject({ title: "Lead", hint: "$1,500", tone: "neutral" });
    expect(columns[1].tone).toBe("success");
    expect(columns[2].hint).toBeUndefined();
  });
  it("folds only the Lost stage to a rail, so the open stages and Won fit side by side", () => {
    const columns = columnsOf([stage(1, "Lead", "open"), stage(2, "Won", "won"), stage(3, "Lost", "lost")]);
    expect(columns.map((c) => c.rail)).toEqual([false, false, true]);
  });
  it("adds up only what's still open", () => {
    expect(openValue([stage(1, "Lead", "open", 2, 1500), stage(2, "Proposal", "open", 1, 500), stage(3, "Won", "won", 1, 48000)])).toBe(2000);
  });
  it("calls a deal overdue only while it's open", () => {
    const deal = (close_on: string | null, closed_at: number | null) => ({ close_on, closed_at } as never);
    expect(isOverdue(deal("2026-11-01", null), "2026-11-06")).toBe(true);
    expect(isOverdue(deal("2026-11-06", null), "2026-11-06")).toBe(false);
    expect(isOverdue(deal("2026-11-01", 5), "2026-11-06")).toBe(false);
    expect(isOverdue(deal(null, null), "2026-11-06")).toBe(false);
  });
});

describe("money", () => {
  it("reads as whole currency, and zero as nothing set", () => {
    expect(money(18000)).toBe("$18,000");
    expect(money(0)).toBe("$0");
  });
});

describe("filters", () => {
  it("round-trip through the URL's words", () => {
    const f = { ...EMPTY_FILTERS, q: "marlow", owner: "12", close: "month" };
    expect(filtersFromQuery(queryOf(f))).toEqual(f);
    expect(queryOf(EMPTY_FILTERS)).toEqual({});
  });
  it("ignore anything a link shouldn't hold", () => {
    expect(filtersFromQuery({ owner: "x", close: "someday", q: 7 } as never)).toEqual(EMPTY_FILTERS);
    expect(filtersFromQuery({ owner: "me" })).toEqual({ ...EMPTY_FILTERS, owner: "me" });
    expect(filtersFromQuery({ owner: "none" })).toEqual({ ...EMPTY_FILTERS, owner: "none" });
  });
  it("count what's on", () => {
    expect(activeFilters(EMPTY_FILTERS)).toBe(0);
    expect(activeFilters({ ...EMPTY_FILTERS, q: "x", close: "month" })).toBe(2);
  });
  it("turn into a request, with nobody as -1 and me as my id", () => {
    const now = new Date("2026-11-06T12:00:00");
    expect(toRequest({ ...EMPTY_FILTERS, owner: "me" }, { me: 4, limit: 100 }, now)).toMatchObject({ owner_id: 4, limit: 100 });
    expect(toRequest({ ...EMPTY_FILTERS, owner: "none" }, { me: 4, limit: 100 }, now)).toMatchObject({ owner_id: -1 });
    expect(toRequest({ ...EMPTY_FILTERS, owner: "9" }, { me: 4, limit: 100 }, now)).toMatchObject({ owner_id: 9 });
    expect(toRequest(EMPTY_FILTERS, { me: 4, limit: 100 }, now).owner_id).toBeUndefined();
  });
  it("name a close date window for each word", () => {
    const now = new Date("2026-11-06T12:00:00");
    expect(Object.keys(CLOSE_LABELS)).toEqual(["month", "soon", "quarter"]);
    expect(closeRange("month", now)).toEqual({ close_from: "2026-11-01", close_to: "2026-11-30" });
    expect(closeRange("soon", now)).toEqual({ close_from: "2026-11-06", close_to: "2026-12-06" });
    expect(closeRange("quarter", now)).toEqual({ close_from: "2026-10-01", close_to: "2026-12-31" });
    expect(closeRange("", now)).toEqual({});
  });
});

describe("removing a name from a note", () => {
  it("takes out only the people named, and tidies the gap", () => {
    expect(stripNames("<@3> the plan is <@4> ready", [3])).toBe("the plan is <@4> ready");
    expect(stripNames("Ask <@3>, then <@3> again", [3])).toBe("Ask, then again");
  });
});
