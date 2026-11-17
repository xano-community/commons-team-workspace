// The demo's clock. A seeded message is stamped at a time of day that fits its words, inside working hours in the workspace's
// time zone, so "Morning all" reads 09:12 and nothing lands at 3am. The zone is the one the deploy runs in: the person who deploys
// a template is the person who first opens it. Every stamp is worked out from the deploy's own moment, so one deploy always gives
// the same times, and none of them is ever in the future.

const MINUTE = 60_000;
const DAY = 86_400_000;

/** The working day the demo's people keep. */
export const WORK_STARTS = "09:00";
export const WORK_ENDS = "18:00";
/** Today's lines are written back from "now". Before this, today hasn't had enough working hours for them, so the story is yesterday's. */
export const TODAY_FROM = "12:00";
/** Today's lines reach back at most this far, so the earliest still lands after the day starts. */
export const TODAY_REACH_MINUTES = 180;
/** After the working day, today's last line lands here. */
const TODAY_LATEST = "17:45";

type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (zone: string) => {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    formatters.set(zone, f);
  }
  return f;
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A moment's calendar day and wall-clock time in a zone. */
export function partsIn(ms: number, zone: string): Parts {
  const got: Record<string, string> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) got[p.type] = p.value;
  return { year: +got.year, month: +got.month, day: +got.day, hour: +got.hour % 24, minute: +got.minute, weekday: WEEKDAYS.indexOf(got.weekday) };
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** The moment a wall clock in `zone` reads `hhmm` on a calendar day. Twice round settles a day the clocks change. */
function wallClock(year: number, month: number, day: number, hhmm: string, zone: string) {
  const want = Date.UTC(year, month - 1, day) + minutesOf(hhmm) * MINUTE;
  let ms = want;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(ms, zone);
    const read = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    ms += want - read;
  }
  return ms;
}

const isWeekday = (p: Parts) => p.weekday >= 1 && p.weekday <= 5;
/** Noon on the calendar day `days` from the one `ms` falls on, as a handle on that day that survives a clock change. */
const noonOf = (ms: number, zone: string, days = 0) => {
  const p = partsIn(ms, zone);
  return wallClock(p.year, p.month, p.day, "12:00", zone) + days * DAY;
};

export type SeedClock = {
  zone: string;
  /** The moment the story's today stands at: now, inside a working day, or the end of the last working day. */
  anchor: number;
  /** `minutes` before the anchor, for today's lines. */
  today: (minutes: number) => number;
  /** A time of day on the working day `days` working days before today's. */
  at: (days: number, hhmm: string) => number;
  /** The calendar date `days` from the deploy's own today in the zone, as YYYY-MM-DD: a due date or a close date. */
  dateFromNow: (days: number) => string;
};

export function seedClock(now: number, zone: string): SeedClock {
  const here = partsIn(now, zone);
  const minute = here.hour * 60 + here.minute;
  const onDay = (noon: number, hhmm: string) => { const p = partsIn(noon, zone); return wallClock(p.year, p.month, p.day, hhmm, zone); };
  // The working day the story's today is, as its noon.
  let day = noonOf(now, zone);
  let anchor: number;
  if (isWeekday(here) && minute >= minutesOf(TODAY_FROM)) anchor = Math.min(now - MINUTE, onDay(day, TODAY_LATEST));
  else {
    do day -= DAY; while (!isWeekday(partsIn(day, zone)));
    day = noonOf(day, zone);
    anchor = onDay(day, TODAY_LATEST);
  }
  const workingDaysBack = (n: number) => {
    let d = day;
    for (let left = n; left > 0;) {
      d = noonOf(d, zone, -1);
      if (isWeekday(partsIn(d, zone))) left--;
    }
    return d;
  };
  return {
    zone,
    anchor,
    today: (minutes) => {
      if (minutes < 0 || minutes > TODAY_REACH_MINUTES) throw new Error(`Today's lines reach back ${TODAY_REACH_MINUTES} minutes at most, not ${minutes}.`);
      return anchor - minutes * MINUTE;
    },
    at: (days, hhmm) => {
      if (days < 1) throw new Error("A line on today's date is written with today(minutes).");
      if (minutesOf(hhmm) < minutesOf(WORK_STARTS) || minutesOf(hhmm) > minutesOf(WORK_ENDS)) throw new Error(`${hhmm} is outside working hours.`);
      return onDay(workingDaysBack(days), hhmm);
    },
    dateFromNow: (days) => {
      const p = partsIn(noonOf(now, zone, days), zone);
      return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    },
  };
}

/** The zone a deploy runs in. */
export const deployZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
