import { f, table } from "@xano/sdk";
import { SEED_CONVERSATIONS } from "../../world.js";
import { user } from "../user.js";
import { space } from "../spaces/space.js";

/**
 * Where messages live: a channel in a space, a DM with its own member rows, or the thread on one record. A thread copies
 * where its record lives into `space_id`, `dm_id` and `crm`, so it's reached exactly as the record is, and a record that
 * moves must rewrite them.
 */
export const conversation = table({
  name: "conversation",
  description: "A channel inside a space, a DM between its members, or the thread on a record.",
  schema: {
    /** A channel's space, or the space a thread's record lives in. Empty for a DM. */
    space_id: f.tableRef(space),
    kind: f.enum(["channel", "dm", "thread"], { default: "channel" }),
    name: f.text({ required: true }),
    /** A channel's purpose, in a line: what it's for and who reads it. Shown under its name. */
    purpose: f.text(),
    created_by: f.tableRef(user),
    is_demo: f.bool(),
    /** What makes a second row impossible: "channel-3-general", "dm-1-2" or "thread-message-9". */
    unique_key: f.text({ nullable: true }),
    /** A thread's record. */
    record_type: f.text(),
    record_id: f.int(),
    /** The conversation a thread's message sits in. */
    parent_id: f.int(),
    /** A thread on something inside a DM: that DM. */
    dm_id: f.int(),
    /** A thread on a CRM record, which lives in no space. */
    crm: f.bool(),
    /** The place of the newest message. Taken with this row locked, so messages commit in order. */
    last_seq: f.int(),
    /** Moves on every send, edit and delete, so a client can ask for everything since it last looked. */
    last_version: f.int(),
    last_message_at: f.timestamp({ nullable: true }),
  },
  index: [
    { type: "btree", fields: [{ name: "space_id", op: "asc" }] },
    { type: "btree|unique", fields: [{ name: "unique_key", op: "asc" }] },
  ],
  seed: SEED_CONVERSATIONS,
});
