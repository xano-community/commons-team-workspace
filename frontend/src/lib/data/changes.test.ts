import { describe, expect, it, vi } from "vitest";
import { createChangeFollower, type ChangeRead } from "./changes";

const entry = (seq: number) => ({ seq, entity: "task", entity_id: seq, op: "updated", actor_id: 1 });
const setup = (log: number[], head = log.at(-1) ?? 0) => {
  const read = vi.fn<ChangeRead>(async (_channel, after) => ({ seq: head, items: after < 0 ? [] : log.filter((s) => s > after).map(entry) }));
  const apply = vi.fn();
  const started = vi.fn();
  return { read, apply, started, follower: createChangeFollower({ read, apply, started }) };
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const applied = (apply: ReturnType<typeof vi.fn>) => apply.mock.calls.map((c) => c[1].seq);

describe("following a channel", () => {
  it("starts from where the channel is now, without replaying its past", async () => {
    const { follower, read, apply } = setup([1, 2, 3]);
    follower.follow("spaces/1");
    await flush();
    expect(read).toHaveBeenCalledWith("spaces/1", -1);
    expect(apply).not.toHaveBeenCalled();
    expect(follower.saw("spaces/1", 4)).toBe(true);
  });

  it("says when it has its starting point, because anything before it may never arrive as a frame", async () => {
    const { follower, started } = setup([1, 2]);
    follower.follow("users/1");
    await flush();
    expect(started).toHaveBeenCalledWith("users/1");
    follower.follow("users/1");
    await flush();
    expect(started).toHaveBeenCalledTimes(1);
  });

  it("catches up when a channel it knows is joined again, since frames were lost while it was off", async () => {
    const { follower, apply, read } = setup([], 0);
    follower.follow("users/1");
    await flush();
    read.mockImplementation(async (_c, after) => ({ seq: 2, items: [1, 2].filter((s) => s > after).map(entry) }));
    follower.follow("users/1");
    await flush();
    expect(applied(apply)).toEqual([1, 2]);
  });

  it("drops a frame it already has", async () => {
    const { follower } = setup([1]);
    follower.follow("spaces/1");
    await flush();
    expect(follower.saw("spaces/1", 1)).toBe(false);
    expect(follower.saw("spaces/1", 2)).toBe(true);
    expect(follower.saw("spaces/1", 2)).toBe(false);
  });

  it("asks for what it missed when a frame skips a number, and applies each once, in order", async () => {
    const { follower, apply, read } = setup([1, 2, 3, 4, 5], 1);
    follower.follow("spaces/1");
    await flush();
    read.mockImplementation(async (_c, after) => ({ seq: 5, items: [2, 3, 4, 5].filter((s) => s > after).map(entry) }));
    expect(follower.saw("spaces/1", 5)).toBe(false);
    await flush();
    expect(applied(apply)).toEqual([2, 3, 4, 5]);
    expect(follower.saw("spaces/1", 5)).toBe(false);
  });

  it("catches up on every channel at once, and keeps paging until it reaches the head", async () => {
    const { follower, apply, read } = setup([], 0);
    follower.follow("spaces/1");
    follower.follow("users/1");
    await flush();
    read.mockImplementation(async (channel, after) => (channel === "users/1" ? { seq: 0, items: [] } : { seq: 3, items: [after + 1].filter((s) => s <= 3).map(entry) }));
    await follower.catchUp();
    expect(apply.mock.calls.filter((c) => c[0] === "spaces/1").map((c) => c[1].seq)).toEqual([1, 2, 3]);
  });

  it("lets a failed read wait for the next catch-up, and loses nothing", async () => {
    const { follower, apply, read } = setup([], 0);
    follower.follow("spaces/1");
    await flush();
    read.mockRejectedValueOnce(new Error("offline"));
    await follower.catchUp();
    expect(apply).not.toHaveBeenCalled();
    read.mockImplementation(async () => ({ seq: 1, items: [entry(1)] }));
    await follower.catchUp();
    expect(applied(apply)).toEqual([1]);
  });

  it("stops following a channel it left", async () => {
    const { follower, read } = setup([], 0);
    follower.follow("spaces/1");
    await flush();
    follower.forget("spaces/1");
    read.mockClear();
    await follower.catchUp();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("a gap noticed while a read is already running", () => {
  it("reads again, because the running read may have been answered before the missing entry committed", async () => {
    const answers: ((v: { seq: number; items: ReturnType<typeof entry>[] }) => void)[] = [];
    const read = vi.fn<ChangeRead>((_c, after) => (after < 0 ? Promise.resolve({ seq: 1, items: [] }) : new Promise((done) => answers.push(done))));
    const apply = vi.fn();
    const follower = createChangeFollower({ read, apply });
    follower.follow("users/1");
    await flush();
    void follower.catchUp();                       // a focus or a timer: this read is on its way
    await flush();
    expect(follower.saw("users/1", 3)).toBe(false); // entry 3's frame lands meanwhile, ahead of the answer
    answers.shift()!({ seq: 2, items: [entry(2)] }); // the read was answered before 3 committed
    await flush();
    expect(answers).toHaveLength(1);                // so it has to ask again
    answers.shift()!({ seq: 3, items: [entry(3)] });
    await flush();
    expect(applied(apply)).toEqual([2, 3]);
  });
});
