// Search over HTTP. Who may see what is decided in the query, in search/find, and never here.
import { apiGroup, auth, inp, input, query, ref, s } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { gateActive } from "../function/members/gate.js";
import { bindBrowser } from "../function/access/reach.js";
import { findRecords } from "../function/search/search.js";
import { readOverview } from "../function/search/overview.js";

export const searchGroup = apiGroup({ name: "search", canonical: "search", middleware: { pre: [gateActive] }, description: "Finding records across the tools." });

export type SearchHit = { key: string; entity: string; entity_id: number; title: string; body: string; href: string; scope: string; changed_at: number; place: string | null; place_kind: string | null };
export type SearchPage = { items: SearchHit[]; total: number };

export const searchRoute = query({
  apiGroup: searchGroup, auth: user,
  name: "search", verb: "GET",
  description: "Find records across chat, tasks, docs, customers and files, among the ones you can reach.",
  input: { q: input.text() },
  stack: [...rbac.signedIn(), ...bindBrowser(), s.function.run({ fn: findRecords, as: "page", input: { actor_id: auth("id"), browser: ref("browser"), q: inp("q") } })],
  response: ref("page"),
  responseShape: {} as SearchPage,
});

export type OverviewTask = { id: number; title: string; status: string; priority: string; due_on: string | null };
export type OverviewRun = { id: number; status: string; last_note: string; thread_id: number; conversation_id: number; created_at: number; finished_at: number | null; agent_name: string | null };
export type Overview = {
  tasks: { open: number; late: number; items: OverviewTask[] };
  agents: { active: number; items: OverviewRun[] };
  started: { message: number; task: number; doc: number; file: number; agent: number; people: number };
  spaces: number;
};

export const overviewRoute = query({
  apiGroup: searchGroup, auth: user,
  name: "overview", verb: "GET",
  description: "What needs you, the agent work you can see, and which first steps you've taken. `today` is your calendar day, YYYY-MM-DD.",
  input: { today: input.text({ methods: ["trim"] }) },
  stack: [...rbac.signedIn(), ...bindBrowser(), s.function.run({ fn: readOverview, as: "overview", input: { actor_id: auth("id"), browser: ref("browser"), today: inp("today") } })],
  response: ref("overview"),
  responseShape: {} as Overview,
});

export const searchQueries = [searchRoute, overviewRoute];
