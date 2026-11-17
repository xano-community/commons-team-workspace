// Adding and managing agents on screen: an admin adds one, writes its brief, mode and spaces, hands it to another sponsor, and brings
// back one that stopped. Every write here needs a real admin in a browser: a demo session can pause agents and can't make or change
// them (origin KTD9). A sponsor is always an active person who isn't a guest, and an agent only ever holds the agent role, so no
// route here can give one `team.manage`.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { agent } from "../../agent.js";
import { changed, notify } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { agent_run } from "../../table/agents/agent_run.js";
import { space_member } from "../../table/spaces/space_member.js";
import { NOT_FOUND } from "../access/reach.js";
import { requireActivePerson } from "../members/gate.js";
import { SYSTEM_CONNECTION } from "../../agents/member-tool.js";

const conn = agent.agent_connection;
const who = { actor_id: input.int({ required: true }), browser: input.bool() };
export const ADMINS_ONLY = "Only people who manage the team add or change agents.";
export const DEMO_REFUSED = "A demo session can't add or change agents. Sign in with a real account to do that.";
export const AGENT_ROLE_ONLY = "An agent always holds the agent role, so it can never manage the team.";
export const GUEST_SPONSOR = "A guest can't sponsor an agent. Choose a member or an admin.";
const NO_SPONSOR = "Choose a current member to sponsor it.";
const MOST_NAME = 40;
const MOST_BRIEF = 1000;
const LIVE = ["queued", "claimed", "working", "waiting"];

const agentLink = (id: Value) => withFilters(c.text("/team/agents/"), fl.concat(id));

/** Binds `actor`: a real admin in a browser. The demo refusal comes last, so a member hears they can't, not that it's a demo. */
const requireRealAdmin = statements(
  guard.require(expr(inp("browser"), "=", c.bool(true)), { errorType: "accessdenied", message: ADMINS_ONLY }),
  s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "kind", "role", "status", "is_demo"], as: "actor" }),
  guard.found("actor", { errorType: "accessdenied", message: ADMINS_ONLY }),
  ...requireActivePerson("actor", { message: ADMINS_ONLY }),
  rbac.allows(ref("actor.role"), "team.manage", ADMINS_ONLY),
  guard.require(expr(ref("actor.is_demo"), "!=", c.bool(true)), { errorType: "accessdenied", message: DEMO_REFUSED }),
);

/** Binds `sponsor`: an active person who isn't a guest. */
const requireSponsor = (id: Value) => statements(
  s.db.get({ table: user, fieldValue: id, output: ["id", "name", "kind", "role", "status"], as: "sponsor" }),
  guard.found("sponsor", { errorType: "badrequest", message: NO_SPONSOR }),
  ...requireActivePerson("sponsor", { errorType: "badrequest", message: NO_SPONSOR }),
  guard.require(expr(ref("sponsor.role"), "!=", c.text("guest")), { errorType: "badrequest", message: GUEST_SPONSOR }),
);

/** Binds `worker`, an agent row of any status. */
const bindAgent = statements(
  s.db.get({ table: user, fieldValue: inp("agent_id"), output: ["id", "name", "kind", "agent_mode", "brief", "sponsor_id", "status", "is_demo"], as: "worker" }),
  guard.found("worker", { errorType: "notfound", message: NOT_FOUND }),
  guard.require(expr(ref("worker.kind"), "=", c.text("agent")), { errorType: "notfound", message: NOT_FOUND }),
);

/** A role field anywhere near an agent: empty, or the agent role, and nothing else. */
const onlyAgentRole = guard.require(expr(withFilters(c.array(["", "agent"]), fl.in(withFilters(inp("role"), fl.first_notnull(c.text(""))))), "=", c.bool(true)), { errorType: "badrequest", message: AGENT_ROLE_ONLY });

/** Every key an agent holds ends: the person who vouched for them has changed. A hosted agent's own line stays, so its runs go on. */
const revokeKeys = (agentId: Value) => statements(
  s.db.query({ table: conn, where: [cmp(col("user_id"), "=", agentId), cmp(col("revoked"), "!=", c.bool(true)), cmp(col("name"), "!=", c.text(SYSTEM_CONNECTION))], output: ["id"], as: "old_keys" }),
  s.foreach({ list: ref("old_keys"), as: "key", body: [s.function.run({ fn: agent.revokeFn, as: "revoked_key", input: { user_id: agentId, id: ref("key.id") } })] }),
);

const briefRules = statements(
  guard.require(expr(withFilters(inp("brief"), fl.first_notnull(c.text("")), fl.strlen()), "<=", c.int(MOST_BRIEF)), { errorType: "badrequest", message: `Keep the brief under ${MOST_BRIEF} characters.` }),
);

export const createAgent = defineFunction({
  name: "agents/create",
  description: "Add a hosted or connected agent, with its brief, its sponsor and the spaces it joins.",
  input: {
    ...who, name: input.text({ required: true, methods: ["trim"] }), mode: input.text({ required: true }), brief: input.text({ methods: ["trim"] }), sponsor_id: input.int({ required: true }),
    space_ids: input.json(), role: input.text(),
  },
  stack: [
    ...requireRealAdmin,
    onlyAgentRole,
    guard.require(expr(withFilters(c.array(["hosted", "connected"]), fl.in(inp("mode"))), "=", c.bool(true)), { errorType: "badrequest", message: "Choose whether it works here or connects from elsewhere." }),
    guard.require(expr(withFilters(inp("name"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Give it a name." }),
    guard.require(expr(withFilters(inp("name"), fl.strlen()), "<=", c.int(MOST_NAME)), { errorType: "badrequest", message: `Keep the name under ${MOST_NAME} characters.` }),
    s.db.query({ table: user, where: [cmp(col("name"), "=", inp("name")), cmp(col("status"), "=", c.text("active"))], returnType: "count", as: "same_name" }),
    guard.require(expr(ref("same_name"), "=", c.int(0)), { errorType: "badrequest", message: "Someone here already has that name. Choose another, so a mention reaches the right one." }),
    s.conditional({ when: expr(inp("mode"), "=", c.text("hosted")), then: [
      guard.require(expr(withFilters(inp("brief"), fl.first_notnull(c.text("")), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Say what it's for in a sentence or two. Every run starts from this." }),
    ] }),
    ...briefRules,
    ...requireSponsor(inp("sponsor_id")),
    s.db.add({ table: user, as: "made", row: {
      name: inp("name"), email: c.null(), password: c.null(), role: c.text("agent"), kind: c.text("agent"), agent_mode: inp("mode"), brief: withFilters(inp("brief"), fl.first_notnull(c.text(""))),
      sponsor_id: inp("sponsor_id"), status: c.text("active"), is_demo: c.bool(false), space_ids: c.array([]),
    } }),
    s.foreach({ list: withFilters(inp("space_ids"), fl.first_notnull(c.array([]))), as: "space_id", body: [
      s.function.run({ fn: "spaces/add_member", as: "joined", input: { actor_id: inp("actor_id"), browser: c.bool(true), space_id: withFilters(ref("space_id"), fl.to_int()), user_id: ref("made.id"), history_ok: c.bool(true) } }),
    ] }),
    s.conditional({ when: expr(inp("sponsor_id"), "!=", inp("actor_id")), then: [
      notify({ to: inp("sponsor_id"), kind: "sponsor", actor: inp("actor_id"), link: agentLink(ref("made.id")), title: withFilters(c.text("You now sponsor "), fl.concat(inp("name"))) }),
    ] }),
    changed({ entity: "user", id: ref("made.id"), op: "created", verb: "added", actor: inp("actor_id"), link: agentLink(ref("made.id")), title: withFilters(c.text("added the agent "), fl.concat(inp("name"))) }),
  ],
  response: { id: ref("made.id") },
});

export const updateAgent = defineFunction({
  name: "agents/update",
  description: "Change an agent's brief or how it works. Empty fields stay as they are.",
  input: { ...who, agent_id: input.int({ required: true }), brief: input.text({ methods: ["trim"] }), mode: input.text(), role: input.text() },
  stack: [
    ...requireRealAdmin,
    onlyAgentRole,
    ...bindAgent,
    guard.require(expr(ref("worker.status"), "=", c.text("active")), { errorType: "badrequest", message: "This agent is stopped. Bring it back first." }),
    ...briefRules,
    s.set_var("mode", withFilters(inp("mode"), fl.first_notempty(ref("worker.agent_mode")))),
    guard.require(expr(withFilters(c.array(["hosted", "connected"]), fl.in(ref("mode"))), "=", c.bool(true)), { errorType: "badrequest", message: "Choose whether it works here or connects from elsewhere." }),
    s.set_var("brief", withFilters(inp("brief"), fl.first_notempty(ref("worker.brief")))),
    s.conditional({ when: expr(ref("mode"), "=", c.text("hosted")), then: [
      guard.require(expr(withFilters(ref("brief"), fl.first_notnull(c.text("")), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Say what it's for in a sentence or two. Every run starts from this." }),
    ] }),
    s.conditional({ when: expr(ref("mode"), "!=", ref("worker.agent_mode")), then: [
      s.db.query({ table: agent_run, where: [cmp(col("agent_id"), "=", inp("agent_id")), cmp(col("status"), "in", c.array(LIVE))], returnType: "count", as: "live" }),
      guard.require(expr(ref("live"), "=", c.int(0)), { errorType: "badrequest", message: "It's working on something. Stop that first, then change how it works." }),
      // A key belongs to an agent that connects. One that works here has nothing to hand out.
      s.conditional({ when: expr(ref("mode"), "=", c.text("hosted")), then: [...revokeKeys(inp("agent_id"))] }),
    ] }),
    s.db.patch({ table: user, fieldValue: inp("agent_id"), data: obj({ brief: ref("brief"), agent_mode: ref("mode") }) }),
    s.set_var("said", c.text("changed the brief of ")),
    s.conditional({ when: expr(ref("mode"), "!=", ref("worker.agent_mode")), then: [s.update_var("said", c.text("changed how this agent works: "))] }),
    changed({ entity: "user", id: inp("agent_id"), verb: "changed", actor: inp("actor_id"), link: agentLink(inp("agent_id")), title: withFilters(ref("said"), fl.concat(ref("worker.name"))) }),
  ],
  response: { id: inp("agent_id"), brief: ref("brief"), mode: ref("mode") },
});

export const setAgentSpaces = defineFunction({
  name: "agents/set_spaces",
  description: "Set the spaces an agent is in: it joins the new ones and leaves the rest.",
  input: { ...who, agent_id: input.int({ required: true }), space_ids: input.json() },
  stack: [
    ...requireRealAdmin,
    ...bindAgent,
    guard.require(expr(ref("worker.status"), "=", c.text("active")), { errorType: "badrequest", message: "This agent is stopped. Bring it back first." }),
    s.set_var("wanted", c.array([])),
    s.foreach({ list: withFilters(inp("space_ids"), fl.first_notnull(c.array([]))), as: "space_id", body: [s.update_var("wanted", withFilters(ref("wanted"), fl.array_push(withFilters(ref("space_id"), fl.to_int()))))] }),
    s.db.query({ table: space_member, where: cmp(col("user_id"), "=", inp("agent_id")), output: ["space_id"], as: "rows" }),
    s.array.map({ source: ref("rows"), as: "current", transform: ref("$this.space_id") }),
    s.foreach({ list: withFilters(ref("wanted"), fl.unique(), fl.array_diff(ref("current"))), as: "space_id", body: [
      s.function.run({ fn: "spaces/add_member", as: "joined", input: { actor_id: inp("actor_id"), browser: c.bool(true), space_id: ref("space_id"), user_id: inp("agent_id"), history_ok: c.bool(true) } }),
    ] }),
    s.foreach({ list: withFilters(ref("current"), fl.array_diff(ref("wanted"))), as: "space_id", body: [
      s.function.run({ fn: "spaces/remove_member", as: "left", input: { actor_id: inp("actor_id"), browser: c.bool(true), space_id: ref("space_id"), user_id: inp("agent_id") } }),
    ] }),
    s.db.query({ table: space_member, where: cmp(col("user_id"), "=", inp("agent_id")), output: ["space_id"], as: "after" }),
    s.array.map({ source: ref("after"), as: "now_in", transform: ref("$this.space_id") }),
  ],
  response: { id: inp("agent_id"), space_ids: ref("now_in") },
});

/**
 * A new sponsor for an agent whose sponsor stays. Its keys end, because the new sponsor didn't vouch for them. What it's waiting on moves
 * to them, and its history stays as it was.
 */
export const changeSponsor = defineFunction({
  name: "agents/change_sponsor",
  description: "Hand an agent to a new sponsor: its keys end and what it's waiting on moves to them.",
  input: { ...who, agent_id: input.int({ required: true }), sponsor_id: input.int({ required: true }) },
  stack: [
    ...requireRealAdmin,
    ...bindAgent,
    guard.require(expr(ref("worker.status"), "=", c.text("active")), { errorType: "badrequest", message: "This agent is stopped. Bring it back with a new sponsor instead." }),
    guard.require(expr(ref("worker.is_demo"), "!=", c.bool(true)), { errorType: "badrequest", message: "Demo agents keep their sponsor until demo mode ends." }),
    guard.require(expr(inp("sponsor_id"), "!=", ref("worker.sponsor_id")), { errorType: "badrequest", message: "They already sponsor it. Choose someone else." }),
    ...requireSponsor(inp("sponsor_id")),
    s.db.patch({ table: user, fieldValue: inp("agent_id"), data: obj({ sponsor_id: inp("sponsor_id") }) }),
    ...revokeKeys(inp("agent_id")),
    s.function.run({ fn: "agents/reroute_approvals", as: "rerouted" }),
    s.conditional({ when: expr(inp("sponsor_id"), "!=", inp("actor_id")), then: [
      notify({ to: inp("sponsor_id"), kind: "sponsor", actor: inp("actor_id"), link: agentLink(inp("agent_id")), title: withFilters(c.text("You now sponsor "), fl.concat(ref("worker.name"))) }),
    ] }),
    changed({ entity: "user", id: inp("agent_id"), verb: "changed", actor: inp("actor_id"), link: agentLink(inp("agent_id")), title: withFilters(c.text("handed "), fl.concat(ref("worker.name")), fl.concat(c.text(" to ")), fl.concat(ref("sponsor.name"))) }),
  ],
  response: { id: inp("agent_id"), sponsor_id: inp("sponsor_id"), revoked: withFilters(ref("old_keys"), fl.count()) },
});

/** Brings back an agent that stopped, because its sponsor left or demo mode ended, under a sponsor who can answer for it. */
export const reviveAgent = defineFunction({
  name: "agents/revive",
  description: "Turn a stopped agent back on with a new sponsor. Its old keys stay ended.",
  input: { ...who, agent_id: input.int({ required: true }), sponsor_id: input.int({ required: true }) },
  stack: [
    ...requireRealAdmin,
    ...bindAgent,
    guard.require(expr(ref("worker.status"), "!=", c.text("removed")), { errorType: "badrequest", message: "This agent was removed from the workspace. Add a new one instead." }),
    guard.require(expr(ref("worker.status"), "=", c.text("disabled")), { errorType: "badrequest", message: "This agent is already working." }),
    ...requireSponsor(inp("sponsor_id")),
    s.db.patch({ table: user, fieldValue: inp("agent_id"), data: obj({ status: c.text("active"), sponsor_id: inp("sponsor_id") }) }),
    s.conditional({ when: expr(inp("sponsor_id"), "!=", inp("actor_id")), then: [
      notify({ to: inp("sponsor_id"), kind: "sponsor", actor: inp("actor_id"), link: agentLink(inp("agent_id")), title: withFilters(c.text("You now sponsor "), fl.concat(ref("worker.name"))) }),
    ] }),
    changed({ entity: "user", id: inp("agent_id"), verb: "revived", actor: inp("actor_id"), link: agentLink(inp("agent_id")), title: withFilters(c.text("brought back "), fl.concat(ref("worker.name"))) }),
  ],
  response: { id: inp("agent_id"), status: c.text("active"), sponsor_id: inp("sponsor_id") },
});

/** Everyone who can be a sponsor, for a picker. */
export const sponsorChoices = defineFunction({
  name: "agents/sponsor_choices",
  description: "The active people who aren't guests.",
  stack: [s.db.query({ table: user, where: [cmp(col("kind"), "=", c.text("human")), cmp(col("status"), "=", c.text("active")), cmp(col("role"), "!=", c.text("guest"))], sort: [{ sortBy: "name", dir: "asc" }], output: ["id", "name"], as: "people" })],
  response: ref("people"),
});

export const manageFunctions = [createAgent, updateAgent, setAgentSpaces, changeSponsor, reviveAgent, sponsorChoices];
