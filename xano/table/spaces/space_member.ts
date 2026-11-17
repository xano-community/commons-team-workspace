import { f, table } from "@xano/sdk";
import { SEED_SPACE_MEMBERS } from "../../world.js";
import { user } from "../user.js";
import { space } from "./space.js";

/** Who has joined a space. Write it through function/access/membership.ts, which keeps user.space_ids in step. */
export const space_member = table({
  name: "space_member",
  description: "One row per person or agent in a space.",
  schema: {
    space_id: f.tableRef(space, { required: true }),
    user_id: f.tableRef(user, { required: true }),
    /** A manager runs the space and adds people to it. A space keeps at least one. */
    role: f.enum(["manager", "member"], { default: "member" }),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "space_id", op: "asc" }, { name: "user_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "user_id", op: "asc" }] },
  ],
  seed: SEED_SPACE_MEMBERS,
});
