import { describe, expect, it, vi } from "vitest";
import { addMissing, gateSend, missingNames, recordKey } from "./mentions";

const two = { warn: true, missing: [{ id: 1, name: "Ana", kind: "human" as const }, { id: 2, name: "Ben", kind: "human" as const }], add: [{ space_id: 9, user_ids: [1, 2] }] };

describe("the mention warning", () => {
  it("holds Enter while the warning shows, and sends once it's gone", () => {
    const send = vi.fn();
    expect(gateSend(true, send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(gateSend(false, send)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it("names who can't see it, in a sentence", () => {
    expect(missingNames(two.missing)).toBe("Ana and Ben");
    expect(missingNames(two.missing.slice(0, 1))).toBe("Ana");
    expect(missingNames([...two.missing, { name: "Cy" }, { name: "Di" }])).toBe("Ana, Ben and 2 others");
  });

  it("keeps the same records as the same key, whatever order they're in", () => {
    expect(recordKey([{ type: "doc", id: 2 }, { type: "doc", id: 1 }])).toBe(recordKey([{ type: "doc", id: 1 }, { type: "doc", id: 2 }]));
  });

  it("adds each person through the same route as the members dialog", async () => {
    const post = vi.fn(async () => ({ added: true, warning: null }));
    await expect(addMissing(two.add, post, async () => true)).resolves.toBe(2);
    expect(post.mock.calls).toEqual([[9, 1, undefined], [9, 2, undefined]]);
  });

  it("asks before adding a guest, and a no adds nobody else's history", async () => {
    const post = vi.fn(async (_s: number, _u: number, ok?: boolean) => (ok ? { added: true, warning: null } : { added: false, warning: "Guests can read everything." }));
    const confirm = vi.fn(async () => false);
    await expect(addMissing([{ space_id: 9, user_ids: [1] }], post, confirm)).resolves.toBe(0);
    expect(confirm).toHaveBeenCalledWith("Guests can read everything.");
    expect(post).toHaveBeenCalledTimes(1);
  });
});
