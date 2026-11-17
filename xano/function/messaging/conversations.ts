// Starting and opening conversations. The routes in query/messages.ts are thin: the rules live here, so an agent's tool can
// run the same ones. Each answers not found before it answers no.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, or, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { notification } from "../../base/tables.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { space } from "../../table/spaces/space.js";
import { space_member } from "../../table/spaces/space_member.js";
import { conversation } from "../../table/messaging/conversation.js";
import { conversation_member } from "../../table/messaging/conversation_member.js";
import { conversation_read } from "../../table/messaging/conversation_read.js";
import { message } from "../../table/messaging/message.js";
import { canCreate, canManage, inReachedSpaces, NOT_FOUND, reachOf, requireReach } from "../access/reach.js";
import { recordChange } from "../links/changes.js";
import { locate, resolveRecords } from "../links/records.js";

const who = { actor_id: input.int({ required: true }), browser: input.bool() };
const me = { actor: inp("actor_id"), browser: inp("browser") };
const ARCHIVED = "This space is archived.";
const MOST_IN_A_DM = 8;
const MOST_LISTED = 500;

/** Binds `conv`, and `home_dm`: the DM it lives in, itself included. */
export const bindHome = (id: Value) => statements(
  s.db.get({ table: conversation, fieldValue: id, as: "conv" }),
  guard.found("conv", { errorType: "notfound", message: NOT_FOUND }),
  s.set_var("home_dm", ref("conv.dm_id")),
  s.conditional({ when: expr(ref("conv.kind"), "=", c.text("dm")), then: [s.update_var("home_dm", ref("conv.id"))] }),
);

/**
 * Tells everyone who reaches a conversation that something in it moved, through the one change path. Ids only: `id` is the
 * conversation and `at` the message's place, and each reader then fetches what it may see. A DM has no channel of its
 * own, so each member hears on theirs. Call it after the write commits.
 */
export const hintChange = defineFunction({
  name: "messages/hint",
  description: "Publish that a conversation changed, on the channels of the people who reach it.",
  input: { entity: input.text({ required: true }), conversation_id: input.int({ required: true }), op: input.text(), at: input.int(), actor_id: input.int() },
  stack: [
    ...bindHome(inp("conversation_id")),
    s.set_var("told", c.array([])),
    s.conditional({
      when: expr(ref("home_dm"), ">", c.int(0)),
      then: [
        s.db.query({ table: conversation_member, where: cmp(col("conversation_id"), "=", ref("home_dm")), output: ["user_id"], as: "members" }),
        s.array.map({ source: ref("members"), as: "member_channels", transform: withFilters(c.text("users/"), fl.concat(ref("$this.user_id"))) }),
        s.update_var("told", ref("member_channels")),
      ],
      else: [s.conditional({
        when: expr(ref("conv.space_id"), ">", c.int(0)),
        then: [s.update_var("told", withFilters(ref("told"), fl.array_push(withFilters(c.text("spaces/"), fl.concat(ref("conv.space_id"))))))],
        else: [s.conditional({ when: expr(ref("conv.crm"), "=", c.bool(true)), then: [s.update_var("told", withFilters(ref("told"), fl.array_push(c.text("crm"))))] })],
      })],
    }),
    s.foreach({ list: ref("told"), as: "channel", body: [
      s.function.run({ fn: recordChange, as: "hint_seq", input: { channel: ref("channel"), entity: inp("entity"), id: inp("conversation_id"), op: inp("op"), actor_id: inp("actor_id"), message: c.text(""), kind: c.text(""), link: c.text(""), at: inp("at") } }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

/** Every channel in a reached space and this person's DMs, with how much of each they haven't read. Threads open from their record. */
export const listConversationsFn = defineFunction({
  name: "conversations/list",
  description: "The channels and DMs an actor reaches, with their unread counts.",
  input: who,
  stack: [
    reachOf(inp("actor_id"), inp("browser")),
    s.db.query({ table: conversation, where: and(or(inReachedSpaces(), cmp(col("id"), "in", ref("reach.dm_ids"))), cmp(col("kind"), "!=", c.text("thread"))),
      sort: [{ sortBy: "name", dir: "asc" }], paging: { per_page: MOST_LISTED, metadata: false }, as: "rows" }),
    s.db.query({ table: conversation_read, where: cmp(col("user_id"), "=", inp("actor_id")), output: ["conversation_id", "last_read_seq"], as: "reads" }),
    s.set_var("read_by", withFilters(ref("reads"), fl.index_by("conversation_id"))),
    s.db.query({ table: notification, output: ["entity_id"], as: "mentions", where: [
      cmp(col("user_id"), "=", inp("actor_id")), cmp(col("entity"), "=", c.text("conversation")), cmp(col("kind"), "=", c.text("mention")), cmp(col("read_at"), "=", c.null()), cmp(col("done_at"), "=", c.null()),
    ] }),
    s.set_var("mention_by", withFilters(ref("mentions"), fl.index_by("entity_id"))),
    s.set_var("member_by", c.obj({})),
    s.conditional({ when: expr(withFilters(ref("reach.dm_ids"), fl.count()), ">", c.int(0)), then: [
      s.db.query({ table: conversation_member, where: cmp(col("conversation_id"), "in", ref("reach.dm_ids")), as: "dm_rows",
        bind: [{ table: user, as: "person", join: "left", where: expr(col("user_id"), "=", col("person.id")) }],
        eval: [{ name: "person.name", as: "name" }, { name: "person.kind", as: "kind" }, { name: "person.status", as: "status" }] }),
      s.update_var("member_by", withFilters(ref("dm_rows"), fl.index_by("conversation_id"))),
    ] }),
    s.set_var("items", c.array([])),
    s.foreach({ list: ref("rows"), as: "row", body: [
      s.set_var("row_reads", withFilters(ref("read_by"), fl.get(ref("row.id")), fl.first_notnull(c.array([])))),
      s.set_var("last_read", c.int(0)),
      s.conditional({ when: expr(withFilters(ref("row_reads"), fl.count()), ">", c.int(0)), then: [s.update_var("last_read", withFilters(ref("row_reads"), fl.first(), fl.get("last_read_seq", 0)))] }),
      s.set_var("unread", c.int(0)),
      // Most conversations are read, so only the ones that aren't pay for a count.
      s.conditional({ when: expr(ref("row.last_seq"), ">", ref("last_read")), then: [
        s.db.query({ table: message, returnType: "count", as: "unread_rows", where: [
          cmp(col("conversation_id"), "=", ref("row.id")), expr(col("seq"), ">", ref("last_read")), cmp(col("author_id"), "!=", inp("actor_id")), cmp(col("deleted_at"), "=", c.null()),
        ] }),
        s.update_var("unread", ref("unread_rows")),
      ] }),
      s.set_var("row_mentions", withFilters(ref("mention_by"), fl.get(ref("row.id")), fl.first_notnull(c.array([])))),
      s.set_var("row_members", withFilters(ref("member_by"), fl.get(ref("row.id")), fl.first_notnull(c.array([])))),
      s.update_var("items", withFilters(ref("items"), fl.array_push(withFilters(ref("row"),
        fl.set("last_read_seq", ref("last_read")), fl.set("unread", ref("unread")), fl.set("mentions", withFilters(ref("row_mentions"), fl.count())), fl.set("members", ref("row_members")))))),
    ] }),
  ],
  response: ref("items"),
});

/** "  Launch Plans! " becomes "launch-plans". Any language's letters stay. */
const channelSlug = (name: Value) => withFilters(withFilters(c.regex(/[^\p{L}\p{N}]+/u), fl.regex_replace(c.text("-"), withFilters(name, fl.lower()))), fl.trim(c.text("-")), fl.substr(c.int(0), c.int(40)));

export const createChannel = defineFunction({
  name: "conversations/create_channel",
  description: "Add a channel to a space. Whoever may create in the space may do this. Agents don't manage channels.",
  input: { ...who, space_id: input.int({ required: true }), name: input.text() },
  stack: [
    ...requireReach({ ...me, type: "space", id: inp("space_id") }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["kind"], as: "actor" }),
    guard.require(and(expr(inp("browser"), "=", c.bool(true)), expr(ref("actor.kind", { safe: true }), "=", c.text("human"))), { errorType: "accessdenied", message: "Only people add channels." }),
    s.db.get({ table: space, fieldValue: inp("space_id"), output: ["archived_at"], as: "home" }),
    guard.found("home", { errorType: "notfound", message: NOT_FOUND }),
    guard.require(expr(ref("home.archived_at"), "=", c.null()), { errorType: "badrequest", message: ARCHIVED }),
    s.function.run({ fn: canCreate, as: "creates", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: inp("space_id") } }),
    guard.require(expr(ref("creates"), "=", c.bool(true)), { errorType: "accessdenied", message: "Guests can't add channels to this space." }),
    s.set_var("slug", channelSlug(inp("name"))),
    guard.require(expr(withFilters(ref("slug"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Name the channel with letters or numbers." }),
    s.set_var("key", withFilters(c.text("channel-"), fl.concat(inp("space_id")), fl.concat(c.text("-")), fl.concat(ref("slug")))),
    s.set_var("taken", withFilters(c.text("There's already a channel called "), fl.concat(ref("slug")), fl.concat(c.text(".")))),
    s.db.query({ table: conversation, where: cmp(col("unique_key"), "=", ref("key")), output: ["id"], returnType: "count", as: "same_name" }),
    s.precondition({ expr: expr(ref("same_name"), "=", c.int(0)), error_type: "badrequest", error: ref("taken") }),
    // Two people naming a channel at once: the unique key lets one through, and the other hears why.
    s.set_var("made_id", c.int(0)),
    s.try_catch({
      try: [
        s.db.add({ table: conversation, as: "made", row: { space_id: inp("space_id"), kind: c.text("channel"), name: ref("slug"), created_by: inp("actor_id"), is_demo: c.bool(false), unique_key: ref("key") } }),
        s.update_var("made_id", ref("made.id")),
      ],
      catch: [],
    }),
    s.precondition({ expr: expr(ref("made_id"), ">", c.int(0)), error_type: "badrequest", error: ref("taken") }),
    changed({ entity: "conversation", id: ref("made_id"), op: "created", verb: "created", actor: inp("actor_id"), space: inp("space_id"),
      link: withFilters(c.text("/chat/"), fl.concat(ref("made_id"))), title: withFilters(c.text("created the channel "), fl.concat(ref("slug"))) }),
    s.db.get({ table: conversation, fieldValue: ref("made_id"), as: "row" }),
  ],
  response: ref("row"),
});

/** Whether two people may talk: a guest knows only the people they share a space with, and the same goes the other way. */
const requireNeighbours = statements(
  s.db.query({ table: space_member, where: cmp(col("user_id"), "=", inp("actor_id")), output: ["space_id"], as: "my_rows" }),
  s.array.map({ source: ref("my_rows"), as: "my_spaces", transform: ref("$this.space_id") }),
  s.set_var("shared", c.int(0)),
  s.conditional({ when: expr(withFilters(ref("my_spaces"), fl.count()), ">", c.int(0)), then: [
    s.db.query({ table: space_member, where: [cmp(col("user_id"), "=", ref("wanted_id")), cmp(col("space_id"), "in", ref("my_spaces"))], returnType: "count", as: "in_common" }),
    s.update_var("shared", ref("in_common")),
  ] }),
  guard.require(expr(ref("shared"), ">", c.int(0)), { errorType: "badrequest", message: "Choose someone you share a space with." }),
);

export const openDm = defineFunction({
  name: "conversations/open_dm",
  description: "Open the DM between an actor and these people, starting it if it's new. The same people always get the same DM.",
  input: { ...who, user_ids: input.list(input.int()) },
  stack: [
    s.set_var("others", withFilters(inp("user_ids"), fl.unique(), fl.array_diff(withFilters(c.array([]), fl.array_push(inp("actor_id")))))),
    guard.require(expr(withFilters(ref("others"), fl.count()), ">=", c.int(1)), { errorType: "badrequest", message: "Choose who to message." }),
    guard.require(expr(withFilters(ref("others"), fl.count()), "<", c.int(MOST_IN_A_DM)), { errorType: "badrequest", message: `A DM holds ${MOST_IN_A_DM} people at most.` }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["role"], as: "actor" }),
    s.foreach({ list: ref("others"), as: "wanted_id", body: [
      s.db.get({ table: user, fieldValue: ref("wanted_id"), output: ["role", "status"], as: "wanted" }),
      guard.require(expr(ref("wanted.status", { safe: true }), "=", c.text("active")), { errorType: "badrequest", message: "Choose a current member." }),
      s.conditional({ when: or(expr(ref("actor.role", { safe: true }), "=", c.text("guest")), expr(ref("wanted.role", { safe: true }), "=", c.text("guest"))), then: [...requireNeighbours] }),
    ] }),
    s.set_var("everyone", withFilters(ref("others"), fl.array_push(inp("actor_id")), fl.sort())),
    s.set_var("key", withFilters(c.text("dm-"), fl.concat(withFilters(ref("everyone"), fl.join("-"))))),
    s.db.query({ table: conversation, where: cmp(col("unique_key"), "=", ref("key")), returnType: "single", as: "existing" }),
    s.conditional({ when: expr(ref("existing"), "=", c.null()), then: [
      // Two people starting the same DM at once: the unique key keeps one, and both end up in it.
      s.try_catch({
        try: [s.db.transaction({ body: [
          s.db.add({ table: conversation, as: "made", row: { kind: c.text("dm"), name: c.text("Direct message"), created_by: inp("actor_id"), is_demo: c.bool(false), unique_key: ref("key") } }),
          s.foreach({ list: ref("everyone"), as: "member_id", body: [s.db.add({ table: conversation_member, as: "joined", row: { conversation_id: ref("made.id"), user_id: ref("member_id") } })] }),
        ] })],
        catch: [],
      }),
    ] }),
    s.db.query({ table: conversation, where: cmp(col("unique_key"), "=", ref("key")), returnType: "single", as: "row" }),
    guard.found("row", { errorType: "notfound", message: NOT_FOUND }),
    s.conditional({ when: expr(ref("existing"), "=", c.null()), then: [
      s.function.run({ fn: hintChange, as: "told", input: { entity: c.text("conversation"), conversation_id: ref("row.id"), op: c.text("created"), at: c.int(0), actor_id: inp("actor_id") } }),
    ] }),
  ],
  response: ref("row"),
});

export const openThread = defineFunction({
  name: "conversations/open_thread",
  description: "Open the thread on a record, starting it if it's new. It's reached exactly as the record is.",
  input: { ...who, record_type: input.text({ required: true }), record_id: input.int({ required: true }) },
  stack: [
    ...requireReach({ ...me, type: inp("record_type"), id: inp("record_id") }),
    s.set_var("key", withFilters(c.text("thread-"), fl.concat(inp("record_type")), fl.concat(c.text("-")), fl.concat(inp("record_id")))),
    s.db.query({ table: conversation, where: cmp(col("unique_key"), "=", ref("key")), returnType: "single", as: "existing" }),
    s.conditional({ when: expr(ref("existing"), "=", c.null()), then: [
      s.function.run({ fn: locate, as: "target", input: { type: inp("record_type"), id: inp("record_id") } }),
      guard.require(expr(ref("target.archived"), "=", c.bool(false)), { errorType: "badrequest", message: ARCHIVED }),
      s.set_var("parent", c.int(0)),
      s.conditional({ when: expr(inp("record_type"), "=", c.text("message")), then: [
        s.db.get({ table: message, fieldValue: inp("record_id"), output: ["conversation_id"], as: "root" }),
        s.update_var("parent", ref("root.conversation_id", { safe: true })),
      ] }),
      s.try_catch({
        try: [s.db.add({ table: conversation, as: "made", row: {
          kind: c.text("thread"), name: c.text("Thread"), created_by: inp("actor_id"), is_demo: c.bool(false), unique_key: ref("key"), record_type: inp("record_type"), record_id: inp("record_id"),
          parent_id: ref("parent"), space_id: ref("target.space_id"), dm_id: ref("target.dm_id"), crm: ref("target.crm"),
        } })],
        catch: [],
      }),
    ] }),
    s.db.query({ table: conversation, where: cmp(col("unique_key"), "=", ref("key")), returnType: "single", as: "row" }),
    guard.found("row", { errorType: "notfound", message: NOT_FOUND }),
    s.conditional({ when: expr(inp("record_type"), "=", c.text("message")), then: [
      s.db.patch({ table: message, fieldValue: inp("record_id"), data: obj({ thread_id: ref("row.id") }) }),
    ] }),
    // Someone with the task open has no thread to follow until they hear there is one.
    s.conditional({ when: and(expr(ref("existing"), "=", c.null()), expr(inp("record_type"), "=", c.text("task"))), then: [
      changed({ entity: "task", id: inp("record_id"), op: "updated", actor: inp("actor_id"), space: ref("row.space_id") }),
    ] }),
    s.conditional({ when: and(expr(ref("existing"), "=", c.null()), expr(inp("record_type"), "=", c.text("doc"))), then: [
      changed({ entity: "doc", id: inp("record_id"), op: "updated", actor: inp("actor_id"), space: ref("row.space_id") }),
    ] }),
    s.conditional({ when: and(expr(ref("existing"), "=", c.null()), expr(ref("row.crm"), "=", c.bool(true))), then: [
      s.conditional({ when: expr(inp("record_type"), "=", c.text("deal")), then: [changed({ entity: "deal", id: inp("record_id"), op: "updated", actor: inp("actor_id"), crm: true })] }),
      s.conditional({ when: expr(inp("record_type"), "=", c.text("company")), then: [changed({ entity: "company", id: inp("record_id"), op: "updated", actor: inp("actor_id"), crm: true })] }),
    ] }),
  ],
  response: ref("row"),
});

/** Binds `people`: the active people a conversation's readers are. A CRM thread's are everyone who holds crm.read. */
const bindPeople = statements(
  s.set_var("ids", c.array([])),
  s.conditional({
    when: expr(ref("home_dm"), ">", c.int(0)),
    then: [
      s.db.query({ table: conversation_member, where: cmp(col("conversation_id"), "=", ref("home_dm")), output: ["user_id"], as: "member_rows" }),
      s.array.map({ source: ref("member_rows"), as: "member_ids", transform: ref("$this.user_id") }),
      s.update_var("ids", ref("member_ids")),
    ],
    else: [s.conditional({ when: expr(ref("conv.space_id"), ">", c.int(0)), then: [
      s.db.query({ table: space_member, where: cmp(col("space_id"), "=", ref("conv.space_id")), output: ["user_id"], as: "member_rows" }),
      s.array.map({ source: ref("member_rows"), as: "member_ids", transform: ref("$this.user_id") }),
      s.update_var("ids", ref("member_ids")),
    ] })],
  }),
  s.conditional({ when: expr(ref("conv.crm"), "=", c.bool(true)), then: [
    s.db.query({ table: user, where: [cmp(col("role"), "in", c.array([...rbac.rolesWith("crm.read")])), cmp(col("status"), "=", c.text("active"))], output: ["id"], paging: { per_page: MOST_LISTED, metadata: false }, as: "crm_rows" }),
    s.array.map({ source: ref("crm_rows"), as: "crm_ids", transform: ref("$this.id") }),
    s.update_var("ids", ref("crm_ids")),
  ] }),
  s.set_var("people", c.array([])),
  s.conditional({ when: expr(withFilters(ref("ids"), fl.count()), ">", c.int(0)), then: [
    s.db.query({ table: user, where: [cmp(col("id"), "in", ref("ids")), cmp(col("status"), "=", c.text("active"))], sort: [{ sortBy: "name", dir: "asc" }], output: ["id", "name", "kind", "status"], paging: { per_page: MOST_LISTED, metadata: false }, as: "found_people" }),
    s.update_var("people", ref("found_people")),
  ] }),
);

export const readPeople = defineFunction({
  name: "conversations/people",
  description: "Who can read a conversation: the people a mention there reaches.",
  input: { ...who, conversation_id: input.int({ required: true }) },
  stack: [...requireReach({ ...me, type: "conversation", id: inp("conversation_id") }), ...bindHome(inp("conversation_id")), ...bindPeople],
  response: ref("people"),
});

export const readDetails = defineFunction({
  name: "conversations/details",
  description: "A conversation, where it lives, and what an actor may do in it.",
  input: { ...who, conversation_id: input.int({ required: true }) },
  stack: [
    ...requireReach({ ...me, type: "conversation", id: inp("conversation_id") }),
    ...bindHome(inp("conversation_id")),
    s.function.run({ fn: locate, as: "place", input: { type: c.text("conversation"), id: inp("conversation_id") } }),
    s.set_var("space_name", c.text("")),
    s.set_var("can_moderate", c.bool(false)),
    s.conditional({ when: expr(ref("place.space_id"), ">", c.int(0)), then: [
      s.db.get({ table: space, fieldValue: ref("place.space_id"), output: ["name"], as: "home" }),
      s.update_var("space_name", ref("home.name", { safe: true })),
      s.function.run({ fn: canManage, as: "manages", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: ref("place.space_id") } }),
      s.update_var("can_moderate", ref("manages")),
    ] }),
    s.db.query({ table: conversation_read, where: [cmp(col("conversation_id"), "=", inp("conversation_id")), cmp(col("user_id"), "=", inp("actor_id"))], output: ["last_read_seq"], returnType: "single", as: "position" }),
    s.set_var("last_read", withFilters(ref("position.last_read_seq", { safe: true }), fl.to_int())),
    s.set_var("members", c.array([])),
    s.conditional({ when: expr(ref("home_dm"), ">", c.int(0)), then: [...bindPeople, s.update_var("members", ref("people"))] }),
    s.set_var("record", c.null()),
    s.conditional({ when: expr(ref("conv.kind"), "=", c.text("thread")), then: [
      s.function.run({ fn: resolveRecords, as: "views", input: { actor_id: inp("actor_id"), browser: inp("browser"),
        items: withFilters(c.array([]), fl.array_push(obj({ type: ref("conv.record_type"), id: ref("conv.record_id") }))) } }),
      s.update_var("record", withFilters(ref("views"), fl.first())),
    ] }),
  ],
  response: {
    conversation: ref("conv"), space_name: ref("space_name"), archived: ref("place.archived"), can_post: c.expression("$var.place.archived == false"), can_moderate: ref("can_moderate"),
    last_read_seq: ref("last_read"), members: ref("members"), record: ref("record"),
  },
});

export const conversationFunctions = [hintChange, listConversationsFn, createChannel, openDm, openThread, readPeople, readDetails];
