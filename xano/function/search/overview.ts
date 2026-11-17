// The overview's one read: what needs this person, what agents are doing where they can see, and how far they've got with the
// app. Every count comes from the same rows as its list, filtered by the same reach.
import { and, c, cmp, col, defineFunction, expr, fl, inp, input, or, ref, s, withFilters } from "@xano/sdk";
import { docTable } from "../../docs.js";
import { rbac } from "../../rbac.js";
import { agent_run } from "../../table/agents/agent_run.js";
import { deal } from "../../table/crm/deal.js";
import { pipeline_stage } from "../../table/crm/pipeline_stage.js";
import { file_record } from "../../table/files/file_record.js";
import { message } from "../../table/messaging/message.js";
import { task } from "../../table/tasks/task.js";
import { user } from "../../table/user.js";
import { inReachedSpaces, reachOf } from "../access/reach.js";

const MOST_TASKS = 5;
const MOST_RUNS = 6;
/** Two weeks back, so this week reads against the last. A cap, not a page: the cards count what's under it. */
const TREND_DAYS = 14;
const MOST_IN_TREND = 500;
const MOST_DEALS = 200;
const ACTIVE = ["queued", "claimed", "working", "waiting"];

const mine = () => [inReachedSpaces(), cmp(col("assignee_id"), "=", inp("actor_id")), cmp(col("deleted_at"), "=", c.null()), cmp(col("status"), "not in", c.array(["done", "canceled"]))];
const reachedRuns = () => or(cmp(col("space_id"), "in", ref("reach.space_ids")), cmp(col("dm_id"), "in", ref("reach.dm_ids")));
const today = () => withFilters(c.now(), fl.epochms_date("Y-m-d", "UTC"));

export const readOverview = defineFunction({
  name: "overview/read",
  description: "What needs a person, the agent work they can see, and which first steps they've taken.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), today: input.text() },
  stack: [
    reachOf(inp("actor_id"), inp("browser")),
    // "Late" is late on the viewer's calendar, which their browser knows and the server doesn't, so a due date reads the same here
    // as on the task. A missing or malformed day falls back to the server's.
    s.set_var("today", today()),
    s.conditional({ when: expr(withFilters(c.regex(/^\d{4}-\d{2}-\d{2}$/), fl.regex_test(inp("today"))), "=", c.bool(true)), then: [s.update_var("today", inp("today"))] }),
    s.db.query({ table: task, where: mine(), returnType: "count", as: "open_tasks" }),
    s.db.query({ table: task, where: [...mine(), cmp(col("due_on"), "!=", c.null()), expr(col("due_on"), "<", ref("today"))], returnType: "count", as: "late_tasks" }),
    s.db.query({ table: task, where: [...mine(), cmp(col("due_on"), "!=", c.null())], sort: [{ sortBy: "due_on", dir: "asc" }], paging: { per_page: MOST_TASKS, metadata: false }, output: ["id", "title", "status", "priority", "due_on", "assignee_id"], as: "due_tasks" }),
    s.db.query({ table: agent_run, where: [reachedRuns(), cmp(col("status"), "in", c.array(ACTIVE))], returnType: "count", as: "active_runs" }),
    s.db.query({
      table: agent_run, where: reachedRuns(), sort: [{ sortBy: "created_at", dir: "desc" }], paging: { per_page: MOST_RUNS, metadata: false },
      bind: [{ table: user, as: "who", join: "left", where: expr(col("agent_id"), "=", col("who.id")) }], eval: [{ name: "who.name", as: "agent_name" }],
      output: ["id", "status", "last_note", "thread_id", "conversation_id", "source_type", "source_id", "created_at", "finished_at", "agent_name"], as: "runs",
    }),
    s.db.query({ table: message, where: [cmp(col("author_id"), "=", inp("actor_id")), cmp(col("deleted_at"), "=", c.null())], returnType: "count", as: "said" }),
    s.db.query({ table: task, where: cmp(col("created_by"), "=", inp("actor_id")), returnType: "count", as: "tasks_made" }),
    s.db.query({ table: docTable, where: cmp(col("owner_id"), "=", inp("actor_id")), returnType: "count", as: "docs_made" }),
    s.db.query({ table: file_record, where: cmp(col("uploaded_by"), "=", inp("actor_id")), returnType: "count", as: "files_made" }),
    s.db.query({ table: agent_run, where: cmp(col("requested_by"), "=", inp("actor_id")), returnType: "count", as: "runs_asked" }),
    s.db.query({ table: user, where: and(cmp(col("kind"), "=", c.text("human")), cmp(col("status"), "=", c.text("active"))), returnType: "count", as: "people" }),
    // The trends: when each task in reach was finished, and when each run in reach started, over the last two weeks.
    s.set_var("since", withFilters(c.now(), fl.sub(c.int(TREND_DAYS * 86_400_000)))),
    s.db.query({ table: task, where: [inReachedSpaces(), cmp(col("deleted_at"), "=", c.null()), cmp(col("status"), "=", c.text("done")), expr(col("completed_at"), ">=", ref("since"))],
      sort: [{ sortBy: "completed_at", dir: "desc" }], paging: { per_page: MOST_IN_TREND, metadata: false }, output: ["completed_at"], as: "done_rows" }),
    s.array.map({ source: ref("done_rows"), as: "done_at", transform: ref("$this.completed_at") }),
    s.db.query({ table: agent_run, where: [reachedRuns(), expr(col("created_at"), ">=", ref("since"))],
      sort: [{ sortBy: "created_at", dir: "desc" }], paging: { per_page: MOST_IN_TREND, metadata: false }, output: ["created_at"], as: "run_rows" }),
    s.array.map({ source: ref("run_rows"), as: "runs_at", transform: ref("$this.created_at") }),
    // The pipeline's open deals with a close date, for someone who may open customers. Anyone else gets none, not a zero.
    s.set_var("deals", c.null()),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["role"], as: "viewer" }),
    s.conditional({ when: rbac.has(ref("viewer.role", { safe: true }), "crm.read"), then: [
      s.db.query({ table: pipeline_stage, where: cmp(col("kind"), "=", c.text("open")), output: ["id"], as: "open_stages" }),
      s.array.map({ source: ref("open_stages"), as: "open_ids", transform: ref("$this.id") }),
      s.db.query({ table: deal, where: [cmp(col("stage_id"), "in", ref("open_ids")), cmp(col("deleted_at"), "=", c.null()), cmp(col("close_on"), "!=", c.null())],
        sort: [{ sortBy: "close_on", dir: "asc" }], paging: { per_page: MOST_DEALS, metadata: false }, output: ["id", "value", "close_on"], as: "open_deals" }),
      s.update_var("deals", ref("open_deals")),
    ] }),
  ],
  response: {
    tasks: { open: ref("open_tasks"), late: ref("late_tasks"), items: ref("due_tasks") },
    agents: { active: ref("active_runs"), items: ref("runs") },
    started: { message: ref("said"), task: ref("tasks_made"), doc: ref("docs_made"), file: ref("files_made"), agent: ref("runs_asked"), people: ref("people") },
    spaces: withFilters(ref("reach.space_ids"), fl.count()),
    trends: { done_at: ref("done_at"), runs_at: ref("runs_at") },
    deals: ref("deals"),
  },
});

export const overviewFunctions = [readOverview];
