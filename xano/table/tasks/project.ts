import { f, table } from "@xano/sdk";
import { SEED_PROJECTS } from "../../world.js";
import { user } from "../user.js";
import { space } from "../spaces/space.js";

/** A body of tasks inside a space. It archives, and is never deleted, so a task always has somewhere to belong. */
export const project = table({
  name: "project",
  description: "A set of tasks in a space. Whoever reaches the space reaches its projects.",
  schema: {
    space_id: f.tableRef(space, { required: true }),
    name: f.text({ required: true }),
    /** Set when it's archived: its tasks stay, and leave the default views. */
    archived_at: f.timestamp({ nullable: true }),
    created_by: f.tableRef(user),
    is_demo: f.bool(),
  },
  index: [{ type: "btree", fields: [{ name: "space_id", op: "asc" }] }],
  seed: SEED_PROJECTS,
});
