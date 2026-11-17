// One conversation's log, kept in the query cache so a purge, a reconnect and a sign-out reach it like everything else, and
// changed only through the merges in log.ts. It loads with /chat. A hint says "something moved here" and carries no text, so
// reading what moved is always one request, asking for everything since the version this tab last saw.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, type MessagePage } from "@/lib/api";
import { chatLogKey } from "./client";
import { chatOutboxFor } from "./outgoing";
import { emptyLog, mergeDelta, mergeNewer, mergeOlder, mergePage, patchRow, type Log, type Page, type Row } from "./log";

const CHANGES_AT_ONCE = 200;
const read = (client: QueryClient, id: number) => client.getQueryData<Log>(chatLogKey(id));
const write = (client: QueryClient, id: number, fn: (log: Log) => Log) => client.setQueryData<Log>(chatLogKey(id), (log) => (log ? fn(log) : log));
const asPage = (p: MessagePage) => p as unknown as Page;

const pulls = new Map<number, { again: boolean }>();

/**
 * Reads everything that changed since this tab last looked. One at a time per conversation, and asking during a read reads
 * once more after it: that read may have been answered before what prompted this committed.
 */
export async function pull(client: QueryClient, id: number): Promise<void> {
  const running = pulls.get(id);
  if (running) { running.again = true; return; }
  const state = { again: false };
  pulls.set(id, state);
  try {
    do {
      state.again = false;
      for (;;) {
        const log = read(client, id);
        if (!log) break;
        const page = await api.messages(id, { after_version: log.version || undefined });
        write(client, id, (l) => mergeDelta(l, asPage(page)));
        if (page.items.length < CHANGES_AT_ONCE) break;
      }
    } while (state.again);
  } catch (e) {
    // Refused means access went: the details say so. A lost connection waits for the next hint, focus or sweep.
    if ((e as { status?: number }).status === 404) void client.invalidateQueries({ queryKey: ["conversation", "details", id] });
  } finally {
    pulls.delete(id);
  }
}

export function useChatLog(id: number, aroundSeq: number | null) {
  const client = useQueryClient();
  const log = useQuery({
    queryKey: chatLogKey(id),
    staleTime: Infinity,
    queryFn: async () => {
      const known = read(client, id);
      if (known) { await pull(client, id); return read(client, id) ?? known; }
      return mergePage(emptyLog(), asPage(await api.messages(id, aroundSeq ? { around_seq: aroundSeq } : {})));
    },
  });
  const [older, setOlder] = useState<"idle" | "loading" | "failed">("idle");
  const [newer, setNewer] = useState<"idle" | "loading" | "failed">("idle");

  // A return to something cached shows it at once, and anything missed lands behind it. A first load reads once more when it
  // lands: a hint that came while it was in the air had nothing here to reach, and no other would follow.
  const loaded = !!log.data;
  useEffect(() => { void pull(client, id); }, [client, id, loaded]);
  useEffect(() => { setOlder("idle"); setNewer("idle"); }, [id]);

  // A scroll can ask many times before "loading" reaches the screen, so the request itself is what's remembered.
  const askingOlder = useRef<number | null>(null);
  const loadOlder = useCallback(async () => {
    const first = read(client, id)?.rows[0]?.seq;
    if (!first || askingOlder.current === id) return;
    askingOlder.current = id;
    setOlder("loading");
    try {
      const page = await api.messages(id, { before_seq: first });
      write(client, id, (l) => mergeOlder(l, asPage(page)));
      setOlder("idle");
    } catch { setOlder("failed"); } finally { if (askingOlder.current === id) askingOlder.current = null; }
  }, [client, id]);

  const loadNewer = useCallback(async () => {
    const last = read(client, id)?.rows.at(-1)?.seq;
    if (!last || newer === "loading") return;
    setNewer("loading");
    try {
      const page = await api.messages(id, { after_seq: last });
      write(client, id, (l) => mergeNewer(l, asPage(page)));
      setNewer("idle");
    } catch { setNewer("failed"); }
  }, [client, id, newer]);

  /** Back to the newest page, from an old window. */
  const toLatest = useCallback(async () => {
    const page = await api.messages(id);
    client.setQueryData<Log>(chatLogKey(id), mergePage(emptyLog(), asPage(page)));
  }, [client, id]);

  /** A message outside what's loaded: its window replaces what's there. */
  const jumpTo = useCallback(async (seq: number) => {
    const page = await api.messages(id, { around_seq: seq });
    client.setQueryData<Log>(chatLogKey(id), mergePage(emptyLog(), asPage(page)));
  }, [client, id]);

  return { log, older, newer, loadOlder, loadNewer, toLatest, jumpTo };
}

export function useOutgoing(userId: number, id: number) {
  const box = chatOutboxFor(userId);
  const all = useSyncExternalStore(box.subscribe, box.all);
  return useMemo(() => all.filter((o) => o.conversationId === id), [all, id]);
}

/** Changes a message on screen at once, and puts it back with `fail` if the server says no. */
export function useMessageActions(id: number) {
  const client = useQueryClient();
  const change = useCallback(async (row: Row, patch: Partial<Row>, send: () => Promise<{ version: number }>, fail: (e: unknown) => void) => {
    write(client, id, (l) => patchRow(l, row.key, patch));
    try {
      const saved = await send();
      write(client, id, (l) => patchRow(l, row.key, { version: saved.version }));
    } catch (e) {
      write(client, id, (l) => patchRow(l, row.key, { body: row.body, edited: row.edited, deleted: row.deleted, version: row.version }));
      fail(e);
    }
  }, [client, id]);
  return {
    edit: (row: Row, body: string, fail: (e: unknown) => void) => change(row, { body, edited: true }, () => api.editMessage(row.id!, body), fail),
    remove: (row: Row, fail: (e: unknown) => void) => change(row, { body: "", deleted: true }, () => api.deleteMessage(row.id!), fail),
  };
}
