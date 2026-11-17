import { describe, expect, it } from "vitest";
import { askedOf, CHAIN_STOPPED, keyCommand, newestBySource, pollEvery, refusedKey, runLine, tookText, type AgentRun } from "./model";

const run = (over: Partial<AgentRun> = {}) => ({
  id: 1, created_at: 0, agent_id: 4, agent_name: "Scout", requested_by: 2, status: "queued", reason: "", detail: "", source_type: "task", source_id: 9, conversation_id: 0, thread_id: 0, space_id: 1, dm_id: 0, attempt: 1, reclaims: 0,
  done_reported: false, last_note: "", steps: 0, tool_calls: 0, tool_errors: 0, step_log: [], waiting_on: 0, claimed_at: null, started_at: null, finished_at: null, stopped_by: 0, is_demo: false, ...over,
}) as AgentRun;
const as = { modelReady: true, nameOf: (id: number) => (id === 2 ? "Morgan" : "Avery"), guest: false };

describe("what a run says", () => {
  it("is plain about each state", () => {
    expect(runLine(run(), as).label).toBe("Queued");
    expect(runLine(run({ status: "claimed" }), as).label).toBe("Starting");
    expect(runLine(run({ status: "working", last_note: "Reading the thread" }), as)).toMatchObject({ label: "Working", note: "Reading the thread", canStop: true, canRetry: false });
    expect(runLine(run({ status: "waiting", waiting_on: 2 }), as).label).toBe("Waiting for Morgan");
    expect(runLine(run({ status: "waiting", waiting_on: 2, approval_id: 7 }), as).label).toBe("Waiting for Morgan to approve");
    expect(runLine(run({ status: "waiting", waiting_on: 2, approval_id: 7 }), { ...as, me: 2 }).label).toBe("Waiting for your OK");
    expect(runLine(run({ status: "waiting", waiting_on: 2, approval_id: 7 }), { ...as, me: 3 }).label).toBe("Waiting for Morgan to approve");
    expect(runLine(run({ status: "done", started_at: 1000, finished_at: 43_000, tool_calls: 3, last_note: "Listed it." }), as)).toMatchObject({ label: "Done", worked: "Worked for 42 s, 3 steps", note: "Listed it.", canStop: false });
  });

  it("says a run is waiting on a key, not that it's queued, when there's no model", () => {
    expect(runLine(run(), { ...as, modelReady: false })).toMatchObject({ label: "Needs a model key to run", tone: "waiting", canStop: true });
  });

  it("gives each failure a reason, and Retry until the attempts run out", () => {
    const failed = (over: Partial<AgentRun>) => runLine(run({ status: "failed", ...over }), as);
    expect(failed({ reason: "timeout" })).toMatchObject({ label: "Couldn't finish", note: "It ran out of time. Try again, or ask for something smaller.", canRetry: true });
    expect(failed({ reason: "model_error", detail: "The model refused the key. An admin can set a new GEMINI_API_KEY, then press Retry." }).note).toContain("GEMINI_API_KEY");
    expect(failed({ reason: "no_completion", detail: "A step didn't work and it wasn't put right: post_message" }).note).toBe("It stopped before it was done. Check what it left, then try again.");
    expect(failed({ reason: "budget", detail: "This demo runs 20 agent requests a day, and today's are used. More are available tomorrow." }).note).toContain("More are available tomorrow");
    expect(failed({ reason: "budget" })).toMatchObject({ canRetry: false, action: null });
    expect(failed({ reason: "budget" }).note).toContain("tomorrow");
    expect(failed({ reason: "removed_from_space" }).note).toContain("Add it back");
    expect(failed({ reason: "step_limit", attempt: 3 })).toMatchObject({ canRetry: false, label: "Tried 3 times" });
    expect(failed({ reason: "canceled", stopped_by: 2 })).toMatchObject({ label: "Stopped", note: "Stopped by Morgan." });
    expect(failed({ reason: "something_new" as AgentRun["reason"] }).note).toBe("It stopped before it was done. Try again in a moment.");
  });

  it("uses calm words: no run says it crashed, errored or was blocked", () => {
    const reasons = ["timeout", "step_limit", "no_completion", "budget", "key_revoked", "sponsor_left", "removed_from_space", "model_error"] as AgentRun["reason"][];
    for (const reason of reasons) {
      // What a person reads. The tone is a style name, not words on screen.
      const { label, note } = runLine(run({ status: "failed", reason }), as);
      expect(`${label} ${note}`).not.toMatch(/fail|error|crash|block|invalid/i);
    }
  });

  it("says when a pause is what's holding a run, ahead of anything else", () => {
    expect(runLine(run(), { ...as, paused: true })).toMatchObject({ label: "Paused", tone: "waiting", canStop: true });
    expect(runLine(run(), { ...as, paused: true, modelReady: false }).label).toBe("Paused");
    expect(runLine(run({ status: "working" }), { ...as, paused: true }).label).toBe("Working");
  });

  it("says when a chain stopped, whatever the run itself came to", () => {
    expect(runLine(run({ status: "done", chain_stopped: true }), as).note).toBe(CHAIN_STOPPED);
    expect(runLine(run({ status: "done", chain_stopped: true, last_note: "Passed it on." }), as).note).toBe(`Passed it on. ${CHAIN_STOPPED}`);
    expect(CHAIN_STOPPED).toBe("Chain stopped: a person can continue it.");
    expect(runLine(run({ status: "done" }), as).note).not.toContain("Chain");
  });

  it("offers the key command only for a refused key", () => {
    const refused = { status: "failed", reason: "model_error", detail: "The model refused the key. An admin can set a new GEMINI_API_KEY, then press Retry." } as const;
    expect(refusedKey(refused, "GEMINI_API_KEY")).toBe(true);
    expect(refusedKey({ ...refused, detail: "The model didn't answer: overloaded" }, "GEMINI_API_KEY")).toBe(false);
    expect(refusedKey({ ...refused, reason: "timeout" }, "GEMINI_API_KEY")).toBe(false);
  });

  it("never offers a guest Retry, and always lets them Stop", () => {
    expect(runLine(run({ status: "failed", reason: "timeout" }), { ...as, guest: true }).canRetry).toBe(false);
    expect(runLine(run({ status: "working" }), { ...as, guest: true }).canStop).toBe(true);
  });
});

describe("how long a run took", () => {
  it("reads in seconds, then minutes, and says nothing for a run that never started", () => {
    expect(tookText({ started_at: 0, finished_at: null })).toBe("");
    expect(tookText({ started_at: 1, finished_at: 200 })).toBe("1 s");
    expect(tookText({ started_at: 1000, finished_at: 181_000 })).toBe("3 min");
  });
});

describe("which run a record shows", () => {
  it("is its newest", () => {
    const shown = newestBySource([run({ id: 1, source_id: 9 }), run({ id: 3, source_id: 9 }), run({ id: 2, source_type: "message", source_id: 9 })], "task");
    expect(shown.get(9)?.id).toBe(3);
    expect(shown.size).toBe(1);
  });
});

describe("a mention that's only just been sent", () => {
  const scout = { id: 4, name: "Scout" };
  it("names the hosted agent it asks, for a few seconds", () => {
    expect(askedOf({ body: "<@4> what's left?", created_at: 1000 }, [scout], 2000)).toBe(scout);
    expect(askedOf({ body: "<@4> what's left?", created_at: 1000 }, [scout], 60_000)).toBeUndefined();
    expect(askedOf({ body: "<@2> what's left?", created_at: 1000 }, [scout], 2000)).toBeUndefined();
  });
});

describe("the fix for a missing key", () => {
  it("names the key and holds no value", () => {
    expect(keyCommand("ANTHROPIC_API_KEY")).toBe('printf %s "$KEY" | npx @xano/sdk env set ANTHROPIC_API_KEY');
  });
});

describe("polling", () => {
  it("runs only while something can move on its own", () => {
    expect(pollEvery([run({ status: "working" })])).toBe(5000);
    expect(pollEvery([run({ status: "waiting" }), run({ status: "done" })])).toBe(false);
    expect(pollEvery(undefined)).toBe(false);
  });
});
