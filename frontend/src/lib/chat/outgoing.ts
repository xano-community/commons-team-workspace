// The outbox, wired to the cache. It loads with /chat, or when something unsent is found at start-up, so a first paint
// doesn't carry it. One per person for the life of the tab, so a message keeps going when its screen has closed.
import { api } from "@/lib/api";
import { queryClient } from "@/lib/data/client";
import { chatLogKey } from "./client";
import { mergeOne, type Log, type ServerMessage } from "./log";
import { createChatOutbox, type ChatOutbox } from "./outbox";

const outboxes = new Map<number, ChatOutbox>();

export function chatOutboxFor(userId: number, name = "You"): ChatOutbox {
  let box = outboxes.get(userId);
  if (!box) {
    box = createChatOutbox({
      userId,
      post: (id, key, body, fileIds) => api.postMessage(id, key, body, fileIds),
      // The answer has no author's name, because the sender already knows it. A hint's fetch brings the stored one.
      onSent: (id, message) => queryClient.setQueryData<Log>(chatLogKey(id), (log) => (log ? mergeOne(log, { ...message, author_name: name, author_kind: "human" } as ServerMessage) : log)),
    });
    outboxes.set(userId, box);
  }
  return box;
}
