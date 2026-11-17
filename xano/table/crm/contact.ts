import { f, table } from "@xano/sdk";
import { SEED_CONTACTS } from "../../world.js";
import { user } from "../user.js";
import { company } from "./company.js";

/** Someone at a company. This is an address book entry, not a member: a contact never signs in. */
export const contact = table({
  name: "contact",
  description: "A person at a company.",
  schema: {
    company_id: f.tableRef(company, { required: true }),
    name: f.text({ required: true }),
    email: f.text(),
    phone: f.text(),
    job_title: f.text(),
    created_by: f.tableRef(user),
    client_id: f.text({ nullable: true }),
    deleted_at: f.timestamp({ nullable: true }),
    is_demo: f.bool(),
  },
  index: [
    { type: "btree", fields: [{ name: "company_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "name", op: "asc" }] },
    { type: "btree|unique", fields: [{ name: "client_id", op: "asc" }] },
  ],
  seed: SEED_CONTACTS,
});
