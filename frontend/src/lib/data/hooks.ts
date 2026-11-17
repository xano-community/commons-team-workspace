// How a screen reads and writes records. Reads come from the in-memory cache and refresh quietly; writes go through the
// outbox, so a rollback, a held write and a live event all land the same way.
import { useCallback, useMemo } from "react";
import { keepPreviousData, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { request } from "@/base/request";
import { perf } from "@/lib/perf";
import { shellToast } from "@/lib/toast";
import { withPending } from "./entities";
import { flushOutbox, sendWrite, type OutboxDeps, type Write } from "./outbox";

/**
 * `useEntityQuery("task", [{ project }], () => api.tasks(project))`. The key is `[entity, ...rest]`, which is how a
 * change to that entity finds this query. Old data stays on screen while new data loads.
 */
export function useEntityQuery<T>(entity: string, rest: QueryKey, fetch: () => Promise<T>, opts: { enabled?: boolean; refetchInterval?: number; refetchOnMount?: boolean | "always" } = {}) {
  const client = useQueryClient();
  return useQuery({
    queryKey: [entity, ...rest],
    queryFn: async () => withPending(client, entity, await fetch()),
    placeholderData: keepPreviousData,
    ...opts,
  });
}

function useOutboxDeps(): OutboxDeps {
  const client = useQueryClient();
  return useMemo(() => ({ client, request, notifyFailure: shellToast.error }), [client]);
}

/** `const write = useWrite(me.id); write({ label: "mark this read", verb, path, changes })`. */
export function useWrite(userId: number) {
  const deps = useOutboxDeps();
  return useCallback((w: Write) => {
    perf.start("optimistic");
    const sent = sendWrite(userId, w, deps);
    perf.endAfterPaint("optimistic");
    return sent;
  }, [userId, deps]);
}

/** Sends what's held: on sign-in, after a 401 is answered, and when the connection returns. */
export function useFlushOutbox(userId: number) {
  const deps = useOutboxDeps();
  return useCallback(() => flushOutbox(userId, deps), [userId, deps]);
}
