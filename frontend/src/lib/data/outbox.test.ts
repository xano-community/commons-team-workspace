import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/base/request";
import { saveDraft, readDraft, purgeDrafts } from "./drafts";
import { flushOutbox, outboxEntries, purgeOutbox, sendWrite, type Write } from "./outbox";

const ADA = 1, BEN = 2;
const write: Write = { label: "move Fix login to Done", verb: "PATCH", path: "/tasks/1", body: { status: "done" }, changes: [{ entity: "task", id: 1, patch: { status: "done" } }] };

let client: QueryClient;
const status = () => client.getQueryData<{ status: string }[]>(["task"])![0].status;
const deps = (request: () => Promise<unknown>, notifyFailure = vi.fn()) => ({ client, request, notifyFailure });

beforeEach(() => {
  localStorage.clear();
  client = new QueryClient();
  client.setQueryData(["task"], [{ id: 1, status: "open" }]);
});

describe("sending a write", () => {
  it("shows before the server answers, and clears the outbox when it does", async () => {
    let answer = () => {};
    const sent = sendWrite(ADA, write, deps(() => new Promise<void>((r) => { answer = r; })));
    expect(status()).toBe("done");
    expect(outboxEntries(ADA)).toHaveLength(1);
    answer();
    expect(await sent).toBe("sent");
    expect(outboxEntries(ADA)).toEqual([]);
  });

  it("rolls back with a toast that names the change when the server refuses", async () => {
    const notify = vi.fn();
    const end = await sendWrite(ADA, write, deps(() => Promise.reject(new ApiError("That task is locked.", 400)), notify));
    expect(end).toBe("failed");
    expect(status()).toBe("open");
    expect(notify).toHaveBeenCalledWith("Couldn't move Fix login to Done. That task is locked.");
    expect(outboxEntries(ADA)).toEqual([]);
  });
});

describe("a 401", () => {
  const signedOut = () => Promise.reject(new ApiError("Your session ended.", 401));

  it("keeps the write on screen and on disk, with no failure toast", async () => {
    const notify = vi.fn();
    expect(await sendWrite(ADA, write, deps(signedOut, notify))).toBe("held");
    expect(status()).toBe("done");
    expect(outboxEntries(ADA)).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps drafts and the outbox apart by person", async () => {
    saveDraft(ADA, "task-1", "Half a thought");
    await sendWrite(ADA, write, deps(signedOut));
    expect(readDraft(ADA, "task-1")?.text).toBe("Half a thought");
    expect(readDraft(BEN, "task-1")).toBeNull();
    expect(outboxEntries(BEN)).toEqual([]);
  });

  it("sends the held write once the same person is back, in a tab that has reloaded", async () => {
    await sendWrite(ADA, write, deps(signedOut));
    client = new QueryClient();
    client.setQueryData(["task"], [{ id: 1, status: "open" }]);
    const request = vi.fn(() => new Promise<void>((r) => { expect(status()).toBe("done"); r(); }));
    await flushOutbox(ADA, deps(request));
    expect(request).toHaveBeenCalledTimes(1);
    expect(outboxEntries(ADA)).toEqual([]);
  });

  it("stops flushing at the first write that still can't go, keeping the order", async () => {
    await sendWrite(ADA, write, deps(signedOut));
    await sendWrite(ADA, { ...write, path: "/tasks/2" }, deps(signedOut));
    const request = vi.fn(signedOut);
    await flushOutbox(ADA, deps(request));
    expect(request).toHaveBeenCalledTimes(1);
    expect(outboxEntries(ADA).map((e) => e.path)).toEqual(["/tasks/1", "/tasks/2"]);
  });
});

it("a lost connection holds the write too", async () => {
  expect(await sendWrite(ADA, write, deps(() => Promise.reject(new ApiError("We can't reach the server.", 0))))).toBe("held");
  expect(outboxEntries(ADA)).toHaveLength(1);
});

describe("a purge", () => {
  const never = () => new Promise<void>(() => {});

  it("forgets one space's work and keeps the rest", () => {
    saveDraft(ADA, "a", "secret", 7);
    saveDraft(ADA, "b", "mine", 8);
    void sendWrite(ADA, { ...write, spaceId: 7 }, deps(never));
    void sendWrite(ADA, { ...write, spaceId: 8 }, deps(never));
    purgeDrafts(ADA, 7);
    purgeOutbox(ADA, 7);
    expect(readDraft(ADA, "a")).toBeNull();
    expect(readDraft(ADA, "b")?.text).toBe("mine");
    expect(outboxEntries(ADA).map((e) => e.spaceId)).toEqual([8]);
  });

  it("forgets everything when no space is named", () => {
    saveDraft(ADA, "a", "secret");
    void sendWrite(ADA, write, deps(never));
    purgeDrafts(ADA);
    purgeOutbox(ADA);
    expect(readDraft(ADA, "a")).toBeNull();
    expect(outboxEntries(ADA)).toEqual([]);
  });
});
