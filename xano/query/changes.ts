// The catch-up read. Frames are fire-and-forget, so a client that saw a gap, reconnected or came back to the tab asks what
// it missed, by sequence number, on a channel it may follow.
import { apiGroup, auth, inp, input, query, ref, s } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { gateActive } from "../function/members/gate.js";
import { bindBrowser } from "../function/access/reach.js";
import { readChanges } from "../function/links/changes.js";

export const changesGroup = apiGroup({ name: "changes", canonical: "changes", middleware: { pre: [gateActive] }, description: "What changed on a live channel since a sequence number." });

export type ChangeEntry = { seq: number; entity: string; entity_id: number; op: string; actor_id: number; at: number };

/** GET changes: entries after `after`, oldest first. A negative `after` asks only where the channel is now. */
export const listChanges = query({
  apiGroup: changesGroup, auth: user,
  name: "changes", verb: "GET",
  description: "What changed on a channel you follow, after a sequence number.",
  input: { channel: input.text({ required: true }), after: input.int() },
  stack: [...rbac.signedIn(), ...bindBrowser(), s.function.run({ fn: readChanges, as: "changes", input: { actor_id: auth("id"), browser: ref("browser"), channel: inp("channel"), after: inp("after") } })],
  response: ref("changes"),
  responseShape: {} as { channel: string; seq: number; items: ChangeEntry[] },
});

export const changeQueries = [listChanges];
