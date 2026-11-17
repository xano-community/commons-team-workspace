import { f, table } from "@xano/sdk";
import { SEED_COMPANIES } from "../../world.js";
import { user } from "../user.js";

/** A customer or a prospect. It lives in no space: everyone who holds `crm.read` reaches it, whichever spaces they're in. */
export const company = table({
  name: "company",
  description: "A company the team sells to or works with.",
  schema: {
    name: f.text({ required: true }),
    domain: f.text(),
    industry: f.text(),
    about: f.text(),
    /** A person or an agent. 0: nobody. */
    owner_id: f.tableRef(user),
    created_by: f.tableRef(user),
    /** Chosen by the sender. A retry with the same one answers the row it made. */
    client_id: f.text({ nullable: true }),
    /** In the trash: it reads Deleted everywhere, can be restored, and is purged after 30 days. Its contacts and deals share the stamp. */
    deleted_at: f.timestamp({ nullable: true }),
    is_demo: f.bool(),
  },
  index: [
    { type: "btree", fields: [{ name: "name", op: "asc" }] },
    { type: "btree", fields: [{ name: "owner_id", op: "asc" }] },
    { type: "btree|unique", fields: [{ name: "client_id", op: "asc" }] },
  ],
  seed: SEED_COMPANIES,
});
