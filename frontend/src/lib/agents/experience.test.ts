import { describe, expect, it } from "vitest";
import { askToAdd, MOST_ATTEMPTS, outsidersIn, pickupLine, REASONS, runLine, STALLED_AFTER_MS, stepLine, withoutAgents, workedText, type AgentRun } from "./model";

const run = (over: Partial<AgentRun> = {}) => ({
  id: 1, created_at: 0, agent_id: 4, agent_name: "Scout", requested_by: 2, status: "failed", reason: "timeout", detail: "", source_type: "task", source_id: 9, conversation_id: 0, thread_id: 0, space_id: 1, dm_id: 0, attempt: 1, reclaims: 0,
  done_reported: false, last_note: "", steps: 0, tool_calls: 0, tool_errors: 0, step_log: [], waiting_on: 0, claimed_at: null, started_at: null, finished_at: null, stopped_by: 2, is_demo: false, ...over,
}) as AgentRun;
const as = { modelReady: true, nameOf: (id: number) => (id === 2 ? "Morgan" : "Avery"), guest: false };
const CALM = /fail|error|crash|block|invalid|denied/i;

describe("every way a run ends short", () => {
  it("has one sentence and one thing to do, in calm words", () => {
    for (const [reason, { words, action }] of Object.entries(REASONS)) {
      const line = runLine(run({ reason: reason as AgentRun["reason"] }), as);
      if (reason !== "canceled") expect(line.note).toBe(words);
      expect(line.note.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2);
      expect(`${line.label} ${line.note}`).not.toMatch(CALM);
      if (action === "retry") expect(line).toMatchObject({ action: "retry", canRetry: true });
      if (action === "agent") expect(line).toMatchObject({ action: "agent", canRetry: false });
      if (action === "wait") expect(line).toMatchObject({ action: null, canRetry: false });
    }
  });

  it("stops offering Retry after three attempts, and says so", () => {
    const line = runLine(run({ reason: "timeout", attempt: MOST_ATTEMPTS }), as);
    expect(line).toMatchObject({ label: "Tried 3 times", canRetry: false, action: null });
    expect(line.note).toContain("Ask again in a new message.");
    expect(runLine(run({ reason: "canceled", attempt: 3 }), as).label).toBe("Tried 3 times");
    expect(runLine(run({ reason: "timeout", attempt: 2 }), as).canRetry).toBe(true);
  });

  it("sends people to the agent's page when only its sponsor or keys can put it right", () => {
    expect(runLine(run({ reason: "sponsor_left" }), as)).toMatchObject({ action: "agent", label: "Couldn't finish" });
    expect(runLine(run({ reason: "key_revoked" }), as).action).toBe("agent");
    expect(runLine(run({ reason: "sponsor_left" }), { ...as, guest: true }).action).toBeNull();
  });

  it("waiting reads as who it's waiting for", () => {
    expect(runLine(run({ status: "waiting", reason: "", waiting_on: 2 }), as).label).toBe("Waiting for Morgan");
    expect(runLine(run({ status: "waiting", reason: "", waiting_on: 2, approval_id: 7 }), as).label).toBe("Waiting for Morgan to approve");
    expect(runLine(run({ status: "waiting", reason: "", waiting_on: 0, approval_id: 7 }), as).label).toBe("Waiting for an admin to approve");
  });

  it("a later attempt says which try it is", () => {
    expect(runLine(run({ status: "queued", reason: "", attempt: 2 }), as).label).toBe("Queued, try 2 of 3");
  });
});

describe("what a run did", () => {
  it("reads as time and steps, or whichever is known", () => {
    expect(workedText({ started_at: 1000, finished_at: 43_000, tool_calls: 6 })).toBe("Worked for 42 s, 6 steps");
    expect(workedText({ started_at: 1000, finished_at: 43_000, tool_calls: 1 })).toBe("Worked for 42 s, 1 step");
    expect(workedText({ started_at: null, finished_at: null, tool_calls: 2 })).toBe("Worked for 2 steps");
    expect(workedText({ started_at: null, finished_at: null, tool_calls: 0 })).toBe("");
  });

  it("names a step's record only for someone who can open it", () => {
    const live = { state: "live", title: "Book the checkout test", href: "/tasks/3" };
    expect(stepLine({ tool: "save_task", ok: true, type: "task", id: 3 }, live)).toEqual({ text: "Saved the task", title: "Book the checkout test", href: "/tasks/3", ok: true });
    expect(stepLine({ tool: "save_task", ok: true, type: "task", id: 3 }, { state: "locked", title: "", href: "" })).toMatchObject({ title: "something you can't open", href: "" });
    expect(stepLine({ tool: "report_progress", ok: true, type: "", id: 0 }, undefined)).toMatchObject({ text: "Said how it was going", title: "" });
    expect(stepLine({ tool: "post_message", ok: false, type: "", id: 0 }, undefined)).toMatchObject({ text: "Couldn't post a message", ok: false });
    expect(stepLine({ tool: "brand_new", ok: true, type: "", id: 0 }, undefined).text).toBe("Used brand new");
    for (const tool of ["post_message", "save_task", "save_doc", "save_crm_record", "save_file", "read_record", "search", "my_inbox", "request_action"]) {
      expect(stepLine({ tool, ok: false, type: "", id: 0 }, undefined).text).not.toMatch(CALM);
    }
  });
});

describe("work handed to a connected agent", () => {
  const now = 10 * 3_600_000;
  it("waits, then reads Stalled after 30 minutes with nothing picked up", () => {
    expect(pickupLine({ created_at: now - 60_000, read_at: null }, "Relay", now).label).toBe("Waiting for Relay to pick this up");
    expect(pickupLine({ created_at: now - STALLED_AFTER_MS - 1, read_at: null }, "Relay", now)).toMatchObject({ label: "Stalled", tone: "waiting" });
    expect(pickupLine({ created_at: now - STALLED_AFTER_MS - 1, read_at: null }, "Relay", now).note).not.toMatch(CALM);
  });

  it("never reads Stalled once my_inbox has handed it over, however long the agent stays away", () => {
    for (const away of [0, STALLED_AFTER_MS + 1, 30 * 86_400_000]) {
      expect(pickupLine({ created_at: now - away - 1000, read_at: now - away }, "Relay", now).label).toBe("Relay picked this up");
    }
  });
});

describe("naming an agent that isn't here", () => {
  const scout = { id: 4, name: "Scout" };
  const relay = { id: 5, name: "Relay" };
  it("finds the named agents outside the conversation", () => {
    expect(outsidersIn([4, 2], [{ id: 2 }], [scout, relay])).toEqual([scout]);
    expect(outsidersIn([4], [{ id: 4 }], [scout])).toEqual([]);
  });

  it("sends without the agent as plain words, so it asks nothing of it", () => {
    expect(withoutAgents("<@4> can you check <@2>'s list?", [scout])).toBe("Scout can you check <@2>'s list?");
  });

  it("names who can add it, or says to ask an admin", () => {
    expect(askToAdd(["Scout"], ["Avery Chen"])).toBe("Ask Avery Chen to add Scout to this space.");
    expect(askToAdd(["Scout"], ["Avery Chen", "Morgan Reyes"])).toBe("Ask Avery Chen or Morgan Reyes to add Scout to this space.");
    expect(askToAdd(["Scout", "Relay"], [])).toBe("Ask an admin to add them to this space.");
  });
});
