import { f, table } from "@xano/sdk";
import { SEED_LINKS } from "../../world.js";
import { user } from "../user.js";

/**
 * Any record linked to any other. Both sides show it, and a link never changes who reaches either record. It holds ids
 * and no text, so a title can't leak through it. `from_scope` is where the source lives, which lets a backlink list
 * filter and count in one query; a record that moves must rewrite it.
 */
export const record_link = table({
  name: "record_link",
  description: "A link from one record to another, by type and id.",
  schema: {
    from_type: f.text({ required: true }),
    from_id: f.int({ required: true }),
    to_type: f.text({ required: true }),
    to_id: f.int({ required: true }),
    /** `body` came from a mention and a body save reconciles it. `manual` was added by hand, and a body save leaves it alone. */
    origin: f.enum(["body", "manual"], { required: true }),
    /** "space-3", "dm-4" or "crm". */
    from_scope: f.text({ required: true }),
    created_by: f.tableRef(user),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "from_type", op: "asc" }, { name: "from_id", op: "asc" }, { name: "to_type", op: "asc" }, { name: "to_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "to_type", op: "asc" }, { name: "to_id", op: "asc" }] },
  ],
  seed: SEED_LINKS,
});
