import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendWrite } from "@/lib/data/outbox";
import { dealPatch, moveLabel } from "./writes";

const board = { stages: [], items: [{ id: 7, title: "Care plan", stage_id: 1, rank: 5 }], ever: 1, open: 1 };
const key = ["deal", "pipeline", {}];

describe("a move the server refuses", () => {
  let client: QueryClient;
  beforeEach(() => { localStorage.clear(); client = new QueryClient(); client.setQueryData(key, board); });
  const move = (request: () => Promise<unknown>, failed: (m: string) => void) => sendWrite(1, {
    label: moveLabel("Care plan", "Proposal"), verb: "POST", path: "/move", body: {}, answer: true, changes: [dealPatch(7, { stage_id: 2, rank: 9 })],
  }, { client, request, notifyFailure: failed });
  const onBoard = () => (client.getQueryData(key) as typeof board).items[0];

  it("shows at once, puts the card back, and says which deal", async () => {
    let refuse!: (e: Error) => void;
    const told = vi.fn();
    const sent = move(() => new Promise((_, no) => { refuse = no; }), told);
    expect(onBoard()).toMatchObject({ stage_id: 2, rank: 9 });
    refuse(Object.assign(new Error("This record was deleted."), { status: 400 }));
    expect(await sent).toBe("failed");
    expect(onBoard()).toMatchObject({ stage_id: 1, rank: 5 });
    expect(told).toHaveBeenCalledWith("Couldn't move Care plan to Proposal. This record was deleted.");
  });
  it("takes the server's row as its answer", async () => {
    expect(await move(() => Promise.resolve({ id: 7, stage_id: 2, rank: 11, stage_name: "Proposal" }), vi.fn())).toBe("sent");
    expect(onBoard()).toMatchObject({ stage_id: 2, rank: 11, stage_name: "Proposal" });
  });
});
