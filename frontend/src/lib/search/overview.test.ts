import { describe, expect, it } from "vitest";
import { closingThisMonth, firstSteps, runHref, runLine, runTone, weekTrend } from "./overview";

const none = { message: 0, task: 0, doc: 0, file: 0, agent: 0, people: 1 };

describe("first steps", () => {
  it("are done by the rows that exist, not by a click", () => {
    const steps = firstSteps({ ...none, task: 3 }, { canInvite: true, guest: false, people: 1 });
    expect(steps.filter((s) => s.done).map((s) => s.id)).toEqual(["task"]);
  });
  it("offer an invite only to someone who can send one, and a guest only a hello", () => {
    expect(firstSteps(none, { canInvite: false, guest: false, people: 1 }).map((s) => s.id)).not.toContain("invite");
    expect(firstSteps(none, { canInvite: false, guest: true, people: 1 }).map((s) => s.id)).toEqual(["message"]);
  });
  it("count a teammate once someone else is here", () => {
    const invite = (people: number) => firstSteps({ ...none, people }, { canInvite: true, guest: false, people }).find((s) => s.id === "invite")!;
    expect(invite(1).done).toBe(false);
    expect(invite(2).done).toBe(true);
  });
});

describe("a run's line", () => {
  it("uses the run's own words, and something plain when it has none", () => {
    expect(runLine({ status: "working", last_note: "Reading the thread" })).toBe("Reading the thread");
    expect(runLine({ status: "queued", last_note: "" })).toBe("is starting");
    expect(runLine({ status: "failed", last_note: "" })).toBe("stopped before it finished");
  });
  it("counts a run waiting on someone as going", () => {
    expect(runTone({ status: "waiting" })).toBe("going");
    expect(runTone({ status: "done" })).toBe("ended");
  });
});

describe("the week's trend", () => {
  const now = new Date(2026, 10, 9, 15).getTime();
  const daysAgo = (n: number, hour = 10) => new Date(2026, 10, 9 - n, hour).getTime();
  it("counts the last 7 days, today included, against the 7 before", () => {
    const t = weekTrend([daysAgo(0), daysAgo(1), daysAgo(6, 0), daysAgo(7, 23), daysAgo(13), daysAgo(14)], now);
    expect(t.week).toBe(3);
    expect(t.last).toBe(2);
  });
  it("draws both weeks day by day, oldest first, and nothing from outside them", () => {
    const t = weekTrend([daysAgo(0), daysAgo(0), daysAgo(13), daysAgo(20)], now);
    expect(t.days).toHaveLength(14);
    expect(t.days[13]).toBe(2);
    expect(t.days[0]).toBe(1);
    expect(t.days.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe("deals closing this month", () => {
  const now = new Date(2026, 10, 9, 15).getTime();
  it("adds up this month's open deals and says how many are past their date", () => {
    const deals = [{ id: 1, value: 18000, close_on: "2026-11-21" }, { id: 2, value: 85000, close_on: "2026-11-07" }, { id: 3, value: 64000, close_on: "2026-12-07" }, { id: 4, value: 1000, close_on: "2026-10-30" }];
    expect(closingThisMonth(deals, now)).toEqual({ count: 2, value: 103000, late: 1 });
  });
  it("is nothing at all with no deals", () => {
    expect(closingThisMonth([], now)).toEqual({ count: 0, value: 0, late: 0 });
  });
});

describe("where a run's row goes", () => {
  it("opens the task it worked on, or the thread it waits in beside its channel", () => {
    expect(runHref({ source_type: "task", source_id: 4, thread_id: 9, conversation_id: 0 })).toBe("/tasks/4");
    expect(runHref({ source_type: "message", source_id: 12, thread_id: 9, conversation_id: 4 })).toBe("/chat/4?thread=9");
    expect(runHref({ source_type: "message", source_id: 12, thread_id: 0, conversation_id: 4 })).toBe("/chat/4");
  });
});

describe("answering an agent", () => {
  it("is a step until nothing an agent asked waits on the person, and never a guest's", () => {
    const step = (waiting: number) => firstSteps(none, { canInvite: false, guest: false, people: 1, waiting }).find((s) => s.id === "approve")!;
    expect(step(1).done).toBe(false);
    expect(step(0).done).toBe(true);
    expect(firstSteps(none, { canInvite: false, guest: true, people: 1, waiting: 1 }).map((s) => s.id)).not.toContain("approve");
  });
  it("opens the request itself when it knows where it is, and the list of them when it doesn't", () => {
    const step = (answer?: string) => firstSteps(none, { canInvite: false, guest: false, people: 1, waiting: 1, answer }).find((s) => s.id === "approve")!;
    expect(step("/chat/12").href).toBe("/chat/12");
    expect(step().href).toBe("/approvals");
    expect(step("").href).toBe("/approvals");
  });
});
