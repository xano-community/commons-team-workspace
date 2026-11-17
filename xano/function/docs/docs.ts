// Docs in the workspace, around @xano-sdk/docs: what a save tells whom, the list and the one read a doc's screen needs, and the
// trash. The module holds the body and its history. A doc's links come from its body here, because only the app knows what a
// record is, and a save reaches the doc's own tabs here, so typing never wakes the rest of the space.
import { and, auth, c, cmp, col, defineFunction, expect, expr, fl, guard, inp, input, middleware, obj, or, ref, resp, s, statements, task as scheduledTask, withFilters, type Value } from "@xano/sdk";
import { docTable, docs } from "../../docs.js";
import { changed } from "../../base/functions.js";
import { live } from "../../base/live.js";
import { notification } from "../../base/tables.js";
import { user } from "../../table/user.js";
import { space } from "../../table/spaces/space.js";
import { conversation } from "../../table/messaging/conversation.js";
import { message } from "../../table/messaging/message.js";
import { doc_state } from "../../table/docs/doc_state.js";
import { doc_suggestion } from "../../table/docs/doc_suggestion.js";
import { record_link } from "../../table/links/record_link.js";
import { project } from "../../table/tasks/project.js";
import { task } from "../../table/tasks/task.js";
import { bindBrowser, canCreate, NOT_FOUND, reachOf, requireReach } from "../access/reach.js";
import { locate } from "../links/records.js";
import { addBodyLinks, forgetRecord, reconcileLinks } from "../links/links.js";
import { deliverAsk } from "../inbox/deliver.js";
import { inlineMarkdown } from "./markdown.js";

const who = { actor_id: input.int({ required: true }), browser: input.bool() };
const me = { actor: inp("actor_id"), browser: inp("browser") };
const docLink = (id: Value) => withFilters(c.text("/docs/"), fl.concat(id));

/** How long the space may go without hearing that a doc it can see has changed. */
const TELL_SPACE_EVERY_MS = 60_000;
/** How long a keystroke, or a person's save, holds an agent's change back. */
export const EDITING_MS = 15_000;
const PER_PAGE = 30;
const EXCERPT = 140;
const SEARCH_AT_MOST = 8;
const MOST_NODES = 100_000;
const PURGE_AFTER = "-30 days";

/** The doc's working notes, made on first need. Two first writers race on the unique index, and the loser reads the winner's row. */
export const stateOf = defineFunction({
  name: "docs/state",
  description: "A doc's working notes.",
  input: { doc_id: input.int({ required: true }) },
  stack: [
    s.db.query({ table: doc_state, where: cmp(col("doc_id"), "=", inp("doc_id")), returnType: "single", as: "held" }),
    s.conditional({ when: expr(ref("held"), "=", c.null()), then: [
      s.try_catch({ try: [s.db.add({ table: doc_state, as: "made", row: { doc_id: inp("doc_id"), told_title: c.text(""), links_key: c.text("") } })], catch: [] }),
      s.db.query({ table: doc_state, where: cmp(col("doc_id"), "=", inp("doc_id")), returnType: "single", as: "held" }),
    ] }),
  ],
  response: ref("held"),
});

/** The records a body links to, in the order it holds them. Walked with native statements, as the module derives its text. */
export const bodyTargets = defineFunction({
  name: "docs/body_targets",
  description: "The record links in a Tiptap body, and one string that says what they are.",
  input: { body: input.json() },
  stack: [
    s.set_var("pending", c.array([])),
    s.array.push({ name: "pending", value: inp("body") }),
    s.set_var("targets", c.array([])),
    s.set_var("keys", c.array([])),
    s.set_var("steps", c.int(0)),
    s.while({ when: and(expr(withFilters(ref("pending"), fl.count()), ">", c.int(0)), expr(ref("steps"), "<", c.int(MOST_NODES))), body: [
      s.array.pop({ name: "pending", as: "node" }),
      s.math.add({ name: "steps", value: c.int(1) }),
      s.conditional({
        when: expr(withFilters(ref("node"), fl.get("type", "")), "=", c.text("recordMention")),
        then: [
          s.set_var("target_type", withFilters(ref("node"), fl.get("attrs.type", ""))),
          s.set_var("target_id", withFilters(ref("node"), fl.get("attrs.id", 0), fl.to_int())),
          s.update_var("targets", withFilters(ref("targets"), fl.array_push(obj({ type: ref("target_type"), id: ref("target_id") })))),
          s.update_var("keys", withFilters(ref("keys"), fl.array_push(withFilters(ref("target_type"), fl.concat(c.text("-")), fl.concat(ref("target_id")))))),
        ],
        else: [s.array.merge({ name: "pending", value: withFilters(ref("node"), fl.get("content", c.array([]) as never)) })],
      }),
    ] }),
  ],
  response: { targets: ref("targets"), key: withFilters(ref("keys"), fl.unique(), fl.sort(), fl.join(",")) },
});

/**
 * What a list shows of a doc: its first paragraph, never a heading run into the words under it. A doc that opens with a list or a
 * table has none, and the list falls back to its first line.
 */
export const docExcerpt = defineFunction({
  name: "docs/excerpt",
  description: "A doc's first paragraph, as one line of plain words.",
  input: { body: input.json() },
  stack: [
    s.set_var("blocks", withFilters(inp("body"), fl.get("content", c.array([])))),
    s.array.find({ expr: ref("blocks"), if: and(expr(withFilters(ref("$this"), fl.get("type", "")), "=", c.text("paragraph")), expr(withFilters(ref("$this"), fl.get("content", c.array([])), fl.count()), ">", c.int(0))), as: "first" }),
    s.set_var("excerpt", c.text("")),
    s.conditional({ when: expr(ref("first"), "!=", c.null()), then: [
      s.foreach({ list: withFilters(ref("first"), fl.get("content", c.array([]))), as: "node", body: [
        s.switch({ on: withFilters(ref("node"), fl.get("type", "")), cases: [
          { when: c.text("text"), break: true, body: [s.text.append({ name: "excerpt", value: withFilters(ref("node"), fl.get("text", "")) })] },
          { when: c.text("mention"), break: true, body: [s.text.append({ name: "excerpt", value: withFilters(c.text("@"), fl.concat(withFilters(ref("node"), fl.get("attrs", c.obj({})), fl.get("label", "")))) })] },
          { when: c.text("hardBreak"), break: true, body: [s.text.append({ name: "excerpt", value: c.text(" ") })] },
        ] }),
      ] }),
    ] }),
  ],
  response: { excerpt: withFilters(ref("excerpt"), fl.trim(), fl.substr(c.int(0), c.int(EXCERPT))) },
  tests: [
    { name: "the first paragraph, past a heading", input: { body: c.obj({ type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Decided" }] },
      { type: "paragraph" },
      { type: "paragraph", content: [{ type: "text", text: "Specs come as a " }, { type: "text", text: "spreadsheet", marks: [{ type: "bold" }] }, { type: "text", text: ", says " }, { type: "mention", attrs: { id: 3, label: "Riley Park" } }] },
      { type: "paragraph", content: [{ type: "text", text: "Not this one." }] },
    ] }) }, expect: [expect.to_equal(resp("excerpt"), c.text("Specs come as a spreadsheet, says @Riley Park"))] },
    { name: "none when the doc has no paragraph", input: { body: c.obj({ type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Plan" }] }] }) },
      expect: [expect.to_equal(resp("excerpt"), c.text(""))] },
  ],
});

/**
 * After every write the module makes. The doc's tabs hear each save, and carry no words. The space hears when a doc arrives or
 * leaves, when it's renamed, and at most once a minute otherwise, so a list stays fresh without every tab waking per keystroke.
 */
export const docChanged = defineFunction({
  name: "docs/changed",
  description: "After a doc is written: tell its open tabs, and tell its space when that's worth a frame.",
  input: { op: input.text({ required: true }), doc_id: input.int({ required: true }), actor_id: input.int(), space_id: input.int() },
  stack: [
    s.db.get({ table: docTable, fieldValue: inp("doc_id"), output: ["title", "body", "version", "excerpt"], as: "written" }),
    guard.found("written", { errorType: "notfound", message: NOT_FOUND }),
    // The list's line for this doc, kept beside it so a page of docs never reads a body. Written only when it changes.
    s.function.run({ fn: docExcerpt, as: "first", input: { body: ref("written.body") } }),
    s.conditional({ when: expr(ref("first.excerpt"), "!=", ref("written.excerpt", { safe: true })), then: [
      s.db.patch({ table: docTable, fieldValue: inp("doc_id"), data: obj({ excerpt: ref("first.excerpt") }) }),
    ] }),
    s.function.run({ fn: stateOf, as: "state", input: { doc_id: inp("doc_id") } }),
    s.realtime.publish({ server: live, channel: withFilters(c.text("docs/"), fl.concat(inp("doc_id"))), message: c.text("doc_saved"), data: obj({ id: inp("doc_id"), version: ref("written.version"), actor_id: inp("actor_id") }) }),
    s.switch({ on: inp("op"), cases: [
      { when: c.text("created"), break: true, body: [
        changed({ entity: "doc", id: inp("doc_id"), op: "created", verb: "created", actor: inp("actor_id"), space: inp("space_id"), link: docLink(inp("doc_id")), title: "created a doc" }),
        s.db.patch({ table: doc_state, fieldValue: ref("state.id"), data: obj({ told_at: c.now(), told_title: ref("written.title") }) }),
      ] },
      { when: c.text("deleted"), break: true, body: [changed({ entity: "doc", id: inp("doc_id"), op: "deleted", actor: inp("actor_id"), space: inp("space_id") })] },
      { when: c.text("undeleted"), break: true, body: [changed({ entity: "doc", id: inp("doc_id"), op: "updated", actor: inp("actor_id"), space: inp("space_id") })] },
    ], default: [
      s.conditional({
        when: or(expr(ref("written.title"), "!=", ref("state.told_title")), expr(withFilters(ref("state.told_at", { safe: true }), fl.to_int(), fl.add(c.int(TELL_SPACE_EVERY_MS))), "<", c.now())),
        then: [
          changed({ entity: "doc", id: inp("doc_id"), op: "updated", actor: inp("actor_id"), space: inp("space_id") }),
          s.db.patch({ table: doc_state, fieldValue: ref("state.id"), data: obj({ told_at: c.now(), told_title: ref("written.title") }) }),
        ],
        // Nobody needed a frame for this save, but search needs its words.
        else: [s.function.run({ fn: "search/index", as: "indexed", input: { type: c.text("doc"), id: inp("doc_id") } })],
      }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

/** Brings a doc's links in line with its body. An unchanged set of links, the usual save, costs one read. */
export const syncLinks = defineFunction({
  name: "docs/sync_links",
  description: "Make a doc's links match the record links in its body.",
  input: { ...who, doc_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: docTable, fieldValue: inp("doc_id"), output: ["body"], as: "written" }),
    guard.found("written", { errorType: "notfound", message: NOT_FOUND }),
    s.function.run({ fn: stateOf, as: "state", input: { doc_id: inp("doc_id") } }),
    s.function.run({ fn: bodyTargets, as: "links", input: { body: ref("written.body") } }),
    s.conditional({ when: expr(ref("links.key"), "!=", ref("state.links_key")), then: [
      s.function.run({ fn: reconcileLinks, as: "linked", input: { actor_id: inp("actor_id"), browser: inp("browser"), from_type: c.text("doc"), from_id: inp("doc_id"), targets: ref("links.targets") } }),
      s.db.patch({ table: doc_state, fieldValue: ref("state.id"), data: obj({ links_key: ref("links.key") }) }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

/**
 * After a person's save or restore. It rides those routes rather than the module's hook, because only a person's body can drop a
 * link: an agent's change swaps words inside one text, so its tool has no reason to reach anything that deletes. A failure here
 * can't undo a save, and the next save puts it right.
 */
export const afterDocWrite = middleware({
  name: "docs/after_write",
  exceptionPolicy: "silent",
  description: "Keep a doc's links in line with the body a person just saved or restored.",
  stack: [
    s.util.get_all_input({ as: "payload" }),
    s.set_var("written_id", withFilters(ref("payload.vars.result.doc.id", { safe: true }), fl.first_notnull(ref("payload.vars.result.id", { safe: true })), fl.to_int())),
    s.conditional({ when: expr(ref("written_id"), ">", c.int(0)), then: [
      ...bindBrowser(),
      s.function.run({ fn: syncLinks, as: "synced", input: { actor_id: auth("id"), browser: ref("browser"), doc_id: ref("written_id") } }),
    ] }),
  ],
});

/** Someone was named in a doc. An agent's inbox is its work, so this is also how a mention in a doc becomes a run. */
export const docMentioned = defineFunction({
  name: "docs/mentioned",
  description: "Tell someone a doc names them.",
  input: { doc_id: input.int({ required: true }), user_id: input.int({ required: true }), actor_id: input.int(), space_id: input.int() },
  stack: [
    s.db.get({ table: docTable, fieldValue: inp("doc_id"), output: ["version"], as: "named_in" }),
    s.function.run({ fn: deliverAsk, as: "sent", input: {
      user_id: inp("user_id"), kind: c.text("mention"), title: c.text("mentioned you in a doc"), body: c.text(""), link: docLink(inp("doc_id")), actor_id: inp("actor_id"), space_id: inp("space_id"), dm_id: c.int(0),
      entity: c.text("doc"), entity_id: inp("doc_id"), group_key: c.text(""), seq: ref("named_in.version", { safe: true }),
    } }),
  ],
  response: { ok: c.bool(true) },
});

/** Refuses a change to a doc in an archived space. The module knows nothing of spaces, so this rides its write routes. */
export const gateDocWrite = middleware({
  name: "docs/gate_write",
  exceptionPolicy: "rethrow",
  description: "Refuses a write to a doc whose space is archived.",
  stack: [
    s.util.get_all_input({ as: "payload" }),
    s.set_var("gate_doc_id", withFilters(ref("payload.vars.id", { safe: true }), fl.to_int())),
    s.db.get({ table: docTable, fieldValue: ref("gate_doc_id"), output: ["space_id"], as: "gate_doc" }),
    s.conditional({ when: expr(ref("gate_doc"), "!=", c.null()), then: [
      s.set_var("gate_space_id", ref("gate_doc.space_id", { safe: true })),
      s.db.get({ table: space, fieldValue: ref("gate_space_id"), output: ["archived_at"], as: "gate_space" }),
      guard.require(expr(ref("gate_space.archived_at", { safe: true }), "=", c.null()), { errorType: "accessdenied", message: "This space is archived, so its docs can't change." }),
    ] }),
  ],
});

const bindPlaces = statements(
  reachOf(inp("actor_id"), inp("browser")),
  s.set_var("places", ref("reach.space_ids")),
  s.conditional({ when: expr(inp("space_id"), ">", c.int(0)), then: [
    ...requireReach({ ...me, type: "space", id: inp("space_id") }),
    s.update_var("places", withFilters(c.array([]), fl.array_push(inp("space_id")))),
  ] }),
);

/** What a list shows of a doc. The body stays behind, so a page of rows is small. */
const LIST_FIELDS = ["id", "title", "text", "excerpt", "space_id", "owner_id", "last_edited_by", "updated_at", "deleted_at", "version", "space_name", "owner_name", "owner_kind", "editor_name", "editor_kind"] as const;
const withNames = {
  bind: [
    { table: space, as: "home", join: "left" as const, where: expr(col("space_id"), "=", col("home.id")) },
    { table: user, as: "owner", join: "left" as const, where: expr(col("owner_id"), "=", col("owner.id")) },
    { table: user, as: "editor", join: "left" as const, where: expr(col("last_edited_by"), "=", col("editor.id")) },
  ],
  eval: [{ name: "home.name", as: "space_name" }, { name: "owner.name", as: "owner_name" }, { name: "owner.kind", as: "owner_kind" }, { name: "editor.name", as: "editor_name" }, { name: "editor.kind", as: "editor_kind" }],
};

/** The docs someone reaches, newest work first. `ever` says whether there's anything to find, so an empty page can say why it's empty. */
export const listDocs = defineFunction({
  name: "docs/list_in_spaces",
  description: "A page of the docs an actor reaches, in one space or all of them.",
  input: { ...who, space_id: input.int(), q: input.text(), trash: input.bool(), page: input.int() },
  stack: [
    ...bindPlaces,
    s.db.query({ table: docTable, where: [cmp(col("space_id"), "in", ref("places")), expr(col("deleted"), "=", c.bool(false))], returnType: "count", as: "ever" }),
    s.db.query({ table: docTable, as: "rows", ...withNames,
      where: and(cmp(col("space_id"), "in", ref("places")), expr(col("deleted"), "=", inp("trash")), or(cmp(col("title"), "includes", inp("q"), { ignoreEmpty: true }), cmp(col("text"), "includes", inp("q"), { ignoreEmpty: true }))),
      sort: [{ sortBy: "updated_at", dir: "desc" }], paging: { page: inp("page"), per_page: PER_PAGE, metadata: true, totals: true }, output: ["curPage", "nextPage", "itemsTotal", ...LIST_FIELDS.map((name) => `items.${name}`)] }),
    s.array.map({ source: ref("rows.items"), as: "ids", transform: ref("$this.id") }),
    // Waiting suggestions are for people who can act on them, so a guest's list doesn't say.
    s.set_var("waiting", c.array([])),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["role"], as: "viewer" }),
    s.conditional({ when: expr(ref("viewer.role", { safe: true }), "!=", c.text("guest")), then: [
      s.db.query({ table: doc_suggestion, where: [cmp(col("doc_id"), "in", ref("ids")), cmp(col("status"), "=", c.text("pending"))], output: ["doc_id"], as: "pending" }),
      s.array.map({ source: ref("pending"), as: "pending_ids", transform: ref("$this.doc_id") }),
      s.update_var("waiting", ref("pending_ids")),
    ] }),
    // How many comments each doc's thread holds, so the list says where the talk is.
    s.db.query({ table: conversation, where: [cmp(col("record_type"), "=", c.text("doc")), cmp(col("record_id"), "in", ref("ids"))], output: ["id", "record_id"], as: "threads" }),
    s.set_var("said", c.obj({})),
    s.foreach({ list: ref("threads"), as: "thread", body: [
      s.db.query({ table: message, where: [cmp(col("conversation_id"), "=", ref("thread.id")), cmp(col("deleted_at"), "=", c.null())], returnType: "count", as: "comment_count" }),
      s.update_var("said", withFilters(ref("said"), fl.set(withFilters(ref("thread.record_id"), fl.to_text()), ref("comment_count")))),
    ] }),
    s.array.map({ source: ref("rows.items"), as: "items", transform: {
      comments: withFilters(ref("said"), fl.get(withFilters(ref("$this.id"), fl.to_text()), 0)),
      id: ref("$this.id"), title: ref("$this.title"), excerpt: withFilters(ref("$this.excerpt", { safe: true }), fl.first_notempty(withFilters(ref("$this.text"), fl.split("\n"), fl.first())), fl.substr(c.int(0), c.int(EXCERPT))), space_id: ref("$this.space_id"), space_name: ref("$this.space_name"), owner_id: ref("$this.owner_id"), owner_name: ref("$this.owner_name"), owner_kind: ref("$this.owner_kind"),
      last_edited_by: ref("$this.last_edited_by"), editor_name: ref("$this.editor_name"), editor_kind: ref("$this.editor_kind"), updated_at: ref("$this.updated_at"), deleted_at: ref("$this.deleted_at"), suggestions: withFilters(ref("waiting"), fl.in(ref("$this.id"))),
    } }),
  ],
  response: { items: ref("items"), ever: ref("ever"), page: ref("rows.curPage"), next_page: ref("rows.nextPage"), total: ref("rows.itemsTotal") },
});

/** For ⌘K, a mention or a link: docs whose title matches, wherever the person reaches. */
export const searchDocs = defineFunction({
  name: "docs/search",
  description: "Docs an actor reaches whose title matches.",
  input: { ...who, q: input.text() },
  stack: [
    reachOf(inp("actor_id"), inp("browser")),
    s.db.query({ table: docTable, as: "rows", where: [cmp(col("space_id"), "in", ref("reach.space_ids")), expr(col("deleted"), "=", c.bool(false)), cmp(col("title"), "includes", inp("q"))], sort: [{ sortBy: "updated_at", dir: "desc" }], paging: { per_page: SEARCH_AT_MOST, metadata: false },
      bind: [withNames.bind[0]], eval: [withNames.eval[0]], output: ["id", "title", "space_name"] }),
  ],
  response: ref("rows"),
});

/** Starts a doc in a space. Reaching it isn't enough: it must be live, and a guest needs the space's say-so. */
export const createDoc = defineFunction({
  name: "docs/create_in_space",
  description: "Start a doc in a space, shared with that space.",
  input: { ...who, space_id: input.int({ required: true }), title: input.text(), body: input.json() },
  stack: [
    s.function.run({ fn: canCreate, as: "creates", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: inp("space_id") } }),
    guard.require(expr(ref("creates"), "=", c.bool(true)), { errorType: "accessdenied", message: "You can't add a doc there." }),
    s.function.run({ fn: docs.fns.create, as: "made", input: { actor_id: inp("actor_id"), title: inp("title"), body: inp("body"), visibility: c.text("team"), record_type: c.text(""), record_id: c.int(0), space_id: inp("space_id") } as never }),
    // A new body has nothing to take away, so it only adds. The first save compares against the key left here.
    s.function.run({ fn: bodyTargets, as: "links", input: { body: ref("made.body") } }),
    s.conditional({ when: expr(ref("links.key"), "!=", c.text("")), then: [
      s.function.run({ fn: addBodyLinks, as: "linked", input: { actor_id: inp("actor_id"), browser: inp("browser"), from_type: c.text("doc"), from_id: ref("made.id"), targets: ref("links.targets") } }),
      s.function.run({ fn: stateOf, as: "state", input: { doc_id: ref("made.id") } }),
      s.db.patch({ table: doc_state, fieldValue: ref("state.id"), data: obj({ links_key: ref("links.key") }) }),
    ] }),
  ],
  response: ref("made"),
});

/** A person's keystroke. It's the one write here that nobody else hears about: it only holds an agent's change back. */
export const markEditing = defineFunction({
  name: "docs/mark_editing",
  description: "Say someone is typing in a doc, so an agent's change waits for them.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    s.function.run({ fn: docs.fns.get, as: "current", input: { actor_id: inp("actor_id"), id: inp("id") } }),
    guard.require(expr(ref("current.access.can_edit"), "=", c.bool(true)), { errorType: "accessdenied", message: "You can read this document, but not change it." }),
    s.function.run({ fn: stateOf, as: "state", input: { doc_id: inp("id") } }),
    s.db.patch({ table: doc_state, fieldValue: ref("state.id"), data: obj({ editing_by: inp("actor_id"), editing_until: withFilters(c.now(), fl.add(c.int(EDITING_MS))) }) }),
  ],
  response: { ok: c.bool(true) },
});

/** Everything a doc's screen needs that isn't the doc. Suggestions are for people who can act on them, and nobody else hears of them. */
export const docContext = defineFunction({
  name: "docs/context",
  description: "Where a doc lives, what this person may do with it, its thread, and the agent changes around it.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    s.function.run({ fn: docs.fns.get, as: "current", input: { actor_id: inp("actor_id"), id: inp("id") } }),
    s.function.run({ fn: locate, as: "place", input: { type: c.text("doc"), id: inp("id") } }),
    s.db.get({ table: space, fieldValue: ref("place.space_id"), output: ["name"], as: "home" }),
    // The module's screen can't tell an agent from a person, so the byline hears it from here.
    s.db.get({ table: user, fieldValue: ref("current.doc.owner_id"), output: ["name", "kind"], as: "owner" }),
    s.db.get({ table: user, fieldValue: ref("current.doc.last_edited_by"), output: ["kind"], as: "editor" }),
    s.set_var("can_edit", c.bool(false)),
    s.conditional({ when: and(expr(ref("current.access.can_edit"), "=", c.bool(true)), expr(ref("place.archived"), "=", c.bool(false))), then: [s.update_var("can_edit", c.bool(true))] }),
    s.set_var("thread_key", withFilters(c.text("thread-doc-"), fl.concat(inp("id")))),
    s.db.query({ table: conversation, where: cmp(col("unique_key"), "=", ref("thread_key")), output: ["id"], returnType: "single", as: "thread" }),
    // The project it's part of, for the breadcrumb: the project of the first task it links to in its own space, if any.
    s.db.query({ table: record_link, where: [cmp(col("from_type"), "=", c.text("doc")), cmp(col("from_id"), "=", inp("id")), cmp(col("to_type"), "=", c.text("task"))], sort: [{ sortBy: "id", dir: "asc" }],
      paging: { per_page: 1, metadata: false }, output: ["to_id"], returnType: "single", as: "for_task" }),
    s.set_var("project", c.null()),
    s.conditional({ when: expr(ref("for_task"), "!=", c.null()), then: [
      s.db.get({ table: task, fieldValue: ref("for_task.to_id"), output: ["project_id", "space_id", "deleted_at"], as: "linked_task" }),
      s.conditional({ when: and(expr(ref("linked_task.space_id", { safe: true }), "=", ref("place.space_id")), expr(ref("linked_task.deleted_at", { safe: true }), "=", c.null())), then: [
        s.db.get({ table: project, fieldValue: ref("linked_task.project_id"), output: ["id", "name"], as: "found_project" }),
        s.update_var("project", ref("found_project")),
      ] }),
    ] }),
    s.set_var("waiting", c.array([])),
    s.set_var("applied", c.array([])),
    s.conditional({ when: expr(ref("can_edit"), "=", c.bool(true)), then: [
      s.function.run({ fn: "docs/pending_suggestions", as: "pending", input: { id: inp("id"), text: ref("current.doc.text") } }),
      s.update_var("waiting", ref("pending")),
      s.function.run({ fn: "docs/recently_applied", as: "recent", input: { id: inp("id") } }),
      s.update_var("applied", ref("recent")),
    ] }),
  ],
  response: {
    id: inp("id"), space_id: ref("place.space_id"), space_name: ref("home.name", { safe: true }), archived: ref("place.archived"), can_edit: ref("can_edit"),
    owner_id: ref("current.doc.owner_id"), owner_name: ref("owner.name", { safe: true }), owner_kind: ref("owner.kind", { safe: true }),
    editor_id: ref("current.doc.last_edited_by"), editor_kind: ref("editor.kind", { safe: true }),
    thread_id: withFilters(ref("thread.id", { safe: true }), fl.to_int()), suggestions: ref("waiting"), applied: ref("applied"),
    project_id: withFilters(ref("project.id", { safe: true }), fl.to_int()), project_name: ref("project.name", { safe: true }),
  },
});

/** The trash empties itself, like a task's: a doc, its history, its thread, its links and whatever was still being suggested. */
export const purgeDocs = defineFunction({
  name: "docs/purge",
  description: "Remove docs that have been in the trash for over 30 days, with everything that hangs off them.",
  stack: [
    s.set_var("cutoff", withFilters(c.now(), fl.epochms_transform(PURGE_AFTER))),
    s.db.query({ table: docTable, where: [expr(col("deleted"), "=", c.bool(true)), expr(col("deleted_at"), "<", ref("cutoff"))], paging: { per_page: 500, metadata: false }, output: ["id"], as: "expired" }),
    s.foreach({ list: ref("expired"), as: "item", body: [
      s.set_var("key", withFilters(c.text("thread-doc-"), fl.concat(ref("item.id")))),
      s.db.query({ table: conversation, where: cmp(col("unique_key"), "=", ref("key")), output: ["id"], returnType: "single", as: "thread" }),
      s.conditional({ when: expr(ref("thread"), "!=", c.null()), then: [
        s.set_var("thread_id", ref("thread.id", { safe: true })),
        s.db.query({ table: message, where: cmp(col("conversation_id"), "=", ref("thread_id")), output: ["id"], as: "said" }),
        s.foreach({ list: ref("said"), as: "post", body: [s.function.run({ fn: forgetRecord, as: "forgotten", input: { type: c.text("message"), id: ref("post.id") } })] }),
        s.db.bulk.delete({ table: message, where: cmp(col("conversation_id"), "=", ref("thread_id")), as: "wiped" }),
        s.db.bulk.delete({ table: notification, where: and(cmp(col("entity"), "=", c.text("conversation")), cmp(col("entity_id"), "=", ref("thread_id"))), as: "unsaid" }),
        s.db.del({ table: conversation, fieldValue: ref("thread_id") }),
      ] }),
      s.function.run({ fn: forgetRecord, as: "forgotten", input: { type: c.text("doc"), id: ref("item.id") } }),
      s.db.bulk.delete({ table: notification, where: and(cmp(col("entity"), "=", c.text("doc")), cmp(col("entity_id"), "=", ref("item.id"))), as: "unsaid" }),
      s.db.bulk.delete({ table: doc_suggestion, where: cmp(col("doc_id"), "=", ref("item.id")), as: "unfiled" }),
      s.db.bulk.delete({ table: doc_state, where: cmp(col("doc_id"), "=", ref("item.id")), as: "unheld" }),
      s.db.bulk.delete({ table: docs.doc_version, where: cmp(col("doc_id"), "=", ref("item.id")), as: "unkept" }),
      s.db.del({ table: docTable, fieldValue: ref("item.id") }),
    ] }),
  ],
  response: { purged: withFilters(ref("expired"), fl.count()) },
});

export const purgeDocsDaily = scheduledTask({
  name: "docs_purge_daily",
  description: "Remove docs that have been in the trash for over 30 days.",
  schedule: [{ startsOn: "2026-01-01T03:30:00Z", freq: 86_400, repeatEnabled: true }],
  stack: [s.function.run({ fn: purgeDocs, as: "purged" })],
});

export const docFunctions = [docExcerpt, inlineMarkdown, stateOf, bodyTargets, syncLinks, docChanged, docMentioned, listDocs, searchDocs, createDoc, markEditing, docContext, purgeDocs];
