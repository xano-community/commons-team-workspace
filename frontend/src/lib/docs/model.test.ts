import { describe, expect, it, vi } from "vitest";
import { bySpace, groupedBy, createPulse, goneNotice, liveRun, listState, queueOf, yieldingSave } from "./model";

const suggestion = (id: number, text_changed = false) => ({ id, find: "x", text: "y", text_changed, note: "", agent_name: "Scout", agent_id: 4 });

describe("queueOf", () => {
  it("shows the oldest first and says how many are behind it", () => {
    expect(queueOf([suggestion(1), suggestion(2), suggestion(3)], () => true)).toMatchObject({ head: { id: 1 }, position: 1, total: 3, stale: false });
  });
  it("is nothing when nothing is waiting", () => {
    expect(queueOf([], () => true)).toBeNull();
  });
  it("trusts the open editor over the last save: words a person just typed away are gone", () => {
    expect(queueOf([suggestion(1)], () => false)?.stale).toBe(true);
    expect(queueOf([suggestion(1, true)], () => true)?.stale).toBe(false);
  });
  it("with no editor yet, falls back on what the server said", () => {
    expect(queueOf([suggestion(1, true)], null)?.stale).toBe(true);
  });
  it("skips one being decided, so the next shows at once", () => {
    expect(queueOf([suggestion(1), suggestion(2)], () => true, new Set([1]))).toMatchObject({ head: { id: 2 }, total: 1 });
  });
});

describe("createPulse", () => {
  it("speaks at once, then not again until the gap has passed", () => {
    const send = vi.fn();
    let now = 1000;
    const pulse = createPulse(send, 5000, () => now);
    pulse(); pulse();
    expect(send).toHaveBeenCalledTimes(1);
    now += 4999; pulse();
    expect(send).toHaveBeenCalledTimes(1);
    now += 1; pulse();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("yieldingSave", () => {
  const body = { base_version: 3, title: "T", body: { type: "doc" as const, content: [] } };
  const won = { conflict: false, doc: { version: 5 }, notified: [] };
  const lost = { conflict: true, doc: { version: 4 }, notified: [] };
  it("passes a clean save straight through", async () => {
    const save = vi.fn().mockResolvedValue(won);
    const yieldDoc = vi.fn();
    expect(await yieldingSave(save, yieldDoc)(9, body)).toBe(won);
    expect(yieldDoc).not.toHaveBeenCalled();
  });
  it("after losing to an agent's own edit, saves on top with no dialog", async () => {
    const save = vi.fn().mockResolvedValueOnce(lost).mockResolvedValueOnce(won);
    const yieldDoc = vi.fn().mockResolvedValue({ yielded: true, version: 4 });
    expect(await yieldingSave(save, yieldDoc)(9, body)).toBe(won);
    expect(yieldDoc).toHaveBeenCalledWith(9, 3);
    expect(save).toHaveBeenLastCalledWith(9, { ...body, base_version: 4 });
  });
  it("after losing to a person, keeps the conflict for the dialog", async () => {
    const save = vi.fn().mockResolvedValue(lost);
    const yieldDoc = vi.fn().mockResolvedValue({ yielded: false, version: 4 });
    expect(await yieldingSave(save, yieldDoc)(9, body)).toBe(lost);
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("keeps the conflict when the yield itself fails, because the dialog loses nothing", async () => {
    const save = vi.fn().mockResolvedValue(lost);
    expect(await yieldingSave(save, vi.fn().mockRejectedValue(new Error("offline")))(9, body)).toBe(lost);
  });
});

describe("liveRun", () => {
  const run = (id: number, status: string) => ({ id, status });
  it("is the newest run still going", () => {
    expect(liveRun([run(3, "working"), run(2, "done")])?.id).toBe(3);
    expect(liveRun([run(3, "queued")])?.id).toBe(3);
    expect(liveRun([run(3, "waiting")])?.id).toBe(3);
  });
  it("shows a failure, so nobody waits on a run that stopped", () => {
    expect(liveRun([run(3, "failed"), run(2, "done")])?.id).toBe(3);
  });
  it("is nothing once the newest has finished", () => {
    expect(liveRun([run(3, "done"), run(2, "failed")])).toBeUndefined();
    expect(liveRun([])).toBeUndefined();
  });
});

describe("listState", () => {
  const base = { loaded: true, error: null, denied: false, spaces: 2, ever: 3, shown: 3, filtered: false, trash: false };
  it("says each way a list can be empty differently", () => {
    expect(listState({ ...base, loaded: false, shown: 0 })).toBe("loading");
    expect(listState({ ...base, loaded: false, shown: 0, error: new Error("x") })).toBe("failed");
    expect(listState({ ...base, denied: true, error: new Error("x") })).toBe("no-access");
    expect(listState({ ...base, spaces: 0, ever: 0, shown: 0 })).toBe("no-space");
    expect(listState({ ...base, ever: 0, shown: 0 })).toBe("never");
    expect(listState({ ...base, shown: 0, filtered: true })).toBe("no-match");
    expect(listState({ ...base, shown: 0, trash: true })).toBe("trash-empty");
    expect(listState(base)).toBe("ready");
  });
  it("keeps a page on screen while a refresh fails", () => {
    expect(listState({ ...base, error: new Error("x"), shown: 3 })).toBe("ready");
  });
});

describe("a doc that has gone while open", () => {
  it("says the space is gone when its person was taken out of it (AE3)", () => {
    expect(goneNotice({ spaceId: 3, mySpaces: [1, 2] }).title).toBe("You no longer have access to this space");
  });
  it("says what may have happened while still in the space, or before the spaces are known", () => {
    expect(goneNotice({ spaceId: 3, mySpaces: [3] }).title).toBe("You no longer have this doc");
    expect(goneNotice({ spaceId: 3, mySpaces: null }).title).toBe("You no longer have this doc");
    expect(goneNotice({ spaceId: null, mySpaces: [] }).title).toBe("You no longer have this doc");
  });
});

describe("docs by space", () => {
  it("keeps each space's newest-first order, with the space of the newest work first", () => {
    const rows = [{ id: 1, space_id: 2 }, { id: 2, space_id: 1 }, { id: 3, space_id: 2 }, { id: 4, space_id: 3 }, { id: 5, space_id: 1 }];
    expect(bySpace(rows).map((d) => d.id)).toEqual([1, 3, 2, 5, 4]);
  });
});

describe("rows grouped by a key", () => {
  it("keeps the list's order inside each group, the group seen first first", () => {
    const rows = [{ id: 1, at: "Studio" }, { id: 2, at: "Direct message" }, { id: 3, at: "Studio" }];
    expect(groupedBy(rows, (r) => r.at).map((r) => r.id)).toEqual([1, 3, 2]);
  });
});
