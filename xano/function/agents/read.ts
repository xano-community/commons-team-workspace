// What a person reads about an agent: its page, its runs, a run's steps, whether a connected agent has picked work up, and whether an
// agent named in a message can hear it there. Every read is filtered for the viewer: a run shows only to someone who reaches what
// asked for it, a DM's runs only to the DM's own people (admins included), and guests read none of this.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters } from "@xano/sdk";
import { agent } from "../../agent.js";
import { workspace_setting } from "../../base/tables.js";
import { notification } from "../../base/tables.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { agent_run } from "../../table/agents/agent_run.js";
import { space } from "../../table/spaces/space.js";
import { space_member } from "../../table/spaces/space_member.js";
import { conversation } from "../../table/messaging/conversation.js";
import { conversation_member } from "../../table/messaging/conversation_member.js";
import { NOT_FOUND, accessRule, canManage, canReach, requireReach } from "../access/reach.js";
import { resolveRecords } from "../links/records.js";
import { SYSTEM_CONNECTION } from "../../agents/member-tool.js";

const conn = agent.agent_connection;
const who = { actor_id: input.int({ required: true }), browser: input.bool() };
export const NO_GUESTS = "Guests don't have access to this.";
/** How many of an agent's runs its page lists, newest first, after the viewer's filter. */
const MOST_RUNS_LISTED = 25;
/** How far back the page looks to fill that list. */
const RUNS_LOOKED_AT = 80;
const MOST_MANAGERS_NAMED = 3;
const MOST_PICKUPS = 50;

/** Binds `reader`. A guest is turned away from everything here. */
const refuseGuests = statements(
  s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "kind", "role", "status", "is_demo"], as: "reader" }),
  guard.found("reader", { errorType: "accessdenied", message: NO_GUESTS }),
  guard.require(expr(ref("reader.role"), "!=", c.text("guest")), { errorType: "accessdenied", message: NO_GUESTS }),
);

const RUN_FIELDS = ["id", "created_at", "agent_id", "requested_by", "status", "reason", "detail", "source_type", "source_id", "conversation_id", "thread_id", "doc_id", "space_id", "dm_id", "attempt", "last_note", "steps", "tool_calls", "tool_errors", "step_log", "waiting_on", "approval_id", "started_at", "finished_at", "stopped_by", "hops", "chain_stopped", "sample"] as const;

/** The record a run is about, as the resolver names it: a message's is its conversation. */
const subjectOf = (run: string) => c.expression(`$var.${run}.source_type == "message" ? {"type": "conversation", "id": $var.${run}.conversation_id} : {"type": $var.${run}.source_type, "id": $var.${run}.source_id}`);

/** Binds `seen`: whether this reader may see this run. A DM's run is for the DM's people alone, whoever else oversees spaces. */
const runVisible = (run: string) => statements(
  s.set_var("seen", c.bool(false)),
  s.conditional({
    when: expr(ref(`${run}.dm_id`), ">", c.int(0)),
    then: [
      s.set_var("dm_of_run", ref(`${run}.dm_id`)),
      s.db.query({ table: conversation_member, where: [cmp(col("conversation_id"), "=", ref("dm_of_run")), cmp(col("user_id"), "=", inp("actor_id"))], returnType: "count", as: "in_dm" }),
      s.conditional({ when: expr(ref("in_dm"), ">", c.int(0)), then: [s.update_var("seen", c.bool(true))] }),
    ],
    else: [
      s.function.run({ fn: canReach, as: "run_reachable", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: ref(`${run}.source_type`), id: ref(`${run}.source_id`) } }),
      s.update_var("seen", ref("run_reachable")),
    ],
  }),
);

export const agentProfile = defineFunction({
  name: "agents/profile",
  description: "One agent's page: who it is, what it's for, who answers for it, the spaces this reader can see it in, and what they may do.",
  input: { ...who, agent_id: input.int({ required: true }) },
  stack: [
    ...refuseGuests,
    s.db.get({ table: user, fieldValue: inp("agent_id"), output: ["id", "name", "kind", "agent_mode", "brief", "sponsor_id", "status", "is_demo", "created_at"], as: "worker" }),
    guard.found("worker", { errorType: "notfound", message: NOT_FOUND }),
    guard.require(expr(ref("worker.kind"), "=", c.text("agent")), { errorType: "notfound", message: NOT_FOUND }),
    s.db.get({ table: user, fieldValue: ref("worker.sponsor_id"), output: ["id", "name", "status", "role"], as: "sponsor" }),
    s.db.query({ table: space_member, where: cmp(col("user_id"), "=", inp("agent_id")), output: ["space_id"], as: "memberships" }),
    s.set_var("spaces", c.array([])),
    s.set_var("hidden_spaces", c.int(0)),
    s.foreach({ list: ref("memberships"), as: "m", body: [
      s.function.run({ fn: canReach, as: "space_seen", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: c.text("space"), id: ref("m.space_id") } }),
      s.conditional({
        when: expr(ref("space_seen"), "=", c.bool(true)),
        then: [
          s.db.get({ table: space, fieldValue: ref("m.space_id"), output: ["id", "name", "archived_at", "visibility"], as: "place" }),
          s.update_var("spaces", withFilters(ref("spaces"), fl.array_push(ref("place")))),
        ],
        else: [s.update_var("hidden_spaces", withFilters(ref("hidden_spaces"), fl.add(c.int(1))))],
      }),
    ] }),
    s.db.query({ table: conn, where: [cmp(col("user_id"), "=", inp("agent_id")), cmp(col("name"), "!=", c.text(SYSTEM_CONNECTION))], sort: [{ sortBy: "last_used_at", dir: "desc" }], output: ["last_used_at", "revoked"], as: "keys" }),
    s.set_var("live_keys", withFilters(ref("keys"), fl.array_filter(c.obj({ revoked: false })), fl.count())),
    s.function.run({ fn: "agents/model_ready", as: "model" }),
    s.db.query({ table: workspace_setting, output: ["agents_paused", "demo_mode"], returnType: "single", as: "setting" }),
    s.set_var("admin", c.bool(false)),
    s.conditional({ when: and(expr(inp("browser"), "=", c.bool(true)), rbac.has(ref("reader.role"), "team.manage")), then: [s.update_var("admin", c.bool(true))] }),
    s.set_var("is_sponsor", c.expression("$var.worker.sponsor_id == $input.actor_id")),
    s.set_var("demo_reader", withFilters(ref("reader.is_demo"), fl.first_notnull(c.bool(false)))),
    s.set_var("sponsor_ok", c.bool(false)),
    s.conditional({ when: and(expr(ref("sponsor.status", { safe: true }), "=", c.text("active")), expr(ref("sponsor.role", { safe: true }), "!=", c.text("guest"))), then: [s.update_var("sponsor_ok", c.bool(true))] }),
  ],
  response: {
    id: ref("worker.id"), name: ref("worker.name"), mode: ref("worker.agent_mode"), brief: ref("worker.brief"), status: ref("worker.status"), is_demo: ref("worker.is_demo"), created_at: ref("worker.created_at"),
    sponsor: obj({ id: ref("worker.sponsor_id"), name: ref("sponsor.name", { safe: true }), active: ref("sponsor_ok") }),
    spaces: ref("spaces"), hidden_spaces: ref("hidden_spaces"),
    last_seen: withFilters(ref("keys"), fl.first(), fl.get("last_used_at", c.null())), has_key: c.expression("$var.live_keys > 0"),
    model_ready: ref("model.ready"), key_name: ref("model.key_name"), paused: withFilters(ref("setting.agents_paused", { safe: true }), fl.first_notnull(c.bool(false))),
    can_manage: c.expression("$var.admin && $var.demo_reader != true"), demo_session: ref("demo_reader"), is_sponsor: ref("is_sponsor"),
    can_keys: c.expression('($var.admin || ($var.is_sponsor && $input.browser == true)) && $var.worker.agent_mode == "connected" && $var.worker.status == "active"'),
  },
});

export const agentRuns = defineFunction({
  name: "agents/runs_of",
  description: "An agent's recent runs, only those this reader may see, with the record each was about named for them.",
  input: { ...who, agent_id: input.int({ required: true }) },
  stack: [
    ...refuseGuests,
    s.db.get({ table: user, fieldValue: inp("agent_id"), output: ["id", "kind", "name"], as: "worker" }),
    guard.found("worker", { errorType: "notfound", message: NOT_FOUND }),
    guard.require(expr(ref("worker.kind"), "=", c.text("agent")), { errorType: "notfound", message: NOT_FOUND }),
    s.db.query({ table: agent_run, where: cmp(col("agent_id"), "=", inp("agent_id")), sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: RUNS_LOOKED_AT, metadata: false }, output: [...RUN_FIELDS], as: "rows" }),
    s.set_var("items", c.array([])),
    s.set_var("wanted", c.array([])),
    s.foreach({ list: ref("rows"), as: "run", body: [
      s.conditional({ when: expr(withFilters(ref("items"), fl.count()), "<", c.int(MOST_RUNS_LISTED)), then: [
        ...runVisible("run"),
        s.conditional({ when: expr(ref("seen"), "=", c.bool(true)), then: [
          s.update_var("items", withFilters(ref("items"), fl.array_push(withFilters(ref("run"), fl.set("agent_name", ref("worker.name")))))),
          s.update_var("wanted", withFilters(ref("wanted"), fl.array_push(subjectOf("run")))),
        ] }),
      ] }),
    ] }),
    s.function.run({ fn: resolveRecords, as: "records", input: { actor_id: inp("actor_id"), browser: inp("browser"), items: ref("wanted") } }),
  ],
  response: { items: ref("items"), records: ref("records") },
});

/**
 * A run's steps with each record named for this reader. A step holds a tool, whether it worked, and the record it touched, never what
 * was said. A guest who reaches the record sees the count on the run, and no steps.
 */
export const runSteps = defineFunction({
  name: "agents/run_steps",
  description: "What a run did, step by step, named for this reader.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: agent_run, fieldValue: inp("id"), output: [...RUN_FIELDS], as: "run" }),
    guard.found("run", { errorType: "notfound", message: NOT_FOUND }),
    ...runVisible("run"),
    guard.require(expr(ref("seen"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["role"], as: "reader" }),
    s.set_var("steps", withFilters(ref("run.step_log"), fl.first_notnull(c.array([])))),
    s.conditional({ when: expr(ref("reader.role", { safe: true }), "=", c.text("guest")), then: [s.update_var("steps", c.array([]))] }),
    // Only a step that touched a record is named, and each takes its own answer back in order.
    s.set_var("wanted", c.array([])),
    s.foreach({ list: ref("steps"), as: "step", body: [
      s.conditional({ when: expr(withFilters(ref("step"), fl.get("type", "")), "!=", c.text("")), then: [
        s.update_var("wanted", withFilters(ref("wanted"), fl.array_push(obj({ type: withFilters(ref("step"), fl.get("type", "")), id: withFilters(ref("step"), fl.get("id", 0), fl.to_int()) })))),
      ] }),
    ] }),
    s.set_var("records", c.array([])),
    s.conditional({ when: expr(withFilters(ref("wanted"), fl.count()), ">", c.int(0)), then: [
      s.function.run({ fn: resolveRecords, as: "resolved", input: { actor_id: inp("actor_id"), browser: inp("browser"), items: ref("wanted") } }),
      s.update_var("records", ref("resolved")),
    ] }),
    s.set_var("named_steps", c.array([])),
    s.set_var("next_record", c.int(0)),
    s.foreach({ list: ref("steps"), as: "step", body: [
      s.set_var("step_record", c.null()),
      s.conditional({ when: expr(withFilters(ref("step"), fl.get("type", "")), "!=", c.text("")), then: [
        s.update_var("step_record", withFilters(ref("records"), fl.get(ref("next_record")))),
        s.update_var("next_record", withFilters(ref("next_record"), fl.add(c.int(1)))),
      ] }),
      s.update_var("named_steps", withFilters(ref("named_steps"), fl.array_push(withFilters(ref("step"), fl.set("record", ref("step_record")))))),
    ] }),
  ],
  response: { steps: ref("named_steps") },
});

/**
 * Whether connected agents have picked up what a record asked of them (KTD4). An open item alone means nothing, because an agent's
 * cursor moves on without closing it. The pick-up is the agent's first `my_inbox` call after the item arrived, read from the call log
 * the agents module keeps for every key. `my_inbox` itself stays read-only, as an MCP read tool must, and a stamp once there never
 * goes, so work an agent has picked up never reads Stalled however long it then stays away.
 */
export const agentPickups = defineFunction({
  name: "agents/pickups",
  description: "The connected agents' items about one task or conversation, and when each was picked up.",
  input: { ...who, type: input.text({ required: true }), id: input.int({ required: true }) },
  stack: [
    guard.require(expr(withFilters(c.array(["task", "conversation"]), fl.in(inp("type"))), "=", c.bool(true)), { errorType: "badrequest", message: "Ask about a task or a conversation." }),
    ...requireReach({ actor: inp("actor_id"), browser: inp("browser"), type: inp("type"), id: inp("id") }),
    s.db.query({ table: user, where: [cmp(col("kind"), "=", c.text("agent")), cmp(col("agent_mode"), "=", c.text("connected"))], output: ["id"], as: "connected" }),
    s.array.map({ source: ref("connected"), as: "connected_ids", transform: ref("$this.id") }),
    s.db.query({ table: notification, where: [cmp(col("entity"), "=", inp("type")), cmp(col("entity_id"), "=", inp("id")), cmp(col("user_id"), "in", ref("connected_ids")), cmp(col("done_at"), "=", c.null())],
      sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: MOST_PICKUPS, metadata: false }, output: ["user_id", "seq", "created_at"], as: "rows" }),
    s.set_var("items", c.array([])),
    s.foreach({ list: ref("rows"), as: "row", body: [
      s.set_var("asked_of", ref("row.user_id")),
      s.set_var("asked_at", ref("row.created_at")),
      s.db.query({ table: agent.agent_activity, where: [cmp(col("user_id"), "=", ref("asked_of")), cmp(col("tool"), "=", c.text("my_inbox")), cmp(col("outcome"), "=", c.text("ok")), expr(col("created_at"), ">=", ref("asked_at"))],
        sort: [{ sortBy: "created_at", dir: "asc" }], paging: { per_page: 1, metadata: false }, output: ["created_at"], as: "first_look" }),
      s.update_var("items", withFilters(ref("items"), fl.array_push(withFilters(ref("row"), fl.set("read_at", withFilters(ref("first_look"), fl.first(), fl.get("created_at", c.null()))))))),
    ] }),
  ],
  response: { items: ref("items") },
});

/**
 * The agents a message names that can't hear it where it's sent. Nothing starts for them until they're in, so the sender is asked
 * first. `can_add` is whether this sender manages the space, and `managers` who does, for anyone who can't.
 */
export const agentMentionCheck = defineFunction({
  name: "agents/mention_check",
  description: "Which named agents are outside a conversation, and who may add them.",
  input: { ...who, conversation_id: input.int({ required: true }), agent_ids: input.json() },
  stack: [
    ...requireReach({ actor: inp("actor_id"), browser: inp("browser"), type: "conversation", id: inp("conversation_id") }),
    s.db.get({ table: conversation, fieldValue: inp("conversation_id"), output: ["id", "kind", "space_id", "dm_id", "crm"], as: "place" }),
    s.set_var("space_id", withFilters(ref("place.space_id", { safe: true }), fl.to_int())),
    s.set_var("dm_id", withFilters(ref("place.dm_id", { safe: true }), fl.to_int())),
    s.conditional({ when: expr(ref("place.kind", { safe: true }), "=", c.text("dm")), then: [s.update_var("dm_id", inp("conversation_id"))] }),
    s.set_var("missing", c.array([])),
    s.foreach({ list: withFilters(inp("agent_ids"), fl.first_notnull(c.array([])), fl.unique()), as: "agent_id", body: [
      s.db.get({ table: user, fieldValue: withFilters(ref("agent_id"), fl.to_int()), output: ["id", "name", "kind", "status"], as: "named" }),
      s.conditional({ when: and(expr(ref("named.kind", { safe: true }), "=", c.text("agent")), expr(ref("named.status", { safe: true }), "=", c.text("active"))), then: [
        s.function.run({ fn: accessRule, as: "hears", input: { actor_id: ref("named.id"), browser: c.bool(false), space_id: ref("space_id"), dm_id: ref("dm_id"), crm_record: withFilters(ref("place.crm", { safe: true }), fl.first_notnull(c.bool(false))) } }),
        s.conditional({ when: expr(ref("hears"), "!=", c.bool(true)), then: [s.update_var("missing", withFilters(ref("missing"), fl.array_push(obj({ id: ref("named.id"), name: ref("named.name") }))))] }),
      ] }),
    ] }),
    s.set_var("can_add", c.bool(false)),
    s.set_var("managers", c.array([])),
    s.conditional({ when: and(expr(withFilters(ref("missing"), fl.count()), ">", c.int(0)), expr(ref("space_id"), ">", c.int(0)), expr(ref("dm_id"), "=", c.int(0))), then: [
      s.function.run({ fn: canManage, as: "manages", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: ref("space_id") } }),
      s.update_var("can_add", ref("manages")),
      s.db.query({ table: space_member, where: [cmp(col("space_id"), "=", ref("space_id")), cmp(col("role"), "=", c.text("manager"))], output: ["user_id"], as: "manager_rows" }),
      s.array.map({ source: ref("manager_rows"), as: "manager_ids", transform: ref("$this.user_id") }),
      s.db.query({ table: user, where: [cmp(col("id"), "in", ref("manager_ids")), cmp(col("status"), "=", c.text("active")), cmp(col("kind"), "=", c.text("human"))], sort: [{ sortBy: "name", dir: "asc" }], paging: { per_page: MOST_MANAGERS_NAMED, metadata: false }, output: ["name"], as: "manager_people" }),
      s.array.map({ source: ref("manager_people"), as: "manager_names", transform: ref("$this.name") }),
      s.update_var("managers", ref("manager_names")),
    ] }),
  ],
  response: { missing: ref("missing"), can_add: ref("can_add"), space_id: ref("space_id"), managers: ref("managers"), in_dm: c.expression("$var.dm_id > 0") },
});

export const agentReadFunctions = [agentProfile, agentRuns, runSteps, agentPickups, agentMentionCheck];
