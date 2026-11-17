// Tasks over HTTP. Each route is one line around its function in function/tasks/tasks.ts, so an agent's tool runs the same rule.
import { apiGroup, auth, inp, input, query, ref, s } from "@xano/sdk";
import type { InferRow } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { project } from "../table/tasks/project.js";
import { task, TASK_PRIORITIES, TASK_STATUSES } from "../table/tasks/task.js";
import { task_view } from "../table/tasks/task_view.js";
import { gateActive } from "../function/members/gate.js";
import { bindBrowser } from "../function/access/reach.js";
import { readRecordItems } from "../function/inbox/read.js";
import {
  assignTask, createProject, createTask, deleteTask, deleteView, listTasks, moveTask, readTask, restoreTask, saveView, searchTasks, setDue, setPriority, setStatus, taskSetup, updateProject, updateTask,
} from "../function/tasks/tasks.js";

export const tasksGroup = apiGroup({ name: "tasks", canonical: "tasks", middleware: { pre: [gateActive] }, description: "Tasks, their projects and saved filters." });

type Row = InferRow<typeof task>;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
/** A task as every screen reads it. A person's name rides along, because they may have left the people list. */
export type TaskView = Row & { assignee_name: string | null; assignee_kind: "human" | "agent" | null; project_name: string };
export type TaskPage = { items: TaskView[]; totals: Partial<Record<TaskStatus, number>>; ever: number; open: number; limit: number; space_name: string; archived: boolean };
export type TaskDetails = { task: TaskView; space_name: string; archived: boolean; trashed: boolean; can_edit: boolean; can_restore: boolean; left_name: string; thread_id: number; unread_items: number };
export type TaskSpace = { id: number; name: string; joined: boolean; can_create: boolean };
export type SavedView = InferRow<typeof task_view>;
export type TaskSetup = { spaces: TaskSpace[]; projects: InferRow<typeof project>[]; views: SavedView[] };

const caller = () => [...rbac.signedIn(), ...bindBrowser()];
const who = () => ({ actor_id: auth("id"), browser: ref("browser") });

/** GET tasks: a scope's tasks, column by column. */
export const listTasksRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "tasks", verb: "GET",
  description: "The tasks you reach, in order, narrowed by filters.",
  input: {
    space_id: input.int(), project_id: input.int(), status: input.text(), priority: input.text(), q: input.text({ methods: ["trim"] }), assignee_id: input.int(),
    due_from: input.text(), due_to: input.text(), no_due: input.bool(), limit: input.int(),
  },
  stack: [...caller(), s.function.run({ fn: listTasks, as: "page", input: {
    ...who(), space_id: inp("space_id"), project_id: inp("project_id"), status: inp("status"), priority: inp("priority"), q: inp("q"), assignee_id: inp("assignee_id"),
    due_from: inp("due_from"), due_to: inp("due_to"), no_due: inp("no_due"), limit: inp("limit"),
  } })],
  response: ref("page"),
  responseShape: {} as TaskPage,
});

/** GET task-setup: the spaces and projects around a list, and your saved filters. */
export const taskSetupRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "task-setup", verb: "GET",
  description: "Where you can work, and your saved filters.",
  stack: [...caller(), s.function.run({ fn: taskSetup, as: "setup", input: who() })],
  response: ref("setup"),
  responseShape: {} as TaskSetup,
});

/** GET task-search: for ⌘K, a mention or a link. */
export const searchTasksRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "task-search", verb: "GET",
  description: "Tasks you reach whose title matches.",
  input: { q: input.text({ methods: ["trim"] }) },
  stack: [...caller(), s.function.run({ fn: searchTasks, as: "found", input: { ...who(), q: inp("q") } })],
  response: ref("found"),
  responseShape: [] as TaskView[],
});

/** POST tasks: add a task. A repeat of `client_id` answers the one it made. */
export const createTaskRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "tasks", verb: "POST",
  // It can start an agent run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Add a task to a project. Safe to retry with the same client_id.",
  input: {
    project_id: input.int({ required: true }), client_id: input.text({ required: true }), title: input.text({ methods: ["trim"] }), description: input.text({ methods: ["trim"] }),
    status: input.enum(TASK_STATUSES, { required: true }), priority: input.enum(TASK_PRIORITIES, { required: true }), due_on: input.text(), assignee_id: input.int(),
  },
  stack: [...caller(), s.function.run({ fn: createTask, as: "made", input: {
    ...who(), project_id: inp("project_id"), client_id: inp("client_id"), title: inp("title"), description: inp("description"), status: inp("status"), priority: inp("priority"), due_on: inp("due_on"), assignee_id: inp("assignee_id"),
  } })],
  response: ref("made"),
  responseShape: {} as TaskView,
});

/** GET tasks/{id}: one task, and what you may do with it. */
export const getTaskRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "tasks/{id}", verb: "GET",
  description: "A task you can reach.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: readTask, as: "details", input: { ...who(), id: inp("id") } })],
  response: ref("details"),
  responseShape: {} as TaskDetails,
});

/** PATCH tasks/{id}: its title and description. */
export const updateTaskRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "tasks/{id}", verb: "PATCH",
  // It can start an agent run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Change a task's title and description.",
  input: { id: input.int({ required: true }), title: input.text({ methods: ["trim"] }), description: input.text({ methods: ["trim"] }) },
  stack: [...caller(), s.function.run({ fn: updateTask, as: "row", input: { ...who(), id: inp("id"), title: inp("title"), description: inp("description") } })],
  response: ref("row"),
  responseShape: {} as TaskView,
});

/** DELETE tasks/{id}: to the trash, from where it can come back. */
export const deleteTaskRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "tasks/{id}", verb: "DELETE",
  description: "Put a task in the trash.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: deleteTask, as: "row", input: { ...who(), id: inp("id") } })],
  response: ref("row"),
  responseShape: {} as TaskView,
});

export const restoreTaskRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "tasks/{id}/restore", verb: "POST",
  description: "Bring a task back from the trash.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: restoreTask, as: "row", input: { ...who(), id: inp("id") } })],
  response: ref("row"),
  responseShape: {} as TaskView,
});

export const setStatusRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "tasks/{id}/status", verb: "POST",
  description: "Change a task's status.",
  input: { id: input.int({ required: true }), status: input.enum(TASK_STATUSES, { required: true }) },
  stack: [...caller(), s.function.run({ fn: setStatus, as: "row", input: { ...who(), id: inp("id"), status: inp("status") } })],
  response: ref("row"),
  responseShape: {} as TaskView,
});

export const moveTaskRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "tasks/{id}/move", verb: "POST",
  description: "Put a task in a column, above another task or at the end.",
  input: { id: input.int({ required: true }), status: input.enum(TASK_STATUSES, { required: true }), before_id: input.int() },
  stack: [...caller(), s.function.run({ fn: moveTask, as: "row", input: { ...who(), id: inp("id"), status: inp("status"), before_id: inp("before_id") } })],
  response: ref("row"),
  responseShape: {} as TaskView,
});

export const setPriorityRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "tasks/{id}/priority", verb: "POST",
  description: "Change a task's priority.",
  input: { id: input.int({ required: true }), priority: input.enum(TASK_PRIORITIES, { required: true }) },
  stack: [...caller(), s.function.run({ fn: setPriority, as: "row", input: { ...who(), id: inp("id"), priority: inp("priority") } })],
  response: ref("row"),
  responseShape: {} as TaskView,
});

export const setDueRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "tasks/{id}/due", verb: "POST",
  description: "Change a task's due date, or clear it.",
  input: { id: input.int({ required: true }), due_on: input.text() },
  stack: [...caller(), s.function.run({ fn: setDue, as: "row", input: { ...who(), id: inp("id"), due_on: inp("due_on") } })],
  response: ref("row"),
  responseShape: {} as TaskView,
});

export const assignTaskRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "tasks/{id}/assign", verb: "POST",
  // It can start an agent run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Put a person or an agent on a task, or nobody with 0.",
  input: { id: input.int({ required: true }), assignee_id: input.int() },
  stack: [...caller(), s.function.run({ fn: assignTask, as: "row", input: { ...who(), id: inp("id"), assignee_id: inp("assignee_id") } })],
  response: ref("row"),
  responseShape: {} as TaskView,
});

/** POST tasks/{id}/read: you've opened it, so what your inbox says about it is read. */
export const readTaskRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "tasks/{id}/read", verb: "POST",
  description: "Say you've opened a task.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: readRecordItems, as: "read", input: { ...who(), entity: "task", entity_id: inp("id") } })],
  response: ref("read"),
  responseShape: {} as { read: number },
});

export const createProjectRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "projects", verb: "POST",
  description: "Add a project to a space.",
  input: { space_id: input.int({ required: true }), name: input.text({ methods: ["trim"] }) },
  stack: [...caller(), s.function.run({ fn: createProject, as: "made", input: { ...who(), space_id: inp("space_id"), name: inp("name") } })],
  response: ref("made"),
  responseShape: {} as InferRow<typeof project>,
});

export const updateProjectRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "projects/{id}", verb: "PATCH",
  description: "Rename a project, or archive it.",
  input: { id: input.int({ required: true }), name: input.text({ methods: ["trim"] }), archived: input.bool() },
  stack: [...caller(), s.function.run({ fn: updateProject, as: "saved", input: { ...who(), id: inp("id"), name: inp("name"), archived: inp("archived") } })],
  response: ref("saved"),
  responseShape: {} as InferRow<typeof project>,
});

export const createViewRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "task-views", verb: "POST",
  description: "Save your filters under a name.",
  input: { name: input.text({ methods: ["trim"] }), query: input.json() },
  stack: [...caller(), s.function.run({ fn: saveView, as: "view", input: { actor_id: auth("id"), name: inp("name"), query: inp("query") } })],
  response: ref("view"),
  responseShape: {} as SavedView,
});

export const deleteViewRoute = query({
  apiGroup: tasksGroup, auth: user,
  name: "task-views/{id}", verb: "DELETE",
  description: "Delete a saved filter of yours.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: deleteView, as: "gone", input: { actor_id: auth("id"), id: inp("id") } })],
  response: ref("gone"),
  responseShape: {} as { removed: boolean },
});

export const taskQueries = [
  listTasksRoute, taskSetupRoute, searchTasksRoute, createTaskRoute, getTaskRoute, updateTaskRoute, deleteTaskRoute, restoreTaskRoute, setStatusRoute, moveTaskRoute, setPriorityRoute, setDueRoute,
  assignTaskRoute, readTaskRoute, createProjectRoute, updateProjectRoute, createViewRoute, deleteViewRoute,
];
