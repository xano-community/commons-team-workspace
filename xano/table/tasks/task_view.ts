import { f, table } from "@xano/sdk";
import { user } from "../user.js";

/** A person's saved filter. `query` holds what the URL would: filter names and ids, and never a record's text. */
export const task_view = table({
  name: "task_view",
  description: "A saved set of task filters, private to the person who saved it.",
  schema: {
    user_id: f.tableRef(user, { required: true }),
    name: f.text({ required: true }),
    query: f.json(),
  },
  index: [{ type: "btree|unique", fields: [{ name: "user_id", op: "asc" }, { name: "name", op: "asc" }] }],
});
