import { describe, expect, it } from "vitest";
import { approvalLook, audienceLine, editedValue, landing, expiresLine, outcomeLine, waitingLine, type ApprovalView } from "./approvals";

const view = (over: Partial<ApprovalView> = {}): ApprovalView => ({
  id: 1, status: "pending", action: "send_external", title: "Post a message", preview: "Hello", approve_label: "Post it", editable_field: "body", details: { body: "Hello" },
  agent_id: 5, agent_name: "Relay", agent_kind: "agent", waiting_for: "Morgan Reyes", can_decide: true, record: null, guests: [], sample: false, created_at: 0, expires_at: null, decided_at: null, decided_by_name: null, link: "", ...over,
});
const nameOf = (id: number) => (id === 2 ? "Morgan Reyes" : "Someone");

describe("what a card says", () => {
  it("shows the exact words of a post", () => {
    const look = approvalLook(view(), nameOf);
    expect(look.asks).toBe("wants to post in");
    expect(look.body).toBe("Hello");
    expect(look.reason).toBe("");
  });
  it("names a task's fields, and leaves out what's empty", () => {
    const look = approvalLook(view({ action: "save_task", details: { id: 0, title: "Ship it", description: "", status: "in_progress", priority: "", due_on: "2026-11-12", assignee_id: 2 } }), nameOf);
    expect(look.asks).toBe("wants to add a task to");
    expect(look.facts).toEqual([{ label: "Status", value: "In progress" }, { label: "Due", value: "2026-11-12" }, { label: "Assigned to", value: "Morgan Reyes" }]);
  });
  it("says a change to a doc isn't a new doc", () => {
    expect(approvalLook(view({ action: "save_doc", details: { id: 4, text: "New", find: "Old", note: "It moved" } }), nameOf)).toMatchObject({ asks: "wants to change", bodyLabel: "The new words", reason: "It moved" });
    expect(approvalLook(view({ action: "save_doc", details: { id: 0, text: "New", title: "Plan" } }), nameOf).asks).toBe("wants to start a doc in");
  });
  it("gives the agent's reason where there's nothing else to read", () => {
    expect(approvalLook(view({ action: "delete_record", preview: "It's a duplicate", details: {} }), nameOf)).toMatchObject({ asks: "wants to delete", reason: "It's a duplicate", body: "" });
  });
  it("counts a bulk change", () => {
    expect(approvalLook(view({ action: "bulk_change", details: { ids: [1, 2, 3], status: "done" } }), nameOf).asks).toBe("wants to change 3 tasks in");
  });
  it("still reads for an action it doesn't know", () => {
    expect(approvalLook(view({ action: "something_new", title: "Do a thing" }), nameOf).asks).toBe("wants to: Do a thing");
  });
});

describe("who will see it", () => {
  it("names guests, up to two", () => {
    expect(audienceLine([])).toBe("");
    expect(audienceLine(["Riley Park"])).toBe("Riley Park will see this. They're a guest here.");
    expect(audienceLine(["Riley", "Sam"])).toBe("Riley and Sam will see this. They're guests here.");
    expect(audienceLine(["Riley", "Sam", "Jo", "Kim"])).toBe("Riley, Sam and 2 more will see this. They're guests here.");
  });
});

describe("how it ends", () => {
  it("shows the agent and the approver", () => {
    expect(outcomeLine({ status: "approved", agent_name: "Relay", decided_by_name: "Morgan Reyes" }, { done: "Posted" })).toBe("Posted. Relay · approved by Morgan Reyes");
  });
  it("says nothing happened when it didn't", () => {
    expect(outcomeLine({ status: "declined", agent_name: "Relay", decided_by_name: "Morgan Reyes" }, { done: "Posted" })).toBe("Declined by Morgan Reyes. Nothing happened, and Relay has been told.");
    expect(outcomeLine({ status: "expired", agent_name: "Relay", decided_by_name: null }, { done: "Posted" })).toBe("Nobody decided in time, so nothing happened. Relay has been told.");
  });
  it("tells someone else who it's waiting for", () => {
    expect(waitingLine({ agent_name: "Relay", waiting_for: "an admin" })).toBe("Relay is waiting for an admin to approve something here.");
  });
});

describe("the clock", () => {
  const now = 1_000_000_000;
  it("counts days, then hours", () => {
    expect(expiresLine(now + 6.4 * 86_400_000, now)).toBe("Expires in 6 days");
    expect(expiresLine(now + 86_400_000, now)).toBe("Expires in 1 day");
    expect(expiresLine(now + 5 * 3_600_000, now)).toBe("Expires in 5 hours");
    expect(expiresLine(now + 60_000, now)).toBe("Expires within the hour");
    expect(expiresLine(now - 1, now)).toBe("");
    expect(expiresLine(null, now)).toBe("");
  });
});

describe("an edit", () => {
  it("is sent only when something changed", () => {
    expect(editedValue("same", "same")).toBeUndefined();
    expect(editedValue("new", "same")).toBe("new");
  });
});

describe("where a request lands", () => {
  const thread = { type: "conversation", id: 9, title: "Thread in marlow-oakline", href: "/chat/9" };
  it("names a thread by its channel, and the chip still opens the thread", () => {
    expect(landing("send_external", "wants to post in", thread)).toEqual({ asks: "wants to reply in a thread in", record: { ...thread, title: "marlow-oakline" } });
  });
  it("leaves a post straight into a channel as it was", () => {
    const channel = { ...thread, title: "marlow-oakline" };
    expect(landing("send_external", "wants to post in", channel)).toEqual({ asks: "wants to post in", record: channel });
  });
  it("leaves every other request, and one with no record, as it was", () => {
    expect(landing("save_task", "wants to add a task to", thread)).toEqual({ asks: "wants to add a task to", record: thread });
    expect(landing("send_external", "wants to post in", null)).toEqual({ asks: "wants to post in", record: null });
  });
});
