// An agent's keys, for the people answerable for it: an admin, or its sponsor, in a browser. The token passes through these
// routes once and is never stored, so every route that shows one keeps its request history off.
import { auth, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters } from "@xano/sdk";
import { agent } from "../agent.js";
import { approvals } from "../approvals.js";
import { changed } from "../base/functions.js";
import { rbac } from "../rbac.js";
import { NOT_FOUND } from "../function/access/reach.js";
import { user } from "../table/user.js";
import { SYSTEM_CONNECTION } from "./member-tool.js";

const conn = agent.agent_connection;
const who = { actor_id: input.int({ required: true }), browser: input.bool() };
const KEY_FIELDS = ["id", "name", "scope", "revoked", "expires_at", "last_used_at", "created_at"] as const;
const OUT_OF_BOUNDS = "Only an admin or this agent's sponsor manages its keys.";

/** Binds `worker`, a connected agent the actor answers for. Hosted agents have no key to hand out. */
const bindManaged = statements(
  guard.require(expr(inp("browser"), "=", c.bool(true)), { errorType: "accessdenied", message: OUT_OF_BOUNDS }),
  s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "kind", "role", "status"], as: "actor" }),
  guard.found("actor", { errorType: "accessdenied", message: OUT_OF_BOUNDS }),
  guard.require(expr(ref("actor.kind"), "=", c.text("human")), { errorType: "accessdenied", message: OUT_OF_BOUNDS }),
  s.db.get({ table: user, fieldValue: inp("agent_id"), output: ["id", "name", "kind", "agent_mode", "status", "sponsor_id"], as: "worker" }),
  guard.found("worker", { errorType: "notfound", message: NOT_FOUND }),
  guard.require(expr(ref("worker.kind"), "=", c.text("agent")), { errorType: "notfound", message: NOT_FOUND }),
  s.set_var("may_manage", c.bool(false)),
  s.conditional({ when: expr(ref("worker.sponsor_id"), "=", inp("actor_id")), then: [s.update_var("may_manage", c.bool(true))] }),
  s.conditional({ when: rbac.has(ref("actor.role"), "team.manage"), then: [s.update_var("may_manage", c.bool(true))] }),
  guard.require(expr(ref("may_manage"), "=", c.bool(true)), { errorType: "accessdenied", message: OUT_OF_BOUNDS }),
  guard.require(expr(ref("actor.role"), "!=", c.text("guest")), { errorType: "accessdenied", message: OUT_OF_BOUNDS }),
  guard.require(expr(ref("worker.agent_mode"), "=", c.text("connected")), { errorType: "badrequest", message: "A hosted agent works here, so it has no key to hand out." }),
);
/** Binds `key`, one of this agent's own keys. */
const bindKey = statements(
  s.db.get({ table: conn, fieldValue: inp("key_id"), as: "key" }),
  guard.found("key", { errorType: "notfound", message: NOT_FOUND }),
  guard.require(expr(ref("key.user_id"), "=", inp("agent_id")), { errorType: "notfound", message: NOT_FOUND }),
);

export const listAgentKeys = defineFunction({
  name: "agents/list_keys",
  description: "An agent's keys, with no token in sight.",
  input: { ...who, agent_id: input.int({ required: true }) },
  stack: [
    ...bindManaged,
    s.db.query({ table: conn, where: [cmp(col("user_id"), "=", inp("agent_id")), cmp(col("name"), "!=", c.text(SYSTEM_CONNECTION))], sort: [{ sortBy: "created_at", dir: "desc" }], output: KEY_FIELDS, as: "rows" }),
  ],
  response: { items: ref("rows") },
});

export const mintAgentKey = defineFunction({
  name: "agents/mint_key",
  description: "Give a connected agent a key on its own row. The token shows once.",
  input: { ...who, agent_id: input.int({ required: true }), name: input.text({ required: true }), scope: input.enum(["read", "read_write"], { required: true }), days: input.int({ required: true }) },
  stack: [
    ...bindManaged,
    guard.require(expr(ref("worker.status"), "=", c.text("active")), { errorType: "badrequest", message: "This agent has left the workspace." }),
    guard.require(expr(inp("name"), "!=", c.text(SYSTEM_CONNECTION)), { errorType: "badrequest", message: "Choose another name." }),
    s.function.run({ fn: agent.connectFn, as: "made", input: { user_id: inp("agent_id"), name: inp("name"), scope: inp("scope"), days: inp("days") } }),
    changed({ entity: "user", id: inp("agent_id"), verb: "issued", actor: inp("actor_id"), link: "/team", title: withFilters(c.text("issued a key for "), fl.concat(ref("worker.name"))) }),
  ],
  response: { key: ref("made.connection"), token: ref("made.token") },
});

/**
 * A new key for the same work. The old one stops at once, and everything it asked for moves to the new one, so `check_approval`
 * keeps answering. Decided rows move too: an agent often checks after it has rotated.
 */
export const rotateAgentKey = defineFunction({
  name: "agents/rotate_key",
  description: "Swap an agent's key for a new one, and carry its approvals across.",
  input: { ...who, agent_id: input.int({ required: true }), key_id: input.int({ required: true }), days: input.int({ required: true }) },
  stack: [
    ...bindManaged,
    ...bindKey,
    guard.require(expr(ref("key.revoked"), "!=", c.bool(true)), { errorType: "badrequest", message: "This key was already revoked. Issue a new one." }),
    s.function.run({ fn: agent.connectFn, as: "made", input: { user_id: inp("agent_id"), name: ref("key.name"), scope: ref("key.scope"), days: inp("days") } }),
    s.db.query({ table: approvals.approval, where: cmp(col("connection_id"), "=", inp("key_id")), output: ["id", "payload"], as: "asked" }),
    s.foreach({ list: ref("asked"), as: "row", body: [
      s.db.patch({ table: approvals.approval, fieldValue: ref("row.id"), data: obj({ connection_id: ref("made.connection.id"), payload: withFilters(ref("row.payload"), fl.set("connection_id", ref("made.connection.id"))) }) }),
    ] }),
    s.function.run({ fn: agent.revokeFn, as: "revoked", input: { user_id: inp("agent_id"), id: inp("key_id") } }),
    changed({ entity: "user", id: inp("agent_id"), verb: "rotated", actor: inp("actor_id"), link: "/team", title: withFilters(c.text("rotated a key for "), fl.concat(ref("worker.name"))) }),
  ],
  response: { key: ref("made.connection"), token: ref("made.token"), moved: withFilters(ref("asked"), fl.count()) },
});

export const revokeAgentKey = defineFunction({
  name: "agents/revoke_key",
  description: "End one of an agent's keys. Its next call is refused.",
  input: { ...who, agent_id: input.int({ required: true }), key_id: input.int({ required: true }) },
  stack: [
    ...bindManaged,
    ...bindKey,
    s.function.run({ fn: agent.revokeFn, as: "revoked", input: { user_id: inp("agent_id"), id: inp("key_id") } }),
    changed({ entity: "user", id: inp("agent_id"), verb: "revoked", actor: inp("actor_id"), link: "/team", title: withFilters(c.text("revoked a key for "), fl.concat(ref("worker.name"))) }),
  ],
  response: { id: inp("key_id"), revoked: c.bool(true) },
});

export const keyFunctions = [listAgentKeys, mintAgentKey, rotateAgentKey, revokeAgentKey];
