// @vitest-environment node
// The seeded world holds together: every link lands on a row in both directions, the sample request is honest, and the production
// entry ships no rows at all. A workflow test starts with an empty database, so the seed itself is checked here.
import { describe, expect, it } from "vitest";
import { DEFAULT_STAGES, DEMO_AGENTS, DEMO_PEOPLE } from "./app";
import { demo_persona } from "./base/tables";
import {
  SAMPLE_EXPIRES_AT, SAMPLE_PROPOSAL, SEED_APPROVALS, SEED_COMPANIES, SEED_CONTACTS, SEED_CONVERSATIONS, SEED_DEALS, SEED_DOCS, SEED_FILES, SEED_LINKS, SEED_MESSAGES,
  SEED_NOTIFICATIONS, SEED_PROJECTS, SEED_RUNS, SEED_SPACE_MEMBERS, SEED_SPACES, SEED_STAGES, SEED_TASKS,
} from "./world";

const ROWS: Record<string, readonly unknown[]> = {
  task: SEED_TASKS, doc: SEED_DOCS, file: SEED_FILES, company: SEED_COMPANIES, contact: SEED_CONTACTS, deal: SEED_DEALS, conversation: SEED_CONVERSATIONS,
  project: SEED_PROJECTS, space: SEED_SPACES, message: SEED_MESSAGES,
};
const exists = (type: string, id: number) => id >= 1 && id <= (ROWS[type]?.length ?? 0);
// Read now: importing the production entry later empties every table's seed.
const SIGN_IN_KEYS = (demo_persona.seed as { key: string }[]).map((p) => p.key);
const SCOUT = DEMO_PEOPLE.length + DEMO_AGENTS.findIndex((a) => a.name === "Scout") + 1;
const MORGAN = DEMO_PEOPLE.findIndex((p) => p.key === "member") + 1;
const RILEY = DEMO_PEOPLE.findIndex((p) => p.role === "guest") + 1;

describe("the seeded links", () => {
  it("land on a seeded row at both ends", () => {
    for (const l of SEED_LINKS) {
      expect(exists(l.from_type, l.from_id), `${l.from_type} ${l.from_id}`).toBe(true);
      expect(exists(l.to_type, l.to_id), `${l.to_type} ${l.to_id}`).toBe(true);
    }
  });
  it("start where their record lives", () => {
    for (const l of SEED_LINKS) {
      const from = ROWS[l.from_type][l.from_id - 1] as { space_id?: number };
      if (from.space_id) expect(l.from_scope).toBe(`space-${from.space_id}`);
    }
  });
  it("point every task, deal and contact at rows that exist", () => {
    for (const t of SEED_TASKS) expect(exists("project", t.project_id)).toBe(true);
    for (const d of SEED_DEALS) {
      expect(exists("company", d.company_id)).toBe(true);
      expect(d.stage_id >= 1 && d.stage_id <= SEED_STAGES.length).toBe(true);
      if (d.contact_id) expect(exists("contact", d.contact_id)).toBe(true);
    }
    for (const m of SEED_MESSAGES) {
      expect(exists("conversation", m.conversation_id)).toBe(true);
      if (m.thread_id) expect(SEED_CONVERSATIONS[m.thread_id - 1].kind).toBe("thread");
    }
  });
});

describe("the sample run", () => {
  const run = SEED_RUNS.find((r) => r.sample)!;
  const ask = SEED_APPROVALS[0];
  const thread = SEED_CONVERSATIONS[ask.payload.conversation_id - 1];
  it("waits on the one seeded request, which goes to Scout's sponsor", () => {
    expect(SEED_RUNS.filter((r) => r.sample)).toHaveLength(1);
    expect(run).toMatchObject({ agent_id: SCOUT, requested_by: MORGAN, status: "waiting", waiting_on: MORGAN, approval_id: 1, is_demo: true, started_at: null, claimed_at: null });
    expect(SEED_RUNS.indexOf(run) + 1).toBe(ask.payload.run_id);
    expect(ask).toMatchObject({ user_id: MORGAN, status: "pending", action: "send_external", editable_field: "body", approver_roles: "", agent_label: "Scout" });
    expect(DEMO_AGENTS.find((a) => a.name === "Scout")!.sponsor).toBe(MORGAN);
  });
  it("lasts as long as the demo, not a module's seven days", () => {
    expect(ask.expires_at).toBe(SAMPLE_EXPIRES_AT);
    expect(SAMPLE_EXPIRES_AT).toBeGreaterThan(Date.now() + 10 * 365 * 86_400_000);
  });
  it("aims at its own thread in the client room, which Scout is in and a guest reads", () => {
    expect(ask.payload).toMatchObject({ conversation_id: run.thread_id, record_type: "conversation", record_id: run.thread_id, agent_id: SCOUT, body: SAMPLE_PROPOSAL });
    expect(thread).toMatchObject({ kind: "thread", record_type: "message", parent_id: run.conversation_id });
    expect(thread.space_id).toBe(run.space_id);
    const inRoom = SEED_SPACE_MEMBERS.filter((m) => m.space_id === run.space_id).map((m) => m.user_id);
    expect(inRoom).toContain(SCOUT);
    expect(inRoom).toContain(RILEY);
    const asked = SEED_MESSAGES[run.source_id - 1];
    expect(asked).toMatchObject({ author_id: MORGAN, conversation_id: run.conversation_id, thread_id: run.thread_id });
    expect(asked.body).toContain(`<@${SCOUT}>`);
  });
  it("is in Morgan's inbox as a decision", () => {
    expect(SEED_NOTIFICATIONS.filter((n) => n.user_id === MORGAN && n.needs_action)).toEqual([
      expect.objectContaining({ kind: "approval", entity: "approval", entity_id: 1, actor_id: SCOUT, clearable: false, head: true }),
    ]);
  });
});

describe("demo rows", () => {
  it("are all marked, so Clear demo data finds them", () => {
    for (const [type, rows] of Object.entries(ROWS)) for (const row of rows) expect((row as { is_demo?: boolean }).is_demo, type).toBe(true);
    for (const r of SEED_RUNS) expect(r.is_demo).toBe(true);
  });
  it("include the default pipeline, in the order setup makes it", () => {
    expect(SEED_STAGES.map((s) => [s.name, s.kind])).toEqual(DEFAULT_STAGES.map((s) => [s.name, s.kind]));
  });
});

describe("the production entry", () => {
  it("ships no seed rows in any table", async () => {
    const demo = (await import("./index")).default;
    const seeded = demo.tables().filter((t) => Array.isArray(t.seed) && t.seed.length > 0).map((t) => t.name);
    expect(seeded).toEqual(expect.arrayContaining(["user", "workspace_setting", "demo_persona", "approval", "message"]));
    const production = (await import("./production")).default;
    const left = production.tables().filter((t) => typeof t.seed === "function" || (Array.isArray(t.seed) && t.seed.length > 0)).map((t) => t.name);
    expect(left).toEqual([]);
  });
});

describe("demo sign-in", () => {
  it("offers Morgan first, whose first minute the demo is built around, then the rest in their usual order", () => {
    const keys = SIGN_IN_KEYS;
    expect(keys).toEqual(["member", "admin", "guest"]);
    expect(new Set(keys)).toEqual(new Set(DEMO_PEOPLE.map((p) => p.key)));
  });
});
