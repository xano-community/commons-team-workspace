// Companies. One function per write, each taking `actor_id` and `browser`, so a person's route and an agent's tool run the same
// rules and leave the same trail. Each answers the company as a list shows it, so a screen can take the answer as it is.
import { c, cmp, col, defineFunction, expr, fl, inp, input, obj, ref, s, withFilters, type Value } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { company } from "../../table/crm/company.js";
import { contact } from "../../table/crm/contact.js";
import { deal } from "../../table/crm/deal.js";
import { closeItems } from "../inbox/deliver.js";
import { companyLink, editable, insertOnce, lengthRule, longText, notDeleted, reachable, requireCrm, requiredText, requireOwner, tellOwner, who, withOwner } from "./shared.js";

const MOST_NAME = 120;
const rowOf = (id: Value, as: string) => s.db.query({ table: company, where: cmp(col("id"), "=", id), returnType: "single", ...withOwner, as });
const fieldRules = [...requiredText("name", MOST_NAME, "Name the company.", "the name"), lengthRule("domain", 200, "the website"), lengthRule("industry", 120, "the industry"), longText("about")];

/** The contacts and deals a delete or a restore just moved, in `people` and `deals`: each is a record search holds. */
const indexEveryone = [
  s.foreach({ list: ref("people"), as: "moved", body: [s.function.run({ fn: "search/index", as: "indexed", input: { type: c.text("contact"), id: ref("moved.id") } })] }),
  s.foreach({ list: ref("deals"), as: "moved", body: [s.function.run({ fn: "search/index", as: "indexed", input: { type: c.text("deal"), id: ref("moved.id") } })] }),
];

export const createCompany = defineFunction({
  name: "crm/create_company",
  description: "Add a company. A repeat of client_id answers the company it made, and does nothing else.",
  input: { ...who, client_id: input.text({ required: true }), name: input.text(), domain: input.text(), industry: input.text(), about: input.text(), owner_id: input.int() },
  stack: [
    ...requireCrm(),
    ...fieldRules,
    requireOwner(inp("owner_id")),
    ...insertOnce(company, { name: inp("name"), domain: inp("domain"), industry: inp("industry"), about: inp("about"), owner_id: inp("owner_id"), created_by: inp("actor_id"), is_demo: c.bool(false) }),
    s.conditional({ when: expr(ref("fresh"), "=", c.bool(true)), then: [
      changed({ entity: "company", id: ref("row_id"), op: "created", verb: "created", actor: inp("actor_id"), crm: true, link: companyLink(ref("row_id")), title: "added a company" }),
      tellOwner(inp("owner_id"), "company", ref("row_id"), companyLink(ref("row_id"))),
    ] }),
    rowOf(ref("row_id"), "answer"),
  ],
  response: ref("answer"),
});

export const updateCompany = defineFunction({
  name: "crm/update_company",
  description: "Change a company's details.",
  input: { ...who, id: input.int({ required: true }), name: input.text(), domain: input.text(), industry: input.text(), about: input.text() },
  stack: [
    ...editable(company),
    ...fieldRules,
    s.db.patch({ table: company, fieldValue: inp("id"), data: obj({ name: inp("name"), domain: inp("domain"), industry: inp("industry"), about: inp("about") }) }),
    changed({ entity: "company", id: inp("id"), actor: inp("actor_id"), crm: true }),
    // A board and a contact list show the company's name beside each row.
    changed({ entity: "deal", id: c.int(0), actor: inp("actor_id"), crm: true }),
    changed({ entity: "contact", id: c.int(0), actor: inp("actor_id"), crm: true }),
    rowOf(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const assignCompany = defineFunction({
  name: "crm/assign_company",
  description: "Put a person or an agent in charge of a company, or nobody with 0.",
  input: { ...who, id: input.int({ required: true }), owner_id: input.int() },
  stack: [
    ...editable(company),
    s.conditional({ when: expr(ref("row.owner_id"), "!=", inp("owner_id")), then: [
      requireOwner(inp("owner_id")),
      s.db.patch({ table: company, fieldValue: inp("id"), data: obj({ owner_id: inp("owner_id") }) }),
      s.conditional({ when: expr(ref("row.owner_id"), ">", c.int(0)), then: [
        s.function.run({ fn: closeItems, as: "closed", input: { entity: c.text("company"), entity_id: inp("id"), kind: c.text("assigned"), user_id: ref("row.owner_id"), seq: c.int(0) } }),
      ] }),
      tellOwner(inp("owner_id"), "company", inp("id"), companyLink(inp("id"))),
      changed({ entity: "company", id: inp("id"), actor: inp("actor_id"), crm: true }),
    ] }),
    rowOf(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const deleteCompany = defineFunction({
  name: "crm/delete_company",
  description: "Put a company in the trash, with its contacts and deals. They share its stamp, so a restore brings back the same ones.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...reachable(company),
    // A second press, or a retry, finds it gone and answers the same row.
    s.conditional({ when: expr(ref("row.deleted_at"), "=", c.null()), then: [
      s.set_var("stamp", c.now()),
      s.db.patch({ table: company, fieldValue: inp("id"), data: obj({ deleted_at: ref("stamp") }) }),
      s.db.query({ table: contact, where: [cmp(col("company_id"), "=", inp("id")), notDeleted()], output: ["id"], as: "people" }),
      s.array.map({ source: ref("people"), as: "people_gone", transform: { id: ref("$this.id"), deleted_at: ref("stamp") } }),
      s.db.bulk.patch({ table: contact, items: ref("people_gone"), as: "people_patched" }),
      s.db.query({ table: deal, where: [cmp(col("company_id"), "=", inp("id")), notDeleted()], output: ["id"], as: "deals" }),
      s.array.map({ source: ref("deals"), as: "deals_gone", transform: { id: ref("$this.id"), deleted_at: ref("stamp") } }),
      s.db.bulk.patch({ table: deal, items: ref("deals_gone"), as: "deals_patched" }),
      s.foreach({ list: c.array(["mention", "assigned"]), as: "kind", body: [
        s.function.run({ fn: closeItems, as: "closed", input: { entity: c.text("company"), entity_id: inp("id"), kind: ref("kind"), user_id: c.int(0), seq: c.int(0) } }),
        s.foreach({ list: ref("deals"), as: "gone", body: [s.function.run({ fn: closeItems, as: "closed", input: { entity: c.text("deal"), entity_id: ref("gone.id"), kind: ref("kind"), user_id: c.int(0), seq: c.int(0) } })] }),
      ] }),
      changed({ entity: "company", id: inp("id"), op: "deleted", verb: "deleted", actor: inp("actor_id"), crm: true, link: companyLink(inp("id")), title: "deleted a company" }),
      changed({ entity: "deal", id: c.int(0), actor: inp("actor_id"), crm: true }),
      changed({ entity: "contact", id: c.int(0), actor: inp("actor_id"), crm: true }),
      ...indexEveryone,
    ] }),
    rowOf(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const restoreCompany = defineFunction({
  name: "crm/restore_company",
  description: "Bring a company back from the trash, with the contacts and deals that went with it.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...reachable(company),
    s.conditional({ when: expr(ref("row.deleted_at"), "!=", c.null()), then: [
      s.db.patch({ table: company, fieldValue: inp("id"), data: obj({ deleted_at: c.null() }) }),
      s.db.query({ table: contact, where: [cmp(col("company_id"), "=", inp("id")), cmp(col("deleted_at"), "=", ref("row.deleted_at"))], output: ["id"], as: "people" }),
      s.array.map({ source: ref("people"), as: "people_back", transform: { id: ref("$this.id"), deleted_at: c.null() } }),
      s.db.bulk.patch({ table: contact, items: ref("people_back"), as: "people_patched" }),
      s.db.query({ table: deal, where: [cmp(col("company_id"), "=", inp("id")), cmp(col("deleted_at"), "=", ref("row.deleted_at"))], output: ["id"], as: "deals" }),
      s.array.map({ source: ref("deals"), as: "deals_back", transform: { id: ref("$this.id"), deleted_at: c.null() } }),
      s.db.bulk.patch({ table: deal, items: ref("deals_back"), as: "deals_patched" }),
      changed({ entity: "company", id: inp("id"), op: "created", verb: "restored", actor: inp("actor_id"), crm: true, link: companyLink(inp("id")), title: "restored a company" }),
      changed({ entity: "deal", id: c.int(0), actor: inp("actor_id"), crm: true }),
      changed({ entity: "contact", id: c.int(0), actor: inp("actor_id"), crm: true }),
      ...indexEveryone,
    ] }),
    rowOf(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const companyFunctions = [createCompany, updateCompany, assignCompany, deleteCompany, restoreCompany];
