// The one way anything reaches a person's inbox. It writes one row per source (a retry changes nothing, so one mention
// is one item), keeps the newest open row of a group as the line the inbox shows, and never stores a record's name: `title`
// is a phrase with no record in it, and the inbox resolves the name for whoever reads it.
import { and, c, cmp, col, defineFunction, expr, fl, inp, input, obj, ref, s, withFilters, type Value } from "@xano/sdk";
import { notification } from "../../base/tables.js";
import { user } from "../../table/user.js";
import { accessRule } from "../access/reach.js";
import { recordChange } from "../links/changes.js";

/** Kinds that wait for a decision. Mark all read skips them. */
export const NEEDS_DECISION = ["approval", "agent_question"];
/** Kinds that leave when their record says so, or on reading, never because someone cleared them. */
const NOT_CLEARABLE = [...NEEDS_DECISION, "dm", "assigned"];

/** Tells a person's open tabs that their inbox changed. Ids only: each tab refetches what it may see. */
export const inboxFrame = (o: { to: Value; id: Value; op: string; kind?: Value; link?: Value; actor?: Value }) => s.function.run({ fn: recordChange, as: "frame_seq", input: {
  channel: withFilters(c.text("users/"), fl.concat(o.to)), entity: c.text("notification"), id: o.id, op: c.text(o.op), actor_id: o.actor ?? c.int(0),
  message: c.text("inbox"), kind: o.kind ?? c.text(""), link: o.link ?? c.text(""), at: c.int(0),
} });

/** After rows leave a group: the newest one left becomes its line, and carries the count. */
export const settleGroup = defineFunction({
  name: "inbox/settle_group",
  description: "Make the newest open row of a group its head, with the group's count.",
  input: { user_id: input.int({ required: true }), group_key: input.text({ required: true }) },
  stack: [
    s.db.query({ table: notification, where: [cmp(col("user_id"), "=", inp("user_id")), cmp(col("group_key"), "=", inp("group_key")), cmp(col("done_at"), "=", c.null())],
      sort: [{ sortBy: "seq", dir: "desc" }, { sortBy: "id", dir: "desc" }], output: ["id"], as: "open_rows" }),
    s.conditional({ when: expr(withFilters(ref("open_rows"), fl.count()), ">", c.int(0)), then: [
      s.foreach({ list: ref("open_rows"), as: "open_row", body: [s.db.patch({ table: notification, fieldValue: ref("open_row.id"), data: obj({ head: c.bool(false), group_count: c.int(1) }) })] }),
      s.set_var("newest", withFilters(ref("open_rows"), fl.first(), fl.get("id"))),
      s.db.patch({ table: notification, fieldValue: ref("newest"), data: obj({ head: c.bool(true), group_count: withFilters(ref("open_rows"), fl.count()) }) }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

export const deliver = defineFunction({
  name: "inbox/deliver",
  description: "Put one item in one person's inbox. Skipped for its own author and for anyone who can't reach what it's about.",
  input: {
    user_id: input.int({ required: true }), kind: input.text({ required: true }), title: input.text({ required: true }), body: input.text(), link: input.text(), actor_id: input.int(),
    /** Where the record lives. 0 and 0: the workspace's own. */
    space_id: input.int(), dm_id: input.int(),
    entity: input.text(), entity_id: input.int(),
    /** One line per key. Empty: this record and kind, or a line of its own when there's no record. */
    group_key: input.text(),
    /** The message's place in its conversation. Empty for anything that isn't a message. */
    seq: input.int(),
    /** It's about a CRM record, which needs crm.read to open. */
    crm: input.bool(),
  },
  stack: [
    s.set_var("delivered", c.bool(false)),
    s.set_var("item_id", c.int(0)),
    s.db.get({ table: user, fieldValue: inp("user_id"), output: ["kind"], as: "recipient" }),
    s.set_var("recipient_kind", ref("recipient.kind", { safe: true })),
    s.set_var("reaches", c.bool(true)),
    s.conditional({ when: expr(withFilters(inp("space_id"), fl.add(inp("dm_id"))), ">", c.int(0)), then: [
      s.function.run({ fn: accessRule, as: "allowed", input: { actor_id: inp("user_id"), browser: c.expression('$var.recipient_kind == "human"'), space_id: inp("space_id"), dm_id: inp("dm_id"), crm_record: c.bool(false) } }),
      s.update_var("reaches", ref("allowed")),
    ] }),
    s.conditional({ when: expr(inp("crm"), "=", c.bool(true)), then: [
      s.function.run({ fn: accessRule, as: "allowed", input: { actor_id: inp("user_id"), browser: c.expression('$var.recipient_kind == "human"'), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
      s.update_var("reaches", ref("allowed")),
    ] }),
    s.conditional({ when: and(expr(ref("recipient"), "!=", c.null()), expr(inp("user_id"), "!=", inp("actor_id")), expr(ref("reaches"), "=", c.bool(true))), then: [
      s.set_var("group", inp("group_key")),
      s.conditional({ when: expr(ref("group"), "=", c.text("")), then: [
        s.conditional({
          when: expr(inp("entity"), "!=", c.text("")),
          then: [s.update_var("group", withFilters(inp("kind"), fl.concat(c.text("-")), fl.concat(inp("entity")), fl.concat(c.text("-")), fl.concat(inp("entity_id"))))],
          else: [s.security.create_uuid({ as: "fresh" }), s.update_var("group", ref("fresh"))],
        }),
      ] }),
      // One person's items take turns, so two replies at once can't both become the group's line.
      s.db.transaction({ body: [
        s.db.get({ table: user, fieldValue: inp("user_id"), lock: true, output: ["id"], as: "turn" }),
        s.db.query({ table: notification, where: [cmp(col("user_id"), "=", inp("user_id")), cmp(col("group_key"), "=", ref("group")), cmp(col("seq"), "=", inp("seq"))], returnType: "single", as: "same" }),
        s.conditional({
          when: expr(ref("same"), "=", c.null()),
          then: [
            s.db.query({ table: notification, where: [cmp(col("user_id"), "=", inp("user_id")), cmp(col("group_key"), "=", ref("group")), expr(col("head"), "=", c.bool(true)), cmp(col("done_at"), "=", c.null())], returnType: "single", output: ["id", "group_count"], as: "line" }),
            s.set_var("group_count", withFilters(ref("line.group_count", { safe: true }), fl.to_int(), fl.add(c.int(1)))),
            s.db.add({ table: notification, as: "item", row: {
              user_id: inp("user_id"), kind: inp("kind"), title: inp("title"), body: inp("body"), link: inp("link"), actor_id: inp("actor_id"), space_id: inp("space_id"),
              entity: inp("entity"), entity_id: inp("entity_id"), group_key: ref("group"), seq: inp("seq"), head: c.bool(true), group_count: ref("group_count"),
              needs_action: withFilters(c.array(NEEDS_DECISION), fl.in(inp("kind"))),
              clearable: withFilters(withFilters(c.array(NOT_CLEARABLE), fl.in(inp("kind"))), fl.not()),
            } }),
            s.conditional({ when: expr(ref("line"), "!=", c.null()), then: [
              s.set_var("line_id", ref("line.id", { safe: true })),
              s.db.patch({ table: notification, fieldValue: ref("line_id"), data: obj({ head: c.bool(false) }) }),
            ] }),
            s.update_var("delivered", c.bool(true)),
            s.update_var("item_id", ref("item.id")),
          ],
          // A retry or an edit is the same source: nothing new. A record that left and came back, like a task reassigned to
          // you again, is new news on the same row.
          else: [
            s.update_var("item_id", ref("same.id", { safe: true })),
            s.conditional({ when: and(expr(inp("seq"), "=", c.int(0)), expr(ref("same.done_at", { safe: true }), "!=", c.null())), then: [
              s.db.patch({ table: notification, fieldValue: ref("item_id"), data: obj({ done_at: c.null(), read_at: c.null(), head: c.bool(true), group_count: c.int(1), created_at: c.now() }) }),
              s.update_var("delivered", c.bool(true)),
            ] }),
          ],
        }),
      ] }),
      s.conditional({ when: expr(ref("delivered"), "=", c.bool(true)), then: [inboxFrame({ to: inp("user_id"), id: ref("item_id"), op: "created", kind: inp("kind"), link: inp("link"), actor: inp("actor_id") })] }),
    ] }),
  ],
  response: { delivered: ref("delivered"), id: ref("item_id") },
});

/**
 * `deliver`, for what someone asks of a member. An agent's inbox is its work, so this is the one door to a run, and a retry that
 * delivers nothing starts nothing. By name, because the runner delivers its own results through `deliver`.
 */
export const deliverAsk = defineFunction({
  name: "inbox/deliver_ask",
  description: "Deliver a mention, a DM or an assignment, and start a hosted agent's run if that's who it's for.",
  input: {
    user_id: input.int({ required: true }), kind: input.text({ required: true }), title: input.text({ required: true }), body: input.text(), link: input.text(), actor_id: input.int(),
    space_id: input.int(), dm_id: input.int(), entity: input.text(), entity_id: input.int(), group_key: input.text(), seq: input.int(), crm: input.bool(),
  },
  stack: [
    s.function.run({ fn: deliver, as: "sent", input: {
      user_id: inp("user_id"), kind: inp("kind"), title: inp("title"), body: inp("body"), link: inp("link"), actor_id: inp("actor_id"), space_id: inp("space_id"), dm_id: inp("dm_id"),
      entity: inp("entity"), entity_id: inp("entity_id"), group_key: inp("group_key"), seq: inp("seq"), crm: inp("crm"),
    } }),
    s.conditional({ when: expr(ref("sent.delivered"), "=", c.bool(true)), then: [
      s.db.get({ table: user, fieldValue: inp("user_id"), output: ["kind"], as: "member" }),
      s.conditional({ when: expr(ref("member.kind", { safe: true }), "=", c.text("agent")), then: [
        s.function.run({ fn: "agents/start", as: "run_started", input: {
          agent_id: inp("user_id"), requested_by: inp("actor_id"), kind: inp("kind"), entity: inp("entity"), entity_id: inp("entity_id"), seq: inp("seq"), space_id: inp("space_id"), dm_id: inp("dm_id"),
        } }),
      ] }),
    ] }),
  ],
  response: ref("sent"),
});

/**
 * Takes items out of inboxes when their record says so: a decision, an answer, a task reassigned, a mention withdrawn.
 * `user_id` narrows it to one person and `seq` to one message; left empty they mean everyone and every message.
 */
export const closeItems = defineFunction({
  name: "inbox/close",
  description: "Close the open items of one kind about a record, for one person or for all of them.",
  input: { entity: input.text({ required: true }), entity_id: input.int({ required: true }), kind: input.text({ required: true }), user_id: input.int(), seq: input.int() },
  stack: [
    s.db.query({ table: notification, as: "closing", output: ["id", "user_id", "group_key"], where: [
      cmp(col("entity"), "=", inp("entity")), cmp(col("entity_id"), "=", inp("entity_id")), cmp(col("kind"), "=", inp("kind")), cmp(col("done_at"), "=", c.null()),
      cmp(col("user_id"), "=", inp("user_id"), { ignoreEmpty: true }), cmp(col("seq"), "=", inp("seq"), { ignoreEmpty: true }),
    ] }),
    s.foreach({ list: ref("closing"), as: "row", body: [
      s.db.patch({ table: notification, fieldValue: ref("row.id"), data: obj({ done_at: c.now(), head: c.bool(false) }) }),
      s.function.run({ fn: settleGroup, as: "settled", input: { user_id: ref("row.user_id"), group_key: ref("row.group_key") } }),
      inboxFrame({ to: ref("row.user_id"), id: ref("row.id"), op: "done" }),
    ] }),
  ],
  response: { closed: withFilters(ref("closing"), fl.count()) },
});

export const deliverFunctions = [settleGroup, deliver, deliverAsk, closeItems];
