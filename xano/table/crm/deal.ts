import { f, table } from "@xano/sdk";
import { SEED_DEALS } from "../../world.js";
import { user } from "../user.js";
import { company } from "./company.js";
import { contact } from "./contact.js";
import { pipeline_stage } from "./pipeline_stage.js";

/** Work being sold. `rank` is its place in its stage, lowest first: whole numbers with a gap between them, as a task's are. */
export const deal = table({
  name: "deal",
  description: "A deal with a company, in a stage of the pipeline.",
  schema: {
    company_id: f.tableRef(company, { required: true }),
    /** Who it's with, when that's one person. 0: nobody in particular. */
    contact_id: f.tableRef(contact),
    title: f.text({ required: true }),
    stage_id: f.tableRef(pipeline_stage, { required: true }),
    /** In whole units of the workspace's currency. */
    value: f.int(),
    close_on: f.date({ nullable: true }),
    /** A person or an agent. 0: nobody. */
    owner_id: f.tableRef(user),
    rank: f.int(),
    created_by: f.tableRef(user),
    client_id: f.text({ nullable: true }),
    /** When it reached a won or lost stage. Empty while it's open. */
    closed_at: f.timestamp({ nullable: true }),
    deleted_at: f.timestamp({ nullable: true }),
    is_demo: f.bool(),
  },
  index: [
    { type: "btree", fields: [{ name: "stage_id", op: "asc" }, { name: "rank", op: "asc" }] },
    { type: "btree", fields: [{ name: "company_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "owner_id", op: "asc" }] },
    { type: "btree|unique", fields: [{ name: "client_id", op: "asc" }] },
  ],
  seed: SEED_DEALS,
});
