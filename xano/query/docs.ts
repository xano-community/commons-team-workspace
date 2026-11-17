// Docs over HTTP, beside the module's own routes: starting a doc in a space, finding one, and everything around a doc's body.
import { apiGroup, auth, inp, input, query, ref, s } from "@xano/sdk";
import type { InferRow } from "@xano/sdk";
import { docs } from "../docs.js";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { doc_suggestion } from "../table/docs/doc_suggestion.js";
import { gateActive } from "../function/members/gate.js";
import { bindBrowser } from "../function/access/reach.js";
import { readRecordItems } from "../function/inbox/read.js";
import { createDoc, docContext, listDocs, markEditing, searchDocs } from "../function/docs/docs.js";
import { decideSuggestion, yieldDoc } from "../function/docs/suggestions.js";

export const docToolsGroup = apiGroup({ name: "doc-tools", canonical: "doc-tools", middleware: { pre: [gateActive] }, description: "Docs in their spaces: lists, suggestions, and who's working." });

type Suggestion = InferRow<typeof doc_suggestion>;
type MemberKind = "human" | "agent";
export type DocRow = InferRow<typeof docs.doc>;
export type DocListItem = { id: number; title: string; excerpt: string; space_id: number; space_name: string; owner_id: number; owner_name: string | null; owner_kind: MemberKind | null; last_edited_by: number; editor_name: string | null; editor_kind: MemberKind | null; updated_at: number; deleted_at: number | null; suggestions: boolean; comments: number };
export type DocPage = { items: DocListItem[]; ever: number; page: number; next_page: number | null; total: number };
export type DocSuggestion = Pick<Suggestion, "id" | "doc_id" | "agent_id" | "run_id" | "base_version" | "find" | "text" | "note" | "created_at"> & { agent_name: string; blocks: unknown[]; text_changed: boolean };
export type DocApplied = { id: number; agent_id: number; agent_name: string; note: string; decided_at: number };
export type DocContext = { id: number; space_id: number; space_name: string; archived: boolean; can_edit: boolean; owner_id: number; owner_name: string | null; owner_kind: MemberKind | null; editor_id: number; editor_kind: MemberKind | null; thread_id: number; suggestions: DocSuggestion[]; applied: DocApplied[];
  /** The project of the first task the doc links to in its space, for the breadcrumb. 0 and null when there isn't one. */
  project_id: number; project_name: string | null };
export type DocDecision = { status: Suggestion["status"]; changed: boolean; text_changed: boolean };

const caller = () => [...rbac.signedIn(), ...bindBrowser()];
const who = () => ({ actor_id: auth("id"), browser: ref("browser") });

export const listDocsRoute = query({
  apiGroup: docToolsGroup, auth: user,
  name: "doc-list", verb: "GET",
  description: "The docs you reach, in one space or all of them, newest work first.",
  input: { space_id: input.int(), q: input.text({ methods: ["trim"] }), trash: input.bool(), page: input.int() },
  stack: [...caller(), s.function.run({ fn: listDocs, as: "list", input: { ...who(), space_id: inp("space_id"), q: inp("q"), trash: inp("trash"), page: inp("page") } })],
  response: ref("list"),
  responseShape: {} as DocPage,
});

export const searchDocsRoute = query({
  apiGroup: docToolsGroup, auth: user,
  name: "doc-search", verb: "GET",
  description: "Docs you reach whose title matches.",
  input: { q: input.text({ methods: ["trim"] }) },
  stack: [...caller(), s.function.run({ fn: searchDocs, as: "found", input: { ...who(), q: inp("q") } })],
  response: ref("found"),
  responseShape: [] as { id: number; title: string; space_name: string }[],
});

export const createDocRoute = query({
  apiGroup: docToolsGroup, auth: user,
  name: "doc-create", verb: "POST",
  // It can reach a run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Start a doc in a space.",
  input: { space_id: input.int({ required: true }), title: input.text(), body: input.json() },
  stack: [...caller(), s.function.run({ fn: createDoc, as: "doc", input: { ...who(), space_id: inp("space_id"), title: inp("title"), body: inp("body") } })],
  response: ref("doc"),
  responseShape: {} as DocRow,
});

export const docContextRoute = query({
  apiGroup: docToolsGroup, auth: user,
  name: "doc-context/{id}", verb: "GET",
  description: "Where a doc lives, what you may do with it, and the agent changes around it.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: docContext, as: "context", input: { ...who(), id: inp("id") } })],
  response: ref("context"),
  responseShape: {} as DocContext,
});

export const docEditingRoute = query({
  apiGroup: docToolsGroup, auth: user,
  name: "doc-editing/{id}", verb: "POST",
  description: "Say you're typing in a doc, so an agent's change waits for you.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: markEditing, as: "marked", input: { ...who(), id: inp("id") } })],
  response: ref("marked"),
  responseShape: {} as { ok: boolean },
});

export const readDocRoute = query({
  apiGroup: docToolsGroup, auth: user,
  name: "doc-read/{id}", verb: "POST",
  description: "Say you've opened a doc.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: readRecordItems, as: "read", input: { ...who(), entity: "doc", entity_id: inp("id") } })],
  response: ref("read"),
  responseShape: {} as { read: number },
});

export const decideSuggestionRoute = query({
  apiGroup: docToolsGroup, auth: user,
  name: "doc-suggestions/{id}/decide", verb: "POST",
  // It can reach a run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Apply or dismiss an agent's change.",
  input: { id: input.int({ required: true }), decision: input.enum(["apply", "dismiss", "reopen"], { required: true }) },
  stack: [...caller(), s.function.run({ fn: decideSuggestion, as: "decided", input: { ...who(), id: inp("id"), decision: inp("decision") } })],
  response: ref("decided"),
  responseShape: {} as DocDecision,
});

export const yieldDocRoute = query({
  apiGroup: docToolsGroup, auth: user,
  name: "doc-yield/{id}", verb: "POST",
  // It can reach a run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Your save lost to an agent's edit: turn that edit back into a suggestion.",
  input: { id: input.int({ required: true }), base_version: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: yieldDoc, as: "yielded", input: { ...who(), id: inp("id"), base_version: inp("base_version") } })],
  response: ref("yielded"),
  responseShape: {} as { yielded: boolean; version: number },
});

export const docQueries = [listDocsRoute, searchDocsRoute, createDocRoute, docContextRoute, docEditingRoute, readDocRoute, decideSuggestionRoute, yieldDocRoute];
