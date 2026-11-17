// Realtime: one server, six channels (BASELINE.md "Live"). Verified on the local engine (v0.1.19): the person's
// auth token is the websocket subprotocol, anonymous sockets are refused, and a person can join only their own
// users/{id} channel. Pushes come from app/changed and app/notify, which every write path calls.
//
// Why a function call and not a table trigger: on the local engine a `tableTrigger` runs but its
// `s.realtime.publish` never reaches a socket, while the same publish from an endpoint's stack (directly or
// through `s.function.run`) does. So writes call `changed(...)` (functions.ts), and audit-bundle.mjs checks
// that every endpoint and tool that writes a domain table does.
import { user } from "../table/user.js";
import { accessRule, canJoinRoom, canReach } from "../function/access/reach.js";
import { c, inp, input, realtimeChannel, realtimeChannelTrigger, realtimeMessage, realtimeServer, realtimeServerTrigger, ref, s } from "@xano/sdk";

/** The one realtime server. `enabled: true` is required: it's the one `enabled` in the SDK that defaults to false. */
export const live = realtimeServer({ name: "live", canonical: "live", enabled: true, description: "Live updates for the app's screens." });

/**
 * Everyone signed in: "row N of <entity> changed" (ids only, never row data: each screen refetches what its
 * person may see), plus presence, so the header can show who's here.
 */
export const appChannel = realtimeChannel({ name: "app", server: live, presence: true, description: "Changes to shared records, and who is online." });

/** One person's own channel: their notifications, the moment they're written. */
export const userChannel = realtimeChannel({
  name: "users/{user_id}", server: live, input: { user_id: input.int() },
  description: "A person's notifications. Only that person can join.",
});

/** Who else is looking at a record (`rooms/space-12`, as `<type>-<id>`): presence only, nothing is sent here. */
export const roomChannel = realtimeChannel({
  name: "rooms/{room}", server: live, input: { room: input.text() }, presence: true,
  description: "Who is viewing a record right now. Only people who reach the record can join.",
});

/** Changes inside one space: ids only, so a subscription a kick missed reveals nothing. */
export const spaceChannel = realtimeChannel({
  name: "spaces/{space_id}", server: live, input: { space_id: input.int() },
  description: "Changes in one space. Only people who reach it can join.",
});

/** Changes to CRM records, which live outside any space. */
export const crmChannel = realtimeChannel({ name: "crm", server: live, description: "Changes to CRM records. Only people with crm.read can join." });

/**
 * Who's typing in one conversation. It's the only channel clients write to, and it lives apart so a busy composer can't
 * crowd out a message's hint. Nothing is stored: a lost frame only means a name shows a moment late.
 */
export const typingChannel = realtimeChannel({
  name: "typing/{conversation_id}", server: live, input: { conversation_id: input.int() }, publish: { who: "authenticated" }, rateLimit: { messagesPerMinute: 60 },
  description: "Who's typing in a conversation. Only people who reach it can join.",
});

/**
 * That an open doc moved on. Only the tabs on this doc join it, so a save reaches them and nobody else, and nothing is stored:
 * a lost frame means a tab refreshes on its next frame or when it's looked at, and a stale save still can't land.
 */
export const docChannel = realtimeChannel({
  name: "docs/{doc_id}", server: live, input: { doc_id: input.int() },
  description: "A doc's saves, for the tabs that have it open. Only people who reach the doc can join.",
});

/** `from` comes from the session, so nobody can type as someone else. `others` leaves out the socket, not the person. */
export const typingMessage = realtimeMessage({
  name: "typing", channel: typingChannel, deliverTo: "others", input: { state: input.enum(["on", "off"]) },
  stack: [s.realtime.get_session({ as: "session" })],
  response: { from: ref("session.client_id"), state: inp("state") },
});

/**
 * Only you join users/{you}. A join trigger has no auth() and no inputs: identity is the session's client_id
 * (the auth row id, as text) and the path param is session.params. An empty or falsy answer refuses.
 */
export const userChannelJoin = realtimeChannelTrigger({
  name: "live/users_join", channel: userChannel, actions: { join: true },
  description: "Admit a person to their own notification channel only.",
  stack: [s.realtime.get_session({ as: "session" })],
  response: { allowed: c.expression('$var.session.authenticated == true && ($var.session.client_id|to_text) == ($var.session.params.user_id|to_text)') },
});

/** Guests stay off the shared channel: its presence shows everyone online, and they see only the people in their spaces. */
export const appChannelJoin = realtimeChannelTrigger({
  name: "live/app_join", channel: appChannel, actions: { join: true },
  description: "Admit everyone but guests to the shared channel.",
  stack: [
    s.realtime.get_session({ as: "session" }),
    s.db.get({ table: user, fieldValue: c.expression("$var.session.client_id|to_int"), output: ["role"], as: "member" }),
    s.set_var("member_role", ref("member.role", { safe: true })),
  ],
  response: { allowed: c.expression('$var.session.authenticated == true && ($var.member_role|to_text) != "" && ($var.member_role|to_text) != "guest"') },
});

const sessionIsBrowser = c.expression('($var.session.extras.kind|to_text) == "person"');

/** Joining a space's channel is reaching the space. */
export const spaceChannelJoin = realtimeChannelTrigger({
  name: "live/spaces_join", channel: spaceChannel, actions: { join: true },
  description: "Admit people who reach the space.",
  stack: [
    s.realtime.get_session({ as: "session" }),
    s.function.run({ fn: canReach, as: "reachable", input: { actor_id: c.expression("$var.session.client_id|to_int"), browser: sessionIsBrowser, type: c.text("space"), id: c.expression("$var.session.params.space_id|to_int") } }),
  ],
  response: { allowed: c.expression("$var.session.authenticated == true && $var.reachable == true") },
});

/** Joining a conversation's typing channel is reaching the conversation. */
export const typingChannelJoin = realtimeChannelTrigger({
  name: "live/typing_join", channel: typingChannel, actions: { join: true },
  description: "Admit people who reach the conversation.",
  stack: [
    s.realtime.get_session({ as: "session" }),
    s.function.run({ fn: canReach, as: "reachable", input: { actor_id: c.expression("$var.session.client_id|to_int"), browser: sessionIsBrowser, type: c.text("conversation"), id: c.expression("$var.session.params.conversation_id|to_int") } }),
  ],
  response: { allowed: c.expression("$var.session.authenticated == true && $var.reachable == true") },
});

/** Joining a doc's channel is reaching the doc. */
export const docChannelJoin = realtimeChannelTrigger({
  name: "live/docs_join", channel: docChannel, actions: { join: true },
  description: "Admit people who reach the doc.",
  stack: [
    s.realtime.get_session({ as: "session" }),
    s.function.run({ fn: canReach, as: "reachable", input: { actor_id: c.expression("$var.session.client_id|to_int"), browser: sessionIsBrowser, type: c.text("doc"), id: c.expression("$var.session.params.doc_id|to_int") } }),
  ],
  response: { allowed: c.expression("$var.session.authenticated == true && $var.reachable == true") },
});

/** Joining the CRM channel is reaching a CRM record. */
export const crmChannelJoin = realtimeChannelTrigger({
  name: "live/crm_join", channel: crmChannel, actions: { join: true },
  description: "Admit people who hold crm.read.",
  stack: [
    s.realtime.get_session({ as: "session" }),
    s.function.run({ fn: accessRule, as: "reachable", input: { actor_id: c.expression("$var.session.client_id|to_int"), browser: sessionIsBrowser, space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
  ],
  response: { allowed: c.expression("$var.session.authenticated == true && $var.reachable == true") },
});

/** Joining a record's room is reaching the record. */
export const roomChannelJoin = realtimeChannelTrigger({
  name: "live/rooms_join", channel: roomChannel, actions: { join: true },
  description: "Admit people who reach the record.",
  stack: [
    s.realtime.get_session({ as: "session" }),
    s.function.run({ fn: canJoinRoom, as: "reachable", input: { actor_id: c.expression("$var.session.client_id|to_int"), browser: sessionIsBrowser, room: c.expression("$var.session.params.room|to_text") } }),
  ],
  response: { allowed: c.expression("$var.session.authenticated == true && $var.reachable == true") },
});

/**
 * Only an active person's marked token opens a socket. An agent key can't pass: its connection id can equal a
 * person's user id, and the join triggers below would take it for that person. Connected agents have no socket.
 */
export const liveConnect = realtimeServerTrigger({
  name: "live/connect", realtimeServer: live, actions: { connect: true },
  description: "Admit active people with a person token, and nobody else, on every channel.",
  stack: [
    s.realtime.get_session({ as: "session" }),
    s.db.get({ table: user, fieldValue: c.expression("$var.session.client_id|to_int"), output: ["status"], as: "member" }),
    s.set_var("member_status", ref("member.status", { safe: true })),
  ],
  response: { allowed: c.expression('$var.session.authenticated == true && ($var.session.extras.kind|to_text) == "person" && ($var.member_status|to_text) == "active"') },
});

export const liveServers = [live];
export const liveChannels = [appChannel, userChannel, roomChannel, spaceChannel, crmChannel, typingChannel, docChannel];
export const liveMessages = [typingMessage];
export const liveTriggers = [userChannelJoin, appChannelJoin, spaceChannelJoin, crmChannelJoin, roomChannelJoin, typingChannelJoin, docChannelJoin, liveConnect];
