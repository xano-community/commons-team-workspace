// Files over HTTP. Each route is one line around its function in function/files/, so an agent's tool meets the same rule.
import { apiGroup, auth, c, expr, fl, inp, input, query, ref, respond, s, withFilters } from "@xano/sdk";
import type { InferRow } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { FILE_KINDS, file_record } from "../table/files/file_record.js";
import { gateActive } from "../function/members/gate.js";
import { bindBrowser } from "../function/access/reach.js";
import type { RecordView } from "./links.js";
import { attachFile, attachedFiles, deleteFile, fileBytes, fileLink, fileLinks, fileStorage, fileViews, listFiles, readFile, restoreFile, searchFiles, storeFile } from "../function/files/files.js";

export const filesGroup = apiGroup({ name: "files", canonical: "files", middleware: { pre: [gateActive] }, description: "Files: keeping them, finding them and getting their bytes." });

type Row = InferRow<typeof file_record>;
export type FileKind = (typeof FILE_KINDS)[number];
export type FileView = Pick<Row, "id" | "name" | "mime" | "size" | "scope" | "space_id" | "dm_id" | "crm" | "uploaded_by" | "run_id" | "created_at" | "deleted_at"> & { kind: FileKind; uploader_name: string | null; uploader_kind: "human" | "agent" | null; space_name: string | null;
  /** In a list: the record this file is most likely there for, and how many it's attached to. Its name comes from the resolver. */
  attached?: { type: string; id: number; count: number } | null };
export type FilePage = { items: FileView[]; ever: number; page: number; next_page: number | null; total: number; denied: boolean };
export type FileDetails = { state: "live" | "trashed" | "refused"; file: FileView | null; can_delete: boolean; archived: boolean };
export type FileLink = { how: "signed" | "table" | "refused" | "unavailable"; url: string | null };
export type FileStorage = { mode: "signed" | "table"; max_upload_bytes: number; blocked_types: string[]; most_on_a_message: number };
export type StoreAnswer = { ok: boolean; code: "" | "refused" | "wrong_type" | "too_big" | "empty" | "failed"; message: string; file: FileView | null; repeat: boolean };
export type FileState = { id: number; state: "live" | "locked" | "deleted"; file: FileView | null };
export type AttachedFile = FileView & { link_id: number };
export type Attached = { items: AttachedFile[]; can_add: boolean };
export type FileHit = { id: number; name: string; kind: FileKind; space_name: string | null };

const caller = () => [...rbac.signedIn(), ...bindBrowser()];
const who = () => ({ actor_id: auth("id"), browser: ref("browser") });
const text = () => input.text({ methods: ["trim"] });
const id = () => input.int({ required: true });

export const fileStorageRoute = query({
  apiGroup: filesGroup, auth: user, name: "file-storage", verb: "GET",
  description: "How this deployment keeps files, and the largest it takes.",
  stack: [...rbac.signedIn(), s.function.run({ fn: fileStorage, as: "storage" })],
  response: ref("storage"), responseShape: {} as FileStorage,
});

export const listFilesRoute = query({
  apiGroup: filesGroup, auth: user, name: "files", verb: "GET",
  description: "A page of the files you reach, in one space or everywhere.",
  input: { space_id: input.int(), kind: text(), since: input.int(), q: text(), trash: input.bool(), page: input.int() },
  stack: [...caller(), s.function.run({ fn: listFiles, as: "page", input: { ...who(), space_id: inp("space_id"), kind: inp("kind"), since: inp("since"), q: inp("q"), trash: inp("trash"), page: inp("page") } })],
  response: ref("page"), responseShape: {} as FilePage,
});

export const uploadFileRoute = query({
  apiGroup: filesGroup, auth: user, name: "files", verb: "POST",
  description: "Add a file to a space, a conversation or a record. A retry with the same client id answers the same row. Anything a person can run into answers 200 and says why.",
  input: { file: input.file(), client_id: input.text({ required: true }), place_type: input.text({ required: true }), place_id: id(), attach: input.bool() },
  stack: [
    ...caller(),
    s.function.run({ fn: storeFile, as: "answer", input: { ...who(), file: inp("file"), client_id: inp("client_id"), place_type: inp("place_type"), place_id: inp("place_id"), run_id: c.int(0) } }),
    s.conditional({ when: expr(inp("attach"), "=", c.bool(true)), then: [
      s.conditional({ when: expr(ref("answer.ok"), "=", c.bool(true)), then: [
        s.function.run({ fn: attachFile, as: "attached", input: { ...who(), id: ref("answer.file.id"), type: inp("place_type"), record_id: inp("place_id") } }),
      ] }),
    ] }),
  ],
  response: ref("answer"), responseShape: {} as StoreAnswer,
});

export const getFileRoute = query({
  apiGroup: filesGroup, auth: user, name: "files/{id}", verb: "GET",
  description: "One file, or a state saying why it can't be shown.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: readFile, as: "details", input: { ...who(), id: inp("id") } })],
  response: ref("details"), responseShape: {} as FileDetails,
});

export const fileLinkRoute = query({
  apiGroup: filesGroup, auth: user, name: "files/{id}/link", verb: "GET",
  description: "How to get this file's bytes right now. Ask this first: it answers 200 even when the answer is no.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: fileLink, as: "link", input: { ...who(), id: inp("id") } })],
  response: ref("link"), responseShape: {} as FileLink,
});

/**
 * The bytes, only ever to someone who reaches the file. Each header is here on purpose. Opened as a page, a file with its stored type
 * ran its script on this origin, and with these it downloads and runs nothing.
 */
export const rawFileRoute = query({
  apiGroup: filesGroup, auth: user, name: "files/{id}/raw", verb: "GET",
  description: "A table-stored file's bytes.",
  input: { id: id() },
  stack: [
    ...caller(),
    s.function.run({ fn: fileBytes, as: "stored", input: { ...who(), id: inp("id") } }),
    s.set_var("plain_name", withFilters(c.text("/[^A-Za-z0-9._ -]+/u"), fl.regex_replace(c.text("_"), ref("stored.name")))),
    s.set_var("encoded_name", withFilters(ref("stored.name"), fl.url_encode_rfc3986())),
    s.util.set_header({ value: withFilters(c.text("Content-Type: "), fl.concat(ref("stored.safe_type"))), duplicates: "replace" }),
    s.util.set_header({ value: withFilters(c.text('Content-Disposition: attachment; filename="'), fl.concat(ref("plain_name")), fl.concat(c.text(`"; filename*=UTF-8''`)), fl.concat(ref("encoded_name"))), duplicates: "replace" }),
    respond.header("X-Content-Type-Options", "nosniff"),
    respond.header("Content-Security-Policy", "sandbox; default-src 'none'"),
    respond.header("Cache-Control", "private, no-store"),
    s.set_var("bytes", withFilters(ref("stored.b64"), fl.base64_decode())),
  ],
  response: ref("bytes"),
  history: false,
});

export const deleteFileRoute = query({
  apiGroup: filesGroup, auth: user, name: "files/{id}", verb: "DELETE",
  description: "Put a file in the trash.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: deleteFile, as: "done", input: { ...who(), id: inp("id") } })],
  response: ref("done"), responseShape: {} as { ok: boolean },
});

export const restoreFileRoute = query({
  apiGroup: filesGroup, auth: user, name: "files/{id}/restore", verb: "POST",
  description: "Bring a file back from the trash.",
  input: { id: id() },
  stack: [...caller(), s.function.run({ fn: restoreFile, as: "done", input: { ...who(), id: inp("id") } })],
  response: ref("done"), responseShape: {} as { ok: boolean },
});

export const fileViewsRoute = query({
  apiGroup: filesGroup, auth: user, name: "file-views", verb: "POST",
  description: "How each of these files looks to you.",
  input: { ids: input.json({ required: true }) },
  stack: [...caller(), s.function.run({ fn: fileViews, as: "views", input: { ...who(), ids: inp("ids") } })],
  response: ref("views"), responseShape: [] as FileState[],
});

export const attachedFilesRoute = query({
  apiGroup: filesGroup, auth: user, name: "file-attachments", verb: "GET",
  description: "The files attached to a record.",
  input: { type: input.text({ required: true }), id: id() },
  stack: [...caller(), s.function.run({ fn: attachedFiles, as: "attached", input: { ...who(), type: inp("type"), id: inp("id") } })],
  response: ref("attached"), responseShape: {} as Attached,
});

export const fileLinksRoute = query({
  apiGroup: filesGroup, auth: user, name: "files/{id}/links", verb: "GET",
  description: "What a file links to and what links to it.",
  input: { id: id(), page: input.int() },
  stack: [...caller(), s.function.run({ fn: fileLinks, as: "links", input: { ...who(), id: inp("id"), page: inp("page") } })],
  response: ref("links"), responseShape: {} as { forward: (RecordView & { link_id: number })[]; backlinks: (RecordView & { link_id: number })[]; backlinks_total: number; next_page: number | null },
});

export const searchFilesRoute = query({
  apiGroup: filesGroup, auth: user, name: "file-search", verb: "GET",
  description: "Files you reach whose name matches.",
  input: { q: text() },
  stack: [...caller(), s.function.run({ fn: searchFiles, as: "found", input: { ...who(), q: inp("q") } })],
  response: ref("found"), responseShape: [] as FileHit[],
});

export const fileQueries = [fileStorageRoute, listFilesRoute, uploadFileRoute, getFileRoute, fileLinkRoute, rawFileRoute, deleteFileRoute, restoreFileRoute, fileViewsRoute, attachedFilesRoute, fileLinksRoute, searchFilesRoute];
