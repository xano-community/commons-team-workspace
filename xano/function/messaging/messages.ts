// A message's life. Sending locks the conversation, takes the next place, inserts, commits, and only then tells anyone, so
// numbers commit in order and a reader who has seen N can never later find N-1. Everything after the commit runs once:
// a repeat of `client_msg_id` answers the row it made and stops there, so a retry can't mention anyone twice or start
// a second agent run. Call these with `browser` from the caller, so an agent's tool meets the same rules.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { user } from "../../table/user.js";
import { conversation } from "../../table/messaging/conversation.js";
import { conversation_member } from "../../table/messaging/conversation_member.js";
import { conversation_read } from "../../table/messaging/conversation_read.js";
import { message } from "../../table/messaging/message.js";
import { task } from "../../table/tasks/task.js";
import { company } from "../../table/crm/company.js";
import { deal } from "../../table/crm/deal.js";
import { accessRule, canManage, NOT_FOUND, requireReach } from "../access/reach.js";
import { closeItems, deliverAsk } from "../inbox/deliver.js";
import { readThrough } from "../inbox/read.js";
import { recordChange } from "../links/changes.js";
import { requireMessageFiles } from "../files/files.js";
import { addBodyLinks, createLink, forgetRecord, reconcileLinks } from "../links/links.js";
import { locate } from "../links/records.js";
import { bindHome, hintChange } from "./conversations.js";

const who = { actor_id: input.int({ required: true }), browser: input.bool() };
const me = { actor: inp("actor_id"), browser: inp("browser") };
const ARCHIVED = "This space is archived.";
const LONGEST = 8000;
const A_PAGE = 50;
const CHANGES_AT_ONCE = 200;
const MOST_MENTIONS = 20;
const MOST_IN_A_THREAD = 200;

/** Binds `files`, what the message carries, and asks that a message with no words has at least that. */
const bodyOrFiles = statements(
  s.set_var("files", withFilters(inp("file_ids"), fl.first_notempty(c.array([])))),
  guard.require(expr(withFilters(inp("body"), fl.strlen(), fl.add(withFilters(ref("files"), fl.count()))), ">=", c.int(1)), { errorType: "badrequest", message: "Write something first." }),
  guard.require(expr(withFilters(inp("body"), fl.strlen()), "<=", c.int(LONGEST)), { errorType: "badrequest", message: `Keep a message under ${LONGEST} characters.` }),
);
const bodyRules = statements(
  guard.require(expr(withFilters(inp("body"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Write something first." }),
  guard.require(expr(withFilters(inp("body"), fl.strlen()), "<=", c.int(LONGEST)), { errorType: "badrequest", message: `Keep a message under ${LONGEST} characters.` }),
);
const requireOpen = (conversationId: Value) => statements(
  s.function.run({ fn: locate, as: "place", input: { type: c.text("conversation"), id: conversationId } }),
  guard.require(expr(ref("place.archived"), "=", c.bool(false)), { errorType: "badrequest", message: ARCHIVED }),
);
const indexed = (id: Value) => s.function.run({ fn: "search/index", as: "indexed", input: { type: c.text("message"), id } });
const hint = (op: string, conversationId: Value, at: Value) => s.function.run({ fn: hintChange, as: "hinted", input: { entity: c.text("message"), conversation_id: conversationId, op: c.text(op), at, actor_id: inp("actor_id") } });

/** Who and what a body names. `<@5>` is a person and `<#doc:12>` a record. More than a screenful is a mistake, so the rest are ignored. */
export const readTokens = defineFunction({
  name: "messages/tokens",
  description: "The people and records a message body mentions.",
  input: { body: input.text() },
  stack: [
    s.set_var("people", c.array([])),
    s.set_var("records", c.array([])),
    s.set_var("person_hits", withFilters(c.regex(/<@\d+>/), fl.regex_match_all(inp("body")), fl.first())),
    s.foreach({ list: ref("person_hits"), as: "hit", body: [
      s.update_var("people", withFilters(ref("people"), fl.array_push(withFilters(ref("hit"), fl.trim(c.text("<@>")), fl.to_int())))),
    ] }),
    s.set_var("record_hits", withFilters(c.regex(/<#[a-z_]+:\d+>/), fl.regex_match_all(inp("body")), fl.first())),
    s.foreach({ list: ref("record_hits"), as: "hit", body: [
      s.set_var("parts", withFilters(ref("hit"), fl.trim(c.text("<#>")), fl.split(":"))),
      s.update_var("records", withFilters(ref("records"), fl.array_push(obj({ type: withFilters(ref("parts"), fl.first()), id: withFilters(ref("parts"), fl.last(), fl.to_int()) })))),
    ] }),
  ],
  response: { people: withFilters(ref("people"), fl.unique(), fl.array_slice(c.int(0), c.int(MOST_MENTIONS))), records: withFilters(ref("records"), fl.array_slice(c.int(0), c.int(MOST_MENTIONS))) },
});

/**
 * A reply reaches whoever it concerns: everyone who has spoken in the thread, and whoever its record belongs to. One line a
 * thread, however many replies. Anyone it mentioned already has their item. Needs `conv`, `author_name`, `link` and `home_dm`.
 */
const tellThread = statements(
  s.db.query({ table: message, where: [cmp(col("conversation_id"), "=", inp("conversation_id")), cmp(col("deleted_at"), "=", c.null())], paging: { per_page: MOST_IN_A_THREAD, metadata: false }, sort: [{ sortBy: "seq", dir: "desc" }], output: ["author_id"], as: "spoke" }),
  s.array.map({ source: ref("spoke"), as: "speakers", transform: ref("$this.author_id") }),
  s.set_var("concerned", ref("speakers")),
  s.switch({ on: ref("conv.record_type"), cases: [
    { when: c.text("task"), break: true, body: [
      s.db.get({ table: task, fieldValue: ref("conv.record_id"), output: ["assignee_id", "created_by"], as: "subject" }),
      s.update_var("concerned", withFilters(ref("concerned"), fl.array_push(ref("subject.assignee_id", { safe: true })), fl.array_push(ref("subject.created_by", { safe: true })))),
    ] },
    { when: c.text("message"), break: true, body: [
      s.db.get({ table: message, fieldValue: ref("conv.record_id"), output: ["author_id"], as: "root" }),
      s.update_var("concerned", withFilters(ref("concerned"), fl.array_push(ref("root.author_id", { safe: true })))),
    ] },
    { when: c.text("deal"), break: true, body: [
      s.db.get({ table: deal, fieldValue: ref("conv.record_id"), output: ["owner_id", "created_by"], as: "subject" }),
      s.update_var("concerned", withFilters(ref("concerned"), fl.array_push(ref("subject.owner_id", { safe: true })), fl.array_push(ref("subject.created_by", { safe: true })))),
    ] },
    { when: c.text("company"), break: true, body: [
      s.db.get({ table: company, fieldValue: ref("conv.record_id"), output: ["owner_id", "created_by"], as: "subject" }),
      s.update_var("concerned", withFilters(ref("concerned"), fl.array_push(ref("subject.owner_id", { safe: true })), fl.array_push(ref("subject.created_by", { safe: true })))),
    ] },
  ] }),
  s.foreach({ list: withFilters(ref("concerned"), fl.unique(), fl.array_diff(inp("people"))), as: "person_id", body: [
    s.db.get({ table: user, fieldValue: ref("person_id"), output: ["kind"], as: "person" }),
    s.set_var("person_kind", ref("person.kind", { safe: true })),
    s.set_var("reaches", c.bool(true)),
    s.conditional({ when: expr(ref("conv.crm"), "=", c.bool(true)), then: [
      s.function.run({ fn: accessRule, as: "allowed", input: { actor_id: ref("person_id"), browser: c.expression('$var.person_kind == "human"'), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
      s.update_var("reaches", ref("allowed")),
    ] }),
    s.conditional({ when: expr(ref("reaches"), "=", c.bool(true)), then: [
      s.function.run({ fn: deliverAsk, as: "sent", input: {
        user_id: ref("person_id"), kind: c.text("reply"), title: withFilters(ref("author_name"), fl.concat(c.text(" replied"))), body: c.text(""), link: ref("link"), actor_id: inp("actor_id"),
        space_id: ref("conv.space_id"), dm_id: ref("home_dm"), entity: c.text("conversation"), entity_id: inp("conversation_id"), group_key: withFilters(c.text("reply-"), fl.concat(inp("conversation_id"))), seq: inp("seq"),
      } }),
    ] }),
  ] }),
);

/**
 * One message's inbox items, through `deliver`, which keeps one row per person and message. So this is safe after an
 * edit: someone newly named gets an item, and someone already named gets nothing. A plain channel message reaches nobody.
 */
export const tell = defineFunction({
  name: "messages/tell",
  description: "Put a message's mentions, a DM, or a thread reply, in the inboxes of the people it's for.",
  input: {
    conversation_id: input.int({ required: true }), seq: input.int({ required: true }), actor_id: input.int({ required: true }), people: input.json(),
    /** A new message, not an edit: only a new reply tells a thread's people. */
    fresh: input.bool(),
  },
  stack: [
    ...bindHome(inp("conversation_id")),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["name"], as: "author" }),
    s.set_var("author_name", ref("author.name", { safe: true })),
    s.set_var("link", withFilters(c.text("/chat/"), fl.concat(inp("conversation_id")), fl.concat(c.text("?seq=")), fl.concat(inp("seq")))),
    s.conditional({ when: expr(ref("conv.parent_id"), ">", c.int(0)), then: [
      s.update_var("link", withFilters(c.text("/chat/"), fl.concat(ref("conv.parent_id")), fl.concat(c.text("?thread=")), fl.concat(inp("conversation_id")), fl.concat(c.text("&seq=")), fl.concat(inp("seq")))),
    ] }),
    s.conditional({ when: expr(ref("conv.record_type"), "=", c.text("task")), then: [
      s.update_var("link", withFilters(c.text("/tasks/"), fl.concat(ref("conv.record_id")), fl.concat(c.text("?seq=")), fl.concat(inp("seq")))),
    ] }),
    s.conditional({ when: expr(ref("conv.crm"), "=", c.bool(true)), then: [
      s.function.run({ fn: locate, as: "subject", input: { type: c.text("conversation"), id: inp("conversation_id") } }),
      s.update_var("link", withFilters(ref("subject.href"), fl.concat(c.text("?seq=")), fl.concat(inp("seq")))),
    ] }),
    s.conditional({
      when: expr(ref("conv.kind"), "=", c.text("dm")),
      then: [
        s.db.query({ table: conversation_member, where: [cmp(col("conversation_id"), "=", inp("conversation_id")), cmp(col("user_id"), "!=", inp("actor_id"))], output: ["user_id"], as: "members" }),
        s.foreach({ list: ref("members"), as: "member", body: [
          s.function.run({ fn: deliverAsk, as: "sent", input: {
            user_id: ref("member.user_id"), kind: c.text("dm"), title: withFilters(ref("author_name"), fl.concat(c.text(" sent you a message"))), body: c.text(""), link: ref("link"), actor_id: inp("actor_id"),
            space_id: c.int(0), dm_id: inp("conversation_id"), entity: c.text("conversation"), entity_id: inp("conversation_id"), group_key: c.text(""), seq: inp("seq"),
          } }),
        ] }),
      ],
      else: [
        s.foreach({ list: inp("people"), as: "person_id", body: [
          s.db.get({ table: user, fieldValue: ref("person_id"), output: ["kind"], as: "person" }),
          s.set_var("person_kind", ref("person.kind", { safe: true })),
          s.set_var("reaches", c.bool(true)),
          // `deliver` checks a space or a DM. A CRM thread has neither, so its rule is asked here.
          s.conditional({ when: expr(ref("conv.crm"), "=", c.bool(true)), then: [
            s.function.run({ fn: accessRule, as: "allowed", input: { actor_id: ref("person_id"), browser: c.expression('$var.person_kind == "human"'), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
            s.update_var("reaches", ref("allowed")),
          ] }),
          s.conditional({ when: expr(ref("reaches"), "=", c.bool(true)), then: [
            s.function.run({ fn: deliverAsk, as: "sent", input: {
              user_id: ref("person_id"), kind: c.text("mention"), title: withFilters(ref("author_name"), fl.concat(c.text(" mentioned you"))), body: c.text(""), link: ref("link"), actor_id: inp("actor_id"),
              space_id: ref("conv.space_id"), dm_id: ref("home_dm"), entity: c.text("conversation"), entity_id: inp("conversation_id"), group_key: c.text(""), seq: inp("seq"),
            } }),
          ] }),
        ] }),
        s.conditional({ when: and(expr(ref("conv.kind"), "=", c.text("thread")), expr(inp("fresh"), "=", c.bool(true))), then: [...tellThread] }),
      ],
    }),
  ],
  response: { ok: c.bool(true) },
});

/** Moves a read position forward, and never back: an old device can't undo a new one. Its row is locked, so two tabs take turns. */
export const advanceRead = defineFunction({
  name: "messages/advance_read",
  description: "Move a person's read position forward to a sequence number.",
  input: { user_id: input.int({ required: true }), conversation_id: input.int({ required: true }), seq: input.int({ required: true }) },
  stack: [
    s.db.query({ table: conversation_read, where: [cmp(col("conversation_id"), "=", inp("conversation_id")), cmp(col("user_id"), "=", inp("user_id"))], output: ["id"], returnType: "count", as: "rows" }),
    // Outside the transaction: two first readers race here, and a failed insert would abort a transaction it was in.
    s.conditional({ when: expr(ref("rows"), "=", c.int(0)), then: [
      s.try_catch({ try: [s.db.add({ table: conversation_read, as: "opened", row: { conversation_id: inp("conversation_id"), user_id: inp("user_id"), last_read_seq: c.int(0) } })], catch: [] }),
    ] }),
    s.set_var("moved", c.bool(false)),
    s.set_var("position", c.int(0)),
    s.db.transaction({ body: [
      s.db.query({ table: conversation_read, where: [cmp(col("conversation_id"), "=", inp("conversation_id")), cmp(col("user_id"), "=", inp("user_id"))], output: ["id"], returnType: "single", as: "found" }),
      guard.found("found", { message: "No read position." }),
      s.db.get({ table: conversation_read, fieldValue: ref("found.id"), lock: true, output: ["id", "last_read_seq"], as: "held" }),
      guard.found("held", { message: "No read position." }),
      s.update_var("position", ref("held.last_read_seq")),
      s.conditional({ when: expr(inp("seq"), ">", ref("position")), then: [
        s.db.patch({ table: conversation_read, fieldValue: ref("held.id"), data: obj({ last_read_seq: inp("seq") }) }),
        s.update_var("position", inp("seq")),
        s.update_var("moved", c.bool(true)),
      ] }),
    ] }),
  ],
  response: { last_read_seq: ref("position"), moved: ref("moved") },
});

/** A reply shows on the message it answers, through that conversation's own order, so its readers hear it like any change. */
const countReply = defineFunction({
  name: "messages/count_reply",
  description: "Add a reply to the count on the message a thread hangs from.",
  input: { thread_id: input.int({ required: true }), parent_id: input.int({ required: true }), message_id: input.int({ required: true }), actor_id: input.int() },
  stack: [
    s.db.transaction({ body: [
      s.db.get({ table: conversation, fieldValue: inp("parent_id"), lock: true, output: ["id", "last_version"], as: "parent" }),
      guard.found("parent", { message: "No such conversation." }),
      s.db.get({ table: message, fieldValue: inp("message_id"), output: ["seq", "reply_count"], as: "root" }),
      guard.found("root", { message: "No such message." }),
      s.set_var("version", withFilters(ref("parent.last_version"), fl.add(c.int(1)))),
      s.db.patch({ table: conversation, fieldValue: inp("parent_id"), data: obj({ last_version: ref("version") }) }),
      s.db.patch({ table: message, fieldValue: inp("message_id"), data: obj({ reply_count: withFilters(ref("root.reply_count"), fl.add(c.int(1))), thread_id: inp("thread_id"), last_reply_at: c.now(), version: ref("version") }) }),
    ] }),
    hint("updated", inp("parent_id"), ref("root.seq")),
  ],
  response: { ok: c.bool(true) },
});

export const postMessage = defineFunction({
  name: "messages/post",
  description: "Send a message. A repeat of client_msg_id answers the row it made, and does nothing else.",
  input: {
    ...who, conversation_id: input.int({ required: true }), client_msg_id: input.text({ required: true }), body: input.text(), file_ids: input.json(), run_id: input.int(), run_note: input.bool(),
    /** Set on an agent's message: who approved it, the app behind a person's connection, and whether guests wait to see it. */
    approved_by: input.int(), via: input.text(), held: input.bool(),
  },
  stack: [
    ...requireReach({ ...me, type: "conversation", id: inp("conversation_id") }),
    ...requireOpen(inp("conversation_id")),
    ...bodyOrFiles,
    s.function.run({ fn: requireMessageFiles, as: "carried", input: { actor_id: inp("actor_id"), conversation_id: inp("conversation_id"), file_ids: ref("files") } }),
    guard.require(and(expr(withFilters(inp("client_msg_id"), fl.strlen()), ">=", c.int(1)), expr(withFilters(inp("client_msg_id"), fl.strlen()), "<=", c.int(64))), { errorType: "badrequest", message: "This message has no usable id." }),
    s.set_var("repeat", c.bool(true)),
    s.db.transaction({ body: [
      s.db.get({ table: conversation, fieldValue: inp("conversation_id"), lock: true, output: ["id", "last_seq", "last_version"], as: "locked" }),
      guard.found("locked", { errorType: "notfound", message: NOT_FOUND }),
      // Under the lock, so two copies of one send can't both miss each other. Checking first also means no failed insert.
      s.db.query({ table: message, where: [cmp(col("conversation_id"), "=", inp("conversation_id")), cmp(col("client_msg_id"), "=", inp("client_msg_id"))], returnType: "count", as: "copies" }),
      s.conditional({ when: expr(ref("copies"), "=", c.int(0)), then: [
        s.set_var("seq", withFilters(ref("locked.last_seq"), fl.add(c.int(1)))),
        s.set_var("version", withFilters(ref("locked.last_version"), fl.add(c.int(1)))),
        s.db.add({ table: message, as: "made", row: {
          conversation_id: inp("conversation_id"), seq: ref("seq"), version: ref("version"), client_msg_id: inp("client_msg_id"), author_id: inp("actor_id"), body: inp("body"), file_ids: ref("files"), run_id: inp("run_id"), run_note: inp("run_note"), approved_by: inp("approved_by"), via: inp("via"), held: inp("held"), is_demo: c.bool(false),
        } }),
        s.db.patch({ table: conversation, fieldValue: inp("conversation_id"), data: obj({ last_seq: ref("seq"), last_version: ref("version"), last_message_at: c.now() }) }),
        s.update_var("repeat", c.bool(false)),
      ] }),
    ] }),
    s.db.query({ table: message, where: [cmp(col("conversation_id"), "=", inp("conversation_id")), cmp(col("client_msg_id"), "=", inp("client_msg_id"))], returnType: "single", as: "row" }),
    guard.found("row", { errorType: "notfound", message: NOT_FOUND }),
    s.conditional({ when: expr(ref("repeat"), "=", c.bool(false)), then: [
      hint("created", inp("conversation_id"), ref("row.seq")),
      indexed(ref("row.id")),
      s.function.run({ fn: advanceRead, as: "own_read", input: { user_id: inp("actor_id"), conversation_id: inp("conversation_id"), seq: ref("row.seq") } }),
      s.function.run({ fn: readThrough, as: "own_items", input: { user_id: inp("actor_id"), conversation_id: inp("conversation_id"), seq: ref("row.seq") } }),
      // A held note reaches nobody's inbox and links nothing, because guests would see those before they see the note.
      s.conditional({ when: expr(inp("held"), "!=", c.bool(true)), then: [
        s.function.run({ fn: readTokens, as: "named", input: { body: inp("body") } }),
        s.function.run({ fn: tell, as: "told", input: { conversation_id: inp("conversation_id"), seq: ref("row.seq"), actor_id: inp("actor_id"), people: ref("named.people"), fresh: c.bool(true) } }),
        s.function.run({ fn: addBodyLinks, as: "linked", input: { actor_id: inp("actor_id"), browser: inp("browser"), from_type: c.text("message"), from_id: ref("row.id"), targets: ref("named.records") } }),
        s.function.run({ fn: "crm/link_named", as: "linked_customers", input: { actor_id: inp("actor_id"), browser: inp("browser"), conversation_id: inp("conversation_id"), records: ref("named.records") } }),
      ] }),
      ...bindHome(inp("conversation_id")),
      // A file sent in a record's thread sits on that record too, so its Files panel shows it.
      s.foreach({ list: ref("files"), as: "file_id", body: [
        s.function.run({ fn: createLink, as: "on_message", input: { actor_id: inp("actor_id"), browser: inp("browser"), from_type: c.text("file"), from_id: ref("file_id"), to_type: c.text("message"), to_id: ref("row.id") } }),
        s.conditional({ when: expr(withFilters(c.array(["task", "doc", "company", "contact", "deal"]), fl.in(ref("conv.record_type"))), "=", c.bool(true)), then: [
          s.function.run({ fn: createLink, as: "on_record", input: { actor_id: inp("actor_id"), browser: inp("browser"), from_type: c.text("file"), from_id: ref("file_id"), to_type: ref("conv.record_type"), to_id: ref("conv.record_id") } }),
        ] }),
      ] }),
      s.conditional({ when: and(expr(ref("conv.parent_id"), ">", c.int(0)), expr(ref("conv.record_type"), "=", c.text("message"))), then: [
        s.function.run({ fn: countReply, as: "counted", input: { thread_id: inp("conversation_id"), parent_id: ref("conv.parent_id"), message_id: ref("conv.record_id"), actor_id: inp("actor_id") } }),
      ] }),
    ] }),
  ],
  response: { message: ref("row"), repeat: ref("repeat") },
});

/** Takes the next version under the conversation's lock, so the highest always wins. Binds `changed_row`. */
const rewrite = (conversationId: Value, id: Value, fields: Record<string, Value>) => s.db.transaction({ body: [
  s.db.get({ table: conversation, fieldValue: conversationId, lock: true, output: ["id", "last_version"], as: "locked" }),
  guard.found("locked", { errorType: "notfound", message: NOT_FOUND }),
  s.set_var("version", withFilters(ref("locked.last_version"), fl.add(c.int(1)))),
  s.db.patch({ table: conversation, fieldValue: conversationId, data: obj({ last_version: ref("version") }) }),
  s.db.patch({ table: message, fieldValue: id, data: obj({ ...fields, version: ref("version") }), as: "changed_row" }),
] });

/** Binds `row`, a message the actor reaches. Anything else is not found. */
const reachableMessage = statements(
  s.db.get({ table: message, fieldValue: inp("id"), as: "row" }),
  guard.found("row", { errorType: "notfound", message: NOT_FOUND }),
  ...requireReach({ ...me, type: "message", id: inp("id") }),
);

export const editMessage = defineFunction({
  name: "messages/edit",
  description: "Change a message's text. Only its author may, and a name taken out of it withdraws that mention.",
  input: { ...who, id: input.int({ required: true }), body: input.text() },
  stack: [
    ...reachableMessage,
    guard.require(expr(ref("row.author_id"), "=", inp("actor_id")), { errorType: "accessdenied", message: "You can edit only your own messages." }),
    guard.require(expr(ref("row.deleted_at"), "=", c.null()), { errorType: "badrequest", message: "This message was deleted." }),
    ...requireOpen(ref("row.conversation_id")),
    ...bodyRules,
    s.function.run({ fn: readTokens, as: "before", input: { body: ref("row.body") } }),
    s.function.run({ fn: readTokens, as: "named", input: { body: inp("body") } }),
    rewrite(ref("row.conversation_id"), inp("id"), { body: inp("body"), edited_at: c.now() }),
    hint("updated", ref("row.conversation_id"), ref("row.seq")),
    indexed(inp("id")),
    s.set_var("withdrawn", withFilters(ref("before.people"), fl.array_diff(ref("named.people")))),
    s.foreach({ list: ref("withdrawn"), as: "person_id", body: [
      s.function.run({ fn: closeItems, as: "closed", input: { entity: c.text("conversation"), entity_id: ref("row.conversation_id"), kind: c.text("mention"), user_id: ref("person_id"), seq: ref("row.seq") } }),
    ] }),
    s.function.run({ fn: tell, as: "told", input: { conversation_id: ref("row.conversation_id"), seq: ref("row.seq"), actor_id: inp("actor_id"), people: ref("named.people"), fresh: c.bool(false) } }),
    s.function.run({ fn: reconcileLinks, as: "linked", input: { actor_id: inp("actor_id"), browser: inp("browser"), from_type: c.text("message"), from_id: inp("id"), targets: ref("named.records") } }),
  ],
  response: ref("changed_row"),
});

export const deleteMessage = defineFunction({
  name: "messages/delete",
  description: "Delete a message: its author, or a manager of its space. The text goes, its place stays, and nothing it said lives on.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...reachableMessage,
    ...bindHome(ref("row.conversation_id")),
    s.set_var("allowed", c.bool(false)),
    s.conditional({ when: expr(ref("row.author_id"), "=", inp("actor_id")), then: [s.update_var("allowed", c.bool(true))] }),
    s.conditional({ when: and(expr(ref("home_dm"), "=", c.int(0)), expr(ref("conv.space_id"), ">", c.int(0))), then: [
      s.function.run({ fn: canManage, as: "manages", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: ref("conv.space_id") } }),
      s.conditional({ when: expr(ref("manages"), "=", c.bool(true)), then: [s.update_var("allowed", c.bool(true))] }),
    ] }),
    guard.require(expr(ref("allowed"), "=", c.bool(true)), { errorType: "accessdenied", message: "You can delete only your own messages." }),
    ...requireOpen(ref("row.conversation_id")),
    s.set_var("result", ref("row")),
    // A second press, or a retry, finds it gone and answers the same row.
    s.conditional({ when: expr(ref("row.deleted_at"), "=", c.null()), then: [
      rewrite(ref("row.conversation_id"), inp("id"), { body: c.text(""), file_ids: c.array([]), deleted_at: c.now() }),
      s.update_var("result", ref("changed_row")),
      hint("deleted", ref("row.conversation_id"), ref("row.seq")),
      indexed(inp("id")),
      s.function.run({ fn: closeItems, as: "mentions_closed", input: { entity: c.text("conversation"), entity_id: ref("row.conversation_id"), kind: c.text("mention"), user_id: c.int(0), seq: ref("row.seq") } }),
      s.function.run({ fn: closeItems, as: "dms_closed", input: { entity: c.text("conversation"), entity_id: ref("row.conversation_id"), kind: c.text("dm"), user_id: c.int(0), seq: ref("row.seq") } }),
      s.function.run({ fn: forgetRecord, as: "forgotten", input: { type: c.text("message"), id: inp("id") } }),
      // Whatever it linked to shows one link fewer. Inside a DM there's nobody to tell: its links are its members' alone.
      s.conditional({ when: expr(ref("conv.space_id"), ">", c.int(0)), then: [changed({ entity: "record_link", id: inp("id"), op: "deleted", actor: inp("actor_id"), space: ref("conv.space_id") })] }),
    ] }),
  ],
  response: ref("result"),
});

export const markRead = defineFunction({
  name: "messages/read",
  description: "Say how far an actor has read. It stops at the newest message, and reads their items up to there.",
  input: { ...who, conversation_id: input.int({ required: true }), seq: input.int({ required: true }) },
  stack: [
    ...requireReach({ ...me, type: "conversation", id: inp("conversation_id") }),
    ...bindHome(inp("conversation_id")),
    s.set_var("target", inp("seq")),
    s.conditional({ when: expr(ref("target"), ">", ref("conv.last_seq")), then: [s.update_var("target", ref("conv.last_seq"))] }),
    s.function.run({ fn: advanceRead, as: "position", input: { user_id: inp("actor_id"), conversation_id: inp("conversation_id"), seq: ref("target") } }),
    s.conditional({ when: expr(ref("position.moved"), "=", c.bool(true)), then: [
      s.function.run({ fn: readThrough, as: "items_read", input: { user_id: inp("actor_id"), conversation_id: inp("conversation_id"), seq: ref("position.last_read_seq") } }),
      // Only this person's other tabs care, so it goes on their own channel.
      s.function.run({ fn: recordChange, as: "told_tabs", input: {
        channel: withFilters(c.text("users/"), fl.concat(inp("actor_id"))), entity: c.text("conversation_read"), id: inp("conversation_id"), op: c.text("updated"), actor_id: inp("actor_id"),
        message: c.text(""), kind: c.text(""), link: c.text(""), at: ref("position.last_read_seq"),
      } }),
    ] }),
  ],
  response: { last_read_seq: ref("position.last_read_seq") },
});

/** A run's held notes reach guests once its result is approved. Each takes the next version, so open screens pick it up. */
export const releaseHeld = defineFunction({
  name: "messages/release_held",
  description: "Show a run's held notes to guests.",
  input: { run_id: input.int({ required: true }), actor_id: input.int() },
  stack: [
    s.db.query({ table: message, where: [cmp(col("run_id"), "=", inp("run_id")), expr(col("held"), "=", c.bool(true))], output: ["id", "conversation_id", "seq"], as: "held_rows" }),
    s.foreach({ list: ref("held_rows"), as: "note", body: [
      rewrite(ref("note.conversation_id"), ref("note.id"), { held: c.bool(false) }),
      hint("updated", ref("note.conversation_id"), ref("note.seq")),
      indexed(ref("note.id")),
    ] }),
  ],
  response: { released: withFilters(ref("held_rows"), fl.count()) },
});

const withAuthor = {
  bind: [
    { table: user, as: "author", join: "left" as const, where: expr(col("author_id"), "=", col("author.id")) },
    { table: user, as: "approver", join: "left" as const, where: expr(col("approved_by"), "=", col("approver.id")) },
  ],
  eval: [{ name: "author.name", as: "author_name" }, { name: "author.kind", as: "author_kind" }, { name: "approver.name", as: "approver_name" }],
};
/** Binds `shown`: what `held` may be for this reader. Guests don't read a run's held notes. */
const bindShown = statements(
  s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["role"], as: "reader" }),
  s.set_var("shown", c.array([true, false])),
  s.conditional({ when: expr(ref("reader.role", { safe: true }), "=", c.text("guest")), then: [s.update_var("shown", c.array([false]))] }),
);
const inThisOne = () => [cmp(col("conversation_id"), "=", inp("conversation_id")), cmp(col("held"), "in", ref("shown"))];
const newestFirst = [{ sortBy: "seq", dir: "desc" as const }];
const oldestFirst = [{ sortBy: "seq", dir: "asc" as const }];

export const readHistory = defineFunction({
  name: "messages/history",
  description: "A page of a conversation, oldest first: the newest, or before, after or around a place, or everything changed since a version.",
  input: { ...who, conversation_id: input.int({ required: true }), before_seq: input.int(), after_seq: input.int(), around_seq: input.int(), after_version: input.int() },
  stack: [
    ...requireReach({ ...me, type: "conversation", id: inp("conversation_id") }),
    ...bindHome(inp("conversation_id")),
    ...bindShown,
    s.set_var("items", c.array([])),
    s.set_var("changes_only", c.bool(false)),
    s.conditional({
      when: expr(inp("after_version"), ">", c.int(0)),
      then: [
        s.db.query({ table: message, where: [...inThisOne(), expr(col("version"), ">", inp("after_version"))], sort: [{ sortBy: "version", dir: "asc" }], paging: { per_page: CHANGES_AT_ONCE, metadata: false }, ...withAuthor, as: "rows" }),
        s.update_var("items", ref("rows")),
        s.update_var("changes_only", c.bool(true)),
      ],
      else: [s.conditional({
        when: expr(inp("before_seq"), ">", c.int(0)),
        then: [
          s.db.query({ table: message, where: [...inThisOne(), expr(col("seq"), "<", inp("before_seq"))], sort: newestFirst, paging: { per_page: A_PAGE, metadata: false }, ...withAuthor, as: "rows" }),
          s.update_var("items", withFilters(ref("rows"), fl.reverse())),
        ],
        else: [s.conditional({
          when: expr(inp("after_seq"), ">", c.int(0)),
          then: [
            s.db.query({ table: message, where: [...inThisOne(), expr(col("seq"), ">", inp("after_seq"))], sort: oldestFirst, paging: { per_page: A_PAGE, metadata: false }, ...withAuthor, as: "rows" }),
            s.update_var("items", ref("rows")),
          ],
          else: [s.conditional({
            when: expr(inp("around_seq"), ">", c.int(0)),
            then: [
              s.db.query({ table: message, where: [...inThisOne(), expr(col("seq"), "<=", inp("around_seq"))], sort: newestFirst, paging: { per_page: A_PAGE / 2, metadata: false }, ...withAuthor, as: "up_to" }),
              s.db.query({ table: message, where: [...inThisOne(), expr(col("seq"), ">", inp("around_seq"))], sort: oldestFirst, paging: { per_page: A_PAGE / 2, metadata: false }, ...withAuthor, as: "after_it" }),
              s.update_var("items", withFilters(withFilters(ref("up_to"), fl.reverse()), fl.array_merge(ref("after_it")))),
            ],
            else: [
              s.db.query({ table: message, where: inThisOne(), sort: newestFirst, paging: { per_page: A_PAGE, metadata: false }, ...withAuthor, as: "rows" }),
              s.update_var("items", withFilters(ref("rows"), fl.reverse())),
            ],
          })],
        })],
      })],
    }),
    s.set_var("has_older", c.bool(false)),
    s.set_var("has_newer", c.bool(false)),
    s.conditional({ when: and(expr(ref("changes_only"), "=", c.bool(false)), expr(withFilters(ref("items"), fl.count()), ">", c.int(0))), then: [
      s.update_var("has_older", c.expression("($var.items|first).seq > 1")),
      s.update_var("has_newer", c.expression("($var.items|last).seq < $var.conv.last_seq")),
    ] }),
  ],
  response: { items: ref("items"), last_seq: ref("conv.last_seq"), last_version: ref("conv.last_version"), has_older: ref("has_older"), has_newer: ref("has_newer") },
});

export const messageFunctions = [readTokens, tell, advanceRead, countReply, postMessage, editMessage, deleteMessage, markRead, releaseHeld, readHistory];
