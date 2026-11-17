// How a run reads, apart from how it looks. `queued`, `working` and the rest are the server's; the words here are what a
// person sees, so every state and failure reason can be tested alone.
import type { AgentRun, RunStep } from "../../../../xano/query/agents.js";

export type { AgentRun };
export type RunTone = "live" | "waiting" | "done" | "failed";
/** The one thing a person can do about a run that ended short: try again, or go to the agent's page and put it right there. */
export type RunAction = "retry" | "agent" | null;
export type RunLine = { tone: RunTone; label: string; note: string; canStop: boolean; canRetry: boolean; action: RunAction; worked: string };
export type { RunStep };

export const MOST_ATTEMPTS = 3;
/** Each reason a run ends short, as one sentence and the one thing to do about it. */
export const REASONS: Record<string, { words: string; action: Exclude<RunAction, null> | "wait" }> = {
  timeout: { words: "It ran out of time. Try again, or ask for something smaller.", action: "retry" },
  step_limit: { words: "It used all its steps before finishing. Try again, or ask for something smaller.", action: "retry" },
  no_completion: { words: "It stopped before it was done. Check what it left, then try again.", action: "retry" },
  budget: { words: "Today's agent requests are used. More are available tomorrow.", action: "wait" },
  key_revoked: { words: "Its connection was turned off, so it can't work until it has a new one.", action: "agent" },
  sponsor_left: { words: "Its sponsor has left, so it can't work until it has a new one.", action: "agent" },
  removed_from_space: { words: "It's no longer in this space. Add it back, then try again.", action: "retry" },
  model_error: { words: "The model didn't answer. Try again in a moment.", action: "retry" },
  canceled: { words: "", action: "retry" },
};
const UNKNOWN = { words: "It stopped before it was done. Try again in a moment.", action: "retry" as const };
/** The reasons whose stored words help a person. The rest are for whoever reads the row. */
const SAYS_MORE = ["budget", "model_error"];
/** What a record shows when agents reach their limit with each other. The next step is a person's. */
export const CHAIN_STOPPED = "Chain stopped: a person can continue it.";

/** "42 s", "3 min", or nothing for a run that never got going. */
export function tookText(run: Pick<AgentRun, "started_at" | "finished_at">): string {
  if (!run.started_at || !run.finished_at) return "";
  const seconds = Math.max(1, Math.round((Number(run.finished_at) - Number(run.started_at)) / 1000));
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

const stepsText = (n: number) => (n === 1 ? "1 step" : `${n} steps`);
const isLive = (s: string) => s === "queued" || s === "claimed" || s === "working" || s === "waiting";

/** "Worked for 42 s, 6 steps": what an ended run did, which opens to its steps. Empty for one that never got going. */
export function workedText(run: Pick<AgentRun, "started_at" | "finished_at" | "tool_calls">): string {
  const took = tookText(run);
  const steps = run.tool_calls ? stepsText(run.tool_calls) : "";
  if (took && steps) return `Worked for ${took}, ${steps}`;
  if (took) return `Worked for ${took}`;
  return steps ? `Worked for ${steps}` : "";
}

/** What a run says. `guest` can stop a run and can't start one, so Retry is never theirs. */
/** `me`, when given, is who's reading: a run waiting on them says so in the second person. */
export function runLine(run: AgentRun, o: { modelReady: boolean; nameOf: (id: number) => string; guest: boolean; paused?: boolean; me?: number }): RunLine {
  const said = statusLine(run, o);
  return run.chain_stopped ? { ...said, note: said.note ? `${said.note} ${CHAIN_STOPPED}` : CHAIN_STOPPED } : said;
}

function statusLine(run: AgentRun, o: { modelReady: boolean; nameOf: (id: number) => string; guest: boolean; paused?: boolean; me?: number }): RunLine {
  const canStop = isLive(run.status);
  const line = { canStop, canRetry: false, note: "", action: null, worked: "" } as const;
  switch (run.status) {
    case "queued":
      if (o.paused) return { ...line, tone: "waiting", label: "Paused", note: "Agents are paused here. This starts once an admin turns them back on." };
      if (!o.modelReady) return { ...line, tone: "waiting", label: "Needs a model key to run", note: "" };
      return { ...line, tone: "live", label: run.attempt > 1 ? `Queued, try ${run.attempt} of ${MOST_ATTEMPTS}` : "Queued" };
    case "claimed":
      return { ...line, tone: "live", label: "Starting" };
    case "working":
      return { ...line, tone: "live", label: "Working", note: run.last_note };
    case "waiting":
      if (run.approval_id && run.waiting_on && run.waiting_on === o.me) return { ...line, tone: "waiting", label: "Waiting for your OK", note: run.last_note };
      if (run.approval_id) return { ...line, tone: "waiting", label: run.waiting_on ? `Waiting for ${o.nameOf(run.waiting_on)} to approve` : "Waiting for an admin to approve", note: run.last_note };
      return { ...line, tone: "waiting", label: `Waiting for ${o.nameOf(run.waiting_on)}`, note: run.last_note };
    case "done":
      return { ...line, tone: "done", label: "Done", note: run.last_note, worked: workedText(run) };
    default: {
      const stopped = run.reason === "canceled";
      const known = REASONS[run.reason] ?? UNKNOWN;
      const words = stopped ? `Stopped by ${o.nameOf(run.stopped_by)}.` : known.words;
      const showDetail = SAYS_MORE.includes(run.reason) && run.detail;
      const said = showDetail ? run.detail : words;
      const triesLeft = run.attempt < MOST_ATTEMPTS;
      const retry = known.action === "retry" && !o.guest;
      if (retry && !triesLeft) {
        return { ...line, canStop: false, tone: "failed", label: `Tried ${MOST_ATTEMPTS} times`, note: `${said} Ask again in a new message.`, worked: workedText(run) };
      }
      const action: RunAction = retry ? "retry" : known.action === "agent" && !o.guest ? "agent" : null;
      return { tone: "failed", label: stopped ? "Stopped" : "Couldn't finish", note: said, canStop: false, canRetry: action === "retry", action, worked: workedText(run) };
    }
  }
}

/** What one step did, for someone who may or may not be able to open what it touched. Never anything the agent said or found. */
const STEP_WORDS: Record<string, [done: string, short: string]> = {
  post_message: ["Posted in", "Couldn't post a message"],
  save_task: ["Saved the task", "Couldn't save a task"],
  save_doc: ["Worked on the doc", "Couldn't change a doc"],
  save_crm_record: ["Updated", "Couldn't update a customer record"],
  save_file: ["Saved the file", "Couldn't save a file"],
  read_record: ["Read", "Couldn't read a record"],
  report_progress: ["Said how it was going", "Couldn't say how it was going"],
  search: ["Searched the workspace", "Couldn't search"],
  my_inbox: ["Checked its inbox", "Couldn't check its inbox"],
  request_action: ["Asked a person first", "Couldn't ask a person"],
  check_approval: ["Checked on an approval", "Couldn't check on an approval"],
};
export type StepRecord = { state: string; title: string; href: string } | undefined;
/** A step's words and where it leads. A record this reader can't open is "something you can't open", and leads nowhere. */
export function stepLine(step: RunStep, record: StepRecord): { text: string; title: string; href: string; ok: boolean } {
  const [done, short] = STEP_WORDS[step.tool] ?? [`Used ${step.tool.replace(/_/g, " ")}`, `Couldn't use ${step.tool.replace(/_/g, " ")}`];
  if (!step.ok) return { text: short, title: "", href: "", ok: false };
  if (!step.type || !step.id) return { text: done, title: "", href: "", ok: true };
  const open = record && (record.state === "live" || record.state === "archived") && record.title;
  return open ? { text: done, title: record.title, href: record.href, ok: true } : { text: done, title: "something you can't open", href: "", ok: true };
}

/** A connected agent picks work up when its owner next runs it. Past this with nothing picked up, the record says Stalled. */
export const STALLED_AFTER_MS = 30 * 60_000;
export type Pickup = { created_at: number; read_at: number | null };
/** What a record says about work handed to a connected agent. Once `my_inbox` has handed it over, it's never Stalled. */
export function pickupLine(item: Pickup, name: string, now: number): { tone: RunTone; label: string; short: string; note: string } {
  if (item.read_at) return { tone: "done", label: `${name} picked this up`, short: "Picked this up", note: "" };
  if (now - Number(item.created_at) > STALLED_AFTER_MS) return { tone: "waiting", label: "Stalled", short: "Stalled", note: `${name} hasn't picked this up in 30 minutes. It runs when its owner starts it, so ask them to.` };
  return { tone: "waiting", label: `Waiting for ${name} to pick this up`, short: "Waiting to pick this up", note: `${name} runs elsewhere, and picks this up when it next runs.` };
}

/** The agents a body names that aren't among those who can read it. */
export const outsidersIn = (named: number[], here: { id: number }[], agents: { id: number; name: string }[]) =>
  agents.filter((a) => named.includes(a.id) && !here.some((p) => p.id === a.id));

/** A body with these agents' mentions turned into their plain names, so it sends and asks nothing of them. */
export const withoutAgents = (body: string, agents: { id: number; name: string }[]) => agents.reduce((text, a) => text.split(`<@${a.id}>`).join(a.name), body);

/** Who to ask, in words: "Ask Avery Chen to add Scout to this space." */
export function askToAdd(names: string[], managers: string[]): string {
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const it = names.length === 1 ? who : "them";
  if (!managers.length) return `Ask an admin to add ${it} to this space.`;
  const asked = managers.length === 1 ? managers[0] : `${managers.slice(0, -1).join(", ")} or ${managers.at(-1)}`;
  return `Ask ${asked} to add ${it} to this space.`;
}

/** The run each message or task shows: its newest. */
export function newestBySource<T extends Pick<AgentRun, "id" | "source_type" | "source_id">>(runs: T[], type: string): Map<number, T> {
  const out = new Map<number, T>();
  for (const r of runs) if (r.source_type === type && (out.get(r.source_id)?.id ?? 0) < r.id) out.set(r.source_id, r);
  return out;
}

/** A stand-in for the run an assignment is about to start, so the record says Queued the moment it's assigned. */
export const queuedStandIn = (agent: { id: number; name: string }, requestedBy: number): AgentRun => ({
  id: 0, created_at: 0, agent_id: agent.id, agent_name: agent.name, requested_by: requestedBy, status: "queued", reason: "", detail: "", source_type: "task", source_id: 0, conversation_id: 0, thread_id: 0, doc_id: 0, space_id: 0, dm_id: 0,
  attempt: 1, hops: 0, chain_stopped: false, reclaims: 0, done_reported: false, last_note: "", steps: 0, tool_calls: 0, tool_errors: 0, step_log: [], waiting_on: 0, approval_id: 0, claimed_at: null, started_at: null, finished_at: null, stopped_by: 0, sample: false, is_demo: false,
});

/** How long a fresh mention may say Queued with no run to show for it. */
const ASKED_FOR_MS = 8000;

/** The hosted agent a message that's only just been sent is asking, if any. */
export function askedOf<T extends { id: number }>(row: { body: string; created_at: number }, agents: T[], now: number): T | undefined {
  if (now - row.created_at > ASKED_FOR_MS) return undefined;
  return agents.find((a) => row.body.includes(`<@${a.id}>`));
}

/** A run the model turned away for its key, which only a new key puts right. */
export const refusedKey = (run: Pick<AgentRun, "status" | "reason" | "detail">, keyName: string) => run.status === "failed" && run.reason === "model_error" && !!keyName && run.detail.includes(keyName);

/** How a person fixes a missing key: the one line an admin runs, with no key in it. */
export const keyCommand = (keyName: string) => `printf %s "$KEY" | npx @xano/sdk env set ${keyName}`;

/** A live run is polled as well, so a lost frame can't leave it looking stuck. */
export const pollEvery = (runs: Pick<AgentRun, "status">[] | undefined) => (runs?.some((r) => isLive(r.status) && r.status !== "waiting") ? 5000 : false);
