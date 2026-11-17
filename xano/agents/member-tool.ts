// Every tool an agent holds is a memberTool. The module's wrapper has already checked the key; this checks the member behind
// it, on each call, because a run can outlive a change. `auth("id")` is the connection, so the actor is always `conn.user_id`,
// and `extras` is read whole, because a missing key is a 500 and connected keys carry none.
//
// Three kinds of caller meet here. A hosted agent acts only inside a live run. A connected agent acts through its own key, within
// a write limit. A person's own key or sign-in re-reads that person, and reaches only their joined spaces and DMs.
import { and, auth, c, cmp, col, defineFunction, expr, fl, guard, inp, input, middleware, obj, or, ref, s, withFilters, type Value } from "@xano/sdk";
import { agent } from "../agent.js";
import { activity, workspace_setting } from "../base/tables.js";
import { deliver } from "../function/inbox/deliver.js";
import { user } from "../table/user.js";
import { agent_run } from "../table/agents/agent_run.js";

/** The name of the one connection a hosted agent runs on. It's a system row: nobody holds a key to it. */
export const SYSTEM_CONNECTION = "system:hosted";
/** A run may not act past this. The token outlasts it by a minute, so the run hears why, rather than a bare expiry. */
export const DEADLINE_MS = 240_000;
const REFUSED = { errorType: "accessdenied" } as const;
/** Writes a connection may make in a window. Hosted runs have their own limits. */
export const MOST_CONNECTED_WRITES = 60;
const WRITE_WINDOW_MS = 300_000;
/** The name a sign-in row starts with, before the app that signed in is known. */
const NO_CLIENT_YET = "Signed-in agents";
const MOST_CLIENT_NAME = 60;
/** Tools a connection counts against its limit. */
export const WRITE_TOOLS = ["post_message", "save_task", "save_doc", "save_crm_record", "save_file", "report_progress", "request_action"];

export const memberGate = defineFunction({
  name: "agents/member_gate",
  description: "Refuses a tool call unless the member behind it is active and within what their kind of connection allows.",
  input: { actor_id: input.int({ required: true }), connection_id: input.int(), connection_name: input.text(), run_id: input.int(), attempt: input.int() },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "name", "kind", "role", "status", "sponsor_id", "agent_mode"], as: "member" }),
    guard.found("member", { ...REFUSED, message: "This member no longer exists." }),
    guard.require(expr(ref("member.status"), "=", c.text("active")), { ...REFUSED, message: "This member is no longer active." }),
    s.set_var("via", c.text("")),
    s.conditional({
      when: expr(ref("member.kind"), "=", c.text("agent")),
      then: [
        guard.require(expr(ref("member.role"), "=", c.text("agent")), { ...REFUSED, message: "An agent can act only with the agent role." }),
        s.db.get({ table: user, fieldValue: ref("member.sponsor_id"), output: ["status", "role"], as: "sponsor" }),
        guard.require(expr(ref("sponsor.status", { safe: true }), "=", c.text("active")), { ...REFUSED, message: "This agent's sponsor has left." }),
        guard.require(expr(ref("sponsor.role", { safe: true }), "!=", c.text("guest")), { ...REFUSED, message: "A guest can't sponsor an agent. Ask an admin for a new sponsor." }),
      ],
      // A person's own connection. Guests have no agent access, and it speaks as the app it is.
      else: [
        guard.require(expr(ref("member.role"), "!=", c.text("guest")), { ...REFUSED, message: "Guests can't connect an agent." }),
        s.update_var("via", withFilters(inp("connection_name"), fl.first_notempty(c.text("a connected app")))),
        s.conditional({ when: expr(ref("via"), "=", c.text(NO_CLIENT_YET)), then: [s.update_var("via", c.text("a connected app"))] }),
      ],
    }),
    s.conditional({ when: expr(ref("member.agent_mode"), "=", c.text("hosted")), then: [
      guard.require(expr(inp("run_id"), ">", c.int(0)), { ...REFUSED, message: "A hosted agent acts only inside a run." }),
    ] }),
    s.set_var("scope", c.null()),
    s.conditional({
      when: expr(inp("run_id"), ">", c.int(0)),
      then: [
        s.db.get({ table: agent_run, fieldValue: inp("run_id"), as: "run" }),
        guard.found("run", { ...REFUSED, message: "This run doesn't exist." }),
        guard.require(expr(ref("run.agent_id"), "=", inp("actor_id")), { ...REFUSED, message: "This run belongs to another agent." }),
        guard.require(expr(ref("run.connection_id"), "=", inp("connection_id")), { ...REFUSED, message: "This run belongs to another connection." }),
        // It asked for something, and a person hasn't decided. A run started again carries the answer.
        guard.require(or(expr(ref("run.status"), "!=", c.text("waiting")), expr(ref("run.approval_id"), "=", c.int(0))), { ...REFUSED, message: "This run is waiting for a person's decision. Stop here: it starts again once they've decided." }),
        // The token names its attempt, so a model still finishing a stopped run can't act in the Retry that followed it.
        guard.require(and(expr(ref("run.status"), "=", c.text("working")), expr(ref("run.attempt"), "=", inp("attempt"))), { ...REFUSED, message: "This run has ended, so nothing more can be done in it." }),
        guard.require(expr(withFilters(ref("run.started_at"), fl.add(c.int(DEADLINE_MS))), ">", c.now()), { ...REFUSED, message: "This run is out of time." }),
        s.update_var("scope", ref("run")),
      ],
    }),
  ],
  response: { run_id: inp("run_id"), run: ref("scope"), kind: ref("member.kind"), via: ref("via") },
});

/**
 * A write outside a run: the pause covers connected agents too, and every connection's writes are counted. This sits apart from the
 * gate because it can tell a sponsor something, and a read tool must write nothing.
 */
export const writeGate = defineFunction({
  name: "agents/write_gate",
  description: "Refuses a connection's write while agents are paused, or past its limit, and tells the sponsor once.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["name", "kind", "sponsor_id"], as: "member" }),
    guard.found("member", { ...REFUSED, message: "This member no longer exists." }),
    s.set_var("is_agent", c.expression('$var.member.kind == "agent"')),
    s.conditional({ when: expr(ref("is_agent"), "=", c.bool(true)), then: [
      s.db.query({ table: workspace_setting, output: ["agents_paused"], returnType: "single", as: "setting" }),
      guard.require(expr(ref("setting.agents_paused", { safe: true }), "!=", c.bool(true)), { ...REFUSED, message: "Agents are paused in this workspace. An admin can turn them back on." }),
    ] }),
    s.set_var("window_start", withFilters(c.now(), fl.sub(c.int(WRITE_WINDOW_MS)))),
    s.db.query({ table: agent.agent_activity, where: [cmp(col("user_id"), "=", inp("actor_id")), cmp(col("tool"), "in", c.array(WRITE_TOOLS)), expr(col("created_at"), ">", ref("window_start"))], returnType: "count", as: "recent_writes" }),
    // The sponsor hears once a window, not once a refusal.
    s.conditional({ when: and(expr(ref("recent_writes"), ">=", c.int(MOST_CONNECTED_WRITES)), expr(ref("is_agent"), "=", c.bool(true))), then: [
      s.function.run({ fn: deliver, as: "told", input: {
        user_id: ref("member.sponsor_id"), kind: c.text("agent_limit"), title: withFilters(ref("member.name"), fl.concat(c.text(" reached its write limit"))), body: c.text(`It can make ${MOST_CONNECTED_WRITES} changes every 5 minutes, and it carries on once that passes.`), link: c.text("/team"), actor_id: inp("actor_id"),
        space_id: c.int(0), dm_id: c.int(0), entity: c.text(""), entity_id: c.int(0), group_key: withFilters(c.text("write-limit-"), fl.concat(inp("actor_id"))), seq: withFilters(c.now(), fl.div(c.int(WRITE_WINDOW_MS)), fl.to_int()),
      } }),
    ] }),
    guard.require(expr(ref("recent_writes"), "<", c.int(MOST_CONNECTED_WRITES)), { errorType: "badrequest", message: `That's ${MOST_CONNECTED_WRITES} changes in 5 minutes, the most a connection can make. Wait a few minutes and carry on.` }),
  ],
  response: { ok: c.bool(true) },
});

/** What a person's connection did shows as theirs, through the app that did it: "Morgan via ChatGPT". */
export const stampVia = defineFunction({
  name: "agents/stamp_via",
  description: "Mark the feed lines a person's connection just wrote with the app behind it.",
  input: { actor_id: input.int({ required: true }), via: input.text({ required: true }), since: input.int({ required: true }) },
  stack: [
    s.db.query({ table: activity, where: [cmp(col("actor_id"), "=", inp("actor_id")), expr(col("created_at"), ">=", inp("since")), cmp(col("via"), "=", c.text(""))], output: ["id"], as: "lines" }),
    s.foreach({ list: ref("lines"), as: "line", body: [s.db.patch({ table: activity, fieldValue: ref("line.id"), data: obj({ via: inp("via") }) })] }),
  ],
  response: { ok: c.bool(true) },
});

/**
 * The sign-in page is the only moment the app is told which client this is, so its name goes on the person's signed-in row. One row
 * holds all their sign-ins, so a second client takes the name over. It can't stop a sign-in: a label isn't worth refusing one for.
 */
export const noteClient = middleware({
  name: "agents/note_client",
  description: "Name a person's signed-in row after the client they're allowing.",
  exceptionPolicy: "silent",
  stack: [
    s.util.get_all_input({ as: "payload" }),
    s.mcp.oauth.request({ request: ref("payload.vars.mcp_request", { safe: true }), as: "details" }),
    s.set_var("client", withFilters(ref("details.client_name", { safe: true }), fl.trim(), fl.substr(c.int(0), c.int(MOST_CLIENT_NAME)))),
    s.conditional({ when: expr(ref("client"), "!=", c.text("")), then: [
      s.function.run({ fn: agent.signInFn, as: "signed_in", input: { user_id: auth("id") } }),
      s.db.patch({ table: agent.agent_connection, fieldValue: ref("signed_in.conn.id"), data: obj({ name: ref("client") }) }),
    ] }),
  ],
});

type ToolSpec = Parameters<typeof agent.tool>[0];

/**
 * `agent.tool` with the member checks first. Binds `member` (`member.run_id`, `member.via`, and `member.run` inside a run). Every answer
 * says `ok: true`: a run reads its tool results for that, because a failed call can reach the model as plain text.
 */
export const memberTool = (o: Omit<ToolSpec, "response"> & { response: Record<string, Value> }) => agent.tool({
  ...o,
  stack: [
    s.set_var("extras", auth("extras")),
    s.set_var("run_id", withFilters(ref("extras"), fl.get("run_id", 0))),
    s.set_var("called_at", c.now()),
    s.function.run({ fn: memberGate, as: "member", input: { actor_id: ref("conn.user_id"), connection_id: ref("conn.id"), connection_name: ref("conn.name"), run_id: ref("run_id"), attempt: withFilters(ref("extras"), fl.get("attempt", 0)) } }),
    ...(o.access === "write" ? [s.conditional({ when: expr(ref("run_id"), "=", c.int(0)), then: [s.function.run({ fn: writeGate, as: "within_limit", input: { actor_id: ref("conn.user_id") } })] })] : []),
    ...o.stack,
    ...(o.access === "write" ? [s.conditional({ when: expr(ref("member.via"), "!=", c.text("")), then: [s.function.run({ fn: stampVia, as: "stamped", input: { actor_id: ref("conn.user_id"), via: ref("member.via"), since: ref("called_at") } })] })] : []),
  ],
  response: { ok: c.bool(true), ...o.response },
});
