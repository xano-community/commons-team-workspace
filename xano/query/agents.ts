// Agents over HTTP: what a screen reads about a run, and the two things a person can do to one, then each agent's page and what an
// admin does from it. A person's only door to starting a run is mentioning or assigning, so nothing here starts new work.
import { apiGroup, auth, inp, input, query, ref, s } from "@xano/sdk";
import type { InferRow } from "@xano/sdk";
import type { RecordView } from "./links.js";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { agent_run } from "../table/agents/agent_run.js";
import { gateActive } from "../function/members/gate.js";
import { bindBrowser } from "../function/access/reach.js";
import { executeRun, listConnectedAgents, listHostedAgents, listRuns, loopGroup, retryRun, setPaused, stopRun } from "../agents/runner.js";
import { listAgentKeys, mintAgentKey, revokeAgentKey, rotateAgentKey } from "../agents/keys.js";
import { approvalView, overseenApprovals, recordApprovals } from "../function/inbox/approvals.js";
import { changeSponsor, createAgent, reviveAgent, setAgentSpaces, sponsorChoices, updateAgent } from "../function/agents/manage.js";
import { agentMentionCheck, agentPickups, agentProfile, agentRuns, runSteps } from "../function/agents/read.js";

export const agentsGroup = apiGroup({ name: "agents", canonical: "agents", middleware: { pre: [gateActive] }, description: "Hosted agents' runs." });

export type AgentRun = Omit<InferRow<typeof agent_run>, "base_url" | "active_key" | "connection_id" | "chain" | "asked_by" | "handed_from" | "spent_at"> & { agent_name: string };
export type RunList = { items: AgentRun[]; model_ready: boolean; key_name: string };
export type ConnectedAgents = { items: { id: number; name: string; brief: string; sponsor_id: number; last_seen: number | null; has_key: boolean }[] };
export type AgentKey = { id: number; name: string; scope: "read" | "read_write"; revoked: boolean; expires_at: number | null; last_used_at: number | null; created_at: number };
export type ApprovalView = {
  id: number; status: "pending" | "approved" | "declined" | "expired"; action: string; title: string; preview: string; approve_label: string; editable_field: string; details: Record<string, unknown> | null;
  agent_id: number; agent_name: string; agent_kind: "agent" | "human"; waiting_for: string; can_decide: boolean; record: RecordView | null; guests: string[];
  /** The demo's seeded request: no model wrote it, and deciding it ends its run (KTD3). */
  sample: boolean;
  created_at: number; expires_at: number | null; decided_at: number | null; decided_by_name: string | null; link: string;
};
export type HostedAgents = { items: { id: number; name: string; brief: string; sponsor_id: number }[]; model_ready: boolean; key_name: string; paused: boolean };
/** One step of a run: the tool, whether it worked, and the record it touched. Never what was said (KTD11). */
export type RunStep = { tool: string; ok: boolean; type: string; id: number };
export type AgentProfile = {
  id: number; name: string; mode: "hosted" | "connected"; brief: string; status: "active" | "disabled" | "removed"; is_demo: boolean; created_at: number;
  sponsor: { id: number; name: string | null; active: boolean };
  spaces: { id: number; name: string; archived_at: number | null; visibility: string }[]; hidden_spaces: number;
  last_seen: number | null; has_key: boolean; model_ready: boolean; key_name: string; paused: boolean;
  can_manage: boolean; demo_session: boolean; is_sponsor: boolean; can_keys: boolean;
};
export type AgentRunList = { items: (AgentRun & { space_id: number; dm_id: number })[]; records: RecordView[] };
export type RunSteps = { steps: (RunStep & { record: RecordView | null })[] };
export type Pickups = { items: { user_id: number; seq: number; created_at: number; read_at: number | null }[] };
export type AgentMentionCheck = { missing: { id: number; name: string }[]; can_add: boolean; space_id: number; managers: string[]; in_dm: boolean };

const caller = () => [...rbac.signedIn(), ...bindBrowser()];
const who = () => ({ actor_id: auth("id"), browser: ref("browser") });

export const hostedAgentsRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "agents/hosted", verb: "GET",
  description: "The hosted agents, what each is for, and whether a model is ready for them.",
  stack: [...rbac.signedIn(), s.function.run({ fn: listHostedAgents, as: "list", input: { actor_id: auth("id") } })],
  response: ref("list"),
  responseShape: {} as HostedAgents,
});

export const pauseAgentsRoute = query({
  // Turning agents back on starts what's queued, which mints each run's token.
  apiGroup: agentsGroup, auth: user, history: false,
  name: "agents/pause", verb: "POST",
  description: "Pause all agents, or turn them back on. What's queued waits, and starts once they're back.",
  input: { paused: input.bool({ required: true }) },
  stack: [...rbac.require("team.manage", "Only people who manage the team pause agents."), s.function.run({ fn: setPaused, as: "state", input: { actor_id: auth("id"), paused: inp("paused") } })],
  response: ref("state"),
  responseShape: {} as { paused: boolean },
});

export const listRunsRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "agent-runs", verb: "GET",
  description: "The runs on one conversation, one task or one doc.",
  input: { conversation_id: input.int(), task_id: input.int(), doc_id: input.int() },
  stack: [...caller(), s.function.run({ fn: listRuns, as: "page", input: { ...who(), conversation_id: inp("conversation_id"), task_id: inp("task_id"), doc_id: inp("doc_id") } })],
  response: ref("page"),
  responseShape: {} as RunList,
});

export const stopRunRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "agent-runs/{id}/stop", verb: "POST",
  description: "Stop a run. Its next tool call is refused.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: stopRun, as: "run", input: { ...who(), id: inp("id") } })],
  response: ref("run"),
  responseShape: {} as AgentRun,
});

export const retryRunRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "agent-runs/{id}/retry", verb: "POST",
  // It can start an agent run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Try a failed run again, up to three attempts.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: retryRun, as: "run", input: { ...who(), id: inp("id") } })],
  response: ref("run"),
  responseShape: {} as AgentRun,
});

export const connectedAgentsRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "agents/connected", verb: "GET",
  description: "The connected agents, and when each was last seen.",
  stack: [...rbac.signedIn(), s.function.run({ fn: listConnectedAgents, as: "list", input: { actor_id: auth("id") } })],
  response: ref("list"),
  responseShape: {} as ConnectedAgents,
});

export const approvalRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "agent-approvals/{id}", verb: "GET",
  description: "One approval as a card.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: approvalView, as: "view", input: { ...who(), id: inp("id") } })],
  response: ref("view"),
  responseShape: {} as ApprovalView,
});

export const recordApprovalsRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "agent-approvals", verb: "GET",
  description: "What's waiting for a decision on one record.",
  input: { type: input.text({ required: true }), id: input.int({ required: true }), thread_id: input.int() },
  stack: [...caller(), s.function.run({ fn: recordApprovals, as: "list", input: { ...who(), type: inp("type"), id: inp("id"), thread_id: inp("thread_id") } })],
  response: ref("list"),
  responseShape: {} as { items: ApprovalView[] },
});

export const overseenApprovalsRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "approvals-overseen", verb: "GET",
  description: "For an admin: what agents are waiting on someone else for, outside DMs. Read-only.",
  stack: [...caller(), s.function.run({ fn: overseenApprovals, as: "list", input: { ...who() } })],
  response: ref("list"),
  responseShape: {} as { items: ApprovalView[] },
});

export const listKeysRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "agents/{agent_id}/keys", verb: "GET",
  description: "A connected agent's keys. Needs an admin or its sponsor.",
  input: { agent_id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: listAgentKeys, as: "list", input: { ...who(), agent_id: inp("agent_id") } })],
  response: ref("list"),
  responseShape: {} as { items: AgentKey[] },
});

// A token passes through these, so nothing of the request is kept.
export const mintKeyRoute = query({
  apiGroup: agentsGroup, auth: user, history: false,
  name: "agents/{agent_id}/keys", verb: "POST",
  description: "Give a connected agent a key, read or read and write, for 1 to 90 days. The token shows once.",
  input: { agent_id: input.int({ required: true }), name: input.text({ required: true }), scope: input.enum(["read", "read_write"], { required: true }), days: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: mintAgentKey, as: "made", input: { ...who(), agent_id: inp("agent_id"), name: inp("name"), scope: inp("scope"), days: inp("days") } })],
  response: ref("made"),
  responseShape: {} as { key: AgentKey; token: string },
});

export const rotateKeyRoute = query({
  apiGroup: agentsGroup, auth: user, history: false,
  name: "agents/{agent_id}/keys/{key_id}/rotate", verb: "POST",
  description: "Swap a key for a new one. What the old key asked for moves across, and it stops at once.",
  input: { agent_id: input.int({ required: true }), key_id: input.int({ required: true }), days: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: rotateAgentKey, as: "made", input: { ...who(), agent_id: inp("agent_id"), key_id: inp("key_id"), days: inp("days") } })],
  response: ref("made"),
  responseShape: {} as { key: AgentKey; token: string; moved: number },
});

export const revokeKeyRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "agents/{agent_id}/keys/{key_id}/revoke", verb: "POST",
  description: "End a key. Its next call is refused.",
  input: { agent_id: input.int({ required: true }), key_id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: revokeAgentKey, as: "gone", input: { ...who(), agent_id: inp("agent_id"), key_id: inp("key_id") } })],
  response: ref("gone"),
  responseShape: {} as { id: number; revoked: boolean },
});

// An agent's page (KTD6), and what an admin changes there. Each read is filtered for whoever asks, and a guest is turned away.
export const agentProfileRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "team-agents/{agent_id}", verb: "GET",
  description: "One agent's page: role, brief, sponsor, spaces, and what this reader may do.",
  input: { agent_id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: agentProfile, as: "page", input: { ...who(), agent_id: inp("agent_id") } })],
  response: ref("page"),
  responseShape: {} as AgentProfile,
});

export const agentRunsRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "team-agents/{agent_id}/runs", verb: "GET",
  description: "An agent's recent runs that this reader may see.",
  input: { agent_id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: agentRuns, as: "list", input: { ...who(), agent_id: inp("agent_id") } })],
  response: ref("list"),
  responseShape: {} as AgentRunList,
});

export const runStepsRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "agent-runs/{id}/steps", verb: "GET",
  description: "What a run did, step by step, with each record named for this reader.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: runSteps, as: "list", input: { ...who(), id: inp("id") } })],
  response: ref("list"),
  responseShape: {} as RunSteps,
});

export const pickupsRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "agent-pickups", verb: "GET",
  description: "Whether connected agents have picked up what a task or conversation asked of them.",
  input: { type: input.text({ required: true }), id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: agentPickups, as: "list", input: { ...who(), type: inp("type"), id: inp("id") } })],
  response: ref("list"),
  responseShape: {} as Pickups,
});

export const agentMentionCheckRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "agent-mention-check", verb: "POST",
  description: "Which agents a message names that can't hear it in this conversation, and who may add them.",
  input: { conversation_id: input.int({ required: true }), agent_ids: input.list(input.int()) },
  stack: [...caller(), s.function.run({ fn: agentMentionCheck, as: "check", input: { ...who(), conversation_id: inp("conversation_id"), agent_ids: inp("agent_ids") } })],
  response: ref("check"),
  responseShape: {} as AgentMentionCheck,
});

export const sponsorChoicesRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "agent-sponsors", verb: "GET",
  description: "Who can sponsor an agent: active people who aren't guests.",
  stack: [...rbac.require("team.manage", "Only people who manage the team choose sponsors."), s.function.run({ fn: sponsorChoices, as: "people" })],
  response: ref("people"),
  responseShape: [] as { id: number; name: string }[],
});

export const createAgentRoute = query({
  // Joining spaces goes through the same doors as changing them later, so nothing of this request is kept either.
  apiGroup: agentsGroup, auth: user, history: false,
  name: "team-agents", verb: "POST",
  description: "Add a hosted or connected agent. Admins only, and never from a demo session.",
  input: { name: input.text({ required: true }), mode: input.enum(["hosted", "connected"], { required: true }), brief: input.text(), sponsor_id: input.int({ required: true }), space_ids: input.list(input.int()), role: input.text() },
  stack: [...caller(), s.function.run({ fn: createAgent, as: "made", input: { ...who(), name: inp("name"), mode: inp("mode"), brief: inp("brief"), sponsor_id: inp("sponsor_id"), space_ids: inp("space_ids"), role: inp("role") } })],
  response: ref("made"),
  responseShape: {} as { id: number },
});

export const updateAgentRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "team-agents/{agent_id}", verb: "PATCH",
  description: "Change an agent's brief or how it works. Admins only.",
  input: { agent_id: input.int({ required: true }), brief: input.text(), mode: input.text(), role: input.text() },
  stack: [...caller(), s.function.run({ fn: updateAgent, as: "saved", input: { ...who(), agent_id: inp("agent_id"), brief: inp("brief"), mode: inp("mode"), role: inp("role") } })],
  response: ref("saved"),
  responseShape: {} as { id: number; brief: string; mode: "hosted" | "connected" },
});

export const agentSpacesRoute = query({
  // Leaving a space ends a run there, and a run can mint a token, so nothing of this request is kept.
  apiGroup: agentsGroup, auth: user, history: false,
  name: "team-agents/{agent_id}/spaces", verb: "PUT",
  description: "Set the spaces an agent is in. Admins only.",
  input: { agent_id: input.int({ required: true }), space_ids: input.list(input.int()) },
  stack: [...caller(), s.function.run({ fn: setAgentSpaces, as: "set", input: { ...who(), agent_id: inp("agent_id"), space_ids: inp("space_ids") } })],
  response: ref("set"),
  responseShape: {} as { id: number; space_ids: number[] },
});

export const changeSponsorRoute = query({
  // Moving what it waits on can close an approval, which starts a run again, and a run mints a token: nothing of this is kept.
  apiGroup: agentsGroup, auth: user, history: false,
  name: "team-agents/{agent_id}/sponsor", verb: "POST",
  description: "Hand an agent to a new sponsor. Its keys end, and what it's waiting on moves to them. Admins only.",
  input: { agent_id: input.int({ required: true }), sponsor_id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: changeSponsor, as: "moved", input: { ...who(), agent_id: inp("agent_id"), sponsor_id: inp("sponsor_id") } })],
  response: ref("moved"),
  responseShape: {} as { id: number; sponsor_id: number; revoked: number },
});

export const reviveAgentRoute = query({
  apiGroup: agentsGroup, auth: user,
  name: "team-agents/{agent_id}/revive", verb: "POST",
  description: "Turn a stopped agent back on with a new sponsor. Admins only.",
  input: { agent_id: input.int({ required: true }), sponsor_id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: reviveAgent, as: "revived", input: { ...who(), agent_id: inp("agent_id"), sponsor_id: inp("sponsor_id") } })],
  response: ref("revived"),
  responseShape: {} as { id: number; status: "active"; sponsor_id: number },
});

export const agentQueries = [agentProfileRoute, agentRunsRoute, runStepsRoute, pickupsRoute, agentMentionCheckRoute, sponsorChoicesRoute, createAgentRoute, updateAgentRoute, agentSpacesRoute, changeSponsorRoute, reviveAgentRoute, hostedAgentsRoute, pauseAgentsRoute, connectedAgentsRoute, listRunsRoute, stopRunRoute, retryRunRoute, approvalRoute, recordApprovalsRoute, overseenApprovalsRoute, listKeysRoute, mintKeyRoute, rotateKeyRoute, revokeKeyRoute, executeRun];
export const agentGroups = [agentsGroup, loopGroup];
