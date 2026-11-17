// What a record is called and where it lives, read fresh for each viewer. Nothing stores a record's name beside a link
// or a mention, so a rename shows everywhere and a title can't outlive someone's access.
//
// A new record type adds one case to `locate` (and to `canReach`), and every chip, backlink and inbox row knows it. A type
// with a trash sets `trashed`, and `can_restore` when its people may bring it back. A message sets `tombstone`.
import { and, c, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters, type Value } from "@xano/sdk";
import { docTable } from "../../docs.js";
import { space } from "../../table/spaces/space.js";
import { conversation } from "../../table/messaging/conversation.js";
import { message } from "../../table/messaging/message.js";
import { project } from "../../table/tasks/project.js";
import { task } from "../../table/tasks/task.js";
import { company } from "../../table/crm/company.js";
import { contact } from "../../table/crm/contact.js";
import { crm_note } from "../../table/crm/crm_note.js";
import { deal } from "../../table/crm/deal.js";
import { file_record } from "../../table/files/file_record.js";
import { reachOf } from "../access/reach.js";

/** More than a screenful of chips is a caller's mistake, and each one costs a read. */
const MOST_AT_ONCE = 100;

const companyHref = (id: Value) => withFilters(c.text("/crm/companies/"), fl.concat(id));
const dealHref = (id: Value) => withFilters(c.text("/crm/deals/"), fl.concat(id));
const contactHref = (companyId: Value, id: Value) => withFilters(companyHref(companyId), fl.concat(c.text("?contact=")), fl.concat(id));
/** A CRM record: it lives in no space, and its scope is what crm.read reaches. */
const inCrm = (title: Value, href: Value) => s.conditional({ when: expr(ref("row"), "!=", c.null()), then: [
  s.update_var("found", c.bool(true)),
  s.update_var("title", title),
  s.update_var("href", href),
  s.update_var("crm", c.bool(true)),
  s.update_var("scope", c.text("crm")),
  s.conditional({ when: expr(ref("row.deleted_at", { safe: true }), "!=", c.null()), then: [s.update_var("trashed", c.bool(true))] }),
] });

export const locate = defineFunction({
  name: "links/locate",
  description: "One record's name, address and state, by type and id. Says nothing about who may see them: that's the caller's job.",
  input: { type: input.text({ required: true }), id: input.int({ required: true }) },
  stack: [
    s.set_var("found", c.bool(false)),
    s.set_var("title", c.text("")),
    s.set_var("href", c.text("")),
    /** Where it lives, as in `reach.scopes`: "space-3", "dm-4" or "crm". */
    s.set_var("scope", c.text("")),
    s.set_var("space_id", c.int(0)),
    s.set_var("dm_id", c.int(0)),
    s.set_var("archived", c.bool(false)),
    s.set_var("crm", c.bool(false)),
    s.set_var("tombstone", c.bool(false)),
    s.set_var("trashed", c.bool(false)),
    s.set_var("conversation_id", c.int(0)),
    /** What a full row shows beside the name: a task's status, assignee and due date, a doc's owner, a file's kind. */
    s.set_var("detail", c.obj({})),
    s.switch({ on: inp("type"), cases: [
      { when: c.text("space"), break: true, body: [
        s.db.get({ table: space, fieldValue: inp("id"), output: ["id", "name", "archived_at"], as: "row" }),
        s.conditional({ when: expr(ref("row"), "!=", c.null()), then: [
          s.update_var("found", c.bool(true)),
          s.update_var("title", ref("row.name", { safe: true })),
          s.update_var("space_id", ref("row.id", { safe: true })),
          s.update_var("scope", withFilters(c.text("space-"), fl.concat(ref("row.id", { safe: true })))),
          s.update_var("href", withFilters(c.text("/?space="), fl.concat(ref("row.id", { safe: true })))),
          s.conditional({ when: expr(ref("row.archived_at", { safe: true }), "!=", c.null()), then: [s.update_var("archived", c.bool(true))] }),
        ] }),
      ] },
      { when: c.text("conversation"), break: true, body: [s.update_var("conversation_id", inp("id"))] },
      { when: c.text("message"), break: true, body: [
        s.db.get({ table: message, fieldValue: inp("id"), output: ["conversation_id", "seq", "deleted_at"], as: "post" }),
        s.update_var("conversation_id", ref("post.conversation_id", { safe: true })),
        s.conditional({ when: expr(ref("post.deleted_at", { safe: true }), "!=", c.null()), then: [s.update_var("tombstone", c.bool(true))] }),
      ] },
      { when: c.text("project"), break: true, body: [
        s.db.get({ table: project, fieldValue: inp("id"), output: ["id", "name", "space_id"], as: "row" }),
        s.conditional({ when: expr(ref("row"), "!=", c.null()), then: [
          s.update_var("found", c.bool(true)),
          s.update_var("title", ref("row.name", { safe: true })),
          s.update_var("space_id", ref("row.space_id", { safe: true })),
          s.update_var("href", withFilters(c.text("/tasks?project="), fl.concat(ref("row.id", { safe: true })))),
        ] }),
      ] },
      { when: c.text("task"), break: true, body: [
        s.db.get({ table: task, fieldValue: inp("id"), output: ["id", "title", "space_id", "deleted_at", "status", "priority", "due_on", "assignee_id"], as: "row" }),
        s.conditional({ when: expr(ref("row"), "!=", c.null()), then: [
          s.update_var("found", c.bool(true)),
          s.update_var("title", ref("row.title", { safe: true })),
          s.update_var("detail", obj({ status: ref("row.status", { safe: true }), priority: ref("row.priority", { safe: true }), due_on: ref("row.due_on", { safe: true }), person_id: ref("row.assignee_id", { safe: true }) })),
          s.update_var("space_id", ref("row.space_id", { safe: true })),
          s.update_var("href", withFilters(c.text("/tasks/"), fl.concat(ref("row.id", { safe: true })))),
          s.conditional({ when: expr(ref("row.deleted_at", { safe: true }), "!=", c.null()), then: [s.update_var("trashed", c.bool(true))] }),
        ] }),
      ] },
      { when: c.text("doc"), break: true, body: [
        s.db.get({ table: docTable, fieldValue: inp("id"), output: ["id", "title", "space_id", "deleted", "owner_id", "updated_at"], as: "row" }),
        s.conditional({ when: expr(ref("row"), "!=", c.null()), then: [
          s.update_var("found", c.bool(true)),
          s.update_var("title", ref("row.title", { safe: true })),
          s.update_var("detail", obj({ person_id: ref("row.owner_id", { safe: true }), updated_at: ref("row.updated_at", { safe: true }) })),
          s.update_var("space_id", ref("row.space_id", { safe: true })),
          s.update_var("href", withFilters(c.text("/docs/"), fl.concat(ref("row.id", { safe: true })))),
          s.conditional({ when: expr(ref("row.deleted", { safe: true }), "=", c.bool(true)), then: [s.update_var("trashed", c.bool(true))] }),
        ] }),
      ] },
      { when: c.text("file"), break: true, body: [
        s.db.get({ table: file_record, fieldValue: inp("id"), output: ["id", "name", "scope", "space_id", "dm_id", "crm", "deleted_at", "kind", "uploaded_by"], as: "row" }),
        s.conditional({ when: expr(ref("row"), "!=", c.null()), then: [
          s.update_var("found", c.bool(true)),
          s.update_var("title", ref("row.name", { safe: true })),
          s.update_var("detail", obj({ kind: ref("row.kind", { safe: true }), person_id: ref("row.uploaded_by", { safe: true }) })),
          s.update_var("href", withFilters(c.text("/files/"), fl.concat(ref("row.id", { safe: true })))),
          s.update_var("scope", ref("row.scope", { safe: true })),
          s.update_var("space_id", ref("row.space_id", { safe: true })),
          s.update_var("dm_id", ref("row.dm_id", { safe: true })),
          s.update_var("crm", ref("row.crm", { safe: true })),
          s.conditional({ when: expr(ref("row.deleted_at", { safe: true }), "!=", c.null()), then: [s.update_var("trashed", c.bool(true))] }),
        ] }),
      ] },
      { when: c.text("company"), break: true, body: [
        s.db.get({ table: company, fieldValue: inp("id"), output: ["id", "name", "deleted_at"], as: "row" }),
        inCrm(ref("row.name", { safe: true }), companyHref(ref("row.id", { safe: true }))),
      ] },
      { when: c.text("contact"), break: true, body: [
        s.db.get({ table: contact, fieldValue: inp("id"), output: ["id", "name", "company_id", "deleted_at"], as: "row" }),
        inCrm(ref("row.name", { safe: true }), contactHref(ref("row.company_id", { safe: true }), ref("row.id", { safe: true }))),
      ] },
      { when: c.text("deal"), break: true, body: [
        s.db.get({ table: deal, fieldValue: inp("id"), output: ["id", "title", "deleted_at"], as: "row" }),
        inCrm(ref("row.title", { safe: true }), dealHref(ref("row.id", { safe: true }))),
      ] },
      { when: c.text("crm_note"), break: true, body: [
        s.db.get({ table: crm_note, fieldValue: inp("id"), output: ["id", "company_id", "deleted_at"], as: "row" }),
        inCrm(c.text("A note"), companyHref(ref("row.company_id", { safe: true }))),
      ] },
    ] }),
    // A project, a task, a doc and a file live in a space, as a channel does.
    s.conditional({ when: expr(withFilters(c.array(["project", "task", "doc", "file"]), fl.in(inp("type"))), "=", c.bool(true)), then: [
      s.conditional({ when: expr(ref("space_id"), ">", c.int(0)), then: [
        s.update_var("scope", withFilters(c.text("space-"), fl.concat(ref("space_id")))),
        s.db.get({ table: space, fieldValue: ref("space_id"), output: ["archived_at"], as: "home" }),
        s.conditional({ when: expr(ref("home.archived_at", { safe: true }), "!=", c.null()), then: [s.update_var("archived", c.bool(true))] }),
      ] }),
    ] }),
    s.conditional({ when: expr(ref("conversation_id"), ">", c.int(0)), then: [
      s.db.get({ table: conversation, fieldValue: ref("conversation_id"), output: ["id", "kind", "name", "space_id", "dm_id", "crm", "record_type", "record_id", "parent_id"], as: "row" }),
      s.conditional({ when: expr(ref("row"), "!=", c.null()), then: [
        s.update_var("found", c.bool(true)),
        s.update_var("title", ref("row.name", { safe: true })),
        s.update_var("href", withFilters(c.text("/chat/"), fl.concat(ref("row.id", { safe: true })))),
        s.update_var("space_id", ref("row.space_id", { safe: true })),
        s.update_var("dm_id", ref("row.dm_id", { safe: true })),
        s.update_var("crm", ref("row.crm", { safe: true })),
        s.conditional({ when: expr(ref("row.kind", { safe: true }), "=", c.text("dm")), then: [s.update_var("dm_id", ref("row.id", { safe: true }))] }),
        s.conditional({
          when: expr(ref("dm_id"), ">", c.int(0)),
          then: [s.update_var("space_id", c.int(0)), s.update_var("scope", withFilters(c.text("dm-"), fl.concat(ref("dm_id"))))],
          else: [s.conditional({
            when: expr(ref("space_id"), ">", c.int(0)),
            then: [
              s.update_var("scope", withFilters(c.text("space-"), fl.concat(ref("space_id")))),
              s.db.get({ table: space, fieldValue: ref("space_id"), output: ["archived_at"], as: "home" }),
              s.conditional({ when: expr(ref("home.archived_at", { safe: true }), "!=", c.null()), then: [s.update_var("archived", c.bool(true))] }),
            ],
            else: [s.conditional({ when: expr(ref("crm"), "=", c.bool(true)), then: [s.update_var("scope", c.text("crm"))] })],
          })],
        }),
        // The thread on a task opens on the task, under its name.
        s.conditional({ when: expr(ref("row.record_type", { safe: true }), "=", c.text("task")), then: [
          s.set_var("subject_id", ref("row.record_id", { safe: true })),
          s.db.get({ table: task, fieldValue: ref("subject_id"), output: ["id", "title"], as: "subject" }),
          s.update_var("title", ref("subject.title", { safe: true })),
          s.update_var("href", withFilters(c.text("/tasks/"), fl.concat(ref("subject.id", { safe: true })))),
        ] }),
        // A thread on a message says where it is, as "Thread" alone says nothing beside other chips.
        s.conditional({ when: expr(ref("row.record_type", { safe: true }), "=", c.text("message")), then: [
          s.set_var("parent_id", ref("row.parent_id", { safe: true })),
          s.db.get({ table: conversation, fieldValue: ref("parent_id"), output: ["name"], as: "parent" }),
          s.update_var("title", withFilters(c.text("Thread in "), fl.concat(ref("parent.name", { safe: true })))),
        ] }),
        // So does a thread on a doc, a file or a customer.
        s.set_var("subject_id", ref("row.record_id", { safe: true })),
        s.switch({ on: ref("row.record_type", { safe: true }), cases: [
          { when: c.text("doc"), break: true, body: [
            s.db.get({ table: docTable, fieldValue: ref("subject_id"), output: ["title"], as: "subject" }),
            s.update_var("title", ref("subject.title", { safe: true })),
            s.update_var("href", withFilters(c.text("/docs/"), fl.concat(ref("subject_id")))),
          ] },
          { when: c.text("file"), break: true, body: [
            s.db.get({ table: file_record, fieldValue: ref("subject_id"), output: ["name"], as: "subject" }),
            s.update_var("title", ref("subject.name", { safe: true })),
            s.update_var("href", withFilters(c.text("/files/"), fl.concat(ref("subject_id")))),
          ] },
          { when: c.text("company"), break: true, body: [
            s.db.get({ table: company, fieldValue: ref("subject_id"), output: ["name"], as: "subject" }),
            s.update_var("title", ref("subject.name", { safe: true })),
            s.update_var("href", companyHref(ref("subject_id"))),
          ] },
          { when: c.text("contact"), break: true, body: [
            s.db.get({ table: contact, fieldValue: ref("subject_id"), output: ["name", "company_id"], as: "subject" }),
            s.update_var("title", ref("subject.name", { safe: true })),
            s.update_var("href", contactHref(ref("subject.company_id", { safe: true }), ref("subject_id"))),
          ] },
          { when: c.text("deal"), break: true, body: [
            s.db.get({ table: deal, fieldValue: ref("subject_id"), output: ["title"], as: "subject" }),
            s.update_var("title", ref("subject.title", { safe: true })),
            s.update_var("href", dealHref(ref("subject_id"))),
          ] },
        ] }),
        s.conditional({ when: expr(inp("type"), "=", c.text("message")), then: [
          s.update_var("title", withFilters(c.text("Message in "), fl.concat(ref("title")))),
          s.update_var("href", withFilters(ref("href"), fl.concat(c.text("?seq=")), fl.concat(ref("post.seq", { safe: true })))),
        ] }),
      ] }),
    ] }),
  ],
  response: {
    found: ref("found"), title: ref("title"), href: ref("href"), scope: ref("scope"), space_id: ref("space_id"), dm_id: ref("dm_id"),
    crm: ref("crm"), archived: ref("archived"), trashed: ref("trashed"), tombstone: ref("tombstone"), can_restore: ref("trashed"), detail: ref("detail"),
  },
});

/**
 * The link states, as one rule. A purged record has no row to check anyone's reach against, so it reads Deleted to
 * everybody. Anything else a viewer can't reach is locked, whatever state it's really in.
 */
export const linkState = defineFunction({
  name: "links/state",
  description: "What a record looks like to a viewer: live, locked, deleted, archived or tombstone.",
  input: { found: input.bool(), reachable: input.bool(), archived: input.bool(), trashed: input.bool(), tombstone: input.bool() },
  stack: [
    s.set_var("state", c.text("live")),
    s.conditional({ when: expr(inp("archived"), "=", c.bool(true)), then: [s.update_var("state", c.text("archived"))] }),
    s.conditional({ when: expr(inp("trashed"), "=", c.bool(true)), then: [s.update_var("state", c.text("deleted"))] }),
    s.conditional({ when: expr(inp("tombstone"), "=", c.bool(true)), then: [s.update_var("state", c.text("tombstone"))] }),
    s.conditional({ when: expr(inp("reachable"), "!=", c.bool(true)), then: [s.update_var("state", c.text("locked"))] }),
    s.conditional({ when: expr(inp("found"), "!=", c.bool(true)), then: [s.update_var("state", c.text("deleted"))] }),
  ],
  response: ref("state"),
});

/** The batch resolver: `items` is `[{ type, id }]`, answered in order, with a title only for a viewer it's meant for. */
export const resolveRecords = defineFunction({
  name: "links/resolve",
  description: "How each record looks to this viewer, in the order asked.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), items: input.json() },
  stack: [
    guard.require(expr(withFilters(inp("items"), fl.count()), "<=", c.int(MOST_AT_ONCE)), { errorType: "badrequest", message: `Ask for ${MOST_AT_ONCE} records at most.` }),
    reachOf(inp("actor_id"), inp("browser")),
    s.set_var("views", c.array([])),
    s.foreach({ list: inp("items"), as: "item", body: [
      s.function.run({ fn: locate, as: "target", input: { type: withFilters(ref("item.type", { safe: true }), fl.to_text()), id: withFilters(ref("item.id", { safe: true }), fl.to_int()) } }),
      s.set_var("reachable", withFilters(ref("reach.scopes"), fl.in(ref("target.scope")))),
      s.function.run({ fn: linkState, as: "state", input: { found: ref("target.found"), reachable: ref("reachable"), archived: ref("target.archived"), trashed: ref("target.trashed"), tombstone: ref("target.tombstone") } }),
      s.set_var("title", c.text("")),
      s.set_var("href", c.text("")),
      s.set_var("detail", c.obj({})),
      s.conditional({ when: expr(ref("state"), "=", c.text("live")), then: [s.update_var("title", ref("target.title")), s.update_var("href", ref("target.href")), s.update_var("detail", ref("target.detail"))] }),
      s.conditional({ when: expr(ref("state"), "=", c.text("archived")), then: [s.update_var("title", ref("target.title")), s.update_var("href", ref("target.href")), s.update_var("detail", ref("target.detail"))] }),
      s.set_var("can_restore", c.bool(false)),
      s.conditional({ when: and(expr(ref("state"), "=", c.text("deleted")), expr(ref("target.can_restore"), "=", c.bool(true))), then: [s.update_var("can_restore", c.bool(true))] }),
      s.update_var("views", withFilters(ref("views"), fl.array_push(obj({
        type: ref("item.type", { safe: true }), id: ref("item.id", { safe: true }), state: ref("state"), title: ref("title"), href: ref("href"), can_restore: ref("can_restore"), detail: ref("detail"),
        link_id: withFilters(ref("item.link_id", { safe: true }), fl.to_int()),
      })))),
    ] }),
  ],
  response: ref("views"),
});

export const recordFunctions = [locate, linkState, resolveRecords];
