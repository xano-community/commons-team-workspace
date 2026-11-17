// Every write goes through here: it shows at once, sits in the outbox until the server answers, and is rolled back with
// a toast that names it if the server refuses. A 401 or a lost connection is not a refusal: the write is held on disk
// under the person's id, stays on screen, and is sent when they're back. A held write may have reached the server if
// the tab died mid-request, so a write that creates a row should carry its entry id as a client id the server dedupes on.
import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { applyEntityEvent, type EntityChange } from "./entities";
import { clearStore, readStore, writeStore } from "./store";

export type Write = {
  /** What the person did, in words that finish "Couldn't …": "mark this read", "move Fix login to Done". */
  label: string;
  verb: string;
  path: string;
  body?: unknown;
  changes: EntityChange[];
  spaceId?: number;
  /** The server answers with the whole record, which is taken as it is, so nothing needs refetching. */
  answer?: boolean;
};
export type OutboxEntry = Write & { id: string; at: number };

export type OutboxDeps = {
  client: QueryClient;
  request: (verb: string, path: string, body?: unknown) => Promise<unknown>;
  notifyFailure: (message: string) => void;
};

const KIND = "outbox";
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
const entries = (userId: number) => readStore<OutboxEntry[]>(KIND, userId, []);
const save = (userId: number, list: OutboxEntry[]) => { writeStore(KIND, userId, list); notify(); };

const reasonOf = (e: unknown) => (e instanceof Error && e.message ? e.message : "Try again.");
/** Nothing is wrong with the write itself: the person is signed out, or the server can't be reached. */
const isHeld = (e: unknown) => { const s = (e as { status?: number } | null)?.status; return s === 401 || s === 0; };

async function attempt(entry: OutboxEntry, userId: number, deps: OutboxDeps): Promise<"sent" | "held" | "failed"> {
  try {
    const answer = await deps.request(entry.verb, entry.path, entry.body);
    save(userId, entries(userId).filter((e) => e.id !== entry.id));
    const rows = entry.answer && answer ? entry.changes.map((c) => ({ ...c, patch: answer as EntityChange["patch"] })) : undefined;
    applyEntityEvent(deps.client, { type: "settled", writeId: entry.id, rows });
    return "sent";
  } catch (e) {
    if (isHeld(e)) return "held";
    save(userId, entries(userId).filter((x) => x.id !== entry.id));
    applyEntityEvent(deps.client, { type: "failed", writeId: entry.id });
    deps.notifyFailure(`Couldn't ${entry.label}. ${reasonOf(e)}`);
    return "failed";
  }
}

/** Shows the write at once and sends it. Resolves to how it ended. */
export function sendWrite(userId: number, write: Write, deps: OutboxDeps) {
  const entry: OutboxEntry = { ...write, id: crypto.randomUUID(), at: Date.now() };
  save(userId, [...entries(userId), entry]);
  applyEntityEvent(deps.client, { type: "write", writeId: entry.id, changes: entry.changes });
  return attempt(entry, userId, deps);
}

/**
 * Sends what's held, oldest first, stopping at the first that still can't go. Puts each back on screen first: after a
 * reload the cache is empty of it. One tab at a time, so two tabs never send the same write.
 */
export async function flushOutbox(userId: number, deps: OutboxDeps): Promise<void> {
  const run = async () => {
    for (const entry of entries(userId)) {
      applyEntityEvent(deps.client, { type: "write", writeId: entry.id, changes: entry.changes });
      if (await attempt(entry, userId, deps) === "held") return;
    }
  };
  if (typeof navigator !== "undefined" && navigator.locks) await navigator.locks.request(`commons.outbox.${userId}`, { ifAvailable: true }, (lock) => (lock ? run() : undefined));
  else await run();
}

/** Forgets unsent writes: all of this person's, or those in one space they were removed from. */
export function purgeOutbox(userId: number, spaceId?: number): void {
  if (spaceId === undefined) { clearStore(KIND, userId); notify(); return; }
  save(userId, entries(userId).filter((e) => e.spaceId !== spaceId));
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
/** How many writes are waiting to be sent. */
export const useOutboxCount = (userId: number): number => useSyncExternalStore(subscribe, () => entries(userId).length);
export const outboxEntries = entries;
