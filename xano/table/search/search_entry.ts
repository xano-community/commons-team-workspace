import { f, table } from "@xano/sdk";
import { SEED_SEARCH } from "../../world.js";

/** What `changed()` indexes. A message arrives from its own write, which knows its row. */
export const INDEXED = ["space", "conversation", "project", "task", "doc", "file", "company", "contact", "deal", "crm_note"];

/** Who can see a row is `scope`, read fresh against `reach.scopes` on every search, so nothing here can outlive someone's access. */
export const search_entry = table({
  name: "search_entry",
  description: "One row per record that can be found, written from the change path.",
  schema: {
    /** "task-12": what makes a second row for a record impossible. */
    key: f.text({ required: true }),
    entity: f.text({ required: true }),
    entity_id: f.int({ required: true }),
    title: f.text(),
    /** The record's words, as plain text, cut to what a search needs. */
    body: f.text(),
    /** The title and the body together, so one search's words can fall in either. */
    terms: f.text(),
    /** "space-3", "dm-4" or "crm", as in `reach.scopes`. */
    scope: f.text({ required: true }),
    href: f.text(),
    /** A message's conversation, whose name is read with the result, so renaming a channel needs no rewrite here. */
    conversation_id: f.int(),
    changed_at: f.timestamp({ nullable: true }),
    is_demo: f.bool(),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "key", op: "asc" }] },
    { type: "btree", fields: [{ name: "scope", op: "asc" }, { name: "changed_at", op: "desc" }] },
  ],
  seed: SEED_SEARCH,
});
