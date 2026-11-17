import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { whenSettled } from "./index";

/** A read that answers when the test says so. */
function slowRead(client: QueryClient, key: string) {
  let answer!: () => void;
  void client.fetchQuery({ queryKey: [key], queryFn: () => new Promise<string>((resolve) => { answer = () => resolve(key); }) });
  return () => answer();
}

describe("a panel waits for its reads before it moves in", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("goes once nothing has been loading for a moment", async () => {
    const client = new QueryClient();
    const done = vi.fn();
    const answer = slowRead(client, "task");
    whenSettled(client, done, { cap: 1000, quiet: 30 });
    await vi.advanceTimersByTimeAsync(100);
    expect(done).not.toHaveBeenCalled();
    answer();
    await vi.advanceTimersByTimeAsync(10);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("waits for a read that starts as another lands, since the first led to it", async () => {
    const client = new QueryClient();
    const done = vi.fn();
    const first = slowRead(client, "task");
    whenSettled(client, done, { cap: 1000, quiet: 30 });
    first();
    await vi.advanceTimersByTimeAsync(5);
    const second = slowRead(client, "comments");
    await vi.advanceTimersByTimeAsync(100);
    expect(done).not.toHaveBeenCalled();
    second();
    await vi.advanceTimersByTimeAsync(40);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("goes anyway at the cap, and only once", async () => {
    const client = new QueryClient();
    const done = vi.fn();
    const answer = slowRead(client, "task");
    whenSettled(client, done, { cap: 300, quiet: 30 });
    await vi.advanceTimersByTimeAsync(300);
    expect(done).toHaveBeenCalledTimes(1);
    answer();
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("goes after the quiet moment when nothing is loading", async () => {
    const client = new QueryClient();
    const done = vi.fn();
    whenSettled(client, done, { cap: 1000, quiet: 30 });
    await vi.advanceTimersByTimeAsync(31);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("does nothing once stopped", async () => {
    const client = new QueryClient();
    const done = vi.fn();
    const stop = whenSettled(client, done, { cap: 100, quiet: 30 });
    stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(done).not.toHaveBeenCalled();
  });
});
