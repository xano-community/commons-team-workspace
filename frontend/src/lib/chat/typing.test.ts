import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTypingList, createTypingSender, typingLine } from "./typing";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("telling others you're typing", () => {
  it("sends once every three seconds at most, however fast the keys", () => {
    const send = vi.fn();
    const t = createTypingSender(send);
    for (let i = 0; i < 20; i++) { t.input(); vi.advanceTimersByTime(100); }
    expect(send.mock.calls.filter(([s]) => s === "on")).toHaveLength(1);
    vi.advanceTimersByTime(1100);
    t.input();
    expect(send.mock.calls.filter(([s]) => s === "on")).toHaveLength(2);
    t.stop();
  });

  it("says stop after five idle seconds, or on sending, and only once", () => {
    const send = vi.fn();
    const t = createTypingSender(send);
    t.input();
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenLastCalledWith("off");
    t.stop();
    expect(send.mock.calls.filter(([s]) => s === "off")).toHaveLength(1);
    t.input();
    t.stop();
    expect(send.mock.calls.filter(([s]) => s === "off")).toHaveLength(2);
  });
});

describe("hearing who's typing", () => {
  it("drops your own id, because your other tab hears you too", () => {
    const changed = vi.fn();
    const list = createTypingList(1, changed);
    list.frame(1, "on");
    expect(list.ids()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it("expires by itself, so a lost stop can't leave someone typing", () => {
    const list = createTypingList(1, vi.fn());
    list.frame(2, "on");
    expect(list.ids()).toEqual([2]);
    vi.advanceTimersByTime(6000);
    expect(list.ids()).toEqual([]);
  });

  it("clears at once on a stop, and when their message arrives", () => {
    const list = createTypingList(1, vi.fn());
    list.frame(2, "on"); list.frame(3, "on");
    list.frame(2, "off");
    list.sent(3);
    expect(list.ids()).toEqual([]);
  });

  it("reads as names, then as several people", () => {
    expect(typingLine([])).toBe("");
    expect(typingLine(["Ada"])).toBe("Ada is typing");
    expect(typingLine(["Ada", "Ben"])).toBe("Ada and Ben are typing");
    expect(typingLine(["Ada", "Ben", "Cy"])).toBe("Ada, Ben and Cy are typing");
    expect(typingLine(["Ada", "Ben", "Cy", "Dee"])).toBe("Several people are typing");
  });
});
