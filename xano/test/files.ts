// Workflow tests for files: who reaches a file, what refuses one, and what's left behind. A real upload, a real download, an SVG opened
// in a browser and a signed link need a deployed backend, so frontend/scripts/files-check.mjs proves those on each target.
import { c, cmp, col, expr, fl, obj, ref, s, withFilters, workflowTest as plainTest, type Value } from "@xano/sdk";
import { saveFile } from "../agents/tools.js";
import { attachFile, cleanName, fileBytes, keepFile, purgeFiles, sniffFile, storeFile } from "../function/files/files.js";
import { companyPanelsRoute, createCompanyRoute } from "../query/crm.js";
import {
  attachedFilesRoute, deleteFileRoute, fileLinkRoute, fileStorageRoute, fileViewsRoute, getFileRoute, listFilesRoute, restoreFileRoute, searchFilesRoute,
} from "../query/files.js";
import { getLinks, resolveLinks } from "../query/links.js";
import { deleteMessageRoute, listMessages, postMessageRoute } from "../query/messages.js";
import { removeSpaceMemberRoute } from "../query/spaces.js";
import { createProjectRoute, createTaskRoute } from "../query/tasks.js";
import { agent_run } from "../table/agents/agent_run.js";
import { file_blob } from "../table/files/file_blob.js";
import { file_record } from "../table/files/file_record.js";
import { record_link } from "../table/links/record_link.js";
import { conversation } from "../table/messaging/conversation.js";
import { space } from "../table/spaces/space.js";
import { user } from "../table/user.js";
import { bearer, channel, dm, joined, makeSpace, missesText, no, person, personToken, rowsTest as workflowTest, seesText, settings, yes } from "./access.js";

const call = (api: Parameters<typeof s.api.call>[0]["api"], token: string, as: string, input: Record<string, Value> = {}) => s.api.call({ api, headers: bearer(token), as, input });
const equal = (name: string, value: Value) => s.expect.to_equal({ expr: ref(name), value });
const is = (name: string, n: number) => equal(name, c.int(n));
const text = (name: string, value: string) => equal(name, c.text(value));
const count = (name: string, n: number) => s.expect.to_equal({ expr: withFilters(ref(name), fl.count()), value: c.int(n) });
const rows = (table: Parameters<typeof s.db.query>[0]["table"], as: string) => s.db.query({ table, returnType: "count", as });

/** A small file, as a resource: what an upload hands the server. */
const resource = (as: string, name: string, body = "hello") => s.storage.create_file_resource({ as, filename: c.text(name), filedata: c.text(body) });
/** Stores a file as `who`, into a place, the way the upload route does. */
const store = (who: string, as: string, name: string, place: [type: string, id: Value], body = "hello", browser = true) => [
  resource(`${as}_res`, name, body),
  s.function.run({ fn: storeFile, as, input: { actor_id: ref(`${who}.id`), browser: c.bool(browser), file: ref(`${as}_res`), client_id: c.text(`${as}-id`), place_type: c.text(place[0]), place_id: place[1], run_id: c.int(0) } }),
];
/** `to_throw` runs in a stack of its own, so a refusal finds its rows again by name. */
const someone = (key: string) => s.db.query({ table: user, where: cmp(col("email"), "=", c.text(`${key}@access-test.example`)), returnType: "single", as: key });
const fileNamed = (name: string, as = "found") => s.db.query({ table: file_record, where: cmp(col("name"), "=", c.text(name)), returnType: "single", as });
const conversationNamed = (key: string) => s.db.query({ table: conversation, where: cmp(col("name"), "=", c.text(key)), returnType: "single", as: "place" });
const spaceNamed = (key: string) => s.db.query({ table: space, where: cmp(col("name"), "=", c.text(`Space ${key}`)), returnType: "single", as: "home" });
const inSpace = (key: string): [string, Value] => ["space", ref(`${key}.id`)];
/** Binds `there`: whether a fresh link to this stored path finds a file. Signing a missing path can refuse, and fetching one can raise. */
const stillThere = (path: string) => [
  s.set_var("there", c.bool(false)),
  s.try_catch({ try: [
    s.storage.sign_private_url({ pathname: ref(path), ttl: c.int(30), as: "signed" }),
    s.api.request({ url: ref("signed"), method: "GET", as: "fetched" }),
    s.conditional({ when: expr(ref("fetched.response.status"), "=", c.int(200)), then: [s.update_var("there", c.bool(true))] }),
  ], catch: [] }),
];
const fileIdsOf = (...keys: string[]) => keys.reduce((list, k) => withFilters(list, fl.array_push(ref(`${k}.file.id`))), c.array([]) as Value);

/** Ada runs space A, Ben is a member, Vic is in the workspace and not in it, Gus is a guest in it. Ann is an admin. */
const team = [
  settings(), person("ann", "admin"), person("ada"), person("ben"), person("vic"), person("gus", "guest"), makeSpace("a"), joined("a", "ada", "manager"), joined("a", "ben"), joined("a", "gus"), channel("chat", "a"),
  personToken("ann", "ann_token"), personToken("ada", "ada_token"), personToken("ben", "ben_token"), personToken("vic", "vic_token"), personToken("gus", "gus_token"),
];
const scoutRow = s.db.add({ table: user, as: "scout", row: { name: c.text("Agent scout"), email: c.null(), password: c.null(), role: c.text("agent"), kind: c.text("agent"), agent_mode: c.text("hosted"), brief: c.text("Write things down."), sponsor_id: ref("ada.id"), status: c.text("active"), is_demo: c.bool(false) } });
const scoutNow = s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent scout")), returnType: "single", as: "scout" });
const runNow = s.db.query({ table: agent_run, sort: [{ sortBy: "id", dir: "desc" }], returnType: "single", as: "run" });
const runIn = (as: string, thread: Value, spaceId: Value) => s.db.add({ table: agent_run, as, row: {
  agent_id: ref("scout.id"), requested_by: ref("ada.id"), source_type: c.text("message"), source_id: c.int(0), space_id: spaceId, dm_id: c.int(0), thread_id: thread, status: c.text("working"), attempt: c.int(1), is_demo: c.bool(false), started_at: c.now(),
} });

export const fileTests = [
  workflowTest({
    name: "files: a member lists, opens and fetches a file in their space, and an outsider finds nothing",
    stack: [
      ...team, ...store("ada", "up", "brief.txt", inSpace("a")),
      yes("up.ok"), text("up.file.kind", "text"),
      s.expect.to_equal({ expr: ref("up.file.scope"), value: withFilters(c.text("space-"), fl.concat(ref("a.id"))) }),
      call(listFilesRoute, "ben_token", "seen", { space_id: ref("a.id") }), count("seen.items", 1), is("seen.ever", 1), no("seen.denied"), text("seen.items.0.name", "brief.txt"), text("seen.items.0.uploader_name", "Test ada"),
      missesText("seen", "attachment"), missesText("seen", "b64"),
      call(fileLinkRoute, "ben_token", "link", { id: ref("up.file.id") }),
      s.expect.to_be_true({ expr: withFilters(c.array(["signed", "table"]), fl.in(ref("link.how"))) }),
      call(listFilesRoute, "vic_token", "vic_list", { space_id: ref("a.id") }), count("vic_list.items", 0), yes("vic_list.denied"), is("vic_list.ever", 0),
      call(listFilesRoute, "vic_token", "vic_all"), count("vic_all.items", 0),
      call(getFileRoute, "vic_token", "vic_read", { id: ref("up.file.id") }), text("vic_read.state", "refused"), missesText("vic_read", "brief"),
      call(fileLinkRoute, "vic_token", "vic_link", { id: ref("up.file.id") }), text("vic_link.how", "refused"), equal("vic_link.url", c.null()),
      s.expect.to_throw({ body: [someone("vic"), fileNamed("brief.txt"), s.function.call({ fn: fileBytes, as: "stolen", input: { actor_id: ref("vic.id"), browser: c.bool(true), id: ref("found.id") } })], exception: c.text("Not found.") }),
      call(fileViewsRoute, "vic_token", "vic_views", { ids: withFilters(c.array([]), fl.array_push(ref("up.file.id"))) }), text("vic_views.0.state", "locked"), equal("vic_views.0.file", c.null()),
      call(searchFilesRoute, "vic_token", "vic_found", { q: c.text("brief") }), count("vic_found", 0),
      call(searchFilesRoute, "ben_token", "ben_found", { q: c.text("brief") }), count("ben_found", 1),
      call(fileLinkRoute, "ann_token", "admin_link", { id: ref("up.file.id") }),
      s.expect.to_be_true({ expr: withFilters(c.array(["signed", "table"]), fl.in(ref("admin_link.how"))) }),
    ],
  }),
  workflowTest({
    name: "files: removal from a space refuses the very next download, and what they saw before says nothing now",
    stack: [
      ...team, ...store("ada", "up", "board.txt", inSpace("a")),
      call(fileLinkRoute, "ben_token", "before", { id: ref("up.file.id") }),
      s.expect.to_be_true({ expr: withFilters(c.array(["signed", "table"]), fl.in(ref("before.how"))) }),
      s.api.call({ api: removeSpaceMemberRoute, headers: bearer("ada_token"), as: "gone", input: { id: ref("a.id"), user_id: ref("ben.id") } }),
      call(fileLinkRoute, "ben_token", "after", { id: ref("up.file.id") }), text("after.how", "refused"), equal("after.url", c.null()),
      s.expect.to_throw({ body: [someone("ben"), fileNamed("board.txt"), s.function.call({ fn: fileBytes, as: "stolen", input: { actor_id: ref("ben.id"), browser: c.bool(true), id: ref("found.id") } })], exception: c.text("Not found.") }),
    ],
  }),
  plainTest({
    name: "files: a retry under the same client id stores once, and one person's id can't answer another's",
    stack: [
      ...team, ...store("ada", "first", "once.txt", inSpace("a")), ...store("ada", "first", "once.txt", inSpace("a")),
      yes("first.repeat"), rows(file_record, "made"), is("made", 1),
      resource("again_res", "once.txt"),
      s.function.run({ fn: storeFile, as: "other", input: { actor_id: ref("ben.id"), browser: c.bool(true), file: ref("again_res"), client_id: c.text("first-id"), place_type: c.text("space"), place_id: ref("a.id"), run_id: c.int(0) } }),
      no("other.repeat"), rows(file_record, "both"), is("both", 2),
    ],
  }),
  plainTest({
    name: "files: a wrong type, a stranger, a guest and a place files can't go are each refused with a reason, and nothing is kept",
    stack: [
      ...team,
      ...store("ada", "bad", "setup.EXE", inSpace("a")), no("bad.ok"), text("bad.code", "wrong_type"),
      ...store("vic", "stranger", "ok.txt", inSpace("a")), no("stranger.ok"), text("stranger.code", "refused"),
      ...store("gus", "guest", "ok.txt", inSpace("a")), no("guest.ok"), text("guest.code", "refused"),
      ...store("ada", "nowhere", "ok.txt", ["message", c.int(1)]), no("nowhere.ok"), text("nowhere.code", "refused"),
      rows(file_record, "kept"), is("kept", 0), rows(file_blob, "bytes"), is("bytes", 0),
    ],
  }),
  plainTest({
    name: "files: storage says which mode applies and its limit, and a file on that path reads back",
    stack: [
      ...team, call(fileStorageRoute, "gus_token", "storage"), seesText("storage.blocked_types", "exe"),
      s.conditional({
        when: expr(ref("storage.mode"), "=", c.text("table")),
        then: [is("storage.max_upload_bytes", 5 * 1024 * 1024), ...store("ada", "up", "t.txt", inSpace("a"), "stored bytes"),
          s.function.call({ fn: fileBytes, as: "read", input: { actor_id: ref("ben.id"), browser: c.bool(true), id: ref("up.file.id") } }), s.expect.to_equal({ expr: withFilters(ref("read.b64"), fl.base64_decode()), value: c.text("stored bytes") })],
        else: [is("storage.max_upload_bytes", 25 * 1024 * 1024), ...store("ada", "up", "s.txt", inSpace("a"), "stored bytes"),
          rows(file_blob, "in_table"), is("in_table", 0),
          call(fileLinkRoute, "ben_token", "link", { id: ref("up.file.id") }), text("link.how", "signed"),
          s.expect.to_contain({ expr: ref("link.url"), value: c.text("http") })],
      }),
    ],
  }),
  workflowTest({
    name: "files: a failed row write leaves no row, no bytes and no stored file",
    stack: [
      ...team, ...store("ada", "up", "first.txt", inSpace("a")), rows(file_record, "before"), rows(file_blob, "bytes_before"),
      s.db.get({ table: file_record, fieldValue: ref("up.file.id"), as: "row" }),
      // A private file of its own, handed over as if a row were about to hold it. A row with no name can't be written.
      resource("spare_res", "spare.txt"),
      s.storage.create_attachment({ as: "spare", value: ref("spare_res"), access: "private" }),
      s.function.call({ fn: keepFile, as: "kept", input: {
        actor_id: ref("ada.id"), name: c.text(""), mime: c.text("text/plain"), size: c.int(5), kind: c.text("text"), safe_type: c.text("text/plain"), mode: c.text("signed"), attachment: ref("spare"), b64: c.text(""), key: c.text("spare-key"),
        scope: ref("row.scope"), space_id: ref("row.space_id"), dm_id: c.int(0), crm: c.bool(false), run_id: c.int(0),
      } }),
      is("kept", 0), rows(file_record, "after"), equal("after", ref("before")), rows(file_blob, "bytes_after"), equal("bytes_after", ref("bytes_before")),
      // Once it's gone, signing it either refuses or gives a link to nothing.
      ...stillThere("spare.path"), no("there"),
      // The same for a table write: a row whose bytes can't be written doesn't stay.
      s.function.call({ fn: keepFile, as: "kept_table", input: {
        actor_id: ref("ada.id"), name: c.text("spare.txt"), mime: c.text("text/plain"), size: c.int(5), kind: c.text("text"), safe_type: c.text("text/plain"), mode: c.text("table"), attachment: c.null(), b64: c.text(""), key: c.text("fresh-key"),
        scope: ref("row.scope"), space_id: ref("row.space_id"), dm_id: c.int(0), crm: c.bool(false), run_id: c.int(0),
      } }),
      is("kept_table", 0), rows(file_record, "after_table"), equal("after_table", ref("before")),
    ],
  }),
  plainTest({
    name: "files: HTML and SVG never get a type a browser shows, whatever they claim, and names lose their paths",
    stack: [
      s.function.call({ fn: sniffFile, as: "svg", input: { name: c.text("logo.svg"), mime: c.text("image/svg+xml") } }), text("svg.kind", "other"), text("svg.safe_type", "application/octet-stream"),
      s.function.call({ fn: sniffFile, as: "html", input: { name: c.text("page.HTML"), mime: c.text("text/html") } }), text("html.kind", "other"), text("html.safe_type", "application/octet-stream"),
      s.function.call({ fn: sniffFile, as: "lie", input: { name: c.text("photo.png"), mime: c.text("text/html") } }), text("lie.kind", "other"), text("lie.safe_type", "application/octet-stream"),
      s.function.call({ fn: sniffFile, as: "lie2", input: { name: c.text("notes.txt"), mime: c.text("image/svg+xml") } }), text("lie2.kind", "other"),
      s.function.call({ fn: sniffFile, as: "evil_text", input: { name: c.text("page.html"), mime: c.text("text/plain") } }), text("evil_text.kind", "other"),
      s.function.call({ fn: sniffFile, as: "png", input: { name: c.text("photo.PNG"), mime: c.text("image/png") } }), text("png.kind", "image"), text("png.safe_type", "image/png"),
      s.function.call({ fn: sniffFile, as: "jpg", input: { name: c.text("photo.jpg"), mime: c.text("image/jpeg") } }), text("jpg.safe_type", "image/jpeg"),
      s.function.call({ fn: sniffFile, as: "pdf", input: { name: c.text("deck.pdf"), mime: c.text("application/pdf") } }), text("pdf.kind", "pdf"), text("pdf.safe_type", "application/pdf"),
      s.function.call({ fn: sniffFile, as: "csv", input: { name: c.text("specs.csv"), mime: c.text("") } }), text("csv.kind", "text"),
      s.function.call({ fn: sniffFile, as: "xlsx", input: { name: c.text("plan.xlsx"), mime: c.text("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") } }), text("xlsx.kind", "sheet"), text("xlsx.safe_type", "application/octet-stream"),
      s.function.call({ fn: sniffFile, as: "exe", input: { name: c.text("a.b.exe"), mime: c.text("") } }), yes("exe.blocked"),
      s.function.call({ fn: cleanName, as: "up", input: { name: c.text("../../etc/passwd") } }), s.expect.to_equal({ expr: ref("up"), value: c.text("passwd") }),
      s.function.call({ fn: cleanName, as: "win", input: { name: c.text("C:\\temp\\report.pdf") } }), s.expect.to_equal({ expr: ref("win"), value: c.text("report.pdf") }),
      s.function.call({ fn: cleanName, as: "dots", input: { name: c.text("..") } }), s.expect.to_equal({ expr: ref("dots"), value: c.text("Untitled file") }),
      s.function.call({ fn: cleanName, as: "keep", input: { name: c.text("board pack é.pdf") } }), s.expect.to_equal({ expr: ref("keep"), value: c.text("board pack é.pdf") }),
    ],
  }),
  workflowTest({
    name: "files: a message carries its own files and nobody else's, a files-only message sends, and deleting it hides them",
    stack: [
      ...team, ...dm("private", "ada", "ben"),
      ...store("ada", "up", "hero.txt", ["conversation", ref("chat.id")]), yes("up.ok"),
      s.expect.to_equal({ expr: ref("up.file.scope"), value: withFilters(c.text("space-"), fl.concat(ref("a.id"))) }),
      call(postMessageRoute, "ada_token", "sent", { id: ref("chat.id"), client_msg_id: c.text("m1"), body: c.text(""), file_ids: fileIdsOf("up") }),
      call(listMessages, "ben_token", "log", { id: ref("chat.id") }), s.expect.to_equal({ expr: ref("log.items.0.file_ids.0"), value: ref("up.file.id") }),
      call(getLinks, "ben_token", "used", { type: c.text("message"), id: ref("sent.message.id") }), seesText("used.backlinks", "hero.txt"),
      s.expect.to_throw({ body: [someone("ben"), personToken("ben", "token"), fileNamed("hero.txt", "up"), conversationNamed("Channel chat"), call(postMessageRoute, "token", "stolen", { id: ref("place.id"), client_msg_id: c.text("m2"), body: c.text("mine now"), file_ids: withFilters(c.array([]), fl.array_push(ref("up.id"))) })], exception: c.text("One of these files can't be sent here.") }),
      s.expect.to_throw({ body: [someone("ada"), personToken("ada", "token"), fileNamed("hero.txt", "up"), conversationNamed("DM private"), call(postMessageRoute, "token", "moved", { id: ref("place.id"), client_msg_id: c.text("m3"), body: c.text("over the wall"), file_ids: withFilters(c.array([]), fl.array_push(ref("up.id"))) })], exception: c.text("One of these files can't be sent here.") }),
      s.expect.to_throw({ body: [someone("ada"), personToken("ada", "token"), conversationNamed("Channel chat"), call(postMessageRoute, "token", "blank", { id: ref("place.id"), client_msg_id: c.text("m4"), body: c.text("") })], exception: c.text("Write something first.") }),
      ...store("ada", "secret", "dm.txt", ["conversation", ref("private.id")]),
      s.expect.to_equal({ expr: ref("secret.file.scope"), value: withFilters(c.text("dm-"), fl.concat(ref("private.id"))) }),
      call(fileLinkRoute, "ann_token", "admin_dm", { id: ref("secret.file.id") }), text("admin_dm.how", "refused"),
      call(fileLinkRoute, "ben_token", "member_dm", { id: ref("secret.file.id") }), s.expect.to_be_true({ expr: withFilters(c.array(["signed", "table"]), fl.in(ref("member_dm.how"))) }),
      call(deleteMessageRoute, "ada_token", "gone", { id: ref("sent.message.id") }),
      call(listMessages, "ben_token", "after", { id: ref("chat.id") }), count("after.items.0.file_ids", 0),
    ],
  }),
  plainTest({
    name: "files: a file sits on a task and a company, a company's panel counts it, and only those who reach it see it",
    stack: [
      ...team,
      call(createProjectRoute, "ada_token", "launch", { space_id: ref("a.id"), name: c.text("Launch") }),
      call(createTaskRoute, "ada_token", "job", { project_id: ref("launch.id"), client_id: c.text("job-id"), title: c.text("Ship it"), status: c.text("todo"), priority: c.text("none") }),
      ...store("ada", "spec", "spec.txt", ["task", ref("job.id")]), yes("spec.ok"),
      s.function.call({ fn: attachFile, as: "on_task", input: { actor_id: ref("ada.id"), browser: c.bool(true), id: ref("spec.file.id"), type: c.text("task"), record_id: ref("job.id") } }),
      call(attachedFilesRoute, "ben_token", "on_job", { type: c.text("task"), id: ref("job.id") }), count("on_job.items", 1), text("on_job.items.0.name", "spec.txt"), yes("on_job.can_add"),
      call(attachedFilesRoute, "gus_token", "guest_job", { type: c.text("task"), id: ref("job.id") }), no("guest_job.can_add"),
      call(createCompanyRoute, "ada_token", "acme", { client_id: c.text("acme-id"), name: c.text("Acme") }),
      s.function.call({ fn: attachFile, as: "on_company", input: { actor_id: ref("ada.id"), browser: c.bool(true), id: ref("spec.file.id"), type: c.text("company"), record_id: ref("acme.id") } }),
      ...store("ada", "contract", "contract.txt", ["company", ref("acme.id")]), yes("contract.ok"), text("contract.file.scope", "crm"), yes("contract.file.crm"),
      s.function.call({ fn: attachFile, as: "contract_on", input: { actor_id: ref("ada.id"), browser: c.bool(true), id: ref("contract.file.id"), type: c.text("company"), record_id: ref("acme.id") } }),
      call(companyPanelsRoute, "ada_token", "ada_panels", { id: ref("acme.id") }), is("ada_panels.files.total", 2), seesText("ada_panels.files.items", "spec.txt"),
      call(companyPanelsRoute, "vic_token", "vic_panels", { id: ref("acme.id") }), is("vic_panels.files.total", 1), missesText("vic_panels.files.items", "spec.txt"), seesText("vic_panels.files.items", "contract.txt"),
      call(fileLinkRoute, "gus_token", "guest_crm", { id: ref("contract.file.id") }), text("guest_crm.how", "refused"),
      call(resolveLinks, "gus_token", "chip", { items: withFilters(c.array([]), fl.array_push(obj({ type: c.text("file"), id: ref("contract.file.id") }))) }), text("chip.0.state", "locked"), text("chip.0.title", ""),
      equal("chip.0.detail", c.obj({})),
      // Files says what each file is attached to: the task before the company, with how many in all. The row reads its task's state.
      call(listFilesRoute, "ben_token", "listed", { space_id: ref("a.id") }), count("listed.items", 1),
      text("listed.items.0.attached.type", "task"), equal("listed.items.0.attached.id", ref("job.id")), is("listed.items.0.attached.count", 2),
      call(resolveLinks, "ben_token", "task_row", { items: withFilters(c.array([]), fl.array_push(obj({ type: c.text("task"), id: ref("job.id") }))) }),
      text("task_row.0.detail.status", "todo"), equal("task_row.0.detail.person_id", c.int(0)),
    ],
  }),
  workflowTest({
    name: "files: whoever added a file or manages its space can delete it, a deleted file refuses downloads, and it comes back",
    stack: [
      ...team, ...store("ben", "up", "draft.txt", inSpace("a")),
      s.expect.to_throw({ body: [someone("gus"), personToken("gus", "token"), fileNamed("draft.txt"), call(deleteFileRoute, "token", "no_guest", { id: ref("found.id") })], exception: c.text("Only whoever added this file, or someone who manages where it lives, can do that.") }),
      call(getFileRoute, "ada_token", "manager", { id: ref("up.file.id") }), yes("manager.can_delete"),
      call(getFileRoute, "gus_token", "guest", { id: ref("up.file.id") }), no("guest.can_delete"),
      call(deleteFileRoute, "ada_token", "gone", { id: ref("up.file.id") }),
      call(fileLinkRoute, "ben_token", "dead", { id: ref("up.file.id") }), text("dead.how", "refused"),
      call(getFileRoute, "ben_token", "trashed", { id: ref("up.file.id") }), text("trashed.state", "trashed"),
      call(listFilesRoute, "ben_token", "list", { space_id: ref("a.id") }), count("list.items", 0), is("list.ever", 0),
      call(listFilesRoute, "ben_token", "bin", { space_id: ref("a.id"), trash: c.bool(true) }), count("bin.items", 1),
      call(resolveLinks, "ben_token", "chip", { items: withFilters(c.array([]), fl.array_push(obj({ type: c.text("file"), id: ref("up.file.id") }))) }), text("chip.0.state", "deleted"),
      call(restoreFileRoute, "ben_token", "back", { id: ref("up.file.id") }),
      call(fileLinkRoute, "ben_token", "alive", { id: ref("up.file.id") }), s.expect.to_be_true({ expr: withFilters(c.array(["signed", "table"]), fl.in(ref("alive.how"))) }),
    ],
  }),
  workflowTest({
    name: "files: purge removes stored bytes, the row and its links after 30 days, and leaves a recent delete alone",
    stack: [
      ...team, ...store("ada", "old", "old.txt", inSpace("a")), ...store("ada", "recent", "recent.txt", inSpace("a")), ...store("ada", "kept", "kept.txt", inSpace("a")),
      s.db.add({ table: record_link, as: "link", row: { from_type: c.text("file"), from_id: ref("old.file.id"), to_type: c.text("space"), to_id: ref("a.id"), origin: c.text("manual"), from_scope: ref("old.file.scope"), created_by: ref("ada.id") } }),
      s.db.get({ table: file_record, fieldValue: ref("old.file.id"), as: "old_row" }),
      s.db.patch({ table: file_record, fieldValue: ref("old.file.id"), data: obj({ deleted_at: withFilters(c.now(), fl.epochms_transform("-31 days")) }) }),
      s.db.patch({ table: file_record, fieldValue: ref("recent.file.id"), data: obj({ deleted_at: withFilters(c.now(), fl.epochms_transform("-2 days")) }) }),
      s.function.call({ fn: purgeFiles, as: "purged" }), is("purged.files", 1),
      rows(file_record, "left"), is("left", 2),
      s.db.query({ table: file_blob, where: cmp(col("file_id"), "=", ref("old.file.id")), returnType: "count", as: "old_bytes" }), is("old_bytes", 0),
      s.db.query({ table: record_link, where: cmp(col("from_id"), "=", ref("old.file.id")), returnType: "count", as: "old_links" }), is("old_links", 0),
      // On a signed target the stored file itself is gone: a fresh link to its path finds nothing.
      s.conditional({ when: expr(ref("old_row.mode"), "=", c.text("signed")), then: [
        ...stillThere("old_row.attachment.path"), no("there"),
      ] }),
    ],
  }),
  workflowTest({
    name: "files: an agent saves a file where its run is, shows as its author, and can't reach past that",
    stack: [
      ...team, scoutRow, makeSpace("b"), joined("b", "scout"), joined("a", "scout"), channel("other", "b"),
      runIn("run", ref("chat.id"), ref("a.id")),
      s.function.call({ fn: saveFile, as: "saved", input: { actor_id: ref("scout.id"), run_id: ref("run.id"), approved_by: ref("ben.id"), name: c.text("summary.md"), content: c.text("# Summary"), space_id: c.int(0), link_type: c.text(""), link_id: c.int(0) } }),
      call(getFileRoute, "ben_token", "read", { id: ref("saved.id") }), text("read.state", "live"), text("read.file.uploader_kind", "agent"), text("read.file.kind", "text"), s.expect.to_equal({ expr: ref("read.file.run_id"), value: ref("run.id") }),
      s.expect.to_throw({ body: [scoutNow, runNow, conversationNamed("Channel other"), s.function.call({ fn: saveFile, as: "elsewhere", input: { actor_id: ref("scout.id"), run_id: ref("run.id"), name: c.text("x.txt"), content: c.text("x"), space_id: c.int(0), link_type: c.text("conversation"), link_id: ref("place.id") } })], exception: c.text("Not found.") }),
      s.expect.to_throw({ body: [scoutNow, runNow, s.function.call({ fn: saveFile, as: "binary", input: { actor_id: ref("scout.id"), run_id: ref("run.id"), approved_by: c.int(1), name: c.text("run.exe"), content: c.text("x"), space_id: c.int(0), link_type: c.text(""), link_id: c.int(0) } })], exception: c.text("This type of file can run on someone's computer, so it can't be shared here.") }),
      s.expect.to_throw({ body: [scoutNow, s.function.call({ fn: saveFile, as: "unplaced", input: { actor_id: ref("scout.id"), run_id: c.int(0), name: c.text("x.txt"), content: c.text("x"), space_id: c.int(0), link_type: c.text(""), link_id: c.int(0) } })], exception: c.text("Say which space the file belongs in.") }),
      s.expect.to_throw({ body: [someone("vic"), spaceNamed("a"), s.function.call({ fn: saveFile, as: "outside", input: { actor_id: ref("vic.id"), run_id: c.int(0), name: c.text("x.txt"), content: c.text("x"), space_id: ref("home.id"), link_type: c.text(""), link_id: c.int(0) } })], exception: c.text("Not found.") }),
    ],
  }),
];
