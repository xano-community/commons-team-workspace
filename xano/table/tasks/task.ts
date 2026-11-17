import { f, table } from "@xano/sdk";
import { SEED_TASKS } from "../../world.js";
import { user } from "../user.js";
import { space } from "../spaces/space.js";
import { project } from "./project.js";

export const TASK_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"] as const;
export const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

/**
 * One piece of work. `space_id` copies its project's, so one filter reaches it, and a task never leaves its space. Mentions
 * live in `description` as `<@5>` and `<#doc:12>`, so a rename shows everywhere. `rank` is its place in its column, lowest
 * first: whole numbers with a gap between them, because a decimal column keeps only five places.
 */
export const task = table({
  name: "task",
  description: "A task in a project, with a status, a priority, a due date and one person or agent on it.",
  schema: {
    project_id: f.tableRef(project, { required: true }),
    space_id: f.tableRef(space, { required: true }),
    title: f.text({ required: true }),
    description: f.text(),
    status: f.enum(TASK_STATUSES, { default: "todo" }),
    priority: f.enum(TASK_PRIORITIES, { default: "none" }),
    due_on: f.date({ nullable: true }),
    /** A person or an agent. 0: nobody. */
    assignee_id: f.tableRef(user),
    /** Who left the space with this task in hand, until someone takes it on. */
    left_by: f.int(),
    created_by: f.tableRef(user),
    rank: f.int(),
    /** Chosen by the sender. A retry with the same one answers the task it made. */
    client_id: f.text({ nullable: true }),
    completed_at: f.timestamp({ nullable: true }),
    /** In the trash: it reads Deleted everywhere, can be restored, and is purged after 30 days. */
    deleted_at: f.timestamp({ nullable: true }),
    is_demo: f.bool(),
  },
  index: [
    { type: "btree", fields: [{ name: "status", op: "asc" }, { name: "rank", op: "asc" }] },
    { type: "btree", fields: [{ name: "space_id", op: "asc" }, { name: "status", op: "asc" }, { name: "rank", op: "asc" }] },
    { type: "btree", fields: [{ name: "project_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "assignee_id", op: "asc" }] },
    { type: "btree|unique", fields: [{ name: "client_id", op: "asc" }] },
  ],
  seed: SEED_TASKS,
});
