// Workflow tests for the first minute and the way out of the demo (U22): the sample run, Clear demo data, first-admin setup's
// pipeline and the guest's missing assistant. A test run starts with an empty database, so each test makes the rows it needs, and
// the seeded world itself is checked by xano/world.test.ts and, on a live backend, frontend/scripts/first-run-check.mjs.
import { c, cmp, col, fl, obj, ref, s, withFilters, workflowTest, type Value } from "@xano/sdk";
import { approvals } from "../approvals.js";
import { activity, notification, workspace_setting } from "../base/tables.js";
import { docs, docTable } from "../docs.js";
import { agentAsk } from "../agents/ask.js";
import { drainRuns, retryRun, stopRun } from "../agents/runner.js";
import { afterDecisionFn } from "../agents/sweep.js";
import { clearDemo } from "../function/members/clear_demo.js";
import { runSetup } from "../function/members/setup.js";
import { listLinks } from "../function/links/links.js";
import { findRecords } from "../function/search/search.js";
import { auth_me } from "../query/authentication/auth_me_GET.js";
import { clearDemoPreview, clearDemoRoute } from "../query/members.js";
import { createCompanyRoute, createDealRoute, setDealStageRoute } from "../query/crm.js";
import { getTaskRoute } from "../query/tasks.js";
import { agent_run } from "../table/agents/agent_run.js";
import { company } from "../table/crm/company.js";
import { contact } from "../table/crm/contact.js";
import { deal } from "../table/crm/deal.js";
import { pipeline_stage } from "../table/crm/pipeline_stage.js";
import { file_blob } from "../table/files/file_blob.js";
import { file_record } from "../table/files/file_record.js";
import { record_link } from "../table/links/record_link.js";
import { conversation } from "../table/messaging/conversation.js";
import { message } from "../table/messaging/message.js";
import { search_entry } from "../table/search/search_entry.js";
import { space } from "../table/spaces/space.js";
import { space_member } from "../table/spaces/space_member.js";
import { project } from "../table/tasks/project.js";
import { task } from "../table/tasks/task.js";
import { user } from "../table/user.js";
import { bearer, channel, joined, makeSpace, person, personToken, rowsTest, seesText, settings } from "./access.js";

type Api = Parameters<typeof s.api.call>[0]["api"];
const equal = (name: string, value: Value) => s.expect.to_equal({ expr: ref(name), value });
const is = (name: string, n: number) => equal(name, c.int(n));
const text = (name: string, value: string) => equal(name, c.text(value));
const says = (name: string, words: string) => s.expect.to_contain({ expr: ref(`${name}.message`), value: c.text(words) });
const rows = (table: Parameters<typeof s.db.query>[0]["table"], as: string, where?: Parameters<typeof s.db.query>[0]["where"]) => s.db.query({ table, where, returnType: "count", as });
const demoMode = s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ demo_mode: c.bool(true), signup_open: c.bool(true) }) });

const PROPOSAL = "Hi Riley, the size guide sits under the photos now.";
const EDITED = "Hi Riley, the size guide sits right under the photos now.";

/**
 * Morgan asked Scout for a reply to Riley, a guest in the client room, and Scout's draft waits for her: the demo's sample run, made
 * through the same door a real run's request takes.
 */
const sampleWorld = [
  settings(), demoMode,
  person("morgan"), person("riley", "guest"),
  s.db.add({ table: user, as: "scout", row: {
    name: c.text("Scout"), email: c.null(), password: c.null(), role: c.text("agent"), kind: c.text("agent"), agent_mode: c.text("hosted"), brief: c.text("Help out."), sponsor_id: ref("morgan.id"), status: c.text("active"), is_demo: c.bool(false),
  } }),
  makeSpace("client"), joined("client", "morgan", "manager"), joined("client", "riley"), joined("client", "scout"),
  channel("room", "client"),
  s.db.add({ table: message, as: "ask", row: { conversation_id: ref("room.id"), seq: c.int(1), version: c.int(1), client_msg_id: c.text("seed-ask"), author_id: ref("morgan.id"), body: c.text("Can you draft a reply for Riley?"), is_demo: c.bool(false) } }),
  s.db.add({ table: conversation, as: "thread", row: { space_id: ref("client.id"), kind: c.text("thread"), name: c.text("Thread"), created_by: ref("scout.id"), record_type: c.text("message"), record_id: ref("ask.id"), parent_id: ref("room.id"), is_demo: c.bool(false) } }),
  s.db.add({ table: agent_run, as: "run", row: {
    agent_id: ref("scout.id"), requested_by: ref("morgan.id"), status: c.text("working"), source_type: c.text("message"), source_id: ref("ask.id"), conversation_id: ref("room.id"), thread_id: ref("thread.id"),
    space_id: ref("client.id"), attempt: c.int(1), sample: c.bool(true), is_demo: c.bool(true),
  } }),
  s.function.call({ fn: agentAsk, as: "asked", input: {
    actor_id: ref("scout.id"), connection_id: c.int(0), run_id: ref("run.id"), action: c.text("send_external"), title: c.text("Post a message"), preview: c.text(PROPOSAL),
    record_type: c.text("conversation"), record_id: ref("thread.id"), payload: obj({ conversation_id: ref("thread.id"), body: c.text(PROPOSAL) }), via: c.text(""),
  } }),
  s.db.get({ table: agent_run, fieldValue: ref("run.id"), as: "waiting" }),
  text("waiting.status", "waiting"),
];
const decide = (decision: "approve" | "decline", edited = "") => s.function.call({ fn: approvals.decide, as: "decided", input: { actor_id: ref("morgan.id"), id: ref("asked.approval_id"), decision: c.text(decision), edited: c.text(edited) } });
/** No model ran: the run was never claimed, never started, and holds no connection a model call would need. */
const noModelCall = [
  s.db.get({ table: agent_run, fieldValue: ref("run.id"), as: "ended" }),
  text("ended.status", "done"),
  s.expect.to_be_null({ expr: ref("ended.claimed_at") }),
  s.expect.to_be_null({ expr: ref("ended.started_at") }),
  is("ended.connection_id", 0),
  is("ended.attempt", 1),
  s.expect.to_be_null({ expr: ref("ended.active_key") }),
];
const threadPosts = (as: string) => s.db.query({ table: message, where: cmp(col("conversation_id"), "=", ref("thread.id")), as });

// ── Clear demo data ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const demoPerson = (key: string, role = "member") => s.db.add({ table: user, as: key, row: {
  name: c.text(`Demo ${key}`), email: c.text(`${key}@seed-test.example`), password: c.null(), role: c.text(role), kind: c.text("human"), status: c.text("active"), is_demo: c.bool(true),
} });
const demoSpace = (key: string) => s.db.add({ table: space, as: key, row: { name: c.text(`Demo ${key}`), visibility: c.text("private"), guests_can_create: c.bool(false), created_by: ref("morgan.id"), is_demo: c.bool(true) } });
const say = (key: string, conv: string, seq: number, who: string, body: string, demo: boolean) => s.db.add({ table: message, as: key, row: {
  conversation_id: ref(`${conv}.id`), seq: c.int(seq), version: c.int(seq), client_msg_id: c.text(`${key}-id`), author_id: ref(`${who}.id`), body: c.text(body), is_demo: c.bool(demo),
} });
const taskIn = (key: string, projectKey: string, spaceKey: string, who: string, title: string, demo: boolean, assignee: Value = c.int(0)) => s.db.add({ table: task, as: key, row: {
  project_id: ref(`${projectKey}.id`), space_id: ref(`${spaceKey}.id`), title: c.text(title), status: c.text("todo"), priority: c.text("none"), assignee_id: assignee, created_by: ref(`${who}.id`), rank: c.int(1), client_id: c.text(`${key}-id`), is_demo: c.bool(demo),
} });
const linkOf = (fromType: string, from: string, toType: string, to: string, spaceKey: string, by: string) => s.db.add({ table: record_link, row: {
  from_type: c.text(fromType), from_id: ref(`${from}.id`), to_type: c.text(toType), to_id: ref(`${to}.id`), origin: c.text("manual"), from_scope: withFilters(c.text("space-"), fl.concat(ref(`${spaceKey}.id`))), created_by: ref(`${by}.id`),
} });
const SECRET = "Demosecret";

/**
 * A demo company mid-way through, with a real admin, Bo, who has started using it: Bo's message sits in a demo channel, Bo's task in a
 * demo project, and Bo's deal with a demo company. Everything demo-owned should go, and everything of Bo's should stay.
 */
const demoWorld = [
  settings(), demoMode,
  person("bo", "admin"), person("cy"), demoPerson("avery", "admin"), demoPerson("morgan"),
  s.db.add({ table: user, as: "scout", row: { name: c.text("Scout"), email: c.null(), password: c.null(), role: c.text("agent"), kind: c.text("agent"), agent_mode: c.text("hosted"), sponsor_id: ref("morgan.id"), status: c.text("active"), is_demo: c.bool(true) } }),
  demoSpace("gone_space"), demoSpace("kept_space"),
  joined("gone_space", "morgan", "manager"), joined("kept_space", "morgan", "manager"), joined("gone_space", "bo"), joined("kept_space", "bo"),
  s.db.patch({ table: user, fieldValue: ref("bo.id"), data: obj({ space_ids: withFilters(c.array([]), fl.array_push(ref("gone_space.id")), fl.array_push(ref("kept_space.id"))) }) }),
  s.db.add({ table: conversation, as: "gone_chat", row: { space_id: ref("gone_space.id"), kind: c.text("channel"), name: c.text("demo-chat"), created_by: ref("morgan.id"), is_demo: c.bool(true) } }),
  s.db.add({ table: conversation, as: "kept_chat", row: { space_id: ref("kept_space.id"), kind: c.text("channel"), name: c.text("launch"), created_by: ref("morgan.id"), is_demo: c.bool(true) } }),
  say("demo_line", "gone_chat", 1, "morgan", `${SECRET} chat`, true), say("demo_reply", "kept_chat", 1, "morgan", "Seeded line", true),
  say("typed_by_demo", "kept_chat", 2, "morgan", "Typed during the demo", false), say("real_line", "kept_chat", 3, "bo", "Bo's own message", false),
  s.db.add({ table: project, as: "demo_project", row: { space_id: ref("kept_space.id"), name: c.text("Demo project"), created_by: ref("morgan.id"), is_demo: c.bool(true) } }),
  taskIn("demo_task", "demo_project", "kept_space", "morgan", `${SECRET} plan`, true), taskIn("real_task", "demo_project", "kept_space", "bo", "Real task by Bo", false, ref("scout.id")),
  linkOf("task", "real_task", "task", "demo_task", "kept_space", "bo"), linkOf("task", "demo_task", "task", "real_task", "kept_space", "morgan"),
  s.db.add({ table: docTable, as: "demo_doc", row: { owner_id: ref("morgan.id"), title: c.text(`${SECRET} brief`), body: c.obj({ type: "doc", content: [] }), text: c.text(""), visibility: c.text("team"), version: c.int(1), space_id: ref("kept_space.id"), is_demo: c.bool(true) } }),
  s.db.add({ table: file_record, as: "demo_file", row: { name: c.text("Demo.txt"), mime: c.text("text/plain"), size: c.int(4), kind: c.text("text"), safe_type: c.text("text/plain; charset=utf-8"), mode: c.text("table"), scope: withFilters(c.text("space-"), fl.concat(ref("kept_space.id"))), space_id: ref("kept_space.id"), uploaded_by: ref("morgan.id"), is_demo: c.bool(true) } }),
  s.db.add({ table: file_blob, row: { file_id: ref("demo_file.id"), b64: c.text("ZGVtbw==") } }),
  s.db.add({ table: pipeline_stage, as: "lead", row: { name: c.text("Lead"), kind: c.text("open"), rank: c.int(1), is_demo: c.bool(true) } }),
  s.db.add({ table: company, as: "gone_co", row: { name: c.text(`${SECRET} Cycles`), created_by: ref("morgan.id"), is_demo: c.bool(true) } }),
  s.db.add({ table: contact, row: { company_id: ref("gone_co.id"), name: c.text("Demo contact"), created_by: ref("morgan.id"), is_demo: c.bool(true) } }),
  s.db.add({ table: deal, row: { company_id: ref("gone_co.id"), title: c.text("Demo deal"), stage_id: ref("lead.id"), created_by: ref("morgan.id"), rank: c.int(1), is_demo: c.bool(true) } }),
  s.db.add({ table: company, as: "kept_co", row: { name: c.text("Fenwick"), created_by: ref("morgan.id"), is_demo: c.bool(true) } }),
  s.db.add({ table: deal, row: { company_id: ref("kept_co.id"), title: c.text("Bo's deal"), stage_id: ref("lead.id"), created_by: ref("bo.id"), rank: c.int(2), is_demo: c.bool(false) } }),
  s.db.add({ table: agent_run, as: "demo_run", row: { agent_id: ref("scout.id"), requested_by: ref("morgan.id"), status: c.text("done"), source_type: c.text("task"), source_id: ref("demo_task.id"), space_id: ref("kept_space.id"), is_demo: c.bool(true) } }),
  s.db.add({ table: approvals.approval, row: { user_id: ref("morgan.id"), source: c.text("mcp"), action: c.text("send_external"), title: c.text("Post a message"), status: c.text("pending"), payload: obj({ agent_id: ref("scout.id"), run_id: ref("demo_run.id") }) } }),
  s.db.add({ table: notification, row: { user_id: ref("bo.id"), kind: c.text("mention"), title: c.text("mentioned you"), actor_id: ref("morgan.id"), group_key: c.text("mention-1"), head: c.bool(true), group_count: c.int(1) } }),
  s.db.add({ table: notification, row: { user_id: ref("bo.id"), kind: c.text("welcome"), title: c.text("Welcome"), actor_id: c.int(0), group_key: c.text("welcome-1"), head: c.bool(true), group_count: c.int(1) } }),
  s.db.add({ table: activity, row: { actor_id: ref("morgan.id"), actor_name: c.text("Demo morgan"), verb: c.text("finished"), title: c.text(`finished ${SECRET} plan`) } }),
  s.db.add({ table: search_entry, row: { key: c.text("task-seeded"), entity: c.text("task"), entity_id: ref("demo_task.id"), title: c.text(`${SECRET} plan`), terms: c.text(`${SECRET} plan`), scope: withFilters(c.text("space-"), fl.concat(ref("kept_space.id"))), is_demo: c.bool(true) } }),
  s.db.add({ table: search_entry, row: { key: c.text("message-typed"), entity: c.text("message"), entity_id: ref("demo_line.id"), title: c.text(`${SECRET} chat`), terms: c.text(`${SECRET} chat`), scope: withFilters(c.text("space-"), fl.concat(ref("gone_space.id"))), is_demo: c.bool(false) } }),
  personToken("bo", "bo_token"), personToken("cy", "cy_token"),
];
const clearAs = (who: string, as: string) => s.function.call({ fn: clearDemo, as, input: { actor_id: ref(`${who}.id`) } });

/** The guest's assistant, refused at its own routes: the chatbot module's queries come from index.ts, which builds it. */
export const askTests = (assistantQueries: readonly Api[]) => {
  const list = assistantQueries.find((q) => (q as { verb?: string; name?: string }).verb === "GET" && (q as { name?: string }).name === "chat/conversations")!;
  const start = assistantQueries.find((q) => (q as { name?: string }).name === "chat/conversations/create")!;
  return [
    workflowTest({
      name: "first minute: a guest can't reach Ask by route, and a member can",
      stack: [
        settings(), person("riley", "guest"), person("morgan"), personToken("riley", "guest_token"), personToken("morgan", "member_token"),
        s.api.call({ api: list, headers: bearer("guest_token"), as: "guest_list" }),
        s.expect.to_not_be_defined({ expr: ref("guest_list.items") }),
        says("guest_list", "Guests"),
        s.api.call({ api: start, headers: bearer("guest_token"), as: "guest_start" }),
        s.expect.to_not_be_defined({ expr: ref("guest_start.id") }),
        s.api.call({ api: list, headers: bearer("member_token"), as: "member_list" }),
        s.expect.to_be_false({ expr: withFilters(withFilters(ref("member_list"), fl.json_encode()), fl.contains(c.text("access to this"))) }),
      ],
    }),
  ];
};

export const seedTests = [
  rowsTest({
    name: "first minute: approving the sample run posts the edited words as the agent and ends the run with no model call",
    stack: [
      ...sampleWorld,
      decide("approve", EDITED),
      text("decided.status", "approved"),
      threadPosts("posts"),
      s.expect.to_equal({ expr: withFilters(ref("posts"), fl.count()), value: c.int(1) }),
      s.set_var("post", withFilters(ref("posts"), fl.first())),
      text("post.body", EDITED),
      equal("post.author_id", ref("scout.id")),
      equal("post.approved_by", ref("morgan.id")),
      ...noModelCall,
      s.expect.to_contain({ expr: ref("ended.last_note"), value: c.text("Posted") }),
      // The decision trigger runs the same step again: nothing changes the second time.
      s.function.call({ fn: afterDecisionFn, as: "again", input: { approval_id: ref("asked.approval_id") } }),
      threadPosts("still"),
      s.expect.to_equal({ expr: withFilters(ref("still"), fl.count()), value: c.int(1) }),
    ],
  }),
  rowsTest({
    name: "first minute: declining the sample run ends it with a note and no model call, and a key set later starts nothing",
    stack: [
      ...sampleWorld,
      decide("decline"),
      s.function.call({ fn: afterDecisionFn, as: "told", input: { approval_id: ref("asked.approval_id") } }),
      ...noModelCall,
      text("ended.last_note", "Test morgan declined it, so nothing was posted."),
      threadPosts("posts"),
      s.expect.to_be_empty({ expr: ref("posts") }),
      // A key arriving drains the queue. The sample run isn't in it, so it stays as it ended.
      s.function.call({ fn: drainRuns, as: "drained" }),
      ...noModelCall,
      s.function.call({ fn: stopRun, as: "stopped", input: { actor_id: ref("morgan.id"), browser: c.bool(true), id: ref("run.id") } }),
      s.db.get({ table: agent_run, fieldValue: ref("run.id"), as: "after_stop" }),
      text("after_stop.status", "done"),
    ],
  }),
  rowsTest({
    name: "first minute: an expired sample request ends its run with a plain note, and a stopped sample run can't be retried",
    stack: [
      ...sampleWorld,
      s.db.patch({ table: approvals.approval, fieldValue: ref("asked.approval_id"), data: obj({ status: c.text("expired") }) }),
      s.function.call({ fn: afterDecisionFn, as: "told", input: { approval_id: ref("asked.approval_id") } }),
      ...noModelCall,
      text("ended.last_note", "Nobody decided in time, so nothing was posted."),
      // A second sample, stopped before anyone decides, can't be sent to a model by Retry.
      s.db.add({ table: agent_run, as: "second", row: { agent_id: ref("scout.id"), requested_by: ref("morgan.id"), status: c.text("waiting"), source_type: c.text("message"), source_id: ref("ask.id"), conversation_id: ref("room.id"), thread_id: ref("thread.id"), space_id: ref("client.id"), attempt: c.int(1), sample: c.bool(true), is_demo: c.bool(true) } }),
      s.function.call({ fn: stopRun, as: "stopped", input: { actor_id: ref("morgan.id"), browser: c.bool(true), id: ref("second.id") } }),
      s.function.call({ fn: retryRun, as: "retried", input: { actor_id: ref("morgan.id"), browser: c.bool(true), id: ref("second.id") } }),
      says("retried", "sample run"),
      s.db.get({ table: agent_run, fieldValue: ref("second.id"), as: "still_stopped" }),
      text("still_stopped.status", "failed"),
    ],
  }),
  workflowTest({
    name: "demo data: clearing is refused for a member and for a demo admin, and changes nothing",
    stack: [
      ...demoWorld,
      clearAs("cy", "by_member"),
      says("by_member", "manage the team"),
      clearAs("avery", "by_demo_admin"),
      says("by_demo_admin", "Invite yourself as an admin"),
      s.api.call({ api: clearDemoRoute, headers: bearer("cy_token"), as: "by_route" }),
      says("by_route", "manage the team"),
      rows(task, "tasks"), is("tasks", 2),
      rows(user, "on", [cmp(col("is_demo"), "=", c.bool(true)), cmp(col("status"), "=", c.text("active"))]), is("on", 3),
    ],
  }),
  rowsTest({
    name: "demo data: a real admin clears every demo-owned row, keeps real work and the pipeline, and can still sign in",
    stack: [
      ...demoWorld,
      s.api.call({ api: clearDemoPreview, headers: bearer("bo_token"), as: "preview" }),
      is("preview.people", 2), is("preview.agents", 1), is("preview.spaces", 1), is("preview.tasks", 1), is("preview.docs", 1), is("preview.files", 1),
      is("preview.messages", 3), is("preview.customers", 3),
      rows(task, "before"), is("before", 2),
      s.api.call({ api: clearDemoRoute, headers: bearer("bo_token"), as: "cleared" }),
      s.expect.to_be_true({ expr: ref("cleared.cleared") }),
      // Nothing demo-owned is left in any seeded table.
      rows(user, "demo_on", [cmp(col("is_demo"), "=", c.bool(true)), cmp(col("status"), "=", c.text("active"))]), is("demo_on", 0),
      rows(message, "messages"), is("messages", 1),
      rows(conversation, "conversations"), is("conversations", 1),
      rows(space, "spaces"), is("spaces", 1),
      rows(space_member, "members"), is("members", 1),
      rows(project, "projects"), is("projects", 1),
      rows(task, "tasks"), is("tasks", 1),
      rows(docs.doc, "docs_left"), is("docs_left", 0),
      rows(file_record, "files"), is("files", 0), rows(file_blob, "blobs"), is("blobs", 0),
      rows(company, "companies"), is("companies", 1), rows(contact, "contacts"), is("contacts", 0), rows(deal, "deals"), is("deals", 1),
      rows(pipeline_stage, "stages"), is("stages", 1),
      rows(agent_run, "runs"), is("runs", 0), rows(approvals.approval, "asks"), is("asks", 0),
      rows(notification, "lines"), is("lines", 1),
      rows(activity, "by_demo", cmp(col("actor_id"), "=", ref("morgan.id"))), is("by_demo", 0),
      rows(record_link, "links"), is("links", 1),
      rows(search_entry, "entries"), is("entries", 0),
      s.function.call({ fn: findRecords, as: "found", input: { actor_id: ref("bo.id"), browser: c.bool(true), run_id: c.int(0), q: c.text(SECRET) } }),
      is("found.total", 0),
      // Bo's work is where it was: the space, the task in it, and the copy of Bo's spaces.
      s.db.get({ table: user, fieldValue: ref("bo.id"), as: "bo_after" }),
      equal("bo_after.space_ids", withFilters(c.array([]), fl.array_push(ref("kept_space.id")))),
      s.api.call({ api: getTaskRoute, headers: bearer("bo_token"), input: { id: ref("real_task.id") }, as: "task_view" }),
      seesText("task_view", "Real task by Bo"),
      // Bo's link to the demo task stays, and reads as deleted.
      s.function.call({ fn: listLinks, as: "task_links", input: { actor_id: ref("bo.id"), browser: c.bool(true), type: c.text("task"), id: ref("real_task.id"), page: c.int(1) } }),
      seesText("task_links.forward", "deleted"),
      s.api.call({ api: auth_me, headers: bearer("bo_token"), as: "me" }),
      equal("me.id", ref("bo.id")),
      s.db.get({ table: user, fieldValue: ref("scout.id"), as: "scout_after" }),
      text("scout_after.status", "disabled"),
      text("scout_after.name", "Scout"),
    ],
  }),
  workflowTest({
    name: "demo data: clearing twice changes nothing the second time",
    stack: [
      ...demoWorld,
      clearAs("bo", "first"),
      s.expect.to_be_true({ expr: withFilters(ref("first.removed"), fl.gt(c.int(0))) }),
      rows(activity, "lines_after_first"),
      clearAs("bo", "second"),
      is("second.removed", 0), is("second.people", 0), is("second.agents", 0),
      rows(activity, "lines_after_second"),
      equal("lines_after_second", ref("lines_after_first")),
      rows(task, "tasks"), is("tasks", 1),
      rows(message, "messages"), is("messages", 1),
      s.api.call({ api: auth_me, headers: bearer("bo_token"), as: "me" }),
      equal("me.id", ref("bo.id")),
    ],
  }),
  rowsTest({
    name: "first admin: setup makes the default pipeline, and a deal can be created and moved to Won",
    stack: [
      s.function.call({ fn: runSetup, as: "made", input: {
        submitted_token: c.text("right-token"), expected_token: c.text("right-token"), workspace_name: c.text("Acme"), name: c.text("First Admin"), email: c.text("first@seed-test.example"), password: c.text("Seed-test-1"),
      } }),
      s.db.query({ table: pipeline_stage, sort: [{ sortBy: "rank", dir: "asc" }], as: "stages" }),
      s.expect.to_equal({ expr: withFilters(ref("stages"), fl.count()), value: c.int(6) }),
      s.array.map({ source: ref("stages"), as: "stage_names", transform: ref("$this.name") }),
      s.expect.to_equal({ expr: ref("stage_names"), value: c.array(["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost"]) }),
      rows(pipeline_stage, "demo_stages", cmp(col("is_demo"), "=", c.bool(true))), is("demo_stages", 0),
      s.set_var("first_stage", withFilters(ref("stages"), fl.first())),
      s.db.query({ table: pipeline_stage, where: cmp(col("kind"), "=", c.text("won")), returnType: "single", as: "won" }),
      s.db.get({ table: user, fieldValue: ref("made.user_id"), as: "admin" }),
      personToken("admin", "admin_token"),
      s.api.call({ api: createCompanyRoute, headers: bearer("admin_token"), as: "acme", input: { client_id: c.text("acme-id"), name: c.text("Acme Bikes") } }),
      s.api.call({ api: createDealRoute, headers: bearer("admin_token"), as: "first_deal", input: { client_id: c.text("deal-id"), company_id: ref("acme.id"), stage_id: ref("first_stage.id"), title: c.text("First deal") } }),
      s.api.call({ api: setDealStageRoute, headers: bearer("admin_token"), as: "closed", input: { id: ref("first_deal.id"), stage_id: ref("won.id") } }),
      equal("closed.stage_id", ref("won.id")),
      s.expect.to_be_defined({ expr: ref("closed.closed_at") }),
    ],
  }),
];
