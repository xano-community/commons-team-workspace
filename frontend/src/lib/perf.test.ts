import { describe, expect, it, vi } from "vitest";
import { loadInTurn, percentile, withinBudget } from "./perf";

describe("budgets", () => {
  it("reads percentiles by nearest rank, as the QA gate does", () => {
    const samples = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(samples, 75)).toBe(15);
    expect(percentile(samples, 95)).toBe(19);
  });

  it("fails a regression at either percentile", () => {
    expect(withinBudget("palette-open", [20, 30, 40, 45])).toBe(true);
    expect(withinBudget("palette-open", [60, 62, 63, 75])).toBe(false);
    expect(withinBudget("palette-open", [10, 10, 10, 150])).toBe(false);
  });
});

describe("loading screens ahead of a click", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  it("loads one at a time, each in its own quiet moment, past one that fails", async () => {
    const queue: (() => void)[] = [];
    const later = (fn: () => void) => { queue.push(fn); return () => {}; };
    const done: string[] = [];
    loadInTurn([() => done.push("a"), () => Promise.reject(new Error("gone")), () => done.push("c")], later);
    expect(done).toEqual([]);
    while (queue.length) { queue.shift()!(); await flush(); }
    expect(done).toEqual(["a", "c"]);
  });
  it("stops when asked", async () => {
    const queue: (() => void)[] = [];
    const cancelled = vi.fn();
    const done: string[] = [];
    const stop = loadInTurn([() => done.push("a"), () => done.push("b")], (fn) => { queue.push(fn); return cancelled; });
    queue.shift()!(); await flush();
    stop();
    expect(cancelled).toHaveBeenCalled();
    expect(done).toEqual(["a"]);
  });
});
