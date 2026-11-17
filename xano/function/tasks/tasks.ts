// Tasks and projects. One function per write, each taking `actor_id` and `browser`, so a person's route and an agent's tool
// run the same rules and leave the same trail. Each answers not found before it answers no, and returns the task as a list
// shows it, so a screen can take the answer as it is.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, task as scheduledTask, withFilters, type Value } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { notification } from "../../base/tables.js";
import { user } from "../../table/user.js";
import { space } from "../../table/spaces/space.js";
import { space_member } from "../../table/spaces/space_member.js";
import { conversation } from "../../table/messaging/conversation.js";
import { message } from "../../table/messaging/message.js";
import { project } from "../../table/tasks/project.js";
import { task, TASK_PRIORITIES, TASK_STATUSES } from "../../table/tasks/task.js";
import { task_view } from "../../table/tasks/task_view.js";
import { accessRule, canCreate, NOT_FOUND, reachOf, requireReach } from "../access/reach.js";
import { closeItems, deliver, deliverAsk } from "../inbox/deliver.js";
import { recordChange } from "../links/changes.js";
import { addBodyLinks, forgetRecord, reconcileLinks } from "../links/links.js";
import { readTokens } from "../messaging/messages.js";

const who = { actor_id: input.int({ required: true }), browser: input.bool() };
const me = { actor: inp("actor_id"), browser: inp("browser") };
const ARCHIVED = "This space is archived.";
const GUESTS = "Guests can't add or change tasks in this space.";
/** Whole numbers are all a rank has, so new places start this far apart: twenty moves into one gap before a renumber. */
const STEP = 1_048_576;
const LONGEST_TITLE = 200;
const LONGEST_BODY = 20_000;
const OPEN = ["backlog", "todo", "in_progress", "in_review"];
const FINISHED = ["done", "cancelled"];
const A_COLUMN = 100;
const MOST_IN_A_COLUMN = 500;
const MOST_VIEWS = 30;
const SEARCH_RESULTS = 10;
const PURGE_AFTER = "-30 days";

const taskLink = (id: Value) => withFilters(c.text("/tasks/"), fl.concat(id));
const notDeleted = () => cmp(col("deleted_at"), "=", c.null());
const withNames = {
  bind: [
    { table: user, as: "assignee", join: "left" as const, where: expr(col("assignee_id"), "=", col("assignee.id")) },
    { table: project, as: "home_project", join: "left" as const, where: expr(col("project_id"), "=", col("home_project.id")) },
  ],
  eval: [{ name: "assignee.name", as: "assignee_name" }, { name: "assignee.kind", as: "assignee_kind" }, { name: "home_project.name", as: "project_name" }],
};
/** The task as every screen reads it, with who's on it and where it lives. */
const rowOf = (id: Value, as: string) => s.db.query({ table: task, where: cmp(col("id"), "=", id), returnType: "single", ...withNames, as });

const titleRules = statements(
  guard.require(expr(withFilters(inp("title"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Give the task a title." }),
  guard.require(expr(withFilters(inp("title"), fl.strlen()), "<=", c.int(LONGEST_TITLE)), { errorType: "badrequest", message: `Keep the title under ${LONGEST_TITLE} characters.` }),
  guard.require(expr(withFilters(inp("description"), fl.strlen()), "<=", c.int(LONGEST_BODY)), { errorType: "badrequest", message: `Keep the description under ${LONGEST_BODY.toLocaleString("en")} characters.` }),
);
const nameRules = statements(
  guard.require(expr(withFilters(inp("name"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Name the project." }),
  guard.require(expr(withFilters(inp("name"), fl.strlen()), "<=", c.int(60)), { errorType: "badrequest", message: "Keep the name under 60 characters." }),
);

/** Refuses a space that takes no writes, or a guest it doesn't let in. Binds `home`. */
const requireOpenSpace = (id: Value) => statements(
  s.db.get({ table: space, fieldValue: id, output: ["archived_at"], as: "home" }),
  guard.found("home", { errorType: "notfound", message: NOT_FOUND }),
  guard.require(expr(ref("home.archived_at"), "=", c.null()), { errorType: "badrequest", message: ARCHIVED }),
  s.function.run({ fn: canCreate, as: "creates", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: id } }),
  guard.require(expr(ref("creates"), "=", c.bool(true)), { errorType: "accessdenied", message: GUESTS }),
);

/** Binds `row`, a task the actor reaches. Anything else is not found. */
const reachableTask = statements(
  s.db.get({ table: task, fieldValue: inp("id"), as: "row" }),
  guard.found("row", { errorType: "notfound", message: NOT_FOUND }),
  ...requireReach({ ...me, type: "task", id: inp("id") }),
);
/** Binds `row`, a task the actor may change. */
const editableTask = statements(
  ...reachableTask,
  guard.require(expr(ref("row.deleted_at"), "=", c.null()), { errorType: "badrequest", message: "This task was deleted." }),
  ...requireOpenSpace(ref("row.space_id")),
);

/** A day as it would be stored, or nothing. A date column turns a bad day into a different good one, so it's read back here. */
export const cleanDue = defineFunction({
  name: "tasks/clean_due",
  description: "A due date as YYYY-MM-DD, or null for none. Refuses a day that doesn't exist.",
  input: { due_on: input.text() },
  stack: [
    s.set_var("day", c.null()),
    s.conditional({ when: expr(inp("due_on"), "!=", c.text("")), then: [
      s.set_var("shaped", withFilters(c.regex(/^\d{4}-\d{2}-\d{2}$/), fl.regex_test(inp("due_on")))),
      guard.require(expr(ref("shaped"), "=", c.bool(true)), { errorType: "badrequest", message: "Choose a real date." }),
      s.set_var("read_back", withFilters(inp("due_on"), fl.to_epochms("UTC"), fl.epochms_date("Y-m-d", "UTC"))),
      guard.require(expr(ref("read_back"), "=", inp("due_on")), { errorType: "badrequest", message: "Choose a real date." }),
      s.update_var("day", inp("due_on")),
    ] }),
  ],
  response: ref("day"),
});

/** Refuses someone who couldn't open the task. A person or an agent, on the same rule. */
const requireAssignable = (person: Value, spaceId: Value) => s.conditional({ when: expr(person, ">", c.int(0)), then: [
  s.db.get({ table: user, fieldValue: person, output: ["kind"], as: "candidate" }),
  s.set_var("candidate_kind", ref("candidate.kind", { safe: true })),
  s.function.run({ fn: accessRule, as: "candidate_reaches", input: { actor_id: person, browser: c.expression('$var.candidate_kind == "human"'), space_id: spaceId, dm_id: c.int(0), crm_record: c.bool(false) } }),
  guard.require(expr(ref("candidate_reaches"), "=", c.bool(true)), { errorType: "badrequest", message: "Add them to this space first." }),
] });

/** The top of a column. New work and work moved in from a menu land here, where someone will see it. */
const topRank = defineFunction({
  name: "tasks/top_rank",
  description: "A rank above everything in a column.",
  input: { status: input.text({ required: true }) },
  stack: [
    s.set_var("rank", c.int(0)),
    s.db.query({ table: task, where: [cmp(col("status"), "=", inp("status")), notDeleted()], sort: [{ sortBy: "rank", dir: "asc" }], paging: { per_page: 1, metadata: false }, output: ["rank"], as: "edge" }),
    s.conditional({ when: expr(withFilters(ref("edge"), fl.count()), ">", c.int(0)), then: [s.update_var("rank", withFilters(ref("edge"), fl.first(), fl.get("rank"), fl.sub(c.int(STEP))))] }),
  ],
  response: ref("rank"),
});

/** Spreads a column back out, keeping its order. It runs when two neighbours have no whole number left between them. */
const renumber = defineFunction({
  name: "tasks/renumber",
  description: "Give every task in a column a fresh rank, in the same order.",
  input: { status: input.text({ required: true }) },
  stack: [
    s.db.query({ table: task, where: [cmp(col("status"), "=", inp("status")), notDeleted()], sort: [{ sortBy: "rank", dir: "asc" }, { sortBy: "id", dir: "asc" }], output: ["id"], as: "column" }),
    s.set_var("next_rank", c.int(0)),
    s.set_var("spread", c.array([])),
    s.foreach({ list: ref("column"), as: "item", body: [
      s.update_var("next_rank", withFilters(ref("next_rank"), fl.add(c.int(STEP)))),
      s.update_var("spread", withFilters(ref("spread"), fl.array_push(obj({ id: ref("item.id"), rank: ref("next_rank") })))),
    ] }),
    s.db.bulk.patch({ table: task, items: ref("spread"), as: "spread_out" }),
  ],
  response: { ok: c.bool(true) },
});

/**
 * Where a task goes in a column: just above `before_id`, or last with none. A move names only the task under it, so it
 * lands right in any filtered view. A neighbour that left the column since the screen drew falls to the end, and never fails.
 */
const placeIn = defineFunction({
  name: "tasks/place",
  description: "The rank that puts a task above another in a column, or at its end.",
  input: { id: input.int({ required: true }), status: input.text({ required: true }), before_id: input.int() },
  stack: [
    s.set_var("place", c.int(0)),
    s.set_var("placed", c.bool(false)),
    s.conditional({ when: and(expr(inp("before_id"), ">", c.int(0)), expr(inp("before_id"), "!=", inp("id"))), then: [
      s.db.get({ table: task, fieldValue: inp("before_id"), output: ["status", "rank", "deleted_at"], as: "under" }),
      s.conditional({ when: and(expr(ref("under"), "!=", c.null()), expr(ref("under.status", { safe: true }), "=", inp("status")), expr(ref("under.deleted_at", { safe: true }), "=", c.null())), then: [
        s.set_var("under_rank", ref("under.rank", { safe: true })),
        ...findAbove(),
        s.conditional({ when: expr(ref("squeezed"), "=", c.bool(true)), then: [
          s.function.run({ fn: renumber, as: "renumbered", input: { status: inp("status") } }),
          s.db.get({ table: task, fieldValue: inp("before_id"), output: ["rank"], as: "renumbered_under" }),
          s.update_var("under_rank", ref("renumbered_under.rank", { safe: true })),
          ...findAbove(),
        ] }),
        s.update_var("place", ref("gap_rank")),
        s.update_var("placed", c.bool(true)),
      ] }),
    ] }),
    s.conditional({ when: expr(ref("placed"), "=", c.bool(false)), then: [
      s.db.query({ table: task, where: [cmp(col("status"), "=", inp("status")), notDeleted(), cmp(col("id"), "!=", inp("id"))], sort: [{ sortBy: "rank", dir: "desc" }], paging: { per_page: 1, metadata: false }, output: ["rank"], as: "edge" }),
      s.conditional({ when: expr(withFilters(ref("edge"), fl.count()), ">", c.int(0)), then: [s.update_var("place", withFilters(ref("edge"), fl.first(), fl.get("rank"), fl.add(c.int(STEP))))] }),
    ] }),
  ],
  response: ref("place"),
});

/** Binds `gap_rank`, and `squeezed` when there's no room above `under_rank`, or another task shares its rank. */
function findAbove() {
  return statements(
    s.db.query({ table: task, where: [cmp(col("status"), "=", inp("status")), notDeleted(), cmp(col("id"), "!=", inp("id")), expr(col("rank"), "<", ref("under_rank"))], sort: [{ sortBy: "rank", dir: "desc" }], paging: { per_page: 1, metadata: false }, output: ["rank"], as: "above" }),
    s.db.query({ table: task, where: [cmp(col("status"), "=", inp("status")), notDeleted(), cmp(col("id"), "!=", inp("id")), cmp(col("id"), "!=", inp("before_id")), cmp(col("rank"), "=", ref("under_rank"))], returnType: "count", as: "sharing" }),
    s.set_var("gap_rank", withFilters(ref("under_rank"), fl.sub(c.int(STEP)))),
    s.set_var("squeezed", c.expression("$var.sharing > 0")),
    s.conditional({ when: expr(withFilters(ref("above"), fl.count()), ">", c.int(0)), then: [
      s.set_var("above_rank", withFilters(ref("above"), fl.first(), fl.get("rank"))),
      s.update_var("gap_rank", c.expression("$var.above_rank + (($var.under_rank - $var.above_rank) / 2|floor)")),
      s.conditional({ when: expr(withFilters(ref("under_rank"), fl.sub(ref("above_rank"))), "<", c.int(2)), then: [s.update_var("squeezed", c.bool(true))] }),
    ] }),
  );
}

/** Tells someone a task is theirs. `deliver` skips the person who did it, and anyone who can't reach it. */
const tellAssigned = (person: Value, id: Value, spaceId: Value) => s.conditional({ when: expr(person, ">", c.int(0)), then: [
  s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["name"], as: "assigner" }),
  s.function.run({ fn: deliverAsk, as: "told_assignee", input: {
    user_id: person, kind: c.text("assigned"), title: withFilters(ref("assigner.name", { safe: true }), fl.concat(c.text(" assigned you a task"))), body: c.text(""), link: taskLink(id), actor_id: inp("actor_id"),
    space_id: spaceId, dm_id: c.int(0), entity: c.text("task"), entity_id: id, group_key: c.text(""), seq: c.int(0),
  } }),
] });

/** Puts mentions new to this body in those people's inboxes, and links what it names. It takes nothing away. */
const tellAdded = defineFunction({
  name: "tasks/tell_added",
  description: "Tell whoever a task's description newly names, and link what it names.",
  input: { ...who, id: input.int({ required: true }), space_id: input.int({ required: true }), before: input.text(), after: input.text() },
  stack: [
    s.function.run({ fn: readTokens, as: "named_before", input: { body: inp("before") } }),
    s.function.run({ fn: readTokens, as: "named", input: { body: inp("after") } }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["name"], as: "writer" }),
    s.foreach({ list: withFilters(ref("named.people"), fl.array_diff(ref("named_before.people"))), as: "person_id", body: [
      s.function.run({ fn: deliverAsk, as: "told_person", input: {
        user_id: ref("person_id"), kind: c.text("mention"), title: withFilters(ref("writer.name", { safe: true }), fl.concat(c.text(" mentioned you"))), body: c.text(""), link: taskLink(inp("id")), actor_id: inp("actor_id"),
        space_id: inp("space_id"), dm_id: c.int(0), entity: c.text("task"), entity_id: inp("id"), group_key: c.text(""), seq: c.int(0),
      } }),
    ] }),
    s.function.run({ fn: addBodyLinks, as: "linked", input: { actor_id: inp("actor_id"), browser: inp("browser"), from_type: c.text("task"), from_id: inp("id"), targets: ref("named.records") } }),
  ],
  response: { ok: c.bool(true) },
});

/** Everything `tellAdded` does, then withdraws the mentions taken out and lines the links up with the new body. */
const tellMentions = defineFunction({
  name: "tasks/tell_mentions",
  description: "Bring a task's inbox items and links in line with what its description names.",
  input: { ...who, id: input.int({ required: true }), space_id: input.int({ required: true }), before: input.text(), after: input.text() },
  stack: [
    s.function.run({ fn: tellAdded, as: "added", input: { actor_id: inp("actor_id"), browser: inp("browser"), id: inp("id"), space_id: inp("space_id"), before: inp("before"), after: inp("after") } }),
    s.function.run({ fn: readTokens, as: "named_before", input: { body: inp("before") } }),
    s.function.run({ fn: readTokens, as: "named", input: { body: inp("after") } }),
    s.foreach({ list: withFilters(ref("named_before.people"), fl.array_diff(ref("named.people"))), as: "person_id", body: [
      s.function.run({ fn: closeItems, as: "withdrawn", input: { entity: c.text("task"), entity_id: inp("id"), kind: c.text("mention"), user_id: ref("person_id"), seq: c.int(0) } }),
    ] }),
    s.function.run({ fn: reconcileLinks, as: "linked", input: { actor_id: inp("actor_id"), browser: inp("browser"), from_type: c.text("task"), from_id: inp("id"), targets: ref("named.records") } }),
  ],
  response: { ok: c.bool(true) },
});

/** The row and all it sets off, in one call, so a lost race on the unique key leaves nothing half done. Answers its id. */
const insertTask = defineFunction({
  name: "tasks/insert",
  description: "Write a new task, and tell whoever it concerns.",
  input: {
    ...who, project_id: input.int({ required: true }), space_id: input.int({ required: true }), key: input.text({ required: true }), title: input.text(), description: input.text(),
    status: input.text({ required: true }), priority: input.text({ required: true }), due_on: input.text({ nullable: true }), assignee_id: input.int(),
  },
  stack: [
    s.function.run({ fn: topRank, as: "rank", input: { status: inp("status") } }),
    s.set_var("finished_at", c.null()),
    s.conditional({ when: expr(withFilters(c.array(FINISHED), fl.in(inp("status"))), "=", c.bool(true)), then: [s.update_var("finished_at", c.now())] }),
    s.db.add({ table: task, as: "made", row: {
      project_id: inp("project_id"), space_id: inp("space_id"), title: inp("title"), description: inp("description"), status: inp("status"), priority: inp("priority"), due_on: inp("due_on"),
      assignee_id: inp("assignee_id"), left_by: c.int(0), created_by: inp("actor_id"), rank: ref("rank"), client_id: inp("key"), is_demo: c.bool(false), completed_at: ref("finished_at"),
    } }),
    changed({ entity: "task", id: ref("made.id"), op: "created", verb: "created", actor: inp("actor_id"), space: inp("space_id"), link: taskLink(ref("made.id")), title: "created a task" }),
    tellAssigned(inp("assignee_id"), ref("made.id"), inp("space_id")),
    s.function.run({ fn: tellAdded, as: "told", input: { actor_id: inp("actor_id"), browser: inp("browser"), id: ref("made.id"), space_id: inp("space_id"), before: c.text(""), after: inp("description") } }),
  ],
  response: ref("made.id"),
});

export const createTask = defineFunction({
  name: "tasks/create",
  description: "Add a task to a project. A repeat of client_id answers the task it made, and does nothing else.",
  input: {
    ...who, project_id: input.int({ required: true }), client_id: input.text({ required: true }), title: input.text(), description: input.text(),
    status: input.enum(TASK_STATUSES, { required: true }), priority: input.enum(TASK_PRIORITIES, { required: true }), due_on: input.text(), assignee_id: input.int(),
  },
  stack: [
    ...requireReach({ ...me, type: "project", id: inp("project_id") }),
    s.db.get({ table: project, fieldValue: inp("project_id"), output: ["space_id", "archived_at"], as: "parent" }),
    guard.found("parent", { errorType: "notfound", message: NOT_FOUND }),
    ...requireOpenSpace(ref("parent.space_id")),
    guard.require(expr(ref("parent.archived_at"), "=", c.null()), { errorType: "badrequest", message: "This project is archived." }),
    ...titleRules,
    guard.require(and(expr(withFilters(inp("client_id"), fl.strlen()), ">=", c.int(1)), expr(withFilters(inp("client_id"), fl.strlen()), "<=", c.int(64))), { errorType: "badrequest", message: "This task has no usable id." }),
    s.function.run({ fn: cleanDue, as: "due", input: { due_on: inp("due_on") } }),
    requireAssignable(inp("assignee_id"), ref("parent.space_id")),
    // The id is the sender's own, so one person's can't answer with another's task.
    s.set_var("key", withFilters(inp("actor_id"), fl.to_text(), fl.concat(c.text(":")), fl.concat(inp("client_id")))),
    s.db.query({ table: task, where: cmp(col("client_id"), "=", ref("key")), output: ["id"], returnType: "single", as: "made_before" }),
    s.set_var("made_id", ref("made_before.id", { safe: true })),
    s.conditional({ when: expr(ref("made_before"), "=", c.null()), then: [
      // Two copies of one create at once: the unique key lets one through, and the other answers its row.
      s.try_catch({
        try: [
          s.function.run({ fn: insertTask, as: "inserted", input: {
            actor_id: inp("actor_id"), browser: inp("browser"), project_id: inp("project_id"), space_id: ref("parent.space_id"), key: ref("key"), title: inp("title"), description: inp("description"),
            status: inp("status"), priority: inp("priority"), due_on: ref("due"), assignee_id: inp("assignee_id"),
          } }),
          s.update_var("made_id", ref("inserted")),
        ],
        catch: [],
      }),
    ] }),
    s.conditional({ when: expr(ref("made_id"), "=", c.null()), then: [
      s.db.query({ table: task, where: cmp(col("client_id"), "=", ref("key")), output: ["id"], returnType: "single", as: "won" }),
      s.update_var("made_id", ref("won.id", { safe: true })),
    ] }),
    rowOf(ref("made_id"), "answer"),
  ],
  response: ref("answer"),
});

export const updateTask = defineFunction({
  name: "tasks/update",
  description: "Change a task's title and description. Mentions added reach their people, and mentions taken out are withdrawn.",
  input: { ...who, id: input.int({ required: true }), title: input.text(), description: input.text() },
  stack: [
    ...editableTask,
    ...titleRules,
    s.db.patch({ table: task, fieldValue: inp("id"), data: obj({ title: inp("title"), description: inp("description") }) }),
    changed({ entity: "task", id: inp("id"), op: "updated", actor: inp("actor_id"), space: ref("row.space_id") }),
    s.conditional({ when: expr(ref("row.description"), "!=", inp("description")), then: [
      s.function.run({ fn: tellMentions, as: "told", input: { actor_id: inp("actor_id"), browser: inp("browser"), id: inp("id"), space_id: ref("row.space_id"), before: ref("row.description"), after: inp("description") } }),
    ] }),
    rowOf(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

/**
 * An agent's change to a task: a new title, and words added under the description. What a person wrote stays theirs, so nothing
 * here can take text, a mention or a link away.
 */
export const reviseTask = defineFunction({
  name: "tasks/revise",
  description: "Change a task's title, or add to its description.",
  input: { ...who, id: input.int({ required: true }), title: input.text(), addition: input.text() },
  stack: [
    ...editableTask,
    s.set_var("title", withFilters(inp("title"), fl.first_notempty(ref("row.title")))),
    s.set_var("description", ref("row.description")),
    s.conditional({ when: expr(inp("addition"), "!=", c.text("")), then: [
      s.conditional({
        when: expr(ref("description"), "=", c.text("")),
        then: [s.update_var("description", inp("addition"))],
        else: [s.update_var("description", withFilters(ref("description"), fl.concat(c.text("\n\n")), fl.concat(inp("addition"))))],
      }),
    ] }),
    guard.require(expr(withFilters(ref("title"), fl.strlen()), "<=", c.int(LONGEST_TITLE)), { errorType: "badrequest", message: `Keep the title under ${LONGEST_TITLE} characters.` }),
    guard.require(expr(withFilters(ref("description"), fl.strlen()), "<=", c.int(LONGEST_BODY)), { errorType: "badrequest", message: `Keep the description under ${LONGEST_BODY.toLocaleString("en")} characters.` }),
    s.db.patch({ table: task, fieldValue: inp("id"), data: obj({ title: ref("title"), description: ref("description") }) }),
    changed({ entity: "task", id: inp("id"), op: "updated", actor: inp("actor_id"), space: ref("row.space_id") }),
    s.function.run({ fn: tellAdded, as: "told", input: { actor_id: inp("actor_id"), browser: inp("browser"), id: inp("id"), space_id: ref("row.space_id"), before: ref("row.description"), after: ref("description") } }),
    rowOf(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

/** Moves a task to a place, stamps a finish, and takes it out of its person's inbox when the work is over. */
const applyPlace = defineFunction({
  name: "tasks/apply_place",
  description: "Write a task's status and rank, with everything a finish means.",
  input: { actor_id: input.int({ required: true }), id: input.int({ required: true }), status: input.text({ required: true }), rank: input.int(), op: input.text({ required: true }) },
  stack: [
    s.db.get({ table: task, fieldValue: inp("id"), output: ["status", "space_id", "completed_at"], as: "was" }),
    s.set_var("finishing", withFilters(c.array(FINISHED), fl.in(inp("status")))),
    s.set_var("was_finished", withFilters(c.array(FINISHED), fl.in(ref("was.status", { safe: true })))),
    s.set_var("completed_at", ref("was.completed_at", { safe: true })),
    s.conditional({ when: expr(ref("finishing"), "=", c.bool(false)), then: [s.update_var("completed_at", c.null())] }),
    s.conditional({ when: and(expr(ref("finishing"), "=", c.bool(true)), expr(ref("was_finished"), "=", c.bool(false))), then: [s.update_var("completed_at", c.now())] }),
    s.db.patch({ table: task, fieldValue: inp("id"), data: obj({ status: inp("status"), rank: inp("rank"), completed_at: ref("completed_at") }) }),
    s.conditional({
      when: and(expr(ref("finishing"), "=", c.bool(true)), expr(ref("was_finished"), "=", c.bool(false))),
      then: [
        s.function.run({ fn: closeItems, as: "closed", input: { entity: c.text("task"), entity_id: inp("id"), kind: c.text("assigned"), user_id: c.int(0), seq: c.int(0) } }),
        changed({ entity: "task", id: inp("id"), op: "moved", verb: "finished", actor: inp("actor_id"), space: ref("was.space_id", { safe: true }), link: taskLink(inp("id")), title: "finished a task" }),
      ],
      else: [changed({ entity: "task", id: inp("id"), op: "moved", actor: inp("actor_id"), space: ref("was.space_id", { safe: true }) })],
    }),
  ],
  response: { ok: c.bool(true) },
});

export const setStatus = defineFunction({
  name: "tasks/set_status",
  description: "Change a task's status. It lands at the top of its new column.",
  input: { ...who, id: input.int({ required: true }), status: input.enum(TASK_STATUSES, { required: true }) },
  stack: [
    ...editableTask,
    s.conditional({ when: expr(ref("row.status"), "!=", inp("status")), then: [
      s.function.run({ fn: topRank, as: "rank", input: { status: inp("status") } }),
      s.function.run({ fn: applyPlace, as: "placed", input: { actor_id: inp("actor_id"), id: inp("id"), status: inp("status"), rank: ref("rank"), op: c.text("moved") } }),
    ] }),
    rowOf(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const moveTask = defineFunction({
  name: "tasks/move",
  description: "Put a task in a column, just above another task, or at the end with none. The order is shared with everyone.",
  input: { ...who, id: input.int({ required: true }), status: input.enum(TASK_STATUSES, { required: true }), before_id: input.int() },
  stack: [
    ...editableTask,
    s.function.run({ fn: placeIn, as: "rank", input: { id: inp("id"), status: inp("status"), before_id: inp("before_id") } }),
    s.function.run({ fn: applyPlace, as: "placed", input: { actor_id: inp("actor_id"), id: inp("id"), status: inp("status"), rank: ref("rank"), op: c.text("moved") } }),
    rowOf(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const setPriority = defineFunction({
  name: "tasks/set_priority",
  description: "Change a task's priority.",
  input: { ...who, id: input.int({ required: true }), priority: input.enum(TASK_PRIORITIES, { required: true }) },
  stack: [
    ...editableTask,
    s.db.patch({ table: task, fieldValue: inp("id"), data: obj({ priority: inp("priority") }) }),
    changed({ entity: "task", id: inp("id"), op: "updated", actor: inp("actor_id"), space: ref("row.space_id") }),
    rowOf(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const setDue = defineFunction({
  name: "tasks/set_due",
  description: "Change a task's due date, or clear it with an empty one.",
  input: { ...who, id: input.int({ required: true }), due_on: input.text() },
  stack: [
    ...editableTask,
    s.function.run({ fn: cleanDue, as: "due", input: { due_on: inp("due_on") } }),
    s.db.patch({ table: task, fieldValue: inp("id"), data: obj({ due_on: ref("due") }) }),
    changed({ entity: "task", id: inp("id"), op: "updated", actor: inp("actor_id"), space: ref("row.space_id") }),
    rowOf(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const assignTask = defineFunction({
  name: "tasks/assign",
  description: "Put a person or an agent on a task, or nobody with 0. They must be able to reach it, and whoever had it stops being told.",
  input: { ...who, id: input.int({ required: true }), assignee_id: input.int() },
  stack: [
    ...editableTask,
    s.conditional({ when: expr(ref("row.assignee_id"), "!=", inp("assignee_id")), then: [
      requireAssignable(inp("assignee_id"), ref("row.space_id")),
      s.db.patch({ table: task, fieldValue: inp("id"), data: obj({ assignee_id: inp("assignee_id"), left_by: c.int(0) }) }),
      s.conditional({ when: expr(ref("row.assignee_id"), ">", c.int(0)), then: [
        s.function.run({ fn: closeItems, as: "closed", input: { entity: c.text("task"), entity_id: inp("id"), kind: c.text("assigned"), user_id: ref("row.assignee_id"), seq: c.int(0) } }),
      ] }),
      s.conditional({ when: expr(withFilters(c.array(FINISHED), fl.in(ref("row.status"))), "=", c.bool(false)), then: [tellAssigned(inp("assignee_id"), inp("id"), ref("row.space_id"))] }),
      s.conditional({
        when: expr(inp("assignee_id"), ">", c.int(0)),
        then: [changed({ entity: "task", id: inp("id"), op: "updated", verb: "assigned", actor: inp("actor_id"), space: ref("row.space_id"), link: taskLink(inp("id")), title: "assigned a task" })],
        else: [changed({ entity: "task", id: inp("id"), op: "updated", actor: inp("actor_id"), space: ref("row.space_id") })],
      }),
    ] }),
    rowOf(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const deleteTask = defineFunction({
  name: "tasks/delete",
  description: "Put a task in the trash. It reads Deleted, its links stay, and it can be restored for 30 days.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...reachableTask,
    ...requireOpenSpace(ref("row.space_id")),
    // A second press, or a retry, finds it gone and answers the same row.
    s.conditional({ when: expr(ref("row.deleted_at"), "=", c.null()), then: [
      s.db.patch({ table: task, fieldValue: inp("id"), data: obj({ deleted_at: c.now() }) }),
      s.function.run({ fn: closeItems, as: "closed_assigned", input: { entity: c.text("task"), entity_id: inp("id"), kind: c.text("assigned"), user_id: c.int(0), seq: c.int(0) } }),
      s.function.run({ fn: closeItems, as: "closed_mentions", input: { entity: c.text("task"), entity_id: inp("id"), kind: c.text("mention"), user_id: c.int(0), seq: c.int(0) } }),
      changed({ entity: "task", id: inp("id"), op: "deleted", verb: "deleted", actor: inp("actor_id"), space: ref("row.space_id"), link: taskLink(inp("id")), title: "deleted a task" }),
    ] }),
    rowOf(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const restoreTask = defineFunction({
  name: "tasks/restore",
  description: "Bring a task back from the trash, to the top of its column.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...reachableTask,
    ...requireOpenSpace(ref("row.space_id")),
    s.conditional({ when: expr(ref("row.deleted_at"), "!=", c.null()), then: [
      s.function.run({ fn: topRank, as: "rank", input: { status: ref("row.status") } }),
      s.db.patch({ table: task, fieldValue: inp("id"), data: obj({ deleted_at: c.null(), rank: ref("rank") }) }),
      changed({ entity: "task", id: inp("id"), op: "created", verb: "restored", actor: inp("actor_id"), space: ref("row.space_id"), link: taskLink(inp("id")), title: "restored a task" }),
    ] }),
    rowOf(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const createProject = defineFunction({
  name: "tasks/create_project",
  description: "Add a project to a space.",
  input: { ...who, space_id: input.int({ required: true }), name: input.text() },
  stack: [
    ...requireReach({ ...me, type: "space", id: inp("space_id") }),
    ...requireOpenSpace(inp("space_id")),
    ...nameRules,
    s.db.add({ table: project, as: "made", row: { space_id: inp("space_id"), name: inp("name"), created_by: inp("actor_id"), is_demo: c.bool(false) } }),
    changed({ entity: "project", id: ref("made.id"), op: "created", verb: "created", actor: inp("actor_id"), space: inp("space_id"), link: withFilters(c.text("/tasks?project="), fl.concat(ref("made.id"))), title: "created a project" }),
  ],
  response: ref("made"),
});

export const updateProject = defineFunction({
  name: "tasks/update_project",
  description: "Rename a project, or archive it. Its tasks stay, and leave the default views.",
  input: { ...who, id: input.int({ required: true }), name: input.text(), archived: input.bool() },
  stack: [
    ...requireReach({ ...me, type: "project", id: inp("id") }),
    s.db.get({ table: project, fieldValue: inp("id"), as: "before" }),
    guard.found("before", { errorType: "notfound", message: NOT_FOUND }),
    ...requireOpenSpace(ref("before.space_id")),
    ...nameRules,
    s.set_var("archived_at", ref("before.archived_at")),
    s.conditional({
      when: expr(inp("archived"), "=", c.bool(true)),
      then: [s.conditional({ when: expr(ref("archived_at"), "=", c.null()), then: [s.update_var("archived_at", c.now())] })],
      else: [s.update_var("archived_at", c.null())],
    }),
    s.db.patch({ table: project, fieldValue: inp("id"), data: obj({ name: inp("name"), archived_at: ref("archived_at") }), as: "saved" }),
    changed({ entity: "project", id: inp("id"), op: "updated", actor: inp("actor_id"), space: ref("before.space_id") }),
    // A list shows the project's name beside each task.
    changed({ entity: "task", id: c.int(0), op: "updated", actor: inp("actor_id"), space: ref("before.space_id") }),
  ],
  response: ref("saved"),
});

/** Only this person's other tabs care, so a saved filter's change goes on their own channel. */
const tellTabs = (id: Value, op: string) => s.function.run({ fn: recordChange, as: "told_tabs", input: {
  channel: withFilters(c.text("users/"), fl.concat(inp("actor_id"))), entity: c.text("task_view"), id, op: c.text(op), actor_id: inp("actor_id"), message: c.text(""), kind: c.text(""), link: c.text(""), at: c.int(0),
} });

export const saveView = defineFunction({
  name: "tasks/save_view",
  description: "Save a person's filters under a name. Saving a name again replaces what it holds.",
  input: { actor_id: input.int({ required: true }), name: input.text(), query: input.json() },
  stack: [
    guard.require(expr(withFilters(inp("name"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Name this filter." }),
    guard.require(expr(withFilters(inp("name"), fl.strlen()), "<=", c.int(40)), { errorType: "badrequest", message: "Keep the name under 40 characters." }),
    s.db.query({ table: task_view, where: [cmp(col("user_id"), "=", inp("actor_id")), cmp(col("name"), "=", inp("name"))], returnType: "single", as: "same_name" }),
    s.conditional({
      when: expr(ref("same_name"), "=", c.null()),
      then: [
        s.db.query({ table: task_view, where: cmp(col("user_id"), "=", inp("actor_id")), returnType: "count", as: "saved_views" }),
        guard.require(expr(ref("saved_views"), "<", c.int(MOST_VIEWS)), { errorType: "badrequest", message: `Keep ${MOST_VIEWS} saved filters at most. Delete one first.` }),
        s.db.add({ table: task_view, as: "made", row: { user_id: inp("actor_id"), name: inp("name"), query: inp("query") } }),
        s.set_var("view", ref("made")),
      ],
      else: [
        s.set_var("same_id", ref("same_name.id", { safe: true })),
        s.db.patch({ table: task_view, fieldValue: ref("same_id"), data: obj({ query: inp("query") }), as: "replaced" }),
        s.set_var("view", ref("replaced")),
      ],
    }),
    tellTabs(ref("view.id"), "updated"),
  ],
  response: ref("view"),
});

export const deleteView = defineFunction({
  name: "tasks/delete_view",
  description: "Delete one of a person's saved filters.",
  input: { actor_id: input.int({ required: true }), id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: task_view, fieldValue: inp("id"), output: ["user_id"], as: "view" }),
    guard.found("view", { errorType: "notfound", message: NOT_FOUND }),
    guard.require(expr(ref("view.user_id"), "=", inp("actor_id")), { errorType: "notfound", message: NOT_FOUND }),
    s.db.del({ table: task_view, fieldValue: inp("id") }),
    tellTabs(inp("id"), "deleted"),
  ],
  response: { removed: c.bool(true) },
});

/**
 * Someone left a space: nobody is left holding its tasks in their name. Each shows who left until someone takes it on, and
 * whoever made them hears once, on one line, however many there were. Runs after the removal commits.
 */
export const unassignLeaver = defineFunction({
  name: "tasks/unassign_leaver",
  description: "Take someone who left a space off its tasks, and tell whoever made those tasks.",
  input: { actor_id: input.int({ required: true }), user_id: input.int({ required: true }), space_id: input.int({ required: true }) },
  stack: [
    s.db.query({ table: task, where: [cmp(col("space_id"), "=", inp("space_id")), cmp(col("assignee_id"), "=", inp("user_id")), notDeleted()], output: ["id", "created_by"], as: "held" }),
    s.conditional({ when: expr(withFilters(ref("held"), fl.count()), ">", c.int(0)), then: [
      s.array.map({ source: ref("held"), as: "released", transform: { id: ref("$this.id"), assignee_id: c.int(0), left_by: inp("user_id") } }),
      s.db.bulk.patch({ table: task, items: ref("released"), as: "cleared" }),
      s.db.get({ table: user, fieldValue: inp("user_id"), output: ["name"], as: "leaver" }),
      s.foreach({ list: ref("held"), as: "item", body: [
        s.function.run({ fn: closeItems, as: "closed", input: { entity: c.text("task"), entity_id: ref("item.id"), kind: c.text("assigned"), user_id: inp("user_id"), seq: c.int(0) } }),
      ] }),
      s.array.map({ source: ref("held"), as: "makers", transform: ref("$this.created_by") }),
      s.foreach({ list: withFilters(ref("makers"), fl.unique()), as: "maker_id", body: [
        s.array.filter_count({ expr: ref("held"), if: expr(ref("$this.created_by"), "=", ref("maker_id")), as: "their_tasks" }),
        s.set_var("noun", c.expression('$var.their_tasks == 1 ? "task needs" : "tasks need"')),
        s.function.run({ fn: deliver, as: "told_maker", input: {
          user_id: ref("maker_id"), kind: c.text("unassigned"),
          title: withFilters(ref("leaver.name", { safe: true }), fl.concat(c.text(" left, so ")), fl.concat(ref("their_tasks")), fl.concat(c.text(" ")), fl.concat(ref("noun")), fl.concat(c.text(" someone new"))),
          body: c.text(""), link: withFilters(c.text("/tasks?space="), fl.concat(inp("space_id")), fl.concat(c.text("&assignee=none"))), actor_id: inp("actor_id"),
          space_id: inp("space_id"), dm_id: c.int(0), entity: c.text("space"), entity_id: inp("space_id"), group_key: withFilters(c.text("left-"), fl.concat(inp("space_id")), fl.concat(c.text("-")), fl.concat(inp("user_id"))), seq: c.int(0),
        } }),
      ] }),
      changed({ entity: "task", id: c.int(0), op: "updated", actor: inp("actor_id"), space: inp("space_id") }),
    ] }),
  ],
  response: { released: withFilters(ref("held"), fl.count()) },
});

/** What 30 days in the trash ends in: the task, its thread, its links and anything still naming it. A chip that pointed at it reads Deleted. */
export const purgeTasks = defineFunction({
  name: "tasks/purge",
  description: "Remove tasks that have been in the trash for over 30 days, with their threads and links.",
  stack: [
    s.set_var("cutoff", withFilters(c.now(), fl.epochms_transform(PURGE_AFTER))),
    s.db.query({ table: task, where: [cmp(col("deleted_at"), "!=", c.null()), expr(col("deleted_at"), "<", ref("cutoff"))], paging: { per_page: 500, metadata: false }, output: ["id"], as: "expired" }),
    s.foreach({ list: ref("expired"), as: "item", body: [
      s.set_var("key", withFilters(c.text("thread-task-"), fl.concat(ref("item.id")))),
      s.db.query({ table: conversation, where: cmp(col("unique_key"), "=", ref("key")), output: ["id"], returnType: "single", as: "thread" }),
      s.conditional({ when: expr(ref("thread"), "!=", c.null()), then: [
        s.set_var("thread_id", ref("thread.id", { safe: true })),
        s.db.query({ table: message, where: cmp(col("conversation_id"), "=", ref("thread_id")), output: ["id"], as: "said" }),
        s.foreach({ list: ref("said"), as: "post", body: [s.function.run({ fn: forgetRecord, as: "forgotten", input: { type: c.text("message"), id: ref("post.id") } })] }),
        s.db.bulk.delete({ table: message, where: cmp(col("conversation_id"), "=", ref("thread_id")), as: "wiped" }),
        s.db.bulk.delete({ table: notification, where: and(cmp(col("entity"), "=", c.text("conversation")), cmp(col("entity_id"), "=", ref("thread_id"))), as: "unsaid" }),
        s.db.del({ table: conversation, fieldValue: ref("thread_id") }),
      ] }),
      s.function.run({ fn: forgetRecord, as: "forgotten", input: { type: c.text("task"), id: ref("item.id") } }),
      s.db.bulk.delete({ table: notification, where: and(cmp(col("entity"), "=", c.text("task")), cmp(col("entity_id"), "=", ref("item.id"))), as: "unsaid" }),
      s.db.del({ table: task, fieldValue: ref("item.id") }),
    ] }),
  ],
  response: { purged: withFilters(ref("expired"), fl.count()) },
});

/** The trash empties itself, once a day. */
export const purgeDaily = scheduledTask({
  name: "tasks_purge_daily",
  description: "Remove tasks that have been in the trash for over 30 days.",
  schedule: [{ startsOn: "2026-01-01T03:00:00Z", freq: 86_400, repeatEnabled: true }],
  stack: [s.function.run({ fn: purgeTasks, as: "purged" })],
});

/** Binds `project_ids`: what a list covers. One project, one space's live projects, or the live ones in every space someone has joined. */
const bindScope = statements(
  s.set_var("space_name", c.text("")),
  s.set_var("archived", c.bool(false)),
  s.set_var("project_ids", c.array([])),
  s.conditional({ when: expr(inp("space_id"), ">", c.int(0)), then: [
    ...requireReach({ ...me, type: "space", id: inp("space_id") }),
    s.db.get({ table: space, fieldValue: inp("space_id"), output: ["name", "archived_at"], as: "home" }),
    s.update_var("space_name", ref("home.name", { safe: true })),
    s.conditional({ when: expr(ref("home.archived_at", { safe: true }), "!=", c.null()), then: [s.update_var("archived", c.bool(true))] }),
  ] }),
  s.conditional({
    when: expr(inp("project_id"), ">", c.int(0)),
    then: [
      ...requireReach({ ...me, type: "project", id: inp("project_id") }),
      s.update_var("project_ids", withFilters(ref("project_ids"), fl.array_push(inp("project_id")))),
    ],
    else: [
      s.set_var("spaces", c.array([])),
      s.conditional({
        when: expr(inp("space_id"), ">", c.int(0)),
        then: [s.update_var("spaces", withFilters(ref("spaces"), fl.array_push(inp("space_id"))))],
        else: [
          s.db.query({ table: space_member, where: cmp(col("user_id"), "=", inp("actor_id")), output: ["space_id"], as: "joined" }),
          s.array.map({ source: ref("joined"), as: "joined_ids", transform: ref("$this.space_id") }),
          s.db.query({ table: space, where: [cmp(col("id"), "in", ref("joined_ids")), cmp(col("archived_at"), "=", c.null())], output: ["id"], as: "live_spaces" }),
          s.array.map({ source: ref("live_spaces"), as: "live_ids", transform: ref("$this.id") }),
          s.update_var("spaces", ref("live_ids")),
        ],
      }),
      s.db.query({ table: project, where: [cmp(col("space_id"), "in", ref("spaces")), cmp(col("archived_at"), "=", c.null())], output: ["id"], as: "projects" }),
      s.array.map({ source: ref("projects"), as: "scope_ids", transform: ref("$this.id") }),
      s.update_var("project_ids", ref("scope_ids")),
    ],
  }),
);

function columnQuery(extra: ReturnType<typeof cmp>[]) {
  return s.db.query({
    table: task, as: "rows",
    where: [
      cmp(col("project_id"), "in", ref("project_ids")), notDeleted(), cmp(col("status"), "=", ref("column")), cmp(col("priority"), "=", inp("priority"), { ignoreEmpty: true }),
      cmp(col("title"), "includes", inp("q"), { ignoreEmpty: true }), cmp(col("assignee_id"), "in", ref("assignees"), { ignoreEmpty: true }),
      cmp(col("due_on"), ">=", inp("due_from"), { ignoreEmpty: true }), cmp(col("due_on"), "<=", inp("due_to"), { ignoreEmpty: true }), ...extra,
    ],
    sort: [{ sortBy: "rank", dir: "asc" }, { sortBy: "id", dir: "asc" }],
    paging: { per_page: ref("size"), metadata: true, totals: true },
    ...withNames,
  });
}

/**
 * Every column's first rows, in order, and how many each holds. Lists and boards read the same answer, so changing view costs
 * nothing. `ever` and `open` ignore the filters, so a screen can tell "nothing yet" from "all done" from "nothing matched".
 */
export const listTasks = defineFunction({
  name: "tasks/list",
  description: "The tasks in a scope, column by column, narrowed by filters.",
  input: {
    ...who, space_id: input.int(), project_id: input.int(), status: input.text(), priority: input.text(), q: input.text(),
    /** A person, or -1 for nobody. */
    assignee_id: input.int(),
    due_from: input.text(), due_to: input.text(), no_due: input.bool(), limit: input.int(),
  },
  stack: [
    ...bindScope,
    s.set_var("size", c.int(A_COLUMN)),
    s.conditional({ when: expr(inp("limit"), ">", c.int(0)), then: [s.update_var("size", withFilters(inp("limit"), fl.min(c.int(MOST_IN_A_COLUMN))))] }),
    s.set_var("assignees", c.array([])),
    s.conditional({ when: expr(inp("assignee_id"), ">", c.int(0)), then: [s.update_var("assignees", withFilters(ref("assignees"), fl.array_push(inp("assignee_id"))))] }),
    s.conditional({ when: expr(inp("assignee_id"), "<", c.int(0)), then: [s.update_var("assignees", c.array([0]))] }),
    s.set_var("columns", c.array([...TASK_STATUSES])),
    s.conditional({ when: expr(inp("status"), "!=", c.text("")), then: [s.update_var("columns", withFilters(c.array([]), fl.array_push(inp("status"))))] }),
    s.set_var("items", c.array([])),
    s.set_var("totals", c.obj({})),
    s.foreach({ list: ref("columns"), as: "column", body: [
      s.conditional({ when: expr(inp("no_due"), "=", c.bool(true)), then: [columnQuery([cmp(col("due_on"), "=", c.null())])], else: [columnQuery([])] }),
      s.update_var("items", withFilters(ref("items"), fl.array_merge(ref("rows.items")))),
      s.update_var("totals", withFilters(ref("totals"), fl.set(ref("column"), ref("rows.itemsTotal")))),
    ] }),
    s.db.query({ table: task, where: [cmp(col("project_id"), "in", ref("project_ids")), notDeleted()], returnType: "count", as: "ever" }),
    s.db.query({ table: task, where: [cmp(col("project_id"), "in", ref("project_ids")), notDeleted(), cmp(col("status"), "in", c.array(OPEN))], returnType: "count", as: "open" }),
  ],
  response: { items: ref("items"), totals: ref("totals"), ever: ref("ever"), open: ref("open"), limit: ref("size"), space_name: ref("space_name"), archived: ref("archived") },
});

export const searchTasks = defineFunction({
  name: "tasks/search",
  description: "Tasks whose title matches, in the spaces an actor reaches.",
  input: { ...who, q: input.text() },
  stack: [
    reachOf(inp("actor_id"), inp("browser")),
    s.set_var("found", c.array([])),
    s.conditional({ when: expr(withFilters(inp("q"), fl.strlen()), ">=", c.int(1)), then: [
      s.db.query({ table: task, where: [cmp(col("space_id"), "in", ref("reach.space_ids")), notDeleted(), cmp(col("title"), "includes", inp("q"))], sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: SEARCH_RESULTS, metadata: false }, ...withNames, as: "matches" }),
      s.update_var("found", ref("matches")),
    ] }),
  ],
  response: ref("found"),
});

/** What the screen needs around its list: where work can go, and this person's saved filters. */
export const taskSetup = defineFunction({
  name: "tasks/setup",
  description: "The spaces and projects an actor can work in, and their saved filters.",
  input: who,
  stack: [
    reachOf(inp("actor_id"), inp("browser")),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["role"], as: "actor" }),
    s.db.query({ table: space_member, where: cmp(col("user_id"), "=", inp("actor_id")), output: ["space_id"], as: "joined" }),
    s.array.map({ source: ref("joined"), as: "joined_ids", transform: ref("$this.space_id") }),
    s.db.query({ table: space, where: [cmp(col("id"), "in", ref("reach.space_ids")), cmp(col("archived_at"), "=", c.null())], sort: [{ sortBy: "name", dir: "asc" }], output: ["id", "name", "guests_can_create"], as: "rows" }),
    s.set_var("role", ref("actor.role", { safe: true })),
    s.set_var("guest", c.expression('$var.role == "guest"')),
    s.array.map({ source: ref("rows"), as: "spaces", transform: {
      id: ref("$this.id"), name: ref("$this.name"),
      joined: withFilters(ref("joined_ids"), fl.in(ref("$this.id"))),
      can_create: c.expression("$var.guest == false || $this.guests_can_create == true"),
    } }),
    s.array.map({ source: ref("rows"), as: "space_ids", transform: ref("$this.id") }),
    s.db.query({ table: project, where: [cmp(col("space_id"), "in", ref("space_ids")), cmp(col("archived_at"), "=", c.null())], sort: [{ sortBy: "name", dir: "asc" }], paging: { per_page: 500, metadata: false }, as: "projects" }),
    s.db.query({ table: task_view, where: cmp(col("user_id"), "=", inp("actor_id")), sort: [{ sortBy: "name", dir: "asc" }], as: "views" }),
  ],
  response: { spaces: ref("spaces"), projects: ref("projects"), views: ref("views") },
});

export const readTask = defineFunction({
  name: "tasks/read",
  description: "One task, where it lives, and what an actor may do with it.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...reachableTask,
    rowOf(inp("id"), "answer"),
    s.db.get({ table: space, fieldValue: ref("row.space_id"), output: ["name", "archived_at"], as: "home" }),
    s.function.run({ fn: canCreate, as: "creates", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: ref("row.space_id") } }),
    s.set_var("archived", c.bool(false)),
    s.conditional({ when: expr(ref("home.archived_at", { safe: true }), "!=", c.null()), then: [s.update_var("archived", c.bool(true))] }),
    s.set_var("trashed", c.bool(false)),
    s.conditional({ when: expr(ref("row.deleted_at"), "!=", c.null()), then: [s.update_var("trashed", c.bool(true))] }),
    s.set_var("left_name", c.text("")),
    s.conditional({ when: and(expr(ref("row.left_by"), ">", c.int(0)), expr(ref("row.assignee_id"), "=", c.int(0))), then: [
      s.db.get({ table: user, fieldValue: ref("row.left_by"), output: ["name"], as: "leaver" }),
      s.update_var("left_name", ref("leaver.name", { safe: true })),
    ] }),
    s.set_var("thread_key", withFilters(c.text("thread-task-"), fl.concat(inp("id")))),
    s.db.query({ table: conversation, where: cmp(col("unique_key"), "=", ref("thread_key")), output: ["id"], returnType: "single", as: "thread" }),
    s.set_var("thread_id", c.int(0)),
    s.conditional({ when: expr(ref("thread"), "!=", c.null()), then: [s.update_var("thread_id", ref("thread.id", { safe: true }))] }),
    s.db.query({ table: notification, where: [cmp(col("user_id"), "=", inp("actor_id")), cmp(col("entity"), "=", c.text("task")), cmp(col("entity_id"), "=", inp("id")), cmp(col("read_at"), "=", c.null())], returnType: "count", as: "unread_items" }),
  ],
  response: {
    task: ref("answer"), space_name: ref("home.name", { safe: true }), archived: ref("archived"), trashed: ref("trashed"),
    can_edit: c.expression("$var.creates == true && $var.trashed == false"), can_restore: c.expression("$var.creates == true && $var.trashed == true"), left_name: ref("left_name"), thread_id: ref("thread_id"), unread_items: ref("unread_items"),
  },
});

export const taskFunctions = [
  cleanDue, topRank, renumber, placeIn, tellAdded, tellMentions, applyPlace, insertTask, createTask, updateTask, reviseTask, setStatus, moveTask, setPriority, setDue, assignTask, deleteTask, restoreTask,
  createProject, updateProject, saveView, deleteView, unassignLeaver, purgeTasks, listTasks, searchTasks, taskSetup, readTask,
];
