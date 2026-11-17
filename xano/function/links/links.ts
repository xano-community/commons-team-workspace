// Links between records. Creating one needs reach on both ends and answers not found otherwise. Linking tells nobody:
// only `deliver` puts anything in an inbox.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, or, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { user } from "../../table/user.js";
import { record_link } from "../../table/links/record_link.js";
import { space_member } from "../../table/spaces/space_member.js";
import { conversation } from "../../table/messaging/conversation.js";
import { conversation_member } from "../../table/messaging/conversation_member.js";
import { accessRule, canManage, canReach, NOT_FOUND, reachOf, requireReach } from "../access/reach.js";
import { locate, resolveRecords } from "./records.js";

const who = { actor_id: input.int({ required: true }), browser: input.bool() };
const me = { actor: inp("actor_id"), browser: inp("browser") };
const ARCHIVED = "This space is archived.";
const keyOf = (type: Value, id: Value) => withFilters(type, fl.concat(c.text("-")), fl.concat(id));
const fromIs = (type: Value, id: Value) => [cmp(col("from_type"), "=", type), cmp(col("from_id"), "=", id)];
const pairIs = (toType: Value, toId: Value) => [...fromIs(inp("from_type"), inp("from_id")), cmp(col("to_type"), "=", toType), cmp(col("to_id"), "=", toId)];
/** Who needs to hear: both ends' channels, when the two live apart. A CRM record's is `crm`, so a link to one stays off the shared `app`. */
const tellBothEnds = (id: Value, op: "created" | "deleted") => statements(
  s.conditional({ when: or(expr(ref("source.space_id"), ">", c.int(0)), expr(ref("source.crm"), "=", c.bool(false))), then: [changed({ entity: "record_link", id, op, actor: inp("actor_id"), space: ref("source.space_id") })] }),
  s.conditional({ when: and(expr(ref("target.space_id"), ">", c.int(0)), expr(ref("target.space_id"), "!=", ref("source.space_id"))), then: [changed({ entity: "record_link", id, op, actor: inp("actor_id"), space: ref("target.space_id") })] }),
  s.conditional({ when: or(expr(ref("source.crm"), "=", c.bool(true)), expr(ref("target.crm"), "=", c.bool(true))), then: [changed({ entity: "record_link", id, op, actor: inp("actor_id"), crm: true })] }),
);
/** A body's links changed: the same, from its own side. */
const tellBody = (id: Value) => s.conditional({
  when: expr(ref("source.crm"), "=", c.bool(true)),
  then: [changed({ entity: "record_link", id, op: "updated", actor: inp("actor_id"), crm: true })],
  else: [changed({ entity: "record_link", id, op: "updated", actor: inp("actor_id"), space: ref("source.space_id") })],
});

export const createLink = defineFunction({
  name: "links/create",
  description: "Link one record to another by hand. Adding a pair that exists answers that link, and it stops being the body's to remove.",
  input: { ...who, from_type: input.text({ required: true }), from_id: input.int({ required: true }), to_type: input.text({ required: true }), to_id: input.int({ required: true }) },
  stack: [
    ...requireReach({ ...me, type: inp("from_type"), id: inp("from_id") }),
    ...requireReach({ ...me, type: inp("to_type"), id: inp("to_id") }),
    s.function.run({ fn: locate, as: "source", input: { type: inp("from_type"), id: inp("from_id") } }),
    guard.require(expr(ref("source.archived"), "=", c.bool(false)), { errorType: "badrequest", message: ARCHIVED }),
    s.function.run({ fn: locate, as: "target", input: { type: inp("to_type"), id: inp("to_id") } }),
    s.db.query({ table: record_link, where: pairIs(inp("to_type"), inp("to_id")), returnType: "single", as: "existing" }),
    s.conditional({
      when: expr(ref("existing"), "=", c.null()),
      then: [
        s.db.add({ table: record_link, as: "link", row: {
          from_type: inp("from_type"), from_id: inp("from_id"), to_type: inp("to_type"), to_id: inp("to_id"), origin: c.text("manual"), from_scope: ref("source.scope"), created_by: inp("actor_id"),
        } }),
        ...tellBothEnds(ref("link.id"), "created"),
      ],
      else: [
        s.set_var("existing_id", ref("existing.id", { safe: true })),
        s.db.patch({ table: record_link, fieldValue: ref("existing_id"), data: obj({ origin: c.text("manual") }), as: "link" }),
      ],
    }),
  ],
  response: ref("link"),
});

export const removeLink = defineFunction({
  name: "links/remove",
  description: "Remove a link. Needs reach on both ends, the same as adding one.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: record_link, fieldValue: inp("id"), as: "link" }),
    guard.found("link", { errorType: "notfound", message: NOT_FOUND }),
    ...requireReach({ ...me, type: ref("link.from_type"), id: ref("link.from_id") }),
    ...requireReach({ ...me, type: ref("link.to_type"), id: ref("link.to_id") }),
    s.function.run({ fn: locate, as: "source", input: { type: ref("link.from_type"), id: ref("link.from_id") } }),
    s.function.run({ fn: locate, as: "target", input: { type: ref("link.to_type"), id: ref("link.to_id") } }),
    s.db.del({ table: record_link, fieldValue: inp("id") }),
    ...tellBothEnds(inp("id"), "deleted"),
  ],
  response: { removed: c.bool(true) },
});

/**
 * Links a body to what it mentions. A new target the saver can't reach is skipped: a purged target is too, so a restore never
 * recreates one. A body that's new has nothing else to do, so it stops here, and only an edit can take a link away.
 */
export const addBodyLinks = defineFunction({
  name: "links/add_body",
  description: "Add the links a body's mentions call for.",
  input: { ...who, from_type: input.text({ required: true }), from_id: input.int({ required: true }), targets: input.json() },
  stack: [
    s.function.run({ fn: locate, as: "source", input: { type: inp("from_type"), id: inp("from_id") } }),
    guard.require(expr(ref("source.found"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
    s.set_var("added", c.int(0)),
    s.foreach({ list: inp("targets"), as: "target", body: [
      s.db.query({ table: record_link, where: pairIs(ref("target.type"), ref("target.id")), returnType: "count", as: "linked" }),
      s.conditional({ when: expr(ref("linked"), "=", c.int(0)), then: [
        s.function.run({ fn: canReach, as: "reachable", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: ref("target.type"), id: ref("target.id") } }),
        s.conditional({ when: expr(ref("reachable"), "=", c.bool(true)), then: [
          s.db.add({ table: record_link, as: "made", row: {
            from_type: inp("from_type"), from_id: inp("from_id"), to_type: ref("target.type"), to_id: ref("target.id"), origin: c.text("body"), from_scope: ref("source.scope"), created_by: inp("actor_id"),
          } }),
          s.update_var("added", withFilters(ref("added"), fl.add(c.int(1)))),
        ] }),
      ] }),
    ] }),
    s.conditional({ when: expr(ref("added"), ">", c.int(0)), then: [tellBody(inp("from_id"))] }),
  ],
  response: ref("added"),
});

/**
 * Brings a body's links in line with the mentions in it. Call it after the final save of a body, and after restoring one.
 * It touches only `body` links, so a link added by hand survives an edit. A locked chip someone else wrote is in `targets`, and stays.
 */
export const reconcileLinks = defineFunction({
  name: "links/reconcile",
  description: "Make a body's links match its mentions, leaving links added by hand.",
  input: { ...who, from_type: input.text({ required: true }), from_id: input.int({ required: true }), targets: input.json() },
  stack: [
    s.function.run({ fn: locate, as: "source", input: { type: inp("from_type"), id: inp("from_id") } }),
    guard.require(expr(ref("source.found"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
    s.set_var("removed", c.int(0)),
    s.array.map({ source: inp("targets"), as: "wanted", transform: keyOf(ref("$this.type"), ref("$this.id")) }),
    s.db.query({ table: record_link, where: [...fromIs(inp("from_type"), inp("from_id")), cmp(col("origin"), "=", c.text("body"))], as: "theirs" }),
    s.foreach({ list: ref("theirs"), as: "row", body: [
      s.conditional({ when: expr(withFilters(ref("wanted"), fl.in(keyOf(ref("row.to_type"), ref("row.to_id")))), "=", c.bool(false)), then: [
        s.db.del({ table: record_link, fieldValue: ref("row.id") }),
        s.update_var("removed", withFilters(ref("removed"), fl.add(c.int(1)))),
      ] }),
    ] }),
    s.function.run({ fn: addBodyLinks, as: "added", input: { actor_id: inp("actor_id"), browser: inp("browser"), from_type: inp("from_type"), from_id: inp("from_id"), targets: inp("targets") } }),
    s.conditional({ when: expr(ref("removed"), ">", c.int(0)), then: [tellBody(inp("from_id"))] }),
  ],
  response: { added: ref("added"), removed: ref("removed") },
});

/** A record is gone for good, or a message was deleted: its links go with it, both ways. Body nodes pointing at it read Deleted. */
export const forgetRecord = defineFunction({
  name: "links/forget",
  description: "Remove every link to or from a record that no longer exists.",
  input: { type: input.text({ required: true }), id: input.int({ required: true }) },
  stack: [
    s.db.bulk.delete({ table: record_link, as: "gone", where: or(
      and(cmp(col("from_type"), "=", inp("type")), cmp(col("from_id"), "=", inp("id"))),
      and(cmp(col("to_type"), "=", inp("type")), cmp(col("to_id"), "=", inp("id"))),
    ) }),
  ],
  response: { removed: ref("gone") },
});

const BACKLINKS_A_PAGE = 30;
const FORWARD_AT_MOST = 100;

/** Both sides of a record. What it links to shows locked when out of reach. What links to it is left out, before counting. */
export const listLinks = defineFunction({
  name: "links/list",
  description: "What a record links to, and a page of what links to it, for a viewer who reaches the record.",
  input: { ...who, type: input.text({ required: true }), id: input.int({ required: true }), page: input.int() },
  stack: [
    ...requireReach({ ...me, type: inp("type"), id: inp("id") }),
    reachOf(inp("actor_id"), inp("browser")),
    s.db.query({ table: record_link, where: fromIs(inp("type"), inp("id")), sort: [{ sortBy: "id", dir: "asc" }], paging: { per_page: FORWARD_AT_MOST, metadata: false }, output: ["id", "to_type", "to_id"], as: "out" }),
    s.array.map({ source: ref("out"), as: "out_refs", transform: { type: ref("$this.to_type"), id: ref("$this.to_id"), link_id: ref("$this.id") } }),
    s.function.run({ fn: resolveRecords, as: "forward", input: { actor_id: inp("actor_id"), browser: inp("browser"), items: ref("out_refs") } }),
    s.db.query({ table: record_link, where: [cmp(col("to_type"), "=", inp("type")), cmp(col("to_id"), "=", inp("id")), cmp(col("from_scope"), "in", ref("reach.scopes"))],
      sort: [{ sortBy: "id", dir: "desc" }], paging: { page: inp("page"), per_page: BACKLINKS_A_PAGE, metadata: true, totals: true }, as: "back" }),
    s.array.map({ source: ref("back.items"), as: "back_refs", transform: { type: ref("$this.from_type"), id: ref("$this.from_id"), link_id: ref("$this.id") } }),
    s.function.run({ fn: resolveRecords, as: "backlinks", input: { actor_id: inp("actor_id"), browser: inp("browser"), items: ref("back_refs") } }),
  ],
  response: { forward: ref("forward"), backlinks: ref("backlinks"), backlinks_total: ref("back.itemsTotal"), next_page: ref("back.nextPage") },
});

const AUDIENCE_AT_MOST = 200;

/**
 * Who in the audience can't reach what's being mentioned, and whom the sender may add. Nothing changes here: an add is a
 * separate, visible act by someone who manages that space. A record the sender can't reach isn't reported on at all.
 */
export const mentionCheck = defineFunction({
  name: "links/mention_check",
  description: "Whether mentioning records in a conversation or space needs a warning, who it names, and who the sender may add.",
  input: { ...who, audience_type: input.text({ required: true }), audience_id: input.int({ required: true }), records: input.json() },
  stack: [
    ...requireReach({ ...me, type: inp("audience_type"), id: inp("audience_id") }),
    reachOf(inp("actor_id"), inp("browser")),
    s.set_var("audience_space", inp("audience_id")),
    s.set_var("dm", c.int(0)),
    s.conditional({ when: expr(inp("audience_type"), "=", c.text("conversation")), then: [
      s.db.get({ table: conversation, fieldValue: inp("audience_id"), output: ["kind", "space_id", "dm_id"], as: "place" }),
      s.update_var("audience_space", ref("place.space_id", { safe: true })),
      s.update_var("dm", ref("place.dm_id", { safe: true })),
      s.conditional({ when: expr(ref("place.kind", { safe: true }), "=", c.text("dm")), then: [s.update_var("dm", inp("audience_id"))] }),
    ] }),
    s.conditional({
      when: expr(ref("dm"), ">", c.int(0)),
      then: [
        s.db.query({ table: conversation_member, where: cmp(col("conversation_id"), "=", ref("dm")), paging: { per_page: AUDIENCE_AT_MOST, metadata: false }, output: ["user_id"], as: "rows" }),
        s.array.map({ source: ref("rows"), as: "member_ids", transform: ref("$this.user_id") }),
      ],
      else: [
        s.db.query({ table: space_member, where: cmp(col("space_id"), "=", ref("audience_space")), paging: { per_page: AUDIENCE_AT_MOST, metadata: false }, output: ["user_id"], as: "rows" }),
        s.array.map({ source: ref("rows"), as: "member_ids", transform: ref("$this.user_id") }),
      ],
    }),
    s.db.query({ table: user, where: [cmp(col("id"), "in", ref("member_ids")), cmp(col("id"), "!=", inp("actor_id")), cmp(col("status"), "=", c.text("active"))], sort: [{ sortBy: "name", dir: "asc" }], output: ["id", "name", "kind"], as: "people" }),
    s.set_var("missing", c.array([])),
    s.set_var("missing_ids", c.array([])),
    s.set_var("add", c.array([])),
    s.foreach({ list: inp("records"), as: "record", body: [
      s.function.run({ fn: locate, as: "target", input: { type: withFilters(ref("record.type", { safe: true }), fl.to_text()), id: withFilters(ref("record.id", { safe: true }), fl.to_int()) } }),
      s.conditional({ when: expr(withFilters(ref("reach.scopes"), fl.in(ref("target.scope"))), "=", c.bool(true)), then: [
        s.set_var("outside", c.array([])),
        s.foreach({ list: ref("people"), as: "person", body: [
          s.function.run({ fn: accessRule, as: "reaches", input: { actor_id: ref("person.id"), browser: c.expression('$var.person.kind == "human"'), space_id: ref("target.space_id"), dm_id: ref("target.dm_id"), crm_record: ref("target.crm") } }),
          s.conditional({ when: expr(ref("reaches"), "=", c.bool(false)), then: [
            s.update_var("outside", withFilters(ref("outside"), fl.array_push(ref("person.id")))),
            s.conditional({ when: expr(withFilters(ref("missing_ids"), fl.in(ref("person.id"))), "=", c.bool(false)), then: [
              s.update_var("missing_ids", withFilters(ref("missing_ids"), fl.array_push(ref("person.id")))),
              s.update_var("missing", withFilters(ref("missing"), fl.array_push(ref("person")))),
            ] }),
          ] }),
        ] }),
        s.conditional({ when: and(expr(withFilters(ref("outside"), fl.count()), ">", c.int(0)), expr(ref("target.space_id"), ">", c.int(0)), expr(ref("target.archived"), "=", c.bool(false))), then: [
          s.function.run({ fn: canManage, as: "manages", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: ref("target.space_id") } }),
          s.conditional({ when: expr(ref("manages"), "=", c.bool(true)), then: [
            s.update_var("add", withFilters(ref("add"), fl.array_push(obj({ space_id: ref("target.space_id"), user_ids: ref("outside") })))),
          ] }),
        ] }),
      ] }),
    ] }),
  ],
  response: { warn: c.expression("($var.missing|count) > 0"), missing: ref("missing"), add: ref("add") },
});

export const linkFunctions = [addBodyLinks, createLink, removeLink, reconcileLinks, forgetRecord, listLinks, mentionCheck];
