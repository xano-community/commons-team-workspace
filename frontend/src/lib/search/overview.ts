// What the overview says, from what the server read. It stays here so the words and the rules can be tested without a screen.
export type OverviewTask = { id: number; title: string; status: string; priority: string; due_on: string | null; assignee_id: number };
export type OverviewRun = { id: number; status: string; last_note: string; thread_id: number; conversation_id: number; source_type: string; source_id: number; created_at: number; finished_at: number | null; agent_name: string | null };
export type Started = { message: number; task: number; doc: number; file: number; agent: number; people: number };
export type OverviewDeal = { id: number; value: number; close_on: string };
export type Overview = {
  tasks: { open: number; late: number; items: OverviewTask[] }; agents: { active: number; items: OverviewRun[] }; started: Started; spaces: number;
  /** When each finished task was finished, and each run started, over the last two weeks, in what the person reaches. */
  trends: { done_at: number[]; runs_at: number[] };
  /** Open deals with a close date. Null for someone who can't open customers. */
  deals: OverviewDeal[] | null;
};

const DAY = 86_400_000;
const startOfDay = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * This week against the week before, from when each thing happened. A week is the last 7 days, today included, and `days` is the
 * last 14 of them, oldest first, so the line shows both weeks the two numbers compare.
 */
export function weekTrend(times: readonly number[], now = Date.now()): { week: number; last: number; days: number[] } {
  const first = startOfDay(now) - 13 * DAY;
  const days = new Array(14).fill(0) as number[];
  for (const t of times) {
    // Rounded, because a day the clocks change on is an hour longer or shorter.
    const i = Math.round((startOfDay(t) - first) / DAY);
    if (i >= 0 && i < 14) days[i]++;
  }
  return { week: days.slice(7).reduce((a, b) => a + b, 0), last: days.slice(0, 7).reduce((a, b) => a + b, 0), days };
}

const dayOf = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** The open deals due to close this calendar month, what they're worth, and how many of them are already past their date. */
export function closingThisMonth(deals: readonly OverviewDeal[], now = Date.now()): { count: number; value: number; late: number } {
  const today = dayOf(now), month = today.slice(0, 7);
  const due = deals.filter((d) => d.close_on?.slice(0, 7) === month);
  return { count: due.length, value: due.reduce((sum, d) => sum + (d.value || 0), 0), late: due.filter((d) => d.close_on < today).length };
}

/** Where a run's row goes: the work it was asked about, so a waiting draft opens where it waits. */
export function runHref(run: Pick<OverviewRun, "source_type" | "source_id" | "thread_id" | "conversation_id">): string {
  if (run.source_type === "task" && run.source_id) return `/tasks/${run.source_id}`;
  if (run.conversation_id && run.thread_id) return `/chat/${run.conversation_id}?thread=${run.thread_id}`;
  return `/chat/${run.thread_id || run.conversation_id}`;
}

const GOING = ["queued", "claimed", "working", "waiting"];
export const runTone = (run: Pick<OverviewRun, "status">) => (GOING.includes(run.status) ? "going" : "ended");

/** What a run is on, in its own last words. */
export function runLine(run: Pick<OverviewRun, "status" | "last_note">): string {
  if (run.last_note) return run.last_note;
  return run.status === "failed" ? "stopped before it finished" : runTone(run) === "going" ? "is starting" : "finished";
}

/** Each step is done by doing it: the row exists or it doesn't, and a click on the checklist proves nothing. */
/** `answer`: where the newest request waiting on the person is, so the step opens it rather than a list of them. */
export function firstSteps(started: Started, o: { canInvite: boolean; guest: boolean; people: number; waiting?: number; answer?: string }) {
  const steps = [
    { id: "message", title: "Say hello in a channel", description: "Open Chat and send your first message.", href: "/chat", done: started.message > 0 },
    { id: "task", title: "Add a task", description: "Give someone, or an agent, something to do.", href: "/tasks?new=1", done: started.task > 0 },
    { id: "doc", title: "Write a doc", description: "Everyone in the space can edit it with you.", href: "/docs?new=1", done: started.doc > 0 },
    { id: "file", title: "Add a file", description: "Keep it beside the work it belongs to.", href: "/files", done: started.file > 0 },
  ];
  if (o.guest) return steps.slice(0, 1);
  return [
    ...steps,
    { id: "agent", title: "Ask an agent", description: "Mention one in a conversation and watch it work.", href: "/agents", done: started.agent > 0 },
    // Done when nothing an agent asked is still waiting on this person: deciding one is the moment the demo is built around.
    ...(o.waiting === undefined ? [] : [{ id: "approve", title: "Answer an agent", description: "Read what it wants to do, change a word if you like, then approve or decline.", href: o.answer || "/approvals", done: o.waiting === 0 }]),
    ...(o.canInvite ? [{ id: "invite", title: "Invite a teammate", description: "Make a link that signs them in with the role you pick.", href: "/team?invite=1", done: started.people > 1 }] : []),
  ];
}
