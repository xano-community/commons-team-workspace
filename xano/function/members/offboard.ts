// Offboarding: a removed member's row stays, so their name stays on old work, and every way in closes.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, or, ref, s, withFilters } from "@xano/sdk";
import { agent } from "../../agent.js";
import { access_link, workspace_setting } from "../../base/tables.js";
import { changed, notify } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { dropAllMemberships } from "../access/membership.js";
import { afterWorkspaceRemoval } from "../access/removal.js";
import { requireActivePerson } from "./gate.js";

/** The agents a person sponsors that are still working. */
export const activeSponsored = (sponsor: Parameters<typeof cmp>[2], as: string) =>
  s.db.query({ table: user, where: [cmp(col("sponsor_id"), "=", sponsor), cmp(col("kind"), "=", c.text("agent")), cmp(col("status"), "=", c.text("active"))],
    output: ["id", "name"], sort: [{ sortBy: "name", dir: "asc" }], as });

/**
 * Removes a member as `actor_id`. The transaction starts by locking the settings row, so two admins removing each
 * other run one after the other and the second finds its actor gone. A sponsor's agents move to `new_sponsor_id`,
 * and the agents' keys stop working, because the new sponsor didn't vouch for them. The agent's sign-ins are revoked
 * after the commit, so a failure there can't undo a removal that the status check already enforces.
 */
export const removeMember = defineFunction({
  name: "members/remove",
  description: "Remove a person or agent from the workspace, moving any agents they sponsor to a new sponsor.",
  input: { actor_id: input.int({ required: true }), member_id: input.int({ required: true }), new_sponsor_id: input.int() },
  stack: [
    guard.require(expr(inp("member_id"), "!=", inp("actor_id")), { errorType: "badrequest", message: "You can't remove yourself. Ask another admin to do it." }),
    s.db.transaction({ body: [
      s.db.get({ table: workspace_setting, fieldName: "singleton", fieldValue: c.int(1), lock: true, output: ["id"], as: "lock" }),
      guard.found("lock", { message: "The workspace has no settings row." }),
      s.db.get({ table: user, fieldValue: inp("member_id"), output: ["id", "name", "kind", "role", "status", "is_demo"], as: "member" }),
      guard.found("member", { message: "No such member." }),
      guard.require(expr(ref("member.status"), "=", c.text("active")), { errorType: "badrequest", message: "This member has already left." }),
      guard.require(expr(ref("member.is_demo"), "!=", c.bool(true)), { errorType: "badrequest", message: "Demo members stay until demo mode ends." }),
      s.conditional({
        when: expr(ref("member.role"), "=", c.text("admin")),
        then: [
          s.db.query({ table: user, as: "other_admins", returnType: "count",
            where: [cmp(col("role"), "=", c.text("admin")), cmp(col("kind"), "=", c.text("human")), cmp(col("status"), "=", c.text("active")), cmp(col("id"), "!=", inp("member_id"))] }),
          guard.require(expr(ref("other_admins"), ">=", c.int(1)), { errorType: "badrequest", message: "This is the last admin. Make someone else an admin first." }),
        ],
      }),
      s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "kind", "role", "status"], as: "actor" }),
      guard.found("actor", { errorType: "accessdenied", message: "Only people who manage the team remove members." }),
      ...requireActivePerson("actor", { message: "Only people who manage the team remove members." }),
      rbac.allows(ref("actor.role"), "team.manage", "Only people who manage the team remove members."),
      activeSponsored(inp("member_id"), "sponsored"),
      s.conditional({
        when: expr(withFilters(ref("sponsored"), fl.count()), ">", c.int(0)),
        then: [
          guard.require(expr(inp("new_sponsor_id"), ">", c.int(0)), { errorType: "badrequest", message: "Choose who sponsors their agents next." }),
          guard.require(expr(inp("new_sponsor_id"), "!=", inp("member_id")), { errorType: "badrequest", message: "Choose someone else to sponsor their agents." }),
          s.db.get({ table: user, fieldValue: inp("new_sponsor_id"), output: ["id", "kind", "role", "status"], as: "sponsor" }),
          guard.found("sponsor", { errorType: "badrequest", message: "Choose a current member to sponsor their agents." }),
          ...requireActivePerson("sponsor", { errorType: "badrequest", message: "Choose a current member to sponsor their agents." }),
          guard.require(expr(ref("sponsor.role"), "!=", c.text("guest")), { errorType: "badrequest", message: "A guest can't sponsor an agent. Choose a member or an admin." }),
          s.foreach({ list: ref("sponsored"), as: "moved", body: [
            s.db.patch({ table: user, fieldValue: ref("moved.id"), data: obj({ sponsor_id: inp("new_sponsor_id") }) }),
            s.db.query({ table: agent.agent_connection, where: [cmp(col("user_id"), "=", ref("moved.id")), cmp(col("revoked"), "!=", c.bool(true))], output: ["id"], as: "agent_keys" }),
            s.foreach({ list: ref("agent_keys"), as: "key", body: [s.db.patch({ table: agent.agent_connection, fieldValue: ref("key.id"), data: obj({ revoked: c.bool(true) }) })] }),
            notify({ to: inp("new_sponsor_id"), kind: "sponsor", actor: inp("actor_id"), link: "/team",
              title: withFilters(c.text("You now sponsor "), fl.concat(ref("moved.name"))) }),
          ] }),
        ],
      }),
      s.db.patch({ table: user, fieldValue: inp("member_id"), data: obj({ status: c.text("removed"), password: c.null() }) }),
      s.db.query({ table: access_link, as: "open_links",
        where: [or(cmp(col("user_id"), "=", inp("member_id")), cmp(col("created_by"), "=", inp("member_id"))), cmp(col("used_at"), "=", c.null()), cmp(col("revoked"), "!=", c.bool(true))], output: ["id"] }),
      s.foreach({ list: ref("open_links"), as: "link", body: [s.db.patch({ table: access_link, fieldValue: ref("link.id"), data: obj({ revoked: c.bool(true) }) })] }),
      ...dropAllMemberships(inp("member_id")),
    ] }),
    ...afterWorkspaceRemoval(inp("actor_id"), inp("member_id"), "left_rows"),
    s.function.run({ fn: "crm/release_owner", as: "released", input: { actor_id: inp("actor_id"), user_id: inp("member_id") } }),
    s.function.run({ fn: "agents/reroute_approvals", as: "rerouted" }),
    s.db.query({ table: agent.agent_connection, where: [cmp(col("user_id"), "=", inp("member_id")), cmp(col("revoked"), "!=", c.bool(true))], output: ["id"], as: "keys" }),
    s.foreach({ list: ref("keys"), as: "key", body: [
      s.function.run({ fn: agent.revokeFn, as: "revoked_key", input: { user_id: inp("member_id"), id: ref("key.id") } }),
    ] }),
    changed({ entity: "user", id: inp("member_id"), op: "deleted", verb: "removed", actor: inp("actor_id"), link: "/team",
      title: withFilters(c.text("removed "), fl.concat(ref("member.name"))) }),
  ],
  response: obj({ id: inp("member_id"), status: c.text("removed") }),
});
