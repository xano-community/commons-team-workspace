import { describe, expect, it } from "vitest";
import { GAP, dealsIn, dropDeal, nudgeAcross, nudgeWithin, stepDeals } from "./order";

const deal = (id: number, stage_id: number, rank: number) => ({ id, stage_id, rank } as never);
const rows = [deal(1, 10, GAP), deal(2, 10, GAP * 2), deal(3, 10, GAP * 3), deal(4, 20, GAP)];

describe("where a deal lands", () => {
  it("reads a stage in rank order", () => {
    expect(dealsIn([deal(2, 10, 9), deal(1, 10, 3), deal(3, 20, 1)], 10).map((d) => (d as { id: number }).id)).toEqual([1, 2]);
  });
  it("lands above the deal it's dropped on, on the sum the server does", () => {
    expect(dropDeal(rows, 3, 10, 2)).toEqual({ stage_id: 10, before_id: 2, rank: GAP + GAP / 2 });
  });
  it("lands last with nothing under it", () => {
    expect(dropDeal(rows, 1, 20, null)).toEqual({ stage_id: 20, before_id: 0, rank: GAP * 2 });
  });
  it("moves up and down by one, and stops at the ends", () => {
    expect(nudgeWithin(rows, 2, -1)).toMatchObject({ stage_id: 10, before_id: 1 });
    expect(nudgeWithin(rows, 2, 1)).toMatchObject({ stage_id: 10, before_id: 0 });
    expect(nudgeWithin(rows, 1, -1)).toBeNull();
  });
  it("crosses to the next stage at the same height, and stops at the edge", () => {
    expect(nudgeAcross(rows, 1, 1, [10, 20, 30])).toMatchObject({ stage_id: 20, before_id: 4 });
    expect(nudgeAcross(rows, 4, 1, [10, 20])).toBeNull();
    expect(nudgeAcross(rows, 1, -1, [10, 20])).toBeNull();
  });
  it("steps over an empty stage when the keyboard walks the board", () => {
    expect(stepDeals(rows, [10, 15, 20], 1, "right")).toBe(4);
    expect(stepDeals(rows, [10, 15, 20], 4, "left")).toBe(1);
    expect(stepDeals(rows, [10, 15, 20], null, "down")).toBe(1);
    expect(stepDeals(rows, [10, 15, 20], 2, "down")).toBe(3);
  });
});
