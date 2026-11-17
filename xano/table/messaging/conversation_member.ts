import { f, table } from "@xano/sdk";
import { user } from "../user.js";
import { conversation } from "./conversation.js";

/** Who is in a DM. Membership of a channel comes from its space. */
export const conversation_member = table({
  name: "conversation_member",
  description: "One row per person or agent in a DM.",
  schema: {
    conversation_id: f.tableRef(conversation, { required: true }),
    user_id: f.tableRef(user, { required: true }),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "conversation_id", op: "asc" }, { name: "user_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "user_id", op: "asc" }] },
  ],
});
