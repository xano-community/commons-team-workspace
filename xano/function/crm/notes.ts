// Notes on a company, a contact or a deal. A mention reaches people through `deliver`, which leaves out anyone who can't open
// customers, and no inbox item ever holds a note's words: it names the record, and each reader opens it or doesn't.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { user } from "../../table/user.js";
import { contact } from "../../table/crm/contact.js";
import { crm_note, NOTE_RECORDS } from "../../table/crm/crm_note.js";
import { deal } from "../../table/crm/deal.js";
import { accessRule, NOT_FOUND } from "../access/reach.js";
import { closeItems, deliverAsk } from "../inbox/deliver.js";
import { addBodyLinks, forgetRecord, reconcileLinks } from "../links/links.js";
import { locate } from "../links/records.js";
import { readTokens } from "../messaging/messages.js";
import { insertOnce, reachable, requireCrm, requiredText, TRASHED, who } from "./shared.js";

const LONGEST = 8000;
const withAuthor = {
  bind: [{ table: user, as: "writer", join: "left" as const, where: expr(col("author_id"), "=", col("writer.id")) }],
  eval: [{ name: "writer.name", as: "author_name" }, { name: "writer.kind", as: "author_kind" }],
};
export const noteRow = (id: Value, as: string) => s.db.query({ table: crm_note, where: cmp(col("id"), "=", id), returnType: "single", ...withAuthor, as });
/** A company's notes, newest first, however they came to be under it. */
export const notesOf = (companyId: Value, as: string, most = 50) => s.db.query({ table: crm_note, where: [cmp(col("company_id"), "=", companyId), cmp(col("deleted_at"), "=", c.null())], sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: most, metadata: false }, ...withAuthor, as });
const bodyRules = requiredText("body", LONGEST, "Write something first.", "a note");

/** Binds `home_company`: the company a record comes under. */
const bindCompany = statements(
  s.set_var("home_company", inp("record_id")),
  s.switch({ on: inp("record_type"), cases: [
    { when: c.text("contact"), break: true, body: [s.db.get({ table: contact, fieldValue: inp("record_id"), output: ["company_id"], as: "under" }), s.update_var("home_company", ref("under.company_id", { safe: true }))] },
    { when: c.text("deal"), break: true, body: [s.db.get({ table: deal, fieldValue: inp("record_id"), output: ["company_id"], as: "under" }), s.update_var("home_company", ref("under.company_id", { safe: true }))] },
  ] }),
);

/** Tells whoever a note newly names. Sent under the note's own id, so an edit can't tell anyone twice. */
const tellNamed = defineFunction({
  name: "crm/tell_named",
  description: "Put a note's new mentions in the inboxes of the people it names who can open customers.",
  input: { actor_id: input.int({ required: true }), note_id: input.int({ required: true }), record_type: input.text({ required: true }), record_id: input.int({ required: true }), people: input.json() },
  stack: [
    s.function.run({ fn: locate, as: "place", input: { type: inp("record_type"), id: inp("record_id") } }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["name"], as: "writer" }),
    s.foreach({ list: inp("people"), as: "person_id", body: [
      s.function.run({ fn: deliverAsk, as: "told_person", input: {
        user_id: ref("person_id"), kind: c.text("mention"), title: withFilters(ref("writer.name", { safe: true }), fl.concat(c.text(" mentioned you"))), body: c.text(""), link: ref("place.href"), actor_id: inp("actor_id"),
        space_id: c.int(0), dm_id: c.int(0), entity: inp("record_type"), entity_id: inp("record_id"), group_key: c.text(""), seq: inp("note_id"), crm: c.bool(true),
      } }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

export const addNote = defineFunction({
  name: "crm/add_note",
  description: "Add a note to a record. A repeat of client_id answers the note it made, and does nothing else.",
  input: { ...who, client_id: input.text({ required: true }), record_type: input.enum(NOTE_RECORDS, { required: true }), record_id: input.int({ required: true }), body: input.text() },
  stack: [
    ...requireCrm(),
    s.function.run({ fn: locate, as: "target", input: { type: inp("record_type"), id: inp("record_id") } }),
    guard.require(expr(ref("target.found"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
    guard.require(expr(ref("target.trashed"), "=", c.bool(false)), { errorType: "badrequest", message: TRASHED }),
    ...bodyRules,
    ...bindCompany,
    ...insertOnce(crm_note, { record_type: inp("record_type"), record_id: inp("record_id"), company_id: ref("home_company"), body: inp("body"), author_id: inp("actor_id"), is_demo: c.bool(false) }),
    s.conditional({ when: expr(ref("fresh"), "=", c.bool(true)), then: [
      changed({ entity: "crm_note", id: ref("row_id"), op: "created", verb: "noted", actor: inp("actor_id"), crm: true, link: ref("target.href"), title: "added a note" }),
      s.function.run({ fn: readTokens, as: "named", input: { body: inp("body") } }),
      s.function.run({ fn: tellNamed, as: "told", input: { actor_id: inp("actor_id"), note_id: ref("row_id"), record_type: inp("record_type"), record_id: inp("record_id"), people: ref("named.people") } }),
      s.function.run({ fn: addBodyLinks, as: "linked", input: { actor_id: inp("actor_id"), browser: inp("browser"), from_type: c.text("crm_note"), from_id: ref("row_id"), targets: ref("named.records") } }),
    ] }),
    noteRow(ref("row_id"), "answer"),
  ],
  response: ref("answer"),
});

export const editNote = defineFunction({
  name: "crm/edit_note",
  description: "Change a note's words. Only its author may, and a name taken out of it withdraws that mention.",
  input: { ...who, id: input.int({ required: true }), body: input.text() },
  stack: [
    ...reachable(crm_note),
    guard.require(expr(ref("row.author_id"), "=", inp("actor_id")), { errorType: "accessdenied", message: "Only the person who wrote a note can change it." }),
    guard.require(expr(ref("row.deleted_at"), "=", c.null()), { errorType: "badrequest", message: TRASHED }),
    ...bodyRules,
    s.function.run({ fn: readTokens, as: "before", input: { body: ref("row.body") } }),
    s.function.run({ fn: readTokens, as: "named", input: { body: inp("body") } }),
    s.db.patch({ table: crm_note, fieldValue: inp("id"), data: obj({ body: inp("body"), edited_at: c.now() }) }),
    changed({ entity: "crm_note", id: inp("id"), actor: inp("actor_id"), crm: true }),
    s.foreach({ list: withFilters(ref("before.people"), fl.array_diff(ref("named.people"))), as: "person_id", body: [
      s.function.run({ fn: closeItems, as: "closed", input: { entity: ref("row.record_type"), entity_id: ref("row.record_id"), kind: c.text("mention"), user_id: ref("person_id"), seq: inp("id") } }),
    ] }),
    s.function.run({ fn: tellNamed, as: "told", input: { actor_id: inp("actor_id"), note_id: inp("id"), record_type: ref("row.record_type"), record_id: ref("row.record_id"), people: withFilters(ref("named.people"), fl.array_diff(ref("before.people"))) } }),
    s.function.run({ fn: reconcileLinks, as: "linked", input: { actor_id: inp("actor_id"), browser: inp("browser"), from_type: c.text("crm_note"), from_id: inp("id"), targets: ref("named.records") } }),
    noteRow(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const deleteNote = defineFunction({
  name: "crm/delete_note",
  description: "Put a note in the trash. Anyone who reaches it may, as an agent's note has nobody else to clear it.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...reachable(crm_note),
    s.conditional({ when: expr(ref("row.deleted_at"), "=", c.null()), then: [
      s.db.patch({ table: crm_note, fieldValue: inp("id"), data: obj({ deleted_at: c.now() }) }),
      s.function.run({ fn: closeItems, as: "closed", input: { entity: ref("row.record_type"), entity_id: ref("row.record_id"), kind: c.text("mention"), user_id: c.int(0), seq: inp("id") } }),
      s.function.run({ fn: forgetRecord, as: "forgotten", input: { type: c.text("crm_note"), id: inp("id") } }),
      changed({ entity: "crm_note", id: inp("id"), op: "deleted", actor: inp("actor_id"), crm: true }),
    ] }),
    noteRow(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

export const restoreNote = defineFunction({
  name: "crm/restore_note",
  description: "Bring a note back from the trash, and link what it names again.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...reachable(crm_note),
    s.conditional({ when: expr(ref("row.deleted_at"), "!=", c.null()), then: [
      s.db.patch({ table: crm_note, fieldValue: inp("id"), data: obj({ deleted_at: c.null() }) }),
      s.function.run({ fn: readTokens, as: "named", input: { body: ref("row.body") } }),
      s.function.run({ fn: addBodyLinks, as: "linked", input: { actor_id: inp("actor_id"), browser: inp("browser"), from_type: c.text("crm_note"), from_id: inp("id"), targets: ref("named.records") } }),
      changed({ entity: "crm_note", id: inp("id"), op: "created", actor: inp("actor_id"), crm: true }),
    ] }),
    noteRow(inp("id"), "answer"),
  ],
  response: ref("answer"),
});

/** Which of the people a note names can't open customers. Nothing can be done about that from here: no space to add them to. */
export const crmMentionCheckFn = defineFunction({
  name: "crm/mention_check",
  description: "Whether naming these people in a CRM note or thread needs a warning, and who it names.",
  input: { ...who, people: input.json() },
  stack: [
    ...requireCrm(),
    s.set_var("missing", c.array([])),
    s.db.query({ table: user, where: [cmp(col("id"), "in", inp("people")), cmp(col("id"), "!=", inp("actor_id")), cmp(col("status"), "=", c.text("active"))], sort: [{ sortBy: "name", dir: "asc" }], output: ["id", "name", "kind"], as: "named" }),
    s.foreach({ list: ref("named"), as: "person", body: [
      s.function.run({ fn: accessRule, as: "reaches", input: { actor_id: ref("person.id"), browser: c.expression('$var.person.kind == "human"'), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
      s.conditional({ when: expr(ref("reaches"), "=", c.bool(false)), then: [s.update_var("missing", withFilters(ref("missing"), fl.array_push(ref("person"))))] }),
    ] }),
  ],
  response: { warn: c.expression("($var.missing|count) > 0"), missing: ref("missing"), add: c.array([]) },
});

export const noteFunctions = [tellNamed, addNote, editNote, deleteNote, restoreNote, crmMentionCheckFn];
