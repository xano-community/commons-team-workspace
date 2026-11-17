// @vitest-environment node
// The demo's clock: whatever the moment and the zone a deploy runs in, what people said lands in working hours, in order, in the
// past, and the same deploy moment always gives the same times. The seeded world is checked against it too.
import { describe, expect, it } from "vitest";
import { TODAY_REACH_MINUTES, WORK_ENDS, WORK_STARTS, deployZone, partsIn, seedClock } from "./seed-clock";
import { SEED_CLOCK, SEED_CONVERSATIONS, SEED_MESSAGES, SEED_RUNS, SEED_APPROVALS, SEED_TASKS } from "./world";

const ZONES = ["America/Los_Angeles", "Europe/London", "Australia/Sydney", "Asia/Kolkata", "UTC"];
const HOUR = 3_600_000;
const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const working = (ms: number, zone: string) => {
  const p = partsIn(ms, zone);
  const at = p.hour * 60 + p.minute;
  return p.weekday >= 1 && p.weekday <= 5 && at >= minutes(WORK_STARTS) && at <= minutes(WORK_ENDS);
};
// Every hour of a week that crosses a clock change in Europe and the US, and one in the southern summer.
const MOMENTS = [Date.UTC(2026, 9, 22, 0, 7), Date.UTC(2026, 10, 9, 0, 7), Date.UTC(2027, 0, 11, 0, 7)].flatMap((start) => Array.from({ length: 24 * 8 }, (_, h) => start + h * HOUR));

describe("the seed clock", () => {
  it("puts every line in working hours, in the past, on the day it names", () => {
    for (const zone of ZONES) {
      for (const now of MOMENTS) {
        const clock = seedClock(now, zone);
        for (const [days, hhmm] of [[1, "09:00"], [1, "18:00"], [3, "09:12"], [5, "16:20"]] as const) {
          const when = clock.at(days, hhmm);
          const p = partsIn(when, zone);
          expect(working(when, zone), `${zone} ${new Date(now).toISOString()} ${days} ${hhmm}`).toBe(true);
          expect(`${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`).toBe(hhmm);
          expect(when).toBeLessThan(now);
        }
        for (const back of [0, 70, TODAY_REACH_MINUTES]) {
          const when = clock.today(back);
          expect(working(when, zone), `${zone} ${new Date(now).toISOString()} today -${back}`).toBe(true);
          expect(when).toBeLessThan(now);
        }
        // Yesterday's last line comes before today's first.
        expect(clock.at(1, WORK_ENDS)).toBeLessThan(clock.today(TODAY_REACH_MINUTES));
      }
    }
  });
  it("keeps today's lines recent when the deploy is in the afternoon of a working day", () => {
    const tuesday3pm = Date.UTC(2026, 10, 10, 23, 0); // 15:00 in Los Angeles
    const clock = seedClock(tuesday3pm, "America/Los_Angeles");
    expect(clock.today(70)).toBe(tuesday3pm - 60_000 - 70 * 60_000);
    expect(partsIn(clock.at(1, "09:12"), "America/Los_Angeles")).toMatchObject({ weekday: 1, day: 9, hour: 9, minute: 12 });
  });
  it("tells the story as yesterday's, before the working day has had enough of itself, and skips the weekend", () => {
    const mondayEarly = Date.UTC(2026, 10, 9, 16, 0); // Monday 08:00 in Los Angeles
    const clock = seedClock(mondayEarly, "America/Los_Angeles");
    expect(partsIn(clock.today(0), "America/Los_Angeles")).toMatchObject({ weekday: 5, hour: 17, minute: 45 });
    expect(partsIn(clock.at(1, "10:00"), "America/Los_Angeles")).toMatchObject({ weekday: 4 });
  });
  it("gives the same times for the same moment, and calendar dates in the zone", () => {
    const now = Date.UTC(2026, 10, 11, 7, 30); // Tuesday 23:30 in Los Angeles, Wednesday in UTC
    expect(seedClock(now, "America/Los_Angeles").at(2, "11:05")).toBe(seedClock(now, "America/Los_Angeles").at(2, "11:05"));
    expect(seedClock(now, "America/Los_Angeles").dateFromNow(0)).toBe("2026-11-10");
    expect(seedClock(now, "UTC").dateFromNow(-1)).toBe("2026-11-10");
  });
  it("refuses a line it can't place honestly", () => {
    const clock = seedClock(Date.UTC(2026, 10, 10, 23, 0), "UTC");
    expect(() => clock.at(1, "22:00")).toThrow(/outside working hours/);
    expect(() => clock.today(TODAY_REACH_MINUTES + 1)).toThrow();
  });
});

describe("the seeded world's clock", () => {
  const zone = deployZone();
  it("stamps every message a person or an agent wrote inside working hours, before the deploy", () => {
    expect(SEED_CLOCK.zone).toBe(zone);
    for (const m of SEED_MESSAGES) {
      expect(working(m.created_at, zone), `${m.body.slice(0, 40)} at ${new Date(m.created_at).toISOString()}`).toBe(true);
      expect(m.created_at).toBeLessThanOrEqual(Date.now());
    }
  });
  it("keeps each conversation's messages in order, and says good morning in the morning", () => {
    for (let id = 1; id <= SEED_CONVERSATIONS.length; id++) {
      const said = SEED_MESSAGES.filter((m) => m.conversation_id === id).sort((a, b) => a.seq - b.seq).map((m) => m.created_at);
      expect(said, `conversation ${id}`).toEqual([...said].sort((a, b) => a - b));
    }
    const morning = SEED_MESSAGES.find((m) => m.body.startsWith("Morning all"))!;
    expect(partsIn(morning.created_at, zone).hour).toBeLessThan(12);
  });
  it("starts each run and its approval when it was asked for", () => {
    const sample = SEED_RUNS.find((r) => r.sample)!;
    const ask = SEED_MESSAGES.find((m) => m.thread_id === sample.thread_id)!;
    expect(sample.created_at).toBe(ask.created_at);
    expect(SEED_APPROVALS[0].created_at).toBeGreaterThan(ask.created_at);
    for (const run of SEED_RUNS.filter((r) => r.finished_at)) expect(working(run.created_at, zone)).toBe(true);
  });
  it("dates work in the zone's calendar", () => {
    const due = SEED_TASKS.map((t) => t.due_on).filter(Boolean);
    expect(due).toContain(SEED_CLOCK.dateFromNow(-1));
    for (const d of due) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
