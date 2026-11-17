// How a doc's screens read. Each query's key starts with `doc`, so the space's frames refresh a list and a doc's surroundings,
// and an autosave, which goes only to the doc's own tabs, refreshes neither.
import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLive } from "@/base/live";
import { useRuns } from "@/lib/agents/client";
import { useEntityQuery } from "@/lib/data";
import { docsApi } from "./api";
import { liveRun } from "./model";

export const useDocList = (q: { space_id?: number; q?: string; trash?: boolean; page?: number }) => useEntityQuery("doc", ["list", q], () => docsApi.list(q), { refetchOnMount: "always" });

export function useDocContext(id: number) {
  const client = useQueryClient();
  const context = useEntityQuery("doc", ["context", id], () => docsApi.context(id), { refetchOnMount: "always" });
  useLive(["doc_suggestion", "space", "space_member"], () => void client.invalidateQueries({ queryKey: ["doc", "context", id] }));
  return context;
}

/** The run a doc's header marks, from the runs on that doc. */
export function useDocRun(id: number) {
  const { runs, modelReady, keyName } = useRuns({ doc_id: id });
  return useMemo(() => ({ run: liveRun(runs), modelReady, keyName }), [runs, modelReady, keyName]);
}
