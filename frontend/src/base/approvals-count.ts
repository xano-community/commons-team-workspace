// The sidebar's approvals count, from the shell's own request helper so the shell doesn't load the agents module for one
// number. Every 20 s, and at once when a live event says an approval changed.
import { routePath } from "../../../xano/routes.gen.js";
import { useEntityQuery } from "@/lib/data";
import { qs, request } from "./request";

type Page = { itemsTotal?: number; items: unknown[] };

export const pendingApprovalsKey = ["approval", "pending-count"];

export function usePendingApprovals(enabled: boolean): number {
  const { data } = useEntityQuery("approval", ["pending-count"], () => request<Page>("GET", routePath("GET approvals") + qs({ view: "pending" })), { enabled, refetchInterval: 20_000 });
  return data?.itemsTotal ?? data?.items.length ?? 0;
}
