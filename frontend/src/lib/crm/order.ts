// A deal's place in a stage, on the task board's rules: the same gap, the same sums, so a card lands where it will stay. A stage is a
// column here, so the rows are read as that module's, with the stage's id for a status.
import { GAP, moveAcross, moveWithin, placeAt, step, type Direction, type Move } from "@/lib/tasks/order";
import type { DealView } from "./model";

export { GAP };
export type DealMove = { stage_id: number; before_id: number; rank: number };
type Placed = Pick<DealView, "id" | "stage_id" | "rank">;

const asCards = (rows: Placed[]) => rows.map((d) => ({ id: d.id, rank: d.rank, status: String(d.stage_id) })) as Parameters<typeof placeAt>[0];
const asMove = (m: Move | null): DealMove | null => (m ? { stage_id: Number(m.status), before_id: m.before_id, rank: m.rank } : null);

export const dealsIn = <T extends Placed>(rows: T[], stage: number): T[] => rows.filter((d) => d.stage_id === stage).sort((a, b) => a.rank - b.rank || a.id - b.id);
export const dropDeal = (rows: Placed[], id: number, stage: number, before: number | null) => asMove(placeAt(asCards(rows), id, String(stage) as never, before))!;
export const nudgeWithin = (rows: Placed[], id: number, by: 1 | -1) => asMove(moveWithin(asCards(rows), id, by));
export const nudgeAcross = (rows: Placed[], id: number, by: 1 | -1, stages: number[]) => asMove(moveAcross(asCards(rows), id, by, stages.map(String)));
export const stepDeals = (rows: Placed[], stages: number[], id: number | null, direction: Direction) => step(asCards(rows), stages.map(String), id, direction);
