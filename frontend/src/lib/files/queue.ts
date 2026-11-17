// A set of uploads, as plain data. It holds each file until it's in or someone lets it go, so Retry always has something to send, and
// a retry goes under the same id, so however often it's tried the server keeps one. Nothing here touches the network or React.
//   queued, uploading   on their way
//   done                in, with its row
//   failed, cancelled   Retry sends it again
//   too_big, wrong_type, empty, refused   Retry can't change these, so another file can take its place
import { precheck, type FileStorage, type FileView, type StoreAnswer } from "./model";

export type Limits = FileStorage;
export type UploadState = "queued" | "uploading" | "done" | "failed" | "cancelled" | "too_big" | "wrong_type" | "empty" | "refused";
export type Upload = { key: string; name: string; size: number; state: UploadState; progress: number; reason?: string; file?: FileView };
export type Send = (file: File, key: string, progress: (fraction: number) => void, signal: AbortSignal) => Promise<StoreAnswer>;

const AT_ONCE = 2;
const LOST = "The connection dropped. Check it, then retry.";
const SIGNED_OUT = "You've been signed out. Sign in, then retry.";
const BROKE = "The server couldn't take this file. Try again.";
const going = (s: UploadState) => s === "queued" || s === "uploading";
/** What a person has to deal with before a message goes. */
const stuck = (s: UploadState) => s !== "done" && !going(s);
export const canRetry = (s: UploadState) => s === "failed" || s === "cancelled";

export function createUploads({ send, limits, onDone }: { send: Send; limits: () => Limits | null; onDone?: (file: FileView) => void }) {
  let list: Upload[] = [];
  const files = new Map<string, File>();
  const running = new Map<string, AbortController>();
  const listeners = new Set<() => void>();

  const publish = () => { list = [...list]; listeners.forEach((fn) => fn()); };
  const update = (key: string, patch: Partial<Upload>) => { list = list.map((u) => (u.key === key ? { ...u, ...patch } : u)); publish(); };

  async function run(upload: Upload) {
    const file = files.get(upload.key);
    if (!file) return;
    const stop = new AbortController();
    running.set(upload.key, stop);
    update(upload.key, { state: "uploading", progress: 0, reason: undefined });
    try {
      const answer = await send(file, upload.key, (progress) => { if (!stop.signal.aborted) update(upload.key, { progress }); }, stop.signal);
      if (stop.signal.aborted) return;
      if (answer.ok && answer.file) {
        update(upload.key, { state: "done", progress: 1, file: answer.file });
        files.delete(upload.key);
        onDone?.(answer.file);
      } else {
        update(upload.key, { state: answer.code === "failed" || !answer.code ? "failed" : answer.code, reason: answer.message || BROKE });
      }
    } catch (e) {
      if (stop.signal.aborted) update(upload.key, { state: "cancelled", reason: undefined });
      else {
        const status = (e as { status?: number }).status ?? 0;
        update(upload.key, { state: "failed", reason: status === 0 ? LOST : status === 401 ? SIGNED_OUT : BROKE });
      }
    } finally {
      running.delete(upload.key);
      pump();
    }
  }

  function pump() {
    for (const next of list.filter((u) => u.state === "queued").slice(0, Math.max(0, AT_ONCE - running.size))) void run(next);
  }

  const fresh = (key: string, file: File): Upload => {
    const refused = precheck(file, limits());
    return { key, name: file.name, size: file.size, state: refused?.code ?? "queued", progress: 0, reason: refused?.message };
  };

  return {
    add(picked: File[]) {
      const made = picked.map((file) => { const key = crypto.randomUUID(); files.set(key, file); return fresh(key, file); });
      list = [...list, ...made];
      publish();
      pump();
    },
    cancel(key: string) {
      const stop = running.get(key);
      if (stop) stop.abort();
      else if (list.find((u) => u.key === key)?.state === "queued") update(key, { state: "cancelled" });
    },
    retry(key: string) {
      const held = list.find((u) => u.key === key);
      if (!held || !canRetry(held.state)) return;
      update(key, { state: "queued", progress: 0, reason: undefined });
      pump();
    },
    /** Puts another file in the place of one that can't go, under a new id: it's a different file. */
    replace(key: string, file: File) {
      files.delete(key);
      const next = crypto.randomUUID();
      files.set(next, file);
      list = list.map((u) => (u.key === key ? fresh(next, file) : u));
      publish();
      pump();
    },
    remove(key: string) {
      running.get(key)?.abort();
      files.delete(key);
      list = list.filter((u) => u.key !== key);
      publish();
    },
    clear() {
      running.forEach((stop) => stop.abort());
      files.clear();
      list = [];
      publish();
    },
    /** Takes what's in off the list, leaving what still needs attention. */
    clearDone() { list = list.filter((u) => u.state !== "done"); publish(); },
    list: () => list,
    pending: () => list.filter((u) => going(u.state)).length,
    problems: () => list.filter((u) => stuck(u.state)).length,
    fileIds: () => list.flatMap((u) => (u.file ? [u.file.id] : [])),
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

export type Uploads = ReturnType<typeof createUploads>;
