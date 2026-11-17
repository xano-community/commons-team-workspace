import { f, table } from "@xano/sdk";
import { SEED_RUNS } from "../../world.js";
import { user } from "../user.js";
import { space } from "../spaces/space.js";

export const RUN_STATES = ["queued", "claimed", "working", "waiting", "done", "failed"] as const;
export const RUN_REASONS = ["", "timeout", "step_limit", "no_completion", "canceled", "budget", "key_revoked", "sponsor_left", "removed_from_space", "model_error"] as const;

/**
 * One piece of work a hosted agent was asked to do, from a mention or an assignment. `claimed` is the moment between the
 * runner taking it and the model starting: people read it as queued. `base_url` is captured in the request that asks for the
 * run, because a scheduled task has no address of its own to call back on.
 */
export const agent_run = table({
  name: "agent_run",
  description: "A hosted agent's run: what asked for it, where it may act, how far it got, and how it ended.",
  schema: {
    agent_id: f.tableRef(user, { required: true }),
    requested_by: f.tableRef(user, { required: true }),
    /** The system connection it runs as. 0 until it's claimed. */
    connection_id: f.int(),
    status: f.enum(RUN_STATES, { default: "queued" }),
    reason: f.enum(RUN_REASONS, { default: "" }),
    /** Plain words about how it failed. Never a key, and never a token. */
    detail: f.text(),
    /** What asked for it: "message", "task" or "doc". */
    source_type: f.text({ required: true }),
    source_id: f.int({ required: true }),
    /** A message's conversation, so a screen finds a conversation's runs in one read. Empty for a task. */
    conversation_id: f.int(),
    /** Where its notes go: the thread on its record, or the DM it was asked in. Opened when the run starts. */
    thread_id: f.int(),
    /** The doc it's working on, whatever asked for it. A screen reads this for its "working here" mark. */
    doc_id: f.int(),
    /** Its bounds. 0 and 0 can't happen for a run that has somewhere to act. */
    space_id: f.tableRef(space),
    dm_id: f.int(),
    /** Set while it's live, so one agent can't hold two runs on one record. A unique index holds that, even in a race. */
    active_key: f.text({ nullable: true }),
    base_url: f.text({ access: "private" }),
    attempt: f.int({ default: 1 }),
    /** How many agents handed this on since a person asked. 0 for a person's own request. */
    hops: f.int(),
    /** Every agent earlier in the chain, as ",4,,5,", so none of them is asked twice. */
    chain: f.text(),
    /** The agent that handed this on. Its requester stays the person who started the chain. */
    asked_by: f.tableRef(user),
    /** The thread it was handed on from, which is what the hourly limit counts. */
    handed_from: f.int(),
    /** This run named another agent and the limits stopped it there, so the record can say a person can carry on. */
    chain_stopped: f.bool(),
    /** When it first took a slot, which is what the daily limits count. A run picked up again isn't counted twice. */
    spent_at: f.timestamp({ nullable: true }),
    /** How often the sweep has taken it back from a runner that vanished. */
    reclaims: f.int(),
    /** Only `report_progress` with done sets this, so a confident reply alone can't finish a run. */
    done_reported: f.bool(),
    /** The latest thing it said it was doing. */
    last_note: f.text(),
    steps: f.int(),
    /**
     * What each tool call did, in order: `{ tool, ok, type, id }`. Never what was said or found, only the tool, whether it worked and
     * the record it touched, so a reader's own access decides whether they see a title (KTD11).
     */
    step_log: f.json(),
    tool_calls: f.int(),
    tool_errors: f.int(),
    waiting_on: f.tableRef(user),
    /** The approval it last asked for. While it's `waiting` with one, a decision wakes it, and a reply in the thread doesn't. */
    approval_id: f.int(),
    claimed_at: f.timestamp({ nullable: true }),
    started_at: f.timestamp({ nullable: true }),
    finished_at: f.timestamp({ nullable: true }),
    stopped_by: f.tableRef(user),
    /**
     * A run the demo seeds, already waiting on its approval, so the first minute shows an agent asking before any model key is set.
     * However it's decided, it ends there, with no model call (KTD3). Screens label it "Sample run".
     */
    sample: f.bool(),
    is_demo: f.bool(),
  },
  index: [
    { type: "btree", fields: [{ name: "status", op: "asc" }, { name: "created_at", op: "asc" }] },
    { type: "btree", fields: [{ name: "source_type", op: "asc" }, { name: "source_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "conversation_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "thread_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "doc_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "handed_from", op: "asc" }, { name: "created_at", op: "asc" }] },
    { type: "btree", fields: [{ name: "spent_at", op: "asc" }] },
    { type: "btree|unique", fields: [{ name: "active_key", op: "asc" }] },
  ],
  seed: SEED_RUNS,
});
