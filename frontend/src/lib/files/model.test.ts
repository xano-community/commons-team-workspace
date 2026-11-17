import { describe, expect, it } from "vitest";
import { DATE_LABELS, filtersFromQuery, listState, noPreviewReason, precheck, previewOf, shownSize, sinceOf, typeOf, whereOf } from "./model";

const limits = { mode: "table" as const, max_upload_bytes: 5 * 1024 * 1024, blocked_types: ["exe", "bat"], most_on_a_message: 10 };
const file = (name: string, size = 10) => ({ name, size });

describe("what a file can show", () => {
  it("previews images, PDFs and text, and nothing else", () => {
    expect(previewOf({ kind: "image" })).toBe("image");
    expect(previewOf({ kind: "pdf" })).toBe("pdf");
    expect(previewOf({ kind: "text" })).toBe("text");
    for (const kind of ["document", "sheet", "archive", "media", "other"] as const) expect(previewOf({ kind })).toBeNull();
  });
  it("says why HTML and SVG only download, and doesn't call a spreadsheet dangerous", () => {
    expect(noPreviewReason({ name: "page.html", kind: "other" })).toMatch(/can run code/);
    expect(noPreviewReason({ name: "LOGO.SVG", kind: "other" })).toMatch(/can run code/);
    expect(noPreviewReason({ name: "plan.xlsx", kind: "sheet" })).not.toMatch(/code/);
  });
});

describe("the check before a byte moves", () => {
  it("passes a file inside the limit", () => expect(precheck(file("a.txt"), limits)).toBeNull());
  it("names the limit for a file over it", () => {
    const refused = precheck(file("big.bin", limits.max_upload_bytes + 1), limits);
    expect(refused?.code).toBe("too_big");
    expect(refused?.message).toContain("5 MB");
  });
  it("takes a file exactly at the limit", () => expect(precheck(file("edge.bin", limits.max_upload_bytes), limits)).toBeNull());
  it("refuses a blocked type in any case, by its last extension", () => {
    expect(precheck(file("setup.EXE"), limits)?.code).toBe("wrong_type");
    expect(precheck(file("report.exe.txt"), limits)).toBeNull();
    expect(precheck(file("a.txt.bat"), limits)?.code).toBe("wrong_type");
  });
  it("refuses an empty file", () => expect(precheck(file("blank.txt", 0), limits)?.code).toBe("empty"));
  it("waits for the server when it doesn't know the limits yet", () => expect(precheck(file("big.bin", 1e12), null)).toBeNull());
});

describe("sizes and dates", () => {
  it("reads like a person would say it", () => {
    expect(shownSize(900)).toBe("900 B");
    expect(shownSize(2048)).toBe("2 KB");
    expect(shownSize(5 * 1024 * 1024)).toBe("5 MB");
    expect(shownSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
  it("turns a date filter into a moment, and ignores what it doesn't know", () => {
    const now = new Date("2026-11-06T12:00:00Z").getTime();
    expect(sinceOf("week", now)).toBe(now - 7 * 86_400_000);
    expect(sinceOf("month", now)).toBe(now - 30 * 86_400_000);
    expect(sinceOf("", now)).toBeUndefined();
    expect(sinceOf("nonsense", now)).toBeUndefined();
    expect(Object.keys(DATE_LABELS)).toContain("year");
  });
  it("keeps only filters that mean something today, from a link", () => {
    expect(filtersFromQuery({ q: "hero", kind: "image", date: "week" })).toEqual({ q: "hero", kind: "image", date: "week" });
    expect(filtersFromQuery({ kind: "bogus", date: "bogus" })).toEqual({ q: "", kind: "", date: "" });
  });
});

describe("where a file says it lives", () => {
  it("names the space, then a DM, then customers", () => {
    expect(whereOf({ space_name: "Studio", dm_id: 0, crm: false })).toBe("Studio");
    expect(whereOf({ space_name: null, dm_id: 4, crm: false })).toBe("Direct message");
    expect(whereOf({ space_name: null, dm_id: 0, crm: true })).toBe("Customers");
  });
});

describe("which state the list is in", () => {
  const base = { loaded: true, error: null, denied: false, spaces: 2, ever: 3, shown: 3, filtered: false, trash: false };
  it("shows rows when it has them, even through a failed refresh", () => expect(listState({ ...base, error: new Error("x") })).toBe("ready"));
  it("tells no access from nothing", () => expect(listState({ ...base, denied: true, shown: 0, ever: 0 })).toBe("no-access"));
  it("tells never had any from nothing matched", () => {
    expect(listState({ ...base, shown: 0, ever: 0 })).toBe("never");
    expect(listState({ ...base, shown: 0, ever: 3, filtered: true })).toBe("no-match");
  });
  it("tells an empty trash and no space apart", () => {
    expect(listState({ ...base, shown: 0, ever: 0, trash: true })).toBe("trash-empty");
    expect(listState({ ...base, shown: 0, ever: 0, spaces: 0 })).toBe("no-space");
  });
  it("loads, and fails only when there's nothing to show", () => {
    expect(listState({ ...base, loaded: false, shown: 0 })).toBe("loading");
    expect(listState({ ...base, loaded: false, shown: 0, error: new Error("x") })).toBe("failed");
  });
});

describe("a file's type, as a person says it", () => {
  it("names a CSV a CSV though it previews as text, and falls back to the kind", () => {
    expect(typeOf({ name: "Marlow bike specs.csv", kind: "text" })).toBe("CSV");
    expect(typeOf({ name: "Oakline logo pack.ZIP", kind: "archive" })).toBe("ZIP archive");
    expect(typeOf({ name: "Unmatched redirects.txt", kind: "text" })).toBe("Text");
    expect(typeOf({ name: "README", kind: "other" })).toBe("File");
  });
});
