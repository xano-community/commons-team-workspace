// Workflow tests for docs: the space rule, an agent's change from filing to decision, and what each write tells whom. Each test
// makes its own rows. Two real windows, typing while a suggestion lands and the phone layout need a browser, so
// frontend/scripts/docs-check.mjs proves those against a deployed backend.
import { c, cmp, col, expr, fl, guard, obj, ref, s, withFilters, workflowTest, type Value } from "@xano/sdk";
import { docs } from "../docs.js";
import { notification, workspace_setting } from "../base/tables.js";
import { listNotifications } from "../base/queries.js";
import { addLink, resolveLinks } from "../query/links.js";
import { removeSpaceMemberRoute, updateSpaceRoute } from "../query/spaces.js";
import { createDocRoute, decideSuggestionRoute, docContextRoute, docEditingRoute, listDocsRoute, searchDocsRoute, yieldDocRoute } from "../query/docs.js";
import { listRunsRoute } from "../query/agents.js";
import { createProjectRoute, createTaskRoute } from "../query/tasks.js";
import { deleteMessageRoute, openThreadRoute, postMessageRoute } from "../query/messages.js";
import { canReach } from "../function/access/reach.js";
import { purgeDocs } from "../function/docs/docs.js";
import { readRecord, reportProgress, saveDoc } from "../agents/tools.js";
import { doc_state } from "../table/docs/doc_state.js";
import { doc_suggestion } from "../table/docs/doc_suggestion.js";
import { agent_run } from "../table/agents/agent_run.js";
import { change_log } from "../table/links/change_log.js";
import { message } from "../table/messaging/message.js";
import { record_link } from "../table/links/record_link.js";
import { task } from "../table/tasks/task.js";
import { project } from "../table/tasks/project.js";
import { user } from "../table/user.js";
import { bearer, channel, joined, makeSpace, missesText, no, notFound, person, personToken, rowsTest, seesText, settings, yes } from "./access.js";

const { get: getDoc, save: saveRoute, restore: restoreRoute, del: deleteRoute, undelete: undeleteRoute, versions: versionsRoute } = docs.endpoints;

const call = (api: Parameters<typeof s.api.call>[0]["api"], token: string, as: string, input: Record<string, Value> = {}) => s.api.call({ api, headers: bearer(token), as, input });
const equal = (name: string, value: Value) => s.expect.to_equal({ expr: ref(name), value });
const is = (name: string, n: number) => equal(name, c.int(n));
const text = (name: string, value: string) => equal(name, c.text(value));
const count = (name: string, n: number) => s.expect.to_equal({ expr: withFilters(ref(name), fl.count()), value: c.int(n) });
const says = (name: string, value: string) => s.expect.to_contain({ expr: ref(name), value: c.text(value) });

/** A row in a space, with the copy on the person's row that the doc rule reads. */
const inSpace = (key: string, who: string, role = "member") => [
  joined(key, who, role),
  s.db.patch({ table: user, fieldValue: ref(`${who}.id`), data: obj({ space_ids: withFilters(c.array([]), fl.array_push(ref(`${key}.id`))) }) }),
];
const scoutRow = s.db.add({ table: user, as: "scout", row: {
  name: c.text("Agent scout"), email: c.null(), password: c.null(), role: c.text("agent"), kind: c.text("agent"), agent_mode: c.text("hosted"), brief: c.text("Keep the launch moving."), sponsor_id: ref("ada.id"), status: c.text("active"), is_demo: c.bool(false),
} });

/** Ada manages A, Ben and Scout are in it, Gia is a guest there, and Cy is in B. Agents are paused, so a mention stays queued. */
const team = [
  settings(), s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ agents_paused: c.bool(true) }) }),
  person("ada"), person("ben"), person("cy"), person("gia", "guest"), person("root", "admin"), scoutRow,
  makeSpace("a"), makeSpace("b"), ...inSpace("a", "ada", "manager"), ...inSpace("a", "ben"), ...inSpace("a", "gia"), ...inSpace("a", "scout"), ...inSpace("b", "cy"),
  channel("chat", "a"),
  personToken("ada", "ada_token"), personToken("ben", "ben_token"), personToken("cy", "cy_token"), personToken("gia", "gia_token"), personToken("root", "root_token"),
];

const paragraph = (...content: Value[]) => obj({ type: c.text("paragraph"), content });
const words = (value: string) => obj({ type: c.text("text"), text: c.text(value) });
const body = (...blocks: Value[]) => obj({ type: c.text("doc"), content: blocks });
const plain = (value: string) => body(paragraph(words(value)));
const newDoc = (as: string, value = "Ship on the 14th of March.", token = "ben_token", spaceKey = "a") => call(createDocRoute, token, as, { space_id: ref(`${spaceKey}.id`), title: c.text("Launch brief"), body: plain(value) });
const save = (token: string, id: Value, base: Value, content: Value, as: string, title = "Launch brief") => call(saveRoute, token, as, { id, base_version: base, title: c.text(title), body: content });
const reload = (key: string, as: string, token = "ben_token") => [call(getDoc, token, `${as}_read`, { id: ref(`${key}.id`) }), s.set_var(as, ref(`${as}_read.doc`))];
const file = (as: string, key: string, find: string, value: string, run: Value = c.int(0)) => s.function.call({ fn: saveDoc, as, input: { actor_id: ref("scout.id"), run_id: run, approved_by: c.int(1), id: ref(`${key}.id`), title: c.text(""), find: c.text(find), text: c.text(value), note: c.text("Tightened this up.") } });
const context = (key: string, as: string, token = "ben_token") => call(docContextRoute, token, as, { id: ref(`${key}.id`) });
const decide = (id: Value, decision: string, as: string, token = "ben_token") => call(decideSuggestionRoute, token, as, { id, decision: c.text(decision) });
const typing = (key: string, as = "typed", token = "ben_token") => call(docEditingRoute, token, as, { id: ref(`${key}.id`) });
/** Someone stopped typing a while ago, and their last save has aged. */
const quiet = (key: string) => [
  s.db.query({ table: doc_state, where: cmp(col("doc_id"), "=", ref(`${key}.id`)), output: ["id"], returnType: "single", as: "held" }),
  s.conditional({ when: expr(ref("held"), "!=", c.null()), then: [s.db.patch({ table: doc_state, fieldValue: ref("held.id"), data: obj({ editing_until: c.null() }) })] }),
  s.db.patch({ table: docs.doc, fieldValue: ref(`${key}.id`), data: obj({ updated_at: withFilters(c.now(), fl.sub(c.int(600_000))) }) }),
];
const suggestion = (id: Value, as: string) => s.db.get({ table: doc_suggestion, fieldValue: id, as });
const aRun = (as: string, thread = "chat") => s.db.add({ table: agent_run, as, row: {
  agent_id: ref("scout.id"), requested_by: ref("ada.id"), source_type: c.text("message"), source_id: c.int(1), space_id: ref("a.id"), status: c.text("working"), attempt: c.int(1), thread_id: ref(`${thread}.id`), conversation_id: ref(`${thread}.id`), started_at: c.now(), done_reported: c.bool(false), is_demo: c.bool(false),
} });
const reloadRun = (key: string, as: string) => s.db.get({ table: agent_run, fieldValue: ref(`${key}.id`), as });
const logged = (spaceKey: string, entity: string, as: string) => [
  s.set_var("space_log", withFilters(c.text("spaces/"), fl.concat(ref(`${spaceKey}.id`)))),
  s.db.query({ table: change_log, where: [cmp(col("channel"), "=", ref("space_log")), cmp(col("entity"), "=", c.text(entity))], returnType: "count", as }),
];
/** The next call to save_doc is turned away with these words. `to_throw` runs in a stack of its own, so it finds its rows again. */
const fileRefused = (words: string, find: string, value = "Anything") => s.expect.to_throw({ exception: c.text(words), body: [
  s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent scout")), returnType: "single", as: "scout" }),
  s.db.query({ table: docs.doc, sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: 1, metadata: false }, as: "docs_now" }),
  s.set_var("doc", withFilters(ref("docs_now"), fl.first())),
  s.function.call({ fn: saveDoc, as: "filed", input: { actor_id: ref("scout.id"), run_id: c.int(0), approved_by: c.int(1), id: ref("doc.id"), title: c.text(""), find: c.text(find), text: c.text(value), note: c.text("") } }),
] });

/** A new doc from an agent's words, read back with its body. */
const written = (as: string, value: string) => [
  s.function.call({ fn: saveDoc, as: `${as}_made`, input: { actor_id: ref("scout.id"), run_id: c.int(0), id: c.int(0), space_id: ref("a.id"), title: c.text("From Scout"), find: c.text(""), text: c.text(value), note: c.text("") } }),
  s.db.get({ table: docs.doc, fieldValue: ref(`${as}_made.id`), as }),
  guard.found(as),
];
/** A new doc reaches a guest through an approval, so these leave the guest out. */
const noGuest = call(removeSpaceMemberRoute, "ada_token", "gia_out", { id: ref("a.id"), user_id: ref("gia.id") });
const encoded = (name: string, as: string) => s.set_var(as, withFilters(ref(name), fl.json_encode()));
const MARKDOWN = [
  "# Plan", "", "Ship **soon**, *maybe*, with `npm test` and [the notes](https://example.com/notes).", "",
  "- First", "- Second", "  - Nested", "", "1. One", "2. Two", "", "- [ ] Open", "- [x] Done", "", "```ts", "const a = 1;", "```",
].join("\n");

export const docTests = [
  workflowTest({
    name: "docs: an agent's markdown becomes headings, lists, a checklist, marks and code, with no blank blocks",
    stack: [
      ...team, noGuest, ...written("doc", MARKDOWN),
      text("doc.body.content.0.type", "heading"), is("doc.body.content.0.attrs.level", 1),
      text("doc.body.content.1.type", "paragraph"),
      text("doc.body.content.1.content.1.text", "soon"), text("doc.body.content.1.content.1.marks.0.type", "bold"),
      text("doc.body.content.1.content.3.marks.0.type", "italic"),
      text("doc.body.content.1.content.5.text", "npm test"), text("doc.body.content.1.content.5.marks.0.type", "code"),
      text("doc.body.content.1.content.7.marks.0.type", "link"), text("doc.body.content.1.content.7.marks.0.attrs.href", "https://example.com/notes"),
      text("doc.body.content.2.type", "bulletList"), count("doc.body.content.2.content", 2),
      text("doc.body.content.2.content.1.content.1.type", "bulletList"),
      text("doc.body.content.3.type", "orderedList"), count("doc.body.content.3.content", 2),
      text("doc.body.content.4.type", "taskList"), equal("doc.body.content.4.content.0.attrs.checked", c.bool(false)), equal("doc.body.content.4.content.1.attrs.checked", c.bool(true)),
      text("doc.body.content.5.type", "codeBlock"), text("doc.body.content.5.attrs.language", "ts"), text("doc.body.content.5.content.0.text", "const a = 1;"),
      count("doc.body.content", 6),
      missesText("doc.text", "**"), missesText("doc.text", "`"),
    ],
  }),
  workflowTest({
    name: "docs: an agent's addition to a doc becomes real blocks too, at once and when it waits",
    stack: [
      ...team, newDoc("doc"), ...quiet("doc"),
      file("added", "doc", "", "## Next\n- [ ] Book the room\n- Tell **Ben**"),
      text("added.status", "applied"),
      s.db.get({ table: docs.doc, fieldValue: ref("doc.id"), as: "now" }), guard.found("now"),
      text("now.body.content.1.type", "heading"), text("now.body.content.2.type", "taskList"), text("now.body.content.3.type", "bulletList"),
      typing("doc"),
      file("waiting", "doc", "", "1. Later"),
      text("waiting.status", "pending"),
      suggestion(ref("waiting.suggestion_id"), "row"), guard.found("row"),
      text("row.blocks.0.type", "orderedList"),
    ],
  }),
  workflowTest({
    name: "docs: a replacement with marks waits for a person's editor, and says its words plainly",
    stack: [
      ...team, newDoc("doc"), ...quiet("doc"),
      file("marked", "doc", "14th of March", "**21st** of March"),
      text("marked.status", "pending"),
      suggestion(ref("marked.suggestion_id"), "row"), guard.found("row"),
      text("row.text", "21st of March"), text("row.blocks.0.text", "21st"), text("row.blocks.0.marks.0.type", "bold"),
      file("plain_words", "doc", "Ship on", "Ship by"),
      text("plain_words.status", "pending"),
    ],
  }),
  workflowTest({
    name: "docs: an agent's words never become HTML, a script or a link that runs",
    stack: [
      ...team, noGuest,
      ...written("doc", "<script>alert(1)</script>\n\n[click](javascript:alert(1))\n\n[data](data:text/html;base64,PHNjcmlwdD4=)\n\n<img src=x onerror=alert(1)>\n\n[fine](https://example.com/a)"),
      encoded("doc.body", "all"),
      text("doc.body.content.0.content.0.text", "<script>alert(1)</script>"),
      text("doc.body.content.1.content.0.text", "[click](javascript:alert(1))"),
      text("doc.body.content.3.content.0.text", "<img src=x onerror=alert(1)>"),
      missesText("all", "\"href\":\"javascript"), missesText("all", "\"href\":\"data"), missesText("all", "\"html\""),
      says("all", "\"href\":\"https://example.com/a\""),
    ],
  }),
  workflowTest({
    name: "docs: a list shows a doc's first paragraph, never its heading, and its screen names the project of the task it's for",
    stack: [
      ...team,
      call(createDocRoute, "ben_token", "notes", { space_id: ref("a.id"), title: c.text("Call notes"), body: body(obj({ type: c.text("heading"), attrs: { level: 2 }, content: [words("Decided")] }), paragraph(words("Specs come as a spreadsheet."))) }),
      call(listDocsRoute, "ben_token", "listed"), text("listed.items.0.excerpt", "Specs come as a spreadsheet."),
      context("notes", "alone"), equal("alone.project_id", c.int(0)), equal("alone.project_name", c.null()),
      call(createProjectRoute, "ada_token", "launch", { space_id: ref("a.id"), name: c.text("Website relaunch") }),
      call(createTaskRoute, "ada_token", "job", { project_id: ref("launch.id"), client_id: c.text("job-id"), title: c.text("Import the specs"), status: c.text("todo"), priority: c.text("none") }),
      call(addLink, "ben_token", "linked", { from_type: c.text("doc"), from_id: ref("notes.id"), to_type: c.text("task"), to_id: ref("job.id") }),
      context("notes", "placed"), equal("placed.project_id", ref("launch.id")), text("placed.project_name", "Website relaunch"),
    ],
  }),
  workflowTest({
    name: "docs: a doc's screen and list know an agent from a person",
    stack: [
      ...team, noGuest, ...written("doc", "From Scout"),
      context("doc", "seen"), text("seen.owner_kind", "agent"), equal("seen.owner_id", ref("scout.id")), text("seen.editor_kind", "agent"),
      call(listDocsRoute, "ben_token", "listed"), text("listed.items.0.editor_kind", "agent"), text("listed.items.0.owner_kind", "agent"),
      newDoc("mine"),
      context("mine", "own"), text("own.owner_kind", "human"),
    ],
  }),
  workflowTest({
    name: "docs: a doc lives in its space, and only people who reach the space find it",
    stack: [
      ...team, newDoc("doc"),
      equal("doc.space_id", ref("a.id")), is("doc.version", 1), text("doc.visibility", "team"),
      call(listDocsRoute, "ada_token", "ada_list"), count("ada_list.items", 1), text("ada_list.items.0.title", "Launch brief"), text("ada_list.items.0.space_name", "Space a"), is("ada_list.ever", 1),
      is("ada_list.items.0.comments", 0),
      // Comments are counted from the doc's own thread, and a deleted one doesn't count.
      call(openThreadRoute, "ada_token", "doc_thread", { record_type: c.text("doc"), record_id: ref("doc.id") }),
      call(postMessageRoute, "ada_token", "first_comment", { id: ref("doc_thread.id"), client_msg_id: c.text("dc-1"), body: c.text("Who signs this off?") }),
      call(postMessageRoute, "ben_token", "second_comment", { id: ref("doc_thread.id"), client_msg_id: c.text("dc-2"), body: c.text("Ada does.") }),
      call(postMessageRoute, "ben_token", "third_comment", { id: ref("doc_thread.id"), client_msg_id: c.text("dc-3"), body: c.text("Typo") }),
      call(deleteMessageRoute, "ben_token", "unsaid", { id: ref("third_comment.message.id") }),
      call(listDocsRoute, "ben_token", "talked"), is("talked.items.0.comments", 2),
      call(listDocsRoute, "cy_token", "cy_list"), count("cy_list.items", 0), is("cy_list.ever", 0),
      call(listDocsRoute, "root_token", "root_list"), count("root_list.items", 1),
      call(listDocsRoute, "ben_token", "other_space", { space_id: ref("b.id") }), notFound("other_space"),
      call(listDocsRoute, "ada_token", "nothing_matched", { q: c.text("zebra") }), count("nothing_matched.items", 0), is("nothing_matched.ever", 1),
      call(searchDocsRoute, "ada_token", "found", { q: c.text("launch") }), count("found", 1),
      call(searchDocsRoute, "cy_token", "not_found", { q: c.text("launch") }), count("not_found", 0),
      call(getDoc, "cy_token", "cy_read", { id: ref("doc.id") }), says("cy_read.message", "doesn't exist"),
      call(docContextRoute, "cy_token", "cy_context", { id: ref("doc.id") }), says("cy_context.message", "doesn't exist"),
    ],
  }),
  workflowTest({
    name: "docs: someone who leaves a space loses the doc they wrote there, and a removed person is refused",
    stack: [
      ...team, newDoc("doc"),
      call(removeSpaceMemberRoute, "ada_token", "out", { id: ref("a.id"), user_id: ref("ben.id") }),
      call(getDoc, "ben_token", "owner_read", { id: ref("doc.id") }), says("owner_read.message", "doesn't exist"),
      save("ben_token", ref("doc.id"), c.int(1), plain("Still mine?"), "owner_save"), says("owner_save.message", "doesn't exist"),
      s.db.patch({ table: user, fieldValue: ref("cy.id"), data: obj({ status: c.text("removed") }) }),
      call(getDoc, "cy_token", "gone_read", { id: ref("doc.id") }), says("gone_read.message", "access to this workspace has ended"),
    ],
  }),
  workflowTest({
    name: "docs: a guest reads and can't change what others wrote, and adds a doc only where the space allows it",
    stack: [
      ...team, newDoc("doc"),
      call(getDoc, "gia_token", "guest_read", { id: ref("doc.id") }), equal("guest_read.access.can_edit", c.bool(false)),
      save("gia_token", ref("doc.id"), c.int(1), plain("Guest words"), "guest_save"), says("guest_save.message", "not edit"),
      context("doc", "guest_context", "gia_token"), equal("guest_context.can_edit", c.bool(false)),
      newDoc("refused", "Nope", "gia_token"), says("refused.message", "can't add"),
      call(updateSpaceRoute, "ada_token", "opened", { id: ref("a.id"), name: c.text("Space a"), visibility: c.text("private"), guests_can_create: c.bool(true), archived: c.bool(false) }),
      newDoc("allowed", "A note from the client", "gia_token"), is("allowed.version", 1),
      save("gia_token", ref("allowed.id"), c.int(1), plain("My own words"), "own_save"), is("own_save.doc.version", 2),
    ],
  }),
  workflowTest({
    name: "docs: an archived space's docs read and can't change",
    stack: [
      ...team, newDoc("doc"), file("pending", "doc", "14th of March", "21st of March"),
      typing("doc"), newDoc("second", "Second doc"), typing("second"), file("waiting", "second", "Second", "Another"),
      call(updateSpaceRoute, "ada_token", "archived", { id: ref("a.id"), name: c.text("Space a"), visibility: c.text("private"), guests_can_create: c.bool(false), archived: c.bool(true) }),
      call(getDoc, "ben_token", "read", { id: ref("doc.id") }), text("read.doc.title", "Launch brief"),
      context("doc", "seen"), equal("seen.archived", c.bool(true)), equal("seen.can_edit", c.bool(false)),
      save("ben_token", ref("doc.id"), ref("read.doc.version"), plain("Too late"), "late"), says("late.message", "archived"),
      call(deleteRoute, "ben_token", "binned", { id: ref("doc.id") }), says("binned.message", "archived"),
      decide(ref("waiting.suggestion_id"), "apply", "refused"), says("refused.message", "archived"),
      newDoc("nope"), says("nope.message", "can't add"),
    ],
  }),
  workflowTest({
    name: "docs: an agent's change applies at once when nobody is working on the doc",
    stack: [
      ...team, newDoc("doc"), ...quiet("doc"),
      file("filed", "doc", "14th of March", "21st of March"),
      text("filed.status", "applied"),
      ...reload("doc", "now"),
      is("now.version", 2), equal("now.last_edited_by", ref("scout.id")), says("now.text", "Ship on the 21st of March."),
      call(versionsRoute, "ben_token", "history", { id: ref("doc.id") }), seesText("history", "created"),
      context("doc", "seen"), count("seen.suggestions", 0), text("seen.applied.0.agent_name", "Agent scout"),
    ],
  }),
  workflowTest({
    name: "docs: quotes and apostrophes survive the server's own edit, and words that cross a bold wait for a person",
    stack: [
      ...team, newDoc("doc", `Riley's "final" specs`), ...quiet("doc"),
      file("filed", "doc", `Riley's "final"`, `Marlow's "locked"`), text("filed.status", "applied"),
      ...reload("doc", "now"), text("now.text", `Marlow's "locked" specs`),
      call(createDocRoute, "ben_token", "styled", { space_id: ref("a.id"), title: c.text("Styled"), body: body(paragraph(words("Ship on the "), obj({ type: c.text("text"), text: c.text("14th"), marks: [obj({ type: c.text("bold") })] }), words(" of March"))) }),
      ...quiet("styled"),
      file("crossing", "styled", "14th of March", "21st of March"), text("crossing.status", "pending"),
      ...reload("styled", "styled_now"), is("styled_now.version", 1),
    ],
  }),
  workflowTest({
    name: "docs: an addition at the end applies at once and leaves what's there",
    stack: [
      ...team, newDoc("doc"), ...quiet("doc"),
      file("filed", "doc", "", "## Next steps\nBook the review"),
      text("filed.status", "applied"),
      ...reload("doc", "now"),
      says("now.text", "Ship on the 14th of March."), says("now.text", "Next steps"), says("now.text", "Book the review"),
    ],
  }),
  workflowTest({
    name: "docs: while a person types, an agent's change waits as a suggestion and the doc doesn't move",
    stack: [
      ...team, newDoc("doc"), ...quiet("doc"), typing("doc"),
      file("filed", "doc", "14th of March", "21st of March"),
      text("filed.status", "pending"),
      ...reload("doc", "now"), is("now.version", 1), says("now.text", "14th of March"),
      context("doc", "seen"), count("seen.suggestions", 1), text("seen.suggestions.0.find", "14th of March"), text("seen.suggestions.0.text", "21st of March"), text("seen.suggestions.0.agent_name", "Agent scout"), equal("seen.suggestions.0.text_changed", c.bool(false)),
    ],
  }),
  workflowTest({
    name: "docs: a save a moment ago counts as someone working, even with no keystroke heard",
    stack: [
      ...team, newDoc("doc"), ...quiet("doc"),
      save("ben_token", ref("doc.id"), c.int(1), plain("Ship on the 14th of March, for sure."), "typed_save"),
      file("filed", "doc", "14th of March", "21st of March"),
      text("filed.status", "pending"),
      ...reload("doc", "now"), is("now.version", 2),
    ],
  }),
  workflowTest({
    name: "docs: suggestions queue in order, and a new one waits its turn on a quiet doc",
    stack: [
      ...team, newDoc("doc", "One two three"), ...quiet("doc"), typing("doc"),
      file("first", "doc", "One", "Uno"), ...quiet("doc"),
      file("second", "doc", "two", "dos"), text("second.status", "pending"),
      file("third", "doc", "", "Cuatro"), text("third.status", "pending"),
      context("doc", "seen"), count("seen.suggestions", 3),
      equal("seen.suggestions.0.id", ref("first.suggestion_id")), equal("seen.suggestions.1.id", ref("second.suggestion_id")), equal("seen.suggestions.2.id", ref("third.suggestion_id")),
    ],
  }),
  rowsTest({
    name: "docs: anyone who can edit decides, and a read-only viewer doesn't see the suggestion at all",
    stack: [
      ...team, newDoc("doc"), typing("doc"), file("filed", "doc", "14th of March", "21st of March"),
      context("doc", "guest_view", "gia_token"), count("guest_view.suggestions", 0), missesText("guest_view", "21st of March"),
      decide(ref("filed.suggestion_id"), "apply", "guest_try", "gia_token"), says("guest_try.message", "not change"),
      decide(ref("filed.suggestion_id"), "apply", "outsider_try", "cy_token"), says("outsider_try.message", "doesn't exist"),
      decide(ref("filed.suggestion_id"), "apply", "applied", "ada_token"), text("applied.status", "applied"), equal("applied.changed", c.bool(true)),
      suggestion(ref("filed.suggestion_id"), "row"), text("row.status", "applied"), equal("row.decided_by", ref("ada.id")),
      decide(ref("filed.suggestion_id"), "dismiss", "second_look"), text("second_look.status", "applied"), equal("second_look.changed", c.bool(false)),
      context("doc", "seen"), count("seen.suggestions", 0),
    ],
  }),
  rowsTest({
    name: "docs: a suggestion whose target text changed offers dismiss only: apply can't go through",
    stack: [
      ...team, newDoc("doc"), typing("doc"), file("filed", "doc", "14th of March", "21st of March"),
      save("ben_token", ref("doc.id"), c.int(1), plain("Ship whenever it's ready."), "moved_on"),
      context("doc", "seen"), equal("seen.suggestions.0.text_changed", c.bool(true)),
      decide(ref("filed.suggestion_id"), "apply", "refused"), text("refused.status", "pending"), equal("refused.changed", c.bool(false)), equal("refused.text_changed", c.bool(true)),
      suggestion(ref("filed.suggestion_id"), "row"), text("row.status", "pending"),
      ...reload("doc", "now"), says("now.text", "Ship whenever it's ready."),
      decide(ref("filed.suggestion_id"), "dismiss", "gone"), text("gone.status", "dismissed"), equal("gone.changed", c.bool(true)),
    ],
  }),
  rowsTest({
    name: "docs: a dismissed suggestion tells the run, and the run reports it in its thread",
    stack: [
      ...team, aRun("run"), newDoc("doc"), typing("doc"), file("filed", "doc", "14th of March", "21st of March", ref("run.id")),
      decide(ref("filed.suggestion_id"), "dismiss", "gone", "ada_token"), equal("gone.changed", c.bool(true)),
      reloadRun("run", "after"), says("after.last_note", "Test ada dismissed"),
      s.db.query({ table: message, where: [cmp(col("conversation_id"), "=", ref("chat.id")), cmp(col("run_id"), "=", ref("run.id"))], sort: [{ sortBy: "seq", dir: "desc" }], as: "said" }),
      count("said", 1), says("said.0.body", "dismissed"), equal("said.0.author_id", ref("scout.id")), equal("said.0.run_note", c.bool(true)),
    ],
  }),
  rowsTest({
    name: "docs: a run that only suggested says so, whatever the model wrote",
    stack: [
      ...team, aRun("run"), newDoc("doc"), typing("doc"), file("filed", "doc", "14th of March", "21st of March", ref("run.id")),
      text("filed.outcome", "Suggested a change"),
      s.function.call({ fn: reportProgress, as: "reported", input: { actor_id: ref("scout.id"), run_id: ref("run.id"), note: c.text("Edited the brief."), state: c.text("done") } }),
      reloadRun("run", "after"), text("after.last_note", "Suggested a change"),
      s.db.query({ table: message, where: [cmp(col("conversation_id"), "=", ref("chat.id")), cmp(col("run_id"), "=", ref("run.id"))], sort: [{ sortBy: "seq", dir: "desc" }], as: "said" }),
      text("said.0.body", "Suggested a change"),
    ],
  }),
  rowsTest({
    name: "docs: a run whose change went in keeps its own words",
    stack: [
      ...team, aRun("run"), newDoc("doc"), ...quiet("doc"), file("filed", "doc", "14th of March", "21st of March", ref("run.id")),
      text("filed.outcome", "Edited"),
      s.function.call({ fn: reportProgress, as: "reported", input: { actor_id: ref("scout.id"), run_id: ref("run.id"), note: c.text("Moved the date."), state: c.text("done") } }),
      reloadRun("run", "after"), text("after.last_note", "Moved the date."),
    ],
  }),
  rowsTest({
    name: "docs: an agent has to quote text that's there, once, inside one line",
    stack: [
      ...team, newDoc("doc", "Ship it. Ship it now."),
      fileRefused("isn't in the document", "Launch tomorrow"),
      fileRefused("more than once", "Ship"),
      fileRefused("one line", "now", "two\nlines"),
    ],
  }),
  rowsTest({
    name: "docs: save_doc with no id adds a doc to the run's space, and it's the agent's",
    stack: [
      ...team, aRun("run"),
      s.function.call({ fn: saveDoc, as: "made", input: { actor_id: ref("scout.id"), run_id: ref("run.id"), approved_by: c.int(1), id: c.int(0), title: c.text("Launch notes"), find: c.text(""), text: c.text("# Notes\nAll good"), note: c.text("") } }),
      text("made.status", "applied"), text("made.outcome", "Created"),
      call(getDoc, "ben_token", "read", { id: ref("made.id") }), equal("read.doc.space_id", ref("a.id")), equal("read.doc.owner_id", ref("scout.id")), says("read.doc.text", "All good"),
      reloadRun("run", "after"), equal("after.doc_id", ref("made.id")),
    ],
  }),
  workflowTest({
    name: "docs: a run working on a doc shows on it, from the run's own row",
    stack: [
      ...team, aRun("run"), newDoc("doc"),
      s.function.call({ fn: readRecord, as: "read", input: { actor_id: ref("scout.id"), run_id: ref("run.id"), type: c.text("doc"), id: ref("doc.id") } }),
      says("read.record.text", "14th of March"),
      typing("doc"), file("filed", "doc", "14th of March", "21st of March", ref("run.id")),
      call(listRunsRoute, "ben_token", "runs", { doc_id: ref("doc.id") }), count("runs.items", 1), equal("runs.items.0.id", ref("run.id")), text("runs.items.0.status", "working"),
      call(listRunsRoute, "cy_token", "outsider", { doc_id: ref("doc.id") }), notFound("outsider"),
    ],
  }),
  workflowTest({
    name: "docs: mentioning an agent in a doc starts a run on that doc, and someone outside the space hears nothing",
    stack: [
      ...team, newDoc("doc"),
      save("ada_token", ref("doc.id"), c.int(1), body(paragraph(words("Please check "),
        obj({ type: c.text("mention"), attrs: obj({ id: ref("scout.id"), label: c.text("Agent scout") }) }), obj({ type: c.text("mention"), attrs: obj({ id: ref("cy.id"), label: c.text("Test cy") }) }))), "asked"),
      s.db.query({ table: agent_run, as: "runs" }), count("runs", 1), text("runs.0.source_type", "doc"), equal("runs.0.source_id", ref("doc.id")), equal("runs.0.doc_id", ref("doc.id")), equal("runs.0.space_id", ref("a.id")),
      call(listNotifications, "cy_token", "cy_inbox"), missesText("cy_inbox", "mentioned"),
      s.db.query({ table: notification, where: cmp(col("user_id"), "=", ref("scout.id")), as: "scout_inbox" }), count("scout_inbox", 1), text("scout_inbox.0.entity", "doc"), missesText("scout_inbox", "Launch brief"),
    ],
  }),
  workflowTest({
    name: "docs: autosaves reach the doc's own tabs, and the space hears a doc changed once in a while, or when it's renamed",
    stack: [
      ...team, newDoc("doc"),
      ...logged("a", "doc", "after_create"), is("after_create", 1),
      save("ben_token", ref("doc.id"), c.int(1), plain("One"), "one"),
      save("ben_token", ref("doc.id"), c.int(2), plain("Two"), "two"),
      save("ben_token", ref("doc.id"), c.int(3), plain("Three"), "three"),
      ...logged("a", "doc", "after_typing"), is("after_typing", 1),
      save("ben_token", ref("doc.id"), c.int(4), plain("Three"), "renamed", "A new name"),
      ...logged("a", "doc", "after_rename"), is("after_rename", 2),
    ],
  }),
  workflowTest({
    name: "docs: a body's links follow it, and restoring a version brings them back",
    stack: [
      ...team,
      s.db.add({ table: project, as: "launch", row: { space_id: ref("a.id"), name: c.text("Launch"), created_by: ref("ada.id"), is_demo: c.bool(false) } }),
      s.db.add({ table: task, as: "work", row: { project_id: ref("launch.id"), space_id: ref("a.id"), title: c.text("Secret title"), status: c.text("todo"), priority: c.text("none"), created_by: ref("ada.id"), rank: c.int(1), client_id: c.text("doc-link"), is_demo: c.bool(false) } }),
      call(createDocRoute, "ben_token", "doc", { space_id: ref("a.id"), title: c.text("Linked"), body: body(paragraph(words("See "), obj({ type: c.text("recordMention"), attrs: obj({ type: c.text("task"), id: ref("work.id") }) }))) }),
      s.db.query({ table: record_link, where: [cmp(col("from_type"), "=", c.text("doc")), cmp(col("from_id"), "=", ref("doc.id"))], as: "links" }), count("links", 1), text("links.0.origin", "body"), equal("links.0.to_id", ref("work.id")),
      ...reload("doc", "now"), missesText("now", "Secret title"), text("now.text", "See"),
      call(versionsRoute, "ben_token", "history", { id: ref("doc.id") }), s.set_var("first_version", withFilters(ref("history"), fl.last())),
      save("ben_token", ref("doc.id"), c.int(1), plain("No links now"), "unlinked", "Linked"),
      s.db.query({ table: record_link, where: [cmp(col("from_type"), "=", c.text("doc")), cmp(col("from_id"), "=", ref("doc.id"))], as: "none" }), count("none", 0),
      call(restoreRoute, "ben_token", "restored", { id: ref("doc.id"), version_id: ref("first_version.id") }), is("restored.version", 3),
      s.db.query({ table: record_link, where: [cmp(col("from_type"), "=", c.text("doc")), cmp(col("from_id"), "=", ref("doc.id"))], as: "back" }), count("back", 1), equal("back.0.to_id", ref("work.id")),
    ],
  }),
  workflowTest({
    name: "docs: a link chip names a doc for those who reach it, and locks it for those who don't",
    stack: [
      ...team, newDoc("doc"),
      s.function.call({ fn: canReach, as: "member_reaches", input: { actor_id: ref("ben.id"), browser: c.bool(true), type: c.text("doc"), id: ref("doc.id") } }), yes("member_reaches"),
      s.function.call({ fn: canReach, as: "outsider_reaches", input: { actor_id: ref("cy.id"), browser: c.bool(true), type: c.text("doc"), id: ref("doc.id") } }), no("outsider_reaches"),
      s.set_var("items", withFilters(c.array([]), fl.array_push(obj({ type: c.text("doc"), id: ref("doc.id") })))),
      call(resolveLinks, "ben_token", "mine", { items: ref("items") }), text("mine.0.state", "live"), text("mine.0.title", "Launch brief"), says("mine.0.href", "/docs/"),
      call(resolveLinks, "cy_token", "theirs", { items: ref("items") }), text("theirs.0.state", "locked"), missesText("theirs", "Launch brief"),
      call(deleteRoute, "ben_token", "binned", { id: ref("doc.id") }),
      call(resolveLinks, "ben_token", "binned_view", { items: ref("items") }), text("binned_view.0.state", "deleted"),
      call(listDocsRoute, "ben_token", "live_list"), count("live_list.items", 0),
      call(listDocsRoute, "ben_token", "trash", { trash: c.bool(true) }), count("trash.items", 1),
      call(undeleteRoute, "ben_token", "back", { id: ref("doc.id") }), equal("back.deleted", c.bool(false)),
    ],
  }),
  workflowTest({
    name: "docs: a person-to-person race keeps the 409, and yielding won't take a person's words",
    stack: [
      ...team, newDoc("doc"),
      save("ada_token", ref("doc.id"), c.int(1), plain("Ada's words"), "first"), is("first.doc.version", 2),
      save("ben_token", ref("doc.id"), c.int(1), plain("Ben's words"), "second"), equal("second.conflict", c.bool(true)), is("second.doc.version", 2),
      call(yieldDocRoute, "ben_token", "yield", { id: ref("doc.id"), base_version: c.int(1) }), equal("yield.yielded", c.bool(false)),
      ...reload("doc", "now"), says("now.text", "Ada's words"),
    ],
  }),
  rowsTest({
    name: "docs: an agent's change that beat a person's first keystroke steps aside, and comes back as a suggestion",
    stack: [
      ...team, aRun("run"), newDoc("doc"), ...quiet("doc"), file("filed", "doc", "14th of March", "21st of March", ref("run.id")), text("filed.status", "applied"),
      save("ben_token", ref("doc.id"), c.int(1), plain("Ship on the 14th of March. I was typing."), "lost"), equal("lost.conflict", c.bool(true)),
      call(yieldDocRoute, "ben_token", "yield", { id: ref("doc.id"), base_version: c.int(1) }), equal("yield.yielded", c.bool(true)), is("yield.version", 2),
      save("ben_token", ref("doc.id"), ref("yield.version"), plain("Ship on the 14th of March. I was typing."), "won"), is("won.doc.version", 3), says("won.doc.text", "I was typing."),
      suggestion(ref("filed.suggestion_id"), "row"), text("row.status", "pending"), is("row.applied_version", 0),
      context("doc", "seen"), count("seen.suggestions", 1), equal("seen.suggestions.0.text_changed", c.bool(false)),
      reloadRun("run", "after"), text("after.last_note", "Suggested a change"),
    ],
  }),
  workflowTest({
    name: "docs: a doc in the trash for over 30 days goes for good, with its links and suggestions",
    stack: [
      ...team, newDoc("doc"), typing("doc"), file("filed", "doc", "14th of March", "21st of March"),
      call(deleteRoute, "ben_token", "binned", { id: ref("doc.id") }),
      s.db.patch({ table: docs.doc, fieldValue: ref("doc.id"), data: obj({ deleted_at: withFilters(c.now(), fl.sub(c.int(31 * 86_400_000))) }) }),
      s.function.call({ fn: purgeDocs, as: "purged" }), is("purged.purged", 1),
      s.db.get({ table: docs.doc, fieldValue: ref("doc.id"), as: "gone" }), s.expect.to_be_null({ expr: ref("gone") }),
      s.db.query({ table: doc_suggestion, returnType: "count", as: "left" }), is("left", 0),
    ],
  }),
];
