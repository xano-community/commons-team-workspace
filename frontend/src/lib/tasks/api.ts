// The task screens' requests. They load with those screens, so the shell doesn't carry them.
import type { SavedView, TaskDetails, TaskPage, TaskSetup, TaskView } from "../../../../xano/query/tasks.js";
import { routePath } from "../../../../xano/routes.gen.js";
import { qs, request } from "@/base/request";
import type { TaskRequest } from "./model";

export type { SavedView, TaskDetails, TaskPage, TaskSetup, TaskView };

export const tasksApi = {
  taskPage: (q: TaskRequest) => request<TaskPage>("GET", routePath("GET tasks") + qs(q)),
  taskSetup: () => request<TaskSetup>("GET", routePath("GET task-setup")),
  task: (id: number) => request<TaskDetails>("GET", routePath("GET tasks/{id}", { id })),
  searchTasks: (q: string) => request<TaskView[]>("GET", routePath("GET task-search") + qs({ q })),
  readTask: (id: number) => request<{ read: number }>("POST", routePath("POST tasks/{id}/read", { id }), {}),
  createSpace: (name: string, visibility: "open" | "private") => request<{ id: number }>("POST", routePath("POST spaces"), { name, visibility }),
  createProject: (space_id: number, name: string) => request<TaskSetup["projects"][number]>("POST", routePath("POST projects"), { space_id, name }),
  updateProject: (id: number, name: string, archived: boolean) => request<TaskSetup["projects"][number]>("PATCH", routePath("PATCH projects/{id}", { id }), { name, archived }),
  saveView: (name: string, query: object) => request<SavedView>("POST", routePath("POST task-views"), { name, query }),
  deleteView: (id: number) => request<{ removed: boolean }>("DELETE", routePath("DELETE task-views/{id}", { id })),
  addLink: (from_type: string, from_id: number, to_type: string, to_id: number) => request<{ id: number }>("POST", routePath("POST links"), { from_type, from_id, to_type, to_id }),
  removeLink: (id: number) => request<{ removed: boolean }>("DELETE", routePath("DELETE links/{id}", { id })),
};
