// The words and shapes of a task write. A refusal puts the screen back and names the task, so every label finishes "Couldn't …".
import type { EntityChange, EntityPatch } from "@/lib/data/entities";
import { STATUS_LABELS, type TaskStatus, type TaskView } from "./model";

export const taskPatch = (id: number, patch: EntityPatch): EntityChange => ({ entity: "task", id, patch });
export const insertRow = (row: Pick<TaskView, "id"> & EntityPatch): EntityChange => ({ entity: "task", id: row.id, patch: row, insert: true });

let stand = 0;
/** A new task on screen before the server has named it. A stand-in id is negative, so it can't meet a real one. */
export const tempTask = (fields: Pick<TaskView, "title" | "status" | "rank" | "project_id" | "space_id"> & Partial<TaskView>) => ({
  priority: "none", due_on: null, assignee_id: 0, assignee_name: null, assignee_kind: null, project_name: "", description: "", left_by: 0, deleted_at: null, completed_at: null, ...fields, id: -(Date.now() * 1000 + (stand++ % 1000)),
} as TaskView);

export const moveLabel = (title: string, status: string) => `move ${title} to ${STATUS_LABELS[status as TaskStatus] ?? status}`;
const SAID = { delete: "Deleted", restore: "Restored" } as const;
export const taskToast = (what: keyof typeof SAID, title: string) => `${SAID[what]} ${title}`;
