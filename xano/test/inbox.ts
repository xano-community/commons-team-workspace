// Workflow tests for the inbox's rules: who gets an item, what reads it, what clears it, and what stays. Each makes its
// own rows. A second tab's count needs a socket, so frontend/scripts/change-path-check.mjs proves the frame itself.
import { c, cmp, col, fl, obj, ref, s, withFilters, workflowTest, type Value } from "@xano/sdk";
import { approvals } from "../approvals.js";
import { clearNotification, listNotifications, readAllNotifications, readNotification, unreadNotifications } from "../base/queries.js";
import { notification } from "../base/tables.js";
import { user } from "../table/user.js";
import { listChanges } from "../query/changes.js";
import { addSpaceMemberRoute, removeSpaceMemberRoute } from "../query/spaces.js";
import { closeItems, deliver } from "../function/inbox/deliver.js";
import { readThrough } from "../function/inbox/read.js";
import { docTable } from "../docs.js";
import { conversation } from "../table/messaging/conversation.js";
import { agent_run } from "../table/agents/agent_run.js";
import { bearer, channel, dm, joined, rowsTest, makeSpace, missesText, notFound, person, personToken, seesText, settings } from "./access.js";

type Item = { to: string; kind: string; title?: string; space?: string; entity?: string; id?: Value; group?: string; seq?: number; actor?: string; as?: string; dmId?: Value };
const give = (o: Item) => s.function.call({ fn: deliver, as: o.as ?? `${o.to}_${o.kind}_${o.seq ?? 0}`, input: {
  user_id: ref(`${o.to}.id`), kind: c.text(o.kind), title: c.text(o.title ?? "Something for you"), link: c.text("/chat/1"), actor_id: o.actor ? ref(`${o.actor}.id`) : c.int(0),
  space_id: o.space ? ref(`${o.space}.id`) : c.int(0), dm_id: o.dmId ?? c.int(0), entity: c.text(o.entity ?? ""), entity_id: o.id ?? c.int(0), group_key: c.text(o.group ?? ""), seq: c.int(o.seq ?? 0),
} });
const list = (token: string, as: string, input: Record<string, Value> = {}) => s.api.call({ api: listNotifications, headers: bearer(token), input, as });
const unread = (token: string, as: string, n: number) => [
  s.api.call({ api: unreadNotifications, headers: bearer(token), as }),
  s.expect.to_equal({ expr: ref(`${as}.count`), value: c.int(n) }),
];
const shows = (name: string, n: number) => s.expect.to_equal({ expr: withFilters(ref(`${name}.items`), fl.count()), value: c.int(n) });
const read = (token: string, id: Value, as: string) => s.api.call({ api: readNotification, headers: bearer(token), input: { id }, as });
const clear = (token: string, id: Value, as: string) => s.api.call({ api: clearNotification, headers: bearer(token), input: { id }, as });
const mention = (to: string, key: string, seq: number, extra: Partial<Item> = {}) => give({ to, kind: "mention", actor: "ada", space: "a", entity: "conversation", id: ref(`${key}.id`), group: `conversation-${key}`, seq, ...extra });

const team = [
  settings(), person("ada"), person("ben"), person("cy"), makeSpace("a"), joined("a", "ada", "manager"), joined("a", "ben"), channel("chat", "a"),
  personToken("ada", "ada_token"), personToken("ben", "ben_token"), personToken("cy", "cy_token"),
];

const agentRow = s.db.add({ table: user, as: "scout", row: { name: c.text("Scout"), email: c.null(), password: c.null(), role: c.text("agent"), kind: c.text("agent"), agent_mode: c.text("hosted"), status: c.text("active"), is_demo: c.bool(false) } });
const aDoc = (as: string, space: string, title: string) => s.db.add({ table: docTable, as, row: { owner_id: ref("ada.id"), title: c.text(title), body: c.obj({ type: "doc", content: [] }), text: c.text(""), visibility: c.text("team"), version: c.int(1), space_id: ref(`${space}.id`), record_type: c.text(""), record_id: c.int(0) } });

const aRun = (as: string, thread: Value, doc: Value) => s.db.add({ table: agent_run, as, row: {
  agent_id: ref("scout.id"), requested_by: ref("ben.id"), source_type: c.text("message"), source_id: c.int(1), space_id: ref("a.id"), status: c.text("done"), attempt: c.int(1), thread_id: thread, conversation_id: ref("chat.id"), doc_id: doc, done_reported: c.bool(true),
} });
const finished = (to: string, run: string) => s.function.call({ fn: deliver, as: `${run}_told`, input: {
  user_id: ref(`${to}.id`), kind: c.text("agent_result"), title: c.text("Scout finished"), link: c.text("/chat/1"), actor_id: ref("scout.id"), space_id: ref("a.id"), dm_id: c.int(0),
  entity: c.text("conversation"), entity_id: ref("chat.id"), group_key: withFilters(c.text("agent-result-"), fl.concat(ref(`${run}.id`))), seq: c.int(1),
} });

export const inboxTests = [
  workflowTest({
    name: "inbox: an agent's line names its record for each reader, stored nowhere, and fresh after a rename",
    stack: [
      ...team, agentRow, aDoc("brief", "a", "Renewal summary"),
      give({ to: "ben", kind: "agent_result", title: "Scout finished", actor: "scout", space: "a", entity: "doc", id: ref("brief.id"), group: "agent-result-1", seq: 1 }),
      list("ben_token", "seen"), shows("seen", 1),
      s.expect.to_equal({ expr: ref("seen.items.0.title"), value: c.text("Scout finished") }),
      s.expect.to_equal({ expr: ref("seen.items.0.actor_kind"), value: c.text("agent") }),
      s.expect.to_equal({ expr: ref("seen.records.0.title"), value: c.text("Renewal summary") }),
      s.db.query({ table: notification, as: "rows" }), missesText("rows", "Renewal summary"),
      s.db.patch({ table: docTable, fieldValue: ref("brief.id"), data: obj({ title: c.text("Renewal notes") }) }),
      list("ben_token", "renamed"),
      s.expect.to_equal({ expr: ref("renamed.records.0.title"), value: c.text("Renewal notes") }),
    ],
  }),
  workflowTest({
    name: "inbox: a record the reader can't reach gives its line no name",
    stack: [
      ...team, agentRow, makeSpace("b"), aDoc("hidden", "b", "Board pay review"),
      give({ to: "ben", kind: "agent_result", title: "Scout finished", actor: "scout", entity: "doc", id: ref("hidden.id"), group: "agent-result-2", seq: 1 }),
      list("ben_token", "seen"), shows("seen", 1),
      s.expect.to_equal({ expr: ref("seen.records.0.state"), value: c.text("locked") }),
      s.expect.to_equal({ expr: ref("seen.records.0.title"), value: c.text("") }),
      missesText("seen", "Board pay review"),
    ],
  }),
  workflowTest({
    name: "inbox: a finished run's line is about the doc it wrote, or else the thread it answered in",
    stack: [
      ...team, agentRow, aDoc("brief", "a", "Renewal summary"),
      aRun("wrote", ref("chat.id"), ref("brief.id")), finished("ben", "wrote"),
      list("ben_token", "seen"),
      s.expect.to_equal({ expr: ref("seen.items.0.entity"), value: c.text("doc") }),
      s.expect.to_equal({ expr: ref("seen.items.0.entity_id"), value: ref("brief.id") }),
      s.expect.to_contain({ expr: ref("seen.items.0.link"), value: c.text("/docs/") }),
      s.expect.to_equal({ expr: ref("seen.records.0.title"), value: c.text("Renewal summary") }),
      s.db.query({ table: notification, as: "rows" }), missesText("rows", "Renewal summary"),
      s.expect.to_equal({ expr: ref("rows.0.entity"), value: c.text("conversation") }),
      aRun("answered", ref("chat.id"), c.int(0)), finished("ada", "answered"),
      list("ada_token", "ada_saw"),
      s.expect.to_equal({ expr: ref("ada_saw.items.0.entity"), value: c.text("conversation") }),
      s.expect.to_equal({ expr: ref("ada_saw.items.0.entity_id"), value: ref("chat.id") }),
    ],
  }),
  workflowTest({
    name: "inbox: a finished run's doc in a space the reader left gives no name",
    stack: [
      ...team, agentRow, makeSpace("b"), aDoc("hidden", "b", "Board pay review"),
      aRun("wrote", ref("chat.id"), ref("hidden.id")), finished("ben", "wrote"),
      list("ben_token", "seen"),
      s.expect.to_equal({ expr: ref("seen.records.0.state"), value: c.text("locked") }),
      missesText("seen", "Board pay review"),
    ],
  }),
  workflowTest({
    name: "inbox: a reply in a doc's thread names the doc, not the word Thread",
    stack: [
      ...team, agentRow, aDoc("brief", "a", "Renewal summary"),
      s.db.add({ table: conversation, as: "thread", row: { kind: c.text("thread"), name: c.text("Thread"), space_id: ref("a.id"), created_by: ref("ada.id"), is_demo: c.bool(false), unique_key: c.text("thread-doc-test"), record_type: c.text("doc"), record_id: ref("brief.id") } }),
      give({ to: "ben", kind: "reply", title: "Scout replied", actor: "scout", space: "a", entity: "conversation", id: ref("thread.id"), group: "doc-thread", seq: 1 }),
      list("ben_token", "seen"),
      s.expect.to_equal({ expr: ref("seen.records.0.title"), value: c.text("Renewal summary") }),
      s.expect.to_contain({ expr: ref("seen.records.0.href"), value: c.text("/docs/") }),
    ],
  }),
  workflowTest({
    name: "inbox: one mention gives one item, however many times it's sent, and never to its author",
    stack: [
      ...team,
      mention("ben", "chat", 4),
      mention("ben", "chat", 4, { as: "retry" }),
      mention("ada", "chat", 4, { as: "own" }),
      list("ben_token", "ben_list"), shows("ben_list", 1),
      s.db.query({ table: notification, returnType: "count", as: "rows" }),
      s.expect.to_equal({ expr: ref("rows"), value: c.int(1) }),
      ...unread("ada_token", "ada_count", 0),
    ],
  }),
  workflowTest({
    name: "inbox: nobody outside a space hears about it, and its row holds no title",
    stack: [
      ...team,
      mention("cy", "chat", 1, { title: "Test ada mentioned you" }),
      mention("ben", "chat", 1, { title: "Test ada mentioned you" }),
      list("cy_token", "cy_list"), shows("cy_list", 0),
      s.db.query({ table: notification, as: "rows" }),
      s.expect.to_equal({ expr: withFilters(ref("rows"), fl.count()), value: c.int(1) }),
      missesText("rows", "Channel chat"), missesText("rows", "Space a"),
      list("ben_token", "ben_list"),
      s.expect.to_equal({ expr: ref("ben_list.records.0.title"), value: c.text("Channel chat") }),
      s.expect.to_equal({ expr: ref("ben_list.items.0.actor_name"), value: c.text("Test ada") }),
    ],
  }),
  workflowTest({
    name: "inbox: ten replies group as one row",
    stack: [
      ...team,
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seq) => mention("ben", "chat", seq)),
      list("ben_token", "grouped"), shows("grouped", 1),
      s.expect.to_equal({ expr: ref("grouped.items.0.group_count"), value: c.int(10) }),
      s.expect.to_equal({ expr: ref("grouped.items.0.seq"), value: c.int(10) }),
      ...unread("ben_token", "count", 1),
      read("ben_token", ref("grouped.items.0.id"), "opened"),
      s.db.query({ table: notification, where: cmp(col("read_at"), "=", c.null()), returnType: "count", as: "left" }),
      s.expect.to_equal({ expr: ref("left"), value: c.int(0) }),
    ],
  }),
  workflowTest({
    name: "inbox: reading in a channel marks the mention read",
    stack: [
      ...team,
      mention("ben", "chat", 3, { group: "thread-a" }), mention("ben", "chat", 5, { group: "thread-b" }),
      ...unread("ben_token", "before", 2),
      s.function.call({ fn: readThrough, as: "through", input: { user_id: ref("ben.id"), conversation_id: ref("chat.id"), seq: c.int(4) } }),
      ...unread("ben_token", "partway", 1),
      s.function.call({ fn: readThrough, as: "through_all", input: { user_id: ref("ben.id"), conversation_id: ref("chat.id"), seq: c.int(5) } }),
      ...unread("ben_token", "after", 0),
      list("ben_token", "still_listed"), shows("still_listed", 2),
    ],
  }),
  workflowTest({
    name: "inbox: a DM leaves when it's read, in the channel or in the inbox",
    stack: [
      ...team,
      ...dm("talk", "ada", "ben"),
      give({ to: "ben", kind: "dm", actor: "ada", entity: "conversation", id: ref("talk.id"), dmId: ref("talk.id"), group: "conversation-talk", seq: 1 }),
      give({ to: "cy", kind: "dm", actor: "ada", entity: "conversation", id: ref("talk.id"), dmId: ref("talk.id"), group: "conversation-talk", seq: 1 }),
      list("cy_token", "outsider"), shows("outsider", 0),
      list("ben_token", "first"), shows("first", 1),
      read("ben_token", ref("first.items.0.id"), "opened"),
      list("ben_token", "gone"), shows("gone", 0),
      give({ to: "ben", kind: "dm", actor: "ada", entity: "conversation", id: ref("talk.id"), dmId: ref("talk.id"), group: "conversation-talk", seq: 2 }),
      s.function.call({ fn: readThrough, as: "through", input: { user_id: ref("ben.id"), conversation_id: ref("talk.id"), seq: c.int(2) } }),
      list("ben_token", "gone_again"), shows("gone_again", 0),
    ],
  }),
  workflowTest({
    name: "inbox: read and done are separate, and each kind clears by its own rule",
    stack: [
      ...team,
      mention("ben", "chat", 1),
      give({ to: "ben", kind: "assigned", actor: "ada", space: "a", entity: "task", id: c.int(9), as: "task_item" }),
      give({ to: "ben", kind: "agent_result", actor: "ada", space: "a", entity: "task", id: c.int(10), as: "result_item" }),
      list("ben_token", "all"), shows("all", 3),
      s.set_var("mention_id", ref("ben_mention_1.id")),
      read("ben_token", ref("mention_id"), "opened"),
      list("ben_token", "after_read"), shows("after_read", 3),
      ...unread("ben_token", "count", 2),
      clear("ben_token", ref("mention_id"), "cleared"),
      list("ben_token", "after_clear"), shows("after_clear", 2),
      clear("ben_token", ref("result_item.id"), "result_cleared"),
      clear("ben_token", ref("task_item.id"), "task_refused"),
      s.expect.to_equal({ expr: ref("task_refused.message"), value: c.text("This one clears on its own.") }),
      s.function.call({ fn: closeItems, as: "reassigned", input: { entity: c.text("task"), entity_id: c.int(9), kind: c.text("assigned"), user_id: ref("ben.id") } }),
      list("ben_token", "empty"), shows("empty", 0),
      s.expect.to_equal({ expr: ref("empty.open"), value: c.int(0) }),
      s.expect.to_equal({ expr: ref("empty.ever"), value: c.int(3) }),
      list("cy_token", "never"), s.expect.to_equal({ expr: ref("never.ever"), value: c.int(0) }),
    ],
  }),
  workflowTest({
    name: "inbox: a withdrawn mention leaves, and the group drops to what's left",
    stack: [
      ...team,
      mention("ben", "chat", 1), mention("ben", "chat", 2), mention("ben", "chat", 3),
      s.function.call({ fn: closeItems, as: "newest_gone", input: { entity: c.text("conversation"), entity_id: ref("chat.id"), kind: c.text("mention"), seq: c.int(3) } }),
      list("ben_token", "two_left"), shows("two_left", 1),
      s.expect.to_equal({ expr: ref("two_left.items.0.group_count"), value: c.int(2) }),
      s.expect.to_equal({ expr: ref("two_left.items.0.seq"), value: c.int(2) }),
      s.function.call({ fn: closeItems, as: "the_rest", input: { entity: c.text("conversation"), entity_id: ref("chat.id"), kind: c.text("mention") } }),
      list("ben_token", "none_left"), shows("none_left", 0),
    ],
  }),
  workflowTest({
    name: "inbox: an approval and an agent's question survive Mark all read",
    stack: [
      ...team,
      mention("ben", "chat", 1),
      give({ to: "ben", kind: "approval", actor: "ada", entity: "approval", id: c.int(0), group: "approval-x", as: "waiting" }),
      give({ to: "ben", kind: "agent_question", actor: "ada", space: "a", entity: "task", id: c.int(2), as: "asking" }),
      give({ to: "ben", kind: "agent_result", actor: "ada", space: "a", entity: "task", id: c.int(3), as: "result" }),
      s.db.patch({ table: notification, fieldValue: ref("waiting.id"), data: obj({ entity: c.text("") }) }),
      s.api.call({ api: readAllNotifications, headers: bearer("ben_token"), as: "marked" }),
      ...unread("ben_token", "left", 2),
      list("ben_token", "needs", { view: c.text("needs") }), shows("needs", 2),
      list("ben_token", "listed"), shows("listed", 4),
      s.expect.to_be_true({ expr: ref("listed.items.0.needs_action") }),
      clear("ben_token", ref("asking.id"), "refused"),
      s.expect.to_equal({ expr: ref("refused.message"), value: c.text("This one clears on its own.") }),
      s.function.call({ fn: closeItems, as: "answered", input: { entity: c.text("task"), entity_id: c.int(2), kind: c.text("agent_question") } }),
      list("ben_token", "after_answer", { view: c.text("needs") }), shows("after_answer", 1),
    ],
  }),
  rowsTest({
    name: "inbox: when one admin decides, the item clears for the others, and an expired one leaves too",
    stack: [
      settings(), person("one", "admin"), person("two", "admin"), person("asker"),
      personToken("one", "one_token"), personToken("two", "two_token"),
      s.db.add({ table: approvals.approval, as: "ask", row: { user_id: ref("asker.id"), source: c.text("mcp"), action: c.text("change_role"), title: c.text("Make Test asker admin"), status: c.text("pending"), approver_roles: c.text(",admin,"), expires_at: c.int(4102444800000) } }),
      s.db.add({ table: approvals.approval, as: "stale", row: { user_id: ref("asker.id"), source: c.text("mcp"), action: c.text("change_role"), title: c.text("Old ask"), status: c.text("pending"), approver_roles: c.text(",admin,"), expires_at: c.int(1000) } }),
      give({ to: "one", kind: "approval", entity: "approval", id: ref("ask.id"), as: "for_one" }),
      give({ to: "two", kind: "approval", entity: "approval", id: ref("ask.id"), as: "for_two" }),
      give({ to: "two", kind: "approval", entity: "approval", id: ref("stale.id"), as: "stale_item" }),
      list("two_token", "before"), shows("before", 1),
      s.api.call({ api: approvals.decline, headers: bearer("one_token"), input: { id: ref("ask.id") }, as: "declined" }),
      s.expect.to_equal({ expr: ref("declined.status"), value: c.text("declined") }),
      list("two_token", "after"), shows("after", 0),
      ...unread("two_token", "count", 0),
      s.db.get({ table: notification, fieldValue: ref("for_two.id"), as: "closed" }),
      s.expect.to_not_be_null({ expr: ref("closed.done_at") }),
    ],
  }),
  workflowTest({
    name: "inbox: a removed person's items hide, count included, and come back when they're re-added",
    stack: [
      ...team,
      mention("ben", "chat", 1),
      s.db.patch({ table: notification, fieldValue: ref("ben_mention_1.id"), data: obj({ title: c.text("Test ada mentioned you") }) }),
      list("ben_token", "before"), shows("before", 1),
      s.api.call({ api: removeSpaceMemberRoute, headers: bearer("ada_token"), input: { id: ref("a.id"), user_id: ref("ben.id") }, as: "removed" }),
      list("ben_token", "hidden"), shows("hidden", 0),
      missesText("hidden", "Test ada"), missesText("hidden", "Channel chat"),
      ...unread("ben_token", "hidden_count", 0),
      read("ben_token", ref("ben_mention_1.id"), "hidden_read"), notFound("hidden_read"),
      s.api.call({ api: readAllNotifications, headers: bearer("ben_token"), as: "marked" }),
      s.api.call({ api: addSpaceMemberRoute, headers: bearer("ada_token"), input: { id: ref("a.id"), user_id: ref("ben.id") }, as: "back" }),
      list("ben_token", "returned"),
      seesText("returned", "Test ada mentioned you"),
      // The mention, unread as it was left, and the note that they were added.
      ...unread("ben_token", "returned_count", 2),
    ],
  }),
  workflowTest({
    name: "inbox: every read tells the person's other tabs, and nobody else reaches an item",
    stack: [
      ...team,
      mention("ben", "chat", 1),
      s.set_var("ben_channel", withFilters(c.text("users/"), fl.concat(ref("ben.id")))),
      s.api.call({ api: listChanges, headers: bearer("ben_token"), input: { channel: ref("ben_channel"), after: c.int(-1) }, as: "head" }),
      read("ada_token", ref("ben_mention_1.id"), "strangers_read"), notFound("strangers_read"),
      clear("ada_token", ref("ben_mention_1.id"), "strangers_clear"), notFound("strangers_clear"),
      read("ben_token", ref("ben_mention_1.id"), "opened"),
      s.api.call({ api: readAllNotifications, headers: bearer("ben_token"), as: "marked" }),
      s.api.call({ api: listChanges, headers: bearer("ben_token"), input: { channel: ref("ben_channel"), after: ref("head.seq") }, as: "told" }),
      s.expect.to_equal({ expr: withFilters(ref("told.items"), fl.count()), value: c.int(2) }),
      s.expect.to_equal({ expr: ref("told.items.0.entity"), value: c.text("notification") }),
      s.expect.to_equal({ expr: ref("told.items.0.op"), value: c.text("read") }),
    ],
  }),
  workflowTest({
    name: "inbox: a space filter narrows the list, and a closed item comes back if the same task returns",
    stack: [
      ...team,
      makeSpace("b"), joined("b", "ben"), channel("other", "b"),
      mention("ben", "chat", 1), mention("ben", "other", 1, { space: "b" }),
      list("ben_token", "scoped", { space_id: ref("b.id") }), shows("scoped", 1),
      s.expect.to_equal({ expr: ref("scoped.items.0.space_id"), value: ref("b.id") }),
      s.expect.to_equal({ expr: ref("scoped.open"), value: c.int(2) }),
      give({ to: "ben", kind: "assigned", actor: "ada", space: "a", entity: "task", id: c.int(9), as: "assigned_first" }),
      s.function.call({ fn: closeItems, as: "reassigned", input: { entity: c.text("task"), entity_id: c.int(9), kind: c.text("assigned"), user_id: ref("ben.id") } }),
      give({ to: "ben", kind: "assigned", actor: "ada", space: "a", entity: "task", id: c.int(9), as: "assigned_again" }),
      s.expect.to_be_true({ expr: ref("assigned_again.delivered") }),
      list("ben_token", "with_task"), shows("with_task", 3),
    ],
  }),
];
