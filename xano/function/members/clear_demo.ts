// Clearing demo data: the demo company goes, and whatever the team made beside it stays. It works from a named list of tables
// (KTD5), so nothing outside it is touched, and it never resets an id.
//
//   Demo-owned   A row seeded as demo (`is_demo`), or one a demo person or agent wrote: their messages, tasks, docs, files and
//                customer records, the runs and requests of demo agents, and what was said to or by a demo account.
//   Kept         A space, project, conversation, company or contact that holds a real row stays, with only its demo rows gone.
//                Pipeline stages stay. Demo people and agents are disabled, not deleted, so names on real work still read.
//   Left behind  A real row's link to a removed one shows the deleted state, as any link to a deleted record does.
//
// The sets are worked out first and the writes come last, so the confirm dialog's counts come from the same reads.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, or, ref, s, statements, withFilters, type AnyTableDef, type Value } from "@xano/sdk";
import { agent } from "../../agent.js";
import { approvals } from "../../approvals.js";
import { activity, notification } from "../../base/tables.js";
import { changed } from "../../base/functions.js";
import { docs } from "../../docs.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { space } from "../../table/spaces/space.js";
import { space_member } from "../../table/spaces/space_member.js";
import { conversation } from "../../table/messaging/conversation.js";
import { conversation_member } from "../../table/messaging/conversation_member.js";
import { conversation_read } from "../../table/messaging/conversation_read.js";
import { message } from "../../table/messaging/message.js";
import { project } from "../../table/tasks/project.js";
import { task } from "../../table/tasks/task.js";
import { task_view } from "../../table/tasks/task_view.js";
import { record_link } from "../../table/links/record_link.js";
import { search_entry } from "../../table/search/search_entry.js";
import { agent_run } from "../../table/agents/agent_run.js";
import { doc_state } from "../../table/docs/doc_state.js";
import { doc_suggestion } from "../../table/docs/doc_suggestion.js";
import { company } from "../../table/crm/company.js";
import { contact } from "../../table/crm/contact.js";
import { crm_note } from "../../table/crm/crm_note.js";
import { deal } from "../../table/crm/deal.js";
import { file_blob } from "../../table/files/file_blob.js";
import { file_record } from "../../table/files/file_record.js";
import { requireActivePerson } from "./gate.js";

const ONLY_REAL_ADMINS = "Only people who manage the team clear demo data.";
const DEMO_ACCOUNT = "Demo accounts are switched off when demo data is cleared. Invite yourself as an admin, sign in with that account, then clear it.";

type Where = Parameters<typeof s.db.query>[0]["where"];
/**
 * Binds `as` to the values of `column` on `table`'s rows that match, always with a -1 in front. An `in` against an empty list
 * matches every row, so no list here is ever empty, and -1 is in no column: 0 is, for "nobody", so it can't stand in.
 * `${as}_count` is how many matched.
 */
const idsOf = (as: string, table: AnyTableDef, where: Where, column = "id") => statements(
  s.db.query({ table, where, output: [column], as: `${as}_rows` }),
  s.array.map({ source: ref(`${as}_rows`), as: `${as}_found`, transform: ref(`$this.${column}`) }),
  s.set_var(as, withFilters(c.array([-1]), fl.array_merge(ref(`${as}_found`)))),
  s.set_var(`${as}_count`, withFilters(ref(`${as}_found`), fl.count())),
);
/** A column's values on the rows that stay, for "holds a real row". */
const keptOf = (as: string, table: AnyTableDef, gone: string, column: string) => idsOf(as, table, cmp(col("id"), "not in", ref(gone)), column);
const demoOwned = (owner: string) => or(cmp(col("is_demo"), "=", c.bool(true)), cmp(col(owner), "in", ref("demo")));
const isIn = (column: string, list: string) => cmp(col(column), "in", ref(list));
const drop = (table: AnyTableDef, where: Where) => s.db.bulk.delete({ table, where });
/** The records a link, an inbox line or a search entry can point at, and the set that says which of them went. */
const RECORD_SETS: readonly [type: string, list: string][] = [
  ["message", "gone_messages"], ["task", "gone_tasks"], ["doc", "gone_docs"], ["file", "gone_files"], ["company", "gone_companies"], ["contact", "gone_contacts"],
  ["deal", "gone_deals"], ["crm_note", "gone_notes"], ["project", "gone_projects"], ["conversation", "gone_conversations"], ["space", "gone_spaces"],
];
const total = (...names: string[]) => names.reduce<Value>((sum, n, i) => (i === 0 ? ref(`${n}_count`) : withFilters(sum, fl.add(ref(`${n}_count`)))), c.int(0));

/** Who's asking, and every set Clear demo data works from, counted. Reads only. */
const measure = (actor: Value) => statements(
    s.db.get({ table: user, fieldValue: actor, output: ["id", "kind", "role", "status", "is_demo"], as: "actor" }),
    guard.found("actor", { errorType: "accessdenied", message: ONLY_REAL_ADMINS }),
    ...requireActivePerson("actor", { message: ONLY_REAL_ADMINS }),
    rbac.allows(ref("actor.role"), "team.manage", ONLY_REAL_ADMINS),
    guard.require(expr(ref("actor.is_demo"), "!=", c.bool(true)), { errorType: "accessdenied", message: DEMO_ACCOUNT }),

    // Who the demo is, and which of them are still switched on.
    ...idsOf("demo", user, cmp(col("is_demo"), "=", c.bool(true))),
    s.db.query({ table: user, where: [cmp(col("is_demo"), "=", c.bool(true)), cmp(col("status"), "=", c.text("active")), cmp(col("kind"), "=", c.text("human"))], returnType: "count", as: "people_on" }),
    s.db.query({ table: user, where: [cmp(col("is_demo"), "=", c.bool(true)), cmp(col("status"), "=", c.text("active")), cmp(col("kind"), "=", c.text("agent"))], returnType: "count", as: "agents_on" }),

    // What goes, leaves first. A parent goes only when nothing real is left in it.
    ...idsOf("gone_messages", message, demoOwned("author_id")),
    ...idsOf("gone_notes", crm_note, demoOwned("author_id")),
    ...idsOf("gone_docs", docs.doc, demoOwned("owner_id")),
    ...idsOf("gone_files", file_record, demoOwned("uploaded_by")),
    ...idsOf("gone_tasks", task, demoOwned("created_by")),
    ...idsOf("gone_deals", deal, demoOwned("created_by")),
    ...idsOf("gone_runs", agent_run, or(cmp(col("is_demo"), "=", c.bool(true)), isIn("agent_id", "demo"), isIn("requested_by", "demo"))),
    ...keptOf("deal_contacts", deal, "gone_deals", "contact_id"),
    ...idsOf("gone_contacts", contact, and(demoOwned("created_by"), cmp(col("id"), "not in", ref("deal_contacts")))),
    ...keptOf("deal_companies", deal, "gone_deals", "company_id"),
    ...keptOf("contact_companies", contact, "gone_contacts", "company_id"),
    ...keptOf("note_companies", crm_note, "gone_notes", "company_id"),
    s.set_var("held_companies", withFilters(ref("deal_companies"), fl.array_merge(ref("contact_companies")), fl.array_merge(ref("note_companies")))),
    ...idsOf("gone_companies", company, and(demoOwned("created_by"), cmp(col("id"), "not in", ref("held_companies")))),
    ...keptOf("task_projects", task, "gone_tasks", "project_id"),
    ...idsOf("gone_projects", project, and(demoOwned("created_by"), cmp(col("id"), "not in", ref("task_projects")))),
    ...keptOf("message_homes", message, "gone_messages", "conversation_id"),
    ...idsOf("gone_conversations", conversation, and(demoOwned("created_by"), cmp(col("id"), "not in", ref("message_homes")))),
    ...keptOf("conversation_spaces", conversation, "gone_conversations", "space_id"),
    ...keptOf("task_spaces", task, "gone_tasks", "space_id"),
    ...keptOf("project_spaces", project, "gone_projects", "space_id"),
    ...keptOf("doc_spaces", docs.doc, "gone_docs", "space_id"),
    ...keptOf("file_spaces", file_record, "gone_files", "space_id"),
    s.set_var("held_spaces", withFilters(ref("conversation_spaces"), fl.array_merge(ref("task_spaces")), fl.array_merge(ref("project_spaces")), fl.array_merge(ref("doc_spaces")), fl.array_merge(ref("file_spaces")))),
    ...idsOf("gone_spaces", space, and(demoOwned("created_by"), cmp(col("id"), "not in", ref("held_spaces")))),
    // An approval's agent lives in its payload, which a query can't filter on, and there are only ever a few.
    s.db.query({ table: approvals.approval, output: ["id", "user_id", "payload"], as: "asks" }),
    s.set_var("gone_approvals", c.array([-1])),
    s.foreach({ list: ref("asks"), as: "ask", body: [
      s.conditional({ when: or(
        expr(withFilters(ref("ask.user_id"), fl.in(ref("demo"))), "=", c.bool(true)),
        expr(withFilters(withFilters(ref("ask.payload"), fl.get("agent_id", 0)), fl.in(ref("demo"))), "=", c.bool(true)),
      ), then: [s.update_var("gone_approvals", withFilters(ref("gone_approvals"), fl.array_push(ref("ask.id"))))] }),
    ] }),
    s.set_var("removed", total("gone_messages", "gone_notes", "gone_docs", "gone_files", "gone_tasks", "gone_deals", "gone_runs", "gone_contacts", "gone_companies", "gone_projects", "gone_conversations", "gone_spaces")),
    s.set_var("switched_off", withFilters(ref("people_on"), fl.add(ref("agents_on")))),

);
const counted = (cleared: boolean) => obj({
    people: ref("people_on"), agents: ref("agents_on"), spaces: ref("gone_spaces_count"), conversations: ref("gone_conversations_count"), messages: ref("gone_messages_count"),
    tasks: ref("gone_tasks_count"), docs: ref("gone_docs_count"), files: ref("gone_files_count"),
    customers: withFilters(ref("gone_companies_count"), fl.add(ref("gone_contacts_count")), fl.add(ref("gone_deals_count"))),
    removed: ref("removed"), cleared: c.bool(cleared),
  });

/** What Clear demo data would remove and switch off, for its confirm dialog. Changes nothing, so a GET can ask it. */
export const demoCounts = defineFunction({
  name: "members/demo_counts",
  description: "Count the demo company's rows, as Clear demo data would remove them.",
  input: { actor_id: input.int({ required: true }) },
  stack: [...measure(inp("actor_id"))],
  response: counted(false),
});

/**
 * Removes the demo company as `actor_id`, who must be a real admin: a demo admin's own account would switch off part way through.
 * A second run finds nothing and changes nothing.
 */
export const clearDemo = defineFunction({
  name: "members/clear_demo",
  description: "Remove the demo company's rows, keep everything real, and switch off the demo people and agents.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    ...measure(inp("actor_id")),
    s.db.transaction({ body: [
      // A real message whose thread went loses its thread, and nothing else.
      s.db.query({ table: message, where: [isIn("thread_id", "gone_conversations"), cmp(col("thread_id"), ">", c.int(0))], output: ["id"], as: "orphaned" }),
      s.foreach({ list: ref("orphaned"), as: "row", body: [s.db.patch({ table: message, fieldValue: ref("row.id"), data: obj({ thread_id: c.int(0), reply_count: c.int(0), last_reply_at: c.null() }) })] }),
      drop(message, isIn("id", "gone_messages")),
      drop(crm_note, isIn("id", "gone_notes")),
      drop(doc_suggestion, or(isIn("doc_id", "gone_docs"), isIn("agent_id", "demo"))),
      drop(doc_state, isIn("doc_id", "gone_docs")),
      drop(docs.doc_version, isIn("doc_id", "gone_docs")),
      drop(docs.doc, isIn("id", "gone_docs")),
      drop(file_blob, isIn("file_id", "gone_files")),
      drop(file_record, isIn("id", "gone_files")),
      drop(task_view, isIn("user_id", "demo")),
      drop(task, isIn("id", "gone_tasks")),
      drop(deal, isIn("id", "gone_deals")),
      drop(contact, isIn("id", "gone_contacts")),
      drop(company, isIn("id", "gone_companies")),
      drop(agent_run, isIn("id", "gone_runs")),
      drop(approvals.approval, isIn("id", "gone_approvals")),
      drop(project, isIn("id", "gone_projects")),
      drop(conversation_member, isIn("conversation_id", "gone_conversations")),
      drop(conversation_read, or(isIn("conversation_id", "gone_conversations"), isIn("user_id", "demo"))),
      drop(conversation, isIn("id", "gone_conversations")),
      // A real person in a space that goes keeps their copy of their spaces in step (function/access/membership.ts).
      s.db.query({ table: space_member, where: [isIn("space_id", "gone_spaces"), cmp(col("user_id"), "not in", ref("demo"))], output: ["user_id"], as: "moved_rows" }),
      s.array.map({ source: ref("moved_rows"), as: "moved_people", transform: ref("$this.user_id") }),
      drop(space_member, or(isIn("space_id", "gone_spaces"), isIn("user_id", "demo"))),
      s.foreach({ list: withFilters(ref("moved_people"), fl.unique()), as: "person", body: [
        s.db.query({ table: space_member, where: cmp(col("user_id"), "=", ref("person")), sort: [{ sortBy: "space_id", dir: "asc" }], output: ["space_id"], as: "still_in" }),
        s.array.map({ source: ref("still_in"), as: "still_ids", transform: ref("$this.space_id") }),
        s.db.patch({ table: user, fieldValue: ref("person"), data: obj({ space_ids: ref("still_ids") }) }),
      ] }),
      drop(space, isIn("id", "gone_spaces")),
      // Links a demo account made, and links from anything that went. A real row's link to something that went stays, as deleted.
      drop(record_link, isIn("created_by", "demo")),
      ...RECORD_SETS.map(([type, list]) => drop(record_link, [cmp(col("from_type"), "=", c.text(type)), isIn("from_id", list)])),
      drop(notification, or(isIn("user_id", "demo"), isIn("actor_id", "demo"), and(cmp(col("entity"), "=", c.text("approval")), isIn("entity_id", "gone_approvals")))),
      drop(activity, isIn("actor_id", "demo")),
      drop(search_entry, cmp(col("is_demo"), "=", c.bool(true))),
      ...RECORD_SETS.map(([type, list]) => drop(search_entry, [cmp(col("entity"), "=", c.text(type)), isIn("entity_id", list)])),
      // Switched off as End demo mode does it: their keys end, and their names stay on everything real.
      s.db.query({ table: agent.agent_connection, where: [isIn("user_id", "demo"), cmp(col("revoked"), "!=", c.bool(true))], output: ["id"], as: "keys" }),
      s.foreach({ list: ref("keys"), as: "key", body: [s.db.patch({ table: agent.agent_connection, fieldValue: ref("key.id"), data: obj({ revoked: c.bool(true) }) })] }),
      s.db.query({ table: user, where: [isIn("id", "demo"), cmp(col("status"), "=", c.text("active"))], output: ["id"], as: "on" }),
      s.foreach({ list: ref("on"), as: "row", body: [s.db.patch({ table: user, fieldValue: ref("row.id"), data: obj({ status: c.text("disabled") }) })] }),
    ] }),
    s.conditional({ when: expr(withFilters(ref("removed"), fl.add(ref("switched_off"))), ">", c.int(0)), then: [
      changed({ entity: "settings", id: c.int(1), verb: "cleared", actor: inp("actor_id"), link: "/settings", title: "cleared the demo data" }),
    ] }),
  ],
  response: counted(true),
});
