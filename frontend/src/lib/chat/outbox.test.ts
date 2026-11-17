import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatOutbox, type OutboxOptions } from "./outbox";

const failure = (status: number, message = "no") => Object.assign(new Error(message), { status });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const setup = (post: OutboxOptions["post"]) => {
  const sent = vi.fn();
  const box = createChatOutbox({ userId: 1, post, onSent: sent, wait: () => Promise.resolve(), timeoutMs: 1000 });
  return { box, sent };
};
const row = { id: 1 } as never;

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe("sending", () => {
  it("shows at once, and leaves when the server answers", async () => {
    const { box, sent } = setup(async () => ({ message: row, repeat: false }));
    const key = box.send(4, "hello");
    expect(box.entries(4)).toMatchObject([{ key, body: "hello", state: "sending" }]);
    await flush();
    expect(box.entries(4)).toEqual([]);
    expect(sent).toHaveBeenCalledWith(4, row);
  });

  it("retries a lost connection with the same id, so the server can't make two", async () => {
    const post = vi.fn<OutboxOptions["post"]>().mockRejectedValueOnce(failure(0)).mockRejectedValueOnce(failure(503)).mockResolvedValue({ message: row, repeat: true });
    const { box } = setup(post);
    const key = box.send(4, "hello");
    await vi.waitFor(() => expect(box.entries(4)).toEqual([]));
    expect(post.mock.calls.map((c) => c[1])).toEqual([key, key, key]);
  });

  it("gives up after three tries, keeps the text, and Retry sends it again under the same id", async () => {
    const post = vi.fn<OutboxOptions["post"]>().mockRejectedValue(failure(0));
    const { box } = setup(post);
    const key = box.send(4, "keep me");
    await vi.waitFor(() => expect(box.entries(4)[0].state).toBe("failed"));
    expect(box.entries(4)[0]).toMatchObject({ body: "keep me", reason: expect.stringContaining("connection") });
    expect(post).toHaveBeenCalledTimes(3);
    post.mockResolvedValue({ message: row, repeat: false });
    box.retry(key);
    await vi.waitFor(() => expect(box.entries(4)).toEqual([]));
    expect(post.mock.lastCall?.[1]).toBe(key);
  });

  it("treats a request that never answers as lost, and retries it", async () => {
    vi.useFakeTimers();
    const post = vi.fn<OutboxOptions["post"]>().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue({ message: row, repeat: true });
    const box = createChatOutbox({ userId: 1, post, onSent: vi.fn(), wait: () => Promise.resolve(), timeoutMs: 1000 });
    box.send(4, "slow");
    await vi.advanceTimersByTimeAsync(1100);
    expect(post).toHaveBeenCalledTimes(2);
    expect(box.entries(4)).toEqual([]);
  });

  it("ends blocked on a refusal, with the text kept and no Retry to offer", async () => {
    const { box } = setup(async () => { throw failure(404, "Not found."); });
    box.send(4, "after removal");
    await vi.waitFor(() => expect(box.entries(4)[0].state).toBe("blocked"));
    expect(box.entries(4)[0].body).toBe("after removal");
  });

  it("says what a rate limit means, and leaves it to retry", async () => {
    const { box } = setup(async () => { throw failure(429); });
    box.send(4, "fast");
    await vi.waitFor(() => expect(box.entries(4)[0].state).toBe("failed"));
    expect(box.entries(4)[0].reason).toMatch(/too fast/i);
  });

  it("holds through a 401, and sends when the person is back", async () => {
    const post = vi.fn<OutboxOptions["post"]>().mockRejectedValueOnce(failure(401)).mockResolvedValue({ message: row, repeat: false });
    const { box } = setup(post);
    box.send(4, "after sign-in");
    await flush();
    expect(box.entries(4)[0].state).toBe("sending");
    expect(post).toHaveBeenCalledTimes(1);
    box.resume();
    await vi.waitFor(() => expect(box.entries(4)).toEqual([]));
  });

  it("sends one conversation's messages in order, one at a time", async () => {
    const seen: string[] = [];
    let release = () => {};
    const post = vi.fn<OutboxOptions["post"]>(async (_c, _k, body) => {
      seen.push(body);
      if (body === "first") await new Promise<void>((r) => { release = r; });
      return { message: row, repeat: false };
    });
    const { box } = setup(post);
    box.send(4, "first"); box.send(4, "second");
    await flush();
    expect(seen).toEqual(["first"]);
    release();
    await vi.waitFor(() => expect(seen).toEqual(["first", "second"]));
  });
});

describe("what survives", () => {
  it("comes back after a reload under the same person, and goes out", async () => {
    const stuck = setup(() => new Promise(() => {}));
    stuck.box.send(4, "written before the reload");
    const post = vi.fn<OutboxOptions["post"]>(async () => ({ message: row, repeat: false }));
    const { box } = setup(post);
    expect(box.entries(4)).toHaveLength(1);
    box.resume();
    await vi.waitFor(() => expect(box.entries(4)).toEqual([]));
    expect(post.mock.calls[0][2]).toBe("written before the reload");
  });

  it("is someone else's nothing", () => {
    setup(() => new Promise(() => {})).box.send(4, "mine");
    const other = createChatOutbox({ userId: 2, post: vi.fn(), onSent: vi.fn() });
    expect(other.entries(4)).toEqual([]);
  });

  it("on removal from a space, leaves the disk but stays on screen, blocked, so it can be copied", () => {
    const { box } = setup(() => new Promise(() => {}));
    box.send(4, "private words", 9);
    box.send(5, "elsewhere", 8);
    box.blockSpace(9);
    expect(box.entries(4)[0]).toMatchObject({ state: "blocked", body: "private words" });
    expect(localStorage.getItem("commons.chat-outbox.1")).not.toContain("private words");
    expect(localStorage.getItem("commons.chat-outbox.1")).toContain("elsewhere");
  });

  it("Discard forgets it", () => {
    const { box } = setup(() => new Promise(() => {}));
    const key = box.send(4, "never mind");
    box.discard(key);
    expect(box.entries(4)).toEqual([]);
  });

  it("sends the files it was given, and sends them again on a retry", async () => {
    const post = vi.fn().mockRejectedValueOnce(Object.assign(new Error("no"), { status: 0 })).mockRejectedValueOnce(Object.assign(new Error("no"), { status: 0 })).mockRejectedValueOnce(Object.assign(new Error("no"), { status: 0 }))
      .mockResolvedValue({ message: { id: 1, seq: 1, client_msg_id: "k" }, repeat: false });
    const box = createChatOutbox({ userId: 91, post, onSent: () => {}, wait: () => Promise.resolve() });
    const key = box.send(1, "", undefined, [4, 5]);
    await new Promise((r) => setTimeout(r, 0));
    expect(box.entries(1)[0].fileIds).toEqual([4, 5]);
    box.retry(key);
    await new Promise((r) => setTimeout(r, 0));
    expect(post.mock.calls.at(-1)).toEqual([1, key, "", [4, 5]]);
  });
});
