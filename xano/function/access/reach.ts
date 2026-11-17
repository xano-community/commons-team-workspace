// The one access rule. Every endpoint, tool, feed and join gate asks it, and nothing else decides who reaches a record.
//
//   - A DM is read by its members. Nobody passes by role, admins included.
//   - A thread is reached as its record is, and a message as its conversation is.
//   - A human admin in a browser session reaches every space.
//   - Anyone else reaches a space by being a member of it, and an agent's role never stands in for that.
//   - A CRM record needs crm.read, whoever holds it: a person in a browser, an agent, or a connection a person owns. A key or a
//     sign-in otherwise reaches only that person's joined spaces and DMs, even when the person is an admin.
//
// `browser` says the caller holds a person token (bindBrowser). Agent keys, a person's own keys and MCP sign-ins don't.
// A record's links never change who reaches it.
import { and, auth, c, cmp, col, defineFunction, expr, fl, guard, inp, input, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { docTable } from "../../docs.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { space } from "../../table/spaces/space.js";
import { space_member } from "../../table/spaces/space_member.js";
import { conversation } from "../../table/messaging/conversation.js";
import { conversation_member } from "../../table/messaging/conversation_member.js";
import { message } from "../../table/messaging/message.js";
import { project } from "../../table/tasks/project.js";
import { task } from "../../table/tasks/task.js";
import { company } from "../../table/crm/company.js";
import { contact } from "../../table/crm/contact.js";
import { crm_note } from "../../table/crm/crm_note.js";
import { deal } from "../../table/crm/deal.js";
import { file_record } from "../../table/files/file_record.js";
import { PERSON_EXTRAS } from "../members/gate.js";

/** What no access and no such record both answer, so the one can't be told from the other. */
export const NOT_FOUND = "Not found.";

/** Binds `browser`: whether this request carries a person token. Reads the whole extras map, as a missing key is a 500. */
export const bindBrowser = () => statements(
  s.set_var("browser", c.bool(false)),
  s.conditional({
    when: expr(withFilters(auth("extras"), fl.get("kind", "")), "=", c.text(PERSON_EXTRAS.kind)),
    then: [s.update_var("browser", c.bool(true))],
  }),
);

/** Loads `actor`, the row behind `actor_id`. A function's input, so the role and status are always current. */
const loadActor = s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "kind", "role", "status"], as: "actor" });
const actorIsActive = expr(ref("actor.status", { safe: true }), "=", c.text("active"));
/** Binds `oversees`: a human admin in a browser session. Needs `actor`. */
const bindOversees = statements(
  s.set_var("oversees", c.bool(false)),
  s.conditional({
    when: and(expr(inp("browser"), "=", c.bool(true)), expr(ref("actor.kind"), "=", c.text("human"))),
    then: [s.conditional({ when: rbac.has(ref("actor.role"), "space.oversee"), then: [s.update_var("oversees", c.bool(true))] })],
  }),
);

/** The rule itself, for a record already resolved to where it lives. `space_id` beats `crm_record`. */
export const accessRule = defineFunction({
  name: "access/rule",
  description: "Whether an actor reaches a record that lives in a DM, a space, or on a CRM record.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), space_id: input.int(), dm_id: input.int(), crm_record: input.bool() },
  stack: [
    s.set_var("allowed", c.bool(false)),
    loadActor,
    s.conditional({ when: actorIsActive, then: [
      ...bindOversees,
      s.conditional({
        when: expr(inp("dm_id"), ">", c.int(0)),
        then: [
          s.db.query({ table: conversation_member, where: [cmp(col("conversation_id"), "=", inp("dm_id")), cmp(col("user_id"), "=", inp("actor_id"))], returnType: "count", as: "dm_rows" }),
          s.conditional({ when: expr(ref("dm_rows"), ">", c.int(0)), then: [s.update_var("allowed", c.bool(true))] }),
        ],
        else: [s.conditional({
          when: expr(inp("space_id"), ">", c.int(0)),
          then: [
            s.db.query({ table: space_member, where: [cmp(col("space_id"), "=", inp("space_id")), cmp(col("user_id"), "=", inp("actor_id"))], returnType: "count", as: "space_rows" }),
            s.conditional({ when: expr(ref("space_rows"), ">", c.int(0)), then: [s.update_var("allowed", c.bool(true))] }),
            s.conditional({ when: expr(ref("oversees"), "=", c.bool(true)), then: [s.update_var("allowed", c.bool(true))] }),
          ],
          else: [s.conditional({
            when: expr(inp("crm_record"), "=", c.bool(true)),
            then: [s.conditional({ when: rbac.has(ref("actor.role"), "crm.read"), then: [s.update_var("allowed", c.bool(true))] })],
          })],
        })],
      }),
    ] }),
  ],
  response: ref("allowed"),
});

/** A record in the CRM lives in no space: it's enough that the row exists. */
const crmCase = (type: string, table: Parameters<typeof s.db.get>[0]["table"]) => ({ when: c.text(type), break: true, body: [
  s.db.get({ table, fieldValue: inp("id"), output: ["id"], as: "found" }),
  s.conditional({ when: expr(ref("found"), "!=", c.null()), then: [s.update_var("crm", c.bool(true))] }),
] });

/** Finds where a record lives, then asks the rule. An unknown type or a missing row reaches nothing. */
export const canReach = defineFunction({
  name: "access/can_reach",
  description: "Whether an actor reaches one record, by its type and id.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), type: input.text({ required: true }), id: input.int({ required: true }) },
  stack: [
    s.set_var("space_id", c.int(0)),
    s.set_var("dm_id", c.int(0)),
    s.set_var("crm", c.bool(false)),
    s.set_var("conversation_id", c.int(0)),
    s.switch({ on: inp("type"), cases: [
      { when: c.text("space"), break: true, body: [
        s.db.get({ table: space, fieldValue: inp("id"), output: ["id"], as: "found" }),
        s.update_var("space_id", ref("found.id", { safe: true })),
      ] },
      { when: c.text("conversation"), break: true, body: [s.update_var("conversation_id", inp("id"))] },
      { when: c.text("message"), break: true, body: [
        s.db.get({ table: message, fieldValue: inp("id"), output: ["conversation_id"], as: "post" }),
        s.update_var("conversation_id", ref("post.conversation_id", { safe: true })),
      ] },
      { when: c.text("project"), break: true, body: [
        s.db.get({ table: project, fieldValue: inp("id"), output: ["space_id"], as: "found" }),
        s.update_var("space_id", ref("found.space_id", { safe: true })),
      ] },
      { when: c.text("task"), break: true, body: [
        s.db.get({ table: task, fieldValue: inp("id"), output: ["space_id"], as: "found" }),
        s.update_var("space_id", ref("found.space_id", { safe: true })),
      ] },
      { when: c.text("doc"), break: true, body: [
        s.db.get({ table: docTable, fieldValue: inp("id"), output: ["space_id"], as: "found" }),
        s.update_var("space_id", ref("found.space_id", { safe: true })),
      ] },
      { when: c.text("file"), break: true, body: [
        s.db.get({ table: file_record, fieldValue: inp("id"), output: ["space_id", "dm_id", "crm"], as: "found" }),
        s.update_var("space_id", ref("found.space_id", { safe: true })),
        s.update_var("dm_id", ref("found.dm_id", { safe: true })),
        s.update_var("crm", ref("found.crm", { safe: true })),
      ] },
      crmCase("company", company), crmCase("contact", contact), crmCase("deal", deal), crmCase("crm_note", crm_note),
    ] }),
    s.conditional({ when: expr(ref("conversation_id"), ">", c.int(0)), then: [
      s.db.get({ table: conversation, fieldValue: ref("conversation_id"), output: ["id", "kind", "space_id", "dm_id", "crm"], as: "place" }),
      s.conditional({
        when: expr(ref("place.kind", { safe: true }), "=", c.text("dm")),
        then: [s.update_var("dm_id", ref("place.id", { safe: true }))],
        else: [
          s.update_var("space_id", ref("place.space_id", { safe: true })),
          s.update_var("dm_id", ref("place.dm_id", { safe: true })),
          s.update_var("crm", ref("place.crm", { safe: true })),
        ],
      }),
    ] }),
    s.function.run({ fn: accessRule, as: "allowed", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: ref("space_id"), dm_id: ref("dm_id"), crm_record: ref("crm") } }),
  ],
  response: ref("allowed"),
});

/**
 * Whether an actor may join `rooms/<type>-<id>`, the same as reaching that record. The id must read back unchanged,
 * so `space-1x` can't stand in for `space-1` and outlast a kick from the real room.
 */
export const canJoinRoom = defineFunction({
  name: "access/can_join_room",
  description: "Whether an actor may see who else is on a record.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), room: input.text({ required: true }) },
  stack: [
    s.set_var("allowed", c.bool(false)),
    s.set_var("parts", withFilters(inp("room"), fl.split("-"))),
    s.conditional({ when: expr(withFilters(ref("parts"), fl.count()), "=", c.int(2)), then: [
      s.set_var("room_type", withFilters(ref("parts"), fl.first())),
      s.set_var("room_id_text", withFilters(ref("parts"), fl.last())),
      s.set_var("room_id", withFilters(ref("room_id_text"), fl.to_int())),
      s.conditional({ when: expr(withFilters(ref("room_id"), fl.to_text()), "=", ref("room_id_text")), then: [
        s.function.run({ fn: canReach, as: "reachable", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: ref("room_type"), id: ref("room_id") } }),
        s.update_var("allowed", ref("reachable")),
      ] }),
    ] }),
  ],
  response: ref("allowed"),
});

/**
 * Everything an actor reaches, for filtering a list in one query. `feed_ids` are the `space_id`s of the activity they
 * may read: their spaces, plus 0, the workspace's own rows, unless they're a guest. `scopes` says the same of any record,
 * as "space-3", "dm-4" and "crm".
 */
export const reachFn = defineFunction({
  name: "access/reach",
  description: "The space ids, DM ids, activity scopes and record scopes an actor reaches.",
  input: { actor_id: input.int({ required: true }), browser: input.bool() },
  stack: [
    s.set_var("space_ids", c.array([])),
    s.set_var("dm_ids", c.array([])),
    s.set_var("feed_ids", c.array([])),
    s.set_var("scopes", c.array([])),
    loadActor,
    s.conditional({ when: actorIsActive, then: [
      ...bindOversees,
      s.conditional({
        when: expr(ref("oversees"), "=", c.bool(true)),
        then: [
          s.db.query({ table: space, output: ["id"], as: "every_space" }),
          s.array.map({ source: ref("every_space"), as: "mapped_spaces", transform: ref("$this.id") }),
        ],
        else: [
          s.db.query({ table: space_member, where: cmp(col("user_id"), "=", inp("actor_id")), output: ["space_id"], as: "joined" }),
          s.array.map({ source: ref("joined"), as: "mapped_spaces", transform: ref("$this.space_id") }),
        ],
      }),
      s.update_var("space_ids", ref("mapped_spaces")),
      s.update_var("feed_ids", ref("mapped_spaces")),
      s.conditional({ when: expr(ref("actor.role"), "!=", c.text("guest")), then: [s.update_var("feed_ids", withFilters(ref("mapped_spaces"), fl.array_push(c.int(0))))] }),
      s.db.query({ table: conversation_member, where: cmp(col("user_id"), "=", inp("actor_id")), output: ["conversation_id"], as: "dms" }),
      s.array.map({ source: ref("dms"), as: "mapped_dms", transform: ref("$this.conversation_id") }),
      s.update_var("dm_ids", ref("mapped_dms")),
      s.array.map({ source: ref("mapped_spaces"), as: "space_scopes", transform: withFilters(c.text("space-"), fl.concat(ref("$this"))) }),
      s.array.map({ source: ref("mapped_dms"), as: "dm_scopes", transform: withFilters(c.text("dm-"), fl.concat(ref("$this"))) }),
      s.update_var("scopes", withFilters(ref("space_scopes"), fl.array_merge(ref("dm_scopes")))),
      s.function.run({ fn: accessRule, as: "crm_reach", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
      s.conditional({ when: expr(ref("crm_reach"), "=", c.bool(true)), then: [s.update_var("scopes", withFilters(ref("scopes"), fl.array_push(c.text("crm"))))] }),
    ] }),
  ],
  response: { space_ids: ref("space_ids"), dm_ids: ref("dm_ids"), feed_ids: ref("feed_ids"), scopes: ref("scopes") },
});

/** Binds `reach` for this caller: `reachOf(auth("id"), ref("browser"))`, or `reachOf(ref("conn.user_id"))` in an agent tool. */
export const reachOf = (actor: Value, browser: Value = c.bool(false)) => s.function.run({ fn: reachFn, as: "reach", input: { actor_id: actor, browser } });

/** The reusable filter: rows whose `column` is a space in `reach`. An empty list matches nothing. */
export const inReachedSpaces = (column = "space_id") => cmp(col(column), "in", ref("reach.space_ids"));
/** The filter for activity rows, which hold the workspace's own rows beside each space's. */
export const inReachedFeed = () => cmp(col("space_id"), "in", ref("reach.feed_ids"));

/** Answers not found unless `actor` reaches the record. */
export const requireReach = (o: { actor: Value; browser: Value; type: string | Value; id: Value }) => statements(
  s.function.run({ fn: canReach, as: "reachable", input: { actor_id: o.actor, browser: o.browser, type: typeof o.type === "string" ? c.text(o.type) : o.type, id: o.id } }),
  guard.require(expr(ref("reachable"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
);

/** Whether an actor runs a space: its managers, and whoever oversees every space. Only ever a person in a browser. */
export const canManage = defineFunction({
  name: "access/can_manage",
  description: "Whether an actor may change a space and who is in it.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), space_id: input.int({ required: true }) },
  stack: [
    s.set_var("allowed", c.bool(false)),
    loadActor,
    s.conditional({ when: and(actorIsActive, expr(inp("browser"), "=", c.bool(true)), expr(ref("actor.kind", { safe: true }), "=", c.text("human"))), then: [
      ...bindOversees,
      s.db.query({ table: space_member, where: [cmp(col("space_id"), "=", inp("space_id")), cmp(col("user_id"), "=", inp("actor_id")), cmp(col("role"), "=", c.text("manager"))], returnType: "count", as: "managing" }),
      s.conditional({ when: expr(ref("managing"), ">", c.int(0)), then: [s.update_var("allowed", c.bool(true))] }),
      s.conditional({ when: expr(ref("oversees"), "=", c.bool(true)), then: [s.update_var("allowed", c.bool(true))] }),
    ] }),
  ],
  response: ref("allowed"),
});

/** Whether an actor may add tasks and docs to a space: they reach it, it isn't archived, and a guest needs the space's say-so. */
export const canCreate = defineFunction({
  name: "access/can_create",
  description: "Whether an actor may create tasks and docs in a space.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), space_id: input.int({ required: true }) },
  stack: [
    s.set_var("allowed", c.bool(false)),
    s.function.run({ fn: canReach, as: "reachable", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: c.text("space"), id: inp("space_id") } }),
    s.conditional({ when: expr(ref("reachable"), "=", c.bool(true)), then: [
      s.db.get({ table: space, fieldValue: inp("space_id"), output: ["archived_at", "guests_can_create"], as: "target" }),
      loadActor,
      s.conditional({ when: expr(ref("target.archived_at", { safe: true }), "=", c.null()), then: [
        s.conditional({
          when: expr(ref("actor.role", { safe: true }), "=", c.text("guest")),
          then: [s.update_var("allowed", ref("target.guests_can_create", { safe: true }))],
          else: [s.update_var("allowed", c.bool(true))],
        }),
      ] }),
    ] }),
  ],
  response: ref("allowed"),
});

export const accessFunctions = [accessRule, canReach, canJoinRoom, reachFn, canManage, canCreate];
