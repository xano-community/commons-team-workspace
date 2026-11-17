// The domain's API (CRAFT.md §4, the one contract): paths from xano/routes.gen.ts, types from the defs with
// `import type`, every call through `request()`. The base app's own endpoints are in src/base/api.ts.
//
//   import type { InferResponse } from "@xano/sdk";
//   import type { listJobs } from "../../../xano/query/jobs/jobs.js";
//   export type JobPage = InferResponse<typeof listJobs>;
//   export const api = {
//     jobs: (q: { q?: string; status?: string; page?: number } = {}) => request<JobPage>("GET", routePath("GET jobs") + qs(q)),
//     updateJob: (id: number, patch: Partial<Job>) => request<Job>("PATCH", routePath("PATCH jobs/{id}", { id }), patch),
//   };
import type { InferResponse } from "@xano/sdk";
import type { addSpaceMemberRoute, getSpace, listConversations, listSpaceMembers, listSpaces } from "../../../xano/query/spaces.js";
import type { checkMention, getLinks, resolveLinks } from "../../../xano/query/links.js";
import type { conversationDetails, conversationPeople, createChannelRoute, deleteMessageRoute, editMessageRoute, listMessages, markReadRoute, openDmRoute, openThreadRoute, postMessageRoute } from "../../../xano/query/messages.js";
import { routePath } from "../../../xano/routes.gen.js";
import { qs, request } from "@/base/request";

export { ApiError, XANO_HOST, qs, request, token } from "@/base/request";
export { baseApi } from "@/base/api";
export type { Me, Person } from "@/base/api";

export type SpaceList = InferResponse<typeof listSpaces>;
export type Space = SpaceList["spaces"][number];

export type MentionCheck = InferResponse<typeof checkMention>;
export type RecordLinks = InferResponse<typeof getLinks>;
export type ConversationRow = InferResponse<typeof listConversations>[number];
export type ConversationDetails = InferResponse<typeof conversationDetails>;
export type ChatPerson = InferResponse<typeof conversationPeople>[number];
export type MessagePage = InferResponse<typeof listMessages>;
export type MessageQuery = { before_seq?: number; after_seq?: number; around_seq?: number; after_version?: number };

export const api = {
  spaces: () => request<SpaceList>("GET", routePath("GET spaces")),
  space: (id: number) => request<InferResponse<typeof getSpace>>("GET", routePath("GET spaces/{id}", { id })),
  spaceMembers: (id: number) => request<InferResponse<typeof listSpaceMembers>>("GET", routePath("GET spaces/{id}/members", { id })),
  addSpaceMember: (id: number, user_id: number, history_ok?: boolean) =>
    request<InferResponse<typeof addSpaceMemberRoute>>("POST", routePath("POST spaces/{id}/members", { id }), { user_id, history_ok }),
  resolveRecords: (items: { type: string; id: number }[]) => request<InferResponse<typeof resolveLinks>>("POST", routePath("POST links/resolve"), { items }),
  links: (type: string, id: number, page?: number) => request<RecordLinks>("GET", routePath("GET links") + qs({ type, id, page })),
  mentionCheck: (audience: { type: "conversation" | "space"; id: number }, records: { type: string; id: number }[]) =>
    request<MentionCheck>("POST", routePath("POST links/mention-check"), { audience_type: audience.type, audience_id: audience.id, records }),
  crmMentionCheck: (people: number[]) => request<MentionCheck>("POST", routePath("POST crm-mention-check"), { people }),
  conversations: () => request<ConversationRow[]>("GET", routePath("GET conversations")),
  conversation: (id: number) => request<ConversationDetails>("GET", routePath("GET conversations/{id}/details", { id })),
  conversationPeople: (id: number) => request<ChatPerson[]>("GET", routePath("GET conversations/{id}/people", { id })),
  messages: (id: number, q: MessageQuery = {}) => request<MessagePage>("GET", routePath("GET conversations/{id}/messages", { id }) + qs(q)),
  postMessage: (id: number, client_msg_id: string, body: string, file_ids?: number[]) => request<InferResponse<typeof postMessageRoute>>("POST", routePath("POST conversations/{id}/messages", { id }), { client_msg_id, body, file_ids }),
  editMessage: (id: number, body: string) => request<InferResponse<typeof editMessageRoute>>("PATCH", routePath("PATCH messages/{id}", { id }), { body }),
  deleteMessage: (id: number) => request<InferResponse<typeof deleteMessageRoute>>("DELETE", routePath("DELETE messages/{id}", { id })),
  markRead: (id: number, seq: number) => request<InferResponse<typeof markReadRoute>>("POST", routePath("POST conversations/{id}/read", { id }), { seq }),
  createChannel: (id: number, name: string) => request<InferResponse<typeof createChannelRoute>>("POST", routePath("POST spaces/{id}/channels", { id }), { name }),
  openDm: (user_ids: number[]) => request<InferResponse<typeof openDmRoute>>("POST", routePath("POST conversations/dm"), { user_ids }),
  openThread: (record_type: string, record_id: number) => request<InferResponse<typeof openThreadRoute>>("POST", routePath("POST threads"), { record_type, record_id }),
};
