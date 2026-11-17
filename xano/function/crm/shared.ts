// What every CRM action shares. A CRM record lives in no space, so one rule covers them all: hold crm.read, or find nothing there.
import { c, cmp, col, expr, fl, guard, inp, input, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { user } from "../../table/user.js";
import { accessRule, NOT_FOUND } from "../access/reach.js";
import { deliverAsk } from "../inbox/deliver.js";

export const who = { actor_id: input.int({ required: true }), browser: input.bool() };
export const TRASHED = "This record was deleted.";
export const CANT_OPEN = "Choose someone who can open customers.";
const LONGEST_TEXT = 4000;

export const notDeleted = () => cmp(col("deleted_at"), "=", c.null());
export const companyLink = (id: Value) => withFilters(c.text("/crm/companies/"), fl.concat(id));
export const dealLink = (id: Value) => withFilters(c.text("/crm/deals/"), fl.concat(id));

/** Answers not found unless the actor reaches the CRM. */
export const requireCrm = () => statements(
  s.function.run({ fn: accessRule, as: "crm_reach", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
  guard.require(expr(ref("crm_reach"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
);

/** Binds `row` from a table, once the actor is known to reach the CRM. Anything else is not found. */
export const reachable = (table: Parameters<typeof s.db.get>[0]["table"], id: Value = inp("id")) => statements(
  ...requireCrm(),
  s.db.get({ table, fieldValue: id, as: "row" }),
  guard.found("row", { errorType: "notfound", message: NOT_FOUND }),
);
/** The same, for a change: a record in the trash reads, and takes no writes. */
export const editable = (table: Parameters<typeof s.db.get>[0]["table"], id: Value = inp("id")) => statements(
  ...reachable(table, id),
  guard.require(expr(ref("row.deleted_at"), "=", c.null()), { errorType: "badrequest", message: TRASHED }),
);

export const withOwner = {
  bind: [{ table: user, as: "owner", join: "left" as const, where: expr(col("owner_id"), "=", col("owner.id")) }],
  eval: [{ name: "owner.name", as: "owner_name" }, { name: "owner.kind", as: "owner_kind" }],
};

export const lengthRule = (field: string, most: number, words: string) => guard.require(expr(withFilters(inp(field), fl.strlen()), "<=", c.int(most)), { errorType: "badrequest", message: `Keep ${words} under ${most.toLocaleString("en")} characters.` });
export const requiredText = (field: string, most: number, missing: string, words: string) => statements(
  guard.require(expr(withFilters(inp(field), fl.trim(), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: missing }),
  lengthRule(field, most, words),
);
export const longText = (field: string) => lengthRule(field, LONGEST_TEXT, "this");

/** Refuses someone who couldn't open the record they'd own. A person or an agent, on the same rule. */
export const requireOwner = (person: Value) => s.conditional({ when: expr(person, ">", c.int(0)), then: [
  s.db.get({ table: user, fieldValue: person, output: ["kind", "status"], as: "candidate" }),
  s.set_var("candidate_kind", ref("candidate.kind", { safe: true })),
  s.function.run({ fn: accessRule, as: "candidate_reaches", input: { actor_id: person, browser: c.expression('$var.candidate_kind == "human"'), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
  guard.require(expr(ref("candidate_reaches"), "=", c.bool(true)), { errorType: "badrequest", message: CANT_OPEN }),
] });

/** Binds `key`, the sender's own id for a new row, so one person's can't answer with another's. */
export const bindKey = () => statements(
  guard.require(expr(withFilters(inp("client_id"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "This has no usable id." }),
  guard.require(expr(withFilters(inp("client_id"), fl.strlen()), "<=", c.int(64)), { errorType: "badrequest", message: "This has no usable id." }),
  s.set_var("key", withFilters(inp("actor_id"), fl.to_text(), fl.concat(c.text(":")), fl.concat(inp("client_id")))),
);

/**
 * Adds a row once. Binds `row_id`, and `fresh` when this call made it: a repeat, or the loser of two at once, has nothing to tell
 * anyone. The unique key on `client_id` is what decides, so a failed insert here means someone else's went in.
 */
export const insertOnce = (table: Parameters<typeof s.db.add>[0]["table"], row: Record<string, Value>) => statements(
  ...bindKey(),
  s.set_var("row_id", c.int(0)),
  s.set_var("fresh", c.bool(false)),
  s.db.query({ table, where: cmp(col("client_id"), "=", ref("key")), output: ["id"], returnType: "single", as: "made_before" }),
  s.conditional({
    when: expr(ref("made_before"), "=", c.null()),
    then: [s.try_catch({ try: [s.db.add({ table, as: "made", row: { ...row, client_id: ref("key") } }), s.update_var("row_id", ref("made.id")), s.update_var("fresh", c.bool(true))], catch: [] })],
    else: [s.update_var("row_id", ref("made_before.id", { safe: true }))],
  }),
  s.conditional({ when: expr(ref("row_id"), "=", c.int(0)), then: [
    s.db.query({ table, where: cmp(col("client_id"), "=", ref("key")), output: ["id"], returnType: "single", as: "won" }),
    s.update_var("row_id", ref("won.id", { safe: true })),
  ] }),
);

/** Tells someone a record is theirs. `deliver` skips whoever did it, and anyone who can't reach it. */
export const tellOwner = (person: Value, entity: string, id: Value, link: Value) => s.conditional({ when: expr(person, ">", c.int(0)), then: [
  s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["name"], as: "giver" }),
  s.function.run({ fn: deliverAsk, as: "told_owner", input: {
    user_id: person, kind: c.text("assigned"), title: withFilters(ref("giver.name", { safe: true }), fl.concat(c.text(` gave you a ${entity}`))), body: c.text(""), link, actor_id: inp("actor_id"),
    space_id: c.int(0), dm_id: c.int(0), entity: c.text(entity), entity_id: id, group_key: c.text(""), seq: c.int(0), crm: c.bool(true),
  } }),
] });
