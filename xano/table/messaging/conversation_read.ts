import { f, table } from "@xano/sdk";
import { SEED_READS } from "../../world.js";
import { user } from "../user.js";
import { conversation } from "./conversation.js";

/**
 * How far one person has read one conversation. It's apart from `conversation_member` because that table decides who
 * reaches a DM, and a read position must never decide anything. It only moves forward. Joining a space writes one at the
 * channel's newest message, so a new joiner starts read; no row means nothing is read.
 */
export const conversation_read = table({
  name: "conversation_read",
  description: "How far a person has read a conversation.",
  schema: {
    conversation_id: f.tableRef(conversation, { required: true }),
    user_id: f.tableRef(user, { required: true }),
    last_read_seq: f.int(),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "conversation_id", op: "asc" }, { name: "user_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "user_id", op: "asc" }] },
  ],
  seed: SEED_READS,
});
