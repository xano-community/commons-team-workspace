// What the customer screens read. Everything here is reached through crm.read alone, except a company's panels: those show records
// from spaces and DMs, so each is filtered for its viewer, and counted after that.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, or, qf, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { notification } from "../../base/tables.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { agent_run } from "../../table/agents/agent_run.js";
import { company } from "../../table/crm/company.js";
import { contact } from "../../table/crm/contact.js";
import { crm_note } from "../../table/crm/crm_note.js";
import { deal } from "../../table/crm/deal.js";
import { pipeline_stage } from "../../table/crm/pipeline_stage.js";
import { record_link } from "../../table/links/record_link.js";
import { conversation } from "../../table/messaging/conversation.js";
import { accessRule, NOT_FOUND, reachOf } from "../access/reach.js";
import { resolveRecords } from "../links/records.js";
import { dealRow, withDealNames } from "./deals.js";
import { notesOf } from "./notes.js";
import { notDeleted, reachable, requireCrm, who, withOwner } from "./shared.js";

const A_COLUMN = 100;
const MOST_IN_A_COLUMN = 500;
const A_PAGE = 50;
const SEARCH_RESULTS = 5;
const PANEL_SHOWS = 6;
const PANEL_SHOWS_AT_MOST = 50;
const MOST_ON_A_COMPANY = 100;
/** What a filter can search through. Past this a search says less, rather than slow every board. */
const MOST_MATCHED = 1000;

const stageOrder = (as: string) => s.db.query({ table: pipeline_stage, sort: [{ sortBy: "rank", dir: "asc" }, { sortBy: "id", dir: "asc" }], as });
const threadOf = (type: string, id: Value) => statements(
  s.set_var("thread_key", withFilters(c.text(`thread-${type}-`), fl.concat(id))),
  s.db.query({ table: conversation, where: cmp(col("unique_key"), "=", ref("thread_key")), output: ["id"], returnType: "single", as: "thread" }),
  s.set_var("thread_id", c.int(0)),
  s.conditional({ when: expr(ref("thread"), "!=", c.null()), then: [s.update_var("thread_id", ref("thread.id", { safe: true }))] }),
);
const unreadAbout = (type: string, id: Value) => s.db.query({ table: notification, where: [cmp(col("user_id"), "=", inp("actor_id")), cmp(col("entity"), "=", c.text(type)), cmp(col("entity_id"), "=", id), cmp(col("read_at"), "=", c.null())], returnType: "count", as: "unread_items" });

/** The stages and who can own a record: what every customer screen needs before it can show a menu. */
export const crmSetup = defineFunction({
  name: "crm/setup",
  description: "The pipeline's stages, who can own a record, and whether this actor may change the stages.",
  input: who,
  stack: [
    ...requireCrm(),
    stageOrder("stages"),
    s.db.query({ table: user, where: [cmp(col("role"), "in", c.array([...rbac.rolesWith("crm.read")])), cmp(col("status"), "=", c.text("active"))], sort: [{ sortBy: "name", dir: "asc" }], output: ["id", "name", "kind"], paging: { per_page: 500, metadata: false }, as: "people" }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["role"], as: "actor" }),
    s.set_var("can_manage", c.bool(false)),
    s.conditional({ when: expr(inp("browser"), "=", c.bool(true)), then: [s.conditional({ when: rbac.has(ref("actor.role", { safe: true }), "crm.manage"), then: [s.update_var("can_manage", c.bool(true))] })] }),
  ],
  response: { stages: ref("stages"), people: ref("people"), can_manage: ref("can_manage") },
});

/** Binds `matched`: the deals a search finds, by their title or their company's name. Empty with no search, and never empty with one. */
const bindMatched = statements(
  s.set_var("matched", c.array([])),
  s.conditional({ when: expr(inp("q"), "!=", c.text("")), then: [
    s.db.query({ table: company, where: [notDeleted(), cmp(col("name"), "includes", inp("q"))], output: ["id"], paging: { per_page: MOST_MATCHED, metadata: false }, as: "named_companies" }),
    s.array.map({ source: ref("named_companies"), as: "company_ids", transform: ref("$this.id") }),
    s.db.query({ table: deal, where: [notDeleted(), or(cmp(col("title"), "includes", inp("q")), cmp(col("company_id"), "in", ref("company_ids")))], output: ["id"], paging: { per_page: MOST_MATCHED, metadata: false }, as: "found_deals" }),
    s.array.map({ source: ref("found_deals"), as: "found_ids", transform: ref("$this.id") }),
    s.update_var("matched", withFilters(ref("found_ids"), fl.array_push(c.int(0)))),
  ] }),
);
const filtered = () => [
  notDeleted(), cmp(col("id"), "in", ref("matched"), { ignoreEmpty: true }), cmp(col("owner_id"), "in", ref("owners"), { ignoreEmpty: true }), cmp(col("company_id"), "=", inp("company_id"), { ignoreEmpty: true }),
  cmp(col("close_on"), ">=", inp("close_from"), { ignoreEmpty: true }), cmp(col("close_on"), "<=", inp("close_to"), { ignoreEmpty: true }),
];

/**
 * Every stage's first deals, in order, and what each holds in all. `ever` and `open` ignore the filters, so a screen can tell
 * "nothing yet" from "all closed" from "nothing matched".
 */
export const readPipeline = defineFunction({
  name: "crm/pipeline",
  description: "The pipeline's deals, stage by stage, narrowed by filters.",
  input: {
    ...who, q: input.text(), company_id: input.int(), close_from: input.text(), close_to: input.text(), limit: input.int(),
    /** A person, or -1 for nobody. */
    owner_id: input.int(),
  },
  stack: [
    ...requireCrm(),
    s.set_var("size", c.int(A_COLUMN)),
    s.conditional({ when: expr(inp("limit"), ">", c.int(0)), then: [s.update_var("size", withFilters(inp("limit"), fl.min(c.int(MOST_IN_A_COLUMN))))] }),
    s.set_var("owners", c.array([])),
    s.conditional({ when: expr(inp("owner_id"), ">", c.int(0)), then: [s.update_var("owners", withFilters(ref("owners"), fl.array_push(inp("owner_id"))))] }),
    s.conditional({ when: expr(inp("owner_id"), "<", c.int(0)), then: [s.update_var("owners", c.array([0]))] }),
    ...bindMatched,
    stageOrder("stage_rows"),
    s.set_var("items", c.array([])),
    s.set_var("stages", c.array([])),
    s.foreach({ list: ref("stage_rows"), as: "stage", body: [
      s.db.query({ table: deal, as: "rows", where: [cmp(col("stage_id"), "=", ref("stage.id")), ...filtered()], sort: [{ sortBy: "rank", dir: "asc" }, { sortBy: "id", dir: "asc" }], paging: { per_page: ref("size"), metadata: true, totals: true }, ...withDealNames }),
      s.db.query({ table: deal, as: "sums", where: [cmp(col("stage_id"), "=", ref("stage.id")), ...filtered()], returnType: "aggregate", aggregate: { group: [{ name: "stage_id", as: "stage_id" }], eval: [{ name: "value", as: "value", filters: [qf.sum()] }] } }),
      s.update_var("items", withFilters(ref("items"), fl.array_merge(ref("rows.items")))),
      s.update_var("stages", withFilters(ref("stages"), fl.array_push(withFilters(ref("stage"), fl.set("deals", ref("rows.itemsTotal")), fl.set("value", withFilters(ref("sums"), fl.first(), fl.get("value", 0), fl.to_int())))))),
    ] }),
    s.db.query({ table: deal, where: notDeleted(), returnType: "count", as: "ever" }),
    s.db.query({ table: deal, where: [notDeleted(), cmp(col("closed_at"), "=", c.null())], returnType: "count", as: "open" }),
    s.db.query({ table: company, where: notDeleted(), returnType: "count", as: "companies" }),
  ],
  response: { stages: ref("stages"), items: ref("items"), ever: ref("ever"), open: ref("open"), companies: ref("companies"), limit: ref("size") },
});

export const listCompanies = defineFunction({
  name: "crm/list_companies",
  description: "A page of companies, with what's open with each.",
  input: { ...who, q: input.text(), owner_id: input.int(), page: input.int() },
  stack: [
    ...requireCrm(),
    s.set_var("owners", c.array([])),
    s.conditional({ when: expr(inp("owner_id"), ">", c.int(0)), then: [s.update_var("owners", withFilters(ref("owners"), fl.array_push(inp("owner_id"))))] }),
    s.conditional({ when: expr(inp("owner_id"), "<", c.int(0)), then: [s.update_var("owners", c.array([0]))] }),
    s.db.query({ table: company, as: "rows", where: [notDeleted(), cmp(col("name"), "includes", inp("q"), { ignoreEmpty: true }), cmp(col("owner_id"), "in", ref("owners"), { ignoreEmpty: true })], sort: [{ sortBy: "name", dir: "asc" }], paging: { page: inp("page"), per_page: A_PAGE, metadata: true, totals: true }, ...withOwner }),
    s.array.map({ source: ref("rows.items"), as: "ids", transform: ref("$this.id") }),
    s.db.query({ table: deal, where: [cmp(col("company_id"), "in", ref("ids")), notDeleted(), cmp(col("closed_at"), "=", c.null())], output: ["company_id", "value"], paging: { per_page: MOST_MATCHED, metadata: false }, as: "open_deals" }),
    s.db.query({ table: contact, where: [cmp(col("company_id"), "in", ref("ids")), notDeleted()], output: ["company_id"], paging: { per_page: MOST_MATCHED, metadata: false }, as: "people" }),
    s.set_var("deals_by", withFilters(ref("open_deals"), fl.index_by("company_id"))),
    s.set_var("people_by", withFilters(ref("people"), fl.index_by("company_id"))),
    s.set_var("items", c.array([])),
    s.foreach({ list: ref("rows.items"), as: "row", body: [
      s.set_var("row_deals", withFilters(ref("deals_by"), fl.get(ref("row.id")), fl.first_notnull(c.array([])))),
      s.array.map({ source: ref("row_deals"), as: "row_values", transform: ref("$this.value") }),
      s.set_var("row_value", c.int(0)),
      s.conditional({ when: expr(withFilters(ref("row_values"), fl.count()), ">", c.int(0)), then: [s.update_var("row_value", withFilters(ref("row_values"), fl.sum()))] }),
      s.update_var("items", withFilters(ref("items"), fl.array_push(withFilters(ref("row"),
        fl.set("open_deals", withFilters(ref("row_deals"), fl.count())), fl.set("open_value", ref("row_value")), fl.set("contacts", withFilters(ref("people_by"), fl.get(ref("row.id")), fl.first_notnull(c.array([])), fl.count())))))),
    ] }),
    s.db.query({ table: company, where: notDeleted(), returnType: "count", as: "ever" }),
  ],
  response: { items: ref("items"), total: ref("rows.itemsTotal"), next_page: ref("rows.nextPage"), ever: ref("ever") },
});

export const listContacts = defineFunction({
  name: "crm/list_contacts",
  description: "A page of contacts, by name.",
  input: { ...who, q: input.text(), company_id: input.int(), page: input.int() },
  stack: [
    ...requireCrm(),
    s.db.query({ table: contact, as: "rows", where: [notDeleted(), cmp(col("name"), "includes", inp("q"), { ignoreEmpty: true }), cmp(col("company_id"), "=", inp("company_id"), { ignoreEmpty: true })], sort: [{ sortBy: "name", dir: "asc" }], paging: { page: inp("page"), per_page: A_PAGE, metadata: true, totals: true },
      bind: [{ table: company, as: "home", join: "left", where: expr(col("company_id"), "=", col("home.id")) }], eval: [{ name: "home.name", as: "company_name" }] }),
    s.db.query({ table: contact, where: notDeleted(), returnType: "count", as: "ever" }),
  ],
  response: { items: ref("rows.items"), total: ref("rows.itemsTotal"), next_page: ref("rows.nextPage"), ever: ref("ever") },
});

/** For ⌘K, a mention or a link. Someone who can't open customers finds nothing, rather than a refusal a search box would have to explain. */
export const searchCrm = defineFunction({
  name: "crm/search",
  description: "Companies, deals and contacts whose name matches, for an actor who reaches the CRM.",
  input: { ...who, q: input.text() },
  stack: [
    s.set_var("found", c.array([])),
    s.function.run({ fn: accessRule, as: "crm_reach", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
    s.conditional({ when: and(expr(ref("crm_reach"), "=", c.bool(true)), expr(withFilters(inp("q"), fl.strlen()), ">=", c.int(1))), then: [
      s.db.query({ table: company, where: [notDeleted(), cmp(col("name"), "includes", inp("q"))], sort: [{ sortBy: "name", dir: "asc" }], paging: { per_page: SEARCH_RESULTS, metadata: false }, output: ["id", "name", "industry"], as: "companies" }),
      s.db.query({ table: deal, where: [notDeleted(), cmp(col("title"), "includes", inp("q"))], sort: [{ sortBy: "title", dir: "asc" }], paging: { per_page: SEARCH_RESULTS, metadata: false }, ...withDealNames, as: "deals" }),
      s.db.query({ table: contact, where: [notDeleted(), cmp(col("name"), "includes", inp("q"))], sort: [{ sortBy: "name", dir: "asc" }], paging: { per_page: SEARCH_RESULTS, metadata: false }, bind: [{ table: company, as: "home", join: "left", where: expr(col("company_id"), "=", col("home.id")) }], eval: [{ name: "home.name", as: "company_name" }], as: "people" }),
      s.array.map({ source: ref("companies"), as: "company_hits", transform: { type: c.text("company"), id: ref("$this.id"), title: ref("$this.name"), hint: ref("$this.industry") } }),
      s.array.map({ source: ref("deals"), as: "deal_hits", transform: { type: c.text("deal"), id: ref("$this.id"), title: ref("$this.title"), hint: ref("$this.company_name") } }),
      s.array.map({ source: ref("people"), as: "contact_hits", transform: { type: c.text("contact"), id: ref("$this.id"), title: ref("$this.name"), hint: ref("$this.company_name") } }),
      s.update_var("found", withFilters(ref("company_hits"), fl.array_merge(ref("deal_hits")), fl.array_merge(ref("contact_hits")))),
    ] }),
  ],
  response: ref("found"),
});

/** A where for links touching a company or anything under it, on one side of the link. */
const familyOn = (side: "from" | "to", withNotes: boolean) => or(
  and(cmp(col(`${side}_type`), "=", c.text("company")), cmp(col(`${side}_id`), "=", inp("id"))),
  and(cmp(col(`${side}_type`), "=", c.text("deal")), cmp(col(`${side}_id`), "in", ref("deal_ids"))),
  and(cmp(col(`${side}_type`), "=", c.text("contact")), cmp(col(`${side}_id`), "in", ref("contact_ids"))),
  ...(withNotes ? [and(cmp(col(`${side}_type`), "=", c.text("crm_note")), cmp(col(`${side}_id`), "in", ref("note_ids")))] : []),
);

/**
 * One panel: what links to the company and what it links to, of these types. A link into it can be filtered in the query, so its
 * total is what this viewer may see. A link out of it is resolved, and what the viewer can't reach is left out here: a panel holds
 * no locked rows, because a row of the right kind says something itself. `total` counts what's left, and only that.
 */
const panel = (key: string, types: string[]) => statements(
  s.db.query({ table: record_link, where: [familyOn("to", false), cmp(col("from_type"), "in", c.array(types)), cmp(col("from_scope"), "in", ref("reach.scopes"))], sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: ref("shows"), metadata: true, totals: true }, as: `${key}_in` }),
  s.db.query({ table: record_link, where: [familyOn("from", true), cmp(col("to_type"), "in", c.array(types))], sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: ref("shows"), metadata: false }, as: `${key}_out` }),
  s.array.map({ source: ref(`${key}_in.items`), as: `${key}_in_refs`, transform: { type: ref("$this.from_type"), id: ref("$this.from_id") } }),
  s.array.map({ source: ref(`${key}_out`), as: `${key}_out_refs`, transform: { type: ref("$this.to_type"), id: ref("$this.to_id") } }),
  s.set_var("seen", c.array([])),
  s.set_var("wanted", c.array([])),
  s.foreach({ list: withFilters(ref(`${key}_in_refs`), fl.array_merge(ref(`${key}_out_refs`))), as: "item", body: [
    s.set_var("item_key", withFilters(ref("item.type"), fl.concat(c.text("-")), fl.concat(ref("item.id")))),
    s.conditional({ when: expr(withFilters(ref("seen"), fl.in(ref("item_key"))), "=", c.bool(false)), then: [
      s.update_var("seen", withFilters(ref("seen"), fl.array_push(ref("item_key")))),
      s.update_var("wanted", withFilters(ref("wanted"), fl.array_push(ref("item")))),
    ] }),
  ] }),
  s.function.run({ fn: resolveRecords, as: "views", input: { actor_id: inp("actor_id"), browser: inp("browser"), items: ref("wanted") } }),
  s.array.filter({ expr: ref("views"), if: expr(withFilters(c.array(["live", "archived"]), fl.in(ref("$this.state"))), "=", c.bool(true)), as: `${key}_shown` }),
  s.set_var(`${key}_total`, withFilters(ref(`${key}_in.itemsTotal`), fl.sub(withFilters(ref(`${key}_in.items`), fl.count())), fl.add(withFilters(ref(`${key}_shown`), fl.count())))),
);
const inPanel = (key: string) => obj({ items: withFilters(ref(`${key}_shown`), fl.array_slice(c.int(0), ref("shows"))), total: ref(`${key}_total`) });

export const companyPanels = defineFunction({
  name: "crm/panels",
  description: "What's linked to a company and everything under it, in chat, tasks, docs and files, as this viewer may see it.",
  input: { ...who, id: input.int({ required: true }), limit: input.int() },
  stack: [
    ...reachable(company),
    reachOf(inp("actor_id"), inp("browser")),
    s.set_var("shows", c.int(PANEL_SHOWS)),
    s.conditional({ when: expr(inp("limit"), ">", c.int(0)), then: [s.update_var("shows", withFilters(inp("limit"), fl.min(c.int(PANEL_SHOWS_AT_MOST))))] }),
    s.db.query({ table: deal, where: cmp(col("company_id"), "=", inp("id")), output: ["id"], paging: { per_page: MOST_ON_A_COMPANY, metadata: false }, as: "deals" }),
    s.array.map({ source: ref("deals"), as: "deal_ids", transform: ref("$this.id") }),
    s.db.query({ table: contact, where: cmp(col("company_id"), "=", inp("id")), output: ["id"], paging: { per_page: MOST_ON_A_COMPANY, metadata: false }, as: "people" }),
    s.array.map({ source: ref("people"), as: "contact_ids", transform: ref("$this.id") }),
    s.db.query({ table: crm_note, where: [cmp(col("company_id"), "=", inp("id")), notDeleted()], output: ["id"], paging: { per_page: MOST_ON_A_COMPANY, metadata: false }, as: "notes" }),
    s.array.map({ source: ref("notes"), as: "note_ids", transform: ref("$this.id") }),
    ...panel("chat", ["conversation", "message"]),
    ...panel("tasks", ["task"]),
    ...panel("docs", ["doc"]),
    ...panel("files", ["file"]),
  ],
  response: { chat: inPanel("chat"), tasks: inPanel("tasks"), docs: inPanel("docs"), files: inPanel("files") },
});

export const readCompany = defineFunction({
  name: "crm/read_company",
  description: "One company, the people and deals under it, its notes, and what's linked to it as this viewer may see it.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...reachable(company),
    s.db.query({ table: company, where: cmp(col("id"), "=", inp("id")), returnType: "single", ...withOwner, as: "answer" }),
    s.db.query({ table: contact, where: [cmp(col("company_id"), "=", inp("id")), notDeleted()], sort: [{ sortBy: "name", dir: "asc" }], paging: { per_page: MOST_ON_A_COMPANY, metadata: false }, as: "contacts" }),
    s.db.query({ table: deal, where: [cmp(col("company_id"), "=", inp("id")), notDeleted()], sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: MOST_ON_A_COMPANY, metadata: false }, ...withDealNames, as: "deals" }),
    notesOf(inp("id"), "notes"),
    s.function.run({ fn: companyPanels, as: "panels", input: { actor_id: inp("actor_id"), browser: inp("browser"), id: inp("id"), limit: c.int(PANEL_SHOWS) } }),
    ...threadOf("company", inp("id")),
    unreadAbout("company", inp("id")),
  ],
  response: {
    company: ref("answer"), contacts: ref("contacts"), deals: ref("deals"), notes: ref("notes"), panels: ref("panels"), thread_id: ref("thread_id"), unread_items: ref("unread_items"),
    trashed: c.expression("$var.row.deleted_at != null"), can_edit: c.expression("$var.row.deleted_at == null"),
  },
});

export const readDeal = defineFunction({
  name: "crm/read_deal",
  description: "One deal, the people at its company, its notes, and what this actor may do.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...reachable(deal),
    dealRow(inp("id"), "answer"),
    s.db.query({ table: contact, where: [cmp(col("company_id"), "=", ref("row.company_id")), notDeleted()], sort: [{ sortBy: "name", dir: "asc" }], paging: { per_page: MOST_ON_A_COMPANY, metadata: false }, as: "contacts" }),
    s.db.query({ table: crm_note, where: [cmp(col("record_type"), "=", c.text("deal")), cmp(col("record_id"), "=", inp("id")), notDeleted()], sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: 50, metadata: false },
      bind: [{ table: user, as: "writer", join: "left", where: expr(col("author_id"), "=", col("writer.id")) }], eval: [{ name: "writer.name", as: "author_name" }, { name: "writer.kind", as: "author_kind" }], as: "notes" }),
    ...threadOf("deal", inp("id")),
    unreadAbout("deal", inp("id")),
  ],
  response: {
    deal: ref("answer"), contacts: ref("contacts"), notes: ref("notes"), thread_id: ref("thread_id"), unread_items: ref("unread_items"),
    trashed: c.expression("$var.row.deleted_at != null"), can_edit: c.expression("$var.row.deleted_at == null"),
  },
});

/** One line a model can act on. */
const dealLine = (row: string) => withFilters(c.text("deal "), fl.concat(ref(`${row}.id`, { safe: true })), fl.concat(c.text(": ")), fl.concat(ref(`${row}.title`, { safe: true })), fl.concat(c.text(", stage ")), fl.concat(ref(`${row}.stage_name`, { safe: true })),
  fl.concat(c.text(", value ")), fl.concat(ref(`${row}.value`, { safe: true })), fl.concat(c.text(", at ")), fl.concat(ref(`${row}.company_name`, { safe: true })), fl.concat(c.text(" (company ")), fl.concat(ref(`${row}.company_id`, { safe: true })), fl.concat(c.text(")\n")));

/** The customers a run has in front of it, for its context. An agent or a requester who can't open customers gets nothing here. */
export const runCustomers = defineFunction({
  name: "crm/run_context",
  description: "The CRM records a run is about, as text for the model. Empty unless both the agent and the requester hold crm.read.",
  input: { run_id: input.int({ required: true }) },
  stack: [
    s.set_var("text", c.text("")),
    s.db.get({ table: agent_run, fieldValue: inp("run_id"), as: "run" }),
    guard.found("run", { errorType: "notfound", message: NOT_FOUND }),
    s.function.run({ fn: accessRule, as: "agent_reaches", input: { actor_id: ref("run.agent_id"), browser: c.bool(false), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
    s.db.get({ table: user, fieldValue: ref("run.requested_by"), output: ["kind"], as: "asker" }),
    s.set_var("asker_kind", ref("asker.kind", { safe: true })),
    s.function.run({ fn: accessRule, as: "asker_reaches", input: { actor_id: ref("run.requested_by"), browser: c.expression('$var.asker_kind == "human"'), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
    s.conditional({ when: and(expr(ref("agent_reaches"), "=", c.bool(true)), expr(ref("asker_reaches"), "=", c.bool(true)), expr(ref("run.dm_id"), "=", c.int(0))), then: [
      // What it's about: the record itself, the record its thread hangs from, and whatever the source links to.
      s.set_var("source_type", ref("run.source_type")),
      s.set_var("source_id", ref("run.source_id")),
      s.conditional({ when: expr(ref("run.source_type"), "=", c.text("message")), then: [
        s.db.get({ table: conversation, fieldValue: ref("run.conversation_id"), output: ["record_type", "record_id"], as: "place" }),
        s.conditional({ when: expr(ref("place.record_type", { safe: true }), "!=", c.text("")), then: [s.update_var("source_type", ref("place.record_type", { safe: true })), s.update_var("source_id", ref("place.record_id", { safe: true }))] }),
      ] }),
      s.set_var("deal_ids", c.array([])),
      s.set_var("company_ids", c.array([])),
      s.conditional({ when: expr(ref("source_type"), "=", c.text("deal")), then: [s.update_var("deal_ids", withFilters(ref("deal_ids"), fl.array_push(ref("source_id"))))] }),
      s.conditional({ when: expr(ref("source_type"), "=", c.text("company")), then: [s.update_var("company_ids", withFilters(ref("company_ids"), fl.array_push(ref("source_id"))))] }),
      s.db.query({ table: record_link, where: or(
        and(cmp(col("from_type"), "=", ref("source_type")), cmp(col("from_id"), "=", ref("source_id")), cmp(col("to_type"), "in", c.array(["deal", "company"]))),
        and(cmp(col("to_type"), "=", ref("source_type")), cmp(col("to_id"), "=", ref("source_id")), cmp(col("from_type"), "in", c.array(["deal", "company"]))),
      ), paging: { per_page: 20, metadata: false }, as: "links" }),
      s.foreach({ list: ref("links"), as: "link", body: [
        s.conditional({ when: expr(ref("link.to_type"), "=", c.text("deal")), then: [s.update_var("deal_ids", withFilters(ref("deal_ids"), fl.array_push(ref("link.to_id"))))] }),
        s.conditional({ when: expr(ref("link.from_type"), "=", c.text("deal")), then: [s.update_var("deal_ids", withFilters(ref("deal_ids"), fl.array_push(ref("link.from_id"))))] }),
        s.conditional({ when: expr(ref("link.to_type"), "=", c.text("company")), then: [s.update_var("company_ids", withFilters(ref("company_ids"), fl.array_push(ref("link.to_id"))))] }),
        s.conditional({ when: expr(ref("link.from_type"), "=", c.text("company")), then: [s.update_var("company_ids", withFilters(ref("company_ids"), fl.array_push(ref("link.from_id"))))] }),
      ] }),
      s.db.query({ table: deal, where: [notDeleted(), or(cmp(col("id"), "in", ref("deal_ids")), cmp(col("company_id"), "in", ref("company_ids")))], paging: { per_page: 10, metadata: false }, ...withDealNames, as: "deals" }),
      s.db.query({ table: company, where: [notDeleted(), cmp(col("id"), "in", ref("company_ids"))], paging: { per_page: 10, metadata: false }, output: ["id", "name", "about"], as: "companies" }),
      s.foreach({ list: ref("companies"), as: "row", body: [
        s.update_var("text", withFilters(ref("text"), fl.concat(c.text("company ")), fl.concat(ref("row.id")), fl.concat(c.text(": ")), fl.concat(ref("row.name")), fl.concat(c.text(". ")), fl.concat(ref("row.about")), fl.concat(c.text("\n")))),
      ] }),
      s.foreach({ list: ref("deals"), as: "row", body: [s.update_var("text", withFilters(ref("text"), fl.concat(dealLine("row"))))] }),
      // What was just written on it: where a note names an agent, this is the request.
      s.db.query({ table: crm_note, where: [notDeleted(), cmp(col("record_type"), "=", ref("source_type")), cmp(col("record_id"), "=", ref("source_id"))], sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: 5, metadata: false }, output: ["body"], as: "notes" }),
      s.foreach({ list: ref("notes"), as: "row", body: [s.update_var("text", withFilters(ref("text"), fl.concat(c.text("note: ")), fl.concat(ref("row.body")), fl.concat(c.text("\n"))))] }),
      s.conditional({ when: expr(ref("text"), "!=", c.text("")), then: [
        stageOrder("stages"),
        s.array.map({ source: ref("stages"), as: "stage_names", transform: ref("$this.name") }),
        s.update_var("text", withFilters(ref("text"), fl.concat(c.text("Stages: ")), fl.concat(withFilters(ref("stage_names"), fl.join(", "))), fl.concat(c.text("\n")))),
      ] }),
    ] }),
  ],
  response: ref("text"),
});

export const readFunctions = [crmSetup, readPipeline, listCompanies, listContacts, searchCrm, companyPanels, readCompany, readDeal, runCustomers];
