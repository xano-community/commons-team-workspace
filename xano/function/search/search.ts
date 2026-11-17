// One search over all five tools. The change path writes `search_entry`, and a search filters on `scope` in the query, against
// the same `reach.scopes` every link and inbox read uses. A row holds no access of its own, so a removal takes effect at once.
//
// A new record type adds a case to `locate`, its words to `indexRecord`, and its name to INDEXED in search_entry.ts.
import { and, c, cmp, col, defineFunction, expr, fl, inp, input, obj, ref, s, withFilters, type Value } from "@xano/sdk";
import { docTable } from "../../docs.js";
import { company } from "../../table/crm/company.js";
import { contact } from "../../table/crm/contact.js";
import { crm_note } from "../../table/crm/crm_note.js";
import { deal } from "../../table/crm/deal.js";
import { agent_run } from "../../table/agents/agent_run.js";
import { conversation } from "../../table/messaging/conversation.js";
import { message } from "../../table/messaging/message.js";
import { search_entry } from "../../table/search/search_entry.js";
import { task } from "../../table/tasks/task.js";
import { user } from "../../table/user.js";
import { reachFn, reachOf } from "../access/reach.js";
import { locate } from "../links/records.js";

export const MOST_RESULTS = 50;
const MOST_WORDS = 4;
const MOST_BODY = 4000;
const SHORTEST_QUERY = 2;
const TITLE_FROM_BODY = 120;
/** No reach ever holds this. */
const GONE = "gone";

/** `<@5>` and `<#doc:12>` are ids, not words anyone typed, and a name here could outlive someone's access to it. */
const plain = (text: Value) => withFilters(c.regex(/<[@#][^>]*>/), fl.regex_replace(c.text(" "), text));

export const indexRecord = defineFunction({
  name: "search/index",
  description: "Bring one record's search row in line with the record: write it, or drop it when it's gone, trashed or a tombstone.",
  input: { type: input.text({ required: true }), id: input.int({ required: true }) },
  stack: [
    // Finding a record later never matters more than the write that's already committed.
    s.try_catch({ try: [
      s.function.run({ fn: locate, as: "target", input: { type: inp("type"), id: inp("id") } }),
      s.set_var("key", withFilters(inp("type"), fl.concat(c.text("-")), fl.concat(inp("id")))),
      s.set_var("title", ref("target.title")),
      s.set_var("body", c.text("")),
      s.set_var("place", c.int(0)),
      s.set_var("listed", c.bool(true)),
      s.switch({ on: inp("type"), cases: [
        { when: c.text("conversation"), break: true, body: [
          s.db.get({ table: conversation, fieldValue: inp("id"), output: ["kind"], as: "row" }),
          s.conditional({ when: expr(ref("row.kind", { safe: true }), "!=", c.text("channel")), then: [s.update_var("listed", c.bool(false))] }),
        ] },
        { when: c.text("message"), break: true, body: [
          s.db.get({ table: message, fieldValue: inp("id"), output: ["body", "conversation_id", "held"], as: "row" }),
          // A guest searches the same space, so a note held from them stays out until it's released.
          s.conditional({ when: expr(ref("row.held", { safe: true }), "=", c.bool(true)), then: [s.update_var("listed", c.bool(false))] }),
          s.update_var("body", plain(ref("row.body", { safe: true }))),
          s.update_var("title", withFilters(ref("body"), fl.trim(), fl.substr(c.int(0), c.int(TITLE_FROM_BODY)))),
          s.update_var("place", ref("row.conversation_id", { safe: true })),
        ] },
        { when: c.text("task"), break: true, body: [
          s.db.get({ table: task, fieldValue: inp("id"), output: ["description"], as: "row" }),
          s.update_var("body", plain(ref("row.description", { safe: true }))),
        ] },
        { when: c.text("doc"), break: true, body: [
          s.db.get({ table: docTable, fieldValue: inp("id"), output: ["text"], as: "row" }),
          s.update_var("body", ref("row.text", { safe: true })),
        ] },
        { when: c.text("company"), break: true, body: [
          s.db.get({ table: company, fieldValue: inp("id"), output: ["domain", "industry", "about"], as: "row" }),
          s.update_var("body", withFilters(ref("row.domain", { safe: true }), fl.concat(c.text(" ")), fl.concat(ref("row.industry", { safe: true })), fl.concat(c.text(" ")), fl.concat(ref("row.about", { safe: true })))),
        ] },
        { when: c.text("contact"), break: true, body: [
          s.db.get({ table: contact, fieldValue: inp("id"), output: ["email", "job_title"], as: "row" }),
          s.update_var("body", withFilters(ref("row.job_title", { safe: true }), fl.concat(c.text(" ")), fl.concat(ref("row.email", { safe: true })))),
        ] },
        { when: c.text("crm_note"), break: true, body: [
          s.db.get({ table: crm_note, fieldValue: inp("id"), output: ["body"], as: "row" }),
          s.update_var("body", plain(ref("row.body", { safe: true }))),
        ] },
      ] }),
      s.update_var("body", withFilters(ref("body"), fl.substr(c.int(0), c.int(MOST_BODY)))),
      s.conditional({
        when: and(expr(ref("target.found"), "=", c.bool(true)), expr(ref("target.trashed"), "=", c.bool(false)), expr(ref("target.tombstone"), "=", c.bool(false)), expr(ref("target.scope"), "!=", c.text("")), expr(ref("listed"), "=", c.bool(true))),
        then: [s.db.add_or_edit({ table: search_entry, fieldName: "key", fieldValue: ref("key"), row: {
          key: ref("key"), entity: inp("type"), entity_id: inp("id"), title: ref("title"), body: ref("body"), terms: withFilters(ref("title"), fl.concat(c.text(" ")), fl.concat(ref("body"))), scope: ref("target.scope"),
          href: ref("target.href"), conversation_id: ref("place"), changed_at: c.now(),
        } })],
        // Emptied, not deleted: it's a write any tool can reach, and a row with no scope and no words can't be found by anyone.
        else: [
          s.db.get({ table: search_entry, fieldName: "key", fieldValue: ref("key"), output: ["id"], as: "held" }),
          s.conditional({ when: expr(ref("held"), "!=", c.null()), then: [
            s.db.patch({ table: search_entry, fieldValue: ref("held.id"), data: obj({ title: c.text(""), body: c.text(""), terms: c.text(""), href: c.text(""), scope: c.text(GONE), conversation_id: c.int(0) }) }),
          ] }),
        ],
      }),
    ], catch: [] }),
  ],
  response: { ok: c.bool(true) },
});

/**
 * Where a search may look. Everyone starts from their own reach. A run looks only where it was asked, and only where whoever
 * asked can see too: its own space or DM, and customers from a space, when both of them open customers.
 */
export const searchScopes = defineFunction({
  name: "search/scopes",
  description: "The scopes a search may read: the actor's reach and, inside a run, that run's bounds.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), run_id: input.int() },
  stack: [
    reachOf(inp("actor_id"), inp("browser")),
    s.set_var("allowed", ref("reach.scopes")),
    s.conditional({ when: expr(inp("run_id"), ">", c.int(0)), then: [
      s.db.get({ table: agent_run, fieldValue: inp("run_id"), output: ["space_id", "dm_id", "requested_by"], as: "bounds" }),
      s.set_var("run_dm", ref("bounds.dm_id", { safe: true })),
      s.set_var("bounded", c.array(["crm"])),
      s.conditional({
        when: expr(ref("run_dm"), ">", c.int(0)),
        // A run in a DM stays in that conversation.
        then: [s.update_var("bounded", withFilters(c.array([]), fl.array_push(withFilters(c.text("dm-"), fl.concat(ref("run_dm"))))))],
        else: [s.update_var("bounded", withFilters(ref("bounded"), fl.array_push(withFilters(c.text("space-"), fl.concat(ref("bounds.space_id", { safe: true }))))))],
      }),
      s.set_var("asker_id", ref("bounds.requested_by", { safe: true })),
      s.db.get({ table: user, fieldValue: ref("asker_id"), output: ["kind"], as: "asker" }),
      s.set_var("asker_kind", ref("asker.kind", { safe: true })),
      s.function.run({ fn: reachFn, as: "asker_reach", input: { actor_id: ref("asker_id"), browser: c.expression('$var.asker_kind == "human"') } }),
      s.update_var("allowed", withFilters(ref("allowed"), fl.array_intersect(ref("bounded")), fl.array_intersect(ref("asker_reach.scopes")))),
    ] }),
  ],
  response: ref("allowed"),
});

/** Access lives here, in the query: a row outside `scopes` is never read, so it can't reach a result, a count or a log. */
const hitsOn = (column: string) => [cmp(col("scope"), "in", ref("scopes")), ...Array.from({ length: MOST_WORDS }, (_, i) => cmp(col(column), "includes", ref(`word_${i}`), { ignoreEmpty: true }))];
const found = (where: ReturnType<typeof hitsOn>, as: string) => s.db.query({
  table: search_entry, where, sort: [{ sortBy: "changed_at", dir: "desc" }], paging: { per_page: MOST_RESULTS, metadata: false },
  bind: [{ table: conversation, as: "home", join: "left", where: expr(col("conversation_id"), "=", col("home.id")) }],
  eval: [{ name: "home.name", as: "place" }, { name: "home.kind", as: "place_kind" }],
  output: ["key", "entity", "entity_id", "title", "body", "href", "scope", "changed_at", "place", "place_kind"], as,
});

export const findRecords = defineFunction({
  name: "search/find",
  description: "Records matching every word of a search, title matches first, among the ones this actor may see.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), run_id: input.int(), q: input.text() },
  stack: [
    s.set_var("items", c.array([])),
    s.set_var("total", c.int(0)),
    s.set_var("wanted", withFilters(inp("q"), fl.trim())),
    s.conditional({ when: expr(withFilters(ref("wanted"), fl.strlen()), ">=", c.int(SHORTEST_QUERY)), then: [
      s.function.run({ fn: searchScopes, as: "scopes", input: { actor_id: inp("actor_id"), browser: inp("browser"), run_id: inp("run_id") } }),
      s.set_var("words", withFilters(ref("wanted"), fl.split(" "), fl.filter_empty_text())),
      ...Array.from({ length: MOST_WORDS }, (_, i) => s.set_var(`word_${i}`, withFilters(ref("words"), fl.get(String(i), "")))),
      found(hitsOn("title"), "titled"),
      found(hitsOn("terms"), "bodied"),
      s.update_var("items", withFilters(ref("titled"), fl.array_merge(ref("bodied")), fl.unique("key"), fl.array_slice(c.int(0), c.int(MOST_RESULTS)))),
      s.db.query({ table: search_entry, where: hitsOn("terms"), returnType: "count", as: "matches" }),
      s.update_var("total", ref("matches")),
    ] }),
  ],
  response: { items: ref("items"), total: ref("total") },
});

export const searchFunctions = [indexRecord, searchScopes, findRecords];
