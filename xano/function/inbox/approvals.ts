// Approvals as a screen sees them. The approval row belongs to the module, so this is what turns one into a card: who's asking, where
// it lands, who can read it, and whether this person decides it. A record's page shows the same card to whoever decides, and a
// quiet line to anyone else who reaches the record. Guests have no part in approvals.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, middleware, or, ref, s, withFilters } from "@xano/sdk";
import { approvals } from "../../approvals.js";
import { user } from "../../table/user.js";
import { agent_run } from "../../table/agents/agent_run.js";
import { space_member } from "../../table/spaces/space_member.js";
import { canReach, NOT_FOUND, requireReach } from "../access/reach.js";
import { locate, resolveRecords } from "../links/records.js";
import { closeItems } from "./deliver.js";

/**
 * After an approval is decided, its item leaves every approver's inbox, live. The agents module has no hook for this, so
 * it runs after the decide routes (xano/index.ts). A failure here can't undo the decision: the list hides the item anyway.
 */
export const afterDecision = middleware({
  name: "inbox/after_decision",
  description: "Close an approval's inbox items for everyone once it's decided.",
  exceptionPolicy: "silent",
  stack: [
    s.util.get_all_input({ as: "payload" }),
    s.set_var("decided", ref("payload.vars.result.id", { safe: true })),
    s.conditional({ when: expr(ref("decided"), ">", c.int(0)), then: [
      s.function.run({ fn: closeItems, as: "closed", input: { entity: c.text("approval"), entity_id: ref("decided"), kind: c.text("approval"), user_id: c.int(0), seq: c.int(0) } }),
    ] }),
  ],
});

const who = { actor_id: input.int({ required: true }), browser: input.bool() };
const MOST_OVERSEEN = 50;

/** One approval for one reader: all of it for whoever decides or decided, and a line for anyone else who reaches the record. */
export const approvalView = defineFunction({
  name: "approvals/view",
  description: "An approval as a card, for someone who decides it, or as a waiting line for someone who only reaches its record.",
  input: {
    ...who, id: input.int({ required: true }),
    /** An admin reading what waits on someone else: the whole card, read-only, and never for a record in a DM. */
    oversee: input.bool(),
  },
  stack: [
    s.db.get({ table: approvals.approval, fieldValue: inp("id"), as: "a" }),
    guard.found("a", { errorType: "notfound", message: NOT_FOUND }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "me" }),
    guard.require(expr(ref("me.role", { safe: true }), "!=", c.text("guest")), { errorType: "notfound", message: NOT_FOUND }),
    s.set_var("role_token", withFilters(c.text(","), fl.concat(ref("me.role", { safe: true })), fl.concat(c.text(",")))),
    s.set_var("decides", c.bool(false)),
    s.conditional({ when: or(
      and(expr(ref("a.approver_roles"), "=", c.text("")), expr(ref("a.user_id"), "=", inp("actor_id"))),
      and(expr(withFilters(ref("a.approver_roles"), fl.contains(ref("role_token"))), "=", c.bool(true)), expr(ref("a.user_id"), "!=", inp("actor_id"))),
    ), then: [s.update_var("decides", c.bool(true))] }),
    s.set_var("record_type", withFilters(ref("a.payload"), fl.get("record_type", ""))),
    s.set_var("record_id", withFilters(ref("a.payload"), fl.get("record_id", 0))),
    s.set_var("reaches", c.bool(true)),
    s.set_var("record", c.null()),
    s.set_var("guests", c.array([])),
    s.conditional({ when: expr(ref("record_id"), ">", c.int(0)), then: [
      s.function.run({ fn: canReach, as: "reachable", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: ref("record_type"), id: ref("record_id") } }),
      s.update_var("reaches", ref("reachable")),
    ] }),
    guard.require(expr(ref("reaches"), "=", c.bool(true)), { errorType: "notfound", message: NOT_FOUND }),
    s.set_var("overseen", c.bool(false)),
    s.conditional({ when: and(expr(inp("oversee"), "=", c.bool(true)), expr(ref("me.role", { safe: true }), "=", c.text("admin")), expr(ref("record_id"), ">", c.int(0))), then: [
      s.function.run({ fn: locate, as: "seen_at", input: { type: ref("record_type"), id: ref("record_id") } }),
      s.conditional({ when: expr(ref("seen_at.dm_id"), "=", c.int(0)), then: [s.update_var("overseen", c.bool(true))] }),
    ] }),
    s.set_var("full", c.expression("$var.decides == true || $var.a.decided_by == $input.actor_id || $var.overseen == true")),
    s.conditional({ when: and(expr(ref("full"), "=", c.bool(true)), expr(ref("record_id"), ">", c.int(0))), then: [
      s.function.run({ fn: resolveRecords, as: "records", input: { actor_id: inp("actor_id"), browser: inp("browser"), items: withFilters(c.array([]), fl.array_push(c.expression('{"type": $var.record_type, "id": $var.record_id}'))) } }),
      s.update_var("record", withFilters(ref("records"), fl.first())),
      s.function.run({ fn: locate, as: "place", input: { type: ref("record_type"), id: ref("record_id") } }),
      s.conditional({ when: expr(ref("place.space_id"), ">", c.int(0)), then: [
        s.db.query({ table: space_member, where: cmp(col("space_id"), "=", ref("place.space_id")), output: ["user_id"], as: "in_space" }),
        s.array.map({ source: ref("in_space"), as: "member_ids", transform: ref("$this.user_id") }),
        s.db.query({ table: user, where: [cmp(col("id"), "in", ref("member_ids")), cmp(col("role"), "=", c.text("guest")), cmp(col("status"), "=", c.text("active"))], output: ["name"], as: "guest_rows" }),
        s.array.map({ source: ref("guest_rows"), as: "guest_names", transform: ref("$this.name") }),
        s.update_var("guests", ref("guest_names")),
      ] }),
    ] }),
    s.set_var("status", ref("a.status")),
    s.conditional({ when: and(expr(ref("a.status"), "=", c.text("pending")), expr(ref("a.expires_at"), "<=", c.now())), then: [s.update_var("status", c.text("expired"))] }),
    s.db.get({ table: user, fieldValue: withFilters(ref("a.payload"), fl.get("agent_id", 0)), output: ["id", "kind"], as: "worker" }),
    // The demo's seeded request says so on its card: no model wrote it.
    s.db.get({ table: agent_run, fieldValue: withFilters(ref("a.payload"), fl.get("run_id", 0)), output: ["sample"], as: "asked_in" }),
    s.db.get({ table: user, fieldValue: ref("a.user_id"), output: ["name", "kind"], as: "owner" }),
    s.db.get({ table: user, fieldValue: ref("a.decided_by"), output: ["name"], as: "decider" }),
    s.set_var("waiting_for", ref("owner.name", { safe: true })),
    s.conditional({ when: expr(ref("a.approver_roles"), "!=", c.text("")), then: [s.update_var("waiting_for", c.text("an admin"))] }),
    s.set_var("details", c.null()),
    s.set_var("preview", c.text("")),
    s.set_var("title", c.text("")),
    s.conditional({ when: expr(ref("full"), "=", c.bool(true)), then: [
      s.update_var("details", ref("a.payload")),
      s.update_var("preview", ref("a.preview")),
      s.update_var("title", ref("a.title")),
    ] }),
  ],
  response: {
    id: ref("a.id"), status: ref("status"), action: ref("a.action"), title: ref("title"), preview: ref("preview"), approve_label: ref("a.approve_label"), editable_field: ref("a.editable_field"), details: ref("details"),
    agent_id: ref("worker.id", { safe: true }), agent_name: ref("a.agent_label"), agent_kind: ref("worker.kind", { safe: true }), waiting_for: ref("waiting_for"), can_decide: ref("decides"), record: ref("record"), guests: ref("guests"),
    sample: withFilters(ref("asked_in.sample", { safe: true }), fl.first_notnull(c.bool(false))), created_at: ref("a.created_at"), expires_at: ref("a.expires_at"), decided_at: ref("a.decided_at"), decided_by_name: ref("decider.name", { safe: true }), link: ref("a.link"),
  },
});

/** What's waiting on a record: its own requests, and those on its thread. */
export const recordApprovals = defineFunction({
  name: "approvals/on_record",
  description: "The pending approvals about one record, each as this reader may see it.",
  input: { ...who, type: input.text({ required: true }), id: input.int({ required: true }), thread_id: input.int() },
  stack: [
    ...requireReach({ actor: inp("actor_id"), browser: inp("browser"), type: inp("type"), id: inp("id") }),
    s.set_var("items", c.array([])),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["role"], as: "reader" }),
    s.conditional({ when: expr(ref("reader.role", { safe: true }), "!=", c.text("guest")), then: [
      s.db.query({ table: approvals.approval, where: [cmp(col("status"), "=", c.text("pending")), expr(col("expires_at"), ">", c.now())], sort: [{ sortBy: "created_at", dir: "asc" }], output: ["id", "payload"], as: "waiting" }),
      s.foreach({ list: ref("waiting"), as: "row", body: [
        s.set_var("about_type", withFilters(ref("row.payload"), fl.get("record_type", ""))),
        s.set_var("about_id", withFilters(ref("row.payload"), fl.get("record_id", 0))),
        s.conditional({ when: or(
          and(expr(ref("about_type"), "=", inp("type")), expr(ref("about_id"), "=", inp("id"))),
          and(expr(ref("about_type"), "=", c.text("conversation")), expr(ref("about_id"), "=", inp("thread_id"))),
        ), then: [
          s.function.run({ fn: approvalView, as: "view", input: { actor_id: inp("actor_id"), browser: inp("browser"), id: ref("row.id") } }),
          s.update_var("items", withFilters(ref("items"), fl.array_push(ref("view")))),
        ] }),
      ] }),
    ] }),
  ],
  response: { items: ref("items") },
});

/**
 * What waits on someone else, for an admin in a browser: requests a sponsor decides, so an admin can see what agents are asking
 * across the spaces they oversee, and who it's waiting on. Read-only. Nothing in a DM, because admins never read DMs, and nothing
 * without a record, because then there's no way to be sure it isn't one. Requests on the admin route are already the admin's own.
 */
export const overseenApprovals = defineFunction({
  name: "approvals/overseen",
  description: "For an admin: agent requests waiting on someone else, outside DMs, as read-only cards.",
  input: { ...who },
  stack: [
    s.set_var("items", c.array([])),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["role", "kind"], as: "reader" }),
    s.conditional({ when: and(expr(ref("reader.role", { safe: true }), "=", c.text("admin")), expr(ref("reader.kind", { safe: true }), "=", c.text("human")), expr(inp("browser"), "=", c.bool(true))), then: [
      s.db.query({ table: approvals.approval, where: [cmp(col("status"), "=", c.text("pending")), expr(col("expires_at"), ">", c.now()), cmp(col("approver_roles"), "=", c.text("")), cmp(col("user_id"), "!=", inp("actor_id")), cmp(col("action"), "!=", c.text("send_dm"))],
        sort: [{ sortBy: "created_at", dir: "desc" }], paging: { per_page: MOST_OVERSEEN, metadata: false }, output: ["id", "payload"], as: "waiting" }),
      s.foreach({ list: ref("waiting"), as: "row", body: [
        s.set_var("about_type", withFilters(ref("row.payload"), fl.get("record_type", ""))),
        s.set_var("about_id", withFilters(ref("row.payload"), fl.get("record_id", 0))),
        s.conditional({ when: expr(ref("about_id"), ">", c.int(0)), then: [
          s.function.run({ fn: locate, as: "place", input: { type: ref("about_type"), id: ref("about_id") } }),
          s.conditional({ when: expr(ref("place.dm_id"), "=", c.int(0)), then: [
            s.function.run({ fn: approvalView, as: "view", input: { actor_id: inp("actor_id"), browser: inp("browser"), id: ref("row.id"), oversee: c.bool(true) } }),
            s.update_var("items", withFilters(ref("items"), fl.array_push(ref("view")))),
          ] }),
        ] }),
      ] }),
    ] }),
  ],
  response: { items: ref("items") },
});

export const approvalFunctions = [approvalView, recordApprovals, overseenApprovals];
