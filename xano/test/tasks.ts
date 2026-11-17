// Workflow tests for tasks: every write through its route, who reaches what, and what each write leaves in inboxes, links and
// the change log. Each makes its own rows. Two real windows, drag and the speed budgets need a browser, so
// frontend/scripts/tasks-check.mjs proves those against a deployed backend.
import { c, expr, fl, obj, ref, s, withFilters, workflowTest, type Value } from "@xano/sdk";
import { notification } from "../base/tables.js";
import { listChanges } from "../query/changes.js";
import { addLink, getLinks, resolveLinks } from "../query/links.js";
import { openThreadRoute, postMessageRoute } from "../query/messages.js";
import { listNotifications } from "../base/queries.js";
import { removeSpaceMemberRoute, updateSpaceRoute } from "../query/spaces.js";
import {
  assignTaskRoute, createProjectRoute, createTaskRoute, createViewRoute, deleteTaskRoute, deleteViewRoute, getTaskRoute, listTasksRoute, moveTaskRoute, readTaskRoute,
  restoreTaskRoute, searchTasksRoute, setDueRoute, setPriorityRoute, setStatusRoute, taskSetupRoute, updateProjectRoute, updateTaskRoute,
} from "../query/tasks.js";
import { canReach } from "../function/access/reach.js";
import { purgeTasks } from "../function/tasks/tasks.js";
import { task } from "../table/tasks/task.js";
import { project } from "../table/tasks/project.js";
import { task_view } from "../table/tasks/task_view.js";
import { conversation } from "../table/messaging/conversation.js";
import { message } from "../table/messaging/message.js";
import { record_link } from "../table/links/record_link.js";
import { user } from "../table/user.js";
import { bearer, channel, joined, makeSpace, missesText, no, notFound, person, personToken, seesText, settings, yes } from "./access.js";

const call = (api: Parameters<typeof s.api.call>[0]["api"], token: string, as: string, input: Record<string, Value> = {}) => s.api.call({ api, headers: bearer(token), as, input });
const equal = (name: string, value: Value) => s.expect.to_equal({ expr: ref(name), value });
const is = (name: string, n: number) => equal(name, c.int(n));
const text = (name: string, value: string) => equal(name, c.text(value));
const count = (name: string, n: number) => s.expect.to_equal({ expr: withFilters(ref(name), fl.count()), value: c.int(n) });
const says = (name: string, value: string) => equal(`${name}.message`, c.text(value));

const newProject = (token: string, spaceKey: string, name: string, as: string) => call(createProjectRoute, token, as, { space_id: ref(`${spaceKey}.id`), name: c.text(name) });
const newTask = (token: string, projectKey: string, title: string, as: string, more: Record<string, Value> = {}) =>
  call(createTaskRoute, token, as, { project_id: ref(`${projectKey}.id`), client_id: c.text(`${as}-id`), title: c.text(title), status: c.text("todo"), priority: c.text("none"), ...more });
const move = (token: string, key: string, status: string, as: string, before?: string) =>
  call(moveTaskRoute, token, as, { id: ref(`${key}.id`), status: c.text(status), before_id: before ? ref(`${before}.id`) : c.int(0) });
const assign = (token: string, key: string, who: string | null, as: string) => call(assignTaskRoute, token, as, { id: ref(`${key}.id`), assignee_id: who ? ref(`${who}.id`) : c.int(0) });
const list = (token: string, as: string, input: Record<string, Value> = {}) => call(listTasksRoute, token, as, input);
const read = (token: string, key: string, as: string) => call(getTaskRoute, token, as, { id: ref(`${key}.id`) });
const inbox = (token: string, as: string) => call(listNotifications, token, as);
const items = (where: string) => s.db.query({ table: notification, returnType: "count", as: where });
/** The titles of a list, in order, as one string: "first,second". */
const order = (name: string, as: string) => [
  s.array.map({ source: ref(`${name}.items`), as: `${as}_titles`, transform: ref("$this.title") }),
  s.set_var(as, withFilters(ref(`${as}_titles`), fl.join(","))),
];

/** Ada manages space A, Ben is in it, Cy is in neither, and A has a project and a channel. */
const team = [
  settings(), person("ada"), person("ben"), person("cy"), makeSpace("a"), joined("a", "ada", "manager"), joined("a", "ben"), channel("chat", "a"),
  personToken("ada", "ada_token"), personToken("ben", "ben_token"), personToken("cy", "cy_token"),
  newProject("ada_token", "a", "Launch", "launch"),
];

export const taskTests = [
  workflowTest({
    name: "tasks: a member makes a project and a task, and a retry with the same client id makes no second one",
    stack: [
      ...team,
      text("launch.name", "Launch"), equal("launch.space_id", ref("a.id")),
      newTask("ben_token", "launch", "Write the brief", "first", { description: c.text("The why") }),
      call(createTaskRoute, "ben_token", "retry", { project_id: ref("launch.id"), client_id: c.text("first-id"), title: c.text("Write the brief"), status: c.text("todo"), priority: c.text("none") }),
      equal("retry.id", ref("first.id")),
      text("first.status", "todo"), equal("first.space_id", ref("a.id")), equal("first.created_by", ref("ben.id")),
      s.db.query({ table: task, returnType: "count", as: "rows" }), is("rows", 1),
      list("ben_token", "seen"), count("seen.items", 1), text("seen.items.0.title", "Write the brief"), text("seen.items.0.project_name", "Launch"),
      is("seen.ever", 1), is("seen.open", 1), is("seen.totals.todo", 1),
    ],
  }),
  workflowTest({
    name: "tasks: a title is required and has a limit, and nothing is made",
    stack: [
      ...team,
      newTask("ada_token", "launch", "   ", "blank"), says("blank", "Give the task a title."),
      newTask("ada_token", "launch", "x".repeat(201), "long"), says("long", "Keep the title under 200 characters."),
      s.db.query({ table: task, returnType: "count", as: "rows" }), is("rows", 0),
    ],
  }),
  workflowTest({
    name: "tasks: nobody outside reads or writes, and it answers the same as nothing there",
    stack: [
      ...team,
      newTask("ada_token", "launch", "Secret plan", "plan"),
      read("cy_token", "plan", "cy_read"), notFound("cy_read"), missesText("cy_read", "Secret plan"),
      call(updateTaskRoute, "cy_token", "cy_edit", { id: ref("plan.id"), title: c.text("Mine now"), description: c.text("") }), notFound("cy_edit"),
      move("cy_token", "plan", "done", "cy_move"), notFound("cy_move"),
      assign("cy_token", "plan", "cy", "cy_assign"), notFound("cy_assign"),
      call(deleteTaskRoute, "cy_token", "cy_delete", { id: ref("plan.id") }), notFound("cy_delete"),
      newTask("cy_token", "launch", "Sneaking in", "cy_made"), notFound("cy_made"),
      list("cy_token", "cy_list"), count("cy_list.items", 0), is("cy_list.ever", 0), missesText("cy_list", "Secret plan"),
      list("cy_token", "cy_scoped", { space_id: ref("a.id") }), notFound("cy_scoped"),
      call(searchTasksRoute, "cy_token", "cy_search", { q: c.text("Secret") }), count("cy_search", 0),
      call(resolveLinks, "cy_token", "cy_chip", { items: withFilters(c.array([]), fl.array_push(obj({ type: c.text("task"), id: ref("plan.id") }))) }),
      text("cy_chip.0.state", "locked"), text("cy_chip.0.title", ""), missesText("cy_chip", "Secret plan"),
      call(resolveLinks, "ben_token", "ben_chip", { items: withFilters(c.array([]), fl.array_push(obj({ type: c.text("task"), id: ref("plan.id") }))) }),
      text("ben_chip.0.state", "live"), text("ben_chip.0.title", "Secret plan"),
      s.function.call({ fn: canReach, as: "ben_reaches", input: { actor_id: ref("ben.id"), browser: c.bool(true), type: c.text("task"), id: ref("plan.id") } }), yes("ben_reaches"),
      s.function.call({ fn: canReach, as: "cy_reaches", input: { actor_id: ref("cy.id"), browser: c.bool(true), type: c.text("project"), id: ref("launch.id") } }), no("cy_reaches"),
    ],
  }),
  workflowTest({
    name: "tasks: a guest reads, comments and edits only when the space says so",
    stack: [
      ...team, person("gus", "guest"), joined("a", "gus"), personToken("gus", "gus_token"),
      newTask("ada_token", "launch", "Client review", "review"),
      read("gus_token", "review", "gus_read"), text("gus_read.task.title", "Client review"), no("gus_read.can_edit"),
      newTask("gus_token", "launch", "Guest idea", "gus_made"), says("gus_made", "Guests can't add or change tasks in this space."),
      move("gus_token", "review", "done", "gus_move"), says("gus_move", "Guests can't add or change tasks in this space."),
      call(openThreadRoute, "gus_token", "thread", { record_type: c.text("task"), record_id: ref("review.id") }),
      call(postMessageRoute, "gus_token", "said", { id: ref("thread.id"), client_msg_id: c.text("g1"), body: c.text("Looks right") }), text("said.message.body", "Looks right"),
      call(updateSpaceRoute, "ada_token", "opened", { id: ref("a.id"), name: c.text("Space a"), visibility: c.text("private"), guests_can_create: c.bool(true), archived: c.bool(false) }),
      newTask("gus_token", "launch", "Guest idea", "gus_again"), text("gus_again.title", "Guest idea"),
      call(taskSetupRoute, "gus_token", "setup"), yes("setup.spaces.0.can_create"),
    ],
  }),
  workflowTest({
    name: "tasks: an archived space reads and takes no writes, and its tasks leave the all-spaces list",
    stack: [
      ...team,
      newTask("ada_token", "launch", "Keep me", "kept"),
      call(updateSpaceRoute, "ada_token", "archived", { id: ref("a.id"), name: c.text("Space a"), visibility: c.text("private"), guests_can_create: c.bool(false), archived: c.bool(true) }),
      read("ben_token", "kept", "reading"), text("reading.task.title", "Keep me"), no("reading.can_edit"), yes("reading.archived"),
      move("ada_token", "kept", "done", "moved"), says("moved", "This space is archived."),
      newTask("ada_token", "launch", "Too late", "late"), says("late", "This space is archived."),
      list("ben_token", "all"), count("all.items", 0),
      list("ben_token", "scoped", { space_id: ref("a.id") }), count("scoped.items", 1),
    ],
  }),
  workflowTest({
    name: "tasks: status, priority, due date and title each change alone, and finishing stamps it",
    stack: [
      ...team,
      newTask("ada_token", "launch", "Ship it", "ship"),
      call(setPriorityRoute, "ben_token", "urgent", { id: ref("ship.id"), priority: c.text("urgent") }), text("urgent.priority", "urgent"), text("urgent.status", "todo"),
      call(setDueRoute, "ben_token", "dated", { id: ref("ship.id"), due_on: c.text("2026-12-01") }), text("dated.due_on", "2026-12-01"), text("dated.priority", "urgent"),
      call(setDueRoute, "ben_token", "undated", { id: ref("ship.id"), due_on: c.text("") }), s.expect.to_be_null({ expr: ref("undated.due_on") }),
      call(setDueRoute, "ben_token", "bad_day", { id: ref("ship.id"), due_on: c.text("not a day") }), says("bad_day", "Choose a real date."),
      call(setStatusRoute, "ben_token", "started", { id: ref("ship.id"), status: c.text("in_progress") }), text("started.status", "in_progress"), s.expect.to_be_null({ expr: ref("started.completed_at") }),
      call(setStatusRoute, "ben_token", "finished", { id: ref("ship.id"), status: c.text("done") }), s.expect.to_be_defined({ expr: ref("finished.completed_at") }),
      call(setStatusRoute, "ben_token", "reopened", { id: ref("ship.id"), status: c.text("todo") }), s.expect.to_be_null({ expr: ref("reopened.completed_at") }),
      call(updateTaskRoute, "ben_token", "renamed", { id: ref("ship.id"), title: c.text("Ship it now"), description: c.text("Today") }), text("renamed.title", "Ship it now"), text("renamed.description", "Today"), text("renamed.status", "todo"),
    ],
  }),
  workflowTest({
    name: "tasks: a filter narrows the list, its totals agree, and a saved filter is its owner's alone",
    stack: [
      ...team,
      newTask("ada_token", "launch", "Alpha report", "alpha", { priority: c.text("high") }),
      newTask("ada_token", "launch", "Beta report", "beta", { status: c.text("in_progress") }),
      newTask("ada_token", "launch", "Gamma notes", "gamma", { due_on: c.text("2026-01-10") }),
      assign("ada_token", "beta", "ben", "to_ben"),
      list("ada_token", "by_text", { q: c.text("report") }), count("by_text.items", 2), is("by_text.ever", 3),
      list("ada_token", "by_status", { status: c.text("in_progress") }), count("by_status.items", 1), text("by_status.items.0.title", "Beta report"),
      list("ada_token", "by_priority", { priority: c.text("high") }), count("by_priority.items", 1),
      list("ada_token", "by_person", { assignee_id: ref("ben.id") }), count("by_person.items", 1), equal("by_person.items.0.assignee_name", c.text("Test ben")),
      list("ada_token", "by_nobody", { assignee_id: c.int(-1) }), count("by_nobody.items", 2),
      list("ada_token", "by_due", { due_to: c.text("2026-01-31") }), count("by_due.items", 1), text("by_due.items.0.title", "Gamma notes"),
      list("ada_token", "no_due", { no_due: c.bool(true) }), count("no_due.items", 2),
      list("ada_token", "nothing", { q: c.text("zebra") }), count("nothing.items", 0), is("nothing.ever", 3),
      call(createViewRoute, "ada_token", "mine", { name: c.text("Hot reports"), query: obj({ q: c.text("report"), view: c.text("board") }) }), text("mine.query.q", "report"),
      call(createViewRoute, "ada_token", "same_name", { name: c.text("Hot reports"), query: obj({ q: c.text("notes") }) }), equal("same_name.id", ref("mine.id")), text("same_name.query.q", "notes"),
      call(createViewRoute, "ada_token", "unnamed", { name: c.text("  "), query: c.obj({}) }), says("unnamed", "Name this filter."),
      call(taskSetupRoute, "ada_token", "ada_setup"), count("ada_setup.views", 1), text("ada_setup.views.0.name", "Hot reports"),
      call(taskSetupRoute, "ben_token", "ben_setup"), count("ben_setup.views", 0),
      call(deleteViewRoute, "ben_token", "ben_delete", { id: ref("mine.id") }), notFound("ben_delete"),
      call(deleteViewRoute, "ada_token", "gone", { id: ref("mine.id") }),
      s.db.query({ table: task_view, returnType: "count", as: "left" }), is("left", 0),
    ],
  }),
  workflowTest({
    name: "tasks: a move lands where it's put, and a second reader sees that order",
    stack: [
      ...team,
      newTask("ada_token", "launch", "One", "one"), newTask("ada_token", "launch", "Two", "two"), newTask("ada_token", "launch", "Three", "three"),
      list("ben_token", "start", { status: c.text("todo") }), ...order("start", "at_start"), equal("at_start", c.text("Three,Two,One")),
      move("ada_token", "one", "todo", "up", "three"),
      list("ben_token", "after_up", { status: c.text("todo") }), ...order("after_up", "at_up"), equal("at_up", c.text("One,Three,Two")),
      move("ada_token", "one", "todo", "between", "two"),
      list("ben_token", "after_mid", { status: c.text("todo") }), ...order("after_mid", "at_mid"), equal("at_mid", c.text("Three,One,Two")),
      move("ada_token", "three", "todo", "last"),
      list("ben_token", "after_end", { status: c.text("todo") }), ...order("after_end", "at_end"), equal("at_end", c.text("One,Two,Three")),
      move("ada_token", "two", "in_review", "across"), text("across.status", "in_review"),
      list("ben_token", "column", { status: c.text("in_review") }), count("column.items", 1),
      move("ada_token", "one", "in_review", "above", "two"),
      list("ben_token", "column_two", { status: c.text("in_review") }), ...order("column_two", "at_column"), equal("at_column", c.text("One,Two")),
    ],
  }),
  workflowTest({
    name: "tasks: a column with no room left renumbers itself, and keeps its order",
    stack: [
      ...team,
      newTask("ada_token", "launch", "A", "ta"), newTask("ada_token", "launch", "B", "tb"), newTask("ada_token", "launch", "C", "tc"),
      s.db.patch({ table: task, fieldValue: ref("ta.id"), data: obj({ rank: c.int(100) }) }),
      s.db.patch({ table: task, fieldValue: ref("tb.id"), data: obj({ rank: c.int(101) }) }),
      s.db.patch({ table: task, fieldValue: ref("tc.id"), data: obj({ rank: c.int(102) }) }),
      move("ada_token", "tc", "todo", "squeezed", "tb"),
      list("ben_token", "after", { status: c.text("todo") }), ...order("after", "at_after"), equal("at_after", c.text("A,C,B")),
      s.expect.to_be_true({ expr: c.expression("$var.after.items[1].rank - $var.after.items[0].rank > 1") }),
    ],
  }),
  workflowTest({
    name: "tasks: moving before a task that left its column falls to the end, and never fails",
    stack: [
      ...team,
      newTask("ada_token", "launch", "Stay", "stay"), newTask("ada_token", "launch", "Gone", "gone"), newTask("ada_token", "launch", "Mover", "mover"),
      call(setStatusRoute, "ben_token", "gone_done", { id: ref("gone.id"), status: c.text("done") }),
      move("ada_token", "mover", "todo", "moved", "gone"), text("moved.status", "todo"),
      list("ada_token", "after", { status: c.text("todo") }), ...order("after", "at_after"), equal("at_after", c.text("Stay,Mover")),
    ],
  }),
  workflowTest({
    name: "tasks: assigning reaches the person's inbox, and a reassign, a finish and a delete take it back out",
    stack: [
      ...team,
      newTask("ada_token", "launch", "Own it", "own"),
      assign("ada_token", "own", "ben", "given"), equal("given.assignee_id", ref("ben.id")),
      inbox("ben_token", "ben_inbox"), count("ben_inbox.items", 1), text("ben_inbox.items.0.kind", "assigned"), text("ben_inbox.items.0.title", "Test ada assigned you a task"),
      missesText("ben_inbox.items.0.title", "Own it"), text("ben_inbox.records.0.title", "Own it"),
      assign("ada_token", "own", "ben", "again"),
      s.db.query({ table: notification, returnType: "count", as: "once" }), is("once", 1),
      assign("ada_token", "own", "ada", "to_ada"),
      inbox("ben_token", "ben_after"), count("ben_after.items", 0),
      assign("ben_token", "own", "ben", "taken"),
      inbox("ben_token", "ben_taken"), count("ben_taken.items", 0),
      assign("ada_token", "own", null, "cleared"), assign("ada_token", "own", "ben", "back"),
      inbox("ben_token", "ben_back"), count("ben_back.items", 1),
      call(setStatusRoute, "ada_token", "finished", { id: ref("own.id"), status: c.text("done") }),
      inbox("ben_token", "ben_done"), count("ben_done.items", 0),
      assign("ada_token", "own", "cy", "outside"), says("outside", "Add them to this space first."),
      newTask("ada_token", "launch", "Throw away", "bin", { assignee_id: ref("ben.id") }),
      inbox("ben_token", "ben_bin"), count("ben_bin.items", 1),
      call(deleteTaskRoute, "ada_token", "binned", { id: ref("bin.id") }),
      inbox("ben_token", "ben_binned"), count("ben_binned.items", 0),
    ],
  }),
  workflowTest({
    name: "tasks: an agent member can be assigned and shows as an agent, and one outside the space can't",
    stack: [
      ...team,
      s.db.add({ table: user, as: "scout", row: { name: c.text("Scout"), email: c.null(), password: c.null(), role: c.text("agent"), kind: c.text("agent"), sponsor_id: ref("ada.id"), status: c.text("active"), is_demo: c.bool(false) } }),
      newTask("ada_token", "launch", "Research", "research"),
      assign("ada_token", "research", "scout", "refused"), says("refused", "Add them to this space first."),
      joined("a", "scout"),
      assign("ada_token", "research", "scout", "given"), equal("given.assignee_id", ref("scout.id")), text("given.assignee_kind", "agent"), text("given.assignee_name", "Scout"),
      list("ben_token", "seen"), text("seen.items.0.assignee_kind", "agent"),
      s.db.query({ table: notification, returnType: "count", as: "told" }), is("told", 1),
    ],
  }),
  workflowTest({
    name: "tasks: someone who leaves a space is taken off its tasks, with a notice on each and one inbox line for who made them",
    stack: [
      ...team, person("dee"), joined("a", "dee"), personToken("dee", "dee_token"), makeSpace("b"), joined("b", "ada", "manager"), joined("b", "ben"), newProject("ada_token", "b", "Elsewhere", "elsewhere"),
      newTask("dee_token", "launch", "One", "one", { assignee_id: ref("ben.id") }), newTask("dee_token", "launch", "Two", "two", { assignee_id: ref("ben.id") }),
      newTask("ada_token", "elsewhere", "Other", "other", { assignee_id: ref("ben.id") }),
      call(removeSpaceMemberRoute, "ada_token", "removed", { id: ref("a.id"), user_id: ref("ben.id") }),
      read("ada_token", "one", "after"), is("after.task.assignee_id", 0), text("after.left_name", "Test ben"),
      read("ada_token", "other", "kept"), equal("kept.task.assignee_id", ref("ben.id")),
      inbox("dee_token", "dee_inbox"), seesText("dee_inbox", "Test ben left, so 2 tasks need someone new"), seesText("dee_inbox", "/tasks?space="),
      inbox("ada_token", "ada_inbox"), missesText("ada_inbox", "need someone new"),
      assign("ada_token", "one", "ada", "taken"),
      read("ada_token", "one", "taken_on"), text("taken_on.left_name", ""),
      inbox("ben_token", "ben_inbox"), missesText("ben_inbox", "One"),
    ],
  }),
  workflowTest({
    name: "tasks: a mention in a description reaches that person once, makes a link, and leaves when taken out",
    stack: [
      ...team,
      newTask("ada_token", "launch", "Plan", "plan"),
      s.set_var("body", withFilters(c.text("for <@"), fl.concat(ref("ben.id")), fl.concat(c.text("> see <#conversation:")), fl.concat(ref("chat.id")), fl.concat(c.text(">")))),
      call(updateTaskRoute, "ada_token", "said", { id: ref("plan.id"), title: c.text("Plan"), description: ref("body") }),
      inbox("ben_token", "first"), count("first.items", 1), text("first.items.0.kind", "mention"),
      call(getLinks, "ada_token", "links", { type: c.text("task"), id: ref("plan.id") }), count("links.forward", 1), text("links.forward.0.title", "Channel chat"), s.expect.to_be_defined({ expr: ref("links.forward.0.link_id") }),
      call(updateTaskRoute, "ada_token", "again", { id: ref("plan.id"), title: c.text("Plan again"), description: ref("body") }),
      s.db.query({ table: notification, returnType: "count", as: "once" }), is("once", 1),
      call(updateTaskRoute, "ada_token", "taken_out", { id: ref("plan.id"), title: c.text("Plan"), description: c.text("nobody") }),
      inbox("ben_token", "after"), count("after.items", 0),
      s.db.query({ table: record_link, returnType: "count", as: "linked" }), is("linked", 0),
    ],
  }),
  workflowTest({
    name: "tasks: a thread on a task is reached as the task is, and a reply reaches who it concerns on one grouped line",
    stack: [
      ...team,
      newTask("ada_token", "launch", "Talk it over", "talk", { assignee_id: ref("ben.id") }),
      read("ben_token", "talk", "before"), is("before.thread_id", 0),
      call(openThreadRoute, "cy_token", "cy_thread", { record_type: c.text("task"), record_id: ref("talk.id") }), notFound("cy_thread"),
      call(openThreadRoute, "ada_token", "thread", { record_type: c.text("task"), record_id: ref("talk.id") }),
      read("ben_token", "talk", "after"), equal("after.thread_id", ref("thread.id")),
      ...[1, 2, 3].map((n) => call(postMessageRoute, "ada_token", `said_${n}`, { id: ref("thread.id"), client_msg_id: c.text(`m${n}`), body: c.text(`note ${n}`) })),
      inbox("ben_token", "ben_inbox"),
      s.expect.to_be_true({ expr: withFilters(withFilters(ref("ben_inbox"), fl.json_encode()), fl.contains(c.text("\"kind\":\"reply\""))) }),
      seesText("ben_inbox", "\"group_count\":3"), seesText("ben_inbox", "Test ada replied"),
      s.array.filter({ expr: ref("ben_inbox.items"), if: expr(ref("$this.kind"), "=", c.text("reply")), as: "replies" }),
      count("replies", 1), seesText("replies", "/tasks/"), text("ben_inbox.records.0.title", "Talk it over"),
    ],
  }),
  workflowTest({
    name: "tasks: opening a task reads its inbox items, and only this person's",
    stack: [
      ...team,
      newTask("ada_token", "launch", "Read me", "readme", { assignee_id: ref("ben.id") }),
      read("ben_token", "readme", "seen"), is("seen.unread_items", 1),
      call(readTaskRoute, "ben_token", "marked", { id: ref("readme.id") }),
      read("ben_token", "readme", "seen_again"), is("seen_again.unread_items", 0),
      inbox("ben_token", "still_there"), count("still_there.items", 1),
      call(readTaskRoute, "cy_token", "cy_marks", { id: ref("readme.id") }), notFound("cy_marks"),
    ],
  }),
  workflowTest({
    name: "tasks: a deleted task reads Deleted, leaves the lists, can be restored, and keeps its links",
    stack: [
      ...team,
      newTask("ada_token", "launch", "Mistake", "oops"),
      call(addLink, "ada_token", "linked", { from_type: c.text("conversation"), from_id: ref("chat.id"), to_type: c.text("task"), to_id: ref("oops.id") }),
      call(deleteTaskRoute, "ben_token", "binned", { id: ref("oops.id") }),
      list("ada_token", "after", {}), count("after.items", 0), is("after.ever", 0),
      read("ada_token", "oops", "opened"), yes("opened.trashed"), no("opened.can_edit"),
      call(resolveLinks, "ada_token", "chip", { items: withFilters(c.array([]), fl.array_push(obj({ type: c.text("task"), id: ref("oops.id") }))) }),
      text("chip.0.state", "deleted"), yes("chip.0.can_restore"), text("chip.0.title", ""),
      move("ada_token", "oops", "done", "moved"), says("moved", "This task was deleted."),
      call(restoreTaskRoute, "ada_token", "back", { id: ref("oops.id") }), s.expect.to_be_null({ expr: ref("back.deleted_at") }),
      list("ada_token", "restored"), count("restored.items", 1),
      call(getLinks, "ada_token", "still", { type: c.text("task"), id: ref("oops.id") }), count("still.backlinks", 1),
    ],
  }),
  workflowTest({
    name: "tasks: a task in the trash over 30 days is purged with its thread and links, and a chip reads Deleted to everyone",
    stack: [
      ...team,
      newTask("ada_token", "launch", "Old", "old"), newTask("ada_token", "launch", "Recent", "recent"),
      call(openThreadRoute, "ada_token", "thread", { record_type: c.text("task"), record_id: ref("old.id") }),
      call(postMessageRoute, "ada_token", "said", { id: ref("thread.id"), client_msg_id: c.text("m1"), body: c.text("in the thread") }),
      call(addLink, "ada_token", "linked", { from_type: c.text("conversation"), from_id: ref("chat.id"), to_type: c.text("task"), to_id: ref("old.id") }),
      call(deleteTaskRoute, "ada_token", "binned", { id: ref("old.id") }), call(deleteTaskRoute, "ada_token", "binned_new", { id: ref("recent.id") }),
      s.db.patch({ table: task, fieldValue: ref("old.id"), data: obj({ deleted_at: withFilters(c.now(), fl.epochms_transform("-31 days")) }) }),
      s.function.call({ fn: purgeTasks, as: "purged", input: {} }), is("purged.purged", 1),
      s.db.query({ table: task, returnType: "count", as: "left" }), is("left", 1),
      s.db.query({ table: message, returnType: "count", as: "messages" }), is("messages", 0),
      s.db.query({ table: conversation, returnType: "count", as: "conversations" }), is("conversations", 1),
      s.db.query({ table: record_link, returnType: "count", as: "links" }), is("links", 0),
      call(resolveLinks, "cy_token", "chip", { items: withFilters(c.array([]), fl.array_push(obj({ type: c.text("task"), id: ref("old.id") }))) }), text("chip.0.state", "deleted"),
    ],
  }),
  workflowTest({
    name: "tasks: a project renames and archives, its tasks stay, and it leaves the default views",
    stack: [
      ...team,
      newTask("ada_token", "launch", "Stays", "stays"),
      call(updateProjectRoute, "ben_token", "renamed", { id: ref("launch.id"), name: c.text("Liftoff"), archived: c.bool(false) }), text("renamed.name", "Liftoff"),
      list("ben_token", "named"), text("named.items.0.project_name", "Liftoff"),
      newProject("ada_token", "a", "  ", "blank"), says("blank", "Name the project."),
      call(updateProjectRoute, "ben_token", "archived", { id: ref("launch.id"), name: c.text("Liftoff"), archived: c.bool(true) }),
      call(taskSetupRoute, "ben_token", "setup"), count("setup.projects", 0),
      list("ben_token", "hidden"), count("hidden.items", 0),
      list("ben_token", "by_project", { project_id: ref("launch.id") }), count("by_project.items", 1),
      newTask("ben_token", "launch", "Not here", "late"), says("late", "This project is archived."),
      read("ben_token", "stays", "reading"), text("reading.task.title", "Stays"),
      s.db.query({ table: project, returnType: "count", as: "projects" }), is("projects", 1),
    ],
  }),
  workflowTest({
    name: "tasks: every write lands on the space's channel in order, with ids and no text",
    stack: [
      ...team,
      s.set_var("channel_name", withFilters(c.text("spaces/"), fl.concat(ref("a.id")))),
      call(listChanges, "ada_token", "before", { channel: ref("channel_name"), after: c.int(-1) }),
      newTask("ada_token", "launch", "Private words", "made"), move("ada_token", "made", "in_review", "moved"),
      call(setPriorityRoute, "ada_token", "raised", { id: ref("made.id"), priority: c.text("high") }),
      call(listChanges, "ben_token", "after", { channel: ref("channel_name"), after: ref("before.seq") }),
      count("after.items", 3), text("after.items.0.entity", "task"), text("after.items.1.op", "moved"), equal("after.items.2.entity_id", ref("made.id")),
      missesText("after", "Private words"),
      call(listChanges, "cy_token", "cy_changes", { channel: ref("channel_name"), after: c.int(-1) }), notFound("cy_changes"),
    ],
  }),
];
