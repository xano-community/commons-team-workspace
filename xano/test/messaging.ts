// Workflow tests for chat: what a send, an edit and a delete leave behind, who reaches what, and what a retry can't repeat.
// Each makes its own rows. Concurrent senders, frames, typing and scrolling need real requests and real windows, so
// frontend/scripts/chat-check.mjs proves those against a deployed backend.
import { c, fl, obj, ref, s, withFilters, workflowTest, type Value } from "@xano/sdk";
import { notification } from "../base/tables.js";
import { listNotifications } from "../base/queries.js";
import { listChanges } from "../query/changes.js";
import { resolveLinks } from "../query/links.js";
import {
  conversationDetails, conversationPeople, createChannelRoute, deleteMessageRoute, editMessageRoute, listMessages, markReadRoute, openDmRoute, openThreadRoute, postMessageRoute,
} from "../query/messages.js";
import { addSpaceMemberRoute, createSpaceRoute, joinSpaceRoute, listConversations, removeSpaceMemberRoute, updateSpaceRoute } from "../query/spaces.js";
import { record_link } from "../table/links/record_link.js";
import { user } from "../table/user.js";
import { message } from "../table/messaging/message.js";
import { bearer, channel, dm, joined, makeSpace, missesText, notFound, person, personToken, rowsTest, seesText, settings } from "./access.js";

const post = (token: string, key: string, id: string, body: Value | string, as: string) => s.api.call({ api: postMessageRoute, headers: bearer(token), as,
  input: { id: ref(`${key}.id`), client_msg_id: c.text(id), body: typeof body === "string" ? c.text(body) : body } });
const at = (who: string, rest = "") => withFilters(c.text("hello <@"), fl.concat(ref(`${who}.id`)), fl.concat(c.text(`>${rest}`)));
const history = (token: string, key: string, as: string, input: Record<string, Value> = {}) => s.api.call({ api: listMessages, headers: bearer(token), as, input: { id: ref(`${key}.id`), ...input } });
const read = (token: string, key: string, seq: number, as: string) => s.api.call({ api: markReadRoute, headers: bearer(token), as, input: { id: ref(`${key}.id`), seq: c.int(seq) } });
const sidebar = (token: string, as: string) => s.api.call({ api: listConversations, headers: bearer(token), as });
const count = (name: string, n: number) => s.expect.to_equal({ expr: withFilters(ref(name), fl.count()), value: c.int(n) });
const equal = (name: string, value: Value) => s.expect.to_equal({ expr: ref(name), value });
const is = (name: string, n: number) => equal(name, c.int(n));
const inbox = (token: string, as: string) => s.api.call({ api: listNotifications, headers: bearer(token), as });
const shows = (name: string, n: number) => count(`${name}.items`, n);
const says = (name: string, text: string) => equal(`${name}.message`, c.text(text));

/** Ada manages space A, Ben is in it, and Cy is in neither A nor the channel. */
const team = [
  settings(), person("ada"), person("ben"), person("cy"), makeSpace("a"), joined("a", "ada", "manager"), joined("a", "ben"), channel("chat", "a"),
  personToken("ada", "ada_token"), personToken("ben", "ben_token"), personToken("cy", "cy_token"),
];

export const messagingTests = [
  workflowTest({
    name: "messaging: a retry gives one message and one mention, and takes no new place",
    stack: [
      ...team,
      post("ada_token", "chat", "same-id", at("ben"), "first"),
      post("ada_token", "chat", "same-id", at("ben"), "retry"),
      equal("retry.message.id", ref("first.message.id")),
      s.expect.to_be_true({ expr: ref("retry.repeat") }),
      s.expect.to_be_false({ expr: ref("first.repeat") }),
      s.db.query({ table: message, returnType: "count", as: "rows" }), is("rows", 1),
      s.db.query({ table: notification, returnType: "count", as: "items" }), is("items", 1),
      history("ada_token", "chat", "log"), is("log.last_seq", 1),
      post("ada_token", "chat", "next-id", "and again", "second"), is("second.message.seq", 2),
    ],
  }),
  workflowTest({
    name: "messaging: messages take the next place in order, and a page reads oldest first",
    stack: [
      ...team,
      ...[1, 2, 3].map((n) => post("ada_token", "chat", `id-${n}`, `message ${n}`, `sent_${n}`)),
      history("ben_token", "chat", "log"), count("log.items", 3),
      is("log.items.0.seq", 1), is("log.items.2.seq", 3), equal("log.items.2.body", c.text("message 3")), equal("log.items.0.author_name", c.text("Test ada")),
      s.expect.to_be_false({ expr: ref("log.has_older") }),
      history("ben_token", "chat", "older", { before_seq: c.int(3) }), count("older.items", 2), is("older.items.1.seq", 2),
      history("ben_token", "chat", "newer", { after_seq: c.int(1) }), count("newer.items", 2), is("newer.items.0.seq", 2),
      history("ben_token", "chat", "around", { around_seq: c.int(2) }), count("around.items", 3),
    ],
  }),
  workflowTest({
    name: "messaging: nobody outside reads or writes, and it answers the same as nothing there",
    stack: [
      ...team,
      post("ada_token", "chat", "id-1", "inside", "sent"),
      history("cy_token", "chat", "cy_log"), notFound("cy_log"), missesText("cy_log", "inside"),
      post("cy_token", "chat", "id-2", "outside", "cy_sent"), notFound("cy_sent"),
      s.api.call({ api: conversationDetails, headers: bearer("cy_token"), input: { id: ref("chat.id") }, as: "cy_details" }), notFound("cy_details"),
      s.api.call({ api: conversationPeople, headers: bearer("cy_token"), input: { id: ref("chat.id") }, as: "cy_people" }), notFound("cy_people"),
      s.db.query({ table: message, returnType: "count", as: "rows" }), is("rows", 1),
    ],
  }),
  workflowTest({
    name: "messaging: a send after removal ends not found, and the channel stops answering",
    stack: [
      ...team,
      post("ben_token", "chat", "before", "still here", "before"), is("before.message.seq", 1),
      s.api.call({ api: removeSpaceMemberRoute, headers: bearer("ada_token"), input: { id: ref("a.id"), user_id: ref("ben.id") }, as: "removed" }),
      post("ben_token", "chat", "after", "gone now", "after"), notFound("after"),
      history("ben_token", "chat", "log"), notFound("log"),
      history("ada_token", "chat", "ada_log"), count("ada_log.items", 1),
    ],
  }),
  workflowTest({
    name: "messaging: an empty or an overlong message is refused, and an archived space reads but takes no message",
    stack: [
      ...team,
      post("ada_token", "chat", "blank", "   ", "blank"), says("blank", "Write something first."),
      post("ada_token", "chat", "long", "x".repeat(8001), "long"), says("long", "Keep a message under 8000 characters."),
      post("ada_token", "chat", "kept", "last word", "kept"),
      s.api.call({ api: updateSpaceRoute, headers: bearer("ada_token"), input: { id: ref("a.id"), name: c.text("Space a"), visibility: c.text("private"), archived: c.bool(true) }, as: "archived" }),
      post("ada_token", "chat", "late", "too late", "late"), says("late", "This space is archived."),
      history("ben_token", "chat", "log"), count("log.items", 1),
      s.api.call({ api: conversationDetails, headers: bearer("ben_token"), input: { id: ref("chat.id") }, as: "details" }),
      s.expect.to_be_false({ expr: ref("details.can_post") }),
    ],
  }),
  workflowTest({
    name: "messaging: a new joiner starts read at the latest message, and what follows is unread",
    stack: [
      ...team,
      post("ada_token", "chat", "m1", "before you came", "m1"), post("ada_token", "chat", "m2", "still before", "m2"),
      s.api.call({ api: addSpaceMemberRoute, headers: bearer("ada_token"), input: { id: ref("a.id"), user_id: ref("cy.id") }, as: "added" }),
      sidebar("cy_token", "fresh"), is("fresh.0.unread", 0), is("fresh.0.last_read_seq", 2),
      post("ada_token", "chat", "m3", "after you came", "m3"),
      sidebar("cy_token", "later"), is("later.0.unread", 1),
    ],
  }),
  workflowTest({
    name: "messaging: read position moves forward only, stops at the newest, and is each person's own",
    stack: [
      ...team,
      ...[1, 2, 3, 4].map((n) => post("ada_token", "chat", `id-${n}`, `message ${n}`, `sent_${n}`)),
      sidebar("ada_token", "author"), is("author.0.unread", 0),
      sidebar("ben_token", "start"), is("start.0.unread", 4),
      read("ben_token", "chat", 3, "three"), is("three.last_read_seq", 3),
      read("ben_token", "chat", 1, "old_device"), is("old_device.last_read_seq", 3),
      sidebar("ben_token", "after"), is("after.0.unread", 1), is("after.0.last_read_seq", 3),
      read("ben_token", "chat", 99, "beyond"), is("beyond.last_read_seq", 4),
      sidebar("ben_token", "done"), is("done.0.unread", 0),
    ],
  }),
  workflowTest({
    name: "messaging: a deleted message stops counting as unread",
    stack: [
      ...team,
      post("ada_token", "chat", "gone", "never mind", "sent"),
      sidebar("ben_token", "before"), is("before.0.unread", 1),
      s.api.call({ api: deleteMessageRoute, headers: bearer("ada_token"), input: { id: ref("sent.message.id") }, as: "deleted" }),
      sidebar("ben_token", "after"), is("after.0.unread", 0),
    ],
  }),
  rowsTest({
    name: "messaging: a mention reaches who it names and who can read it, and holds no message text",
    stack: [
      ...team,
      post("ada_token", "chat", "id-1", withFilters(at("ben", " and <@"), fl.concat(ref("cy.id")), fl.concat(c.text("> secret plan"))), "sent"),
      inbox("ben_token", "ben_inbox"), shows("ben_inbox", 1),
      equal("ben_inbox.items.0.kind", c.text("mention")), equal("ben_inbox.items.0.title", c.text("Test ada mentioned you")),
      equal("ben_inbox.items.0.seq", ref("sent.message.seq")), equal("ben_inbox.records.0.title", c.text("Channel chat")),
      inbox("cy_token", "cy_inbox"), shows("cy_inbox", 0),
      s.db.query({ table: notification, as: "rows" }), count("rows", 1), missesText("rows", "secret plan"),
      read("ben_token", "chat", 1, "read"),
      s.db.get({ table: notification, fieldValue: ref("rows.0.id"), as: "row" }),
      s.expect.to_not_be_null({ expr: ref("row.read_at") }),
    ],
  }),
  workflowTest({
    name: "messaging: every message in a DM is an inbox item, it leaves on reading, and a channel's plain message is not one",
    stack: [
      ...team,
      ...dm("talk", "ada", "ben"),
      post("ada_token", "chat", "plain", "just talking", "plain"),
      inbox("ben_token", "quiet"), shows("quiet", 0),
      post("ada_token", "talk", "d1", at("ben"), "d1"), post("ada_token", "talk", "d2", "second", "d2"),
      inbox("ben_token", "grouped"), shows("grouped", 1), equal("grouped.items.0.kind", c.text("dm")), is("grouped.items.0.group_count", 2),
      read("ben_token", "talk", 2, "read"),
      inbox("ben_token", "gone"), shows("gone", 0),
    ],
  }),
  workflowTest({
    name: "messaging: only the author edits, and an edit moves the version, mentions the new and withdraws the old",
    stack: [
      ...team,
      person("dee"), joined("a", "dee"), personToken("dee", "dee_token"),
      post("ada_token", "chat", "id-1", at("ben"), "sent"), is("sent.message.version", 1),
      s.api.call({ api: editMessageRoute, headers: bearer("ben_token"), input: { id: ref("sent.message.id"), body: c.text("not yours") }, as: "theirs" }),
      says("theirs", "You can edit only your own messages."),
      s.api.call({ api: editMessageRoute, headers: bearer("ada_token"), input: { id: ref("sent.message.id"), body: at("dee") }, as: "edited" }),
      is("edited.version", 2), s.expect.to_not_be_null({ expr: ref("edited.edited_at") }),
      inbox("ben_token", "ben_inbox"), shows("ben_inbox", 0),
      inbox("dee_token", "dee_inbox"), shows("dee_inbox", 1),
      s.api.call({ api: editMessageRoute, headers: bearer("ada_token"), input: { id: ref("sent.message.id"), body: at("dee", " again") }, as: "twice" }),
      s.db.query({ table: notification, returnType: "count", as: "items" }), is("items", 2),
      history("ben_token", "chat", "since", { after_version: c.int(1) }), count("since.items", 1), is("since.items.0.version", 3),
      equal("since.items.0.seq", ref("sent.message.seq")),
    ],
  }),
  workflowTest({
    name: "messaging: a delete leaves a tombstone with no text, closes its mention and drops its links",
    stack: [
      ...team,
      channel("other", "a"),
      post("ada_token", "chat", "id-1", withFilters(at("ben", " see <#conversation:"), fl.concat(ref("other.id")), fl.concat(c.text("> private words"))), "sent"),
      s.db.query({ table: record_link, returnType: "count", as: "linked" }), is("linked", 1),
      s.api.call({ api: deleteMessageRoute, headers: bearer("ben_token"), input: { id: ref("sent.message.id") }, as: "refused" }),
      says("refused", "You can delete only your own messages."),
      s.api.call({ api: deleteMessageRoute, headers: bearer("ada_token"), input: { id: ref("sent.message.id") }, as: "deleted" }),
      is("deleted.version", 2),
      history("ben_token", "chat", "log"), count("log.items", 1), s.expect.to_not_be_null({ expr: ref("log.items.0.deleted_at") }), missesText("log", "private words"),
      s.db.query({ table: record_link, returnType: "count", as: "unlinked" }), is("unlinked", 0),
      inbox("ben_token", "ben_inbox"), shows("ben_inbox", 0),
      s.api.call({ api: resolveLinks, headers: bearer("ben_token"), input: { items: withFilters(c.array([]), fl.array_push(obj({ type: c.text("message"), id: ref("sent.message.id") }))) }, as: "view" }),
      equal("view.0.state", c.text("tombstone")), equal("view.0.title", c.text("")),
    ],
  }),
  workflowTest({
    name: "messaging: a space's manager may delete anyone's message there, and nobody may in someone else's DM",
    stack: [
      ...team,
      ...dm("talk", "ben", "cy"),
      post("ben_token", "chat", "id-1", "out of line", "sent"),
      s.api.call({ api: deleteMessageRoute, headers: bearer("ada_token"), input: { id: ref("sent.message.id") }, as: "moderated" }), is("moderated.version", 2),
      post("ben_token", "talk", "id-2", "between us", "private"),
      s.api.call({ api: deleteMessageRoute, headers: bearer("ada_token"), input: { id: ref("private.message.id") }, as: "stranger" }), notFound("stranger"),
      s.api.call({ api: deleteMessageRoute, headers: bearer("cy_token"), input: { id: ref("private.message.id") }, as: "other" }), says("other", "You can delete only your own messages."),
    ],
  }),
  rowsTest({
    name: "messaging: a record mention links the record, and a reader outside it sees it locked",
    stack: [
      ...team,
      makeSpace("b"), joined("b", "ada", "manager"), channel("hidden", "b"),
      post("ada_token", "chat", "id-1", withFilters(c.text("see <#conversation:"), fl.concat(ref("hidden.id")), fl.concat(c.text(">"))), "sent"),
      s.db.query({ table: record_link, returnType: "single", as: "link" }),
      equal("link.from_type", c.text("message")), equal("link.to_id", ref("hidden.id")), equal("link.origin", c.text("body")),
      s.api.call({ api: resolveLinks, headers: bearer("ben_token"), input: { items: withFilters(c.array([]), fl.array_push(obj({ type: c.text("conversation"), id: ref("hidden.id") }))) }, as: "view" }),
      equal("view.0.state", c.text("locked")), missesText("view", "Channel hidden"),
      post("ben_token", "chat", "id-2", withFilters(c.text("guess <#conversation:"), fl.concat(ref("hidden.id")), fl.concat(c.text(">"))), "guess"),
      s.db.query({ table: record_link, returnType: "count", as: "links" }), is("links", 1),
    ],
  }),
  workflowTest({
    name: "messaging: frames carry ids only, on the space's channel, and a DM's go to its members",
    stack: [
      ...team,
      ...dm("talk", "ada", "ben"),
      s.set_var("space_channel", withFilters(c.text("spaces/"), fl.concat(ref("a.id")))),
      s.set_var("ben_channel", withFilters(c.text("users/"), fl.concat(ref("ben.id")))),
      post("ada_token", "chat", "id-1", "secret words", "sent"),
      s.api.call({ api: listChanges, headers: bearer("ben_token"), input: { channel: ref("space_channel"), after: c.int(0) }, as: "told" }),
      count("told.items", 1), equal("told.items.0.entity", c.text("message")), equal("told.items.0.entity_id", ref("chat.id")), is("told.items.0.at", 1),
      missesText("told", "secret words"),
      post("ada_token", "talk", "id-2", "whispered", "whisper"),
      s.api.call({ api: listChanges, headers: bearer("ben_token"), input: { channel: ref("ben_channel"), after: c.int(0) }, as: "dm_told" }),
      seesText("dm_told", '"entity":"message"'), missesText("dm_told", "whispered"),
      s.api.call({ api: listChanges, headers: bearer("ben_token"), input: { channel: ref("space_channel"), after: c.int(0) }, as: "space_again" }), count("space_again.items", 1),
    ],
  }),
  workflowTest({
    name: "messaging: a thread is one row per record, is reached as the record is, and counts on its message",
    stack: [
      ...team,
      post("ada_token", "chat", "root", "start here", "root"),
      s.api.call({ api: openThreadRoute, headers: bearer("ben_token"), input: { record_type: c.text("message"), record_id: ref("root.message.id") }, as: "thread" }),
      s.api.call({ api: openThreadRoute, headers: bearer("ada_token"), input: { record_type: c.text("message"), record_id: ref("root.message.id") }, as: "same" }),
      equal("same.id", ref("thread.id")), equal("thread.kind", c.text("thread")), equal("thread.space_id", ref("a.id")),
      s.api.call({ api: openThreadRoute, headers: bearer("cy_token"), input: { record_type: c.text("message"), record_id: ref("root.message.id") }, as: "outsider" }), notFound("outsider"),
      post("ben_token", "thread", "r1", "a reply", "reply"), is("reply.message.seq", 1),
      history("ada_token", "chat", "log"), is("log.items.0.reply_count", 1), equal("log.items.0.thread_id", ref("thread.id")), is("log.items.0.version", 2),
      post("ben_token", "thread", "r1", "a reply", "again"),
      history("ada_token", "chat", "same_log"), is("same_log.items.0.reply_count", 1),
      history("cy_token", "thread", "cy_log"), notFound("cy_log"),
      sidebar("ada_token", "listed"), count("listed", 1),
      s.api.call({ api: removeSpaceMemberRoute, headers: bearer("ada_token"), input: { id: ref("a.id"), user_id: ref("ben.id") }, as: "removed" }),
      post("ben_token", "thread", "r2", "still here?", "late"), notFound("late"),
    ],
  }),
  workflowTest({
    name: "messaging: a thread on a space's record works, and one inside a DM belongs to the DM's members alone",
    stack: [
      ...team,
      person("boss", "admin"), personToken("boss", "boss_token"),
      ...dm("talk", "ada", "ben"),
      s.api.call({ api: openThreadRoute, headers: bearer("ben_token"), input: { record_type: c.text("space"), record_id: ref("a.id") }, as: "on_space" }),
      post("ben_token", "on_space", "s1", "about the space", "on_space_post"), is("on_space_post.message.seq", 1),
      post("ada_token", "talk", "d1", "dm root", "root"),
      s.api.call({ api: openThreadRoute, headers: bearer("ben_token"), input: { record_type: c.text("message"), record_id: ref("root.message.id") }, as: "thread" }),
      post("ben_token", "thread", "t1", "dm reply", "reply"),
      s.api.call({ api: listMessages, headers: bearer("boss_token"), input: { id: ref("thread.id") }, as: "boss_log" }), notFound("boss_log"),
      s.api.call({ api: openThreadRoute, headers: bearer("boss_token"), input: { record_type: c.text("message"), record_id: ref("root.message.id") }, as: "boss_open" }), notFound("boss_open"),
      s.api.call({ api: openThreadRoute, headers: bearer("ben_token"), input: { record_type: c.text("nothing"), record_id: c.int(1) }, as: "unknown" }), notFound("unknown"),
    ],
  }),
  workflowTest({
    name: "messaging: anyone who can create in a space can add a channel, once per name",
    stack: [
      ...team,
      person("gus", "guest"), joined("a", "gus"), personToken("gus", "gus_token"),
      s.api.call({ api: createChannelRoute, headers: bearer("ben_token"), input: { id: ref("a.id"), name: c.text("  Launch Plans! ") }, as: "made" }),
      equal("made.name", c.text("launch-plans")), equal("made.kind", c.text("channel")), equal("made.space_id", ref("a.id")),
      s.api.call({ api: createChannelRoute, headers: bearer("ada_token"), input: { id: ref("a.id"), name: c.text("launch plans") }, as: "again" }),
      says("again", "There's already a channel called launch-plans."),
      s.api.call({ api: createChannelRoute, headers: bearer("ada_token"), input: { id: ref("a.id"), name: c.text("!!!") }, as: "nothing" }),
      says("nothing", "Name the channel with letters or numbers."),
      s.api.call({ api: createChannelRoute, headers: bearer("gus_token"), input: { id: ref("a.id"), name: c.text("mine") }, as: "guest" }),
      says("guest", "Guests can't add channels to this space."),
      s.api.call({ api: createChannelRoute, headers: bearer("cy_token"), input: { id: ref("a.id"), name: c.text("mine") }, as: "outsider" }), notFound("outsider"),
    ],
  }),
  workflowTest({
    name: "messaging: a new space starts with a general channel, and joining it starts read",
    stack: [
      settings(), person("ada"), person("ben"), personToken("ada", "ada_token"), personToken("ben", "ben_token"),
      s.api.call({ api: createSpaceRoute, headers: bearer("ada_token"), input: { name: c.text("Fresh"), visibility: c.text("open") }, as: "fresh" }),
      sidebar("ada_token", "mine"), count("mine", 1), equal("mine.0.name", c.text("general")),
      s.set_var("general", obj({ id: ref("mine.0.id") })),
      post("ada_token", "general", "hello", "hello", "sent"),
      s.api.call({ api: joinSpaceRoute, headers: bearer("ben_token"), input: { id: ref("fresh.id") }, as: "joined" }),
      sidebar("ben_token", "ben_list"), is("ben_list.0.unread", 0),
    ],
  }),
  workflowTest({
    name: "messaging: the same people open the same DM, a guest reaches only their neighbours, and a removed person isn't offered",
    stack: [
      ...team,
      person("gus", "guest"), person("gone"), joined("a", "gus"), personToken("gus", "gus_token"),
      s.db.patch({ table: user, fieldValue: ref("gone.id"), data: obj({ status: c.text("removed") }) }),
      s.api.call({ api: openDmRoute, headers: bearer("ada_token"), input: { user_ids: withFilters(c.array([]), fl.array_push(ref("ben.id"))) }, as: "first" }),
      s.api.call({ api: openDmRoute, headers: bearer("ben_token"), input: { user_ids: withFilters(c.array([]), fl.array_push(ref("ada.id"))) }, as: "second" }),
      equal("second.id", ref("first.id")), equal("first.kind", c.text("dm")),
      s.api.call({ api: openDmRoute, headers: bearer("gus_token"), input: { user_ids: withFilters(c.array([]), fl.array_push(ref("ben.id"))) }, as: "neighbour" }), equal("neighbour.kind", c.text("dm")),
      s.api.call({ api: openDmRoute, headers: bearer("gus_token"), input: { user_ids: withFilters(c.array([]), fl.array_push(ref("cy.id"))) }, as: "stranger" }), says("stranger", "Choose someone you share a space with."),
      s.api.call({ api: openDmRoute, headers: bearer("ada_token"), input: { user_ids: c.array([]) }, as: "nobody" }), says("nobody", "Choose who to message."),
      s.api.call({ api: openDmRoute, headers: bearer("ada_token"), input: { user_ids: withFilters(c.array([]), fl.array_push(ref("gone.id"))) }, as: "left" }), says("left", "Choose a current member."),
    ],
  }),
];
