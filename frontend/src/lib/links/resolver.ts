// The one way a screen learns what a record is called. Chips ask for themselves; everything asked in the same moment
// goes out as one request, and the answer is filtered for this viewer on the server. A rename or a loss of access reaches
// a chip through the same cache as any other change.
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type RecordRef = { type: string; id: number };
export type RecordState = "live" | "locked" | "deleted" | "archived" | "tombstone";
/** What a full row shows beside a live record's name: a task's status, assignee and due date, a doc's owner, a file's kind. */
export type RecordDetail = { status?: string; priority?: string; due_on?: string | null; person_id?: number; updated_at?: number; kind?: string };
export type RecordView = RecordRef & { state: RecordState; title: string; href: string; can_restore: boolean; detail?: RecordDetail };

const BATCH = 100;   // what the server takes at once
const keyOf = (r: RecordRef) => `${r.type}:${r.id}`;
type Waiting<V> = { ref: RecordRef; resolve: ((v: V) => void)[]; reject: ((e: unknown) => void)[] };

export function createResolver<V = RecordView>(fetch: (items: RecordRef[]) => Promise<V[]>) {
  let queue = new Map<string, Waiting<V>>();
  const flush = () => {
    const batch = [...queue.values()];
    queue = new Map();
    for (let i = 0; i < batch.length; i += BATCH) {
      const part = batch.slice(i, i + BATCH);
      fetch(part.map((w) => w.ref)).then(
        (views) => part.forEach((w, n) => w.resolve.forEach((fn) => fn(views[n]))),
        (e) => part.forEach((w) => w.reject.forEach((fn) => fn(e))),
      );
    }
  };
  return (ref: RecordRef) => new Promise<V>((resolve, reject) => {
    if (!queue.size) queueMicrotask(flush);
    const key = keyOf(ref);
    const waiting = queue.get(key) ?? { ref, resolve: [], reject: [] };
    waiting.resolve.push(resolve);
    waiting.reject.push(reject);
    queue.set(key, waiting);
  });
}

const load = createResolver((items) => api.resolveRecords(items));

/** One record as this viewer may see it. The key starts with `record`, then its type, so a change to that type refreshes it. */
export const useRecord = (type: string, id: number) =>
  useQuery({ queryKey: ["record", type, id], queryFn: () => load({ type, id }) });
