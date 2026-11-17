// Links between records, and the warning a mention raises. A record's name reaches a viewer only through here, filtered
// for that viewer, so nothing that stores a link or a mention has to hold it.
import { apiGroup, auth, inp, input, query, ref, s } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { gateActive } from "../function/members/gate.js";
import { bindBrowser } from "../function/access/reach.js";
import { createLink, listLinks, mentionCheck, removeLink } from "../function/links/links.js";
import { resolveRecords } from "../function/links/records.js";

export const linksGroup = apiGroup({ name: "links", canonical: "links", middleware: { pre: [gateActive] }, description: "Links between records, and resolving a record's name for its viewer." });

export type RecordState = "live" | "locked" | "deleted" | "archived" | "tombstone";
/** One record as this viewer may see it. `title` and `href` are empty unless the state is live or archived. */
/** What a full row shows beside a live record's name. Empty for anything the viewer can't open. */
export type RecordDetail = { status?: string; priority?: string; due_on?: string | null; person_id?: number; updated_at?: number; kind?: string };
export type RecordView = { type: string; id: number; state: RecordState; title: string; href: string; can_restore: boolean; detail?: RecordDetail };
export type MentionCheck = { warn: boolean; missing: { id: number; name: string; kind: "human" | "agent" }[]; add: { space_id: number; user_ids: number[] }[] };

const caller = () => [...rbac.signedIn(), ...bindBrowser()];
const who = () => ({ actor_id: auth("id"), browser: ref("browser") });

/** POST links/resolve: the one batch read behind every chip. */
export const resolveLinks = query({
  apiGroup: linksGroup, auth: user,
  name: "links/resolve", verb: "POST",
  description: "What each of these records looks like to you. A record you can't reach comes back locked, with no title.",
  input: { items: input.json({ required: true }) },
  stack: [...caller(), s.function.run({ fn: resolveRecords, as: "records", input: { ...who(), items: inp("items") } })],
  response: ref("records"),
  responseShape: [] as RecordView[],
});

/** POST links/mention-check: who in the audience can't reach what's being mentioned, before it's sent. */
export const checkMention = query({
  apiGroup: linksGroup, auth: user,
  name: "links/mention-check", verb: "POST",
  description: "Whether mentioning these records here needs a warning, who it should name, and who the sender may add.",
  input: { audience_type: input.enum(["conversation", "space"], { required: true }), audience_id: input.int({ required: true }), records: input.json({ required: true }) },
  stack: [...caller(), s.function.run({ fn: mentionCheck, as: "check", input: { ...who(), audience_type: inp("audience_type"), audience_id: inp("audience_id"), records: inp("records") } })],
  response: ref("check"),
  responseShape: {} as MentionCheck,
});

/** GET links: what a record links to, and what links to it. Backlinks are filtered before they're counted. */
export const getLinks = query({
  apiGroup: linksGroup, auth: user,
  name: "links", verb: "GET",
  description: "Both sides of one record's links.",
  input: { type: input.text({ required: true }), id: input.int({ required: true }), page: input.int() },
  stack: [...caller(), s.function.run({ fn: listLinks, as: "links", input: { ...who(), type: inp("type"), id: inp("id"), page: inp("page") } })],
  response: ref("links"),
  responseShape: {} as { forward: (RecordView & { link_id: number })[]; backlinks: (RecordView & { link_id: number })[]; backlinks_total: number; next_page: number | null },
});

/** POST links: link one record to another by hand. Reaching both is required, and anything else answers not found. */
export const addLink = query({
  apiGroup: linksGroup, auth: user,
  name: "links", verb: "POST",
  description: "Link one record to another.",
  input: { from_type: input.text({ required: true }), from_id: input.int({ required: true }), to_type: input.text({ required: true }), to_id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: createLink, as: "link", input: { ...who(), from_type: inp("from_type"), from_id: inp("from_id"), to_type: inp("to_type"), to_id: inp("to_id") } })],
  response: ref("link"),
  responseShape: {} as { id: number },
});

/** DELETE links/{id}: take a link away. Anyone who reaches both ends may. */
export const dropLink = query({
  apiGroup: linksGroup, auth: user,
  name: "links/{id}", verb: "DELETE",
  description: "Remove a link.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: removeLink, as: "dropped", input: { ...who(), id: inp("id") } })],
  response: ref("dropped"),
  responseShape: {} as { removed: boolean },
});

export const linkQueries = [resolveLinks, checkMention, getLinks, addLink, dropLink];
