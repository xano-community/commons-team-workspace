// How bytes reach this tab. The server is always asked first, and answers 200 whatever it says, so a refusal never lands in the
// console. A signed link is fetched here and never opened: a browser opening it would run what's in it. What's saved or shown is made
// a blob of a type this app chose, so nothing the file claims about itself decides how it's treated.
import { token } from "@/base/request";
import { filesApi, rawUrl } from "./api";
import type { FileView } from "./model";

export class FileRefused extends Error {
  constructor() { super("You don't have access to this file."); }
}

const KEEP = 24;
const TYPES: Partial<Record<FileView["kind"], string>> = { pdf: "application/pdf", text: "text/plain" };
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const shownType = (f: Pick<FileView, "name" | "kind">) => (f.kind === "image" ? IMAGE_TYPES[f.name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream" : TYPES[f.kind] ?? "application/octet-stream");

async function fetchBytes(id: number): Promise<Blob> {
  const link = await filesApi.link(id);
  if (link.how === "refused") throw new FileRefused();
  if (link.how === "unavailable") throw new Error("Storage isn't answering. Try again in a moment.");
  const held = token.get();
  const answer = link.how === "signed" ? await fetch(link.url!) : await fetch(rawUrl(id), { headers: held ? { Authorization: `Bearer ${held}` } : {} });
  if (!answer.ok) throw new Error("This file didn't load. Try again.");
  return answer.blob();
}

/** Recent files' bytes, so a list and its preview ask once. A blob's address is dropped when it falls out, and a sign-out clears them. */
const kept = new Map<number, { blob: Blob; url: string }>();
function keep(id: number, blob: Blob) {
  const url = URL.createObjectURL(blob);
  kept.set(id, { blob, url });
  if (kept.size > KEEP) {
    const [oldest, entry] = kept.entries().next().value!;
    URL.revokeObjectURL(entry.url);
    kept.delete(oldest);
  }
  return kept.get(id)!;
}
const asking = new Map<number, Promise<{ blob: Blob; url: string }>>();

/** A file's bytes as something a page may show, typed by this app. A file that's been removed from reach must ask again, so a cached copy is only for this view. */
export function shownBytes(file: Pick<FileView, "id" | "name" | "kind">): Promise<{ blob: Blob; url: string }> {
  const hit = kept.get(file.id);
  if (hit) return Promise.resolve(hit);
  const going = asking.get(file.id);
  if (going) return going;
  const started = fetchBytes(file.id).then((blob) => keep(file.id, new Blob([blob], { type: shownType(file) }))).finally(() => asking.delete(file.id));
  asking.set(file.id, started);
  return started;
}

export function forgetBytes(id?: number) {
  for (const [key, entry] of kept) if (id === undefined || key === id) { URL.revokeObjectURL(entry.url); kept.delete(key); }
}

/** Saves a file through a blob, always as plain bytes, always asking the server first. */
export async function saveFile(file: Pick<FileView, "id" | "name">) {
  const blob = await fetchBytes(file.id);
  const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
