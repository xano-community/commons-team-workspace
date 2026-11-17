import { describe, expect, it } from "vitest";
import { checklistShows, demoDataLines, landingAfterSignIn, openAsHref, otherPersonas, readOpenAs, showsKeyCommand } from "./first-run";

describe("where a sign-in lands", () => {
  it("opens a demo on the inbox, with what waits for a decision open", () => {
    expect(landingAfterSignIn("/", true)).toBe("/inbox?item=first");
    expect(landingAfterSignIn(undefined, true)).toBe("/inbox?item=first");
  });
  it("opens a real account on the overview", () => {
    expect(landingAfterSignIn("/", false)).toBe("/");
    expect(landingAfterSignIn(null, false)).toBe("/");
  });
  it("keeps the address someone was sent to, for either", () => {
    expect(landingAfterSignIn("/tasks/4", true)).toBe("/tasks/4");
    expect(landingAfterSignIn("/chat/2?seq=3", false)).toBe("/chat/2?seq=3");
  });
  it("never lands back on sign-in, or off the app", () => {
    expect(landingAfterSignIn("/sign-in?as=admin", true)).toBe("/inbox?item=first");
    expect(landingAfterSignIn("https://elsewhere.example", false)).toBe("/");
  });
});

describe("who sees the model key command", () => {
  it("shows it to everyone in a demo, Morgan the member included", () => {
    expect(showsKeyCommand({ demoMode: true, admin: false })).toBe(true);
    expect(showsKeyCommand({ demoMode: true, admin: true })).toBe(true);
  });
  it("shows it to admins only in a real workspace, and members are told to ask one", () => {
    expect(showsKeyCommand({ demoMode: false, admin: true })).toBe(true);
    expect(showsKeyCommand({ demoMode: false, admin: false })).toBe(false);
  });
});

describe("open as another demo person", () => {
  it("signs the new window in as them, on the page this one is on", () => {
    expect(openAsHref("admin", "/chat/2")).toBe("/sign-in?as=admin&to=%2Fchat%2F2");
    expect(readOpenAs("?as=admin&to=%2Fchat%2F2")).toEqual({ as: "admin", to: "/chat/2" });
  });
  it("lands on the inbox when there's nowhere in particular to go", () => {
    expect(openAsHref("admin", "/")).toBe("/sign-in?as=admin");
    expect(readOpenAs("?as=admin")).toEqual({ as: "admin", to: "" });
  });
  it("ignores an address that leaves the app", () => {
    expect(readOpenAs("?as=admin&to=https://evil.example")).toEqual({ as: "admin", to: "" });
    expect(readOpenAs("?as=admin&to=//evil.example")).toEqual({ as: "admin", to: "" });
    expect(readOpenAs("?to=/chat/2")).toBeNull();
  });
  it("offers everyone but yourself", () => {
    const personas = [
      { key: "admin", label: "Avery Chen", description: "" },
      { key: "member", label: "Morgan Reyes", description: "" },
      { key: "guest", label: "Riley Park", description: "" },
    ];
    expect(otherPersonas(personas, { name: "Morgan Reyes" }).map((p) => p.key)).toEqual(["admin", "guest"]);
  });
});

describe("what Clear demo data says it will do", () => {
  const none = { people: 0, agents: 0, spaces: 0, conversations: 0, messages: 0, tasks: 0, docs: 0, files: 0, customers: 0, removed: 0, cleared: false };
  it("counts each kind, in plain words", () => {
    expect(demoDataLines({ ...none, people: 3, agents: 2, spaces: 3, conversations: 8, messages: 31, tasks: 16, docs: 4, files: 5, customers: 27 })).toEqual([
      "3 spaces, 8 conversations and 31 messages removed", "16 tasks, 4 docs and 5 files removed", "27 customer records removed", "3 demo people and 2 demo agents switched off",
    ]);
  });
  it("leaves out what's already gone, and says one in the singular", () => {
    expect(demoDataLines({ ...none, tasks: 1, agents: 1 })).toEqual(["1 task removed", "1 demo agent switched off"]);
  });
  it("says nothing when there's nothing to clear", () => {
    expect(demoDataLines(none)).toEqual([]);
  });
});

describe("the overview's checklist", () => {
  it("stays away from someone who arrives with every step done", () => {
    expect(checklistShows({ total: 5, done: 5, openedBefore: false })).toBe(false);
  });
  it("shows while a step is left, and shows the finished card to someone who finished it here", () => {
    expect(checklistShows({ total: 5, done: 2, openedBefore: false })).toBe(true);
    expect(checklistShows({ total: 5, done: 5, openedBefore: true })).toBe(true);
  });
  it("shows nothing with no steps", () => {
    expect(checklistShows({ total: 0, done: 0, openedBefore: true })).toBe(false);
  });
});
