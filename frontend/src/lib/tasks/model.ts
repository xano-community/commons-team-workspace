// What the task screens agree on, kept free of React so it can be tested alone: the statuses, what a filter means, and which of
// the states a screen is in.
import type { TaskPage, TaskPriority, TaskStatus, TaskView } from "../../../../xano/query/tasks";

export type { TaskPage, TaskPriority, TaskStatus, TaskView };
export type TaskRequest = {
  space_id?: number; project_id?: number; status?: string; priority?: string; q?: string; assignee_id?: number;
  due_from?: string; due_to?: string; no_due?: boolean; limit?: number;
};

export const STATUS_LABELS: Record<TaskStatus, string> = { backlog: "Backlog", todo: "Todo", in_progress: "In progress", in_review: "In review", done: "Done", cancelled: "Cancelled" };
export const STATUSES = Object.keys(STATUS_LABELS) as TaskStatus[];
export const PRIORITY_LABELS: Record<TaskPriority, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority" };
export const PRIORITIES = Object.keys(PRIORITY_LABELS) as TaskPriority[];
/** A cancelled task isn't a stage of work, so it has no column. A list shows it, and a menu can get it there. */
export const BOARD_STATUSES: TaskStatus[] = ["backlog", "todo", "in_progress", "in_review", "done"];
/** The list reads work under way first. */
export const LIST_ORDER: TaskStatus[] = ["in_review", "in_progress", "todo", "backlog", "done", "cancelled"];
export const isOpen = (status: string) => status !== "done" && status !== "cancelled";

export const DUE_LABELS = { overdue: "Overdue", today: "Due today", week: "Due this week", none: "No due date" } as const;
export type DueWord = keyof typeof DUE_LABELS;

export type TaskFilters = { q: string; status: string; priority: string; assignee: string; project: string; due: string };
export const EMPTY_FILTERS: TaskFilters = { q: "", status: "", priority: "", assignee: "", project: "", due: "" };

/** A filter as a link or a saved filter holds it: only what's on. */
export const queryOf = (f: TaskFilters): Partial<TaskFilters> => Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Partial<TaskFilters>;

const positive = (v: unknown) => /^[1-9]\d*$/.test(String(v));

/** A filter from a link or a saved filter, keeping only what can mean something today. */
export function filtersFromQuery(query: Partial<Record<keyof TaskFilters, unknown>>): TaskFilters {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const assignee = text(query.assignee);
  return {
    q: text(query.q),
    status: STATUSES.includes(query.status as TaskStatus) ? text(query.status) : "",
    priority: PRIORITIES.includes(query.priority as TaskPriority) ? text(query.priority) : "",
    assignee: assignee === "me" || assignee === "none" || positive(assignee) ? assignee : "",
    project: positive(query.project) ? text(query.project) : "",
    due: text(query.due) in DUE_LABELS ? text(query.due) : "",
  };
}

export const activeFilters = (f: TaskFilters) => Object.values(f).filter(Boolean).length;

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const dayAfter = (now: Date, days: number) => { const d = new Date(now); d.setDate(d.getDate() + days); return day(d); };

/** "Today" is this person's today, so the server is asked for days, not words. */
export function dueRange(word: string, now: Date): Pick<TaskRequest, "due_from" | "due_to" | "no_due"> {
  switch (word) {
    case "overdue": return { due_to: dayAfter(now, -1) };
    case "today": return { due_from: day(now), due_to: day(now) };
    case "week": return { due_from: day(now), due_to: dayAfter(now, 7) };
    case "none": return { no_due: true };
    default: return {};
  }
}

export function toRequest(f: TaskFilters, o: { space: number | null; me: number; limit: number }, now: Date): TaskRequest {
  const assignee = f.assignee === "me" ? o.me : f.assignee === "none" ? -1 : Number(f.assignee) || undefined;
  return {
    space_id: o.space ?? undefined, project_id: Number(f.project) || undefined, status: f.status || undefined, priority: f.priority || undefined, q: f.q || undefined,
    assignee_id: assignee, limit: o.limit, ...dueRange(f.due, now),
  };
}

/** The projects a screen scoped to one space can use: that space's own, or every project when no space is picked. */
export const projectsIn = <P extends { space_id: number }>(projects: P[], space: number | null | undefined): P[] =>
  space ? projects.filter((p) => p.space_id === space) : projects;

export type ScreenState = "loading" | "failed" | "no-access" | "no-space" | "no-project" | "never" | "all-done" | "no-match" | "ready";

/** Which of its states a screen is in. A refresh that fails keeps what's on screen: only a first load can be "failed". */
export function screenState(s: { error: unknown; loaded: boolean; denied: boolean; spaces: number; projects: number; ever: number; open: number; shown: number; filtered: boolean; archived: boolean }): ScreenState {
  if (s.denied) return "no-access";
  if (!s.loaded) return s.error ? "failed" : "loading";
  if (s.filtered) return s.shown ? "ready" : "no-match";
  if (!s.spaces) return s.ever ? "ready" : "no-space";
  if (!s.ever) return s.projects ? "never" : "no-project";
  return s.open ? "ready" : "all-done";
}

export type TaskGroup = { status: TaskStatus; items: TaskView[] };

/** Rows by status, each in rank order. Finished work waits until it's asked for. */
export function listGroups(rows: TaskView[], showFinished: boolean): TaskGroup[] {
  return LIST_ORDER.filter((s) => showFinished || isOpen(s)).map((status) => ({
    status, items: rows.filter((r) => r.status === status).sort((a, b) => a.rank - b.rank || a.id - b.id),
  })).filter((g) => g.items.length);
}

/** Whether any column holds more than the server sent. */
export const hasMore = (rows: Pick<TaskView, "status">[], totals: TaskPage["totals"]) =>
  Object.entries(totals).some(([status, total]) => (total ?? 0) > rows.filter((r) => r.status === status).length);
