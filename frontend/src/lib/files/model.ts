// What the file screens agree on, kept free of React so it can be tested alone: what a file can show, what stops an upload before a
// byte moves, what a filter means, and which of its states a screen is in.
import type { AttachedFile, Attached, FileDetails, FileHit, FileKind, FileLink, FilePage, FileState, FileStorage, FileView, StoreAnswer } from "../../../../xano/query/files";

export type { AttachedFile, Attached, FileDetails, FileHit, FileKind, FileLink, FilePage, FileState, FileStorage, FileView, StoreAnswer };

/** Where a file goes: a space, a conversation, or a record it's being attached to. */
export type Place = { type: "space" | "conversation" | "task" | "doc" | "company" | "contact" | "deal"; id: number };

export const KIND_LABELS: Record<FileKind, string> = { image: "Image", pdf: "PDF", text: "Text", document: "Document", sheet: "Spreadsheet", archive: "Archive", media: "Audio or video", other: "File" };
export const KIND_FILTERS = (["image", "pdf", "text", "document", "sheet", "archive", "media", "other"] as const).map((value) => ({ value, label: value === "other" ? "Other" : KIND_LABELS[value] }));
export const DATE_LABELS = { week: "Last 7 days", month: "Last 30 days", year: "Last year" } as const;
const DAYS: Record<keyof typeof DATE_LABELS, number> = { week: 7, month: 30, year: 365 };
export const DATE_FILTERS = Object.entries(DATE_LABELS).map(([value, label]) => ({ value, label }));

export type Preview = "image" | "pdf" | "text";
export const previewOf = (f: { kind: FileKind }): Preview | null => (f.kind === "image" || f.kind === "pdf" || f.kind === "text" ? f.kind : null);

const RUNS_CODE = /\.(html?|xhtml|shtml|mhtml|svgz?|xml)$/i;
/** The one line beside a file that won't open here. */
export const noPreviewReason = (f: { name: string; kind: FileKind }) => (RUNS_CODE.test(f.name)
  ? "HTML and SVG files can run code, so they only download."
  : `${f.kind === "other" ? "This file" : `${KIND_LABELS[f.kind]} files`} can't be shown here. Download it to open it.`);

const extensionOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");
/** A file's type as a person names it: a CSV is a CSV, though it previews as text. */
const NAMED: Record<string, string> = { csv: "CSV", tsv: "TSV", json: "JSON", md: "Markdown", zip: "ZIP archive", png: "PNG image", jpg: "JPEG image", jpeg: "JPEG image", gif: "GIF image", webp: "WebP image" };
export const typeOf = (f: Pick<FileView, "name" | "kind">) => NAMED[extensionOf(f.name)] ?? KIND_LABELS[f.kind];

export const shownSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(Math.round(mb * 10) / 10) ? Math.round(mb) : mb.toFixed(1)} MB`;
};

export type Refusal = { code: "too_big" | "wrong_type" | "empty"; message: string };

/** What's plain from the file alone, so a refusal costs nobody an upload. The server asks again: this is only a courtesy. */
export function precheck(file: { name: string; size: number }, limits: Pick<FileStorage, "max_upload_bytes" | "blocked_types"> | null): Refusal | null {
  if (!limits) return null;
  if (limits.blocked_types.includes(extensionOf(file.name))) return { code: "wrong_type", message: "This type of file can run on someone's computer, so it can't be shared here." };
  if (file.size === 0) return { code: "empty", message: "This file is empty." };
  if (file.size > limits.max_upload_bytes) return { code: "too_big", message: `This file is over the limit here, which is ${shownSize(limits.max_upload_bytes)}.` };
  return null;
}

export const sinceOf = (word: string, now: number): number | undefined => (word in DAYS ? now - DAYS[word as keyof typeof DAYS] * 86_400_000 : undefined);

export type FileFilters = { q: string; kind: string; date: string };
export const filtersFromQuery = (query: Partial<Record<keyof FileFilters, unknown>>): FileFilters => {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  return { q: text(query.q), kind: text(query.kind) in KIND_LABELS ? text(query.kind) : "", date: text(query.date) in DATE_LABELS ? text(query.date) : "" };
};

export const whereOf = (f: Pick<FileView, "space_name" | "dm_id" | "crm">) => f.space_name ?? (f.dm_id ? "Direct message" : f.crm ? "Customers" : "Nowhere");

export type ListState = "loading" | "failed" | "no-access" | "no-space" | "never" | "no-match" | "trash-empty" | "ready";

export function listState(o: { loaded: boolean; error: unknown; denied: boolean; spaces: number; ever: number; shown: number; filtered: boolean; trash: boolean }): ListState {
  if (o.denied) return "no-access";
  if (o.shown > 0) return "ready";
  if (!o.loaded) return o.error ? "failed" : "loading";
  if (o.filtered) return "no-match";
  if (o.trash) return "trash-empty";
  if (o.spaces === 0 && o.ever === 0) return "no-space";
  return "never";
}
