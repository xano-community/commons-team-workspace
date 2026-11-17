// A record's runs, and Stop and Retry. Everything here loads with the screens that show a run, not with the shell.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentKey, AgentMentionCheck, AgentProfile, AgentRun, AgentRunList, ApprovalView, ConnectedAgents, HostedAgents, Pickups, RunList, RunSteps } from "../../../../xano/query/agents.js";
import { routePath } from "../../../../xano/routes.gen.js";
import { ApiError, qs, request } from "@/base/request";
import { useEntityQuery, applyEntityEvent } from "@/lib/data";
import { shellToast } from "@/lib/toast";
import { pollEvery, queuedStandIn } from "./model";

const EMPTY: AgentRun[] = [];

/** `where` is one conversation, one task or one doc. The cache key starts with the entity, so a live frame refreshes it. */
export function useRuns(where: { conversation_id: number } | { task_id: number } | { doc_id: number }) {
  const list = useQuery({
    queryKey: ["agent_run", where],
    queryFn: () => request<RunList>("GET", routePath("GET agent-runs") + qs(where)),
    refetchInterval: (q) => pollEvery(q.state.data?.items),
  });
  return { runs: list.data?.items ?? EMPTY, modelReady: list.data?.model_ready ?? true, keyName: list.data?.key_name ?? "", loaded: !!list.data };
}

/** Long enough to read, however fast the run starts. */
const HOLD_QUEUED_MS = 800;

/**
 * The run a task shows. When someone on the screen gives the task to a hosted agent, it reads Queued at once: the row is a
 * round trip away, and a fast run has moved on by the time it's read, so a person would never see where it started.
 */
export function useTaskRun(id: number, assignee: { id: number; name: string } | null, me: number, guest: boolean) {
  const { runs, modelReady, keyName, loaded } = useRuns({ task_id: id });
  const hosted = useHostedAgents();
  const [held, setHeld] = useState(false);
  const last = useRef(assignee?.id);
  useEffect(() => {
    const before = last.current;
    last.current = assignee?.id;
    if (before === undefined && !assignee) return;
    // A guest's assignment starts nothing, so nothing should say it did.
    if (guest || before === assignee?.id || !hosted.data?.items.some((a) => a.id === assignee?.id)) return;
    setHeld(true);
    const free = setTimeout(() => setHeld(false), HOLD_QUEUED_MS);
    return () => clearTimeout(free);
  }, [assignee?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return { run: held && assignee ? queuedStandIn(assignee, me) : runs[0], modelReady, keyName, loaded };
}

export const useHostedAgents = () => useEntityQuery("agent_run", ["hosted"], () => request<HostedAgents>("GET", routePath("GET agents/hosted")));

/** Pause all agents, or turn them back on. */
export function usePauseAgents() {
  const client = useQueryClient();
  return (paused: boolean) => request<{ paused: boolean }>("POST", routePath("POST agents/pause"), { paused }).then(
    () => client.invalidateQueries({ queryKey: ["agent_run"] }),
    (e: Error) => { shellToast.error(e.message || "Couldn't change that. Try again."); },
  );
}

/** Stop and Retry. Each answers with the run, and that answer goes straight into every list holding it. */
export function useRunActions() {
  const client = useQueryClient();
  return useMemo(() => {
    const act = (path: string, failed: string) => request<AgentRun>("POST", path, {}).then(
      (run) => applyEntityEvent(client, { type: "remote", entity: "agent_run", id: null }) ?? run,
      (e: unknown) => shellToast.error(`${failed} ${e instanceof Error ? e.message : "Try again."}`),
    );
    return {
      stop: (id: number) => act(routePath("POST agent-runs/{id}/stop", { id }), "Couldn't stop that run."),
      retry: (id: number) => act(routePath("POST agent-runs/{id}/retry", { id }), "Couldn't start that run again."),
    };
  }, [client]);
}

export const useConnectedAgents = () => useEntityQuery("agent_run", ["connected"], () => request<ConnectedAgents>("GET", routePath("GET agents/connected")));

/** One approval's card. It's refetched by any change to this person's inbox, so a decision elsewhere lands here too. */
export const useApproval = (id: number) => useEntityQuery("approval", ["card", id], () => request<ApprovalView>("GET", routePath("GET agent-approvals/{id}", { id })));

/** What's waiting on a record, and on its thread. */
/** For an admin: what agents wait on someone else for, outside DMs, read-only. */
export const useOverseenApprovals = (enabled: boolean) => useEntityQuery("approval", ["overseen"], () => request<{ items: ApprovalView[] }>("GET", routePath("GET approvals-overseen")), { enabled });
/** The ids of what waits on the signed-in person, newest first, each read as a card with useApproval. */
export const usePendingApprovalIds = (enabled: boolean) => useApprovalIds("pending", enabled);
/** The ids of what waits on the signed-in person, or of what they've decided, newest first. */
export const useApprovalIds = (view: "pending" | "decided", enabled = true) =>
  useEntityQuery("approval", [`${view}-list`], () => request<{ items: { id: number }[] }>("GET", `${routePath("GET approvals")}?view=${view}`), { enabled });
export const useRecordApprovals = (type: string, id: number, threadId = 0) =>
  useEntityQuery("approval", ["record", type, id, threadId], () => request<{ items: ApprovalView[] }>("GET", routePath("GET agent-approvals") + qs({ type, id, thread_id: threadId })));

/** Approve or decline. It answers with what happened, and a refusal stays on the card for the person to read. */
export function useDecide() {
  const client = useQueryClient();
  return useMemo(() => {
    const settled = () => Promise.all([client.invalidateQueries({ queryKey: ["approval"] }), client.invalidateQueries({ queryKey: ["notification"] }), client.invalidateQueries({ queryKey: ["agent_run"] })]);
    return {
      approve: (id: number, edited?: string) => request<unknown>("POST", routePath("POST approvals/{id}/approve", { id }), edited === undefined ? {} : { edited }).finally(settled),
      decline: (id: number) => request<unknown>("POST", routePath("POST approvals/{id}/decline", { id }), {}).finally(settled),
    };
  }, [client]);
}

/** An empty list can come back from the engine as `{}`: every list read here goes through this. */
const list = <T,>(v: T[] | Record<string, never> | null | undefined): T[] => (Array.isArray(v) ? v : []);

/** One agent's page, and what this reader may do there. */
export const useAgentProfile = (id: number) => useQuery({ queryKey: ["user", "agent", id], queryFn: () => request<AgentProfile>("GET", routePath("GET team-agents/{agent_id}", { agent_id: id })).then((a) => ({ ...a, spaces: list(a.spaces) })), retry: (n, e) => n < 2 && !(e instanceof ApiError && e.status < 500) });

/** An agent's recent runs this reader may see, each with its record named for them. Live runs are polled too. */
export function useAgentRuns(id: number) {
  return useQuery({
    queryKey: ["agent_run", "of", id],
    queryFn: () => request<AgentRunList>("GET", routePath("GET team-agents/{agent_id}/runs", { agent_id: id })).then((r) => ({ items: list(r.items), records: list(r.records) })),
    refetchInterval: (q) => pollEvery(q.state.data?.items),
  });
}

/** A run's steps, read when someone opens them. */
export const useRunSteps = (id: number, open: boolean) => useQuery({
  queryKey: ["agent_run", "steps", id],
  queryFn: () => request<RunSteps>("GET", routePath("GET agent-runs/{id}/steps", { id })),
  enabled: open && id > 0,
  staleTime: 30_000,
});

/** Whether connected agents have picked up what this task or conversation asked of them. Checked now and then, since nothing announces it. */
export const usePickups = (type: "task" | "conversation", id: number, enabled: boolean) => useQuery({
  queryKey: ["notification", "pickups", type, id],
  queryFn: () => request<Pickups>("GET", routePath("GET agent-pickups") + qs({ type, id })).then((r) => ({ items: list(r.items) })),
  enabled: enabled && id > 0,
  refetchInterval: (q) => (q.state.data?.items.some((i) => !i.read_at) ? 30_000 : false),
});

/** The people an admin can make a sponsor. */
export const useSponsorChoices = (enabled: boolean) => useQuery({
  queryKey: ["user", "sponsors"],
  queryFn: () => request<{ id: number; name: string }[]>("GET", routePath("GET agent-sponsors")),
  enabled,
});

/** What an admin changes about an agent. Each answers once it's done, and every screen showing that agent reads it again. */
export function useManageAgent() {
  const client = useQueryClient();
  return useMemo(() => {
    const settle = <T,>(p: Promise<T>) => p.finally(() => Promise.all([client.invalidateQueries({ queryKey: ["user"] }), client.invalidateQueries({ queryKey: ["agent_run"] }), client.invalidateQueries({ queryKey: ["space"] })]));
    return {
      create: (body: { name: string; mode: "hosted" | "connected"; brief: string; sponsor_id: number; space_ids: number[] }) => settle(request<{ id: number }>("POST", routePath("POST team-agents"), body)),
      update: (id: number, body: { brief?: string; mode?: "hosted" | "connected" }) => settle(request<{ id: number }>("PATCH", routePath("PATCH team-agents/{agent_id}", { agent_id: id }), body)),
      setSpaces: (id: number, space_ids: number[]) => settle(request<{ id: number; space_ids: number[] }>("PUT", routePath("PUT team-agents/{agent_id}/spaces", { agent_id: id }), { space_ids })),
      sponsor: (id: number, sponsor_id: number) => settle(request<{ revoked: number }>("POST", routePath("POST team-agents/{agent_id}/sponsor", { agent_id: id }), { sponsor_id })),
      revive: (id: number, sponsor_id: number) => settle(request<{ id: number }>("POST", routePath("POST team-agents/{agent_id}/revive", { agent_id: id }), { sponsor_id })),
    };
  }, [client]);
}

/** A connected agent's keys: list, make (the token shows once), and revoke. */
export const useAgentKeys = (id: number, enabled: boolean) => useQuery({
  queryKey: ["user", "keys", id],
  queryFn: () => request<{ items: AgentKey[] }>("GET", routePath("GET agents/{agent_id}/keys", { agent_id: id })).then((r) => ({ items: list(r.items) })),
  enabled,
});
export function useKeyActions(id: number) {
  const client = useQueryClient();
  return useMemo(() => {
    const settle = <T,>(p: Promise<T>) => p.finally(() => client.invalidateQueries({ queryKey: ["user"] }));
    return {
      make: (name: string, scope: "read" | "read_write", days: number) => settle(request<{ key: AgentKey; token: string }>("POST", routePath("POST agents/{agent_id}/keys", { agent_id: id }), { name, scope, days })),
      revoke: (keyId: number) => settle(request<{ id: number }>("POST", routePath("POST agents/{agent_id}/keys/{key_id}/revoke", { agent_id: id, key_id: keyId }), {})),
    };
  }, [client, id]);
}

/** Which agents a draft names that can't hear it here, and who may add them. */
export const useAgentMentionCheck = (conversationId: number, agentIds: number[]) => useQuery({
  queryKey: ["agent-mention-check", conversationId, agentIds.join(",")],
  queryFn: () => request<AgentMentionCheck>("POST", routePath("POST agent-mention-check"), { conversation_id: conversationId, agent_ids: agentIds }).then((r) => ({ ...r, missing: list(r.missing), managers: list(r.managers) })),
  enabled: conversationId > 0 && agentIds.length > 0,
  staleTime: 0,
});
