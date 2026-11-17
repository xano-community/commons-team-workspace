import { f, table } from "@xano/sdk";
import { docs } from "../../docs.js";
import { SEED_DOC_SUGGESTIONS } from "../../world.js";
import { space } from "../spaces/space.js";
import { user } from "../user.js";

export const SUGGESTION_STATES = ["pending", "applied", "dismissed"] as const;

/**
 * An agent's change to a doc. Agents never write a body straight in: a change is filed here, and it goes in at once only when
 * nobody is working on the doc. `find` empty means it adds `blocks` at the end. `applied_version` is set when the server put it
 * in itself, and stays 0 when a person pressed Apply, because then the change arrives with their own save.
 */
export const doc_suggestion = table({
  name: "doc_suggestion",
  description: "A change an agent proposed to a doc, and what became of it.",
  schema: {
    doc_id: f.tableRef(docs.doc, { required: true }),
    space_id: f.tableRef(space),
    agent_id: f.tableRef(user, { required: true }),
    /** The run that filed it, so a decision can reach the run. 0 for a connected agent. */
    run_id: f.int(),
    base_version: f.int(),
    /** The exact words to replace, inside one block. */
    find: f.text(),
    /** What replaces them, or the text being added at the end. */
    text: f.text(),
    /** `text` as blocks for an addition, or as text nodes for a replacement that brings marks. */
    blocks: f.json(),
    /** Why, in the agent's words. */
    note: f.text(),
    status: f.enum(SUGGESTION_STATES, { default: "pending" }),
    applied_version: f.int(),
    /** 0 while it's pending, and when the server applied it at once. */
    decided_by: f.tableRef(user),
    decided_at: f.timestamp({ nullable: true }),
  },
  seed: SEED_DOC_SUGGESTIONS,
  index: [{ type: "btree", fields: [{ name: "doc_id", op: "asc" }, { name: "status", op: "asc" }] }, { type: "btree", fields: [{ name: "run_id", op: "asc" }] }],
});
