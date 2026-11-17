// The one change path. A write commits, then lands here: lock its channel's row, take the next number, log it, commit,
// and only then publish. Holding the lock through the commit means numbers commit in order, so a client that has read
// up to N can never later find an N-1 that was still in flight. Frames carry ids, never content, so a subscription that
// outlived someone's access reveals nothing. Call this after the write's own transaction, never inside it.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { live } from "../../base/live.js";
import { change_channel, change_log } from "../../table/links/change_log.js";
import { accessRule, canReach, NOT_FOUND } from "../access/reach.js";

export const recordChange = defineFunction({
  name: "changes/record",
  description: "Log a change on a channel, in commit order, then publish it. Answers its sequence number.",
  input: {
    channel: input.text({ required: true }), entity: input.text({ required: true }), id: input.int(), op: input.text(), actor_id: input.int(),
    /** The frame's type: "changed" unless it's an inbox frame. */
    message: input.text(), kind: input.text(), link: input.text(),
    /** Where inside the record it happened: a message's place in its conversation. */
    at: input.int(),
  },
  stack: [
    s.db.get({ table: change_channel, fieldName: "channel", fieldValue: inp("channel"), output: ["id"], as: "known" }),
    // Outside the transaction: two first writers race here, and a failed insert would abort a transaction it was in.
    s.conditional({ when: expr(ref("known"), "=", c.null()), then: [
      s.try_catch({ try: [s.db.add({ table: change_channel, as: "opened", row: { channel: inp("channel"), last_seq: c.int(0) } })], catch: [] }),
    ] }),
    s.db.transaction({ body: [
      s.db.get({ table: change_channel, fieldName: "channel", fieldValue: inp("channel"), lock: true, output: ["id", "last_seq"], as: "log" }),
      guard.found("log", { message: "No such channel." }),
      s.set_var("seq", withFilters(ref("log.last_seq"), fl.add(c.int(1)))),
      s.db.patch({ table: change_channel, fieldValue: ref("log.id"), data: obj({ last_seq: ref("seq") }) }),
      s.db.add({ table: change_log, as: "entry", row: { channel: inp("channel"), seq: ref("seq"), entity: inp("entity"), entity_id: inp("id"), op: inp("op"), actor_id: inp("actor_id"), at: inp("at") } }),
    ] }),
    s.set_var("frame", c.text("changed")),
    s.conditional({ when: expr(inp("message"), "!=", c.text("")), then: [s.update_var("frame", inp("message"))] }),
    s.realtime.publish({ server: live, channel: inp("channel"), message: ref("frame"),
      data: obj({ entity: inp("entity"), id: inp("id"), op: inp("op"), actor_id: inp("actor_id"), seq: ref("seq"), kind: inp("kind"), link: inp("link"), at: inp("at") }) }),
  ],
  response: ref("seq"),
});

/** Whether someone may read a channel's log: the same answer as joining it. The id must read back unchanged. */
export const canFollow = defineFunction({
  name: "changes/can_follow",
  description: "Whether an actor may follow a live channel.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), channel: input.text({ required: true }) },
  stack: [
    s.set_var("allowed", c.bool(false)),
    s.conditional({
      when: expr(inp("channel"), "=", c.text("crm")),
      then: [
        s.function.run({ fn: accessRule, as: "crm_reach", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
        s.update_var("allowed", ref("crm_reach")),
      ],
      else: [
        s.set_var("parts", withFilters(inp("channel"), fl.split("/"))),
        s.conditional({ when: expr(withFilters(ref("parts"), fl.count()), "=", c.int(2)), then: [
          s.set_var("id_text", withFilters(ref("parts"), fl.last())),
          s.set_var("id", withFilters(ref("id_text"), fl.to_int())),
          s.conditional({ when: expr(withFilters(ref("id"), fl.to_text()), "=", ref("id_text")), then: [
            s.switch({ on: withFilters(ref("parts"), fl.first()), cases: [
              { when: c.text("users"), break: true, body: [s.update_var("allowed", c.expression("$var.id == $input.actor_id"))] },
              { when: c.text("spaces"), break: true, body: [
                s.function.run({ fn: canReach, as: "space_reach", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: c.text("space"), id: ref("id") } }),
                s.update_var("allowed", ref("space_reach")),
              ] },
            ] }),
          ] }),
        ] }),
      ],
    }),
  ],
  response: ref("allowed"),
});

const PAGE = 200;

/** What a client missed. A negative `after` answers only where the channel is now, which is where a new client starts. */
export const readChanges = defineFunction({
  name: "changes/read",
  description: "The entries on a channel after a sequence number, oldest first, and where the channel is now.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), channel: input.text({ required: true }), after: input.int() },
  stack: [
    s.function.run({ fn: canFollow, as: "follows", input: { actor_id: inp("actor_id"), browser: inp("browser"), channel: inp("channel") } }),
    guard.require(expr(ref("follows"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
    s.db.get({ table: change_channel, fieldName: "channel", fieldValue: inp("channel"), output: ["last_seq"], as: "head" }),
    s.set_var("head_seq", c.int(0)),
    s.conditional({ when: expr(ref("head"), "!=", c.null()), then: [s.update_var("head_seq", ref("head.last_seq", { safe: true }))] }),
    s.set_var("items", c.array([])),
    s.conditional({ when: expr(inp("after"), ">=", c.int(0)), then: [
      s.db.query({ table: change_log, where: [cmp(col("channel"), "=", inp("channel")), expr(col("seq"), ">", inp("after"))], sort: [{ sortBy: "seq", dir: "asc" }],
        paging: { per_page: PAGE, metadata: false }, output: ["seq", "entity", "entity_id", "op", "actor_id", "at"], as: "rows" }),
      s.update_var("items", ref("rows")),
    ] }),
  ],
  response: { channel: inp("channel"), seq: ref("head_seq"), items: ref("items") },
});

export const changeFunctions = [recordChange, canFollow, readChanges];
