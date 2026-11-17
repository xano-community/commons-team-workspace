// Asking first. Anything an agent may not do alone comes through `agentAsk`, which picks who decides and leaves the rest to the
// module: nothing runs until a person says yes.
//
//   Sponsor route   user_id is the sponsor, so only they decide.
//   Admin route     user_id stays the agent, and any admin decides, an admin sponsor included. A sponsor who can't reach the
//                   record lands here too, so they never read a preview of it. A DM has no admin route, because admins never read
//                   DMs: a run in one goes to the person who asked, who's in it.
//   A person's own connection keeps the module's path: user_id is the person, and they decide what their own client asked.
//
// Who wrote it comes from the key, never from the model: `agent_id` goes into the payload here.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { approvals } from "../approvals.js";
import { activity } from "../base/tables.js";
import { user } from "../table/user.js";
import { agent_run } from "../table/agents/agent_run.js";
import { conversation_member } from "../table/messaging/conversation_member.js";
import { space_member } from "../table/spaces/space_member.js";
import { company } from "../table/crm/company.js";
import { contact } from "../table/crm/contact.js";
import { accessRule, canReach, NOT_FOUND } from "../function/access/reach.js";
import { deliver } from "../function/inbox/deliver.js";
import { recordChange } from "../function/links/changes.js";
import { locate } from "../function/links/records.js";
import { requireActivePerson } from "../function/members/gate.js";

/** Actions only an admin decides. The rest go to the sponsor, because a member could do them by hand. */
const ADMIN_ACTIONS = ["export_crm", "grant_space_access", "change_role"];
export const ADMIN_ROUTE = ",admin,";
/** The rest of a sentence after the agent's name, for the inbox. It never holds a record's name: the card resolves that per viewer. */
const ASKS: Record<string, string> = {
  send_external: "wants to post where guests can read",
  send_dm: "wants to send a direct message",
  save_task: "wants to save a task guests can see",
  save_doc: "wants to save a doc guests can see",
  save_crm_record: "wants to link a customer where guests can see",
  save_file: "wants to add a file guests can see",
  delete_record: "wants to delete something",
  bulk_change: "wants to change several tasks at once",
  export_crm: "wants to export your customers",
  grant_space_access: "wants to join a space",
  change_role: "wants to change someone's role",
};

/** Whether anyone outside the team can read a record, through its space or its DM. CRM records have no guests. */
export const guestsRead = defineFunction({
  name: "agents/guests_read",
  description: "Whether a guest can read this record.",
  input: { type: input.text({ required: true }), id: input.int({ required: true }) },
  stack: [
    s.function.run({ fn: locate, as: "place", input: { type: inp("type"), id: inp("id") } }),
    s.set_var("people", c.array([])),
    s.conditional({
      when: expr(ref("place.dm_id"), ">", c.int(0)),
      then: [
        s.db.query({ table: conversation_member, where: cmp(col("conversation_id"), "=", ref("place.dm_id")), output: ["user_id"], as: "in_dm" }),
        s.array.map({ source: ref("in_dm"), as: "dm_ids", transform: ref("$this.user_id") }),
        s.update_var("people", ref("dm_ids")),
      ],
      else: [s.conditional({ when: expr(ref("place.space_id"), ">", c.int(0)), then: [
        s.db.query({ table: space_member, where: cmp(col("space_id"), "=", ref("place.space_id")), output: ["user_id"], as: "in_space" }),
        s.array.map({ source: ref("in_space"), as: "space_ids", transform: ref("$this.user_id") }),
        s.update_var("people", ref("space_ids")),
      ] })],
    }),
    s.db.query({ table: user, where: [cmp(col("id"), "in", ref("people")), cmp(col("role"), "=", c.text("guest")), cmp(col("status"), "=", c.text("active"))], returnType: "count", as: "guests" }),
  ],
  response: c.expression("$var.guests > 0"),
});

/** Tells screens that an approval moved, on the channels of the people who reach it. Ids only, like every frame. */
export const approvalChanged = defineFunction({
  name: "agents/approval_changed",
  description: "Publish that an approval changed.",
  input: { id: input.int({ required: true }), space_id: input.int(), crm: input.bool(), op: input.text() },
  stack: [
    s.conditional({ when: expr(inp("space_id"), ">", c.int(0)), then: [
      s.function.run({ fn: recordChange, as: "told", input: { channel: withFilters(c.text("spaces/"), fl.concat(inp("space_id"))), entity: c.text("approval"), id: inp("id"), op: inp("op"), actor_id: c.int(0), message: c.text(""), kind: c.text(""), link: c.text(""), at: c.int(0) } }),
    ] }),
    s.conditional({ when: expr(inp("crm"), "=", c.bool(true)), then: [
      s.function.run({ fn: recordChange, as: "told_crm", input: { channel: c.text("crm"), entity: c.text("approval"), id: inp("id"), op: inp("op"), actor_id: c.int(0), message: c.text(""), kind: c.text(""), link: c.text(""), at: c.int(0) } }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

/** Puts a pending approval in the inbox of whoever decides it now. A repeat changes nothing, so a reroute can call it freely. */
export const tellDeciders = defineFunction({
  name: "agents/tell_deciders",
  description: "Deliver an approval to the sponsor, or to every admin on the admin route.",
  input: { approval_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: approvals.approval, fieldValue: inp("approval_id"), as: "a" }),
    guard.found("a", { errorType: "notfound", message: NOT_FOUND }),
    s.set_var("agent_id", withFilters(ref("a.payload"), fl.get("agent_id", 0))),
    s.set_var("record_type", withFilters(ref("a.payload"), fl.get("record_type", ""))),
    s.set_var("record_id", withFilters(ref("a.payload"), fl.get("record_id", 0))),
    s.set_var("space_id", c.int(0)),
    s.set_var("dm_id", c.int(0)),
    s.set_var("crm", c.bool(false)),
    s.set_var("link", c.text("/approvals")),
    s.conditional({ when: expr(ref("record_id"), ">", c.int(0)), then: [
      s.function.run({ fn: locate, as: "place", input: { type: ref("record_type"), id: ref("record_id") } }),
      s.update_var("space_id", ref("place.space_id")),
      s.update_var("dm_id", ref("place.dm_id")),
      s.update_var("crm", ref("place.crm")),
      s.conditional({ when: expr(ref("place.href"), "!=", c.text("")), then: [s.update_var("link", ref("place.href"))] }),
    ] }),
    s.set_var("line", withFilters(ref("a.agent_label"), fl.concat(c.text(" ")), fl.concat(withFilters(c.obj(ASKS), fl.get(ref("a.action"), "wants your OK"))))),
    s.set_var("deciders", c.array([])),
    s.conditional({
      when: expr(withFilters(ref("a.approver_roles"), fl.contains(c.text(ADMIN_ROUTE))), "=", c.bool(true)),
      then: [
        s.db.query({ table: user, where: [cmp(col("role"), "=", c.text("admin")), cmp(col("kind"), "=", c.text("human")), cmp(col("status"), "=", c.text("active")), cmp(col("id"), "!=", ref("a.user_id"))], output: ["id"], as: "admins" }),
        s.array.map({ source: ref("admins"), as: "admin_ids", transform: ref("$this.id") }),
        s.update_var("deciders", ref("admin_ids")),
      ],
      else: [s.update_var("deciders", withFilters(c.array([]), fl.array_push(ref("a.user_id"))))],
    }),
    // A person's own client asked in their name, so the line has no one else behind it to name as its author.
    s.set_var("from", ref("agent_id")),
    s.foreach({ list: ref("deciders"), as: "decider", body: [
      s.conditional({ when: expr(ref("decider"), "=", ref("agent_id")), then: [s.update_var("from", c.int(0))] }),
      s.function.run({ fn: deliver, as: "told", input: {
        user_id: ref("decider"), kind: c.text("approval"), title: ref("line"), body: c.text(""), link: ref("link"), actor_id: ref("from"), space_id: ref("space_id"), dm_id: ref("dm_id"),
        entity: c.text("approval"), entity_id: inp("approval_id"), group_key: withFilters(c.text("approval-"), fl.concat(inp("approval_id"))), seq: c.int(0), crm: ref("crm"),
      } }),
      s.function.run({ fn: recordChange, as: "told_tabs", input: { channel: withFilters(c.text("users/"), fl.concat(ref("decider"))), entity: c.text("approval"), id: inp("approval_id"), op: c.text("created"), actor_id: c.int(0), message: c.text(""), kind: c.text(""), link: c.text(""), at: c.int(0) } }),
    ] }),
    s.function.run({ fn: approvalChanged, as: "told_screens", input: { id: inp("approval_id"), space_id: ref("space_id"), crm: ref("crm"), op: c.text("created") } }),
  ],
  response: { ok: c.bool(true) },
});

/** Who decides, and the payload that carries who asked. A sponsor who can't reach the record never sees it. */
export const askRoute = defineFunction({
  name: "agents/ask_route",
  description: "Work out who decides an agent's request, and stamp it with who asked.",
  input: {
    actor_id: input.int({ required: true }), connection_id: input.int(), run_id: input.int(), action: input.text({ required: true }), record_type: input.text(), record_id: input.int(), payload: input.json(),
    /** The app behind a person's own connection. Empty for an agent. */
    via: input.text(),
  },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "name", "kind", "sponsor_id"], as: "member" }),
    guard.found("member", { errorType: "notfound", message: NOT_FOUND }),
    s.set_var("user_id", inp("actor_id")),
    s.set_var("admin_route", c.bool(false)),
    s.set_var("link", c.text("")),
    s.set_var("dm_id", c.int(0)),
    s.conditional({ when: expr(inp("record_id"), ">", c.int(0)), then: [
      s.function.run({ fn: locate, as: "target", input: { type: inp("record_type"), id: inp("record_id") } }),
      s.update_var("link", ref("target.href")),
      s.update_var("dm_id", ref("target.dm_id")),
    ] }),
    // A person's own client speaks as the app it is, so the card reads "ChatGPT wants to", for that person to decide.
    s.set_var("label", inp("via")),
    /** Set when someone other than the sponsor decides, so a later reroute leaves it with them. */
    s.set_var("decider_id", c.int(0)),
    s.conditional({ when: expr(ref("member.kind"), "=", c.text("agent")), then: [
      s.update_var("label", ref("member.name")),
      s.set_var("sponsor_reaches", c.bool(true)),
      s.conditional({ when: expr(inp("record_id"), ">", c.int(0)), then: [
        s.function.run({ fn: canReach, as: "reachable", input: { actor_id: ref("member.sponsor_id"), browser: c.bool(true), type: inp("record_type"), id: inp("record_id") } }),
        s.update_var("sponsor_reaches", ref("reachable")),
      ] }),
      s.conditional({
        when: expr(withFilters(c.array(ADMIN_ACTIONS), fl.in(inp("action"))), "=", c.bool(true)),
        then: [s.update_var("admin_route", c.bool(true))],
        else: [s.conditional({
          when: expr(ref("sponsor_reaches"), "=", c.bool(true)),
          then: [s.update_var("user_id", ref("member.sponsor_id"))],
          else: [s.conditional({
            when: expr(ref("dm_id"), "=", c.int(0)),
            then: [s.update_var("admin_route", c.bool(true))],
            else: [
              s.db.get({ table: agent_run, fieldValue: inp("run_id"), output: ["requested_by"], as: "run" }),
              s.update_var("decider_id", withFilters(ref("run.requested_by", { safe: true }), fl.first_notnull(c.int(0)))),
              // A connected agent has no run, so nobody asked it here who could decide in the sponsor's place.
              guard.require(expr(ref("decider_id"), ">", c.int(0)), { errorType: "badrequest", message: "Your sponsor isn't in this conversation, and nobody outside it can read it, so nobody can approve this." }),
              s.function.run({ fn: canReach, as: "decider_reaches", input: { actor_id: ref("decider_id"), browser: c.bool(true), type: inp("record_type"), id: inp("record_id") } }),
              guard.require(expr(ref("decider_reaches"), "=", c.bool(true)), { errorType: "badrequest", message: "Your sponsor isn't in this conversation, and nobody outside it can read it, so nobody can approve this." }),
              s.update_var("user_id", ref("decider_id")),
            ],
          })],
        })],
      }),
    ] }),
  ],
  response: {
    user_id: ref("user_id"), admin_route: ref("admin_route"), label: ref("label"), link: ref("link"),
    payload: withFilters(withFilters(inp("payload"), fl.first_notnull(c.obj({}))),
      fl.set("agent_id", inp("actor_id")), fl.set("connection_id", inp("connection_id")), fl.set("run_id", inp("run_id")), fl.set("record_type", inp("record_type")), fl.set("record_id", inp("record_id")), fl.set("decider_id", ref("decider_id"))),
  },
});

/** Once the row exists: it reaches whoever decides, a run waits for them, and the agent is told what to say. */
export const askFinish = defineFunction({
  name: "agents/ask_finish",
  description: "Tell whoever decides, pause a run, and answer the agent in plain words.",
  input: { approval_id: input.int({ required: true }), run_id: input.int(), user_id: input.int({ required: true }), admin_route: input.bool() },
  stack: [
    s.conditional({ when: expr(inp("admin_route"), "=", c.bool(true)), then: [
      s.db.patch({ table: approvals.approval, fieldValue: inp("approval_id"), data: obj({ approver_roles: c.text(ADMIN_ROUTE) }) }),
    ] }),
    s.function.run({ fn: tellDeciders, as: "told", input: { approval_id: inp("approval_id") } }),
    s.set_var("waiting_for", c.text("an admin")),
    s.set_var("decider_id", c.int(0)),
    s.conditional({ when: expr(inp("admin_route"), "=", c.bool(false)), then: [
      s.db.get({ table: user, fieldValue: inp("user_id"), output: ["name"], as: "decider" }),
      s.update_var("waiting_for", ref("decider.name", { safe: true })),
      s.update_var("decider_id", inp("user_id")),
    ] }),
    s.conditional({ when: expr(inp("run_id"), ">", c.int(0)), then: [
      s.db.patch({ table: agent_run, fieldValue: inp("run_id"), as: "paused", data: obj({ status: c.text("waiting"), waiting_on: ref("decider_id"), approval_id: inp("approval_id") }) }),
      s.function.run({ fn: "agents/changed", as: "run_told", input: { run_id: inp("run_id"), space_id: ref("paused.space_id"), dm_id: ref("paused.dm_id"), op: c.text("updated") } }),
    ] }),
  ],
  response: {
    approval_id: inp("approval_id"), status: c.text("pending"), waiting_for: ref("waiting_for"),
    message: withFilters(c.text("Not done yet: "), fl.concat(ref("waiting_for")), fl.concat(c.text(" has to approve this first. Tell them it's ready to review, and don't ask again. The decision comes to your inbox."))),
  },
});

/**
 * The one door to a person's OK. `record_type` and `record_id` name what it concerns, and whoever decides can reach that. Inside a
 * run the run waits: the model's next call is refused, and the decision queues it again.
 */
export const agentAsk = defineFunction({
  name: "agents/ask",
  description: "Ask for approval on an agent's behalf, routed to its sponsor or to the admins.",
  input: {
    actor_id: input.int({ required: true }), connection_id: input.int(), run_id: input.int(), action: input.text({ required: true }), title: input.text({ required: true }), preview: input.text(),
    record_type: input.text(), record_id: input.int(), payload: input.json(), via: input.text(),
  },
  stack: [
    s.function.run({ fn: askRoute, as: "route", input: { actor_id: inp("actor_id"), connection_id: inp("connection_id"), run_id: inp("run_id"), action: inp("action"), record_type: inp("record_type"), record_id: inp("record_id"), payload: inp("payload"), via: inp("via") } }),
    s.function.run({ fn: approvals.requestApproval, as: "row", input: {
      user_id: ref("route.user_id"), source: c.text("mcp"), agent_label: ref("route.label"), connection_id: inp("connection_id"), action: inp("action"), title: inp("title"), preview: inp("preview"), link: ref("route.link"), payload: ref("route.payload"),
    } }),
    s.function.run({ fn: askFinish, as: "answer", input: { approval_id: ref("row.approval_id"), run_id: inp("run_id"), user_id: ref("route.user_id"), admin_route: ref("route.admin_route") } }),
  ],
  response: ref("answer"),
});

/** Before an approved action runs: the person may still decide this, and the agent is still fit to do it. */
export const approvalChecks = defineFunction({
  name: "agents/approval_checks",
  description: "Refuse an approval if the approver or the agent has lost what it needs.",
  input: { approver_id: input.int({ required: true }), agent_id: input.int({ required: true }), record_type: input.text(), record_id: input.int() },
  stack: [
    s.db.get({ table: user, fieldValue: inp("approver_id"), output: ["id", "kind", "role", "status"], as: "approver" }),
    guard.found("approver", { errorType: "accessdenied", message: "Only a person on the team can approve this." }),
    ...requireActivePerson("approver", { message: "Only a person on the team can approve this." }),
    guard.require(expr(ref("approver.role"), "!=", c.text("guest")), { errorType: "accessdenied", message: "Only a person on the team can approve this." }),
    s.db.get({ table: user, fieldValue: inp("agent_id"), output: ["id", "name", "status"], as: "worker" }),
    guard.found("worker", { errorType: "badrequest", message: "This agent no longer exists, so this can't go ahead. Decline it." }),
    s.set_var("no_longer", withFilters(ref("worker.name"), fl.concat(c.text(" can't reach this any more, so this can't go ahead. Add them back to the space, or decline it.")))),
    s.precondition({ expr: expr(ref("worker.status"), "=", c.text("active")), error_type: "badrequest", error: ref("no_longer") }),
    s.conditional({ when: expr(inp("record_id"), ">", c.int(0)), then: [
      s.function.run({ fn: canReach, as: "approver_reaches", input: { actor_id: inp("approver_id"), browser: c.bool(true), type: inp("record_type"), id: inp("record_id") } }),
      guard.require(expr(ref("approver_reaches"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
      s.function.run({ fn: canReach, as: "agent_reaches", input: { actor_id: inp("agent_id"), browser: c.bool(false), type: inp("record_type"), id: inp("record_id") } }),
      s.precondition({ expr: expr(ref("agent_reaches"), "=", c.bool(true)), error_type: "badrequest", error: ref("no_longer") }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

/** After an approved action: the feed says who approved it, a run's held notes reach guests, and the run goes back in the queue. */
export const settleApproved = defineFunction({
  name: "agents/settle_approved",
  description: "Record the approver on what an agent just did, and pick its run up again.",
  input: { approver_id: input.int({ required: true }), agent_id: input.int({ required: true }), run_id: input.int(), since: input.int() },
  stack: [
    s.conditional({ when: expr(inp("approver_id"), "!=", inp("agent_id")), then: [
      s.db.query({ table: activity, where: [cmp(col("actor_id"), "=", inp("agent_id")), expr(col("created_at"), ">=", inp("since"))], output: ["id"], as: "lines" }),
      s.foreach({ list: ref("lines"), as: "line", body: [s.db.patch({ table: activity, fieldValue: ref("line.id"), data: obj({ approved_by: inp("approver_id") }) })] }),
    ] }),
    s.conditional({ when: expr(inp("run_id"), ">", c.int(0)), then: [
      s.function.run({ fn: "messages/release_held", as: "released", input: { run_id: inp("run_id"), actor_id: inp("agent_id") } }),
      s.function.run({ fn: "agents/resume", as: "resumed", input: { run_id: inp("run_id") } }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

/** The trash, by the same doors a person's Delete uses. Bulk and CRM cascades live in those functions. */
export const deleteRecord = defineFunction({
  name: "agents/delete_record",
  description: "Put one record in the trash as an agent.",
  input: { actor_id: input.int({ required: true }), type: input.text({ required: true }), id: input.int({ required: true }) },
  stack: [
    s.switch({ on: inp("type"), cases: [
      { when: c.text("task"), break: true, body: [s.function.run({ fn: "tasks/delete", as: "gone", input: { actor_id: inp("actor_id"), browser: c.bool(false), id: inp("id") } })] },
      { when: c.text("doc"), break: true, body: [s.function.run({ fn: "docs/delete", as: "gone", input: { actor_id: inp("actor_id"), id: inp("id") } })] },
      { when: c.text("file"), break: true, body: [s.function.run({ fn: "files/delete", as: "gone", input: { actor_id: inp("actor_id"), browser: c.bool(false), id: inp("id") } })] },
      { when: c.text("company"), break: true, body: [s.function.run({ fn: "crm/delete_company", as: "gone", input: { actor_id: inp("actor_id"), browser: c.bool(false), id: inp("id") } })] },
      { when: c.text("contact"), break: true, body: [s.function.run({ fn: "crm/delete_contact", as: "gone", input: { actor_id: inp("actor_id"), browser: c.bool(false), id: inp("id") } })] },
      { when: c.text("deal"), break: true, body: [s.function.run({ fn: "crm/delete_deal", as: "gone", input: { actor_id: inp("actor_id"), browser: c.bool(false), id: inp("id") } })] },
    ] }),
  ],
  response: { deleted: c.bool(true), type: inp("type"), id: inp("id") },
});

/** Many tasks at once. Each one goes through the action a person's own change takes. */
export const bulkChange = defineFunction({
  name: "agents/bulk_change",
  description: "Change the status, priority or assignee of a list of tasks as an agent.",
  input: { actor_id: input.int({ required: true }), run_id: input.int(), ids: input.json(), status: input.text(), priority: input.text(), assignee_id: input.int() },
  stack: [
    s.foreach({ list: inp("ids"), as: "task_id", body: [
      s.function.run({ fn: "agents/require_in_scope", as: "in_scope", input: { actor_id: inp("actor_id"), run_id: inp("run_id"), type: c.text("task"), id: ref("task_id") } }),
      s.conditional({ when: expr(inp("status"), "!=", c.text("")), then: [s.function.run({ fn: "tasks/set_status", as: "moved", input: { actor_id: inp("actor_id"), browser: c.bool(false), id: ref("task_id"), status: inp("status") } })] }),
      s.conditional({ when: expr(inp("priority"), "!=", c.text("")), then: [s.function.run({ fn: "tasks/set_priority", as: "ranked", input: { actor_id: inp("actor_id"), browser: c.bool(false), id: ref("task_id"), priority: inp("priority") } })] }),
      s.conditional({ when: expr(inp("assignee_id"), ">", c.int(0)), then: [s.function.run({ fn: "tasks/assign", as: "assigned", input: { actor_id: inp("actor_id"), browser: c.bool(false), id: ref("task_id"), assignee_id: inp("assignee_id") } })] }),
    ] }),
  ],
  response: { changed: withFilters(inp("ids"), fl.count()) },
});

const MOST_EXPORTED = 5000;
const csvCell = (v: Parameters<typeof withFilters>[0]) => withFilters(c.text('"'), fl.concat(withFilters(v, fl.to_text(), fl.string_replace(c.text('"'), c.text('""')))), fl.concat(c.text('"')));

/** Every company and contact as a CSV file in a space, so it goes through the same door as any upload. */
export const exportCrm = defineFunction({
  name: "agents/export_crm",
  description: "Save the customers as a CSV file in a space.",
  input: { actor_id: input.int({ required: true }), space_id: input.int({ required: true }) },
  stack: [
    s.function.run({ fn: accessRule, as: "may_read", input: { actor_id: inp("actor_id"), browser: c.bool(false), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
    guard.require(expr(ref("may_read"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
    s.db.query({ table: company, where: cmp(col("deleted_at"), "=", c.null()), sort: [{ sortBy: "name", dir: "asc" }], paging: { per_page: MOST_EXPORTED, metadata: false }, output: ["id", "name", "domain", "industry"], as: "companies" }),
    s.db.query({ table: contact, where: cmp(col("deleted_at"), "=", c.null()), sort: [{ sortBy: "name", dir: "asc" }], paging: { per_page: MOST_EXPORTED, metadata: false }, output: ["company_id", "name", "email", "phone", "job_title"], as: "people" }),
    s.set_var("csv", c.text("type,name,company_id,domain_or_email,industry_or_title\n")),
    s.foreach({ list: ref("companies"), as: "row", body: [
      s.update_var("csv", withFilters(ref("csv"), fl.concat(c.text("company,")), fl.concat(csvCell(ref("row.name"))), fl.concat(c.text(",")), fl.concat(ref("row.id")), fl.concat(c.text(",")), fl.concat(csvCell(ref("row.domain"))), fl.concat(c.text(",")), fl.concat(csvCell(ref("row.industry"))), fl.concat(c.text("\n")))),
    ] }),
    s.foreach({ list: ref("people"), as: "row", body: [
      s.update_var("csv", withFilters(ref("csv"), fl.concat(c.text("contact,")), fl.concat(csvCell(ref("row.name"))), fl.concat(c.text(",")), fl.concat(ref("row.company_id")), fl.concat(c.text(",")), fl.concat(csvCell(ref("row.email"))), fl.concat(c.text(",")), fl.concat(csvCell(ref("row.job_title"))), fl.concat(c.text("\n")))),
    ] }),
    s.set_var("named", withFilters(c.text("customers-"), fl.concat(withFilters(c.now(), fl.epochms_date("Y-m-d", "UTC"))), fl.concat(c.text(".csv")))),
    s.storage.create_file_resource({ as: "written", filename: ref("named"), filedata: ref("csv") }),
    s.security.create_uuid({ as: "file_key" }),
    s.function.run({ fn: "files/store", as: "stored", input: { actor_id: inp("actor_id"), browser: c.bool(false), file: ref("written"), client_id: ref("file_key"), place_type: c.text("space"), place_id: inp("space_id"), run_id: c.int(0) } }),
    s.precondition({ expr: expr(ref("stored.ok"), "=", c.bool(true)), error_type: "badrequest", error: ref("stored.message") }),
  ],
  response: { file_id: ref("stored.file.id"), name: ref("stored.file.name"), companies: withFilters(ref("companies"), fl.count()), contacts: withFilters(ref("people"), fl.count()) },
});

export const askFunctions = [guestsRead, approvalChanged, tellDeciders, askRoute, askFinish, agentAsk, approvalChecks, settleApproved, deleteRecord, bulkChange, exportCrm];
