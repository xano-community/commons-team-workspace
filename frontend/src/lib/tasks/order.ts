// Order in a column. A move names only the task it sits above, which is right in any filtered view; the rank here is the same
// sum the server does, so the card lands where it will stay. Pure, and the same for a drag and a key.
import type { TaskStatus, TaskView } from "./model";

/** Must match the server's step (xano/function/tasks/tasks.ts). */
export const GAP = 1_048_576;

type Placed = Pick<TaskView, "id" | "status" | "rank">;
export type Move = { status: TaskStatus; before_id: number; rank: number };
export type Direction = "up" | "down" | "left" | "right";

export const sortTasks = <T extends Placed>(rows: T[]): T[] => [...rows].sort((a, b) => a.rank - b.rank || a.id - b.id);
export const columnOf = <T extends Placed>(rows: T[], status: string): T[] => sortTasks(rows.filter((r) => r.status === status));

export function rankBetween(above: number | null, below: number | null): number {
  if (above === null && below === null) return 0;
  if (above === null) return below! - GAP;
  if (below === null) return above + GAP;
  return above + Math.floor((below - above) / 2);
}

/** A task's place above `before`, or at the end of a column with none. */
export function placeAt(rows: Placed[], id: number, status: TaskStatus, before: number | null): Move {
  const column = columnOf(rows, status).filter((r) => r.id !== id);
  const at = before === null ? -1 : column.findIndex((r) => r.id === before);
  if (at < 0) return { status, before_id: 0, rank: rankBetween(column.at(-1)?.rank ?? null, null) };
  return { status, before_id: column[at].id, rank: rankBetween(column[at - 1]?.rank ?? null, column[at].rank) };
}

export function moveWithin(rows: Placed[], id: number, by: 1 | -1): Move | null {
  const task = rows.find((r) => r.id === id);
  if (!task) return null;
  const column = columnOf(rows, task.status);
  const at = column.findIndex((r) => r.id === id);
  const target = at + by;
  if (target < 0 || target >= column.length) return null;
  return placeAt(rows, id, task.status as TaskStatus, by < 0 ? column[target].id : column[target + 1]?.id ?? null);
}

/** Into the next column, at the same height, or last when that one is shorter. */
export function moveAcross(rows: Placed[], id: number, by: 1 | -1, statuses: string[]): Move | null {
  const task = rows.find((r) => r.id === id);
  if (!task) return null;
  const to = statuses[statuses.indexOf(task.status) + by] as TaskStatus | undefined;
  if (!to) return null;
  const height = columnOf(rows, task.status).findIndex((r) => r.id === id);
  return placeAt(rows, id, to, columnOf(rows, to)[height]?.id ?? null);
}

export const afterMove = <T extends Placed>(rows: T[], id: number, move: Move): T[] => rows.map((r) => (r.id === id ? { ...r, status: move.status, rank: move.rank } : r));

/** The next card from `id`. A column with nothing in it is stepped over. */
export function step(rows: Placed[], statuses: string[], id: number | null, direction: Direction): number | null {
  const first = statuses.map((s) => columnOf(rows, s)[0]).find(Boolean);
  const task = id === null ? undefined : rows.find((r) => r.id === id);
  if (!task) return first?.id ?? null;
  const column = columnOf(rows, task.status);
  const at = column.findIndex((r) => r.id === id);
  if (direction === "up" || direction === "down") return column[Math.min(column.length - 1, Math.max(0, at + (direction === "down" ? 1 : -1)))].id;
  const by = direction === "right" ? 1 : -1;
  for (let n = statuses.indexOf(task.status) + by; n >= 0 && n < statuses.length; n += by) {
    const next = columnOf(rows, statuses[n]);
    if (next.length) return next[Math.min(at, next.length - 1)].id;
  }
  return id;
}

/** Where selection goes when the selected task leaves the view: the next one, or the one before the last. */
export function neighbour(ids: number[], id: number): number | null {
  const at = ids.indexOf(id);
  return ids[at + 1] ?? ids[at - 1] ?? null;
}
