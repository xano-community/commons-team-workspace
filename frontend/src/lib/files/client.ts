// How file screens read. Each key starts with `file`, so a live frame on a space or the CRM refreshes a list, a tile and a file's own
// screen together. One set of uploads per place lives for the life of the tab, so leaving a screen doesn't stop what's going.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useEntityQuery, queryClient } from "@/lib/data";
import { createResolver } from "@/lib/links/resolver";
import { filesApi, sendFile, type FileRequest } from "./api";
import { FileRefused, forgetBytes, shownBytes } from "./bytes";
import type { FileState, FileStorage, FileView, Place } from "./model";
import { createUploads, type Uploads } from "./queue";

export const useFiles = (q: FileRequest) => useEntityQuery("file", ["list", q], () => filesApi.list(q), { refetchOnMount: "always" });
export const useFile = (id: number) => useEntityQuery("file", ["one", id], () => filesApi.file(id), { refetchOnMount: "always" });
export const useAttached = (type: string, id: number) => useEntityQuery("file", ["attached", type, id], () => filesApi.attached(type, id));

/** Signing a real file costs a write, so it's asked once a session. A plan doesn't change under someone's hands. */
export const storageQuery = { queryKey: ["file-storage"], queryFn: filesApi.storage, staleTime: Infinity, gcTime: Infinity };
export const useFileStorage = () => useQuery(storageQuery);

const views = createResolver<FileState>((items) => filesApi.views(items.map((i) => i.id)));
/** One file named by id, as this viewer may see it. Everything asked in the same moment is one request. */
export const useFileView = (id: number) => useQuery({
  queryKey: ["file", "view", id],
  queryFn: () => views({ type: "file", id }),
  staleTime: 30_000,
});

const sets = new Map<string, Uploads>();
const keyOf = (place: Place, attach: boolean) => `${place.type}:${place.id}:${attach}`;
const refreshAfter = () => {
  void queryClient.invalidateQueries({ queryKey: ["file"] });
  void queryClient.invalidateQueries({ queryKey: ["record_link"] });
  void queryClient.invalidateQueries({ queryKey: ["company"] });
};

export function uploadsFor(place: Place, attach: boolean): Uploads {
  const key = keyOf(place, attach);
  let set = sets.get(key);
  if (!set) {
    void queryClient.prefetchQuery(storageQuery);
    set = createUploads({
      send: (file, id, progress, signal) => sendFile(file, place, attach, id, progress, signal),
      limits: () => queryClient.getQueryData<FileStorage>(storageQuery.queryKey) ?? null,
      onDone: refreshAfter,
    });
    sets.set(key, set);
  }
  return set;
}

// Signing out clears the query cache and keeps the tab, and whoever signs in next mustn't inherit bytes or uploads.
queryClient.getQueryCache().subscribe((e) => {
  if (e.type !== "removed" || e.query.queryKey[0] !== "file-storage") return;
  forgetBytes();
  sets.forEach((set) => set.clear());
  sets.clear();
});

/** Warns before a tab closes on a file still leaving. */
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => { if ([...sets.values()].some((s) => s.pending() > 0)) e.preventDefault(); });
}

/** One place's uploads, as a screen sees them. With no place there's nothing to do, which is what an edit in place wants. */
export function useUploads(place: Place | null, attach = false) {
  useFileStorage();
  const set = useMemo(() => (place ? uploadsFor(place, attach) : null), [place?.type, place?.id, attach]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useSyncExternalStore((fn) => set?.subscribe(fn) ?? (() => {}), () => set?.list() ?? NONE);
  return { set, list };
}
const NONE: never[] = [];

export type Bytes = { state: "loading" } | { state: "ready"; url: string; blob: Blob } | { state: "refused" } | { state: "failed"; error: unknown; retry: () => void };

/** A file's bytes for showing. Off until `enabled`, so a row out of view asks for nothing. */
export function useFileBytes(file: Pick<FileView, "id" | "name" | "kind"> | null, enabled = true): Bytes {
  const [attempt, setAttempt] = useState(0);
  const [bytes, setBytes] = useState<Bytes>({ state: "loading" });
  useEffect(() => {
    if (!file || !enabled) return;
    let live = true;
    setBytes({ state: "loading" });
    shownBytes(file).then(
      (b) => { if (live) setBytes({ state: "ready", ...b }); },
      (error) => { if (live) setBytes(error instanceof FileRefused ? { state: "refused" } : { state: "failed", error, retry: () => setAttempt((n) => n + 1) }); },
    );
    return () => { live = false; };
  }, [file?.id, enabled, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  return bytes;
}
