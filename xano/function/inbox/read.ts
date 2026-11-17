// Reading the inbox. `notification` rows and pending approvals give one list and one count, and every read goes through
// the same filter: an item about a space the reader has left is hidden, not deleted, so it comes back if they return.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, or, obj, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { approvals } from "../../approvals.js";
import { notification } from "../../base/tables.js";
import { user } from "../../table/user.js";
import { agent_run } from "../../table/agents/agent_run.js";
import { NOT_FOUND, inReachedSpaces, reachOf, requireReach } from "../access/reach.js";
import { resolveRecords } from "../links/records.js";
import { inboxFrame, settleGroup } from "./deliver.js";

const who = { actor_id: input.int({ required: true }), browser: input.bool() };
const PAGE = 30;

const mine = () => cmp(col("user_id"), "=", inp("actor_id"));
const inReach = () => or(expr(col("space_id"), "=", c.int(0)), inReachedSpaces());
/** An approval's item lasts as long as the approval can still be decided, so one that expires leaves on its own. */
const stillDecidable = () => or(expr(col("entity"), "!=", c.text("approval")), cmp(col("entity_id"), "in", ref("decidable")));
const bindFilters = () => statements(
  reachOf(inp("actor_id"), inp("browser")),
  s.db.query({ table: approvals.approval, where: [cmp(col("status"), "=", c.text("pending")), expr(col("expires_at"), ">", c.now())], output: ["id"], as: "pending" }),
  s.array.map({ source: ref("pending"), as: "decidable", transform: ref("$this.id") }),
);
/** The inbox's lines. */
const lines = () => [mine(), cmp(col("done_at"), "=", c.null()), expr(col("head"), "=", c.bool(true)), inReach(), stillDecidable()];

/** Binds `n`, this person's item. Anyone else's, and one they can't reach any more, is not found. */
const ownItem = (id: Value) => statements(
  s.db.get({ table: notification, fieldValue: id, as: "n" }),
  guard.found("n", { errorType: "notfound", message: NOT_FOUND }),
  guard.require(expr(ref("n.user_id"), "=", inp("actor_id")), { errorType: "notfound", message: NOT_FOUND }),
  reachOf(inp("actor_id"), inp("browser")),
  s.conditional({ when: expr(ref("n.space_id"), ">", c.int(0)), then: [
    guard.require(expr(withFilters(ref("reach.space_ids"), fl.in(ref("n.space_id"))), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
  ] }),
);

/** Marks `rows` read. A DM has done its job once it's read, so it leaves too. */
const markRead = (rows: string) => statements(
  s.array.map({ source: ref(rows), as: "reading", transform: { id: ref("$this.id"), read_at: c.now() } }),
  s.db.bulk.patch({ table: notification, items: ref("reading"), as: "marked" }),
);
const leaveIfDm = (rows: string, tag: string) => statements(
  s.set_var(`${tag}_dms`, withFilters(ref(rows), fl.array_filter(c.obj({ kind: "dm" })))),
  s.foreach({ list: ref(`${tag}_dms`), as: "row", body: [
    s.db.patch({ table: notification, fieldValue: ref("row.id"), data: obj({ done_at: c.now(), head: c.bool(false) }) }),
    s.function.run({ fn: settleGroup, as: "settled", input: { user_id: ref("row.user_id"), group_key: ref("row.group_key") } }),
  ] }),
);
const unreadCols = ["id", "kind", "user_id", "group_key"] as const;

/**
 * A finished run's line was written about where it was asked. Reading it, what it made matters more: the doc it wrote, or else the
 * thread it answered in, so it sits with those replies. Read here, so the row stays free of any record's name and the resolver
 * still decides what this reader may see. The run's id is in the line's group key.
 */
const aboutItsWork = statements(
  s.conditional({ when: expr(ref("row.kind"), "=", c.text("agent_result")), then: [
    s.db.get({ table: agent_run, fieldValue: withFilters(ref("row.group_key"), fl.string_replace("agent-result-", ""), fl.to_int()), output: ["doc_id", "thread_id"], as: "run" }),
    s.set_var("made_doc", withFilters(ref("run.doc_id", { safe: true }), fl.to_int())),
    s.set_var("answered_in", withFilters(ref("run.thread_id", { safe: true }), fl.to_int())),
    s.conditional({
      when: expr(ref("made_doc"), ">", c.int(0)),
      then: [s.update_var("row", withFilters(ref("row"), fl.set("entity", c.text("doc")), fl.set("entity_id", ref("made_doc")), fl.set("link", withFilters(c.text("/docs/"), fl.concat(ref("made_doc"))))))],
      else: [s.conditional({ when: expr(ref("answered_in"), ">", c.int(0)), then: [s.update_var("row", withFilters(ref("row"), fl.set("entity", c.text("conversation")), fl.set("entity_id", ref("answered_in"))))] })],
    }),
  ] }),
);

export const listInbox = defineFunction({
  name: "inbox/list",
  description: "A page of a person's inbox, what needs a decision first, with its records resolved for them.",
  input: { ...who, view: input.enum(["all", "unread", "needs"]), space_id: input.int(), page: input.int() },
  stack: [
    ...bindFilters(),
    s.conditional({
      when: expr(inp("view"), "=", c.text("unread")),
      then: [page([cmp(col("read_at"), "=", c.null())])],
      else: [s.conditional({
        when: expr(inp("view"), "=", c.text("needs")),
        then: [page([expr(col("needs_action"), "=", c.bool(true))])],
        else: [page([])],
      })],
    }),
    s.db.query({ table: notification, where: lines(), returnType: "count", as: "open" }),
    s.db.query({ table: notification, where: [mine(), inReach()], returnType: "count", as: "ever" }),
    s.set_var("lines", c.array([])),
    s.set_var("wanted", c.array([])),
    s.foreach({ list: ref("rows.items"), as: "row", body: [
      ...aboutItsWork,
      s.update_var("lines", withFilters(ref("lines"), fl.array_push(ref("row")))),
      s.conditional({ when: expr(withFilters(ref("row.entity"), fl.strlen()), ">", c.int(0)), then: [
        s.conditional({ when: expr(ref("row.entity"), "!=", c.text("approval")), then: [
          s.update_var("wanted", withFilters(ref("wanted"), fl.array_push(c.expression('{"type": $var.row.entity, "id": $var.row.entity_id}')))),
        ] }),
      ] }),
    ] }),
    s.function.run({ fn: resolveRecords, as: "records", input: { actor_id: inp("actor_id"), browser: inp("browser"), items: ref("wanted") } }),
  ],
  response: {
    items: ref("lines"), curPage: ref("rows.curPage"), nextPage: ref("rows.nextPage"), prevPage: ref("rows.prevPage"), itemsTotal: ref("rows.itemsTotal"), pageTotal: ref("rows.pageTotal"),
    open: ref("open"), ever: ref("ever"), records: ref("records"),
  },
});

/** The line's own query, with who caused it read in the same trip. */
function page(extra: ReturnType<typeof cmp>[]) {
  return s.db.query({
    table: notification, as: "rows",
    where: [...lines(), cmp(col("space_id"), "=", inp("space_id"), { ignoreEmpty: true }), ...extra],
    bind: [{ table: user, as: "actor", join: "left", where: expr(col("actor_id"), "=", col("actor.id")) }],
    eval: [{ name: "actor.name", as: "actor_name" }, { name: "actor.kind", as: "actor_kind" }],
    sort: [{ sortBy: "needs_action", dir: "desc" }, { sortBy: "created_at", dir: "desc" }],
    paging: { page: inp("page"), per_page: PAGE, metadata: true, totals: true },
  });
}

export const countInbox = defineFunction({
  name: "inbox/count",
  description: "How many lines in a person's inbox are unread, after the same filter as the list.",
  input: who,
  stack: [
    ...bindFilters(),
    s.db.query({ table: notification, where: [...lines(), cmp(col("read_at"), "=", c.null())], returnType: "count", as: "n" }),
  ],
  response: ref("n"),
});

/** Opening a line reads its whole group. */
export const readItem = defineFunction({
  name: "inbox/read",
  description: "Mark one inbox line read, with everything grouped under it.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...ownItem(inp("id")),
    s.db.query({ table: notification, where: [mine(), cmp(col("group_key"), "=", ref("n.group_key")), cmp(col("read_at"), "=", c.null())], output: unreadCols, as: "group_rows" }),
    ...markRead("group_rows"),
    ...leaveIfDm("group_rows", "group"),
    inboxFrame({ to: inp("actor_id"), id: inp("id"), op: "read" }),
  ],
  response: { id: inp("id"), read: c.bool(true) },
});

/** Clearing is the person's own call, so it's refused for anything that clears by its own rule. */
export const clearItem = defineFunction({
  name: "inbox/clear",
  description: "Take one inbox line out of the inbox, with everything grouped under it.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...ownItem(inp("id")),
    guard.require(expr(ref("n.clearable"), "=", c.bool(true)), { errorType: "badrequest", message: "This one clears on its own." }),
    s.db.query({ table: notification, where: [mine(), cmp(col("group_key"), "=", ref("n.group_key")), cmp(col("done_at"), "=", c.null())], output: ["id"], as: "group_rows" }),
    s.array.map({ source: ref("group_rows"), as: "clearing", transform: { id: ref("$this.id"), done_at: c.now(), head: c.bool(false) } }),
    s.db.bulk.patch({ table: notification, items: ref("clearing"), as: "cleared" }),
    inboxFrame({ to: inp("actor_id"), id: inp("id"), op: "done" }),
  ],
  response: { id: inp("id"), done: c.bool(true) },
});

/** Everything but what waits for a decision, and only what the person can see: a hidden item comes back as they left it. */
export const readAllItems = defineFunction({
  name: "inbox/read_all",
  description: "Mark everything read except what needs a decision.",
  input: who,
  stack: [
    reachOf(inp("actor_id"), inp("browser")),
    s.db.query({ table: notification, where: [mine(), cmp(col("read_at"), "=", c.null()), expr(col("needs_action"), "=", c.bool(false)), inReach()], output: unreadCols, as: "unread" }),
    ...markRead("unread"),
    ...leaveIfDm("unread", "all"),
    inboxFrame({ to: inp("actor_id"), id: c.int(0), op: "read" }),
  ],
  response: { read: c.bool(true) },
});

/** Someone read a conversation up to `seq`: what it mentioned them in up to there is read, in every tab. */
export const readThrough = defineFunction({
  name: "inbox/read_through",
  description: "Mark a person's items about a conversation read up to a sequence number.",
  input: { user_id: input.int({ required: true }), conversation_id: input.int({ required: true }), seq: input.int({ required: true }) },
  stack: [
    s.db.query({ table: notification, output: unreadCols, as: "passed", where: [
      cmp(col("user_id"), "=", inp("user_id")), cmp(col("entity"), "=", c.text("conversation")), cmp(col("entity_id"), "=", inp("conversation_id")),
      cmp(col("read_at"), "=", c.null()), expr(col("seq"), ">", c.int(0)), expr(col("seq"), "<=", inp("seq")),
    ] }),
    s.conditional({ when: expr(withFilters(ref("passed"), fl.count()), ">", c.int(0)), then: [
      // Row by row: an agent's post lands here too, and few items pass at once.
      s.foreach({ list: ref("passed"), as: "row", body: [s.db.patch({ table: notification, fieldValue: ref("row.id"), data: obj({ read_at: c.now() }) })] }),
      ...leaveIfDm("passed", "passed"),
      inboxFrame({ to: inp("user_id"), id: c.int(0), op: "read" }),
    ] }),
  ],
  response: { read: withFilters(ref("passed"), fl.count()) },
});

/** Opening a record reads what this person's inbox says about it, in every tab. */
export const readRecordItems = defineFunction({
  name: "inbox/read_record",
  description: "Mark a person's items about one record read, once they've opened it.",
  input: { ...who, entity: input.text({ required: true }), entity_id: input.int({ required: true }) },
  stack: [
    ...requireReach({ actor: inp("actor_id"), browser: inp("browser"), type: inp("entity"), id: inp("entity_id") }),
    s.db.query({ table: notification, output: unreadCols, as: "about", where: [mine(), cmp(col("entity"), "=", inp("entity")), cmp(col("entity_id"), "=", inp("entity_id")), cmp(col("read_at"), "=", c.null())] }),
    s.conditional({ when: expr(withFilters(ref("about"), fl.count()), ">", c.int(0)), then: [
      ...markRead("about"),
      inboxFrame({ to: inp("actor_id"), id: c.int(0), op: "read" }),
    ] }),
  ],
  response: { read: withFilters(ref("about"), fl.count()) },
});

const MOST_FOR_A_CONNECTION = 30;

/**
 * An agent's work, oldest first: what `after` hasn't seen. Nothing is marked, so a client that dies mid-way asks again. A run reads
 * only its own space's items, because what's in another space is no business of whoever started it.
 */
export const connectionInbox = defineFunction({
  name: "inbox/for_connection",
  description: "What's waiting for an agent or a person's connection, oldest first, by membership alone.",
  input: { actor_id: input.int({ required: true }), run_id: input.int(), after: input.int() },
  stack: [
    reachOf(inp("actor_id"), c.bool(false)),
    s.db.query({ table: approvals.approval, where: [cmp(col("status"), "=", c.text("pending")), expr(col("expires_at"), ">", c.now())], output: ["id"], as: "pending" }),
    s.array.map({ source: ref("pending"), as: "decidable", transform: ref("$this.id") }),
    s.set_var("run_space", c.int(0)),
    s.set_var("in_a_dm", c.bool(false)),
    s.conditional({ when: expr(inp("run_id"), ">", c.int(0)), then: [
      s.db.get({ table: agent_run, fieldValue: inp("run_id"), output: ["space_id"], as: "bounds" }),
      s.update_var("run_space", ref("bounds.space_id", { safe: true })),
      s.conditional({ when: expr(ref("run_space"), "=", c.int(0)), then: [s.update_var("in_a_dm", c.bool(true))] }),
    ] }),
    s.set_var("items", c.array([])),
    s.set_var("named", c.array([])),
    s.set_var("next_after", withFilters(inp("after"), fl.to_int())),
    s.conditional({ when: expr(ref("in_a_dm"), "=", c.bool(false)), then: [
      s.db.query({ table: notification, as: "rows",
        // Every row, not a group's line: for an agent, each mention is a piece of work.
        where: [mine(), cmp(col("done_at"), "=", c.null()), inReach(), stillDecidable(), expr(col("id"), ">", ref("next_after")), cmp(col("space_id"), "=", ref("run_space"), { ignoreEmpty: true })],
        bind: [{ table: user, as: "actor", join: "left", where: expr(col("actor_id"), "=", col("actor.id")) }],
        eval: [{ name: "actor.name", as: "actor_name" }],
        sort: [{ sortBy: "id", dir: "asc" }], paging: { per_page: MOST_FOR_A_CONNECTION, metadata: false }, output: ["id", "kind", "title", "body", "link", "entity", "entity_id", "seq", "created_at", "actor_name"] }),
      s.set_var("wanted", c.array([])),
      s.foreach({ list: ref("rows"), as: "row", body: [
        s.conditional({ when: expr(withFilters(c.array(["", "approval", "approval_result"]), fl.in(ref("row.entity"))), "=", c.bool(false)), then: [
          s.update_var("wanted", withFilters(ref("wanted"), fl.array_push(c.expression('{"type": $var.row.entity, "id": $var.row.entity_id}')))),
        ] }),
      ] }),
      s.function.run({ fn: resolveRecords, as: "records", input: { actor_id: inp("actor_id"), browser: c.bool(false), items: ref("wanted") } }),
      s.update_var("items", ref("rows")),
      s.conditional({ when: expr(withFilters(ref("rows"), fl.count()), ">", c.int(0)), then: [s.update_var("next_after", withFilters(ref("rows"), fl.last(), fl.get("id")))] }),
      s.update_var("named", ref("records")),
    ] }),
  ],
  response: { items: ref("items"), records: ref("named"), next_after: ref("next_after") },
});

export const inboxFunctions = [connectionInbox, listInbox, countInbox, readItem, clearItem, readAllItems, readThrough, readRecordItems];
