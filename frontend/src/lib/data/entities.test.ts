import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyEntityEvent, withPending } from "./entities";

type Task = { id: number; status: string; title: string };
const row = (over: Partial<Task> = {}): Task => ({ id: 1, status: "open", title: "Fix login", ...over });
const change = (patch: Partial<Task>, id = 1) => ({ entity: "task", id, patch });

let client: QueryClient;
const list = () => client.getQueryData<Task[]>(["task", "list"])!;
beforeEach(() => {
  client = new QueryClient();
  client.setQueryData(["task", "list"], [row(), row({ id: 2, title: "Ship it" })]);
});

describe("a local write", () => {
  it("shows in every query that holds the record", () => {
    client.setQueryData(["task", 1], row());
    client.setQueryData(["task", "page"], { items: [row()], itemsTotal: 1 });
    applyEntityEvent(client, { type: "write", writeId: "w", changes: [change({ status: "done" })] });
    expect(list()[0].status).toBe("done");
    expect(client.getQueryData<Task>(["task", 1])!.status).toBe("done");
    expect(client.getQueryData<{ items: Task[] }>(["task", "page"])!.items[0].status).toBe("done");
  });

  it("rolls back on failure, and only what it changed", () => {
    applyEntityEvent(client, { type: "write", writeId: "w", changes: [change({ status: "done" })] });
    applyEntityEvent(client, { type: "remote", entity: "task", id: 1, patch: { title: "Fix sign-in" } });
    applyEntityEvent(client, { type: "failed", writeId: "w" });
    expect(list()[0]).toEqual(row({ title: "Fix sign-in" }));
  });

  it("keeps a newer write to the same field when an older one fails", () => {
    applyEntityEvent(client, { type: "write", writeId: "old", changes: [change({ status: "doing" })] });
    applyEntityEvent(client, { type: "write", writeId: "new", changes: [change({ status: "done" })] });
    applyEntityEvent(client, { type: "failed", writeId: "old" });
    expect(list()[0].status).toBe("done");
  });

  it("isn't applied twice when a held write is sent again, so its rollback still finds the original", () => {
    applyEntityEvent(client, { type: "write", writeId: "w", changes: [change({ status: "done" })] });
    applyEntityEvent(client, { type: "write", writeId: "w", changes: [change({ status: "done" })] });
    applyEntityEvent(client, { type: "failed", writeId: "w" });
    expect(list()[0].status).toBe("open");
  });
});

describe("a remote event", () => {
  it("never overwrites a pending write", () => {
    applyEntityEvent(client, { type: "write", writeId: "w", changes: [change({ status: "done" })] });
    applyEntityEvent(client, { type: "remote", entity: "task", id: 1, patch: { status: "blocked", title: "Renamed" } });
    expect(list()[0]).toEqual(row({ status: "done", title: "Renamed" }));
  });

  it("waits to refetch until the pending write settles, then refetches once", () => {
    const refetch = vi.spyOn(client, "invalidateQueries");
    applyEntityEvent(client, { type: "write", writeId: "w", changes: [change({ status: "done" })] });
    applyEntityEvent(client, { type: "remote", entity: "task", id: 1 });
    applyEntityEvent(client, { type: "remote", entity: "task", id: null });
    expect(refetch).not.toHaveBeenCalled();
    applyEntityEvent(client, { type: "settled", writeId: "w", rows: [change({ status: "done" })] });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("refetches straight away when nothing is pending, for that entity alone", () => {
    const refetch = vi.spyOn(client, "invalidateQueries");
    applyEntityEvent(client, { type: "remote", entity: "task", id: 2 });
    expect(refetch).toHaveBeenCalledWith({ queryKey: ["task"] });
  });

  it("leaves another record's write alone", () => {
    applyEntityEvent(client, { type: "write", writeId: "w", changes: [change({ status: "done" }, 2)] });
    applyEntityEvent(client, { type: "remote", entity: "task", id: 1, patch: { status: "blocked" } });
    expect(list().map((t) => t.status)).toEqual(["blocked", "done"]);
  });

  it("takes a deleted record out of the cache", () => {
    applyEntityEvent(client, { type: "remote", entity: "task", id: 1, op: "deleted" });
    expect(list().map((t) => t.id)).toEqual([2]);
  });

  it("refreshes everything after a gap", () => {
    const refetch = vi.spyOn(client, "invalidateQueries");
    applyEntityEvent(client, { type: "remote", entity: "*", id: null, op: "reconnected" });
    expect(refetch).toHaveBeenCalledWith(undefined);
  });
});

it("a fetch that returns during a write can't undo it", () => {
  applyEntityEvent(client, { type: "write", writeId: "w", changes: [change({ status: "done" })] });
  const fresh = withPending(client, "task", [row({ title: "From the server" })]);
  expect(fresh[0]).toEqual(row({ status: "done", title: "From the server" }));
});
