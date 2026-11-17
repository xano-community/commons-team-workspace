import { describe, expect, it, vi } from "vitest";
import { createResolver, type RecordRef, type RecordView } from "./resolver";

const view = (r: RecordRef): RecordView => ({ ...r, state: "live", title: `${r.type} ${r.id}`, href: "/x", can_restore: false });

describe("the batch resolver", () => {
  it("asks once for everything a screen wants in the same moment, without repeats", async () => {
    const fetch = vi.fn(async (items: RecordRef[]) => items.map(view));
    const load = createResolver(fetch);
    const [a, b, c] = await Promise.all([load({ type: "doc", id: 1 }), load({ type: "doc", id: 1 }), load({ type: "task", id: 2 })]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toEqual([{ type: "doc", id: 1 }, { type: "task", id: 2 }]);
    expect([a.title, b.title, c.title]).toEqual(["doc 1", "doc 1", "task 2"]);
  });

  it("splits a long screen into batches the server takes", async () => {
    const fetch = vi.fn(async (items: RecordRef[]) => items.map(view));
    const load = createResolver(fetch);
    await Promise.all(Array.from({ length: 150 }, (_, id) => load({ type: "doc", id })));
    expect(fetch.mock.calls.map((c) => c[0].length)).toEqual([100, 50]);
  });

  it("fails every chip in a batch that failed, so each can show it", async () => {
    const load = createResolver(async () => { throw new Error("nope"); });
    await expect(load({ type: "doc", id: 1 })).rejects.toThrow("nope");
  });
});
