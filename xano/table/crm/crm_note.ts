import { f, table } from "@xano/sdk";
import { SEED_NOTES } from "../../world.js";
import { user } from "../user.js";
import { company } from "./company.js";

export const NOTE_RECORDS = ["company", "contact", "deal"] as const;

/** Something worth keeping about a customer. Mentions live in `body` as `<@5>` and `<#task:12>`, so a rename shows everywhere. */
export const crm_note = table({
  name: "crm_note",
  description: "A note on a company, a contact or a deal.",
  schema: {
    record_type: f.enum(NOTE_RECORDS, { required: true }),
    record_id: f.int({ required: true }),
    /** The company it comes under, so a company's page reads its notes in one query. */
    company_id: f.tableRef(company, { required: true }),
    body: f.text({ required: true }),
    /** A person or an agent. */
    author_id: f.tableRef(user),
    client_id: f.text({ nullable: true }),
    edited_at: f.timestamp({ nullable: true }),
    deleted_at: f.timestamp({ nullable: true }),
    is_demo: f.bool(),
  },
  index: [
    { type: "btree", fields: [{ name: "company_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "record_type", op: "asc" }, { name: "record_id", op: "asc" }] },
    { type: "btree|unique", fields: [{ name: "client_id", op: "asc" }] },
  ],
  seed: SEED_NOTES,
});
