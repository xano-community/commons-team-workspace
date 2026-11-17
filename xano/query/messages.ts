// Chat over HTTP. A message goes out here and only here, never by a client's own frame: the server takes its place in the
// conversation, then a hint tells everyone to come and read it. Each route is thin, so an agent's tool can run the same rule.
import { apiGroup, auth, inp, input, query, ref, s } from "@xano/sdk";
import type { InferRow } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { conversation } from "../table/messaging/conversation.js";
import { message } from "../table/messaging/message.js";
import { gateActive } from "../function/members/gate.js";
import { bindBrowser } from "../function/access/reach.js";
import { createChannel, openDm, openThread, readDetails, readPeople } from "../function/messaging/conversations.js";
import { deleteMessage, editMessage, markRead, postMessage, readHistory } from "../function/messaging/messages.js";

export const messagingGroup = apiGroup({ name: "messaging", canonical: "messaging", middleware: { pre: [gateActive] }, description: "Messages, and starting channels, DMs and threads." });

type Conversation = InferRow<typeof conversation>;
type Message = InferRow<typeof message>;
/** A message as a reader gets it: its author's name rides along, because an author may have left the people list. */
export type MessageView = Omit<Message, "file_ids"> & { file_ids?: unknown; author_name: string; author_kind: "human" | "agent"; approver_name?: string | null };
export type MessagePage = { items: MessageView[]; last_seq: number; last_version: number; has_older: boolean; has_newer: boolean };
export type Person = { id: number; name: string; kind: "human" | "agent"; status: string };

const caller = () => [...rbac.signedIn(), ...bindBrowser()];
const who = () => ({ actor_id: auth("id"), browser: ref("browser") });

/** GET conversations/{id}/messages: the newest page, or one of `before_seq`, `after_seq`, `around_seq`, or everything changed since `after_version`. */
export const listMessages = query({
  apiGroup: messagingGroup, auth: user,
  name: "conversations/{id}/messages", verb: "GET",
  description: "A page of a conversation you can reach, oldest first.",
  input: { id: input.int({ required: true }), before_seq: input.int(), after_seq: input.int(), around_seq: input.int(), after_version: input.int() },
  stack: [...caller(), s.function.run({ fn: readHistory, as: "page", input: { ...who(), conversation_id: inp("id"), before_seq: inp("before_seq"), after_seq: inp("after_seq"), around_seq: inp("around_seq"), after_version: inp("after_version") } })],
  response: ref("page"),
  responseShape: {} as MessagePage,
});

/** POST conversations/{id}/messages: send. A repeat of `client_msg_id` answers the row it made, with `repeat` set, and nothing else happens. */
export const postMessageRoute = query({
  apiGroup: messagingGroup, auth: user,
  name: "conversations/{id}/messages", verb: "POST",
  // It can start an agent run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Send a message. Safe to retry with the same client_msg_id.",
  input: { id: input.int({ required: true }), client_msg_id: input.text({ required: true }), body: input.text({ methods: ["trim"] }), file_ids: input.json() },
  stack: [...caller(), s.function.run({ fn: postMessage, as: "sent", input: { ...who(), conversation_id: inp("id"), client_msg_id: inp("client_msg_id"), body: inp("body"), file_ids: inp("file_ids") } })],
  response: ref("sent"),
  responseShape: {} as { message: Message; repeat: boolean },
});

/** PATCH messages/{id}: change your own message. */
export const editMessageRoute = query({
  apiGroup: messagingGroup, auth: user,
  name: "messages/{id}", verb: "PATCH",
  // It can start an agent run, and a run mints a token, so nothing of this request is kept.
  history: false,
  description: "Edit a message you wrote.",
  input: { id: input.int({ required: true }), body: input.text({ methods: ["trim"] }) },
  stack: [...caller(), s.function.run({ fn: editMessage, as: "row", input: { ...who(), id: inp("id"), body: inp("body") } })],
  response: ref("row"),
  responseShape: {} as Message,
});

/** DELETE messages/{id}: your own, or any in a space you manage. It stays as a tombstone. */
export const deleteMessageRoute = query({
  apiGroup: messagingGroup, auth: user,
  name: "messages/{id}", verb: "DELETE",
  description: "Delete a message. Its place stays, as a tombstone.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: deleteMessage, as: "row", input: { ...who(), id: inp("id") } })],
  response: ref("row"),
  responseShape: {} as Message,
});

/** POST conversations/{id}/read: you've read up to `seq`. It only ever moves forward. */
export const markReadRoute = query({
  apiGroup: messagingGroup, auth: user,
  name: "conversations/{id}/read", verb: "POST",
  description: "Say how far you've read.",
  input: { id: input.int({ required: true }), seq: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: markRead, as: "position", input: { ...who(), conversation_id: inp("id"), seq: inp("seq") } })],
  response: ref("position"),
  responseShape: {} as { last_read_seq: number },
});

/** GET conversations/{id}/details: what a screen needs to open one, and what this person may do there. */
export const conversationDetails = query({
  apiGroup: messagingGroup, auth: user,
  name: "conversations/{id}/details", verb: "GET",
  description: "A conversation, where it lives, and what you may do in it.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: readDetails, as: "details", input: { ...who(), conversation_id: inp("id") } })],
  response: ref("details"),
  responseShape: {} as {
    conversation: Conversation; space_name: string; archived: boolean; can_post: boolean; can_moderate: boolean; last_read_seq: number; members: Person[];
    record: { type: string; id: number; state: string; title: string; href: string; can_restore: boolean } | null;
  },
});

/** GET conversations/{id}/people: who a mention here reaches. */
export const conversationPeople = query({
  apiGroup: messagingGroup, auth: user,
  name: "conversations/{id}/people", verb: "GET",
  description: "Everyone who can read a conversation, for mentions.",
  input: { id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: readPeople, as: "people", input: { ...who(), conversation_id: inp("id") } })],
  response: ref("people"),
  responseShape: [] as Person[],
});

/** POST spaces/{id}/channels: add a channel to a space. */
export const createChannelRoute = query({
  apiGroup: messagingGroup, auth: user,
  name: "spaces/{id}/channels", verb: "POST",
  description: "Add a channel to a space.",
  input: { id: input.int({ required: true }), name: input.text({ required: true }) },
  stack: [...caller(), s.function.run({ fn: createChannel, as: "made", input: { ...who(), space_id: inp("id"), name: inp("name") } })],
  response: ref("made"),
  responseShape: {} as Conversation,
});

/** POST conversations/dm: open the DM between you and these people, starting it if it's new. */
export const openDmRoute = query({
  apiGroup: messagingGroup, auth: user,
  name: "conversations/dm", verb: "POST",
  description: "Open the DM with these people.",
  input: { user_ids: input.list(input.int(), { required: true }) },
  stack: [...caller(), s.function.run({ fn: openDm, as: "dm", input: { ...who(), user_ids: inp("user_ids") } })],
  response: ref("dm"),
  responseShape: {} as Conversation,
});

/** POST threads: open the thread on a record, starting it if it's new. */
export const openThreadRoute = query({
  apiGroup: messagingGroup, auth: user,
  name: "threads", verb: "POST",
  description: "Open the thread on a record you can reach.",
  input: { record_type: input.text({ required: true }), record_id: input.int({ required: true }) },
  stack: [...caller(), s.function.run({ fn: openThread, as: "thread", input: { ...who(), record_type: inp("record_type"), record_id: inp("record_id") } })],
  response: ref("thread"),
  responseShape: {} as Conversation,
});

export const messagingQueries = [listMessages, postMessageRoute, editMessageRoute, deleteMessageRoute, markReadRoute, conversationDetails, conversationPeople, createChannelRoute, openDmRoute, openThreadRoute];
