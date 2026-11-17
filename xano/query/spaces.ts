// Spaces and channels, and who's in them. Every read goes through the access rule, and answers not found when it says
// no, so nobody can tell a space they can't reach from one that doesn't exist.
import { apiGroup, auth, c, cmp, col, expr, guard, inp, input, or, query, ref, s } from "@xano/sdk";
import type { InferRow } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { space } from "../table/spaces/space.js";
import { space_member } from "../table/spaces/space_member.js";
import { conversation } from "../table/messaging/conversation.js";
import { gateActive } from "../function/members/gate.js";
import { bindBrowser, canCreate, canManage, inReachedSpaces, reachOf, requireReach } from "../function/access/reach.js";
import { listConversationsFn } from "../function/messaging/conversations.js";
import { addSpaceMember, createSpace, joinSpace, removeSpaceMember, setSpaceRole, updateSpace } from "../function/access/spaces.js";

export const spacesGroup = apiGroup({ name: "spaces", canonical: "spaces", middleware: { pre: [gateActive] }, description: "Spaces, their members and their channels." });

type Space = InferRow<typeof space>;
const caller = () => [...rbac.signedIn(), ...bindBrowser()];

/** GET spaces: what the caller reaches, and, for people who can join, the open spaces they haven't. */
export const listSpaces = query({
  apiGroup: spacesGroup, auth: user,
  name: "spaces", verb: "GET",
  description: "The spaces you're in or oversee, plus the open spaces you could join.",
  stack: [
    ...caller(),
    reachOf(auth("id"), ref("browser")),
    s.conditional({
      when: expr(ref("me.role"), "=", c.text("guest")),
      then: [s.db.query({ table: space, where: inReachedSpaces("id"), sort: [{ sortBy: "name", dir: "asc" }], as: "rows" })],
      else: [s.conditional({
        when: expr(ref("browser"), "=", c.bool(true)),
        then: [s.db.query({ table: space, where: or(inReachedSpaces("id"), cmp(col("visibility"), "=", c.text("open"))), sort: [{ sortBy: "name", dir: "asc" }], as: "rows" })],
        else: [s.db.query({ table: space, where: inReachedSpaces("id"), sort: [{ sortBy: "name", dir: "asc" }], as: "rows" })],
      })],
    }),
    s.db.query({ table: space_member, where: cmp(col("user_id"), "=", auth("id")), output: ["space_id", "role"], as: "mine" }),
  ],
  response: { spaces: ref("rows"), memberships: ref("mine") },
  responseShape: {} as { spaces: Space[]; memberships: { space_id: number; role: "manager" | "member" }[] },
});

/** POST spaces: start a space. Its creator manages it. */
export const createSpaceRoute = query({
  apiGroup: spacesGroup, auth: user,
  name: "spaces", verb: "POST",
  description: "Create a space.",
  input: { name: input.text({ required: true }), visibility: input.enum(["open", "private"], { required: true }), guests_can_create: input.bool() },
  stack: [
    ...caller(),
    s.function.run({ fn: createSpace, as: "made", input: { actor_id: auth("id"), browser: ref("browser"), name: inp("name"), visibility: inp("visibility"), guests_can_create: inp("guests_can_create") } }),
  ],
  response: ref("made"),
  responseShape: {} as Space,
});

/** GET spaces/{id}: one space, and what the caller may do in it. */
export const getSpace = query({
  apiGroup: spacesGroup, auth: user,
  name: "spaces/{id}", verb: "GET",
  description: "One space you can reach.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...caller(),
    ...requireReach({ actor: auth("id"), browser: ref("browser"), type: "space", id: inp("id") }),
    s.db.get({ table: space, fieldValue: inp("id"), as: "row" }),
    s.function.run({ fn: canManage, as: "can_manage", input: { actor_id: auth("id"), browser: ref("browser"), space_id: inp("id") } }),
    s.function.run({ fn: canCreate, as: "can_create", input: { actor_id: auth("id"), browser: ref("browser"), space_id: inp("id") } }),
  ],
  response: { space: ref("row"), can_manage: ref("can_manage"), can_create: ref("can_create") },
  responseShape: {} as { space: Space; can_manage: boolean; can_create: boolean },
});

/** PATCH spaces/{id}: the whole of a space's settings. `archived` makes it read-only; spaces are never deleted. */
export const updateSpaceRoute = query({
  apiGroup: spacesGroup, auth: user,
  name: "spaces/{id}", verb: "PATCH",
  description: "Change a space's settings, or archive it. Its managers and admins.",
  input: { id: input.int({ required: true }), name: input.text({ required: true }), visibility: input.enum(["open", "private"], { required: true }), guests_can_create: input.bool(), archived: input.bool() },
  stack: [
    ...caller(),
    s.function.run({ fn: updateSpace, as: "row", input: { actor_id: auth("id"), browser: ref("browser"), space_id: inp("id"), name: inp("name"), visibility: inp("visibility"), guests_can_create: inp("guests_can_create"), archived: inp("archived") } }),
  ],
  response: ref("row"),
  responseShape: {} as Space,
});

/** GET spaces/{id}/members: who's in a space. Reaching it is what lets a guest see these people. */
export const listSpaceMembers = query({
  apiGroup: spacesGroup, auth: user,
  name: "spaces/{id}/members", verb: "GET",
  description: "Who's in a space you can reach.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...caller(),
    ...requireReach({ actor: auth("id"), browser: ref("browser"), type: "space", id: inp("id") }),
    s.db.query({ table: space_member, where: cmp(col("space_id"), "=", inp("id")), output: ["user_id", "role"], as: "rows" }),
    s.array.map({ source: ref("rows"), as: "ids", transform: ref("$this.user_id") }),
    s.db.query({ table: user, where: cmp(col("id"), "in", ref("ids")), sort: [{ sortBy: "name", dir: "asc" }], output: ["id", "name", "role", "kind", "status"], as: "people" }),
  ],
  response: { members: ref("rows"), people: ref("people") },
  responseShape: {} as { members: { user_id: number; role: "manager" | "member" }[]; people: { id: number; name: string; role: string; kind: "human" | "agent"; status: string }[] },
});

/** POST spaces/{id}/members: add someone. A guest needs `history_ok`: without it, nothing changes and `warning` says why. */
export const addSpaceMemberRoute = query({
  apiGroup: spacesGroup, auth: user,
  name: "spaces/{id}/members", verb: "POST",
  description: "Add a person or agent to a space. Its managers and admins.",
  input: { id: input.int({ required: true }), user_id: input.int({ required: true }), history_ok: input.bool() },
  stack: [
    ...caller(),
    s.function.run({ fn: addSpaceMember, as: "result", input: { actor_id: auth("id"), browser: ref("browser"), space_id: inp("id"), user_id: inp("user_id"), history_ok: inp("history_ok") } }),
  ],
  response: ref("result"),
  responseShape: {} as { added: boolean; warning: string | null },
});

/** POST spaces/{id}/join: join an open space. */
export const joinSpaceRoute = query({
  apiGroup: spacesGroup, auth: user,
  name: "spaces/{id}/join", verb: "POST",
  description: "Join an open space.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...caller(),
    s.function.run({ fn: joinSpace, as: "result", input: { actor_id: auth("id"), browser: ref("browser"), space_id: inp("id") } }),
  ],
  response: ref("result"),
  responseShape: {} as { joined: boolean },
});

/** PATCH spaces/{id}/members/{user_id}: hand a space over. */
export const setSpaceRoleRoute = query({
  apiGroup: spacesGroup, auth: user,
  name: "spaces/{id}/members/{user_id}", verb: "PATCH",
  description: "Make a member a manager, or a manager a member.",
  input: { id: input.int({ required: true }), user_id: input.int({ required: true }), role: input.enum(["manager", "member"], { required: true }) },
  stack: [
    ...caller(),
    s.function.run({ fn: setSpaceRole, as: "result", input: { actor_id: auth("id"), browser: ref("browser"), space_id: inp("id"), user_id: inp("user_id"), role: inp("role") } }),
  ],
  response: ref("result"),
  responseShape: {} as { user_id: number; role: "manager" | "member" },
});

/** POST spaces/{id}/members/{user_id}/remove: remove someone, or leave with your own id. */
export const removeSpaceMemberRoute = query({
  apiGroup: spacesGroup, auth: user,
  // It can close an approval, which starts a run again, and a run mints a token, so nothing of this request is kept.
  history: false,
  name: "spaces/{id}/members/{user_id}/remove", verb: "POST",
  description: "Remove someone from a space, or leave it.",
  input: { id: input.int({ required: true }), user_id: input.int({ required: true }) },
  stack: [
    ...caller(),
    s.function.run({ fn: removeSpaceMember, as: "result", input: { actor_id: auth("id"), browser: ref("browser"), space_id: inp("id"), user_id: inp("user_id") } }),
  ],
  response: ref("result"),
  responseShape: {} as { removed: boolean; kick_failed: boolean },
});

/** GET conversations: every channel in a reached space, and the caller's own DMs. */
export const listConversations = query({
  apiGroup: spacesGroup, auth: user,
  name: "conversations", verb: "GET",
  description: "The channels and DMs you can reach.",
  stack: [
    ...caller(),
    s.function.run({ fn: listConversationsFn, as: "rows", input: { actor_id: auth("id"), browser: ref("browser") } }),
  ],
  response: ref("rows"),
  responseShape: [] as (InferRow<typeof conversation> & { last_read_seq: number; unread: number; mentions: number; members: { user_id: number; name: string; kind: "human" | "agent"; status: string }[] })[],
});

/** GET conversations/{id}: one channel or DM. */
export const getConversation = query({
  apiGroup: spacesGroup, auth: user,
  name: "conversations/{id}", verb: "GET",
  description: "One channel or DM you can reach.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...caller(),
    ...requireReach({ actor: auth("id"), browser: ref("browser"), type: "conversation", id: inp("id") }),
    s.db.get({ table: conversation, fieldValue: inp("id"), as: "row" }),
    guard.found("row", { message: "Not found." }),
  ],
  response: ref("row"),
  responseShape: {} as InferRow<typeof conversation>,
});

export const spaceQueries = [listSpaces, createSpaceRoute, getSpace, updateSpaceRoute, listSpaceMembers, addSpaceMemberRoute, joinSpaceRoute, setSpaceRoleRoute, removeSpaceMemberRoute, listConversations, getConversation];
