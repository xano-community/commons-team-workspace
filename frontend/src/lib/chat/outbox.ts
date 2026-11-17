// What's leaving. A message is on screen the moment it's sent, and stays until the server has it or the person decides.
// Everything goes under one client id, so however often it's retried the server makes one row. Unlike a record's write,
// nothing here rolls back: text someone wrote is never taken away from them.
//   sending  on its way, retried on its own through a lost connection, and held through a sign-in
//   failed   the retries ran out: Retry, Copy or Discard
//   blocked  the server refused and a retry can't change that: Copy or Discard
import { clearStore, readStore, writeStore } from "@/lib/data/store";
import type { ServerMessage } from "./log";

export type Outgoing = { key: string; conversationId: number; spaceId?: number; body: string; fileIds?: number[]; at: number; state: "sending" | "failed" | "blocked"; reason?: string };
type Sent = { message: Omit<ServerMessage, "author_name" | "author_kind">; repeat: boolean };
export type OutboxOptions = {
  userId: number;
  post: (conversationId: number, key: string, body: string, fileIds?: number[]) => Promise<Sent>;
  onSent: (conversationId: number, message: Sent["message"]) => void;
  wait?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

const KIND = "chat-outbox";
const TRIES = 3;
const LOST = "Not sent. Check your connection, then retry.";
const TOO_FAST = "You're sending too fast. Wait a moment, then retry.";
const NO_ACCESS = "You can't post here any more.";

const statusOf = (e: unknown) => (e as { status?: number } | null)?.status ?? 0;
const lost = (status: number) => status === 0 || status >= 500;

export function createChatOutbox({ userId, post, onSent, wait = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 15_000 }: OutboxOptions) {
  let list = readStore<Outgoing[]>(KIND, userId, []);
  /** Kept off the disk: text from a space this person has just lost. It lives until the tab closes, so they can copy it. */
  const offDisk = new Set<string>();
  const chains = new Map<number, Promise<void>>();
  const held = new Set<string>();
  const queued = new Set<string>();
  const listeners = new Set<() => void>();

  const publish = () => {
    writeStore(KIND, userId, list.filter((o) => !offDisk.has(o.key)));
    list = [...list];
    listeners.forEach((fn) => fn());
  };
  const update = (key: string, patch: Partial<Outgoing>) => { list = list.map((o) => (o.key === key ? { ...o, ...patch } : o)); publish(); };
  const remove = (key: string) => { list = list.filter((o) => o.key !== key); offDisk.delete(key); publish(); };
  const find = (key: string) => list.find((o) => o.key === key);

  /** A request that never answers counts as lost. It may still land, and the retry under the same id then finds it. */
  const attempt = (o: Outgoing) => Promise.race([
    post(o.conversationId, o.key, o.body, o.fileIds),
    new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("timed out"), { status: 0 })), timeoutMs)),
  ]);

  async function deliver(key: string) {
    for (let tries = 1; ; tries++) {
      const entry = find(key);
      if (!entry || entry.state !== "sending") return;
      try {
        const { message } = await attempt(entry);
        onSent(entry.conversationId, message);
        remove(key);
        return;
      } catch (e) {
        const status = statusOf(e);
        if (status === 401) { held.add(key); return; }
        if (status === 429) { update(key, { state: "failed", reason: TOO_FAST }); return; }
        if (!lost(status)) { update(key, { state: "blocked", reason: status === 400 && e instanceof Error ? e.message : NO_ACCESS }); return; }
        if (tries >= TRIES) { update(key, { state: "failed", reason: LOST }); return; }
        await wait(1000 * 2 ** (tries - 1));
      }
    }
  }

  /** One at a time per conversation, so messages land in the order they were written. */
  const enqueue = (o: Outgoing) => {
    if (queued.has(o.key)) return;
    queued.add(o.key);
    const next = (chains.get(o.conversationId) ?? Promise.resolve()).then(() => deliver(o.key)).finally(() => queued.delete(o.key));
    chains.set(o.conversationId, next);
  };

  return {
    /** Puts it on screen and sends it. Answers its client id. */
    send(conversationId: number, body: string, spaceId?: number, fileIds?: number[]) {
      const entry: Outgoing = { key: crypto.randomUUID(), conversationId, spaceId, body, fileIds, at: Date.now(), state: "sending" };
      list = [...list, entry];
      publish();
      enqueue(entry);
      return entry.key;
    },
    retry(key: string) {
      const entry = find(key);
      if (!entry || entry.state === "blocked") return;
      update(key, { state: "sending", reason: undefined });
      enqueue(find(key)!);
    },
    discard: remove,
    /** Sends what was left: after a reload, a sign-in, or the connection coming back. */
    resume() {
      for (const o of list) if (o.state === "sending") { held.delete(o.key); enqueue(o); }
    },
    /** This person lost a space, or everything. Its text leaves the disk, and stays on screen to be copied. */
    blockSpace(spaceId?: number) {
      for (const o of list) if (spaceId === undefined || o.spaceId === spaceId) offDisk.add(o.key);
      list = list.map((o) => (offDisk.has(o.key) ? { ...o, state: "blocked" as const, reason: NO_ACCESS } : o));
      if (!list.some((o) => !offDisk.has(o.key))) clearStore(KIND, userId);
      publish();
    },
    entries: (conversationId: number) => list.filter((o) => o.conversationId === conversationId),
    all: () => list,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

export type ChatOutbox = ReturnType<typeof createChatOutbox>;
