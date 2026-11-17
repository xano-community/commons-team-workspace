// Ending demo mode: every demo door shuts in one transaction, and the accounts that aren't demo rows stay, once an
// admin has seen them.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { agent } from "../../agent.js";
import { access_link, workspace_setting } from "../../base/tables.js";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { requireActivePerson } from "./gate.js";

/** Every active account that isn't a demo row, besides `actor`: what ending demo mode keeps. */
export const otherAccounts = (actor: Parameters<typeof cmp>[2], as: string) =>
  s.db.query({ table: user, where: [cmp(col("is_demo"), "!=", c.bool(true)), cmp(col("status"), "=", c.text("active")), cmp(col("id"), "!=", actor)],
    output: ["id", "name", "email", "role", "kind"], sort: [{ sortBy: "id", dir: "asc" }], as });

/**
 * Ends demo mode as `actor_id`, who must be a real admin, or nobody could manage the workspace afterwards.
 * `confirmed_ids` are the accounts the admin was shown: if anyone joined since, the list no longer matches and the
 * admin sees the new list instead of keeping an account they never saw.
 */
export const endDemo = defineFunction({
  name: "members/end_demo",
  description: "Close demo sign-in, open sign-up, demo accounts, every agent key and every open link.",
  input: { actor_id: input.int({ required: true }), confirmed_ids: input.list(input.int()) },
  stack: [
    s.db.transaction({ body: [
      s.db.get({ table: workspace_setting, fieldName: "singleton", fieldValue: c.int(1), lock: true, output: ["id", "demo_mode"], as: "settings" }),
      guard.found("settings", { message: "The workspace has no settings row." }),
      guard.require(expr(ref("settings.demo_mode"), "=", c.bool(true)), { errorType: "badrequest", message: "Demo mode is already off." }),
      s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "kind", "role", "status", "is_demo"], as: "actor" }),
      guard.found("actor", { errorType: "accessdenied", message: "Only people who manage the team end demo mode." }),
      ...requireActivePerson("actor", { message: "Only people who manage the team end demo mode." }),
      rbac.allows(ref("actor.role"), "team.manage", "Only people who manage the team end demo mode."),
      guard.require(expr(ref("actor.is_demo"), "!=", c.bool(true)), { errorType: "accessdenied", message: "Demo accounts stop working when demo mode ends. Invite yourself as an admin, sign in with that account, then end it." }),
      otherAccounts(inp("actor_id"), "others"),
      guard.require(expr(withFilters(inp("confirmed_ids"), fl.count()), "=", withFilters(ref("others"), fl.count())), { errorType: "badrequest", message: "The list of accounts changed. Check it again." }),
      s.foreach({ list: ref("others"), as: "other", body: [
        guard.require(expr(withFilters(ref("other.id"), fl.in(inp("confirmed_ids"))), "=", c.bool(true)), { errorType: "badrequest", message: "The list of accounts changed. Check it again." }),
      ] }),
      s.db.query({ table: user, where: [cmp(col("is_demo"), "=", c.bool(true)), cmp(col("status"), "=", c.text("active"))], output: ["id"], as: "demo_rows" }),
      s.foreach({ list: ref("demo_rows"), as: "row", body: [s.db.patch({ table: user, fieldValue: ref("row.id"), data: obj({ status: c.text("disabled") }) })] }),
      s.db.query({ table: agent.agent_connection, where: cmp(col("revoked"), "!=", c.bool(true)), output: ["id"], as: "keys" }),
      s.foreach({ list: ref("keys"), as: "key", body: [s.db.patch({ table: agent.agent_connection, fieldValue: ref("key.id"), data: obj({ revoked: c.bool(true) }) })] }),
      s.db.query({ table: access_link, where: [cmp(col("used_at"), "=", c.null()), cmp(col("revoked"), "!=", c.bool(true))], output: ["id"], as: "links" }),
      s.foreach({ list: ref("links"), as: "link", body: [s.db.patch({ table: access_link, fieldValue: ref("link.id"), data: obj({ revoked: c.bool(true) }) })] }),
      s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ demo_mode: c.bool(false), signup_open: c.bool(false) }) }),
    ] }),
    changed({ entity: "settings", id: ref("settings.id"), verb: "ended", actor: inp("actor_id"), link: "/settings", title: "ended demo mode" }),
  ],
  response: obj({ ended: c.bool(true) }),
});
