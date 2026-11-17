// What 30 days in the trash ends in: the record, its thread, its notes and its links. A chip that pointed at it reads Deleted.
import { and, c, cmp, col, defineFunction, expr, fl, inp, input, ref, s, task as scheduledTask, withFilters } from "@xano/sdk";
import { notification } from "../../base/tables.js";
import { company } from "../../table/crm/company.js";
import { contact } from "../../table/crm/contact.js";
import { crm_note } from "../../table/crm/crm_note.js";
import { deal } from "../../table/crm/deal.js";
import { conversation } from "../../table/messaging/conversation.js";
import { message } from "../../table/messaging/message.js";
import { forgetRecord } from "../links/links.js";

const PURGE_AFTER = "-30 days";
const expired = (table: Parameters<typeof s.db.query>[0]["table"], as: string) => s.db.query({ table, where: [cmp(col("deleted_at"), "!=", c.null()), expr(col("deleted_at"), "<", ref("cutoff"))], paging: { per_page: 500, metadata: false }, output: ["id"], as });

/** One record's thread and links, notes and inbox items: everything that's about it, before the row goes. */
const purgeRecord = defineFunction({
  name: "crm/purge_record",
  description: "Remove what hangs from a record that's going for good.",
  input: { type: input.text({ required: true }), id: input.int({ required: true }) },
  stack: [
    s.set_var("key", withFilters(c.text("thread-"), fl.concat(inp("type")), fl.concat(c.text("-")), fl.concat(inp("id")))),
    s.db.query({ table: conversation, where: cmp(col("unique_key"), "=", ref("key")), output: ["id"], returnType: "single", as: "thread" }),
    s.conditional({ when: expr(ref("thread"), "!=", c.null()), then: [
      s.set_var("thread_id", ref("thread.id", { safe: true })),
      s.db.query({ table: message, where: cmp(col("conversation_id"), "=", ref("thread_id")), output: ["id"], as: "said" }),
      s.foreach({ list: ref("said"), as: "post", body: [s.function.run({ fn: forgetRecord, as: "forgotten", input: { type: c.text("message"), id: ref("post.id") } })] }),
      s.db.bulk.delete({ table: message, where: cmp(col("conversation_id"), "=", ref("thread_id")), as: "wiped" }),
      s.db.bulk.delete({ table: notification, where: and(cmp(col("entity"), "=", c.text("conversation")), cmp(col("entity_id"), "=", ref("thread_id"))), as: "unsaid" }),
      s.db.del({ table: conversation, fieldValue: ref("thread_id") }),
    ] }),
    s.db.query({ table: crm_note, where: [cmp(col("record_type"), "=", inp("type")), cmp(col("record_id"), "=", inp("id"))], output: ["id"], as: "notes" }),
    s.foreach({ list: ref("notes"), as: "note", body: [
      s.function.run({ fn: forgetRecord, as: "forgotten", input: { type: c.text("crm_note"), id: ref("note.id") } }),
      s.db.del({ table: crm_note, fieldValue: ref("note.id") }),
    ] }),
    s.function.run({ fn: forgetRecord, as: "forgotten", input: { type: inp("type"), id: inp("id") } }),
    s.db.bulk.delete({ table: notification, where: and(cmp(col("entity"), "=", inp("type")), cmp(col("entity_id"), "=", inp("id"))), as: "unsaid" }),
  ],
  response: { ok: c.bool(true) },
});

export const purgeCrm = defineFunction({
  name: "crm/purge",
  description: "Remove companies, contacts, deals and notes that have been in the trash for over 30 days.",
  stack: [
    s.set_var("cutoff", withFilters(c.now(), fl.epochms_transform(PURGE_AFTER))),
    expired(crm_note, "old_notes"),
    s.foreach({ list: ref("old_notes"), as: "item", body: [
      s.function.run({ fn: forgetRecord, as: "forgotten", input: { type: c.text("crm_note"), id: ref("item.id") } }),
      s.db.del({ table: crm_note, fieldValue: ref("item.id") }),
    ] }),
    expired(deal, "old_deals"),
    s.foreach({ list: ref("old_deals"), as: "item", body: [s.function.run({ fn: purgeRecord, as: "cleared", input: { type: c.text("deal"), id: ref("item.id") } }), s.db.del({ table: deal, fieldValue: ref("item.id") })] }),
    expired(contact, "old_contacts"),
    s.foreach({ list: ref("old_contacts"), as: "item", body: [
      s.function.run({ fn: purgeRecord, as: "cleared", input: { type: c.text("contact"), id: ref("item.id") } }),
      s.db.query({ table: deal, where: cmp(col("contact_id"), "=", ref("item.id")), output: ["id"], as: "named_in" }),
      s.array.map({ source: ref("named_in"), as: "unnamed", transform: { id: ref("$this.id"), contact_id: c.int(0) } }),
      s.db.bulk.patch({ table: deal, items: ref("unnamed"), as: "unnamed_rows" }),
      s.db.del({ table: contact, fieldValue: ref("item.id") }),
    ] }),
    expired(company, "old_companies"),
    // Its contacts and deals share its stamp, so they're gone by here. Anything left would point at nothing.
    s.foreach({ list: ref("old_companies"), as: "item", body: [
      s.db.query({ table: deal, where: cmp(col("company_id"), "=", ref("item.id")), returnType: "count", as: "deals_left" }),
      s.db.query({ table: contact, where: cmp(col("company_id"), "=", ref("item.id")), returnType: "count", as: "contacts_left" }),
      s.conditional({ when: expr(withFilters(ref("deals_left"), fl.add(ref("contacts_left"))), "=", c.int(0)), then: [
        s.function.run({ fn: purgeRecord, as: "cleared", input: { type: c.text("company"), id: ref("item.id") } }),
        s.db.del({ table: company, fieldValue: ref("item.id") }),
      ] }),
    ] }),
  ],
  response: { deals: withFilters(ref("old_deals"), fl.count()), companies: withFilters(ref("old_companies"), fl.count()) },
});

/** The trash empties itself, once a day. */
export const purgeCrmDaily = scheduledTask({
  name: "crm_purge_daily",
  description: "Remove customers that have been in the trash for over 30 days.",
  schedule: [{ startsOn: "2026-01-01T03:30:00Z", freq: 86_400, repeatEnabled: true }],
  stack: [s.function.run({ fn: purgeCrm, as: "purged" })],
});

export const purgeFunctions = [purgeRecord, purgeCrm];
