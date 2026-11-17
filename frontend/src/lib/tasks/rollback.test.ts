import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { sendWrite } from "@/lib/data/outbox";
import { insertRow, moveLabel, taskPatch, taskToast, tempTask } from "./writes";

const deps = (client: QueryClient, request: () => Promise<unknown>, notifyFailure = vi.fn()) => ({ client, request, notifyFailure });
const page = (rows: object[]) => ({ items: rows, totals: {}, ever: rows.length, open: rows.length, limit: 100, space_name: "", archived: false });
const KEY = ["task", "list", {}];
const seeded = () => { const c = new QueryClient(); c.setQueryData(KEY, page([{ id: 7, title: "Fix login", status: "todo", rank: 10 }])); return c; };
const rowsOf = (c: QueryClient) => c.getQueryData<{ items: { id: number; title?: string; status?: string; rank?: number }[] }>(KEY)!.items;

describe("a move", () => {
  it("shows at once, and a refusal puts it back and names the task", async () => {
    const client = seeded();
    const fail = vi.fn();
    let refuse = (_e: unknown) => {};
    const pending = sendWrite(1, { label: moveLabel("Fix login", "done"), verb: "POST", path: "/x", changes: [taskPatch(7, { status: "done", rank: 1 })] },
      deps(client, () => new Promise((_, no) => { refuse = no; }), fail));
    expect(rowsOf(client)[0].status).toBe("done");
    refuse(Object.assign(new Error("This space is archived."), { status: 400 }));
    await pending;
    expect(rowsOf(client)[0]).toMatchObject({ status: "todo", rank: 10 });
    expect(fail).toHaveBeenCalledWith("Couldn't move Fix login to Done. This space is archived.");
  });
  it("takes the server's answer as the row, with no refetch needed", async () => {
    const client = seeded();
    await sendWrite(1, { label: "move", verb: "POST", path: "/x", answer: true, changes: [taskPatch(7, { status: "done" })] }, deps(client, async () => ({ id: 7, status: "done", rank: 99 })));
    expect(rowsOf(client)[0]).toMatchObject({ status: "done", rank: 99 });
  });
});

describe("a new task", () => {
  it("appears at once under a stand-in id, and the server's row takes its place", async () => {
    const client = seeded();
    const made = tempTask({ title: "New one", status: "todo", rank: 5, project_id: 2, space_id: 3 });
    expect(made.id).toBeLessThan(0);
    let answer = (_v: unknown) => {};
    const pending = sendWrite(1, { label: "add New one", verb: "POST", path: "/x", answer: true, changes: [insertRow(made)] }, deps(client, () => new Promise((yes) => { answer = yes; })));
    expect(rowsOf(client).map((r) => r.title)).toEqual(["Fix login", "New one"]);
    answer({ ...made, id: 8 });
    await pending;
    expect(rowsOf(client).map((r) => r.id)).toEqual([7, 8]);
  });
  it("leaves again if it's refused, and says so", async () => {
    const client = seeded();
    const fail = vi.fn();
    await sendWrite(1, { label: "add New one", verb: "POST", path: "/x", changes: [insertRow(tempTask({ title: "New one", status: "todo", rank: 5, project_id: 2, space_id: 3 }))] },
      deps(client, async () => { throw Object.assign(new Error("Guests can't add or change tasks in this space."), { status: 403 }); }, fail));
    expect(rowsOf(client).map((r) => r.id)).toEqual([7]);
    expect(fail).toHaveBeenCalledWith("Couldn't add New one. Guests can't add or change tasks in this space.");
  });
});

describe("words", () => {
  it("names the task and where it went", () => {
    expect(moveLabel("Fix login", "in_progress")).toBe("move Fix login to In progress");
    expect(taskToast("delete", "Fix login")).toBe("Deleted Fix login");
  });
});
