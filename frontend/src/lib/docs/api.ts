// Docs over HTTP, beside the module's own client: paths and types from the backend. No editor comes in here: the shell's ⌘K reads this.
import type { DocApplied, DocContext, DocDecision, DocListItem, DocPage, DocRow, DocSuggestion } from "../../../../xano/query/docs.js";
import { routePath } from "../../../../xano/routes.gen.js";
import { qs, request } from "@/base/request";

export type { DocApplied, DocContext, DocListItem, DocPage, DocRow, DocSuggestion };

export const docsApi = {
  list: (q: { space_id?: number; q?: string; trash?: boolean; page?: number }) => request<DocPage>("GET", routePath("GET doc-list") + qs(q)),
  search: (q: string) => request<{ id: number; title: string; space_name: string }[]>("GET", `${routePath("GET doc-search")}?q=${encodeURIComponent(q)}`),
  create: (space_id: number, title = "") => request<DocRow>("POST", routePath("POST doc-create"), { space_id, title }),
  context: (id: number) => request<DocContext>("GET", routePath("GET doc-context/{id}", { id })),
  editing: (id: number) => request<{ ok: boolean }>("POST", routePath("POST doc-editing/{id}", { id }), {}),
  read: (id: number) => request<{ read: number }>("POST", routePath("POST doc-read/{id}", { id }), {}),
  decide: (id: number, decision: "apply" | "dismiss" | "reopen") => request<DocDecision>("POST", routePath("POST doc-suggestions/{id}/decide", { id }), { decision }),
  restore: (id: number) => request<DocRow>("POST", routePath("POST docs/{id}/undelete", { id }), {}),
  yieldTo: (id: number, base_version: number) => request<{ yielded: boolean; version: number }>("POST", routePath("POST doc-yield/{id}", { id }), { base_version }),
};
