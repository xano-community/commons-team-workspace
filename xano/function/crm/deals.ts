// Deals. A move names only the deal it lands above, so it's right in any filtered view, and the order is shared with everyone.
// The rank sums are the same as a task's, because a card must land where it will stay.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { company } from "../../table/crm/company.js";
import { contact } from "../../table/crm/contact.js";
import { deal } from "../../table/crm/deal.js";
import { pipeline_stage } from "../../table/crm/pipeline_stage.js";
import { NOT_FOUND } from "../access/reach.js";
import { closeItems } from "../inbox/deliver.js";
import { cleanDue } from "../tasks/tasks.js";
import { requireContactOf } from "./contacts.js";
import { dealLink, editable, insertOnce, notDeleted, reachable, requireCrm, requiredText, requireOwner, tellOwner, TRASHED, who, withOwner } from "./shared.js";

/** Must match frontend/src/lib/tasks/order.ts, which works out where a card lands before the server says. */
const STEP = 1_048_576;
const MOST_TITLE = 200;
const MOST_VALUE = 2_000_000_000;

export const withDealNames = {
  bind: [
    ...withOwner.bind,
    { table: company, as: "home", join: "left" as const, where: expr(col("company_id"), "=", col("home.id")) },
    { table: contact, as: "person", join: "left" as const, where: expr(col("contact_id"), "=", col("person.id")) },
    { table: pipeline_stage, as: "column", join: "left" as const, where: expr(col("stage_id"), "=", col("column.id")) },
  ],
  eval: [...withOwner.eval, { name: "home.name", as: "company_name" }, { name: "person.name", as: "contact_name" }, { name: "column.name", as: "stage_name" }, { name: "column.kind", as: "stage_kind" }],
};
/** The deal as every screen reads it, with who's on it and where it sits. */
export const dealRow = (id: Value, as: string) => s.db.query({ table: deal, where: cmp(col("id"), "=", id), returnType: "single", ...withDealNames, as });
const valueRules = statements(
  guard.require(expr(inp("value"), ">=", c.int(0)), { errorType: "badrequest", message: "A deal's value can't be below zero." }),
  guard.require(expr(inp("value"), "<=", c.int(MOST_VALUE)), { errorType: "badrequest", message: "That value is too large." }),
);
const titleRules = requiredText("title", MOST_TITLE, "Give the deal a title.", "the title");

/** Binds `target`, a stage that exists. */
const requireStage = (id: Value) => statements(
  s.db.get({ table: pipeline_stage, fieldValue: id, output: ["id", "kind", "name"], as: "target" }),
  guard.found("target", { errorType: "notfound", message: NOT_FOUND }),
);

/** The top of a stage. New deals and deals moved from a menu land here, where someone will see them. */
const topRank = defineFunction({
  name: "crm/top_rank",
  description: "A rank above everything in a stage.",
  input: { stage_id: input.int({ required: true }) },
  stack: [
    s.set_var("rank", c.int(0)),
    s.db.query({ table: deal, where: [cmp(col("stage_id"), "=", inp("stage_id")), notDeleted()], sort: [{ sortBy: "rank", dir: "asc" }], paging: { per_page: 1, metadata: false }, output: ["rank"], as: "edge" }),
    s.conditional({ when: expr(withFilters(ref("edge"), fl.count()), ">", c.int(0)), then: [s.update_var("rank", withFilters(ref("edge"), fl.first(), fl.get("rank"), fl.sub(c.int(STEP))))] }),
  ],
  response: ref("rank"),
});

/** Spreads a stage back out, keeping its order. It runs when two neighbours have no whole number left between them. */
const renumber = defineFunction({
  name: "crm/renumber",
  description: "Give every deal in a stage a fresh rank, in the same order.",
  input: { stage_id: input.int({ required: true }) },
  stack: [
    s.db.query({ table: deal, where: [cmp(col("stage_id"), "=", inp("stage_id")), notDeleted()], sort: [{ sortBy: "rank", dir: "asc" }, { sortBy: "id", dir: "asc" }], output: ["id"], as: "column" }),
    s.set_var("next_rank", c.int(0)),
    s.set_var("spread", c.array([])),
    s.foreach({ list: ref("column"), as: "item", body: [
      s.update_var("next_rank", withFilters(ref("next_rank"), fl.add(c.int(STEP)))),
      s.update_var("spread", withFilters(ref("spread"), fl.array_push(obj({ id: ref("item.id"), rank: ref("next_rank") })))),
    ] }),
    s.db.bulk.patch({ table: deal, items: ref("spread"), as: "spread_out" }),
  ],
  response: { ok: c.bool(true) },
});

/** Binds `gap_rank`, and `squeezed` when there's no room above `under_rank`, or another deal shares its rank. */
const findAbove = () => statements(
  s.db.query({ table: deal, where: [cmp(col("stage_id"), "=", inp("stage_id")), notDeleted(), cmp(col("id"), "!=", inp("id")), expr(col("rank"), "<", ref("under_rank"))], sort: [{ sortBy: "rank", dir: "desc" }], paging: { per_page: 1, metadata: false }, output: ["rank"], as: "above" }),
  s.db.query({ table: deal, where: [cmp(col("stage_id"), "=", inp("stage_id")), notDeleted(), cmp(col("id"), "!=", inp("id")), cmp(col("id"), "!=", inp("before_id")), cmp(col("rank"), "=", ref("under_rank"))], returnType: "count", as: "sharing" }),
  s.set_var("gap_rank", withFilters(ref("under_rank"), fl.sub(c.int(STEP)))),
  s.set_var("squeezed", c.expression("$var.sharing > 0")),
  s.conditional({ when: expr(withFilters(ref("above"), fl.count()), ">", c.int(0)), then: [
    s.set_var("above_rank", withFilters(ref("above"), fl.first(), fl.get("rank"))),
    s.update_var("gap_rank", c.expression("$var.above_rank + (($var.under_rank - $var.above_rank) / 2|floor)")),
    s.conditional({ when: expr(withFilters(ref("under_rank"), fl.sub(ref("above_rank"))), "<", c.int(2)), then: [s.update_var("squeezed", c.bool(true))] }),
  ] }),
);

/** Where a deal goes in a stage: just above `before_id`, or last with none. A neighbour that has left falls to the end, and never fails. */
const placeIn = defineFunction({
  name: "crm/place",
  description: "The rank that puts a deal above another in a stage, or at its end.",
  input: { id: input.int({ required: true }), stage_id: input.int({ required: true }), before_id: input.int() },
  stack: [
    s.set_var("place", c.int(0)),
    s.set_var("placed", c.bool(false)),
    s.conditional({ when: and(expr(inp("before_id"), ">", c.int(0)), expr(inp("before_id"), "!=", inp("id"))), then: [
      s.db.get({ table: deal, fieldValue: inp("before_id"), output: ["stage_id", "rank", "deleted_at"], as: "under" }),
      s.conditional({ when: and(expr(ref("under"), "!=", c.null()), expr(ref("under.stage_id", { safe: true }), "=", inp("stage_id")), expr(ref("under.deleted_at", { safe: true }), "=", c.null())), then: [
        s.set_var("under_rank", ref("under.rank", { safe: true })),
        ...findAbove(),
        s.conditional({ when: expr(ref("squeezed"), "=", c.bool(true)), then: [
          s.function.run({ fn: renumber, as: "renumbered", input: { stage_id: inp("stage_id") } }),
          s.db.get({ table: deal, fieldValue: inp("before_id"), output: ["rank"], as: "renumbered_under" }),
          s.update_var("under_rank", ref("renumbered_under.rank", { safe: true })),
          ...findAbove(),
        ] }),
        s.update_var("place", ref("gap_rank")),
        s.update_var("placed", c.bool(true)),
      ] }),
    ] }),
    s.conditional({ when: expr(ref("placed"), "=", c.bool(false)), then: [
      s.db.query({ table: deal, where: [cmp(col("stage_id"), "=", inp("stage_id")), notDeleted(), cmp(col("id"), "!=", inp("id"))], sort: [{ sortBy: "rank", dir: "desc" }], paging: { per_page: 1, metadata: false }, output: ["rank"], as: "edge" }),
      s.conditional({ when: expr(withFilters(ref("edge"), fl.count()), ">", c.int(0)), then: [s.update_var("place", withFilters(ref("edge"), fl.first(), fl.get("rank"), fl.add(c.int(STEP))))] }),
    ] }),
  ],
  response: ref("place"),
});

/** Writes where a deal sits, and stamps a close. Leaving a closed stage clears the stamp, so a deal can reopen. */
const applyPlace = defineFunction({
  name: "crm/apply_place",
  description: "Write a deal's stage and rank, with everything a close means.",
  input: { actor_id: input.int({ required: true }), id: input.int({ required: true }), stage_id: input.int({ required: true }), rank: input.int() },
  stack: [
    s.db.get({ table: deal, fieldValue: inp("id"), output: ["closed_at"], as: "was" }),
    s.db.get({ table: pipeline_stage, fieldValue: inp("stage_id"), output: ["kind"], as: "landing" }),
    s.set_var("landing_kind", ref("landing.kind", { safe: true })),
    s.set_var("closing", c.expression('$var.landing_kind != "open"')),
    s.set_var("closed_at", ref("was.closed_at", { safe: true })),
    s.set_var("was_closed", c.expression("$var.closed_at != null")),
    s.conditional({ when: expr(ref("closing"), "=", c.bool(false)), then: [s.update_var("closed_at", c.null())] }),
    s.conditional({ when: and(expr(ref("closing"), "=", c.bool(true)), expr(ref("was_closed"), "=", c.bool(false))), then: [s.update_var("closed_at", c.now())] }),
    s.db.patch({ table: deal, fieldValue: inp("id"), data: obj({ stage_id: inp("stage_id"), rank: inp("rank"), closed_at: ref("closed_at") }) }),
    s.conditional({
      when: and(expr(ref("closing"), "=", c.bool(true)), expr(ref("was_closed"), "=", c.bool(false))),
      then: [changed({ entity: "deal", id: inp("id"), op: "moved", verb: "closed", actor: inp("actor_id"), crm: true, link: dealLink(inp("id")), title: withFilters(c.text("marked a deal "), fl.concat(ref("landing.kind", { safe: true }))) })],
      else: [changed({ entity: "deal", id: inp("id"), op: "moved", actor: inp("actor_id"), crm: true })],
    }),
  ],
  response: { ok: c.bool(true) },
});

export const createDeal = defineFunction({
  name: "crm/create_deal",
  description: "Add a deal to a company. A repeat of client_id answers the deal it made, and does nothing else.",
  input: {
    ...who, client_id: input.text({ required: true }), company_id: input.int({ required: true }), stage_id: input.int({ required: true }), title: input.text(), value: input.int(), close_on: input.text(), owner_id: input.int(), contact_id: input.int(),
  },
  stack: [
    ...requireCrm(),
    s.db.get({ table: company, fieldValue: inp("company_id"), output: ["deleted_at"], as: "home_company" }),
    guard.found("home_company", { errorType: "notfound", message: NOT_FOUND }),
    guard.require(expr(ref("home_company.deleted_at"), "=", c.null()), { errorType: "badrequest", message: TRASHED }),
    ...requireStage(inp("stage_id")),
    ...titleRules,
    ...valueRules,
    s.function.run({ fn: cleanDue, as: "close_day", input: { due_on: inp("close_on") } }),
    requireOwner(inp("owner_id")),
    requireContactOf(inp("contact_id"), inp("company_id")),
    s.function.run({ fn: topRank, as: "rank", input: { stage_id: inp("stage_id") } }),
    s.set_var("closed_at", c.null()),
    s.conditional({ when: expr(ref("target.kind"), "!=", c.text("open")), then: [s.update_var("closed_at", c.now())] }),
    ...insertOnce(deal, {
      company_id: inp("company_id"), contact_id: inp("contact_id"), title: inp("title"), stage_id: inp("stage_id"), value: inp("value"), close_on: ref("close_day"), owner_id: inp("owner_id"), rank: ref("rank"), created_by: inp("actor_id"), closed_at: ref("closed_at"), is_demo: c.bool(false),
    }),
    s.conditional({ when: expr(ref("fresh"), "=", c.bool(true)), then: [
      changed({ entity: "deal", id: ref("row_id"), op: "created", verb: "created", actor: inp("actor_id"), crm: true, link: dealLink(ref("row_id")), title: "added a deal" }),
      changed({ entity: "company", id: inp("company_id"), actor: inp("actor_id"), crm: true }),
      tellOwner(inp("owner_id"), "deal", ref("row_id"), dealLink(ref("row_id"))),
    ] }),
    dealRow(ref("row_id"), "answer"),
  ],
  response: ref("answer"),
});

export const updateDeal = defineFunction({
  name: "crm/update_deal",
  description: "Change a deal's title, value, close date and who it's with.",
  input: { ...who, id: input.int({ required: true }), title: input.text(), value: input.int(), close_on: input.text(), contact_id: input.int() },
  stack: [
    ...editable(deal),
    ...titleRules,
    ...valueRules,
    s.function.run({ fn: cleanDue, as: "close_day", input: { due_on: inp("close_on") } }),
    requireContactOf(inp("contact_id"), ref("row.company_id")),
    s.db.patch({ table: deal, fieldValue: inp("id"), data: obj({ title: inp("title"), value: inp("value"), close_on: ref("close_day"), contact_id: inp("contact_id") }) }),
    changed({ entity: "deal", id: inp("id"), actor: inp("actor_id"), crm: true }),
    changed({ entity: "company", id: ref("row.company_id"), actor: inp("actor_id"), crm: true }),
    dealRow(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const setDealStage = defineFunction({
  name: "crm/set_stage",
  description: "Change a deal's stage. It lands at the top of its new column.",
  input: { ...who, id: input.int({ required: true }), stage_id: input.int({ required: true }) },
  stack: [
    ...editable(deal),
    ...requireStage(inp("stage_id")),
    s.conditional({ when: expr(ref("row.stage_id"), "!=", inp("stage_id")), then: [
      s.function.run({ fn: topRank, as: "rank", input: { stage_id: inp("stage_id") } }),
      s.function.run({ fn: applyPlace, as: "placed", input: { actor_id: inp("actor_id"), id: inp("id"), stage_id: inp("stage_id"), rank: ref("rank") } }),
      changed({ entity: "company", id: ref("row.company_id"), actor: inp("actor_id"), crm: true }),
    ] }),
    dealRow(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const moveDeal = defineFunction({
  name: "crm/move_deal",
  description: "Put a deal in a stage, just above another deal, or at the end with none. The order is shared with everyone.",
  input: { ...who, id: input.int({ required: true }), stage_id: input.int({ required: true }), before_id: input.int() },
  stack: [
    ...editable(deal),
    ...requireStage(inp("stage_id")),
    s.function.run({ fn: placeIn, as: "rank", input: { id: inp("id"), stage_id: inp("stage_id"), before_id: inp("before_id") } }),
    s.function.run({ fn: applyPlace, as: "placed", input: { actor_id: inp("actor_id"), id: inp("id"), stage_id: inp("stage_id"), rank: ref("rank") } }),
    dealRow(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const assignDeal = defineFunction({
  name: "crm/assign_deal",
  description: "Put a person or an agent on a deal, or nobody with 0. They must be able to open it, and whoever had it stops being told.",
  input: { ...who, id: input.int({ required: true }), owner_id: input.int() },
  stack: [
    ...editable(deal),
    s.conditional({ when: expr(ref("row.owner_id"), "!=", inp("owner_id")), then: [
      requireOwner(inp("owner_id")),
      s.db.patch({ table: deal, fieldValue: inp("id"), data: obj({ owner_id: inp("owner_id") }) }),
      s.conditional({ when: expr(ref("row.owner_id"), ">", c.int(0)), then: [
        s.function.run({ fn: closeItems, as: "closed", input: { entity: c.text("deal"), entity_id: inp("id"), kind: c.text("assigned"), user_id: ref("row.owner_id"), seq: c.int(0) } }),
      ] }),
      tellOwner(inp("owner_id"), "deal", inp("id"), dealLink(inp("id"))),
      changed({ entity: "deal", id: inp("id"), actor: inp("actor_id"), crm: true }),
    ] }),
    dealRow(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const deleteDeal = defineFunction({
  name: "crm/delete_deal",
  description: "Put a deal in the trash. It reads Deleted, its links stay, and it can be restored for 30 days.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...reachable(deal),
    s.conditional({ when: expr(ref("row.deleted_at"), "=", c.null()), then: [
      s.db.patch({ table: deal, fieldValue: inp("id"), data: obj({ deleted_at: c.now() }) }),
      s.function.run({ fn: closeItems, as: "closed_assigned", input: { entity: c.text("deal"), entity_id: inp("id"), kind: c.text("assigned"), user_id: c.int(0), seq: c.int(0) } }),
      s.function.run({ fn: closeItems, as: "closed_mentions", input: { entity: c.text("deal"), entity_id: inp("id"), kind: c.text("mention"), user_id: c.int(0), seq: c.int(0) } }),
      changed({ entity: "deal", id: inp("id"), op: "deleted", verb: "deleted", actor: inp("actor_id"), crm: true, link: dealLink(inp("id")), title: "deleted a deal" }),
      changed({ entity: "company", id: ref("row.company_id"), actor: inp("actor_id"), crm: true }),
    ] }),
    dealRow(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const restoreDeal = defineFunction({
  name: "crm/restore_deal",
  description: "Bring a deal back from the trash, to the top of its stage, unless its company is still in the trash.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...reachable(deal),
    s.db.get({ table: company, fieldValue: ref("row.company_id"), output: ["deleted_at"], as: "home_company" }),
    guard.require(expr(ref("home_company.deleted_at", { safe: true }), "=", c.null()), { errorType: "badrequest", message: "Restore the company first." }),
    s.conditional({ when: expr(ref("row.deleted_at"), "!=", c.null()), then: [
      s.function.run({ fn: topRank, as: "rank", input: { stage_id: ref("row.stage_id") } }),
      s.db.patch({ table: deal, fieldValue: inp("id"), data: obj({ deleted_at: c.null(), rank: ref("rank") }) }),
      changed({ entity: "deal", id: inp("id"), op: "created", verb: "restored", actor: inp("actor_id"), crm: true, link: dealLink(inp("id")), title: "restored a deal" }),
      changed({ entity: "company", id: ref("row.company_id"), actor: inp("actor_id"), crm: true }),
    ] }),
    dealRow(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

/** Someone left: nobody stays in charge in their name. The records wait for someone new, and the board shows they have no owner. */
export const releaseOwner = defineFunction({
  name: "crm/release_owner",
  description: "Take someone who left off every company and deal they owned.",
  input: { actor_id: input.int({ required: true }), user_id: input.int({ required: true }) },
  stack: [
    s.db.query({ table: deal, where: cmp(col("owner_id"), "=", inp("user_id")), output: ["id"], as: "deals" }),
    s.array.map({ source: ref("deals"), as: "deals_released", transform: { id: ref("$this.id"), owner_id: c.int(0) } }),
    s.db.bulk.patch({ table: deal, items: ref("deals_released"), as: "deals_patched" }),
    s.db.query({ table: company, where: cmp(col("owner_id"), "=", inp("user_id")), output: ["id"], as: "companies" }),
    s.array.map({ source: ref("companies"), as: "companies_released", transform: { id: ref("$this.id"), owner_id: c.int(0) } }),
    s.db.bulk.patch({ table: company, items: ref("companies_released"), as: "companies_patched" }),
    s.conditional({ when: expr(withFilters(ref("deals"), fl.count()), ">", c.int(0)), then: [changed({ entity: "deal", id: c.int(0), actor: inp("actor_id"), crm: true })] }),
    s.conditional({ when: expr(withFilters(ref("companies"), fl.count()), ">", c.int(0)), then: [changed({ entity: "company", id: c.int(0), actor: inp("actor_id"), crm: true })] }),
  ],
  response: { released: withFilters(ref("deals"), fl.count()) },
});

export const dealFunctions = [topRank, renumber, placeIn, applyPlace, createDeal, updateDeal, setDealStage, moveDeal, assignDeal, deleteDeal, restoreDeal, releaseOwner];
