import { describe, expect, it } from "vitest";
import { GAP, afterMove, columnOf, moveAcross, moveWithin, neighbour, rankBetween, sortTasks, step } from "./order";

const t = (id: number, status: string, rank: number) => ({ id, status, rank } as never);
const board = [t(1, "todo", 10), t(2, "todo", 20), t(3, "todo", 30), t(4, "in_progress", 5)];
const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

describe("ranks", () => {
  it("goes between two neighbours, above the first, or below the last", () => {
    expect(rankBetween(10, 20)).toBe(15);
    expect(rankBetween(null, 20)).toBe(20 - GAP);
    expect(rankBetween(10, null)).toBe(10 + GAP);
    expect(rankBetween(null, null)).toBe(0);
  });
  it("sorts by rank, then by id, as the server does", () => {
    expect(ids(sortTasks([t(2, "todo", 5), t(1, "todo", 5), t(3, "todo", 1)]))).toEqual([3, 1, 2]);
  });
  it("reads one column in order", () => {
    expect(ids(columnOf(board, "todo"))).toEqual([1, 2, 3]);
  });
});

describe("a move", () => {
  it("up swaps with the card above, naming that card as the one to sit over", () => {
    expect(moveWithin(board, 2, -1)).toEqual({ status: "todo", before_id: 1, rank: 10 - GAP });
    expect(moveWithin(board, 3, -1)).toEqual({ status: "todo", before_id: 2, rank: 15 });
  });
  it("down sits over the card two below, or last with none", () => {
    expect(moveWithin(board, 1, 1)).toEqual({ status: "todo", before_id: 3, rank: 25 });
    expect(moveWithin(board, 2, 1)).toEqual({ status: "todo", before_id: 0, rank: 30 + GAP });
  });
  it("stops at the ends of a column", () => {
    expect(moveWithin(board, 1, -1)).toBeNull();
    expect(moveWithin(board, 3, 1)).toBeNull();
  });
  it("across keeps its height in the next column, as near as it can", () => {
    const statuses = ["todo", "in_progress", "done"];
    expect(moveAcross(board, 2, 1, statuses)).toEqual({ status: "in_progress", before_id: 0, rank: 5 + GAP });
    expect(moveAcross(board, 1, 1, statuses)).toEqual({ status: "in_progress", before_id: 4, rank: 5 - GAP });
    expect(moveAcross(board, 1, -1, statuses)).toBeNull();
    expect(moveAcross(board, 4, 1, statuses)).toEqual({ status: "done", before_id: 0, rank: 0 });
  });
  it("shows on screen as the server will store it", () => {
    const moved = afterMove(board, 3, { status: "todo", before_id: 2, rank: 15 });
    expect(ids(columnOf(moved, "todo"))).toEqual([1, 3, 2]);
  });
});

describe("walking the board", () => {
  const statuses = ["todo", "in_progress"];
  it("down and up stay in a column, and stop at its ends", () => {
    expect(step(board, statuses, 1, "down")).toBe(2);
    expect(step(board, statuses, 3, "down")).toBe(3);
    expect(step(board, statuses, 1, "up")).toBe(1);
  });
  it("across lands at the same height, or the last card", () => {
    expect(step(board, statuses, 3, "right")).toBe(4);
    expect(step(board, statuses, 4, "left")).toBe(1);
  });
  it("skips an empty column", () => {
    expect(step([t(1, "todo", 1), t(2, "done", 1)], ["todo", "in_progress", "done"], 1, "right")).toBe(2);
  });
  it("starts at the first card when nothing is selected", () => {
    expect(step(board, statuses, null, "down")).toBe(1);
  });
  it("keeps a neighbour to land on when the selected task leaves the view", () => {
    expect(neighbour([1, 2, 3], 2)).toBe(3);
    expect(neighbour([1, 2, 3], 3)).toBe(2);
    expect(neighbour([1], 1)).toBeNull();
  });
});
