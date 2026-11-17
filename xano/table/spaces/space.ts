import { f, table } from "@xano/sdk";
import { SEED_SPACES } from "../../world.js";
import { user } from "../user.js";

/** A body of work that holds channels, tasks, docs and files. Spaces archive; they are never deleted. */
export const space = table({
  name: "space",
  description: "A body of work. Every member can see an open space and join it. Only its members and admins see a private one.",
  schema: {
    name: f.text({ required: true }),
    visibility: f.enum(["open", "private"], { required: true }),
    /** Whether guests in this space may create tasks and docs. */
    guests_can_create: f.bool(),
    /** Set when the space is archived, and read-only. */
    archived_at: f.timestamp({ nullable: true }),
    created_by: f.tableRef(user),
    is_demo: f.bool(),
  },
  seed: SEED_SPACES,
});
