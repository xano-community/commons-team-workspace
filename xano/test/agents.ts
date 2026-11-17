// Workflow tests for connected agents and approvals. Each calls the functions the tools call, with the connection a key would bring.
// A real key over MCP, the trigger and the sign-in page need a live backend, so frontend/scripts/connected-check.mjs proves those.
import { c, cmp, col, fl, obj, ref, s, withFilters, workflowTest, type Value } from "@xano/sdk";
import { agent } from "../agent.js";
import { approvals } from "../approvals.js";
import { activity, notification, workspace_setting } from "../base/tables.js";
import { listActivity } from "../base/queries.js";
import { agentAsk, guestsRead } from "../agents/ask.js";
import { listAgentKeys, mintAgentKey, revokeAgentKey, rotateAgentKey } from "../agents/keys.js";
import { memberGate, MOST_CONNECTED_WRITES, writeGate } from "../agents/member-tool.js";
import { finishRun } from "../agents/runner.js";
import { afterDecisionFn, expireApprovals, rerouteApprovals, resumeMissed, suspendSponsorless, warnExpiringKeys } from "../agents/sweep.js";
import { planRequest, readRecord, reportProgress, saveCrmRecord, saveDoc, saveFile, saveTask, speak } from "../agents/tools.js";
import { approvalView, recordApprovals } from "../function/inbox/approvals.js";
import { connectionInbox } from "../function/inbox/read.js";
import { readHistory } from "../function/messaging/messages.js";
import { removeSpaceMember } from "../function/access/spaces.js";
import { getTaskRoute } from "../query/tasks.js";
import { postMessageRoute } from "../query/messages.js";
import { rbac } from "../rbac.js";
import { agentProfileRoute, agentRunsRoute, changeSponsorRoute, connectedAgentsRoute, createAgentRoute, listKeysRoute, mintKeyRoute, overseenApprovalsRoute, pickupsRoute, reviveAgentRoute, revokeKeyRoute, updateAgentRoute } from "../query/agents.js";
import { agent_run } from "../table/agents/agent_run.js";
import { company } from "../table/crm/company.js";
import { conversation as conversation_table } from "../table/messaging/conversation.js";
import { conversation_member } from "../table/messaging/conversation_member.js";
import { message } from "../table/messaging/message.js";
import { project as project_table } from "../table/tasks/project.js";
import { task } from "../table/tasks/task.js";
import { user } from "../table/user.js";
import { space as space_table } from "../table/spaces/space.js";
import { space_member } from "../table/spaces/space_member.js";
import { bearer, channel, dm, joined, makeSpace, missesText, person, personToken, rowsTest, seesText, settings } from "./access.js";

const relayRow = (key: string, sponsor: string, mode = "connected") => s.db.add({ table: user, as: key, row: {
  name: c.text(`Agent ${key}`), email: c.null(), password: c.null(), role: c.text("agent"), kind: c.text("agent"), agent_mode: c.text(mode), brief: c.text("Help out."), sponsor_id: ref(`${sponsor}.id`), status: c.text("active"), is_demo: c.bool(false),
} });
const keyOf = (who: string, as: string, name = "Laptop key") => s.db.add({ table: agent.agent_connection, as, row: { user_id: ref(`${who}.id`), name: c.text(name), kind: c.text("key"), scope: c.text("read_write"), revoked: c.bool(false), expires_at: withFilters(c.now(), fl.add(c.int(86400000))) } });
const projectIn = (key: string, spaceKey: string) => s.db.add({ table: project_table, as: key, row: { space_id: ref(`${spaceKey}.id`), name: c.text(`Project ${key}`), created_by: c.int(1), is_demo: c.bool(false) } });
const equal = (name: string, value: Value) => s.expect.to_equal({ expr: ref(name), value });
const is = (name: string, value: string) => equal(name, c.text(value));
const count = (name: string, n: number) => s.expect.to_equal({ expr: withFilters(ref(name), fl.count()), value: c.int(n) });

/**
 * Ada is a member who sponsors Relay, a connected agent. Amy is the only admin, and Cy another member. Team holds no guests, and
 * Client holds Riley, a guest. Private is one Relay is in and Ada isn't, and Outside one Relay isn't in.
 */
const team = [
  settings(), s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ agents_paused: c.bool(false) }) }),
  person("ada"), person("amy", "admin"), person("cy"), person("riley", "guest"), relayRow("relay", "ada"), keyOf("relay", "key"),
  makeSpace("team"), makeSpace("client"), makeSpace("hidden"), makeSpace("outside"),
  joined("team", "ada", "manager"), joined("team", "cy"), joined("team", "relay"),
  joined("client", "ada", "manager"), joined("client", "riley"), joined("client", "relay"),
  joined("hidden", "cy", "manager"), joined("hidden", "relay"),
  joined("outside", "cy", "manager"),
  channel("general", "team"), channel("room", "client"), channel("secret", "hidden"),
  projectIn("work", "team"), projectIn("shared", "client"), projectIn("private_work", "hidden"),
  personToken("ada", "ada_token"), personToken("amy", "amy_token"), personToken("cy", "cy_token"),
];
const as = (who = "relay", key = "key") => ({ actor_id: ref(`${who}.id`), run_id: c.int(0), connection_id: ref(`${key}.id`), approved_by: c.int(0), via: c.text("") });
const asker = (who = "relay", key = "key") => ({ actor_id: ref(`${who}.id`), run_id: c.int(0), connection_id: ref(`${key}.id`), via: c.text("") });
const taskInput = (project: string, title: string, o: Partial<{ who: string; key: string }> = {}) => ({
  ...as(o.who, o.key), id: c.int(0), project_id: ref(`${project}.id`), title: c.text(title), description: c.text(""), status: c.text(""), priority: c.text(""), due_on: c.text(""), assignee_id: c.int(0),
});
const say = (out: string, conversation: string, body: string, o: Partial<{ who: string; key: string; via: string }> = {}) => s.function.call({ fn: speak, as: out, input: { ...as(o.who, o.key), via: c.text(o.via ?? ""), conversation_id: ref(`${conversation}.id`), body: c.text(body) } });
const decide = (out: string, who: string, id: Value, decision: "approve" | "decline" = "approve", edited = "") => s.function.call({ fn: approvals.decide, as: out, input: { actor_id: ref(`${who}.id`), id, decision: c.text(decision), edited: c.text(edited) } });
const pendingFor = (out: string, token: string) => s.api.call({ api: approvals.list, headers: bearer(token), as: out, input: { view: c.text("pending"), page: c.int(1) } });
const view = (out: string, who: string, id: Value, browser = true) => s.function.call({ fn: approvalView, as: out, input: { actor_id: ref(`${who}.id`), browser: c.bool(browser), id } });
const row = (id: Value, out: string) => s.db.get({ table: approvals.approval, fieldValue: id, as: out });
/** Finds a member by test name, because `to_throw` runs in a stack of its own. */
const lookUp = (key: string) => s.db.query({ table: user, where: cmp(col("email"), "=", c.text(`${key}@access-test.example`)), returnType: "single", as: key });
const newestApproval = s.db.query({ table: approvals.approval, sort: [{ sortBy: "id", dir: "desc" }], returnType: "single", as: "asked_row" });
const refuses = (words: string, body: Parameters<typeof s.expect.to_throw>[0]["body"]) => s.expect.to_throw({ exception: c.text(words), body });
const writing = (who: string) => s.function.call({ fn: writeGate, as: "within_limit", input: { actor_id: ref(`${who}.id`) } });
const gate = (who: string, key: string, name = "Laptop key") => s.function.call({ fn: memberGate, as: "gated", input: { actor_id: ref(`${who}.id`), connection_id: ref(`${key}.id`), connection_name: c.text(name), run_id: c.int(0), attempt: c.int(0) } });

export const agentTests = [
  workflowTest({
    name: "connected: one function gives a record and its timeline, from an endpoint and from a tool",
    stack: [
      ...team,
      s.function.call({ fn: saveTask, as: "made", input: taskInput("work", "Check the redirects") }),
      s.api.call({ api: getTaskRoute, headers: bearer("ada_token"), as: "page", input: { id: ref("made.task_id") } }),
      s.api.call({ api: listActivity, headers: bearer("ada_token"), as: "feed", input: { entity: c.text("task"), entity_id: ref("made.task_id"), page: c.int(1), per_page: c.int(20) } }),
      s.function.call({ fn: readRecord, as: "read", input: { actor_id: ref("relay.id"), run_id: c.int(0), type: c.text("task"), id: ref("made.task_id") } }),
      equal("read.record.title", ref("page.task.title")),
      equal("read.record.status", ref("page.task.status")),
      equal("read.record.space_name", ref("page.space_name")),
      s.set_var("first_line", withFilters(ref("feed.items"), fl.first())),
      s.set_var("tool_line", withFilters(ref("read.timeline"), fl.first())),
      equal("tool_line.did", ref("first_line.title")),
      equal("tool_line.who", ref("first_line.actor_name")),
    ],
  }),
  rowsTest({
    name: "connected: an agent key writes a task where only the team can read, and the agent is the author",
    stack: [
      ...team,
      s.function.call({ fn: saveTask, as: "made", input: taskInput("work", "Send the brief") }),
      s.expect.to_be_true({ expr: withFilters(ref("made.task_id"), fl.to_bool()) }),
      equal("made.approval", c.null()),
      s.db.get({ table: task, fieldValue: ref("made.task_id"), as: "row" }),
      equal("row.created_by", ref("relay.id")),
      s.db.query({ table: activity, where: [cmp(col("entity"), "=", c.text("task")), cmp(col("entity_id"), "=", ref("made.task_id"))], returnType: "single", as: "line" }),
      equal("line.actor_id", ref("relay.id")),
    ],
  }),
  workflowTest({
    name: "approvals: guests are noticed through a space and through a DM, and only there",
    stack: [
      ...team,
      ...dm("with_riley", "ada", "riley"),
      ...dm("with_cy", "ada", "cy"),
      s.function.call({ fn: guestsRead, as: "in_team", input: { type: c.text("conversation"), id: ref("general.id") } }),
      s.function.call({ fn: guestsRead, as: "in_client", input: { type: c.text("conversation"), id: ref("room.id") } }),
      s.function.call({ fn: guestsRead, as: "in_project", input: { type: c.text("project"), id: ref("shared.id") } }),
      s.function.call({ fn: guestsRead, as: "dm_guest", input: { type: c.text("conversation"), id: ref("with_riley.id") } }),
      s.function.call({ fn: guestsRead, as: "dm_team", input: { type: c.text("conversation"), id: ref("with_cy.id") } }),
      s.expect.to_be_false({ expr: ref("in_team") }),
      s.expect.to_be_true({ expr: ref("in_client") }),
      s.expect.to_be_true({ expr: ref("in_project") }),
      s.expect.to_be_true({ expr: ref("dm_guest") }),
      s.expect.to_be_false({ expr: ref("dm_team") }),
    ],
  }),
  rowsTest({
    name: "approvals: save_task into a guest space waits, and nothing is written until a person says yes",
    stack: [
      ...team,
      s.function.call({ fn: saveTask, as: "made", input: taskInput("shared", "Share the timeline") }),
      equal("made.task_id", c.int(0)),
      is("made.approval.status", "pending"),
      s.db.query({ table: task, where: cmp(col("project_id"), "=", ref("shared.id")), returnType: "count", as: "none_yet" }),
      equal("none_yet", c.int(0)),
      decide("done", "ada", ref("made.approval.approval_id")),
      is("done.status", "approved"),
      s.db.query({ table: task, where: cmp(col("project_id"), "=", ref("shared.id")), returnType: "single", as: "row" }),
      is("row.title", "Share the timeline"),
      equal("row.created_by", ref("relay.id")),
    ],
  }),
  workflowTest({
    name: "approvals: every write tool asks first in a guest space",
    stack: [
      ...team,
      say("post", "room", "Hello from the agent"),
      is("post.approval.status", "pending"),
      s.function.call({ fn: saveDoc, as: "doc", input: { ...as(), id: c.int(0), space_id: ref("client.id"), title: c.text("Timeline"), find: c.text(""), text: c.text("Week one"), note: c.text("") } }),
      is("doc.approval.status", "pending"),
      s.function.call({ fn: saveFile, as: "file", input: { ...as(), name: c.text("plan.md"), content: c.text("# Plan"), space_id: ref("client.id"), link_type: c.text(""), link_id: c.int(0) } }),
      is("file.approval.status", "pending"),
      s.db.add({ table: company, as: "acme", row: { name: c.text("Acme"), created_by: ref("ada.id"), client_id: c.text("acme"), is_demo: c.bool(false) } }),
      s.function.call({ fn: saveCrmRecord, as: "linked", input: {
        ...as(), type: c.text("company"), id: ref("acme.id"), company_id: c.int(0), name: c.text(""), domain: c.text(""), industry: c.text(""), about: c.text(""), email: c.text(""), phone: c.text(""), job_title: c.text(""),
        stage: c.text(""), value: c.int(0), close_on: c.text(""), owner_id: c.int(0), note: c.text(""), link_type: c.text("conversation"), link_id: ref("room.id"),
      } }),
      is("linked.approval.status", "pending"),
      s.db.query({ table: message, where: cmp(col("conversation_id"), "=", ref("room.id")), returnType: "count", as: "posted" }),
      equal("posted", c.int(0)),
    ],
  }),
  rowsTest({
    name: "approvals: a sponsor-route request appears only for the sponsor, and a preview only to who decides",
    stack: [
      ...team,
      say("post", "room", "Only Ada should read this first"),
      s.set_var("id", ref("post.approval.approval_id")),
      pendingFor("for_ada", "ada_token"),
      pendingFor("for_amy", "amy_token"),
      pendingFor("for_cy", "cy_token"),
      count("for_ada.items", 1),
      count("for_amy.items", 0),
      count("for_cy.items", 0),
      s.db.query({ table: notification, where: [cmp(col("entity"), "=", c.text("approval")), cmp(col("entity_id"), "=", ref("id"))], as: "lines" }),
      count("lines", 1),
      s.set_var("line", withFilters(ref("lines"), fl.first())),
      equal("line.user_id", ref("ada.id")),
      equal("line.actor_id", ref("relay.id")),
      missesText("line", "Only Ada should"),
      view("card", "ada", ref("id")),
      s.expect.to_be_true({ expr: ref("card.can_decide") }),
      is("card.preview", "Only Ada should read this first"),
      is("card.agent_name", "Agent relay"),
      // Amy is an admin in a browser, so she reaches the room, and reads that it's waiting and nothing of what it says.
      view("line_only", "amy", ref("id")),
      s.expect.to_be_false({ expr: ref("line_only.can_decide") }),
      is("line_only.preview", ""),
      is("line_only.waiting_for", "Test ada"),
      refuses("Not found", [newestApproval, lookUp("cy"), view("out", "cy", ref("asked_row.id"))]),
      refuses("Not found", [newestApproval, lookUp("riley"), view("out", "riley", ref("asked_row.id"))]),
      refuses("No such approval", [newestApproval, lookUp("cy"), decide("out", "cy", ref("asked_row.id"))]),
    ],
  }),
  workflowTest({
    name: "approvals: a record shows the card to who decides, a line to the rest, and nothing to a guest",
    stack: [
      ...team,
      say("post", "room", "For the room"),
      s.function.call({ fn: recordApprovals, as: "for_ada", input: { actor_id: ref("ada.id"), browser: c.bool(true), type: c.text("conversation"), id: ref("room.id"), thread_id: c.int(0) } }),
      count("for_ada.items", 1),
      s.function.call({ fn: recordApprovals, as: "for_amy", input: { actor_id: ref("amy.id"), browser: c.bool(true), type: c.text("conversation"), id: ref("room.id"), thread_id: c.int(0) } }),
      missesText("for_amy", "For the room"),
      count("for_amy.items", 1),
      s.function.call({ fn: recordApprovals, as: "for_riley", input: { actor_id: ref("riley.id"), browser: c.bool(true), type: c.text("conversation"), id: ref("room.id"), thread_id: c.int(0) } }),
      count("for_riley.items", 0),
    ],
  }),
  workflowTest({
    name: "approvals: an admin sees what waits on someone else, read-only, and nothing in a DM",
    stack: [
      ...team,
      say("post", "room", "For the room, once Ada says so"),
      ...dm("with_ada", "relay", "ada", "riley"),
      s.function.call({ fn: speak, as: "dm_post", input: { ...as(), conversation_id: ref("with_ada.id"), body: c.text("Only for the DM") } }),
      s.api.call({ api: overseenApprovalsRoute, headers: bearer("amy_token"), as: "for_amy" }),
      // Amy sees the room's request whole, that Ada decides it, and no way to decide it herself.
      count("for_amy.items", 1),
      equal("for_amy.items.0.id", ref("post.approval.approval_id")),
      s.expect.to_be_false({ expr: ref("for_amy.items.0.can_decide") }),
      is("for_amy.items.0.waiting_for", "Test ada"),
      seesText("for_amy", "For the room, once Ada says so"),
      // The DM's request is Ada's too, and an admin never reads a DM.
      missesText("for_amy", "Only for the DM"),
      // Anyone who isn't an admin gets nothing, and Ada already has both in her own list.
      s.api.call({ api: overseenApprovalsRoute, headers: bearer("cy_token"), as: "for_cy" }), count("for_cy.items", 0),
      s.api.call({ api: overseenApprovalsRoute, headers: bearer("ada_token"), as: "for_ada" }), count("for_ada.items", 0),
    ],
  }),
  rowsTest({
    name: "approvals: a sponsor outside the space never sees the preview, and the admin route is used",
    stack: [
      ...team,
      joined("hidden", "riley"),
      say("post", "secret", "Ada isn't in this space"),
      s.set_var("id", ref("post.approval.approval_id")),
      row(ref("id"), "asked"),
      equal("asked.user_id", ref("relay.id")),
      is("asked.approver_roles", ",admin,"),
      pendingFor("for_ada", "ada_token"),
      count("for_ada.items", 0),
      pendingFor("for_amy", "amy_token"),
      count("for_amy.items", 1),
      refuses("Not found", [newestApproval, lookUp("ada"), view("out", "ada", ref("asked_row.id"))]),
      s.db.query({ table: notification, where: [cmp(col("entity"), "=", c.text("approval")), cmp(col("entity_id"), "=", ref("id"))], as: "lines" }),
      count("lines", 1),
      s.set_var("line", withFilters(ref("lines"), fl.first())),
      equal("line.user_id", ref("amy.id")),
    ],
  }),
  rowsTest({
    name: "approvals: a DM a sponsor isn't in has nobody who may decide, so it's refused",
    stack: [
      ...team,
      ...dm("with_riley", "relay", "riley"),
      refuses("nobody can approve", [
        s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }),
        s.db.query({ table: agent.agent_connection, returnType: "single", as: "key" }),
        s.db.query({ table: conversation_table, where: cmp(col("name"), "=", c.text("DM with_riley")), returnType: "single", as: "with_riley" }),
        say("out", "with_riley", "Hello"),
      ]),
    ],
  }),
  rowsTest({
    name: "approvals: a sole admin who is the sponsor decides an admin-route request",
    stack: [
      ...team,
      relayRow("own", "amy"),
      keyOf("own", "own_key"),
      joined("team", "own"),
      s.function.call({ fn: agentAsk, as: "asked", input: { ...asker("own", "own_key"), action: c.text("change_role"), title: c.text("Make Cy admin"), preview: c.text("They run the launch"), record_type: c.text(""), record_id: c.int(0), payload: obj({ id: ref("cy.id"), role: c.text("admin") }) } }),
      row(ref("asked.approval_id"), "asked_row"),
      equal("asked_row.user_id", ref("own.id")),
      is("asked_row.approver_roles", ",admin,"),
      decide("done", "amy", ref("asked.approval_id")),
      is("done.status", "approved"),
      s.db.get({ table: user, fieldValue: ref("cy.id"), output: ["role"], as: "now" }),
      is("now.role", "admin"),
    ],
  }),
  rowsTest({
    name: "approvals: an approved edit runs with the edited value, showing agent and approver",
    stack: [
      ...team,
      say("post", "room", "Draft words"),
      decide("done", "ada", ref("post.approval.approval_id"), "approve", "Final words"),
      s.db.query({ table: message, where: cmp(col("conversation_id"), "=", ref("room.id")), returnType: "single", as: "posted" }),
      is("posted.body", "Final words"),
      equal("posted.author_id", ref("relay.id")),
      equal("posted.approved_by", ref("ada.id")),
      s.function.call({ fn: saveTask, as: "made", input: taskInput("shared", "Draft task") }),
      decide("saved", "ada", ref("made.approval.approval_id"), "approve", "Final task"),
      s.db.query({ table: task, where: cmp(col("project_id"), "=", ref("shared.id")), returnType: "single", as: "row" }),
      is("row.title", "Final task"),
      s.db.query({ table: activity, where: [cmp(col("entity"), "=", c.text("task")), cmp(col("entity_id"), "=", ref("row.id"))], returnType: "single", as: "line" }),
      equal("line.actor_id", ref("relay.id")),
      equal("line.approved_by", ref("ada.id")),
    ],
  }),
  rowsTest({
    name: "approvals: an agent removed from the space fails the approval, and the row stays pending",
    stack: [
      ...team,
      say("post", "room", "Still want this?"),
      s.db.del({ table: space_member, fieldValue: ref("relay_in_client.id") }),
      refuses("can't reach this any more", [newestApproval, lookUp("ada"), decide("out", "ada", ref("asked_row.id"))]),
      row(ref("post.approval.approval_id"), "still"),
      is("still.status", "pending"),
      s.db.query({ table: message, where: cmp(col("conversation_id"), "=", ref("room.id")), returnType: "count", as: "posted" }),
      equal("posted", c.int(0)),
      decide("declined", "ada", ref("post.approval.approval_id"), "decline"),
      is("declined.status", "declined"),
    ],
  }),
  rowsTest({
    name: "approvals: a person who left can't approve, and an agent can't either",
    stack: [
      ...team,
      say("post", "room", "One more"),
      s.db.patch({ table: user, fieldValue: ref("ada.id"), data: obj({ role: c.text("guest") }) }),
      refuses("Only a person on the team", [newestApproval, lookUp("ada"), decide("out", "ada", ref("asked_row.id"))]),
      s.db.patch({ table: user, fieldValue: ref("ada.id"), data: obj({ kind: c.text("agent"), role: c.text("agent") }) }),
      refuses("Only a person on the team", [newestApproval, lookUp("ada"), decide("out", "ada", ref("asked_row.id"))]),
    ],
  }),
  rowsTest({
    name: "approvals: request_action checks what it's asked, and asks nothing it can't support",
    stack: [
      ...team,
      refuses("Say why", [lookUp("ada"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), s.function.call({ fn: planRequest, as: "out", input: { actor_id: ref("relay.id"), run_id: c.int(0), action: c.text("delete_record"), type: c.text("task"), id: c.int(1), reason: c.text(" ") } })]),
      refuses("needs no approval", [s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), s.function.call({ fn: planRequest, as: "out", input: { actor_id: ref("relay.id"), run_id: c.int(0), action: c.text("bulk_change"), ids: c.array([1, 2]), status: c.text("done"), reason: c.text("Tidying up") } })]),
      refuses("Guests can read", [
        s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }),
        s.db.query({ table: space_table, where: cmp(col("name"), "=", c.text("Space client")), returnType: "single", as: "client" }),
        s.function.call({ fn: planRequest, as: "out", input: { actor_id: ref("relay.id"), run_id: c.int(0), action: c.text("export_crm"), space_id: ref("client.id"), reason: c.text("For the board") } }),
      ]),
      s.function.call({ fn: planRequest, as: "plan", input: { actor_id: ref("relay.id"), run_id: c.int(0), action: c.text("grant_space_access"), space_id: ref("outside.id"), reason: c.text("Cy asked me to help there") } }),
      is("plan.title", "Join a space"),
    ],
  }),
  rowsTest({
    name: "approvals: a delete waits for the sponsor and then goes to the trash as the agent's",
    stack: [
      ...team,
      s.function.call({ fn: saveTask, as: "made", input: taskInput("work", "Old task") }),
      s.function.call({ fn: planRequest, as: "plan", input: { actor_id: ref("relay.id"), run_id: c.int(0), action: c.text("delete_record"), type: c.text("task"), id: ref("made.task_id"), reason: c.text("It's a duplicate") } }),
      s.function.call({ fn: agentAsk, as: "asked", input: { ...asker(), action: c.text("delete_record"), title: ref("plan.title"), preview: c.text("It's a duplicate"), record_type: ref("plan.record_type"), record_id: ref("plan.record_id"), payload: ref("plan.payload") } }),
      s.db.get({ table: task, fieldValue: ref("made.task_id"), output: ["deleted_at"], as: "before" }),
      equal("before.deleted_at", c.null()),
      decide("done", "ada", ref("asked.approval_id")),
      s.db.get({ table: task, fieldValue: ref("made.task_id"), output: ["deleted_at"], as: "after" }),
      s.expect.to_not_equal({ expr: ref("after.deleted_at"), value: c.null() }),
      s.db.query({ table: activity, where: [cmp(col("entity"), "=", c.text("task")), cmp(col("verb"), "=", c.text("deleted"))], returnType: "single", as: "line" }),
      equal("line.actor_id", ref("relay.id")),
      equal("line.approved_by", ref("ada.id")),
    ],
  }),
  rowsTest({
    name: "connected: a key's owner, a person, reaches only joined spaces and CRM with crm.read, and acts through the app",
    stack: [
      ...team,
      keyOf("amy", "amy_key", "ChatGPT"),
      joined("team", "amy"),
      s.db.add({ table: company, as: "acme", row: { name: c.text("Acme"), created_by: ref("ada.id"), client_id: c.text("acme"), is_demo: c.bool(false) } }),
      // In a browser Amy oversees every space. Through her connection she reaches only the one she joined.
      refuses("Not found", [
        s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Test amy")), returnType: "single", as: "amy" }),
        s.db.query({ table: conversation_table, where: cmp(col("name"), "=", c.text("Channel secret")), returnType: "single", as: "secret" }),
        s.function.call({ fn: readRecord, as: "out", input: { actor_id: ref("amy.id"), run_id: c.int(0), type: c.text("conversation"), id: ref("secret.id") } }),
      ]),
      s.function.call({ fn: readRecord, as: "customer", input: { actor_id: ref("amy.id"), run_id: c.int(0), type: c.text("company"), id: ref("acme.id") } }),
      is("customer.record.name", "Acme"),
      gate("amy", "amy_key", "ChatGPT"),
      is("gated.via", "ChatGPT"),
      say("post", "general", "Morning all", { who: "amy", key: "amy_key", via: "ChatGPT" }),
      s.db.get({ table: message, fieldValue: ref("post.message_id"), as: "posted" }),
      equal("posted.author_id", ref("amy.id")),
      is("posted.via", "ChatGPT"),
    ],
  }),
  rowsTest({
    name: "connected: a person's client asks that person, on the module's own path",
    stack: [
      ...team,
      keyOf("ada", "ada_key", "ChatGPT"),
      say("post", "room", "From Ada's client", { who: "ada", key: "ada_key", via: "ChatGPT" }),
      row(ref("post.approval.approval_id"), "asked"),
      equal("asked.user_id", ref("ada.id")),
      is("asked.approver_roles", ""),
      is("asked.agent_label", "ChatGPT"),
      s.db.query({ table: notification, where: [cmp(col("entity"), "=", c.text("approval")), cmp(col("entity_id"), "=", ref("asked.id"))], returnType: "single", as: "line" }),
      equal("line.user_id", ref("ada.id")),
      decide("done", "ada", ref("asked.id")),
      s.db.query({ table: message, where: cmp(col("conversation_id"), "=", ref("room.id")), returnType: "single", as: "posted" }),
      equal("posted.author_id", ref("ada.id")),
    ],
  }),
  rowsTest({
    name: "connected: a guest can't reach through a connection, and a sponsor who became a guest stops their agent",
    stack: [
      ...team,
      keyOf("riley", "riley_key"),
      refuses("Guests can't connect", [lookUp("riley"), s.db.query({ table: agent.agent_connection, where: cmp(col("user_id"), "=", ref("riley.id")), returnType: "single", as: "riley_key" }), gate("riley", "riley_key")]),
      s.db.patch({ table: user, fieldValue: ref("ada.id"), data: obj({ role: c.text("guest") }) }),
      refuses("can't sponsor", [
        s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }),
        s.db.query({ table: agent.agent_connection, where: cmp(col("user_id"), "=", ref("relay.id")), returnType: "single", as: "key" }),
        gate("relay", "key"),
      ]),
    ],
  }),
  rowsTest({
    name: "connected: if a row with kind agent ever holds another role, its tools refuse",
    stack: [
      ...team,
      gate("relay", "key"),
      s.db.patch({ table: user, fieldValue: ref("relay.id"), data: obj({ role: c.text("admin") }) }),
      refuses("only with the agent role", [
        s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }),
        s.db.query({ table: agent.agent_connection, where: cmp(col("user_id"), "=", ref("relay.id")), returnType: "single", as: "key" }),
        gate("relay", "key"),
      ]),
    ],
  }),
  rowsTest({
    name: "connected: a key can write 60 times in 5 minutes, then waits, and its sponsor hears once",
    stack: [
      ...team,
      s.foreach({ list: c.array(Array.from({ length: MOST_CONNECTED_WRITES }, (_, i) => i)), as: "n", body: [
        s.db.add({ table: agent.agent_activity, as: "written", row: { connection_id: ref("key.id"), user_id: ref("relay.id"), tool: c.text("save_task"), outcome: c.text("ok") } }),
      ] }),
      gate("relay", "key"),
      refuses("the most a connection can make", [
        s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }),
        writing("relay"),
      ]),
      refuses("the most a connection can make", [
        s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }),
        writing("relay"),
      ]),
      s.db.query({ table: notification, where: [cmp(col("user_id"), "=", ref("ada.id")), cmp(col("kind"), "=", c.text("agent_limit"))], as: "told" }),
      count("told", 1),
    ],
  }),
  rowsTest({
    name: "connected: pausing agents stops a connected agent's writes and not its reads",
    stack: [
      ...team,
      s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ agents_paused: c.bool(true) }) }),
      gate("relay", "key"),
      refuses("Agents are paused", [
        s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }),
        writing("relay"),
      ]),
    ],
  }),
  workflowTest({
    name: "connected: my_inbox gives work oldest first, a cursor moves past it, and a decision arrives there",
    stack: [
      ...team,
      s.function.call({ fn: speak, as: "first", input: { ...as("ada", "key"), conversation_id: ref("general.id"), body: withFilters(c.text("<@"), fl.concat(ref("relay.id")), fl.concat(c.text("> first ask"))) } }),
      s.function.call({ fn: speak, as: "second", input: { ...as("cy", "key"), conversation_id: ref("general.id"), body: withFilters(c.text("<@"), fl.concat(ref("relay.id")), fl.concat(c.text("> second ask"))) } }),
      s.function.call({ fn: connectionInbox, as: "inbox", input: { actor_id: ref("relay.id"), run_id: c.int(0), after: c.int(0) } }),
      count("inbox.items", 2),
      s.set_var("oldest", withFilters(ref("inbox.items"), fl.first())),
      is("oldest.kind", "mention"),
      is("oldest.actor_name", "Test ada"),
      s.function.call({ fn: connectionInbox, as: "again", input: { actor_id: ref("relay.id"), run_id: c.int(0), after: ref("inbox.next_after") } }),
      count("again.items", 0),
      say("post", "room", "Ask first"),
      decide("done", "ada", ref("post.approval.approval_id"), "decline"),
      s.function.call({ fn: afterDecisionFn, as: "told", input: { approval_id: ref("post.approval.approval_id") } }),
      s.function.call({ fn: connectionInbox, as: "decided", input: { actor_id: ref("relay.id"), run_id: c.int(0), after: ref("inbox.next_after") } }),
      count("decided.items", 1),
      s.set_var("line", withFilters(ref("decided.items"), fl.first())),
      is("line.kind", "approval_decided"),
      is("line.title", "Declined by Test ada: Post a message"),
      s.function.call({ fn: afterDecisionFn, as: "again_told", input: { approval_id: ref("post.approval.approval_id") } }),
      s.function.call({ fn: connectionInbox, as: "once", input: { actor_id: ref("relay.id"), run_id: c.int(0), after: ref("inbox.next_after") } }),
      count("once.items", 1),
    ],
  }),
  rowsTest({
    name: "keys: only an admin or the sponsor manages a connected agent's keys, and a hosted agent has none",
    stack: [
      ...team,
      relayRow("scout", "ada", "hosted"),
      s.function.call({ fn: mintAgentKey, as: "by_sponsor", input: { actor_id: ref("ada.id"), browser: c.bool(true), agent_id: ref("relay.id"), name: c.text("Morgan's laptop"), scope: c.text("read_write"), days: c.int(30) } }),
      s.expect.to_be_defined({ expr: ref("by_sponsor.token") }),
      equal("by_sponsor.key.user_id", ref("relay.id")),
      s.function.call({ fn: mintAgentKey, as: "by_admin", input: { actor_id: ref("amy.id"), browser: c.bool(true), agent_id: ref("relay.id"), name: c.text("Server"), scope: c.text("read"), days: c.int(30) } }),
      s.function.call({ fn: listAgentKeys, as: "keys", input: { actor_id: ref("amy.id"), browser: c.bool(true), agent_id: ref("relay.id") } }),
      count("keys.items", 3),
      missesText("keys", "token"),
      refuses("Only an admin or this agent's sponsor", [lookUp("cy"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), s.function.call({ fn: mintAgentKey, as: "out", input: { actor_id: ref("cy.id"), browser: c.bool(true), agent_id: ref("relay.id"), name: c.text("Mine"), scope: c.text("read"), days: c.int(30) } })]),
      refuses("Only an admin or this agent's sponsor", [lookUp("amy"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), s.function.call({ fn: mintAgentKey, as: "out", input: { actor_id: ref("amy.id"), browser: c.bool(false), agent_id: ref("relay.id"), name: c.text("Mine"), scope: c.text("read"), days: c.int(30) } })]),
      refuses("no key to hand out", [lookUp("amy"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent scout")), returnType: "single", as: "scout" }), s.function.call({ fn: mintAgentKey, as: "out", input: { actor_id: ref("amy.id"), browser: c.bool(true), agent_id: ref("scout.id"), name: c.text("Mine"), scope: c.text("read"), days: c.int(30) } })]),
    ],
  }),
  rowsTest({
    name: "keys: rotation moves what the old key asked for, and the old key stops",
    stack: [
      ...team,
      say("post", "room", "Asked on the old key"),
      s.function.call({ fn: rotateAgentKey, as: "rotated", input: { actor_id: ref("ada.id"), browser: c.bool(true), agent_id: ref("relay.id"), key_id: ref("key.id"), days: c.int(30) } }),
      equal("rotated.moved", c.int(1)),
      row(ref("post.approval.approval_id"), "asked"),
      equal("asked.connection_id", ref("rotated.key.id")),
      s.db.get({ table: agent.agent_connection, fieldValue: ref("key.id"), output: ["revoked"], as: "old" }),
      s.expect.to_be_true({ expr: ref("old.revoked") }),
      s.function.call({ fn: agent.checkKeyFn, as: "new_key", input: { connection_id: ref("rotated.key.id"), write: c.bool(true) } }),
      equal("new_key.conn.user_id", ref("relay.id")),
      s.function.call({ fn: revokeAgentKey, as: "gone", input: { actor_id: ref("amy.id"), browser: c.bool(true), agent_id: ref("relay.id"), key_id: ref("rotated.key.id") } }),
      refuses("revoked", [
        s.db.query({ table: agent.agent_connection, where: cmp(col("name"), "=", c.text("Laptop key")), sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: 1, metadata: false }, as: "latest" }),
        s.set_var("latest_key", withFilters(ref("latest"), fl.first())),
        s.function.call({ fn: agent.checkKeyFn, as: "out", input: { connection_id: ref("latest_key.id"), write: c.bool(false) } }),
      ]),
    ],
  }),
  rowsTest({
    name: "sweep: an approval whose sponsor left the space moves to the admins, and one in a DM closes",
    stack: [
      ...team,
      joined("hidden", "ada"),
      joined("hidden", "riley"),
      say("post", "secret", "While Ada's here"),
      row(ref("post.approval.approval_id"), "before"),
      equal("before.user_id", ref("ada.id")),
      s.function.call({ fn: removeSpaceMember, as: "left", input: { actor_id: ref("ada.id"), browser: c.bool(true), space_id: ref("hidden.id"), user_id: ref("ada.id") } }),
      row(ref("post.approval.approval_id"), "after"),
      equal("after.user_id", ref("relay.id")),
      is("after.approver_roles", ",admin,"),
      s.db.query({ table: notification, where: [cmp(col("entity"), "=", c.text("approval")), cmp(col("entity_id"), "=", ref("after.id")), cmp(col("user_id"), "=", ref("ada.id")), cmp(col("done_at"), "=", c.null())], returnType: "count", as: "still_with_ada" }),
      equal("still_with_ada", c.int(0)),
      s.db.query({ table: notification, where: [cmp(col("entity"), "=", c.text("approval")), cmp(col("entity_id"), "=", ref("after.id")), cmp(col("user_id"), "=", ref("amy.id"))], returnType: "count", as: "with_amy" }),
      equal("with_amy", c.int(1)),
      ...dm("with_ada", "relay", "ada", "riley"),
      s.function.call({ fn: speak, as: "dm_post", input: { ...as(), conversation_id: ref("with_ada.id"), body: c.text("In the DM") } }),
      s.db.query({ table: conversation_member, where: [cmp(col("conversation_id"), "=", ref("with_ada.id")), cmp(col("user_id"), "=", ref("ada.id"))], returnType: "single", as: "ada_in_dm" }),
      s.db.del({ table: conversation_member, fieldValue: ref("ada_in_dm.id") }),
      s.function.call({ fn: rerouteApprovals, as: "moved" }),
      row(ref("dm_post.approval.approval_id"), "closed"),
      is("closed.status", "expired"),
    ],
  }),
  rowsTest({
    name: "sweep: a new sponsor takes over what's waiting",
    stack: [
      ...team,
      joined("client", "cy"),
      say("post", "room", "Moves with the agent"),
      s.db.patch({ table: user, fieldValue: ref("relay.id"), data: obj({ sponsor_id: ref("cy.id") }) }),
      s.function.call({ fn: rerouteApprovals, as: "moved" }),
      row(ref("post.approval.approval_id"), "asked"),
      equal("asked.user_id", ref("cy.id")),
      s.db.query({ table: notification, where: [cmp(col("entity"), "=", c.text("approval")), cmp(col("user_id"), "=", ref("cy.id"))], returnType: "count", as: "with_cy" }),
      equal("with_cy", c.int(1)),
    ],
  }),
  rowsTest({
    name: "sweep: what nobody decided expires, leaves the inbox and reaches the agent",
    stack: [
      ...team,
      say("post", "room", "Nobody answers this"),
      s.db.patch({ table: approvals.approval, fieldValue: ref("post.approval.approval_id"), data: obj({ expires_at: c.int(1000) }) }),
      s.function.call({ fn: expireApprovals, as: "swept" }),
      equal("swept.expired", c.int(1)),
      row(ref("post.approval.approval_id"), "asked"),
      is("asked.status", "expired"),
      s.db.query({ table: notification, where: [cmp(col("entity"), "=", c.text("approval")), cmp(col("done_at"), "=", c.null())], returnType: "count", as: "open" }),
      equal("open", c.int(0)),
      s.db.query({ table: notification, where: [cmp(col("user_id"), "=", ref("relay.id")), cmp(col("kind"), "=", c.text("approval_decided"))], returnType: "single", as: "told" }),
      is("told.title", "Nobody decided in time: Post a message"),
    ],
  }),
  rowsTest({
    name: "sweep: an agent whose sponsor is gone stops, its keys end, and the admins hear once",
    stack: [
      ...team,
      s.db.patch({ table: user, fieldValue: ref("ada.id"), data: obj({ status: c.text("removed") }) }),
      s.function.call({ fn: suspendSponsorless, as: "swept" }),
      equal("swept.stopped", c.int(1)),
      s.function.call({ fn: suspendSponsorless, as: "again" }),
      equal("again.stopped", c.int(0)),
      s.db.get({ table: user, fieldValue: ref("relay.id"), output: ["status"], as: "now" }),
      is("now.status", "disabled"),
      s.db.get({ table: agent.agent_connection, fieldValue: ref("key.id"), output: ["revoked"], as: "line" }),
      s.expect.to_be_true({ expr: ref("line.revoked") }),
      s.db.query({ table: notification, where: [cmp(col("user_id"), "=", ref("amy.id")), cmp(col("kind"), "=", c.text("agent_stopped"))], returnType: "count", as: "told" }),
      equal("told", c.int(1)),
    ],
  }),
  workflowTest({
    name: "sweep: a sponsor hears once about a key that runs out within a week",
    stack: [
      ...team,
      s.function.call({ fn: warnExpiringKeys, as: "first" }),
      equal("first.warned", c.int(1)),
      s.function.call({ fn: warnExpiringKeys, as: "second" }),
      s.db.query({ table: notification, where: [cmp(col("user_id"), "=", ref("ada.id")), cmp(col("kind"), "=", c.text("agent_key"))], returnType: "count", as: "told" }),
      equal("told", c.int(1)),
    ],
  }),
  rowsTest({
    name: "runs: a hosted run in a guest space asks, waits, keeps its notes from guests, and starts again on the answer",
    stack: [
      ...team,
      s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ agents_paused: c.bool(true) }) }),
      relayRow("scout", "ada", "hosted"),
      joined("client", "scout"),
      keyOf("scout", "line", "system:hosted"),
      s.db.add({ table: agent_run, as: "run", row: {
        agent_id: ref("scout.id"), requested_by: ref("ada.id"), connection_id: ref("line.id"), status: c.text("working"), reason: c.text(""), source_type: c.text("message"), source_id: c.int(1), conversation_id: ref("room.id"), thread_id: ref("room.id"),
        space_id: ref("client.id"), dm_id: c.int(0), active_key: c.text("test-run"), attempt: c.int(1), started_at: c.now(), is_demo: c.bool(false),
      } }),
      s.function.call({ fn: reportProgress, as: "noted", input: { ...as("scout", "line"), run_id: ref("run.id"), conversation_id: c.int(0), note: c.text("Reading the client's thread."), state: c.text("working") } }),
      s.function.call({ fn: readHistory, as: "for_ada", input: { actor_id: ref("ada.id"), browser: c.bool(true), conversation_id: ref("room.id"), before_seq: c.int(0), after_seq: c.int(0), around_seq: c.int(0), after_version: c.int(0) } }),
      seesText("for_ada.items", "Reading the client"),
      s.function.call({ fn: readHistory, as: "for_riley", input: { actor_id: ref("riley.id"), browser: c.bool(true), conversation_id: ref("room.id"), before_seq: c.int(0), after_seq: c.int(0), around_seq: c.int(0), after_version: c.int(0) } }),
      missesText("for_riley.items", "Reading the client"),
      s.function.call({ fn: speak, as: "post", input: { ...as("scout", "line"), run_id: ref("run.id"), conversation_id: c.int(0), body: c.text("The launch moves to Tuesday.") } }),
      s.db.get({ table: agent_run, fieldValue: ref("run.id"), as: "paused" }),
      is("paused.status", "waiting"),
      equal("paused.waiting_on", ref("ada.id")),
      equal("paused.approval_id", ref("post.approval.approval_id")),
      refuses("waiting for a person's decision", [
        s.db.query({ table: agent_run, returnType: "single", as: "latest" }),
        s.function.call({ fn: memberGate, as: "out", input: { actor_id: ref("latest.agent_id"), connection_id: ref("latest.connection_id"), connection_name: c.text("system:hosted"), run_id: ref("latest.id"), attempt: c.int(1) } }),
      ]),
      decide("done", "ada", ref("post.approval.approval_id")),
      s.db.get({ table: agent_run, fieldValue: ref("run.id"), as: "again" }),
      is("again.status", "queued"),
      // The turn that asked can still be finishing after a quick yes, and it says nothing about the turn that's next.
      s.db.patch({ table: agent_run, fieldValue: ref("run.id"), data: obj({ status: c.text("claimed") }) }),
      s.function.call({ fn: finishRun, as: "late", input: { run_id: ref("run.id"), attempt: c.int(1), error: c.text(""), steps: c.array([]), started_at: ref("paused.started_at") } }),
      s.db.get({ table: agent_run, fieldValue: ref("run.id"), as: "unmoved" }),
      is("unmoved.status", "claimed"),
      s.function.call({ fn: readHistory, as: "released", input: { actor_id: ref("riley.id"), browser: c.bool(true), conversation_id: ref("room.id"), before_seq: c.int(0), after_seq: c.int(0), around_seq: c.int(0), after_version: c.int(0) } }),
      seesText("released.items", "Reading the client"),
      seesText("released.items", "The launch moves to Tuesday."),
    ],
  }),
  rowsTest({
    name: "runs: a decline starts the run again, a sweep catches one the trigger missed, and a reply doesn't wake it",
    stack: [
      ...team,
      s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ agents_paused: c.bool(true) }) }),
      relayRow("scout", "ada", "hosted"),
      joined("client", "scout"),
      keyOf("scout", "line", "system:hosted"),
      s.db.add({ table: agent_run, as: "run", row: {
        agent_id: ref("scout.id"), requested_by: ref("ada.id"), connection_id: ref("line.id"), status: c.text("working"), reason: c.text(""), source_type: c.text("message"), source_id: c.int(1), conversation_id: ref("room.id"), thread_id: ref("room.id"),
        space_id: ref("client.id"), dm_id: c.int(0), active_key: c.text("test-run"), attempt: c.int(1), started_at: c.now(), is_demo: c.bool(false),
      } }),
      s.function.call({ fn: speak, as: "post", input: { ...as("scout", "line"), run_id: ref("run.id"), conversation_id: c.int(0), body: c.text("Shall I say so?") } }),
      decide("no", "ada", ref("post.approval.approval_id"), "decline"),
      s.db.get({ table: agent_run, fieldValue: ref("run.id"), as: "still" }),
      is("still.status", "waiting"),
      s.function.call({ fn: resumeMissed, as: "caught" }),
      s.db.get({ table: agent_run, fieldValue: ref("run.id"), as: "again" }),
      is("again.status", "queued"),
    ],
  }),
  rowsTest({
    name: "manage: an admin adds a connected agent, its key shows once, its page says it has one, and a revoked key stops at once",
    stack: [
      ...team,
      s.api.call({ api: createAgentRoute, headers: bearer("amy_token"), as: "made", input: { name: c.text("Courier"), mode: c.text("connected"), brief: c.text("Carries notes between the team and the client."), sponsor_id: ref("ada.id"), space_ids: withFilters(c.array([]), fl.array_push(ref("team.id"))), role: c.text("") } }),
      s.db.get({ table: user, fieldValue: ref("made.id"), as: "courier" }),
      is("courier.kind", "agent"), is("courier.role", "agent"), is("courier.agent_mode", "connected"), is("courier.status", "active"),
      equal("courier.sponsor_id", ref("ada.id")),
      s.db.query({ table: space_member, where: [cmp(col("user_id"), "=", ref("made.id")), cmp(col("space_id"), "=", ref("team.id"))], returnType: "count", as: "joined_team" }),
      equal("joined_team", c.int(1)),
      s.api.call({ api: agentProfileRoute, headers: bearer("ada_token"), as: "before_key", input: { agent_id: ref("made.id") } }),
      s.expect.to_be_false({ expr: ref("before_key.has_key") }),
      s.expect.to_be_true({ expr: ref("before_key.can_keys") }),
      s.expect.to_be_false({ expr: ref("before_key.can_manage") }),
      s.api.call({ api: mintKeyRoute, headers: bearer("ada_token"), as: "minted", input: { agent_id: ref("made.id"), name: c.text("Ada's laptop"), scope: c.text("read_write"), days: c.int(30) } }),
      s.expect.to_be_defined({ expr: ref("minted.token") }),
      s.api.call({ api: listKeysRoute, headers: bearer("amy_token"), as: "keys", input: { agent_id: ref("made.id") } }),
      count("keys.items", 1),
      missesText("keys", "token"),
      s.api.call({ api: agentProfileRoute, headers: bearer("amy_token"), as: "with_key", input: { agent_id: ref("made.id") } }),
      s.expect.to_be_true({ expr: ref("with_key.has_key") }),
      s.expect.to_be_true({ expr: ref("with_key.can_manage") }),
      s.function.call({ fn: agent.checkKeyFn, as: "works", input: { connection_id: ref("minted.key.id"), write: c.bool(true) } }),
      equal("works.conn.user_id", ref("made.id")),
      s.api.call({ api: revokeKeyRoute, headers: bearer("ada_token"), as: "gone", input: { agent_id: ref("made.id"), key_id: ref("minted.key.id") } }),
      refuses("revoked", [
        s.db.query({ table: agent.agent_connection, where: cmp(col("name"), "=", c.text("Ada's laptop")), returnType: "single", as: "laptop" }),
        s.function.call({ fn: agent.checkKeyFn, as: "out", input: { connection_id: ref("laptop.id"), write: c.bool(false) } }),
      ]),
    ],
  }),
  rowsTest({
    name: "manage: a member can't add an agent, change a brief or a sponsor, and a sponsor who's a member can't revive one",
    stack: [
      ...team,
      refuses("manage the team add or change agents", [lookUp("cy"), lookUp("ada"), personToken("cy", "t"), s.api.call({ api: createAgentRoute, headers: bearer("t"), as: "out", input: { name: c.text("Mine"), mode: c.text("hosted"), brief: c.text("Help."), sponsor_id: ref("cy.id"), space_ids: c.array([]), role: c.text("") } })]),
      refuses("manage the team add or change agents", [lookUp("ada"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), personToken("ada", "t"), s.api.call({ api: updateAgentRoute, headers: bearer("t"), as: "out", input: { agent_id: ref("relay.id"), brief: c.text("Do anything."), mode: c.text(""), role: c.text("") } })]),
      refuses("manage the team add or change agents", [lookUp("ada"), lookUp("cy"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), personToken("ada", "t"), s.api.call({ api: changeSponsorRoute, headers: bearer("t"), as: "out", input: { agent_id: ref("relay.id"), sponsor_id: ref("cy.id") } })]),
      s.db.patch({ table: user, fieldValue: ref("relay.id"), data: obj({ status: c.text("disabled") }) }),
      refuses("manage the team add or change agents", [lookUp("ada"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), personToken("ada", "t"), s.api.call({ api: reviveAgentRoute, headers: bearer("t"), as: "out", input: { agent_id: ref("relay.id"), sponsor_id: ref("ada.id") } })]),
      s.db.get({ table: user, fieldValue: ref("relay.id"), as: "still" }),
      is("still.status", "disabled"), is("still.brief", "Help out."), equal("still.sponsor_id", ref("ada.id")),
    ],
  }),
  rowsTest({
    name: "manage: a demo session can't add an agent, change a brief or a sponsor, or revive one, even as an admin",
    stack: [
      ...team,
      s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ demo_mode: c.bool(true) }) }),
      s.db.patch({ table: user, fieldValue: ref("amy.id"), data: obj({ is_demo: c.bool(true) }) }),
      refuses("demo session", [lookUp("amy"), personToken("amy", "t"), s.api.call({ api: createAgentRoute, headers: bearer("t"), as: "out", input: { name: c.text("Mine"), mode: c.text("hosted"), brief: c.text("Help."), sponsor_id: ref("amy.id"), space_ids: c.array([]), role: c.text("") } })]),
      refuses("demo session", [lookUp("amy"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), personToken("amy", "t"), s.api.call({ api: updateAgentRoute, headers: bearer("t"), as: "out", input: { agent_id: ref("relay.id"), brief: c.text("Do anything."), mode: c.text(""), role: c.text("") } })]),
      refuses("demo session", [lookUp("amy"), lookUp("cy"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), personToken("amy", "t"), s.api.call({ api: changeSponsorRoute, headers: bearer("t"), as: "out", input: { agent_id: ref("relay.id"), sponsor_id: ref("cy.id") } })]),
      s.db.patch({ table: user, fieldValue: ref("relay.id"), data: obj({ status: c.text("disabled") }) }),
      refuses("demo session", [lookUp("amy"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), personToken("amy", "t"), s.api.call({ api: reviveAgentRoute, headers: bearer("t"), as: "out", input: { agent_id: ref("relay.id"), sponsor_id: ref("amy.id") } })]),
      s.db.query({ table: user, where: cmp(col("kind"), "=", c.text("agent")), returnType: "count", as: "agents" }),
      equal("agents", c.int(1)),
    ],
  }),
  rowsTest({
    name: "manage: no route makes an agent anything but an agent, so none can give it team.manage",
    stack: [
      ...team,
      refuses("never manage the team", [lookUp("amy"), personToken("amy", "t"), s.api.call({ api: createAgentRoute, headers: bearer("t"), as: "out", input: { name: c.text("Boss"), mode: c.text("hosted"), brief: c.text("Run things."), sponsor_id: ref("amy.id"), space_ids: c.array([]), role: c.text("admin") } })]),
      refuses("never manage the team", [lookUp("amy"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), personToken("amy", "t"), s.api.call({ api: updateAgentRoute, headers: bearer("t"), as: "out", input: { agent_id: ref("relay.id"), brief: c.text(""), mode: c.text(""), role: c.text("admin") } })]),
      refuses("can't hold that role", [lookUp("amy"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), personToken("amy", "t"), s.api.call({ api: rbac.endpoints.setRole, headers: bearer("t"), as: "out", input: { id: ref("relay.id"), role: c.text("admin") } })]),
      s.db.get({ table: user, fieldValue: ref("relay.id"), as: "after" }),
      is("after.role", "agent"),
      s.db.query({ table: user, where: [cmp(col("kind"), "=", c.text("agent")), cmp(col("role"), "!=", c.text("agent"))], returnType: "count", as: "odd" }),
      equal("odd", c.int(0)),
    ],
  }),
  rowsTest({
    name: "manage: a guest can't be named sponsor when adding, handing over or reviving an agent",
    stack: [
      ...team,
      refuses("A guest can't sponsor an agent", [lookUp("amy"), lookUp("riley"), personToken("amy", "t"), s.api.call({ api: createAgentRoute, headers: bearer("t"), as: "out", input: { name: c.text("Helper"), mode: c.text("connected"), brief: c.text(""), sponsor_id: ref("riley.id"), space_ids: c.array([]), role: c.text("") } })]),
      refuses("A guest can't sponsor an agent", [lookUp("amy"), lookUp("riley"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), personToken("amy", "t"), s.api.call({ api: changeSponsorRoute, headers: bearer("t"), as: "out", input: { agent_id: ref("relay.id"), sponsor_id: ref("riley.id") } })]),
      s.db.patch({ table: user, fieldValue: ref("relay.id"), data: obj({ status: c.text("disabled") }) }),
      refuses("A guest can't sponsor an agent", [lookUp("amy"), lookUp("riley"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), personToken("amy", "t"), s.api.call({ api: reviveAgentRoute, headers: bearer("t"), as: "out", input: { agent_id: ref("relay.id"), sponsor_id: ref("riley.id") } })]),
      s.api.call({ api: reviveAgentRoute, headers: bearer("amy_token"), as: "back", input: { agent_id: ref("relay.id"), sponsor_id: ref("cy.id") } }),
      s.db.get({ table: user, fieldValue: ref("relay.id"), as: "revived" }),
      is("revived.status", "active"), equal("revived.sponsor_id", ref("cy.id")),
    ],
  }),
  rowsTest({
    name: "sponsor: handing an agent over ends its keys, moves what's waiting to the new sponsor, and leaves its history as it was",
    stack: [
      ...team,
      joined("client", "cy"),
      say("post", "room", "Asked before the hand-over"),
      row(ref("post.approval.approval_id"), "asked"),
      equal("asked.user_id", ref("ada.id")),
      s.db.query({ table: activity, where: cmp(col("actor_id"), "=", ref("relay.id")), returnType: "count", as: "lines_before" }),
      s.db.query({ table: message, where: cmp(col("author_id"), "=", ref("relay.id")), returnType: "count", as: "said_before" }),
      s.api.call({ api: changeSponsorRoute, headers: bearer("amy_token"), as: "moved", input: { agent_id: ref("relay.id"), sponsor_id: ref("cy.id") } }),
      equal("moved.revoked", c.int(1)),
      s.db.get({ table: agent.agent_connection, fieldValue: ref("key.id"), output: ["revoked"], as: "old_key" }),
      s.expect.to_be_true({ expr: ref("old_key.revoked") }),
      row(ref("post.approval.approval_id"), "now"),
      is("now.status", "pending"),
      equal("now.user_id", ref("cy.id")),
      s.db.get({ table: user, fieldValue: ref("relay.id"), as: "handed" }),
      equal("handed.sponsor_id", ref("cy.id")),
      s.db.query({ table: activity, where: cmp(col("actor_id"), "=", ref("relay.id")), returnType: "count", as: "lines_after" }),
      s.db.query({ table: message, where: cmp(col("author_id"), "=", ref("relay.id")), returnType: "count", as: "said_after" }),
      equal("lines_after", ref("lines_before")),
      equal("said_after", ref("said_before")),
      refuses("already sponsor it", [lookUp("amy"), lookUp("cy"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), personToken("amy", "t"), s.api.call({ api: changeSponsorRoute, headers: bearer("t"), as: "out", input: { agent_id: ref("relay.id"), sponsor_id: ref("cy.id") } })]),
    ],
  }),
  rowsTest({
    name: "page: a guest is turned away from an agent's page and its runs by route, and the agent lists give a guest no brief",
    stack: [
      ...team,
      personToken("riley", "riley_token"),
      refuses("Guests don't have access", [lookUp("riley"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), personToken("riley", "t"), s.api.call({ api: agentProfileRoute, headers: bearer("t"), as: "out", input: { agent_id: ref("relay.id") } })]),
      refuses("Guests don't have access", [lookUp("riley"), s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent relay")), returnType: "single", as: "relay" }), personToken("riley", "t"), s.api.call({ api: agentRunsRoute, headers: bearer("t"), as: "out", input: { agent_id: ref("relay.id") } })]),
      s.api.call({ api: connectedAgentsRoute, headers: bearer("riley_token"), as: "for_guest" }),
      s.api.call({ api: connectedAgentsRoute, headers: bearer("ada_token"), as: "for_team" }),
      s.set_var("guest_row", withFilters(ref("for_guest.items"), fl.first())),
      s.set_var("team_row", withFilters(ref("for_team.items"), fl.first())),
      is("guest_row.brief", ""),
      is("team_row.brief", "Help out."),
      missesText("for_guest", "Help out."),
    ],
  }),
  rowsTest({
    name: "pickups: a mention waits for Relay, my_inbox stamps it picked up, and it stays picked up when Relay goes quiet",
    stack: [
      ...team,
      s.api.call({ api: postMessageRoute, headers: bearer("ada_token"), as: "asked", input: { id: ref("general.id"), client_msg_id: c.text("pickup-1"), body: withFilters(c.text("<@"), fl.concat(ref("relay.id")), fl.concat(c.text("> can you check the redirects?"))) } }),
      s.api.call({ api: pickupsRoute, headers: bearer("cy_token"), as: "waiting", input: { type: c.text("conversation"), id: ref("general.id") } }),
      count("waiting.items", 1),
      s.set_var("first_look", withFilters(ref("waiting.items"), fl.first())),
      equal("first_look.read_at", c.null()),
      equal("first_look.user_id", ref("relay.id")),
      s.function.call({ fn: connectionInbox, as: "inbox", input: { actor_id: ref("relay.id"), run_id: c.int(0), after: c.int(0) } }),
      // What the module's tool wrapper logs for every successful call. frontend/scripts/agent-check.mjs proves it over a real key.
      s.db.add({ table: agent.agent_activity, as: "looked", row: { connection_id: ref("key.id"), user_id: ref("relay.id"), tool: c.text("my_inbox"), outcome: c.text("ok"), detail: c.text("") } }),
      s.api.call({ api: pickupsRoute, headers: bearer("cy_token"), as: "picked", input: { type: c.text("conversation"), id: ref("general.id") } }),
      s.set_var("second_look", withFilters(ref("picked.items"), fl.first())),
      s.expect.to_not_be_null({ expr: ref("second_look.read_at") }),
      // Relay goes quiet: its key ends and nobody calls again. What it picked up stays picked up.
      s.db.patch({ table: agent.agent_connection, fieldValue: ref("key.id"), data: obj({ revoked: c.bool(true) }) }),
      s.api.call({ api: pickupsRoute, headers: bearer("cy_token"), as: "later", input: { type: c.text("conversation"), id: ref("general.id") } }),
      s.set_var("third_look", withFilters(ref("later.items"), fl.first())),
      equal("third_look.read_at", ref("second_look.read_at")),
      // A later mention isn't picked up by a look that came before it.
      s.api.call({ api: postMessageRoute, headers: bearer("ada_token"), as: "again", input: { id: ref("general.id"), client_msg_id: c.text("pickup-2"), body: withFilters(c.text("<@"), fl.concat(ref("relay.id")), fl.concat(c.text("> and the sitemap?"))) } }),
      s.api.call({ api: pickupsRoute, headers: bearer("cy_token"), as: "newer", input: { type: c.text("conversation"), id: ref("general.id") } }),
      s.set_var("newest", withFilters(ref("newer.items"), fl.first())),
      equal("newest.seq", ref("again.message.seq")),
      equal("newest.read_at", c.null()),
      refuses("Not found", [lookUp("riley"), s.db.query({ table: conversation_table, where: cmp(col("name"), "=", c.text("Channel general")), returnType: "single", as: "general" }), personToken("riley", "t"), s.api.call({ api: pickupsRoute, headers: bearer("t"), as: "out", input: { type: c.text("conversation"), id: ref("general.id") } })]),
    ],
  }),
];
