// The three calls a template's own code makes (BASELINE.md): `changed` after every write, `notify` when a person
// should know, `notifyRoles` when whoever holds a permission should. Each is one statement in a stack.
import { and, auth, c, cmp, col, defineFunction, expr, fl, inp, input, obj, ref, s, withFilters, type Value } from "@xano/sdk";
import { user } from "../table/user.js";
import { activity, notification } from "./tables.js";
import { live } from "./live.js";
import { recordChange } from "../function/links/changes.js";
import { deliver } from "../function/inbox/deliver.js";
import { INDEXED } from "../table/search/search_entry.js";

/** Log what happened (when there's a title) and tell every open screen that the record changed. */
export const changedFn = defineFunction({
  name: "app/changed",
  description: "After a write: add an activity row (when titled) and push {entity, id, op} to the screens allowed to see it.",
  input: {
    entity: input.text({ required: true }), id: input.int(), op: input.text(),
    actor_id: input.int(), via: input.text(), verb: input.text(), title: input.text(), link: input.text(), private_to: input.int(), space_id: input.int(), crm: input.bool(),
  },
  stack: [
    s.conditional({
      when: expr(inp("title"), "!=", c.text("")),
      then: [
        s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["name"], as: "actor" }),
        s.db.add({ table: activity, row: {
        actor_id: inp("actor_id"), actor_name: ref("actor.name", { safe: true }), via: inp("via"), verb: inp("verb"), entity: inp("entity"), entity_id: inp("id"),
        title: inp("title"), link: inp("link"), private_to: inp("private_to"), space_id: inp("space_id"),
      } }),
      ],
    }),
    // A change inside a space or the CRM goes through its gated channel's log. Only the workspace's own changes use `app`.
    s.set_var("channel", c.text("app")),
    s.conditional({ when: expr(inp("crm"), "=", c.bool(true)), then: [s.update_var("channel", c.text("crm"))] }),
    s.conditional({ when: expr(inp("space_id"), ">", c.int(0)), then: [s.update_var("channel", withFilters(c.text("spaces/"), fl.concat(inp("space_id"))))] }),
    s.conditional({
      when: expr(ref("channel"), "=", c.text("app")),
      then: [s.realtime.publish({ server: live, channel: ref("channel"), message: c.text("changed"), data: obj({ entity: inp("entity"), id: inp("id"), op: inp("op"), actor_id: inp("actor_id") }) })],
      else: [s.function.run({ fn: recordChange, as: "seq", input: { channel: ref("channel"), entity: inp("entity"), id: inp("id"), op: inp("op"), actor_id: inp("actor_id"), message: c.text(""), kind: c.text(""), link: c.text(""), at: c.int(0) } })],
    }),
    // After the frame, so a second window doesn't wait on it. An id of 0 means "several changed", with nothing to read here.
    s.conditional({ when: and(expr(inp("id"), ">", c.int(0)), expr(withFilters(c.array(INDEXED), fl.in(inp("entity"))), "=", c.bool(true))), then: [
      s.function.run({ fn: "search/index", as: "indexed", input: { type: inp("entity"), id: inp("id") } }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

/** Notify one person (never the person who caused it): `inbox/deliver` with no message behind it. */
export const notifyFn = defineFunction({
  name: "app/notify",
  description: "Put an item in one person's inbox. Skipped when they caused it, or can't reach what it's about.",
  input: {
    user_id: input.int({ required: true }), kind: input.text(), title: input.text({ required: true }),
    body: input.text(), link: input.text(), actor_id: input.int(), space_id: input.int(), entity: input.text(), entity_id: input.int(),
  },
  stack: [
    s.function.run({ fn: deliver, as: "sent", input: {
      user_id: inp("user_id"), kind: inp("kind"), title: inp("title"), body: inp("body"), link: inp("link"), actor_id: inp("actor_id"), space_id: inp("space_id"),
      dm_id: c.int(0), entity: inp("entity"), entity_id: inp("entity_id"), group_key: c.text(""), seq: c.int(0),
    } }),
  ],
  response: { ok: c.bool(true) },
});

/** Notify everyone whose role is in `roles` (e.g. `rbac.rolesWith("jobs.approve")`), except the actor. */
export const notifyRolesFn = defineFunction({
  name: "app/notify_roles",
  description: "Notify every person holding one of these roles (an approver queue), except whoever caused it.",
  input: {
    roles: input.list(input.text()), kind: input.text(), title: input.text({ required: true }),
    body: input.text(), link: input.text(), actor_id: input.int(), entity: input.text(), entity_id: input.int(),
  },
  stack: [
    s.db.query({ table: user, where: [cmp(col("role"), "in", inp("roles")), cmp(col("kind"), "=", c.text("human")), cmp(col("status"), "=", c.text("active"))], output: ["id"], paging: { per_page: 200, metadata: false }, as: "people" }),
    s.foreach({ list: ref("people"), as: "person", body: [
      s.function.run({ fn: notifyFn, as: "sent", input: {
        user_id: ref("person.id"), kind: inp("kind"), title: inp("title"), body: inp("body"), link: inp("link"), actor_id: inp("actor_id"), space_id: c.int(0), entity: inp("entity"), entity_id: inp("entity_id"),
      } }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

type Text = string | Value;
const v = (x: Text | undefined, fallback = ""): Value => (x === undefined ? c.text(fallback) : typeof x === "string" ? c.text(x) : x);

/**
 * After a write, in the same stack: `changed({ entity: "job", id: ref("row.id"), op: "updated", title: … })`.
 * - `title` also logs it to the activity feed and the record's timeline: the rest of a sentence after the
 *   person's name ("moved Fix the boiler to In progress"). Leave it out for small edits.
 * - `actor` defaults to `auth("id")`. In an agent tool, pass `actor: ref("conn.user_id"), via: ref("conn.name")`
 *   (auth("id") there is the agent key, not the person).
 * - `space` is the space the record lives in. Its activity and live push then reach only people who reach that space.
 * - `crm` says a record with no space lives in the CRM, so it goes out on the gated `crm` channel.
 */
export const changed = (o: {
  entity: string; id: Value; op?: "created" | "updated" | "deleted" | "moved";
  title?: Text; verb?: Text; link?: Text; actor?: Value; via?: Text; privateTo?: Value; space?: Value; crm?: boolean;
}) => s.function.run({ fn: changedFn, as: "_changed", input: {
  entity: c.text(o.entity), id: o.id, op: c.text(o.op ?? "updated"), actor_id: o.actor ?? auth("id"), via: v(o.via),
  verb: v(o.verb, o.op ?? "updated"), title: v(o.title), link: v(o.link), private_to: o.privateTo ?? c.int(0), space_id: o.space ?? c.int(0), crm: c.bool(o.crm ?? false),
} });

/**
 * Tell one person: `notify({ to: ref("job.assignee_id"), kind: "assigned", title: …, link: … })`. About something in a
 * space, pass `space` and `entity`, and keep the record's name out of `title`: the inbox resolves it for each viewer.
 */
export const notify = (o: { to: Value; kind?: string; title: Text; body?: Text; link?: Text; actor?: Value; space?: Value; entity?: string; entityId?: Value }) =>
  s.function.run({ fn: notifyFn, as: "_notified", input: {
    user_id: o.to, kind: c.text(o.kind ?? ""), title: v(o.title), body: v(o.body), link: v(o.link), actor_id: o.actor ?? auth("id"),
    space_id: o.space ?? c.int(0), entity: c.text(o.entity ?? ""), entity_id: o.entityId ?? c.int(0),
  } });

/** Tell everyone with one of these roles: `notifyRoles({ roles: rbac.rolesWith("jobs.approve"), … })`. */
export const notifyRoles = (o: { roles: readonly string[]; kind?: string; title: Text; body?: Text; link?: Text; actor?: Value; entity?: string; entityId?: Value }) =>
  s.function.run({ fn: notifyRolesFn, as: "_notified", input: {
    roles: c.array([...o.roles]), kind: c.text(o.kind ?? ""), title: v(o.title), body: v(o.body), link: v(o.link), actor_id: o.actor ?? auth("id"),
    entity: c.text(o.entity ?? ""), entity_id: o.entityId ?? c.int(0),
  } });

export const baseFunctions = [changedFn, notifyFn, notifyRolesFn];
