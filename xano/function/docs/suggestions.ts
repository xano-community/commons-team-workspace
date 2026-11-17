// An agent's change to a doc, from filing to decision. A person's work always wins:
//
//   nobody is working on the doc, and nothing is queued -> it goes in at once, as the agent, in the doc's history like any save
//   otherwise                                           -> it waits in order, for anyone who can edit to Apply or Dismiss
//   its words are gone from the doc                     -> Dismiss only, so an Apply can never overwrite what someone wrote
//
// A person's Apply happens in their own editor, where their unsaved typing is, and arrives with their next save, so this file only
// records the decision. The server's own edit is a literal swap on the body's JSON, and is checked against the derived text: if
// the words cross a bold or a link, or bring marks of their own, it can't swap them, so the change waits for a person whose editor can.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters, type Value } from "@xano/sdk";
import { docs } from "../../docs.js";
import { changed } from "../../base/functions.js";
import { user } from "../../table/user.js";
import { agent_run } from "../../table/agents/agent_run.js";
import { doc_suggestion } from "../../table/docs/doc_suggestion.js";
import { NOT_FOUND } from "../access/reach.js";
import { locate } from "../links/records.js";
import { postMessage } from "../messaging/messages.js";
import { EDITING_MS, stateOf } from "./docs.js";
import { inlineMarkdown } from "./markdown.js";

const ARCHIVED = "This space is archived, so its docs can't change.";
const RECENT_MS = 300_000;
/** How many times `words` appears in `text`. */
const timesIn = (text: Value, words: Value) => withFilters(text, fl.split(words), fl.count(), fl.sub(c.int(1)));
/** A string as it sits inside JSON, without the quotes round it. */
const asJson = (text: Value) => withFilters(text, fl.json_encode(), fl.substr(c.int(1), c.int(-1)));
const when = (status: "pending" | "applied") => cmp(col("status"), "=", c.text(status));
const FIELDS = ["id", "doc_id", "agent_id", "agent_name", "run_id", "base_version", "find", "text", "blocks", "note", "created_at"] as const;
const withAgent = {
  bind: [{ table: user, as: "author", join: "left" as const, where: expr(col("agent_id"), "=", col("author.id")) }],
  eval: [{ name: "author.name", as: "agent_name" }],
};

/** What's waiting on a doc, oldest first. `text_changed` is against the last save: the screen checks again against what's typed. */
export const pendingSuggestions = defineFunction({
  name: "docs/pending_suggestions",
  description: "A doc's waiting suggestions, in order, and whether each one's words are still there.",
  input: { id: input.int({ required: true }), text: input.text() },
  stack: [
    s.db.query({ table: doc_suggestion, where: [cmp(col("doc_id"), "=", inp("id")), when("pending")], sort: [{ sortBy: "id", dir: "asc" }], output: [...FIELDS], ...withAgent, as: "rows" }),
    s.array.map({ source: ref("rows"), as: "items", transform: {
      id: ref("$this.id"), doc_id: ref("$this.doc_id"), agent_id: ref("$this.agent_id"), agent_name: ref("$this.agent_name"), run_id: ref("$this.run_id"), base_version: ref("$this.base_version"),
      find: ref("$this.find"), text: ref("$this.text"), blocks: ref("$this.blocks"), note: ref("$this.note"), created_at: ref("$this.created_at"),
      text_changed: c.expression('$this.find != "" && (($input.text|split:$this.find|count) != 2)'),
    } }),
  ],
  response: ref("items"),
});

/** What an agent put in by itself lately, so someone who was away can see why the doc moved. */
export const recentlyApplied = defineFunction({
  name: "docs/recently_applied",
  description: "An agent's changes that went in by themselves in the last few minutes.",
  input: { id: input.int({ required: true }) },
  stack: [
    s.db.query({ table: doc_suggestion, where: [cmp(col("doc_id"), "=", inp("id")), when("applied"), cmp(col("decided_by"), "=", c.int(0)), expr(col("decided_at"), ">", withFilters(c.now(), fl.sub(c.int(RECENT_MS))))], sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: 1, metadata: false }, output: ["id", "agent_id", "agent_name", "note", "decided_at"], ...withAgent, as: "rows" }),
  ],
  response: ref("rows"),
});

/** Says in the run's thread what became of its change. A run that's gone, or an agent that's left the space, can't undo a decision. */
export const tellRun = defineFunction({
  name: "docs/tell_run",
  description: "Put what a person did with an agent's change on the run that filed it.",
  input: { run_id: input.int(), agent_id: input.int(), words: input.text({ required: true }) },
  stack: [
    s.conditional({ when: expr(inp("run_id"), ">", c.int(0)), then: [
      s.db.get({ table: agent_run, fieldValue: inp("run_id"), as: "run" }),
      s.conditional({ when: expr(ref("run"), "!=", c.null()), then: [
        s.db.patch({ table: agent_run, fieldValue: inp("run_id"), data: obj({ last_note: inp("words") }) }),
        s.conditional({ when: expr(ref("run.thread_id", { safe: true }), ">", c.int(0)), then: [
          s.security.create_uuid({ as: "note_key" }),
          s.try_catch({ try: [
            s.function.run({ fn: postMessage, as: "said", input: { actor_id: inp("agent_id"), browser: c.bool(false), conversation_id: ref("run.thread_id", { safe: true }), client_msg_id: ref("note_key"), body: inp("words"), run_id: inp("run_id"), run_note: c.bool(true) } }),
          ], catch: [] }),
        ] }),
        s.function.run({ fn: "agents/changed", as: "run_told", input: { run_id: inp("run_id"), space_id: ref("run.space_id", { safe: true }), dm_id: ref("run.dm_id", { safe: true }), op: c.text("updated") } }),
      ] }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

/**
 * Files one change. Binds nothing a caller needs but the answer: `status` says whether it went in, and `outcome` is what the run
 * may say about it. The caller has already checked the agent may be here.
 */
export const fileSuggestion = defineFunction({
  name: "docs/file_suggestion",
  description: "File an agent's change to a doc: in at once on a quiet doc, or waiting for a person.",
  input: { actor_id: input.int({ required: true }), run_id: input.int(), id: input.int({ required: true }), find: input.text(), text: input.text(), note: input.text() },
  stack: [
    guard.require(expr(withFilters(inp("text"), fl.trim()), "!=", c.text("")), { errorType: "badrequest", message: "Give the text to add or put in." }),
    s.function.run({ fn: docs.fns.get, as: "current", input: { actor_id: inp("actor_id"), id: inp("id") } }),
    guard.require(expr(ref("current.access.can_edit"), "=", c.bool(true)), { errorType: "accessdenied", message: "This agent can read this doc, but not change it." }),
    s.function.run({ fn: locate, as: "place", input: { type: c.text("doc"), id: inp("id") } }),
    guard.require(expr(ref("place.archived"), "=", c.bool(false)), { errorType: "accessdenied", message: ARCHIVED }),
    s.set_var("doc", ref("current.doc")),
    s.set_var("next_body", c.null()),
    s.set_var("expected", c.text("")),
    s.set_var("blocks", c.array([])),
    s.set_var("words", inp("text")),
    s.conditional({
      when: expr(inp("find"), "=", c.text("")),
      then: [
        s.function.run({ fn: docs.fns.fromText, as: "added", input: { text: inp("text") } }),
        s.update_var("blocks", ref("added.content")),
        s.update_var("next_body", obj({ type: c.text("doc"), content: withFilters(ref("doc.body"), fl.get("content", c.array([]) as never), fl.array_merge(ref("added.content"))) })),
      ],
      else: [
        guard.require(and(expr(withFilters(inp("find"), fl.contains(c.text("\n"))), "=", c.bool(false)), expr(withFilters(inp("text"), fl.contains(c.text("\n"))), "=", c.bool(false))), { errorType: "badrequest", message: "Replace text within one line. To add new lines, leave find empty, and they go at the end." }),
        s.set_var("seen", timesIn(ref("doc.text"), inp("find"))),
        guard.require(expr(ref("seen"), ">", c.int(0)), { errorType: "badrequest", message: "That text isn't in the document. Read it again and quote it exactly." }),
        guard.require(expr(ref("seen"), "=", c.int(1)), { errorType: "badrequest", message: "That text appears more than once. Quote more of it." }),
        s.function.run({ fn: inlineMarkdown, as: "marked", input: { text: inp("text"), inline: c.bool(true) } }),
        s.function.run({ fn: docs.fns.derive, as: "plain", input: { body: obj({ type: c.text("doc"), content: [obj({ type: c.text("paragraph"), content: ref("marked") })] }) } }),
        s.conditional({
          when: expr(ref("plain.text"), "=", withFilters(inp("text"), fl.trim())),
          then: [
            s.update_var("expected", withFilters(ref("doc.text"), fl.string_replace(inp("find"), inp("text")))),
            s.set_var("encoded", withFilters(ref("doc.body"), fl.json_encode())),
            s.conditional({ when: expr(timesIn(ref("encoded"), asJson(inp("find"))), "=", c.int(1)), then: [
              s.update_var("next_body", withFilters(ref("encoded"), fl.string_replace(asJson(inp("find")), asJson(inp("text"))), fl.json_decode())),
            ] }),
          ],
          else: [s.update_var("words", ref("plain.text")), s.update_var("blocks", ref("marked"))],
        }),
      ],
    }),
    // Busy means a keystroke not long ago, a person's save not long ago, or something already waiting: the queue keeps its order.
    s.function.run({ fn: stateOf, as: "state", input: { doc_id: inp("id") } }),
    s.db.get({ table: user, fieldValue: ref("doc.last_edited_by"), output: ["kind"], as: "last_editor" }),
    s.db.query({ table: doc_suggestion, where: [cmp(col("doc_id"), "=", inp("id")), when("pending")], returnType: "count", as: "queued" }),
    s.set_var("busy", c.bool(false)),
    s.conditional({ when: expr(withFilters(ref("state.editing_until", { safe: true }), fl.to_int()), ">", c.now()), then: [s.update_var("busy", c.bool(true))] }),
    s.conditional({ when: and(expr(ref("last_editor.kind", { safe: true }), "=", c.text("human")), expr(withFilters(ref("doc.updated_at"), fl.add(c.int(EDITING_MS))), ">", c.now())), then: [s.update_var("busy", c.bool(true))] }),
    s.conditional({ when: expr(ref("queued"), ">", c.int(0)), then: [s.update_var("busy", c.bool(true))] }),
    s.set_var("status", c.text("pending")),
    s.set_var("applied_version", c.int(0)),
    s.conditional({ when: and(expr(ref("busy"), "=", c.bool(false)), expr(ref("next_body"), "!=", c.null())), then: [
      s.function.run({ fn: docs.fns.derive, as: "check", input: { body: ref("next_body") } }),
      s.conditional({ when: expr(withFilters(ref("expected"), fl.strlen()), ">", c.int(0)), then: [
        s.conditional({ when: expr(ref("check.text"), "!=", ref("expected")), then: [s.update_var("next_body", c.null())] }),
      ] }),
      s.conditional({ when: expr(ref("next_body"), "!=", c.null()), then: [
        s.function.run({ fn: docs.fns.save, as: "saved", input: { actor_id: inp("actor_id"), id: inp("id"), base_version: ref("doc.version"), title: ref("doc.title"), body: ref("next_body") } }),
        // Someone's save got in first, so this stays a suggestion, the same as if they'd been typing.
        s.conditional({ when: expr(ref("saved.conflict"), "=", c.bool(false)), then: [
          s.update_var("status", c.text("applied")),
          s.update_var("applied_version", ref("saved.doc.version")),
        ] }),
      ] }),
    ] }),
    s.set_var("decided_at", c.null()),
    s.conditional({ when: expr(ref("status"), "=", c.text("applied")), then: [s.update_var("decided_at", c.now())] }),
    s.db.add({ table: doc_suggestion, as: "filed", row: {
      doc_id: inp("id"), space_id: ref("place.space_id"), agent_id: inp("actor_id"), run_id: inp("run_id"), base_version: ref("doc.version"), find: inp("find"), text: ref("words"), blocks: ref("blocks"), note: inp("note"),
      status: ref("status"), applied_version: ref("applied_version"), decided_by: c.int(0), decided_at: ref("decided_at"),
    } }),
    s.set_var("outcome", c.text("Suggested a change")),
    s.set_var("activity_line", c.text("suggested a change to a doc")),
    s.conditional({ when: expr(ref("status"), "=", c.text("applied")), then: [s.update_var("outcome", c.text("Edited")), s.update_var("activity_line", c.text("edited a doc"))] }),
    changed({ entity: "doc_suggestion", id: ref("filed.id"), op: "created", verb: "suggested", actor: inp("actor_id"), space: ref("place.space_id"), link: withFilters(c.text("/docs/"), fl.concat(inp("id"))), title: ref("activity_line") }),
  ],
  response: { suggestion_id: ref("filed.id"), status: ref("status"), outcome: ref("outcome") },
});

/** A person's Apply, Dismiss or, when their editor found the words gone after all, a step back. The row's lock settles two windows. */
export const decideSuggestion = defineFunction({
  name: "docs/decide_suggestion",
  description: "Record a person's decision on an agent's change. Apply is refused once the words have gone.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), id: input.int({ required: true }), decision: input.enum(["apply", "dismiss", "reopen"], { required: true }) },
  stack: [
    s.db.get({ table: doc_suggestion, fieldValue: inp("id"), as: "row" }),
    guard.found("row", { errorType: "notfound", message: NOT_FOUND }),
    s.function.run({ fn: docs.fns.get, as: "current", input: { actor_id: inp("actor_id"), id: ref("row.doc_id") } }),
    guard.require(expr(ref("current.access.can_edit"), "=", c.bool(true)), { errorType: "accessdenied", message: "You can read this document, but not change it." }),
    s.function.run({ fn: locate, as: "place", input: { type: c.text("doc"), id: ref("row.doc_id") } }),
    guard.require(expr(ref("place.archived"), "=", c.bool(false)), { errorType: "accessdenied", message: ARCHIVED }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["name"], as: "decider" }),
    s.set_var("changed_now", c.bool(false)),
    s.set_var("text_changed", c.bool(false)),
    s.set_var("status", ref("row.status")),
    s.db.transaction({ body: [
      s.db.get({ table: doc_suggestion, fieldValue: inp("id"), lock: true, as: "held" }),
      s.update_var("status", ref("held.status", { safe: true })),
      s.switch({ on: inp("decision"), cases: [
        { when: c.text("apply"), break: true, body: [
          s.conditional({ when: expr(ref("status"), "=", c.text("pending")), then: [
            s.conditional({ when: and(expr(ref("row.find"), "!=", c.text("")), expr(timesIn(ref("current.doc.text"), ref("row.find")), "!=", c.int(1))), then: [s.update_var("text_changed", c.bool(true))] }),
            s.conditional({ when: expr(ref("text_changed"), "=", c.bool(false)), then: [
              s.db.patch({ table: doc_suggestion, fieldValue: inp("id"), data: obj({ status: c.text("applied"), decided_by: inp("actor_id"), decided_at: c.now() }) }),
              s.update_var("status", c.text("applied")),
              s.update_var("changed_now", c.bool(true)),
            ] }),
          ] }),
        ] },
        { when: c.text("dismiss"), break: true, body: [
          s.conditional({ when: expr(ref("status"), "=", c.text("pending")), then: [
            s.db.patch({ table: doc_suggestion, fieldValue: inp("id"), data: obj({ status: c.text("dismissed"), decided_by: inp("actor_id"), decided_at: c.now() }) }),
            s.update_var("status", c.text("dismissed")),
            s.update_var("changed_now", c.bool(true)),
          ] }),
        ] },
        { when: c.text("reopen"), break: true, body: [
          s.conditional({ when: and(expr(ref("status"), "=", c.text("applied")), expr(ref("held.decided_by", { safe: true }), "=", inp("actor_id"))), then: [
            s.db.patch({ table: doc_suggestion, fieldValue: inp("id"), data: obj({ status: c.text("pending"), decided_by: c.int(0), decided_at: c.null() }) }),
            s.update_var("status", c.text("pending")),
            s.update_var("changed_now", c.bool(true)),
          ] }),
        ] },
      ] }),
    ] }),
    s.conditional({ when: expr(ref("changed_now"), "=", c.bool(true)), then: [
      changed({ entity: "doc_suggestion", id: inp("id"), op: "updated", actor: inp("actor_id"), space: ref("place.space_id") }),
      s.conditional({ when: expr(inp("decision"), "!=", c.text("reopen")), then: [
        s.set_var("words", withFilters(ref("decider.name", { safe: true }), fl.concat(c.text(" dismissed this suggestion.")))),
        s.conditional({ when: expr(inp("decision"), "=", c.text("apply")), then: [s.update_var("words", withFilters(ref("decider.name", { safe: true }), fl.concat(c.text(" applied this suggestion."))))] }),
        s.function.run({ fn: tellRun, as: "told", input: { run_id: ref("row.run_id"), agent_id: ref("row.agent_id"), words: ref("words") } }),
      ] }),
    ] }),
  ],
  response: { status: ref("status"), changed: ref("changed_now"), text_changed: ref("text_changed") },
});

/**
 * A person's save lost a race. If only the server's own edits came between, they step aside: each goes back to waiting, and the
 * caller saves on top, so that person's words land with no dialog and the agent's change is offered again. Every version since
 * theirs must be one of those edits, so another person's words can never be taken this way: that race keeps its dialog.
 */
export const yieldDoc = defineFunction({
  name: "docs/yield",
  description: "Turn an agent's edits since a version back into suggestions, if nothing else came between.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), id: input.int({ required: true }), base_version: input.int({ required: true }) },
  stack: [
    s.function.run({ fn: docs.fns.get, as: "current", input: { actor_id: inp("actor_id"), id: inp("id") } }),
    guard.require(expr(ref("current.access.can_edit"), "=", c.bool(true)), { errorType: "accessdenied", message: "You can read this document, but not change it." }),
    s.db.query({ table: doc_suggestion, where: [cmp(col("doc_id"), "=", inp("id")), when("applied"), expr(col("applied_version"), ">", inp("base_version"))], as: "edits" }),
    s.set_var("since", withFilters(ref("current.doc.version"), fl.sub(inp("base_version")))),
    s.set_var("yielded", c.bool(false)),
    s.conditional({ when: and(expr(ref("since"), ">", c.int(0)), expr(withFilters(ref("edits"), fl.count()), "=", ref("since"))), then: [
      s.foreach({ list: ref("edits"), as: "edit", body: [
        s.db.patch({ table: doc_suggestion, fieldValue: ref("edit.id"), data: obj({ status: c.text("pending"), applied_version: c.int(0), decided_at: c.null() }) }),
        s.function.run({ fn: tellRun, as: "told", input: { run_id: ref("edit.run_id"), agent_id: ref("edit.agent_id"), words: c.text("Suggested a change") } }),
      ] }),
      s.update_var("yielded", c.bool(true)),
      changed({ entity: "doc_suggestion", id: inp("id"), op: "updated", actor: inp("actor_id"), space: ref("current.doc.space_id") }),
    ] }),
  ],
  response: { yielded: ref("yielded"), version: ref("current.doc.version") },
});

export const suggestionFunctions = [pendingSuggestions, recentlyApplied, tellRun, fileSuggestion, decideSuggestion, yieldDoc];
