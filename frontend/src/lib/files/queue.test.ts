import { describe, expect, it, vi } from "vitest";
import { createUploads, type Limits, type Send } from "./queue";

const limits: Limits = { mode: "table", max_upload_bytes: 100, blocked_types: ["exe"], most_on_a_message: 10 };
const picked = (name: string, size = 10) => new File(["x".repeat(size)], name);
const stored = (id: number) => ({ ok: true, code: "", message: "", repeat: false, file: { id, name: `f${id}` } });
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A send held open, so a test decides how each one ends. */
function held() {
  const calls: { file: File; key: string; progress: (n: number) => void; signal: AbortSignal; resolve: (v: never) => void; reject: (e: unknown) => void }[] = [];
  const send = ((file, key, progress, signal) => new Promise((resolve, reject) => {
    calls.push({ file, key, progress, signal, resolve: resolve as (v: never) => void, reject });
    signal.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")));
  })) as Send;
  return { calls, send };
}

describe("an upload", () => {
  it("shows its progress, then its file", async () => {
    const { calls, send } = held();
    const q = createUploads({ send, limits: () => limits });
    q.add([picked("a.txt")]);
    await tick();
    expect(q.list()[0].state).toBe("uploading");
    calls[0].progress(0.4);
    expect(q.list()[0].progress).toBe(0.4);
    calls[0].resolve(stored(7) as never);
    await tick();
    expect(q.list()[0]).toMatchObject({ state: "done", progress: 1, file: { id: 7 } });
    expect(q.fileIds()).toEqual([7]);
  });

  it("never sends a file the limits refuse, and says which way", async () => {
    const { calls, send } = held();
    const q = createUploads({ send, limits: () => limits });
    q.add([picked("big.bin", 101), picked("run.exe"), picked("blank.txt", 0)]);
    await tick();
    expect(calls).toHaveLength(0);
    expect(q.list().map((u) => u.state)).toEqual(["too_big", "wrong_type", "empty"]);
    expect(q.pending()).toBe(0);
  });

  it("stops when it's cancelled, and Retry starts it again under the same id", async () => {
    const { calls, send } = held();
    const q = createUploads({ send, limits: () => limits });
    q.add([picked("a.txt")]);
    await tick();
    const key = q.list()[0].key;
    q.cancel(key);
    await tick();
    expect(calls[0].signal.aborted).toBe(true);
    expect(q.list()[0].state).toBe("cancelled");
    q.retry(key);
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].key).toBe(key);
    calls[1].resolve(stored(1) as never);
    await tick();
    expect(q.list()[0].state).toBe("done");
  });

  it("says the connection dropped, keeps the file for Retry, and a retry can't double it", async () => {
    const { calls, send } = held();
    const q = createUploads({ send, limits: () => limits });
    q.add([picked("a.txt")]);
    await tick();
    calls[0].reject(Object.assign(new Error("lost"), { status: 0 }));
    await tick();
    expect(q.list()[0]).toMatchObject({ state: "failed", reason: expect.stringMatching(/connection/i) });
    q.retry(q.list()[0].key);
    await tick();
    expect(calls[1].key).toBe(calls[0].key);
  });

  it("takes the server's word when it refuses", async () => {
    const { calls, send } = held();
    const q = createUploads({ send, limits: () => limits });
    q.add([picked("a.txt")]);
    await tick();
    calls[0].resolve({ ok: false, code: "refused", message: "You don't have access to this any more.", file: null, repeat: false } as never);
    await tick();
    expect(q.list()[0]).toMatchObject({ state: "refused", reason: "You don't have access to this any more." });
  });

  it("offers another file in the place of one that can't go", async () => {
    const { calls, send } = held();
    const q = createUploads({ send, limits: () => limits });
    q.add([picked("big.bin", 101)]);
    await tick();
    q.replace(q.list()[0].key, picked("small.bin"));
    await tick();
    expect(q.list()).toHaveLength(1);
    expect(q.list()[0]).toMatchObject({ name: "small.bin", state: "uploading" });
    expect(calls).toHaveLength(1);
  });
});

describe("the queue", () => {
  it("sends two at a time, and the next starts when one ends", async () => {
    const { calls, send } = held();
    const q = createUploads({ send, limits: () => limits });
    q.add([picked("a.txt"), picked("b.txt"), picked("c.txt")]);
    await tick();
    expect(calls).toHaveLength(2);
    expect(q.list().map((u) => u.state)).toEqual(["uploading", "uploading", "queued"]);
    calls[0].resolve(stored(1) as never);
    await tick();
    expect(calls).toHaveLength(3);
  });

  it("counts what's still going, and what failed, for a message that's waiting", async () => {
    const { calls, send } = held();
    const q = createUploads({ send, limits: () => limits });
    q.add([picked("a.txt"), picked("b.txt")]);
    await tick();
    expect(q.pending()).toBe(2);
    calls[0].resolve(stored(1) as never);
    calls[1].reject(Object.assign(new Error("lost"), { status: 0 }));
    await tick();
    expect(q.pending()).toBe(0);
    expect(q.problems()).toBe(1);
    expect(q.fileIds()).toEqual([1]);
  });

  it("tells whoever's listening, stops when told, and clears what's finished", async () => {
    const { calls, send } = held();
    const q = createUploads({ send, limits: () => limits });
    const heard = vi.fn();
    const stop = q.subscribe(heard);
    q.add([picked("a.txt")]);
    await tick();
    expect(heard).toHaveBeenCalled();
    stop();
    calls[0].resolve(stored(1) as never);
    await tick();
    q.clear();
    expect(q.list()).toEqual([]);
  });

  it("tells a screen when a file lands, so it can refresh once", async () => {
    const { calls, send } = held();
    const landed = vi.fn();
    const q = createUploads({ send, limits: () => limits, onDone: landed });
    q.add([picked("a.txt")]);
    await tick();
    calls[0].resolve(stored(9) as never);
    await tick();
    expect(landed).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }));
  });
});
