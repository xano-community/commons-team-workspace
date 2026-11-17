// Files. Bytes never reach a browser on trust: the server names each file's kind, and every read asks the access rule first. A
// deployment that can sign keeps bytes in private storage and hands out 60-second links. One that can't keeps them in a table, behind
// an authed route. The answer comes from signing a real file, because a made-up path fails even where signing works.
//
// Nothing someone can run into is an HTTP error here. A refusal, a file that's too big and a person who lost access all answer 200 with
// a reason, so a screen says so in its own words and the browser's console stays clean.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, or, ref, s, statements, task as scheduledTask, withFilters, type Value } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { space } from "../../table/spaces/space.js";
import { file_blob } from "../../table/files/file_blob.js";
import { file_record } from "../../table/files/file_record.js";
import { record_link } from "../../table/links/record_link.js";
import { canCreate, canManage, canReach, NOT_FOUND, reachOf, requireReach } from "../access/reach.js";
import { createLink, forgetRecord, listLinks } from "../links/links.js";
import { locate } from "../links/records.js";

const who = { actor_id: input.int({ required: true }), browser: input.bool() };
const me = { actor: inp("actor_id"), browser: inp("browser") };

/** The largest file a table holds: what stayed clean with five downloads at once. */
export const TABLE_LIMIT = 5 * 1024 * 1024;
/** The largest file private storage takes through this route. */
export const SIGNED_LIMIT = 25 * 1024 * 1024;
const LINK_SECONDS = 60;
const PROBE_SECONDS = 5;
const LONGEST_NAME = 200;
const A_PAGE = 50;
const SEARCH_RESULTS = 8;
const MOST_AT_ONCE = 100;
export const MOST_ON_A_MESSAGE = 10;
const MOST_ON_A_RECORD = 50;
const PURGE_AFTER = "-30 days";

const IMAGES = ["png", "jpg", "jpeg", "gif", "webp"];
const TEXTS = ["txt", "md", "markdown", "csv", "tsv", "json", "log", "yaml", "yml"];
const DOCUMENTS = ["doc", "docx", "ppt", "pptx", "key", "pages", "odt", "odp", "rtf"];
const SHEETS = ["xls", "xlsx", "numbers", "ods"];
const ARCHIVES = ["zip", "tar", "gz", "tgz", "7z", "rar"];
const MEDIA = ["mp3", "wav", "m4a", "mp4", "mov", "webm"];
/** Each can run script when a browser opens it. They're kept, and only ever leave as a download. */
const NEVER_SHOWN = ["html", "htm", "xhtml", "shtml", "mhtml", "svg", "svgz", "xml"];
/** What runs on a double-click, which has no place in a shared folder. */
export const BLOCKED_TYPES = ["exe", "msi", "bat", "cmd", "com", "scr", "pif", "vbs", "ps1", "jar", "apk", "dmg", "pkg"];
const PLACES = ["space", "conversation", "task", "doc", "company", "contact", "deal"];
const BYTES = "application/octet-stream";
const TEXT_TYPE = "text/plain; charset=utf-8";

const inList = (list: readonly string[], value: Value) => expr(withFilters(c.array([...list]), fl.in(value)), "=", c.bool(true));
const failed = (code: string, message: Value) => s.return(obj({ ok: c.bool(false), code: c.text(code), message, file: c.null(), repeat: c.bool(false) }));

const LIST_FIELDS = ["id", "name", "mime", "size", "kind", "scope", "space_id", "dm_id", "crm", "uploaded_by", "run_id", "created_at", "deleted_at", "uploader_name", "uploader_kind", "space_name"];
const withNames = {
  bind: [
    { table: user, as: "uploader", join: "left" as const, where: expr(col("uploaded_by"), "=", col("uploader.id")) },
    { table: space, as: "home", join: "left" as const, where: expr(col("space_id"), "=", col("home.id")) },
  ],
  eval: [{ name: "uploader.name", as: "uploader_name" }, { name: "uploader.kind", as: "uploader_kind" }, { name: "home.name", as: "space_name" }],
};

/** A name as this app keeps it. Platforms clean names differently, so it's done here: no path, no control characters, a sane length. */
export const cleanName = defineFunction({
  name: "files/clean_name",
  description: "A file's name with any path and control characters taken out.",
  input: { name: input.text() },
  stack: [
    s.set_var("flat", withFilters(c.text("/\\\\/u"), fl.regex_replace(c.text("/"), inp("name")))),
    s.set_var("last", withFilters(ref("flat"), fl.split("/"), fl.last())),
    s.set_var("plain", withFilters(c.text("/[\\x00-\\x1f\\x7f]+/u"), fl.regex_replace(c.text(""), ref("last")))),
    s.set_var("clean", withFilters(ref("plain"), fl.trim(), fl.substr(c.int(0), c.int(LONGEST_NAME)))),
    s.conditional({ when: expr(withFilters(c.array(["", ".", ".."]), fl.in(ref("clean"))), "=", c.bool(true)), then: [s.update_var("clean", c.text("Untitled file"))] }),
  ],
  response: ref("clean"),
});

/** What a file is, read from its name and its stated type together. A disagreement goes the safe way. */
export const sniffFile = defineFunction({
  name: "files/sniff",
  description: "A file's kind, the type it goes out with, and whether it's refused.",
  input: { name: input.text(), mime: input.text() },
  stack: [
    s.set_var("ext", c.text("")),
    s.set_var("parts", withFilters(inp("name"), fl.split("."))),
    s.conditional({ when: expr(withFilters(ref("parts"), fl.count()), ">", c.int(1)), then: [s.update_var("ext", withFilters(ref("parts"), fl.last(), fl.lower()))] }),
    s.set_var("stated", withFilters(inp("mime"), fl.lower())),
    s.set_var("unsure", withFilters(c.array(["", BYTES]), fl.in(ref("stated")))),
    s.set_var("kind", c.text("other")),
    s.set_var("safe_type", c.text(BYTES)),
    s.set_var("risky", withFilters(c.array([...NEVER_SHOWN]), fl.in(ref("ext")))),
    s.conditional({ when: or(
      expr(withFilters(ref("stated"), fl.contains(c.text("html"))), "=", c.bool(true)),
      expr(withFilters(ref("stated"), fl.contains(c.text("svg"))), "=", c.bool(true)),
      expr(withFilters(c.array(["text/xml", "application/xml"]), fl.in(ref("stated"))), "=", c.bool(true)),
    ), then: [s.update_var("risky", c.bool(true))] }),
    s.conditional({ when: expr(ref("risky"), "=", c.bool(false)), then: [
      s.conditional({ when: and(inList(IMAGES, ref("ext")), or(expr(ref("unsure"), "=", c.bool(true)), expr(withFilters(ref("stated"), fl.substr(c.int(0), c.int(6))), "=", c.text("image/")))), then: [
        s.update_var("kind", c.text("image")),
        s.update_var("safe_type", withFilters(c.text("image/"), fl.concat(ref("ext")))),
        s.conditional({ when: expr(ref("ext"), "=", c.text("jpg")), then: [s.update_var("safe_type", c.text("image/jpeg"))] }),
      ] }),
      s.conditional({ when: and(expr(ref("kind"), "=", c.text("other")), or(
        and(expr(ref("ext"), "=", c.text("pdf")), or(expr(ref("unsure"), "=", c.bool(true)), expr(ref("stated"), "=", c.text("application/pdf")))),
        and(expr(ref("ext"), "=", c.text("")), expr(ref("stated"), "=", c.text("application/pdf"))),
      )), then: [s.update_var("kind", c.text("pdf")), s.update_var("safe_type", c.text("application/pdf"))] }),
      s.conditional({ when: and(expr(ref("kind"), "=", c.text("other")), or(inList(TEXTS, ref("ext")), and(expr(ref("ext"), "=", c.text("")), expr(ref("stated"), "=", c.text("text/plain"))))), then: [
        s.update_var("kind", c.text("text")), s.update_var("safe_type", c.text(TEXT_TYPE)),
      ] }),
      s.conditional({ when: expr(ref("kind"), "=", c.text("other")), then: [
        s.conditional({ when: inList(DOCUMENTS, ref("ext")), then: [s.update_var("kind", c.text("document"))] }),
        s.conditional({ when: inList(SHEETS, ref("ext")), then: [s.update_var("kind", c.text("sheet"))] }),
        s.conditional({ when: inList(ARCHIVES, ref("ext")), then: [s.update_var("kind", c.text("archive"))] }),
        s.conditional({ when: inList(MEDIA, ref("ext")), then: [s.update_var("kind", c.text("media"))] }),
      ] }),
    ] }),
  ],
  response: { kind: ref("kind"), safe_type: ref("safe_type"), blocked: withFilters(c.array([...BLOCKED_TYPES]), fl.in(ref("ext"))), ext: ref("ext") },
});

/** Where a new file would live, and whether this person may put it there. Tasks and docs need what adding one needs, and a thread needs what speaking in it needs. */
export const placeFile = defineFunction({
  name: "files/place",
  description: "Whether an actor may add a file to a record, and the scope it would live in.",
  input: { ...who, type: input.text({ required: true }), id: input.int({ required: true }) },
  stack: [
    s.set_var("reason", c.text("")),
    s.conditional({ when: expr(withFilters(c.array(PLACES), fl.in(inp("type"))), "=", c.bool(false)), then: [s.update_var("reason", c.text("Files can't go there."))] }),
    s.function.run({ fn: locate, as: "home", input: { type: inp("type"), id: inp("id") } }),
    s.function.run({ fn: canReach, as: "reachable", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: inp("type"), id: inp("id") } }),
    s.conditional({ when: expr(ref("reachable"), "!=", c.bool(true)), then: [s.update_var("reason", c.text("You don't have access to this any more."))] }),
    s.conditional({ when: expr(ref("reason"), "=", c.text("")), then: [
      s.conditional({ when: expr(ref("home.archived"), "=", c.bool(true)), then: [s.update_var("reason", c.text("This space is archived, so nothing can be added."))] }),
      s.conditional({ when: expr(ref("home.trashed"), "=", c.bool(true)), then: [s.update_var("reason", c.text("This record is in the trash."))] }),
      s.conditional({ when: and(expr(inp("type"), "!=", c.text("conversation")), expr(ref("home.space_id"), ">", c.int(0)), expr(ref("reason"), "=", c.text(""))), then: [
        s.function.run({ fn: canCreate, as: "can_add", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: ref("home.space_id") } }),
        s.conditional({ when: expr(ref("can_add"), "!=", c.bool(true)), then: [s.update_var("reason", c.text("This space's managers decide who can add files."))] }),
      ] }),
    ] }),
  ],
  response: { ok: c.expression('$var.reason == ""'), reason: ref("reason"), scope: ref("home.scope"), space_id: ref("home.space_id"), dm_id: ref("home.dm_id"), crm: ref("home.crm") },
});

/**
 * Writes the row, and the bytes if they live in a table. If either write fails nothing stays behind, in the tables or in storage: a
 * person retrying must not leave copies nobody can find. Answers the row's id, or 0.
 */
export const keepFile = defineFunction({
  name: "files/keep",
  description: "Write a file's row and bytes, or leave nothing at all.",
  input: {
    actor_id: input.int({ required: true }), name: input.text(), mime: input.text(), size: input.int(), kind: input.text(), safe_type: input.text(), mode: input.text(), attachment: input.json(), b64: input.text(), key: input.text(),
    scope: input.text(), space_id: input.int(), dm_id: input.int(), crm: input.bool(), run_id: input.int(),
  },
  stack: [
    s.set_var("kept", c.int(0)),
    s.set_var("path", withFilters(inp("attachment"), fl.get("path", ""))),
    // One transaction, so a failure anywhere in it leaves no row and no bytes in a table, and only storage needs cleaning up.
    s.try_catch({
      try: [s.db.transaction({ body: [
        guard.require(expr(withFilters(inp("name"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "A file needs a name." }),
        s.db.add({ table: file_record, as: "made", row: {
          name: inp("name"), mime: inp("mime"), size: inp("size"), kind: inp("kind"), safe_type: inp("safe_type"), mode: inp("mode"), attachment: inp("attachment"), scope: inp("scope"), space_id: inp("space_id"), dm_id: inp("dm_id"), crm: inp("crm"),
          uploaded_by: inp("actor_id"), run_id: inp("run_id"), client_id: inp("key"), is_demo: c.bool(false),
        } }),
        s.conditional({ when: expr(inp("mode"), "=", c.text("table")), then: [
          guard.require(expr(withFilters(inp("b64"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "This file's bytes are missing." }),
          s.db.add({ table: file_blob, as: "bytes", row: { file_id: ref("made.id"), b64: inp("b64") } }),
        ] }),
        s.update_var("kept", ref("made.id")),
      ] })],
      catch: [
        s.update_var("kept", c.int(0)),
        s.conditional({ when: expr(ref("path"), "!=", c.text("")), then: [s.storage.delete_file({ pathname: ref("path") })] }),
      ],
    }),
    s.conditional({ when: expr(ref("kept"), ">", c.int(0)), then: [
      s.set_var("link", withFilters(c.text("/files/"), fl.concat(ref("kept")))),
      // A DM's files reach its members through the message they came with, so they aren't announced anywhere.
      s.conditional({ when: expr(inp("crm"), "=", c.bool(true)), then: [changed({ entity: "file", id: ref("kept"), op: "created", verb: "added", actor: inp("actor_id"), link: ref("link"), title: "added a file", crm: true })] }),
      s.conditional({ when: expr(inp("space_id"), ">", c.int(0)), then: [changed({ entity: "file", id: ref("kept"), op: "created", verb: "added", actor: inp("actor_id"), space: inp("space_id"), link: ref("link"), title: "added a file" })] }),
      s.conditional({ when: expr(inp("dm_id"), ">", c.int(0)), then: [s.function.run({ fn: "search/index", as: "indexed", input: { type: c.text("file"), id: ref("kept") } })] }),
    ] }),
  ],
  response: ref("kept"),
});

/** One file, as a reader gets it. The stored path never leaves the server. */
const viewOf = (id: Value, as: string) => s.db.query({ table: file_record, where: cmp(col("id"), "=", id), returnType: "single", ...withNames, output: LIST_FIELDS, as });

/**
 * Takes a file in. A retry under the same client id answers the row it made. Bytes go to private storage, and signing that very file
 * says whether this deployment can read them back: if not, they come out of storage and go in a table.
 */
export const storeFile = defineFunction({
  name: "files/store",
  description: "Keep an uploaded file where its place says, in whichever way this deployment can read back.",
  input: { ...who, file: input.file(), client_id: input.text(), place_type: input.text({ required: true }), place_id: input.int({ required: true }), run_id: input.int() },
  stack: [
    guard.require(and(expr(withFilters(inp("client_id"), fl.strlen()), ">=", c.int(1)), expr(withFilters(inp("client_id"), fl.strlen()), "<=", c.int(64))), { errorType: "badrequest", message: "This file has no usable id." }),
    s.set_var("key", withFilters(inp("actor_id"), fl.to_text(), fl.concat(c.text(":")), fl.concat(inp("client_id")))),
    s.function.run({ fn: placeFile, as: "place", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: inp("place_type"), id: inp("place_id") } }),
    s.conditional({ when: expr(ref("place.ok"), "=", c.bool(false)), then: [failed("refused", ref("place.reason"))] }),
    s.db.query({ table: file_record, where: cmp(col("client_id"), "=", ref("key")), output: ["id"], returnType: "single", as: "before" }),
    s.conditional({ when: expr(ref("before"), "!=", c.null()), then: [
      s.set_var("before_id", ref("before.id", { safe: true })),
      viewOf(ref("before_id"), "view"),
      s.return(obj({ ok: c.bool(true), code: c.text(""), message: c.text(""), file: ref("view"), repeat: c.bool(true) })),
    ] }),
    s.storage.read_file_resource({ as: "res", value: inp("file") }),
    s.function.run({ fn: cleanName, as: "name", input: { name: ref("res.name") } }),
    s.function.run({ fn: sniffFile, as: "seen", input: { name: ref("name"), mime: ref("res.mime") } }),
    s.conditional({ when: expr(ref("seen.blocked"), "=", c.bool(true)), then: [failed("wrong_type", c.text("This type of file can run on someone's computer, so it can't be shared here."))] }),
    s.conditional({ when: expr(ref("res.size"), "=", c.int(0)), then: [failed("empty", c.text("This file is empty."))] }),
    s.conditional({ when: expr(ref("res.size"), ">", c.int(SIGNED_LIMIT)), then: [failed("too_big", c.text("This file is over the upload limit."))] }),
    s.set_var("mode", c.text("signed")),
    s.set_var("attachment", c.null()),
    s.set_var("b64", c.text("")),
    s.try_catch({
      try: [
        s.storage.create_attachment({ as: "stored", value: inp("file"), access: "private" }),
        s.update_var("attachment", ref("stored")),
        s.storage.sign_private_url({ pathname: ref("stored.path"), ttl: c.int(PROBE_SECONDS), as: "probed" }),
      ],
      catch: [
        s.conditional({ when: expr(ref("attachment"), "!=", c.null()), then: [s.storage.delete_file({ pathname: ref("attachment.path", { safe: true }) })] }),
        s.update_var("mode", c.text("table")),
        s.update_var("attachment", c.null()),
      ],
    }),
    s.conditional({ when: expr(ref("mode"), "=", c.text("table")), then: [
      s.conditional({ when: expr(ref("res.size"), ">", c.int(TABLE_LIMIT)), then: [failed("too_big", c.text("This file is over the upload limit."))] }),
      s.update_var("b64", withFilters(ref("res.data"), fl.base64_encode())),
    ] }),
    s.function.run({ fn: keepFile, as: "kept", input: {
      actor_id: inp("actor_id"), name: ref("name"), mime: ref("res.mime"), size: ref("res.size"), kind: ref("seen.kind"), safe_type: ref("seen.safe_type"), mode: ref("mode"), attachment: ref("attachment"), b64: ref("b64"), key: ref("key"),
      scope: ref("place.scope"), space_id: ref("place.space_id"), dm_id: ref("place.dm_id"), crm: ref("place.crm"), run_id: inp("run_id"),
    } }),
    // Losing a race to the same retry isn't a failure: the other copy is the file.
    s.set_var("file_id", ref("kept")),
    s.conditional({ when: expr(ref("file_id"), "=", c.int(0)), then: [
      s.db.query({ table: file_record, where: cmp(col("client_id"), "=", ref("key")), output: ["id"], returnType: "single", as: "winner" }),
      s.conditional({ when: expr(ref("winner"), "=", c.null()), then: [failed("failed", c.text("This file couldn't be saved. Try again."))] }),
      s.update_var("file_id", ref("winner.id", { safe: true })),
    ] }),
    viewOf(ref("file_id"), "view"),
  ],
  response: { ok: c.bool(true), code: c.text(""), message: c.text(""), file: ref("view"), repeat: c.bool(false) },
  responseShape: {} as { ok: boolean; code: string; message: string; file: unknown; repeat: boolean },
});

/** Binds `row`, and answers whether this actor reaches it. A file that's gone and a file out of reach read the same. */
const bindReach = statements(
  s.db.get({ table: file_record, fieldValue: inp("id"), as: "row" }),
  s.function.run({ fn: canReach, as: "reachable", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: c.text("file"), id: inp("id") } }),
);

/** Whether an actor may delete a file: whoever added it, or whoever runs where it lives. */
const canChange = defineFunction({
  name: "files/can_change",
  description: "Whether an actor may delete or restore a file.",
  input: { ...who, uploaded_by: input.int(), space_id: input.int(), crm: input.bool() },
  stack: [
    s.set_var("allowed", c.expression("$input.uploaded_by == $input.actor_id")),
    s.conditional({ when: expr(inp("space_id"), ">", c.int(0)), then: [
      s.function.run({ fn: canManage, as: "manages", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: inp("space_id") } }),
      s.conditional({ when: expr(ref("manages"), "=", c.bool(true)), then: [s.update_var("allowed", c.bool(true))] }),
    ] }),
    s.conditional({ when: expr(inp("crm"), "=", c.bool(true)), then: [
      s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["role"], as: "actor" }),
      s.conditional({ when: rbac.has(ref("actor.role", { safe: true }), "crm.manage"), then: [s.update_var("allowed", c.bool(true))] }),
    ] }),
  ],
  response: ref("allowed"),
});

/** What a file's own screen needs. Nobody gets a refusal to show the browser: `state` says which screen to draw. */
export const readFile = defineFunction({
  name: "files/read",
  description: "One file as this viewer may see it, or a state saying why not.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...bindReach,
    s.conditional({ when: or(expr(ref("row"), "=", c.null()), expr(ref("reachable"), "!=", c.bool(true))), then: [s.return(obj({ state: c.text("refused"), file: c.null(), can_delete: c.bool(false), archived: c.bool(false) }))] }),
    viewOf(inp("id"), "view"),
    s.function.run({ fn: locate, as: "place", input: { type: c.text("file"), id: inp("id") } }),
    s.function.run({ fn: canChange, as: "allowed", input: { actor_id: inp("actor_id"), browser: inp("browser"), uploaded_by: ref("row.uploaded_by", { safe: true }), space_id: ref("row.space_id", { safe: true }), crm: ref("row.crm", { safe: true }) } }),
    s.set_var("state", c.text("live")),
    s.conditional({ when: expr(ref("row.deleted_at", { safe: true }), "!=", c.null()), then: [s.update_var("state", c.text("trashed"))] }),
  ],
  response: { state: ref("state"), file: ref("view"), can_delete: ref("allowed"), archived: ref("place.archived") },
  responseShape: {} as { state: string; file: unknown; can_delete: boolean; archived: boolean },
});

/**
 * The one question before any bytes move. `how` is `signed` with a 60-second link, `table` for the authed route, `refused`, or
 * `unavailable` when storage won't sign right now. Each row stays on the path it was written with.
 */
export const fileLink = defineFunction({
  name: "files/link",
  description: "How this viewer gets a file's bytes right now.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...bindReach,
    s.conditional({ when: or(expr(ref("row"), "=", c.null()), expr(ref("reachable"), "!=", c.bool(true)), expr(ref("row.deleted_at", { safe: true }), "!=", c.null())), then: [s.return(obj({ how: c.text("refused"), url: c.null() }))] }),
    s.set_var("how", c.text("table")),
    s.set_var("url", c.null()),
    s.conditional({ when: expr(ref("row.mode", { safe: true }), "=", c.text("signed")), then: [
      s.set_var("path", ref("row.attachment.path", { safe: true })),
      s.try_catch({
        try: [s.storage.sign_private_url({ pathname: ref("path"), ttl: c.int(LINK_SECONDS), as: "signed" }), s.update_var("url", ref("signed")), s.update_var("how", c.text("signed"))],
        catch: [s.update_var("how", c.text("unavailable"))],
      }),
    ] }),
  ],
  response: { how: ref("how"), url: ref("url") },
  responseShape: {} as { how: string; url: string | null },
});

/** The bytes of a table-stored file. Anything short of a live row in reach is not found. The route adds the headers. */
export const fileBytes = defineFunction({
  name: "files/bytes",
  description: "A table-stored file's name, type and bytes, for someone who reaches it.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...requireReach({ ...me, type: "file", id: inp("id") }),
    s.db.get({ table: file_record, fieldValue: inp("id"), output: ["name", "safe_type", "deleted_at"], as: "row" }),
    guard.found("row", { errorType: "notfound", message: NOT_FOUND }),
    guard.require(expr(ref("row.deleted_at"), "=", c.null()), { errorType: "notfound", message: NOT_FOUND }),
    s.db.get({ table: file_blob, fieldName: "file_id", fieldValue: inp("id"), as: "blob" }),
    guard.found("blob", { errorType: "notfound", message: NOT_FOUND }),
  ],
  response: { name: ref("row.name"), safe_type: ref("row.safe_type"), b64: ref("blob.b64") },
});

const bindPlaces = statements(
  s.set_var("places", ref("reach.scopes")),
  s.set_var("denied", c.bool(false)),
  s.conditional({ when: expr(inp("space_id"), ">", c.int(0)), then: [
    s.set_var("wanted", withFilters(c.text("space-"), fl.concat(inp("space_id")))),
    s.update_var("places", withFilters(c.array([]), fl.array_push(ref("wanted")))),
    s.conditional({ when: expr(withFilters(ref("reach.scopes"), fl.in(ref("wanted"))), "=", c.bool(false)), then: [s.update_var("denied", c.bool(true)), s.update_var("places", c.array([]))] }),
  ] }),
);

/** A file's work comes first: the task it's for, then a doc, then a conversation, then a customer. */
const ATTACHED_ORDER = ["task", "doc", "message", "conversation", "deal", "company", "contact"];
const MOST_LINKS_A_PAGE = 500;
/**
 * Each listed file's `attached`: the one record it's most likely there for, by type and id, and how many it's attached to. Only the
 * reference: the name comes from the record resolver, filtered for the viewer like every other chip, so this costs one read a page.
 */
const attachedTo = [
  s.array.map({ source: ref("rows.items"), as: "page_ids", transform: ref("$this.id") }),
  s.db.query({ table: record_link, where: [cmp(col("from_type"), "=", c.text("file")), cmp(col("from_id"), "in", ref("page_ids"))], sort: [{ sortBy: "id", dir: "asc" }],
    paging: { per_page: MOST_LINKS_A_PAGE, metadata: false }, output: ["from_id", "to_type", "to_id"], as: "file_links" }),
  s.set_var("items", c.array([])),
  s.foreach({ list: ref("rows.items"), as: "row", body: [
    s.array.filter({ expr: ref("file_links"), if: expr(ref("$this.from_id"), "=", ref("row.id")), as: "mine" }),
    s.set_var("pick", c.null()),
    s.foreach({ list: c.array(ATTACHED_ORDER), as: "kind", body: [
      s.conditional({ when: expr(ref("pick"), "=", c.null()), then: [
        s.array.find({ expr: ref("mine"), if: expr(ref("$this.to_type"), "=", ref("kind")), as: "found" }),
        s.update_var("pick", ref("found")),
      ] }),
    ] }),
    s.conditional({ when: and(expr(ref("pick"), "=", c.null()), expr(withFilters(ref("mine"), fl.count()), ">", c.int(0))), then: [s.update_var("pick", withFilters(ref("mine"), fl.first()))] }),
    s.set_var("attached", c.null()),
    s.conditional({ when: expr(ref("pick"), "!=", c.null()), then: [s.update_var("attached", obj({ type: ref("pick.to_type"), id: ref("pick.to_id"), count: withFilters(ref("mine"), fl.count()) }))] }),
    s.update_var("items", withFilters(ref("items"), fl.array_push(withFilters(ref("row"), fl.set("attached", ref("attached")))))),
  ] }),
];

/** A page of what this viewer reaches, newest first. A space out of reach is `denied`, which a screen shows as a state and not an error. */
export const listFiles = defineFunction({
  name: "files/list",
  description: "A page of the files an actor reaches, in one space or everywhere, by kind, date and name.",
  input: { ...who, space_id: input.int(), kind: input.text(), since: input.int(), q: input.text(), trash: input.bool(), page: input.int() },
  stack: [
    reachOf(inp("actor_id"), inp("browser")),
    ...bindPlaces,
    s.db.query({ table: file_record, where: [cmp(col("scope"), "in", ref("places")), cmp(col("deleted_at"), "=", c.null())], returnType: "count", as: "ever" }),
    s.conditional({
      when: expr(inp("trash"), "=", c.bool(true)),
      then: [s.db.query({ table: file_record, as: "rows", ...withNames, where: [cmp(col("scope"), "in", ref("places")), cmp(col("deleted_at"), "!=", c.null()), cmp(col("name"), "includes", inp("q"), { ignoreEmpty: true })],
        sort: [{ sortBy: "deleted_at", dir: "desc" }], paging: { page: inp("page"), per_page: A_PAGE, metadata: true, totals: true }, output: ["curPage", "nextPage", "itemsTotal", ...LIST_FIELDS.map((name) => `items.${name}`)] })],
      else: [s.db.query({ table: file_record, as: "rows", ...withNames, where: [cmp(col("scope"), "in", ref("places")), cmp(col("deleted_at"), "=", c.null()), cmp(col("kind"), "=", inp("kind"), { ignoreEmpty: true }), expr(col("created_at"), ">=", inp("since")), cmp(col("name"), "includes", inp("q"), { ignoreEmpty: true })],
        sort: [{ sortBy: "created_at", dir: "desc" }], paging: { page: inp("page"), per_page: A_PAGE, metadata: true, totals: true }, output: ["curPage", "nextPage", "itemsTotal", ...LIST_FIELDS.map((name) => `items.${name}`)] })],
    }),
    ...attachedTo,
  ],
  response: { items: ref("items"), ever: ref("ever"), page: ref("rows.curPage"), next_page: ref("rows.nextPage"), total: ref("rows.itemsTotal"), denied: ref("denied") },
});

/** For a person looking for a file to link. Finds only what they reach. */
export const searchFiles = defineFunction({
  name: "files/search",
  description: "Files an actor reaches whose name matches.",
  input: { ...who, q: input.text() },
  stack: [
    reachOf(inp("actor_id"), inp("browser")),
    s.db.query({ table: file_record, as: "rows", bind: [withNames.bind[1]], eval: [withNames.eval[2]], where: [cmp(col("scope"), "in", ref("reach.scopes")), cmp(col("deleted_at"), "=", c.null()), cmp(col("name"), "includes", inp("q"))], sort: [{ sortBy: "created_at", dir: "desc" }], paging: { per_page: SEARCH_RESULTS, metadata: false }, output: ["id", "name", "kind", "space_name"] }),
  ],
  response: ref("rows"),
});

/** Files named by id, in the order asked, each saying how it looks to this viewer. A message's tiles read through here. */
export const fileViews = defineFunction({
  name: "files/views",
  description: "How each of these files looks to this viewer.",
  input: { ...who, ids: input.json() },
  stack: [
    guard.require(expr(withFilters(inp("ids"), fl.count()), "<=", c.int(MOST_AT_ONCE)), { errorType: "badrequest", message: `Ask for ${MOST_AT_ONCE} files at most.` }),
    reachOf(inp("actor_id"), inp("browser")),
    s.db.query({ table: file_record, as: "rows", ...withNames, where: cmp(col("id"), "in", inp("ids")), output: LIST_FIELDS }),
    s.set_var("views", c.array([])),
    s.foreach({ list: inp("ids"), as: "wanted", body: [
      s.array.find({ expr: ref("rows"), if: expr(ref("$this.id"), "=", ref("wanted")), as: "hit" }),
      s.set_var("state", c.text("deleted")),
      s.set_var("file", c.null()),
      s.conditional({ when: expr(ref("hit"), "!=", c.null()), then: [
        s.conditional({
          when: expr(withFilters(ref("reach.scopes"), fl.in(ref("hit.scope", { safe: true }))), "=", c.bool(false)),
          then: [s.update_var("state", c.text("locked"))],
          else: [s.conditional({ when: expr(ref("hit.deleted_at", { safe: true }), "=", c.null()), then: [s.update_var("state", c.text("live")), s.update_var("file", ref("hit"))] })],
        }),
      ] }),
      s.update_var("views", withFilters(ref("views"), fl.array_push(obj({ id: ref("wanted"), state: ref("state"), file: ref("file") })))),
    ] }),
  ],
  response: ref("views"),
});

/** What's attached to a record, for someone who reaches it. A file out of their reach isn't there at all. */
export const attachedFiles = defineFunction({
  name: "files/attached",
  description: "The files attached to a record, newest first, as this viewer may see them.",
  input: { ...who, type: input.text({ required: true }), id: input.int({ required: true }) },
  stack: [
    ...requireReach({ ...me, type: inp("type"), id: inp("id") }),
    reachOf(inp("actor_id"), inp("browser")),
    s.db.query({ table: record_link, where: [cmp(col("to_type"), "=", inp("type")), cmp(col("to_id"), "=", inp("id")), cmp(col("from_type"), "=", c.text("file")), cmp(col("from_scope"), "in", ref("reach.scopes"))], sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: MOST_ON_A_RECORD, metadata: false }, output: ["id", "from_id"], as: "links" }),
    s.array.map({ source: ref("links"), as: "ids", transform: ref("$this.from_id") }),
    s.db.query({ table: file_record, as: "rows", ...withNames, where: [cmp(col("id"), "in", ref("ids")), cmp(col("deleted_at"), "=", c.null())], output: LIST_FIELDS }),
    s.set_var("items", c.array([])),
    s.foreach({ list: ref("links"), as: "link", body: [
      s.array.find({ expr: ref("rows"), if: expr(ref("$this.id"), "=", ref("link.from_id")), as: "hit" }),
      s.conditional({ when: expr(ref("hit"), "!=", c.null()), then: [s.update_var("items", withFilters(ref("items"), fl.array_push(withFilters(ref("hit"), fl.set("link_id", ref("link.id"))))))] }),
    ] }),
    s.function.run({ fn: placeFile, as: "place", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: inp("type"), id: inp("id") } }),
  ],
  response: { items: ref("items"), can_add: ref("place.ok") },
});

/** A file's links, for its own screen. Someone who has just lost the file gets none, rather than a refusal in their console. */
export const fileLinks = defineFunction({
  name: "files/links",
  description: "What a file links to and what links to it, or nothing for someone who no longer reaches it.",
  input: { ...who, id: input.int({ required: true }), page: input.int() },
  stack: [
    s.function.run({ fn: canReach, as: "reachable", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: c.text("file"), id: inp("id") } }),
    s.conditional({ when: expr(ref("reachable"), "!=", c.bool(true)), then: [s.return(obj({ forward: c.array([]), backlinks: c.array([]), backlinks_total: c.int(0), next_page: c.null() }))] }),
    s.function.run({ fn: listLinks, as: "links", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: c.text("file"), id: inp("id"), page: inp("page") } }),
  ],
  response: ref("links"),
  responseShape: {} as { forward: unknown[]; backlinks: unknown[]; backlinks_total: number; next_page: number | null },
});

/** Attaches a file to the place it was uploaded for. Reach on both ends, as for any link. */
export const attachFile = defineFunction({
  name: "files/attach",
  description: "Attach a file to a record.",
  input: { ...who, id: input.int({ required: true }), type: input.text({ required: true }), record_id: input.int({ required: true }) },
  stack: [s.function.run({ fn: createLink, as: "link", input: { actor_id: inp("actor_id"), browser: inp("browser"), from_type: c.text("file"), from_id: inp("id"), to_type: inp("type"), to_id: inp("record_id") } })],
  response: ref("link"),
});

const tell = (op: "deleted" | "updated", verb: string, title: string) => statements(
  s.set_var("link", withFilters(c.text("/files/"), fl.concat(inp("id")))),
  s.conditional({ when: expr(ref("row.crm", { safe: true }), "=", c.bool(true)), then: [changed({ entity: "file", id: inp("id"), op, verb, actor: inp("actor_id"), link: ref("link"), title, crm: true })] }),
  s.conditional({ when: expr(ref("row.space_id", { safe: true }), ">", c.int(0)), then: [changed({ entity: "file", id: inp("id"), op, verb, actor: inp("actor_id"), space: ref("row.space_id", { safe: true }), link: ref("link"), title })] }),
  s.conditional({ when: expr(ref("row.dm_id", { safe: true }), ">", c.int(0)), then: [s.function.run({ fn: "search/index", as: "indexed", input: { type: c.text("file"), id: inp("id") } })] }),
);
const editable = statements(
  ...bindReach,
  guard.require(and(expr(ref("row"), "!=", c.null()), expr(ref("reachable"), "=", c.bool(true))), { errorType: "notfound", message: NOT_FOUND }),
  s.function.run({ fn: canChange, as: "allowed", input: { actor_id: inp("actor_id"), browser: inp("browser"), uploaded_by: ref("row.uploaded_by", { safe: true }), space_id: ref("row.space_id", { safe: true }), crm: ref("row.crm", { safe: true }) } }),
  guard.require(expr(ref("allowed"), "=", c.bool(true)), { errorType: "accessdenied", message: "Only whoever added this file, or someone who manages where it lives, can do that." }),
  s.function.run({ fn: locate, as: "place", input: { type: c.text("file"), id: inp("id") } }),
  guard.require(expr(ref("place.archived"), "=", c.bool(false)), { errorType: "badrequest", message: "This space is archived." }),
);

export const deleteFile = defineFunction({
  name: "files/delete",
  description: "Put a file in the trash. It reads Deleted everywhere, and it can come back for 30 days.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...editable,
    s.conditional({ when: expr(ref("row.deleted_at", { safe: true }), "=", c.null()), then: [
      s.db.patch({ table: file_record, fieldValue: inp("id"), data: obj({ deleted_at: c.now() }) }),
      ...tell("deleted", "deleted", "deleted a file"),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

export const restoreFile = defineFunction({
  name: "files/restore",
  description: "Bring a file back from the trash.",
  input: { ...who, id: input.int({ required: true }) },
  stack: [
    ...editable,
    s.db.patch({ table: file_record, fieldValue: inp("id"), data: obj({ deleted_at: c.null() }) }),
    ...tell("updated", "restored", "restored a file"),
  ],
  response: { ok: c.bool(true) },
});

/** Files on a message must already live where the message does, and be the sender's own. A file can't be carried past a space's walls. */
export const requireMessageFiles = defineFunction({
  name: "files/require_for_message",
  description: "Refuse files that a message in this conversation can't carry.",
  input: { actor_id: input.int({ required: true }), conversation_id: input.int({ required: true }), file_ids: input.json() },
  stack: [
    guard.require(expr(withFilters(inp("file_ids"), fl.count()), "<=", c.int(MOST_ON_A_MESSAGE)), { errorType: "badrequest", message: `Send ${MOST_ON_A_MESSAGE} files at most in one message.` }),
    s.function.run({ fn: locate, as: "home", input: { type: c.text("conversation"), id: inp("conversation_id") } }),
    s.db.query({ table: file_record, where: [cmp(col("id"), "in", inp("file_ids")), cmp(col("scope"), "=", ref("home.scope")), cmp(col("uploaded_by"), "=", inp("actor_id")), cmp(col("deleted_at"), "=", c.null())], returnType: "count", as: "usable" }),
    guard.require(expr(ref("usable"), "=", withFilters(inp("file_ids"), fl.count())), { errorType: "badrequest", message: "One of these files can't be sent here." }),
  ],
  response: { ok: c.bool(true) },
});

/** The storage question, asked of a real one-byte file that's removed again, and what follows from the answer. */
export const fileStorage = defineFunction({
  name: "files/storage",
  description: "How this deployment keeps files, and the largest it takes.",
  stack: [
    s.set_var("mode", c.text("signed")),
    s.storage.create_file_resource({ as: "tiny", filename: c.text("storage-check.txt"), filedata: c.text("x") }),
    s.storage.create_attachment({ as: "check", value: ref("tiny"), access: "private" }),
    s.try_catch({
      try: [s.storage.sign_private_url({ pathname: ref("check.path"), ttl: c.int(PROBE_SECONDS), as: "probed" })],
      catch: [s.update_var("mode", c.text("table"))],
    }),
    s.storage.delete_file({ pathname: ref("check.path") }),
    s.set_var("most", c.int(SIGNED_LIMIT)),
    s.conditional({ when: expr(ref("mode"), "=", c.text("table")), then: [s.update_var("most", c.int(TABLE_LIMIT))] }),
  ],
  response: { mode: ref("mode"), max_upload_bytes: ref("most"), blocked_types: c.array(BLOCKED_TYPES), most_on_a_message: c.int(MOST_ON_A_MESSAGE) },
});

/** What 30 days in the trash ends in: the bytes, wherever they are, the row and its links. A chip that pointed at it reads Deleted. */
export const purgeFiles = defineFunction({
  name: "files/purge",
  description: "Remove files that have been in the trash for over 30 days, and their stored bytes.",
  stack: [
    s.set_var("cutoff", withFilters(c.now(), fl.epochms_transform(PURGE_AFTER))),
    s.db.query({ table: file_record, where: [cmp(col("deleted_at"), "!=", c.null()), expr(col("deleted_at"), "<", ref("cutoff"))], paging: { per_page: 500, metadata: false }, as: "old" }),
    s.foreach({ list: ref("old"), as: "item", body: [
      s.conditional({ when: expr(ref("item.mode"), "=", c.text("signed")), then: [
        s.set_var("path", ref("item.attachment.path", { safe: true })),
        s.try_catch({ try: [s.storage.delete_file({ pathname: ref("path") })], catch: [] }),
      ] }),
      s.db.bulk.delete({ table: file_blob, where: cmp(col("file_id"), "=", ref("item.id")), as: "bytes_gone" }),
      s.function.run({ fn: forgetRecord, as: "forgotten", input: { type: c.text("file"), id: ref("item.id") } }),
      s.db.del({ table: file_record, fieldValue: ref("item.id") }),
    ] }),
  ],
  response: { files: withFilters(ref("old"), fl.count()) },
});

export const purgeFilesDaily = scheduledTask({
  name: "files_purge_daily",
  description: "Remove files that have been in the trash for over 30 days.",
  schedule: [{ startsOn: "2026-01-01T04:00:00Z", freq: 86_400, repeatEnabled: true }],
  stack: [s.function.run({ fn: purgeFiles, as: "purged" })],
});

export const fileFunctions = [cleanName, sniffFile, placeFile, keepFile, storeFile, canChange, readFile, fileLink, fileBytes, listFiles, searchFiles, fileViews, attachedFiles, fileLinks, attachFile, deleteFile, restoreFile, requireMessageFiles, fileStorage, purgeFiles];
