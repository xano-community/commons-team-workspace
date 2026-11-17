// How the task screens read and write. Reads come through the query cache, which a live frame refreshes; each write shows at
// once, goes through the outbox, and takes the server's row as its answer, so a refusal rolls back by name and nothing refetches.
import { useCallback, useMemo } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useLive } from "@/base/live";
import { useMe } from "@/base/session";
import { api } from "@/lib/api";
import { tasksApi, type SavedView, type TaskDetails, type TaskPage } from "./api";
import { useEntityQuery, useWrite, withPending } from "@/lib/data";
import { shellToast } from "@/lib/toast";
import { routePath } from "../../../../xano/routes.gen.js";
import { isOpen, type TaskPriority, type TaskRequest, type TaskStatus, type TaskView } from "./model";
import { columnOf, GAP, placeAt, type Move } from "./order";
import { insertRow, moveLabel, taskPatch, taskToast, tempTask } from "./writes";

export type { SavedView, TaskDetails, TaskPage };

export function useTaskSetup() {
  const client = useQueryClient();
  const setup = useEntityQuery("project", ["setup"], tasksApi.taskSetup);
  // A space archived, or someone joining, changes what every list here may do.
  useLive(["task_view", "space_member", "space"], () => { void setup.refetch(); void client.invalidateQueries({ queryKey: ["task"] }); });
  return setup;
}

/** What's cached shows at once. A change that came while this screen was closed had nobody listening, so it refreshes behind. */
export const useTaskPage = (request: TaskRequest) => useEntityQuery("task", ["list", request], () => tasksApi.taskPage(request), { refetchOnMount: "always" });
/** A task and what surrounds it, as one record, so a write or a live change reaches it like any other copy. */
export type TaskFull = TaskView & Omit<TaskDetails, "task">;
const readTask = async (id: number): Promise<TaskFull> => { const { task, ...rest } = await tasksApi.task(id); return { ...task, ...rest }; };
export const useTaskDetails = (id: number) => useEntityQuery("task", ["details", id], () => readTask(id));
/** A press on a row starts the task's read before the click lands, so its sheet is ready to slide in sooner. */
export function prefetchTask(client: QueryClient, id: number) {
  if (id <= 0) return;
  void client.prefetchQuery({ queryKey: ["task", "details", id], queryFn: async () => withPending(client, "task", await readTask(id)), staleTime: 5_000 });
}
/** A space's name from the task setup on hand, or nothing. */
function spaceNameOf(client: QueryClient, id: number) {
  return client.getQueryData<{ spaces?: { id: number; name?: string }[] }>(["project", "setup"])?.spaces?.find((s) => s.id === id)?.name ?? "";
}
/**
 * What a list already knows about a task, so opening it shows the row at once and the rest fills in. Undefined when no list
 * on hand holds it. It says nothing it doesn't know: no rights, no thread, so a screen treats it as read-only until the task loads.
 */
export function taskFromLists(client: QueryClient, id: number): TaskFull | undefined {
  for (const [, page] of client.getQueriesData<TaskPage>({ queryKey: ["task", "list"] })) {
    const row = page?.items?.find((t) => t.id === id);
    if (row) return { ...row, space_name: spaceNameOf(client, row.space_id), archived: false, trashed: false, can_edit: false, can_restore: false, left_name: "", thread_id: 0, unread_items: 0 };
  }
  return undefined;
}
export const useSpacePeople = (space: number | null) => useEntityQuery("space_member", ["task-people", space], () => api.spaceMembers(space!), { enabled: !!space });

export type NewTask = { project_id: number; space_id: number; project_name: string; title: string; description: string; status: TaskStatus; priority: TaskPriority; due_on: string; assignee_id: number; assignee_name: string | null; assignee_kind: TaskView["assignee_kind"] };

/** The one way anything changes a task. `rows` are what's on screen, for working out where a move lands. */
export function useTaskActions() {
  const me = useMe()!;
  const write = useWrite(me.id);
  const client = useQueryClient();
  const post = useCallback((task: TaskView, label: string, route: "status" | "priority" | "due" | "assign" | "move", body: object, patch: Record<string, unknown>) => write({
    label, verb: "POST", answer: true, spaceId: task.space_id, changes: [taskPatch(task.id, patch)], body,
    path: routePath(`POST tasks/{id}/${route}` as "POST tasks/{id}/status", { id: task.id }),
  }), [write]);

  return useMemo(() => {
    /** The server keeps a finished task's stamp, and the screen needs the same to read as done at once. */
    const place = (task: TaskView, m: Move, body: object, route: "status" | "move", label = moveLabel(task.title, m.status)) =>
      post(task, label, route, body, { status: m.status, rank: m.rank, completed_at: isOpen(m.status) ? null : task.completed_at ?? Date.now() });
    const actions = {
      /** To the top of a column, from a menu, wherever the rest of that column is. */
      setStatus: (task: TaskView, status: TaskStatus, rows: TaskView[]) => {
        if (task.status === status) return;
        const top = columnOf(rows, status)[0]?.rank;
        return place(task, { status, before_id: 0, rank: top === undefined ? 0 : top - GAP }, { status }, "status");
      },
      move: (task: TaskView, m: Move) => place(task, m, { status: m.status, before_id: m.before_id }, "move"),
      drop: (task: TaskView, status: TaskStatus, before: number | null, rows: TaskView[]) => actions.move(task, placeAt(rows, task.id, status, before)),
      setPriority: (task: TaskView, priority: TaskPriority) => { if (task.priority !== priority) void post(task, `change the priority of ${task.title}`, "priority", { priority }, { priority }); },
      setDue: (task: TaskView, due_on: string) => { if ((task.due_on ?? "") !== due_on) void post(task, `change the due date of ${task.title}`, "due", { due_on }, { due_on: due_on || null }); },
      assign: (task: TaskView, person: { id: number; name: string; kind: "human" | "agent" } | null) => {
        if ((task.assignee_id || 0) === (person?.id ?? 0)) return;
        void post(task, person ? `assign ${task.title} to ${person.name}` : `unassign ${task.title}`, "assign", { assignee_id: person?.id ?? 0 }, { assignee_id: person?.id ?? 0, assignee_name: person?.name ?? null, assignee_kind: person?.kind ?? null, left_by: 0 });
      },
      update: (task: TaskView, title: string, description: string) => write({
        label: `save ${title || task.title}`, verb: "PATCH", path: routePath("PATCH tasks/{id}", { id: task.id }), body: { title, description }, answer: true, spaceId: task.space_id, changes: [taskPatch(task.id, { title, description })],
      }),
      remove: async (task: TaskView) => {
        const ended = await write({ label: `delete ${task.title}`, verb: "DELETE", path: routePath("DELETE tasks/{id}", { id: task.id }), spaceId: task.space_id, changes: [taskPatch(task.id, { deleted_at: Date.now() })] });
        if (ended === "sent") shellToast.show(taskToast("delete", task.title), { label: "Undo", onClick: () => void actions.restore(task) });
        return ended;
      },
      restore: (task: TaskView) => write({ label: `restore ${task.title}`, verb: "POST", path: routePath("POST tasks/{id}/restore", { id: task.id }), body: {}, answer: true, spaceId: task.space_id, changes: [taskPatch(task.id, { deleted_at: null })] }),
      create: (t: NewTask, rows: TaskView[]) => {
        const top = columnOf(rows, t.status)[0]?.rank;
        const row = tempTask({ ...t, due_on: t.due_on || null, rank: top === undefined ? 0 : top - GAP });
        return write({
          label: `add ${t.title}`, verb: "POST", path: routePath("POST tasks"), answer: true, spaceId: t.space_id, changes: [insertRow(row)],
          body: { project_id: t.project_id, client_id: crypto.randomUUID(), title: t.title, description: t.description, status: t.status, priority: t.priority, due_on: t.due_on, assignee_id: t.assignee_id },
        });
      },
    };
    return actions;
  }, [client, post, write]);
}
