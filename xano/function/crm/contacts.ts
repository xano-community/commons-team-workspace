// Contacts: the people at a company. They always sit under one, so they arrive and leave with it.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters, type Value } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { company } from "../../table/crm/company.js";
import { contact } from "../../table/crm/contact.js";
import { NOT_FOUND } from "../access/reach.js";
import { companyLink, editable, insertOnce, lengthRule, reachable, requireCrm, requiredText, TRASHED, who } from "./shared.js";

const withCompany = {
  bind: [{ table: company, as: "home", join: "left" as const, where: expr(col("company_id"), "=", col("home.id")) }],
  eval: [{ name: "home.name", as: "company_name" }],
};
export const contactRow = (id: Value, as: string) => s.db.query({ table: contact, where: cmp(col("id"), "=", id), returnType: "single", ...withCompany, as });
const fieldRules = [
  ...requiredText("name", 120, "Name the contact.", "the name"), lengthRule("phone", 40, "the phone number"), lengthRule("job_title", 120, "the job title"), lengthRule("email", 200, "the email address"),
  s.conditional({ when: expr(inp("email"), "!=", c.text("")), then: [
    guard.require(expr(withFilters(c.regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/), fl.regex_test(inp("email"))), "=", c.bool(true)), { errorType: "badrequest", message: "Check the email address." }),
  ] }),
];

export const createContact = defineFunction({
  name: "crm/create_contact",
  description: "Add a person to a company. A repeat of client_id answers the contact it made.",
  input: { ...who, client_id: input.text({ required: true }), company_id: input.int({ required: true }), name: input.text(), email: input.text(), phone: input.text(), job_title: input.text() },
  stack: [
    ...requireCrm(),
    s.db.get({ table: company, fieldValue: inp("company_id"), output: ["deleted_at"], as: "home_company" }),
    guard.found("home_company", { errorType: "notfound", message: NOT_FOUND }),
    guard.require(expr(ref("home_company.deleted_at"), "=", c.null()), { errorType: "badrequest", message: TRASHED }),
    ...fieldRules,
    ...insertOnce(contact, { company_id: inp("company_id"), name: inp("name"), email: inp("email"), phone: inp("phone"), job_title: inp("job_title"), created_by: inp("actor_id"), is_demo: c.bool(false) }),
    s.conditional({ when: expr(ref("fresh"), "=", c.bool(true)), then: [
      changed({ entity: "contact", id: ref("row_id"), op: "created", verb: "created", actor: inp("actor_id"), crm: true, link: companyLink(inp("company_id")), title: "added a contact" }),
      changed({ entity: "company", id: inp("company_id"), actor: inp("actor_id"), crm: true }),
    ] }),
    contactRow(ref("row_id"), "answer"),
  ],
  response: ref("answer"),
});

export const updateContact = defineFunction({
  name: "crm/update_contact",
  description: "Change a contact's details.",
  input: { ...who, id: input.int({ required: true }), name: input.text(), email: input.text(), phone: input.text(), job_title: input.text() },
  stack: [
    ...editable(contact),
    ...fieldRules,
    s.db.patch({ table: contact, fieldValue: inp("id"), data: obj({ name: inp("name"), email: inp("email"), phone: inp("phone"), job_title: inp("job_title") }) }),
    changed({ entity: "contact", id: inp("id"), actor: inp("actor_id"), crm: true }),
    changed({ entity: "company", id: ref("row.company_id"), actor: inp("actor_id"), crm: true }),
    contactRow(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const deleteContact = defineFunction({
  name: "crm/delete_contact",
  description: "Put a contact in the trash. A deal that named them stops naming them when they're purged.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...reachable(contact),
    s.conditional({ when: expr(ref("row.deleted_at"), "=", c.null()), then: [
      s.db.patch({ table: contact, fieldValue: inp("id"), data: obj({ deleted_at: c.now() }) }),
      changed({ entity: "contact", id: inp("id"), op: "deleted", verb: "deleted", actor: inp("actor_id"), crm: true, link: companyLink(ref("row.company_id")), title: "deleted a contact" }),
      changed({ entity: "company", id: ref("row.company_id"), actor: inp("actor_id"), crm: true }),
      changed({ entity: "deal", id: c.int(0), actor: inp("actor_id"), crm: true }),
    ] }),
    contactRow(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const restoreContact = defineFunction({
  name: "crm/restore_contact",
  description: "Bring a contact back from the trash, unless their company is still in it.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...reachable(contact),
    s.db.get({ table: company, fieldValue: ref("row.company_id"), output: ["deleted_at"], as: "home_company" }),
    guard.require(expr(ref("home_company.deleted_at", { safe: true }), "=", c.null()), { errorType: "badrequest", message: "Restore the company first." }),
    s.conditional({ when: expr(ref("row.deleted_at"), "!=", c.null()), then: [
      s.db.patch({ table: contact, fieldValue: inp("id"), data: obj({ deleted_at: c.null() }) }),
      changed({ entity: "contact", id: inp("id"), op: "created", verb: "restored", actor: inp("actor_id"), crm: true, link: companyLink(ref("row.company_id")), title: "restored a contact" }),
      changed({ entity: "company", id: ref("row.company_id"), actor: inp("actor_id"), crm: true }),
    ] }),
    contactRow(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

/** Who a deal is with, when it says: someone at its own company, or nobody with 0. */
export const requireContactOf = (contactId: Value, companyId: Value) => s.conditional({ when: expr(contactId, ">", c.int(0)), then: [
  s.db.get({ table: contact, fieldValue: contactId, output: ["company_id", "deleted_at"], as: "named_contact" }),
  guard.require(expr(ref("named_contact.company_id", { safe: true }), "=", companyId), { errorType: "badrequest", message: "Choose someone at this deal's company." }),
] });

export const contactFunctions = [createContact, updateContact, deleteContact, restoreContact];
