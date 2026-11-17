// The file screens' requests. They load with those screens, so the shell doesn't carry them.
import { routePath } from "../../../../xano/routes.gen.js";
import { XANO_HOST, qs, request, token } from "@/base/request";
import type { RecordLinks } from "@/lib/api";
import type { Attached, FileDetails, FileHit, FileLink, FilePage, FileState, FileStorage, Place, StoreAnswer } from "./model";

export type FileRequest = { space_id?: number; kind?: string; since?: number; q?: string; trash?: boolean; page?: number };

export const filesApi = {
  storage: () => request<FileStorage>("GET", routePath("GET file-storage")),
  list: (q: FileRequest) => request<FilePage>("GET", routePath("GET files") + qs(q)),
  file: (id: number) => request<FileDetails>("GET", routePath("GET files/{id}", { id })),
  link: (id: number) => request<FileLink>("GET", routePath("GET files/{id}/link", { id })),
  views: (ids: number[]) => request<FileState[]>("POST", routePath("POST file-views"), { ids }),
  attached: (type: string, id: number) => request<Attached>("GET", routePath("GET file-attachments") + qs({ type, id })),
  links: (id: number, page?: number) => request<RecordLinks>("GET", routePath("GET files/{id}/links", { id }) + qs({ page })),
  search: (q: string) => request<FileHit[]>("GET", routePath("GET file-search") + qs({ q })),
  remove: (id: number) => request<{ ok: boolean }>("DELETE", routePath("DELETE files/{id}", { id })),
  restore: (id: number) => request<{ ok: boolean }>("POST", routePath("POST files/{id}/restore", { id }), {}),
};

const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/**
 * Sends one file. `request()` speaks JSON and has no progress, so this is the one path that talks to the backend by hand: XHR is what
 * reports bytes leaving and can stop halfway.
 */
export function sendFile(file: File, place: Place, attach: boolean, key: string, progress: (fraction: number) => void, signal: AbortSignal): Promise<StoreAnswer> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("client_id", key);
    form.append("place_type", place.type);
    form.append("place_id", String(place.id));
    form.append("attach", String(attach));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${XANO_HOST}${routePath("POST files")}`);
    const held = token.get();
    if (held) xhr.setRequestHeader("Authorization", `Bearer ${held}`);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) progress(e.loaded / e.total); };
    const lost = () => reject(Object.assign(new Error("lost"), { status: 0 }));
    xhr.onerror = lost;
    xhr.ontimeout = lost;
    xhr.onabort = () => reject(new DOMException("stopped", "AbortError"));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 && xhr.response ? resolve(xhr.response as StoreAnswer) : reject(Object.assign(new Error("refused"), { status: xhr.status })));
    signal.addEventListener("abort", () => xhr.abort());
    xhr.send(form);
  });
}

export const rawUrl = (id: number) => `${XANO_HOST}${routePath("GET files/{id}/raw", { id })}`;
