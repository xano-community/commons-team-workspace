import { f, table } from "@xano/sdk";
import { docs } from "../../docs.js";
import { user } from "../user.js";

/** What the server needs to remember about a doc between saves. One row per doc, written often and read by nobody but the server. */
export const doc_state = table({
  name: "doc_state",
  description: "A doc's working notes: who's typing, what its space last heard, and which links its body holds.",
  schema: {
    doc_id: f.tableRef(docs.doc, { required: true }),
    /** A person's last keystroke, plus a moment. While this is ahead of now, an agent's change waits. */
    editing_until: f.timestamp({ nullable: true }),
    editing_by: f.tableRef(user),
    /** When the space's channel last heard about this doc, and the title it heard. */
    told_at: f.timestamp({ nullable: true }),
    told_title: f.text(),
    /** The record links the body held at the last save, as one string, so an unchanged body skips the reconcile. */
    links_key: f.text(),
  },
  index: [{ type: "btree|unique", fields: [{ name: "doc_id", op: "asc" }] }],
});
