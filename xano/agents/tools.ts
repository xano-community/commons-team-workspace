// What an agent can do, for chat, tasks, docs, customers and files. Each tool is a thin memberTool over a function here, and each
// function calls the same action a person's route calls, with the agent as actor and `browser` false, so it meets the same rules and
// leaves the same trail. Inside a run the bounds are tighter: it reads only where it was asked, and speaks only in its own thread.
// A write guests would see asks first: the tool answers with the approval, and the same function runs once a person says yes.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { HUMAN_ROLES } from "../app.js";
import { approvals } from "../approvals.js";
import { TASK_PRIORITIES, TASK_STATUSES, task } from "../table/tasks/task.js";
import { agent_run } from "../table/agents/agent_run.js";
import { project } from "../table/tasks/project.js";
import { doc_suggestion } from "../table/docs/doc_suggestion.js";
import { docs } from "../docs.js";
import { accessRule, canReach, NOT_FOUND } from "../function/access/reach.js";
import { createLink } from "../function/links/links.js";
import { locate } from "../function/links/records.js";
import { postMessage, readHistory } from "../function/messaging/messages.js";
import { assignTask, createTask, readTask, reviseTask, setDue, setPriority, setStatus } from "../function/tasks/tasks.js";
import { createDoc } from "../function/docs/docs.js";
import { fileSuggestion } from "../function/docs/suggestions.js";
import { assignCompany, createCompany, updateCompany } from "../function/crm/companies.js";
import { contactRow, createContact, updateContact } from "../function/crm/contacts.js";
import { assignDeal, createDeal, setDealStage, updateDeal } from "../function/crm/deals.js";
import { addNote } from "../function/crm/notes.js";
import { readCompany, readDeal } from "../function/crm/reads.js";
import { readFile, storeFile } from "../function/files/files.js";
import { findRecords } from "../function/search/search.js";
import { company } from "../table/crm/company.js";
import { contact } from "../table/crm/contact.js";
import { deal } from "../table/crm/deal.js";
import { pipeline_stage } from "../table/crm/pipeline_stage.js";
import { user } from "../table/user.js";
import { connectionInbox } from "../function/inbox/read.js";
import { agentAsk, askFinish, askRoute, guestsRead } from "./ask.js";
import { memberTool } from "./member-tool.js";

const asAgent = { actor_id: inp("actor_id"), browser: c.bool(false) };
/** Who's calling, and what the write functions need to ask first. `approved_by` is set only when a person has said yes. */
const caller = { actor_id: input.int({ required: true }), run_id: input.int(), connection_id: input.int(), approved_by: input.int(), via: input.text() };
/** What a write answers: `approval` is empty when it went straight in, and otherwise says who it's waiting for. */
type Asked<T> = T & { approval: { approval_id: number; status: string; waiting_for: string; message: string } | null };
const NO_PLACE = { errorType: "badrequest", message: "Say which conversation this is about." } as const;

/** Binds `ask_first`: guests would see this, and nobody has said yes yet. */
const guestsWouldSee = (type: Value, id: Value) => statements(
  s.function.run({ fn: guestsRead, as: "guests", input: { type, id } }),
  s.set_var("ask_first", ref("guests")),
  s.conditional({ when: expr(inp("approved_by"), ">", c.int(0)), then: [s.update_var("ask_first", c.bool(false))] }),
);
/** Stops here with the approval, instead of doing the thing. `answer` is the function's normal answer, with `approval` filled in. */
const askInstead = (o: { action: string; title: string; preview: Value; type: Value; id: Value; payload: Value; answer: Record<string, Value> }) => s.conditional({ when: expr(ref("ask_first"), "=", c.bool(true)), then: [
  s.function.run({ fn: agentAsk, as: "asked", input: {
    actor_id: inp("actor_id"), connection_id: inp("connection_id"), run_id: inp("run_id"), action: c.text(o.action), title: c.text(o.title), preview: o.preview, record_type: o.type, record_id: o.id, payload: o.payload, via: inp("via"),
  } }),
  s.return(obj({ ...o.answer, approval: ref("asked") })),
] });
const MOST_TASKS_READ = 50;
const MOST_DOC_READ = 20_000;
const MOST_TIMELINE = 20;
/** What a run that filed changes but saw none go in may say, whatever the model wrote. */
const ONLY_SUGGESTED = "Suggested a change";

/**
 * Answers not found unless the actor reaches customers and, inside a run, whoever asked for it does too. A run in a DM stays in
 * that conversation, so it never gets here with an answer of yes.
 */
export const requireCustomers = defineFunction({
  name: "agents/require_customers",
  description: "Refuse an actor who can't open customers, or a run whose requester can't.",
  input: { actor_id: input.int({ required: true }), run_id: input.int() },
  stack: [
    s.function.run({ fn: accessRule, as: "actor_reaches", input: { ...asAgent, space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
    guard.require(expr(ref("actor_reaches"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
    s.conditional({ when: expr(inp("run_id"), ">", c.int(0)), then: [
      s.db.get({ table: agent_run, fieldValue: inp("run_id"), output: ["requested_by", "dm_id"], as: "bounds" }),
      guard.require(expr(ref("bounds.dm_id", { safe: true }), "=", c.int(0)), { errorType: "notfound", message: NOT_FOUND }),
      s.set_var("asker_id", ref("bounds.requested_by", { safe: true })),
      s.db.get({ table: user, fieldValue: ref("asker_id"), output: ["kind"], as: "asker" }),
      s.set_var("asker_kind", ref("asker.kind", { safe: true })),
      s.function.run({ fn: accessRule, as: "asker_reaches", input: { actor_id: ref("asker_id"), browser: c.expression('$var.asker_kind == "human"'), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
      guard.require(expr(ref("asker_reaches"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

/** Answers not found unless the actor reaches a record and, inside a run, it lives where the run started. */
export const requireInScope = defineFunction({
  name: "agents/require_in_scope",
  description: "Refuse a record the actor can't reach, or one outside the run it's in.",
  input: { actor_id: input.int({ required: true }), run_id: input.int(), type: input.text({ required: true }), id: input.int({ required: true }) },
  stack: [
    s.function.run({ fn: canReach, as: "reachable", input: { ...asAgent, type: inp("type"), id: inp("id") } }),
    guard.require(expr(ref("reachable"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
    s.conditional({ when: expr(inp("run_id"), ">", c.int(0)), then: [
      s.db.get({ table: agent_run, fieldValue: inp("run_id"), output: ["space_id", "dm_id"], as: "bounds" }),
      s.function.run({ fn: locate, as: "place", input: { type: inp("type"), id: inp("id") } }),
      s.conditional({
        when: expr(ref("place.crm"), "=", c.bool(true)),
        then: [s.function.run({ fn: requireCustomers, as: "customers", input: { actor_id: inp("actor_id"), run_id: inp("run_id") } })],
        else: [guard.require(and(expr(ref("place.space_id"), "=", ref("bounds.space_id", { safe: true })), expr(ref("place.dm_id"), "=", ref("bounds.dm_id", { safe: true }))), { errorType: "notfound", message: NOT_FOUND })],
      }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

export const reportProgress = defineFunction({
  name: "agents/report",
  description: "Say how the work is going. In a run it goes in the run's thread, `done` is the only way a run can finish, and `waiting` asks whoever requested it.",
  input: { ...caller, conversation_id: input.int(), note: input.text(), state: input.text() },
  stack: [
    s.set_var("note", inp("note")),
    s.set_var("place", inp("conversation_id")),
    s.conditional({ when: expr(inp("run_id"), ">", c.int(0)), then: [
      s.db.get({ table: agent_run, fieldValue: inp("run_id"), output: ["thread_id"], as: "bounds" }),
      s.update_var("place", ref("bounds.thread_id", { safe: true })),
      s.conditional({ when: expr(inp("state"), "=", c.text("done")), then: [
        s.db.query({ table: doc_suggestion, where: cmp(col("run_id"), "=", inp("run_id")), returnType: "count", as: "filed" }),
        s.db.query({ table: doc_suggestion, where: [cmp(col("run_id"), "=", inp("run_id")), cmp(col("status"), "=", c.text("applied"))], returnType: "count", as: "went_in" }),
        s.conditional({ when: and(expr(ref("filed"), ">", c.int(0)), expr(ref("went_in"), "=", c.int(0))), then: [s.update_var("note", c.text(ONLY_SUGGESTED))] }),
      ] }),
    ] }),
    guard.require(expr(ref("place"), ">", c.int(0)), NO_PLACE),
    // Guests see what the agent did once it's approved, and not its working out loud on the way there.
    s.function.run({ fn: guestsRead, as: "guests", input: { type: c.text("conversation"), id: ref("place") } }),
    s.security.create_uuid({ as: "note_key" }),
    s.function.run({ fn: postMessage, as: "posted", input: { ...asAgent, conversation_id: ref("place"), client_msg_id: ref("note_key"), body: ref("note"), run_id: inp("run_id"), run_note: c.bool(true), via: inp("via"), approved_by: c.int(0), held: ref("guests") } }),
    s.conditional({ when: expr(inp("run_id"), ">", c.int(0)), then: [
      s.db.get({ table: agent_run, fieldValue: inp("run_id"), as: "run" }),
      s.db.patch({ table: agent_run, fieldValue: inp("run_id"), data: obj({ last_note: ref("note") }) }),
      s.conditional({ when: expr(inp("state"), "=", c.text("done")), then: [s.db.patch({ table: agent_run, fieldValue: inp("run_id"), data: obj({ done_reported: c.bool(true) }) })] }),
      s.conditional({ when: expr(inp("state"), "=", c.text("waiting")), then: [s.db.patch({ table: agent_run, fieldValue: inp("run_id"), data: obj({ status: c.text("waiting"), waiting_on: ref("run.requested_by", { safe: true }), approval_id: c.int(0) }) })] }),
      s.function.run({ fn: "agents/changed", as: "run_told", input: { run_id: inp("run_id"), space_id: ref("run.space_id", { safe: true }), dm_id: ref("run.dm_id", { safe: true }), op: c.text("updated") } }),
    ] }),
  ],
  response: { state: inp("state") },
});

export const speak = defineFunction({
  name: "agents/post_message",
  description: "Post as the agent. Inside a run it goes to the run's own thread, and nowhere else. Where a guest can read, it asks first.",
  input: { ...caller, conversation_id: input.int(), body: input.text() },
  stack: [
    s.set_var("target", inp("conversation_id")),
    s.conditional({ when: expr(inp("run_id"), ">", c.int(0)), then: [
      s.db.get({ table: agent_run, fieldValue: inp("run_id"), output: ["thread_id"], as: "run" }),
      s.set_var("own_thread", ref("run.thread_id", { safe: true })),
      guard.require(expr(withFilters(c.array([0]), fl.array_push(ref("own_thread")), fl.in(inp("conversation_id"))), "=", c.bool(true)), { errorType: "accessdenied", message: "A run can post only in its own thread. To message someone else, use request_action with send_dm." }),
      s.update_var("target", ref("own_thread")),
    ] }),
    guard.require(expr(ref("target"), ">", c.int(0)), NO_PLACE),
    s.function.run({ fn: canReach, as: "reachable", input: { ...asAgent, type: c.text("conversation"), id: ref("target") } }),
    guard.require(expr(ref("reachable"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
    ...guestsWouldSee(c.text("conversation"), ref("target")),
    askInstead({ action: "send_external", title: "Post a message", preview: inp("body"), type: c.text("conversation"), id: ref("target"), payload: obj({ conversation_id: ref("target"), body: inp("body") }), answer: { message_id: c.int(0), conversation_id: ref("target") } }),
    s.security.create_uuid({ as: "post_key" }),
    s.function.run({ fn: postMessage, as: "posted", input: { ...asAgent, conversation_id: ref("target"), client_msg_id: ref("post_key"), body: inp("body"), run_id: inp("run_id"), run_note: c.bool(false), via: inp("via"), approved_by: inp("approved_by"), held: c.bool(false) } }),
  ],
  response: { message_id: ref("posted.message.id"), conversation_id: ref("target"), approval: c.null() },
  responseShape: {} as Asked<{ message_id: number; conversation_id: number }>,
});

/** Sends one change when the model made it. An empty field means leave it alone. */
const when = (field: string, then: Parameters<typeof s.conditional>[0]["then"]) => s.conditional({ when: expr(inp(field), "!=", c.text("")), then });

export const saveTask = defineFunction({
  name: "agents/save_task",
  description: "Add a task, or change one, as the agent. Inside a run it stays in the run's space.",
  input: {
    ...caller, id: input.int(), project_id: input.int(), title: input.text(), description: input.text(), status: input.text(), priority: input.text(), due_on: input.text(), assignee_id: input.int(),
  },
  stack: [
    s.set_var("task_id", inp("id")),
    // What guests would see it in: the task, or for a new one the project it goes into.
    s.set_var("home_type", c.text("project")),
    s.set_var("home_id", inp("project_id")),
    s.conditional({ when: expr(inp("id"), ">", c.int(0)), then: [s.update_var("home_type", c.text("task")), s.update_var("home_id", inp("id"))] }),
    guard.require(expr(ref("home_id"), ">", c.int(0)), { errorType: "badrequest", message: "Say which project the task belongs to." }),
    s.function.run({ fn: requireInScope, as: "in_scope", input: { actor_id: inp("actor_id"), run_id: inp("run_id"), type: ref("home_type"), id: ref("home_id") } }),
    ...guestsWouldSee(ref("home_type"), ref("home_id")),
    askInstead({ action: "save_task", title: "Save a task", preview: withFilters(inp("title"), fl.first_notempty(inp("description"))), type: ref("home_type"), id: ref("home_id"),
      payload: obj({ id: inp("id"), project_id: inp("project_id"), title: inp("title"), description: inp("description"), status: inp("status"), priority: inp("priority"), due_on: inp("due_on"), assignee_id: inp("assignee_id") }), answer: { task_id: inp("id") } }),
    s.conditional({
      when: expr(inp("id"), ">", c.int(0)),
      then: [
        s.conditional({ when: expr(withFilters(inp("title"), fl.concat(inp("description"))), "!=", c.text("")), then: [
          s.function.run({ fn: reviseTask, as: "revised", input: { ...asAgent, id: inp("id"), title: inp("title"), addition: inp("description") } }),
        ] }),
        when("status", [s.function.run({ fn: setStatus, as: "moved", input: { ...asAgent, id: inp("id"), status: inp("status") } })]),
        when("priority", [s.function.run({ fn: setPriority, as: "ranked", input: { ...asAgent, id: inp("id"), priority: inp("priority") } })]),
        when("due_on", [s.function.run({ fn: setDue, as: "dated", input: { ...asAgent, id: inp("id"), due_on: inp("due_on") } })]),
        s.conditional({ when: expr(inp("assignee_id"), ">", c.int(0)), then: [s.function.run({ fn: assignTask, as: "assigned", input: { ...asAgent, id: inp("id"), assignee_id: inp("assignee_id") } })] }),
      ],
      else: [
        s.security.create_uuid({ as: "task_key" }),
        s.set_var("status", withFilters(inp("status"), fl.first_notempty(c.text("todo")))),
        s.set_var("priority", withFilters(inp("priority"), fl.first_notempty(c.text("none")))),
        s.function.run({ fn: createTask, as: "made", input: {
          ...asAgent, project_id: inp("project_id"), client_id: ref("task_key"), title: inp("title"), description: inp("description"), status: ref("status"), priority: ref("priority"), due_on: inp("due_on"), assignee_id: inp("assignee_id"),
        } }),
        s.update_var("task_id", ref("made.id")),
      ],
    }),
  ],
  response: { task_id: ref("task_id"), approval: c.null() },
  responseShape: {} as Asked<{ task_id: number }>,
});

/** Marks the doc a run is on, so people with it open can see an agent is there. */
const onDoc = (run: Parameters<typeof expr>[0], doc: Parameters<typeof expr>[0]) => s.conditional({ when: expr(run, ">", c.int(0)), then: [
  s.db.patch({ table: agent_run, fieldValue: run, as: "marked", data: obj({ doc_id: doc }) }),
  s.function.run({ fn: "agents/changed", as: "run_told", input: { run_id: run, space_id: ref("marked.space_id"), dm_id: ref("marked.dm_id"), op: c.text("updated") } }),
] });

/**
 * An agent's one way into a doc's body. With an id it files a change, and what that came to is the function's to decide. With
 * none it starts a doc, which holds nobody's words yet, in the run's space or the one it names.
 */
export const saveDoc = defineFunction({
  name: "agents/save_doc",
  description: "Start a doc, or propose a change to one, as the agent.",
  input: { ...caller, id: input.int(), space_id: input.int(), title: input.text(), find: input.text(), text: input.text(), note: input.text() },
  stack: [
    s.set_var("doc_id", inp("id")),
    s.set_var("status", c.text("applied")),
    s.set_var("outcome", c.text("Created")),
    s.set_var("suggestion_id", c.int(0)),
    s.set_var("home", inp("space_id")),
    s.conditional({ when: expr(inp("run_id"), ">", c.int(0)), then: [
      s.db.get({ table: agent_run, fieldValue: inp("run_id"), output: ["space_id"], as: "bounds" }),
      s.update_var("home", ref("bounds.space_id", { safe: true })),
    ] }),
    s.set_var("place_type", c.text("space")),
    s.set_var("place_id", ref("home")),
    s.conditional({ when: expr(inp("id"), ">", c.int(0)), then: [s.update_var("place_type", c.text("doc")), s.update_var("place_id", inp("id"))] }),
    guard.require(expr(ref("place_id"), ">", c.int(0)), { errorType: "badrequest", message: "Say which space the doc belongs in." }),
    s.function.run({ fn: requireInScope, as: "in_scope", input: { actor_id: inp("actor_id"), run_id: inp("run_id"), type: ref("place_type"), id: ref("place_id") } }),
    ...guestsWouldSee(ref("place_type"), ref("place_id")),
    askInstead({ action: "save_doc", title: "Save a doc", preview: inp("text"), type: ref("place_type"), id: ref("place_id"),
      payload: obj({ id: inp("id"), space_id: ref("home"), title: inp("title"), find: inp("find"), text: inp("text"), note: inp("note") }), answer: { id: inp("id"), suggestion_id: c.int(0), status: c.text("waiting"), outcome: c.text("Waiting for approval") } }),
    s.conditional({
      when: expr(inp("id"), ">", c.int(0)),
      then: [
        onDoc(inp("run_id"), inp("id")),
        s.function.run({ fn: fileSuggestion, as: "filed", input: { actor_id: inp("actor_id"), run_id: inp("run_id"), id: inp("id"), find: inp("find"), text: inp("text"), note: inp("note") } }),
        s.update_var("status", ref("filed.status")),
        s.update_var("outcome", ref("filed.outcome")),
        s.update_var("suggestion_id", ref("filed.suggestion_id")),
      ],
      else: [
        guard.require(expr(withFilters(inp("title"), fl.trim()), "!=", c.text("")), { errorType: "badrequest", message: "Give the doc a title." }),
        s.function.run({ fn: docs.fns.fromText, as: "blocks", input: { text: inp("text") } }),
        s.function.run({ fn: createDoc, as: "made", input: { ...asAgent, space_id: ref("home"), title: inp("title"), body: ref("blocks") } }),
        s.update_var("doc_id", ref("made.id")),
        onDoc(inp("run_id"), ref("made.id")),
      ],
    }),
  ],
  response: { id: ref("doc_id"), suggestion_id: ref("suggestion_id"), status: ref("status"), outcome: ref("outcome"), approval: c.null() },
  responseShape: {} as Asked<{ id: number; suggestion_id: number; status: string; outcome: string }>,
});

export const readRecord = defineFunction({
  name: "agents/read_record",
  description: "Read a conversation, a task, a project, a doc or a customer the actor reaches.",
  input: { actor_id: input.int({ required: true }), run_id: input.int(), type: input.text({ required: true }), id: input.int({ required: true }) },
  stack: [
    s.function.run({ fn: requireInScope, as: "in_scope", input: { actor_id: inp("actor_id"), run_id: inp("run_id"), type: inp("type"), id: inp("id") } }),
    s.set_var("record", c.null()),
    s.switch({ on: inp("type"), cases: [
      { when: c.text("conversation"), break: true, body: [
        s.function.run({ fn: readHistory, as: "page", input: { ...asAgent, conversation_id: inp("id"), before_seq: c.int(0), after_seq: c.int(0), around_seq: c.int(0), after_version: c.int(0) } }),
        s.array.map({ source: ref("page.items"), as: "lines", transform: { from: ref("$this.author_name"), said: ref("$this.body") } }),
        s.update_var("record", ref("lines")),
      ] },
      { when: c.text("task"), break: true, body: [
        s.function.run({ fn: readTask, as: "page", input: { ...asAgent, id: inp("id") } }),
        s.update_var("record", withFilters(ref("page.task"), fl.set("space_name", ref("page.space_name")), fl.set("thread_id", ref("page.thread_id")))),
      ] },
      { when: c.text("doc"), break: true, body: [
        s.function.run({ fn: docs.fns.get, as: "current", input: { actor_id: inp("actor_id"), id: inp("id") } }),
        s.db.query({ table: doc_suggestion, where: [cmp(col("doc_id"), "=", inp("id")), cmp(col("agent_id"), "=", inp("actor_id"))], sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: 10, metadata: false }, output: ["id", "status", "find"], as: "mine" }),
        s.update_var("record", obj({ id: inp("id"), title: ref("current.doc.title"), text: withFilters(ref("current.doc.text"), fl.substr(c.int(0), c.int(MOST_DOC_READ))), your_suggestions: ref("mine") })),
      ] },
      { when: c.text("project"), break: true, body: [
        s.db.query({ table: task, where: [cmp(col("project_id"), "=", inp("id")), cmp(col("deleted_at"), "=", c.null())], sort: [{ sortBy: "rank", dir: "asc" }], paging: { per_page: MOST_TASKS_READ, metadata: false }, output: ["id", "title", "status", "priority", "due_on", "assignee_id"], as: "rows" }),
        s.update_var("record", ref("rows")),
      ] },
      { when: c.text("company"), break: true, body: [
        s.function.run({ fn: readCompany, as: "page", input: { ...asAgent, id: inp("id") } }),
        s.update_var("record", withFilters(ref("page.company"), fl.set("contacts", ref("page.contacts")), fl.set("deals", ref("page.deals")), fl.set("notes", ref("page.notes")))),
      ] },
      { when: c.text("deal"), break: true, body: [
        s.function.run({ fn: readDeal, as: "page", input: { ...asAgent, id: inp("id") } }),
        s.update_var("record", withFilters(ref("page.deal"), fl.set("notes", ref("page.notes")))),
      ] },
      { when: c.text("contact"), break: true, body: [contactRow(inp("id"), "row"), s.update_var("record", ref("row"))] },
      { when: c.text("file"), break: true, body: [
        s.function.run({ fn: readFile, as: "page", input: { ...asAgent, id: inp("id") } }),
        s.update_var("record", ref("page")),
      ] },
    ] }),
    s.function.run({ fn: "app/activity_page", as: "history", input: { ...asAgent, entity: inp("type"), entity_id: inp("id"), page: c.int(1), size: c.int(MOST_TIMELINE) } }),
    s.array.map({ source: ref("history.items"), as: "timeline", transform: { who: ref("$this.actor_name"), did: ref("$this.title"), approved_by: ref("$this.approved_by"), at: ref("$this.created_at") } }),
  ],
  response: { record: ref("record"), timeline: ref("timeline") },
});

/** A stage as a model names it, in any case. A name that isn't one says what is. */
const stageNamed = defineFunction({
  name: "agents/stage_named",
  description: "The stage with this name, or a refusal listing the stages.",
  input: { stage: input.text() },
  stack: [
    s.db.query({ table: pipeline_stage, sort: [{ sortBy: "rank", dir: "asc" }], output: ["id", "name"], as: "stages" }),
    s.set_var("wanted", withFilters(inp("stage"), fl.trim(), fl.lower())),
    s.array.find({ expr: ref("stages"), if: expr(withFilters(ref("$this.name"), fl.lower()), "=", ref("wanted")), as: "found" }),
    s.array.map({ source: ref("stages"), as: "names", transform: ref("$this.name") }),
    s.set_var("refusal", withFilters(c.text("No stage called "), fl.concat(inp("stage")), fl.concat(c.text(". The stages are ")), fl.concat(withFilters(ref("names"), fl.join(", "))), fl.concat(c.text(".")))),
    s.precondition({ expr: expr(ref("found"), "!=", c.null()), error_type: "badrequest", error: ref("refusal") }),
  ],
  response: ref("found.id", { safe: true }),
});

const anyOf = (fields: string[]) => withFilters(c.text(""), ...fields.map((f) => fl.concat(inp(f))));

/**
 * Adds or changes a customer, as whoever is acting. Each change goes through the same action a person's route calls, and an empty
 * field means leave it alone, so a model can't clear anything by leaving it out. Deleting asks first, through `request_action`.
 * `note` and a link ride along, so one call can move a deal and say why.
 */
export const saveCrmRecord = defineFunction({
  name: "agents/save_crm_record",
  description: "Add or change a company, a contact or a deal, with a note and a link if asked.",
  input: {
    ...caller, type: input.text({ required: true }), id: input.int(), company_id: input.int(), name: input.text(), domain: input.text(), industry: input.text(), about: input.text(),
    email: input.text(), phone: input.text(), job_title: input.text(), stage: input.text(), value: input.int(), close_on: input.text(), owner_id: input.int(), note: input.text(), link_type: input.text(), link_id: input.int(),
  },
  stack: [
    s.set_var("saved_id", inp("id")),
    s.conditional({
      when: expr(inp("id"), ">", c.int(0)),
      then: [s.function.run({ fn: requireInScope, as: "in_scope", input: { actor_id: inp("actor_id"), run_id: inp("run_id"), type: inp("type"), id: inp("id") } })],
      else: [s.function.run({ fn: requireCustomers, as: "in_scope", input: { actor_id: inp("actor_id"), run_id: inp("run_id") } })],
    }),
    // A customer has no guests, but a record it links to can.
    s.set_var("ask_first", c.bool(false)),
    s.conditional({ when: expr(inp("link_id"), ">", c.int(0)), then: [
      s.function.run({ fn: requireInScope, as: "link_in_scope", input: { actor_id: inp("actor_id"), run_id: inp("run_id"), type: inp("link_type"), id: inp("link_id") } }),
      ...guestsWouldSee(inp("link_type"), inp("link_id")),
    ] }),
    askInstead({ action: "save_crm_record", title: "Save and link a customer", preview: withFilters(inp("name"), fl.first_notempty(inp("note"))), type: inp("link_type"), id: inp("link_id"),
      payload: obj({ type: inp("type"), id: inp("id"), company_id: inp("company_id"), name: inp("name"), domain: inp("domain"), industry: inp("industry"), about: inp("about"), email: inp("email"), phone: inp("phone"), job_title: inp("job_title"),
        stage: inp("stage"), value: inp("value"), close_on: inp("close_on"), owner_id: inp("owner_id"), note: inp("note"), link_type: inp("link_type"), link_id: inp("link_id") }), answer: { id: inp("id") } }),
    s.switch({ on: inp("type"), cases: [
      { when: c.text("company"), break: true, body: [
        s.conditional({
          when: expr(inp("id"), ">", c.int(0)),
          then: [
            s.conditional({ when: expr(anyOf(["name", "domain", "industry", "about"]), "!=", c.text("")), then: [
              s.db.get({ table: company, fieldValue: inp("id"), as: "row" }),
              s.function.run({ fn: updateCompany, as: "changed_row", input: { ...asAgent, id: inp("id"), name: withFilters(inp("name"), fl.first_notempty(ref("row.name", { safe: true }))), domain: withFilters(inp("domain"), fl.first_notempty(ref("row.domain", { safe: true }))),
                industry: withFilters(inp("industry"), fl.first_notempty(ref("row.industry", { safe: true }))), about: withFilters(inp("about"), fl.first_notempty(ref("row.about", { safe: true }))) } }),
            ] }),
            s.conditional({ when: expr(inp("owner_id"), ">", c.int(0)), then: [s.function.run({ fn: assignCompany, as: "owned", input: { ...asAgent, id: inp("id"), owner_id: inp("owner_id") } })] }),
          ],
          else: [
            s.security.create_uuid({ as: "company_key" }),
            s.function.run({ fn: createCompany, as: "made", input: { ...asAgent, client_id: ref("company_key"), name: inp("name"), domain: inp("domain"), industry: inp("industry"), about: inp("about"), owner_id: inp("owner_id") } }),
            s.update_var("saved_id", ref("made.id")),
          ],
        }),
      ] },
      { when: c.text("contact"), break: true, body: [
        s.conditional({
          when: expr(inp("id"), ">", c.int(0)),
          then: [
            s.db.get({ table: contact, fieldValue: inp("id"), as: "row" }),
            s.function.run({ fn: updateContact, as: "changed_row", input: { ...asAgent, id: inp("id"), name: withFilters(inp("name"), fl.first_notempty(ref("row.name", { safe: true }))), email: withFilters(inp("email"), fl.first_notempty(ref("row.email", { safe: true }))),
              phone: withFilters(inp("phone"), fl.first_notempty(ref("row.phone", { safe: true }))), job_title: withFilters(inp("job_title"), fl.first_notempty(ref("row.job_title", { safe: true }))) } }),
          ],
          else: [
            guard.require(expr(inp("company_id"), ">", c.int(0)), { errorType: "badrequest", message: "Say which company the contact is at." }),
            s.security.create_uuid({ as: "contact_key" }),
            s.function.run({ fn: createContact, as: "made", input: { ...asAgent, client_id: ref("contact_key"), company_id: inp("company_id"), name: inp("name"), email: inp("email"), phone: inp("phone"), job_title: inp("job_title") } }),
            s.update_var("saved_id", ref("made.id")),
          ],
        }),
      ] },
      { when: c.text("deal"), break: true, body: [
        s.set_var("stage_id", c.int(0)),
        s.conditional({ when: expr(inp("stage"), "!=", c.text("")), then: [
          s.function.run({ fn: stageNamed, as: "stage_found", input: { stage: inp("stage") } }),
          s.update_var("stage_id", ref("stage_found")),
        ] }),
        s.conditional({
          when: expr(inp("id"), ">", c.int(0)),
          then: [
            s.conditional({ when: expr(withFilters(inp("name"), fl.concat(inp("close_on")), fl.concat(inp("value"))), "!=", c.text("0")), then: [
              s.db.get({ table: deal, fieldValue: inp("id"), as: "row" }),
              s.function.run({ fn: updateDeal, as: "changed_row", input: { ...asAgent, id: inp("id"), title: withFilters(inp("name"), fl.first_notempty(ref("row.title", { safe: true }))), value: withFilters(inp("value"), fl.first_notempty(ref("row.value", { safe: true }))),
                close_on: withFilters(inp("close_on"), fl.first_notempty(ref("row.close_on", { safe: true }))), contact_id: ref("row.contact_id", { safe: true }) } }),
            ] }),
            s.conditional({ when: expr(ref("stage_id"), ">", c.int(0)), then: [s.function.run({ fn: setDealStage, as: "staged", input: { ...asAgent, id: inp("id"), stage_id: ref("stage_id") } })] }),
            s.conditional({ when: expr(inp("owner_id"), ">", c.int(0)), then: [s.function.run({ fn: assignDeal, as: "owned", input: { ...asAgent, id: inp("id"), owner_id: inp("owner_id") } })] }),
          ],
          else: [
            guard.require(expr(inp("company_id"), ">", c.int(0)), { errorType: "badrequest", message: "Say which company the deal is with." }),
            s.conditional({ when: expr(ref("stage_id"), "=", c.int(0)), then: [
              s.db.query({ table: pipeline_stage, where: cmp(col("kind"), "=", c.text("open")), sort: [{ sortBy: "rank", dir: "asc" }], paging: { per_page: 1, metadata: false }, output: ["id"], as: "first_stage" }),
              s.update_var("stage_id", withFilters(ref("first_stage"), fl.first(), fl.get("id", 0))),
            ] }),
            s.security.create_uuid({ as: "deal_key" }),
            s.function.run({ fn: createDeal, as: "made", input: { ...asAgent, client_id: ref("deal_key"), company_id: inp("company_id"), stage_id: ref("stage_id"), title: inp("name"), value: inp("value"), close_on: inp("close_on"), owner_id: inp("owner_id"), contact_id: c.int(0) } }),
            s.update_var("saved_id", ref("made.id")),
          ],
        }),
      ] },
    ] }),
    s.conditional({ when: expr(inp("note"), "!=", c.text("")), then: [
      s.security.create_uuid({ as: "note_key" }),
      s.function.run({ fn: addNote, as: "noted", input: { ...asAgent, client_id: ref("note_key"), record_type: inp("type"), record_id: ref("saved_id"), body: inp("note") } }),
    ] }),
    s.conditional({ when: expr(inp("link_id"), ">", c.int(0)), then: [
      s.function.run({ fn: createLink, as: "link", input: { ...asAgent, from_type: inp("link_type"), from_id: inp("link_id"), to_type: inp("type"), to_id: ref("saved_id") } }),
    ] }),
  ],
  response: { id: ref("saved_id"), approval: c.null() },
  responseShape: {} as Asked<{ id: number }>,
});

const MOST_FILE_TEXT = 200_000;
const FILE_PREVIEW = 600;

/**
 * Saves what an agent wrote as a file. It goes through the door a person's upload does, so it meets the same limits and shows who
 * made it. Inside a run it lands where the run is. Outside one it needs a place to go, and an agent can't reach past that.
 */
export const saveFile = defineFunction({
  name: "agents/save_file",
  description: "Save text as a file in a run's place or a named space, and attach it to a record if asked.",
  input: { ...caller, name: input.text(), content: input.text(), space_id: input.int(), link_type: input.text(), link_id: input.int() },
  stack: [
    guard.require(expr(withFilters(inp("name"), fl.trim()), "!=", c.text("")), { errorType: "badrequest", message: "Give the file a name, with its extension." }),
    guard.require(expr(withFilters(inp("content"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "This file has nothing in it." }),
    guard.require(expr(withFilters(inp("content"), fl.strlen()), "<=", c.int(MOST_FILE_TEXT)), { errorType: "badrequest", message: `Keep a file under ${MOST_FILE_TEXT.toLocaleString("en")} characters.` }),
    s.set_var("place_type", c.text("space")),
    s.set_var("place_id", inp("space_id")),
    s.conditional({ when: expr(inp("run_id"), ">", c.int(0)), then: [
      s.db.get({ table: agent_run, fieldValue: inp("run_id"), output: ["thread_id"], as: "run" }),
      s.update_var("place_type", c.text("conversation")),
      s.update_var("place_id", ref("run.thread_id", { safe: true })),
    ] }),
    guard.require(expr(ref("place_id"), ">", c.int(0)), { errorType: "badrequest", message: "Say which space the file belongs in." }),
    s.conditional({ when: expr(inp("link_id"), ">", c.int(0)), then: [s.function.run({ fn: requireInScope, as: "link_in_scope", input: { actor_id: inp("actor_id"), run_id: inp("run_id"), type: inp("link_type"), id: inp("link_id") } })] }),
    s.function.run({ fn: requireInScope, as: "place_in_scope", input: { actor_id: inp("actor_id"), run_id: inp("run_id"), type: ref("place_type"), id: ref("place_id") } }),
    ...guestsWouldSee(ref("place_type"), ref("place_id")),
    s.conditional({ when: expr(inp("link_id"), ">", c.int(0)), then: [
      s.function.run({ fn: guestsRead, as: "link_guests", input: { type: inp("link_type"), id: inp("link_id") } }),
      s.conditional({ when: expr(ref("link_guests"), "=", c.bool(true)), then: [s.update_var("ask_first", c.bool(true))] }),
      s.conditional({ when: expr(inp("approved_by"), ">", c.int(0)), then: [s.update_var("ask_first", c.bool(false))] }),
    ] }),
    askInstead({ action: "save_file", title: "Add a file", preview: withFilters(inp("content"), fl.substr(c.int(0), c.int(FILE_PREVIEW))), type: ref("place_type"), id: ref("place_id"),
      payload: obj({ name: inp("name"), content: inp("content"), space_id: inp("space_id"), link_type: inp("link_type"), link_id: inp("link_id") }), answer: { id: c.int(0), name: inp("name") } }),
    s.storage.create_file_resource({ as: "written", filename: inp("name"), filedata: inp("content") }),
    s.security.create_uuid({ as: "file_key" }),
    s.function.run({ fn: storeFile, as: "stored", input: { ...asAgent, file: ref("written"), client_id: ref("file_key"), place_type: ref("place_type"), place_id: ref("place_id"), run_id: inp("run_id") } }),
    s.precondition({ expr: expr(ref("stored.ok"), "=", c.bool(true)), error_type: "badrequest", error: ref("stored.message") }),
    s.conditional({ when: expr(inp("link_id"), ">", c.int(0)), then: [
      s.function.run({ fn: createLink, as: "link", input: { ...asAgent, from_type: c.text("file"), from_id: ref("stored.file.id"), to_type: inp("link_type"), to_id: inp("link_id") } }),
    ] }),
  ],
  response: { id: ref("stored.file.id"), name: ref("stored.file.name"), approval: c.null() },
  responseShape: {} as Asked<{ id: number; name: string }>,
});

/** Every action `request_action` can ask for, in a model's words. Guest-visible writes ask by themselves, from their own tools. */
const REQUESTS = ["delete_record", "bulk_change", "export_crm", "grant_space_access", "change_role", "send_dm"] as const;
const DELETABLE = ["task", "doc", "file", "company", "contact", "deal"];
const MOST_BULK = 200;
const BULK_FROM = 20;

/** The plan for one request: checks it, and says what it's about. Nothing is written here, so a refusal leaves nothing behind. */
export const planRequest = defineFunction({
  name: "agents/plan_request",
  description: "Check what an agent is asking for, and work out its title, record and payload.",
  input: {
    actor_id: input.int({ required: true }), run_id: input.int(), action: input.text({ required: true }), type: input.text(), id: input.int(), ids: input.json(), status: input.text(), priority: input.text(), assignee_id: input.int(),
    space_id: input.int(), member_id: input.int(), role: input.text(), reason: input.text(), body: input.text(),
  },
  stack: [
    s.set_var("title", c.text("")),
    s.set_var("preview", inp("reason")),
    s.set_var("record_type", c.text("")),
    s.set_var("record_id", c.int(0)),
    s.set_var("payload", c.obj({})),
    guard.require(expr(withFilters(inp("reason"), fl.trim()), "!=", c.text("")), { errorType: "badrequest", message: "Say why, in a line a person can read." }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["kind"], as: "asker" }),
    s.switch({ on: inp("action"), cases: [
      { when: c.text("delete_record"), break: true, body: [
        guard.require(expr(withFilters(c.array(DELETABLE), fl.in(inp("type"))), "=", c.bool(true)), { errorType: "badrequest", message: "Name a task, doc, file, company, contact or deal to delete." }),
        s.function.run({ fn: requireInScope, as: "in_scope", input: { actor_id: inp("actor_id"), run_id: inp("run_id"), type: inp("type"), id: inp("id") } }),
        s.update_var("title", withFilters(c.text("Delete this "), fl.concat(inp("type")))),
        s.update_var("record_type", inp("type")),
        s.update_var("record_id", inp("id")),
      ] },
      { when: c.text("bulk_change"), break: true, body: [
        s.set_var("how_many", withFilters(inp("ids"), fl.first_notnull(c.array([])), fl.count())),
        guard.require(expr(ref("how_many"), ">", c.int(BULK_FROM)), { errorType: "badrequest", message: `Up to ${BULK_FROM} tasks needs no approval: change them with save_task.` }),
        guard.require(expr(ref("how_many"), "<=", c.int(MOST_BULK)), { errorType: "badrequest", message: `Ask for at most ${MOST_BULK} tasks at a time.` }),
        guard.require(expr(withFilters(inp("status"), fl.concat(inp("priority")), fl.concat(inp("assignee_id"))), "!=", c.text("0")), { errorType: "badrequest", message: "Say what to change: status, priority or assignee_id." }),
        s.set_var("one_home", c.int(0)),
        s.foreach({ list: inp("ids"), as: "task_id", body: [
          s.function.run({ fn: requireInScope, as: "in_scope", input: { actor_id: inp("actor_id"), run_id: inp("run_id"), type: c.text("task"), id: ref("task_id") } }),
          s.function.run({ fn: locate, as: "home", input: { type: c.text("task"), id: ref("task_id") } }),
          s.conditional({ when: expr(ref("one_home"), "=", c.int(0)), then: [s.update_var("one_home", ref("home.space_id"))] }),
          guard.require(expr(ref("home.space_id"), "=", ref("one_home")), { errorType: "badrequest", message: "Ask for one space at a time, so the right person decides." }),
        ] }),
        s.update_var("title", withFilters(c.text("Change "), fl.concat(ref("how_many")), fl.concat(c.text(" tasks")))),
        s.update_var("record_type", c.text("space")),
        s.update_var("record_id", ref("one_home")),
        s.update_var("payload", obj({ ids: inp("ids"), status: inp("status"), priority: inp("priority"), assignee_id: inp("assignee_id") })),
      ] },
      { when: c.text("export_crm"), break: true, body: [
        s.function.run({ fn: requireCustomers, as: "customers", input: { actor_id: inp("actor_id"), run_id: inp("run_id") } }),
        guard.require(expr(inp("space_id"), ">", c.int(0)), { errorType: "badrequest", message: "Say which space the export goes in." }),
        s.function.run({ fn: requireInScope, as: "in_scope", input: { actor_id: inp("actor_id"), run_id: inp("run_id"), type: c.text("space"), id: inp("space_id") } }),
        s.function.run({ fn: guestsRead, as: "guests", input: { type: c.text("space"), id: inp("space_id") } }),
        guard.require(expr(ref("guests"), "=", c.bool(false)), { errorType: "badrequest", message: "Guests can read that space. Choose one only the team can read." }),
        s.update_var("title", c.text("Export every company and contact to a file")),
        s.update_var("payload", obj({ space_id: inp("space_id") })),
      ] },
      { when: c.text("grant_space_access"), break: true, body: [
        guard.require(expr(ref("asker.kind", { safe: true }), "=", c.text("agent")), { errorType: "badrequest", message: "Join a space in the app." }),
        s.function.run({ fn: locate, as: "wanted", input: { type: c.text("space"), id: inp("space_id") } }),
        guard.require(expr(ref("wanted.found"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
        s.update_var("title", c.text("Join a space")),
        s.update_var("payload", obj({ space_id: inp("space_id") })),
      ] },
      { when: c.text("change_role"), break: true, body: [
        guard.require(expr(withFilters(c.array([...HUMAN_ROLES]), fl.in(inp("role"))), "=", c.bool(true)), { errorType: "badrequest", message: `Choose a role: ${HUMAN_ROLES.join(", ")}.` }),
        s.db.get({ table: user, fieldValue: inp("member_id"), output: ["id", "name", "kind", "role", "status"], as: "target" }),
        guard.found("target", { errorType: "notfound", message: NOT_FOUND }),
        guard.require(and(expr(ref("target.kind"), "=", c.text("human")), expr(ref("target.status"), "=", c.text("active"))), { errorType: "notfound", message: NOT_FOUND }),
        guard.require(expr(ref("target.role"), "!=", inp("role")), { errorType: "badrequest", message: "They already have that role." }),
        s.update_var("title", withFilters(c.text("Make "), fl.concat(ref("target.name")), fl.concat(c.text(" ")), fl.concat(inp("role")))),
        s.update_var("payload", obj({ id: inp("member_id"), role: inp("role") })),
      ] },
      // A run may speak only where it started. A message anywhere else is a person's call, and it's filed under the run's own
      // conversation, because that's what prompted it, and only someone who reads that can judge it.
      { when: c.text("send_dm"), break: true, body: [
        guard.require(expr(ref("asker.kind", { safe: true }), "=", c.text("agent")), { errorType: "badrequest", message: "Message people in the app." }),
        guard.require(expr(withFilters(inp("body"), fl.trim()), "!=", c.text("")), { errorType: "badrequest", message: "Write the message in body." }),
        s.db.get({ table: user, fieldValue: inp("member_id"), output: ["id", "name", "status"], as: "target" }),
        guard.found("target", { errorType: "notfound", message: NOT_FOUND }),
        guard.require(and(expr(ref("target.status"), "=", c.text("active")), expr(ref("target.id"), "!=", inp("actor_id"))), { errorType: "notfound", message: NOT_FOUND }),
        s.conditional({ when: expr(inp("run_id"), ">", c.int(0)), then: [
          s.db.get({ table: agent_run, fieldValue: inp("run_id"), output: ["thread_id"], as: "bounds" }),
          s.update_var("record_type", c.text("conversation")),
          s.update_var("record_id", ref("bounds.thread_id", { safe: true })),
        ] }),
        s.update_var("title", withFilters(c.text("Message "), fl.concat(ref("target.name")))),
        s.update_var("preview", inp("body")),
        s.update_var("payload", obj({ member_id: inp("member_id"), body: inp("body") })),
      ] },
    ] }),
    guard.require(expr(ref("title"), "!=", c.text("")), { errorType: "badrequest", message: `Ask for one of: ${REQUESTS.join(", ")}.` }),
  ],
  response: { title: ref("title"), preview: ref("preview"), record_type: ref("record_type"), record_id: ref("record_id"), payload: ref("payload") },
});

const inRun = { actor_id: ref("conn.user_id"), run_id: ref("member.run_id"), connection_id: ref("conn.id"), approved_by: c.int(0), via: ref("member.via") };
/** What a write answers when it asked first instead. Empty when it went straight in. */
const askedAnswer = (fn: string) => ({ approval: ref(`${fn}.approval`) });

export const reportProgressTool = memberTool({
  name: "report_progress", title: "Report progress", access: "write",
  description: "Say how the work is going, in one short line people will read. In a hosted run: use state working as you go, state done once, when the work is finished, and state waiting to ask whoever requested this a question. Outside a run, name the conversation_id it's about and use state working or done. Guests don't see these notes.",
  input: { note: input.text({ required: true }), state: input.enum(["working", "waiting", "done"], { required: true }), conversation_id: input.int() },
  logDetail: inp("state"),
  stack: [s.function.run({ fn: reportProgress, as: "reported", input: { ...inRun, conversation_id: inp("conversation_id"), note: inp("note"), state: inp("state") } })],
  response: { state: ref("reported.state") },
});

export const postMessageTool = memberTool({
  name: "post_message", title: "Post a message", access: "write",
  description: "Say something to people. In a run it goes in the run's own thread, so leave conversation_id out. Name someone as <@id>. Where a guest can read, it waits for a person to approve it: the answer's approval says so, and it hasn't been posted until then.",
  input: { body: input.text({ required: true }), conversation_id: input.int() },
  stack: [s.function.run({ fn: speak, as: "said", input: { ...inRun, conversation_id: inp("conversation_id"), body: inp("body") } })],
  response: { message_id: ref("said.message_id"), conversation_id: ref("said.conversation_id"), ...askedAnswer("said") },
});

export const saveTaskTool = memberTool({
  name: "save_task", title: "Save a task", access: "write",
  description: "Add a task with project_id and title, or change one with id and only the fields to change. On an existing task, description adds to what's there and never replaces it. Dates are YYYY-MM-DD. assignee_id is a person's id. Where a guest can see it, it waits for a person to approve it: the answer's approval says so.",
  input: {
    id: input.int(), project_id: input.int(), title: input.text(), description: input.text(), status: input.enum(TASK_STATUSES), priority: input.enum(TASK_PRIORITIES), due_on: input.text(), assignee_id: input.int(),
  },
  stack: [s.function.run({ fn: saveTask, as: "saved", input: {
    ...inRun, id: inp("id"), project_id: inp("project_id"), title: inp("title"), description: inp("description"), status: inp("status"), priority: inp("priority"), due_on: inp("due_on"), assignee_id: inp("assignee_id"),
  } })],
  response: { task_id: ref("saved.task_id"), ...askedAnswer("saved") },
});

export const readRecordTool = memberTool({
  name: "read_record", title: "Read a record", access: "read",
  description: "Read a conversation's latest messages, one task, the tasks in a project, a doc's text and what became of your suggestions on it, a company, contact or deal with its notes, or a file's details, with what's happened to it lately.",
  input: { type: input.enum(["conversation", "task", "project", "doc", "company", "contact", "deal", "file"], { required: true }), id: input.int({ required: true }) },
  stack: [s.function.run({ fn: readRecord, as: "found", input: { actor_id: ref("conn.user_id"), run_id: ref("member.run_id"), type: inp("type"), id: inp("id") } })],
  response: { record: ref("found.record"), timeline: ref("found.timeline") },
});

export const saveDocTool = memberTool({
  name: "save_doc", title: "Save a doc", access: "write",
  description: "Propose a change to a doc, or start one. With id and find, swap those exact words, quoted from one line, for text. With id and no find, add text to the end, one line per paragraph, # for headings. With no id, start a doc from title and text, in space_id. Say why in note. A person's work comes first: the answer's outcome says what happened, so report that and nothing stronger. Suggested a change means it hasn't gone in. Where a guest can read, it waits for a person to approve it.",
  input: { id: input.int(), space_id: input.int(), title: input.text(), find: input.text(), text: input.text({ required: true }), note: input.text() },
  logDetail: inp("note"),
  stack: [s.function.run({ fn: saveDoc, as: "saved", input: { ...inRun, id: inp("id"), space_id: inp("space_id"), title: inp("title"), find: inp("find"), text: inp("text"), note: inp("note") } })],
  response: { id: ref("saved.id"), status: ref("saved.status"), outcome: ref("saved.outcome"), ...askedAnswer("saved") },
});

export const saveCrmRecordTool = memberTool({
  name: "save_crm_record", title: "Save a customer record", access: "write",
  description: "Add or change a company, a contact or a deal. Leave id out to add one, and fill in only the fields to change: an empty field stays as it is. name is the company's or contact's name, or the deal's title. A new deal or contact needs company_id. stage is a stage's name. value is whole currency units. close_on is YYYY-MM-DD. note adds a note to the record, so say why you changed it there. link_type and link_id link a task, doc or conversation to the record. To delete, use request_action.",
  input: {
    type: input.enum(["company", "contact", "deal"], { required: true }), id: input.int(), company_id: input.int(), name: input.text(), domain: input.text(), industry: input.text(), about: input.text(), email: input.text(), phone: input.text(), job_title: input.text(),
    stage: input.text(), value: input.int(), close_on: input.text(), owner_id: input.int(), note: input.text(), link_type: input.enum(["task", "doc", "conversation"]), link_id: input.int(),
  },
  logDetail: inp("type"),
  stack: [s.function.run({ fn: saveCrmRecord, as: "saved", input: {
    ...inRun, type: inp("type"), id: inp("id"), company_id: inp("company_id"), name: inp("name"), domain: inp("domain"), industry: inp("industry"), about: inp("about"), email: inp("email"), phone: inp("phone"), job_title: inp("job_title"),
    stage: inp("stage"), value: inp("value"), close_on: inp("close_on"), owner_id: inp("owner_id"), note: inp("note"), link_type: inp("link_type"), link_id: inp("link_id"),
  } })],
  response: { id: ref("saved.id"), ...askedAnswer("saved") },
});

export const saveFileTool = memberTool({
  name: "save_file", title: "Save a file", access: "write",
  description: "Save text you wrote as a file people can open and download, such as a report, a list or a CSV. name needs its extension: .txt, .md or .csv read in the app. In a run it lands where the run is, so leave space_id out. link_type and link_id attach it to a task, doc, company, contact or deal. To point at it in a message, write <#file:id>. Where a guest can see it, it waits for a person to approve it.",
  input: { name: input.text({ required: true }), content: input.text({ required: true }), space_id: input.int(), link_type: input.enum(["task", "doc", "company", "contact", "deal"]), link_id: input.int() },
  logDetail: inp("name"),
  stack: [s.function.run({ fn: saveFile, as: "saved", input: { ...inRun, name: inp("name"), content: inp("content"), space_id: inp("space_id"), link_type: inp("link_type"), link_id: inp("link_id") } })],
  response: { id: ref("saved.id"), name: ref("saved.name"), ...askedAnswer("saved") },
});

export const searchTool = memberTool({
  name: "search", title: "Search", access: "read",
  description: "Find records by the words in them, across chat, tasks, docs, customers and files, and read the ones that matter with read_record. Answers only what you may open, and in a run only what's where the run started.",
  input: { q: input.text({ required: true }) },
  stack: [s.function.run({ fn: findRecords, as: "found", input: { actor_id: ref("conn.user_id"), browser: c.bool(false), run_id: ref("member.run_id"), q: inp("q") } })],
  response: { results: ref("found.items"), total: ref("found.total") },
});

export const myInboxTool = memberTool({
  name: "my_inbox", title: "My inbox", access: "read",
  description: "What's waiting for you, oldest first: mentions, assignments, replies and decisions on what you asked for. Start here. Pass the answer's next_after as after to see only what's new, and read a record with read_record.",
  input: { after: input.int() },
  stack: [s.function.run({ fn: connectionInbox, as: "inbox", input: { actor_id: ref("conn.user_id"), run_id: ref("member.run_id"), after: inp("after") } })],
  response: { items: ref("inbox.items"), records: ref("inbox.records"), next_after: ref("inbox.next_after") },
});

export const requestActionTool = memberTool({
  name: "request_action", title: "Ask a person first", access: "write", asksApproval: true,
  description: `Ask a person to approve something you can't do alone. It is NOT done until they approve it, and you'll find the decision in my_inbox, or with check_approval. Always give reason, in a line a person can read. delete_record: type and id. bulk_change: ids (more than ${BULK_FROM} tasks in one space) with status, priority or assignee_id. export_crm: space_id for the file, in a space guests can't read. grant_space_access: space_id. change_role: member_id and role. send_dm: member_id and body, to message someone outside this thread.`,
  input: {
    action: input.enum(REQUESTS, { required: true }), reason: input.text({ required: true }), type: input.enum(["task", "doc", "file", "company", "contact", "deal"]), id: input.int(), ids: input.list(input.int()),
    status: input.enum(TASK_STATUSES), priority: input.enum(TASK_PRIORITIES), assignee_id: input.int(), space_id: input.int(), member_id: input.int(), role: input.enum(HUMAN_ROLES), body: input.text(),
  },
  logDetail: inp("action"),
  stack: [
    s.function.run({ fn: planRequest, as: "plan", input: {
      actor_id: ref("conn.user_id"), run_id: ref("member.run_id"), action: inp("action"), type: inp("type"), id: inp("id"), ids: inp("ids"), status: inp("status"), priority: inp("priority"), assignee_id: inp("assignee_id"),
      space_id: inp("space_id"), member_id: inp("member_id"), role: inp("role"), reason: inp("reason"), body: inp("body"),
    } }),
    s.function.run({ fn: askRoute, as: "route", input: {
      actor_id: ref("conn.user_id"), connection_id: ref("conn.id"), run_id: ref("member.run_id"), action: inp("action"), record_type: ref("plan.record_type"), record_id: ref("plan.record_id"), payload: ref("plan.payload"), via: ref("member.via"),
    } }),
    s.function.run({ fn: approvals.requestApproval, as: "row", input: {
      user_id: ref("route.user_id"), source: c.text("mcp"), agent_label: ref("route.label"), connection_id: ref("conn.id"), action: inp("action"), title: ref("plan.title"), preview: ref("plan.preview"), link: ref("route.link"), payload: ref("route.payload"),
    } }),
    s.function.run({ fn: askFinish, as: "asked", input: { approval_id: ref("row.approval_id"), run_id: ref("member.run_id"), user_id: ref("route.user_id"), admin_route: ref("route.admin_route") } }),
  ],
  response: { approval_id: ref("asked.approval_id"), status: ref("asked.status"), waiting_for: ref("asked.waiting_for"), message: ref("asked.message") },
});

export const hostedTools = [myInboxTool, searchTool, readRecordTool, postMessageTool, saveTaskTool, saveDocTool, saveCrmRecordTool, saveFileTool, reportProgressTool, requestActionTool];
export const toolFunctions = [requireCustomers, requireInScope, reportProgress, speak, saveTask, readRecord, saveDoc, stageNamed, saveCrmRecord, saveFile, planRequest];
