import { describe, expect, it } from "vitest";
import { shownBacklinks } from "./panel";

const file = { type: "file", id: 4 }, doc = { type: "doc", id: 2 }, deal = { type: "deal", id: 9 };

describe("a record's links beside its files", () => {
  it("leaves out a file the record already shows in Files, and counts what's left", () => {
    expect(shownBacklinks([file, doc], 2, true)).toEqual({ views: [doc], total: 1 });
  });
  it("says nothing at all when the only link was the attached file", () => {
    expect(shownBacklinks([file], 1, true)).toEqual({ views: [], total: 0 });
  });
  it("keeps every link on a record with no Files section", () => {
    expect(shownBacklinks([file, deal], 2, false)).toEqual({ views: [file, deal], total: 2 });
  });
  it("keeps the server's count for links on later pages", () => {
    expect(shownBacklinks([file, doc], 30, true)).toEqual({ views: [doc], total: 29 });
  });
});
