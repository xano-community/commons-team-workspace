// What happens after someone decides, and what catches the rest. `tableTrigger` hears every decision, because the module has no hook
// for a decline and expiry writes nothing of its own. The hourly sweep is the backstop: it expires what nobody decided, moves
// approvals off a sponsor who can't reach them any more, picks up runs a decision missed, and stops agents whose sponsor has gone.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, tableTrigger, task as scheduledTask, withFilters, and } from "@xano/sdk";
import { agent } from "../agent.js";
import { approvals } from "../approvals.js";
import { user } from "../table/user.js";
import { agent_run } from "../table/agents/agent_run.js";
import { canReach } from "../function/access/reach.js";
import { closeItems, deliver } from "../function/inbox/deliver.js";
import { locate } from "../function/links/records.js";
import { ADMIN_ROUTE, approvalChanged, tellDeciders } from "./ask.js";
import { SYSTEM_CONNECTION } from "./member-tool.js";

const conn = agent.agent_connection;
const HOUR_SECONDS = 3_600;
const KEY_WARNING_MS = 7 * 86_400_000;
const LIVE_RUNS = ["queued", "claimed", "working", "waiting"];
const NOBODY_CAN = "This can't be decided any more: only people in the conversation could read it, and the agent's sponsor has left it.";

/** Whatever way a request ended: it leaves every inbox, its agent hears, and a run waiting on it goes back in the queue. */
export const afterDecisionFn = defineFunction({
  name: "agents/after_decision",
  description: "Tell an agent how its request ended, and pick its run up again. Safe to call twice.",
  input: { approval_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: approvals.approval, fieldValue: inp("approval_id"), as: "a" }),
    guard.found("a", { message: "No such approval." }),
    s.conditional({ when: expr(ref("a.status"), "!=", c.text("pending")), then: [
      s.function.run({ fn: closeItems, as: "closed", input: { entity: c.text("approval"), entity_id: inp("approval_id"), kind: c.text("approval"), user_id: c.int(0), seq: c.int(0) } }),
      s.set_var("agent_id", withFilters(ref("a.payload"), fl.get("agent_id", 0))),
      s.set_var("run_id", withFilters(ref("a.payload"), fl.get("run_id", 0))),
      s.db.get({ table: user, fieldValue: ref("agent_id"), output: ["kind"], as: "worker" }),
      s.conditional({ when: expr(ref("worker.kind", { safe: true }), "=", c.text("agent")), then: [
        s.db.get({ table: user, fieldValue: ref("a.decided_by"), output: ["name"], as: "decider" }),
        s.set_var("outcome", withFilters(c.text("Approved by "), fl.concat(ref("decider.name", { safe: true })))),
        s.conditional({ when: expr(ref("a.status"), "=", c.text("declined")), then: [s.update_var("outcome", withFilters(c.text("Declined by "), fl.concat(ref("decider.name", { safe: true }))))] }),
        s.conditional({ when: expr(ref("a.status"), "=", c.text("expired")), then: [s.update_var("outcome", c.text("Nobody decided in time"))] }),
        s.function.run({ fn: deliver, as: "told", input: {
          user_id: ref("agent_id"), kind: c.text("approval_decided"), title: withFilters(ref("outcome"), fl.concat(c.text(": ")), fl.concat(ref("a.title"))), body: ref("a.status"), link: ref("a.link"), actor_id: ref("a.decided_by"),
          space_id: c.int(0), dm_id: c.int(0), entity: c.text("approval_result"), entity_id: inp("approval_id"), group_key: withFilters(c.text("decision-"), fl.concat(inp("approval_id"))), seq: c.int(0),
        } }),
      ] }),
      s.conditional({ when: expr(ref("run_id"), ">", c.int(0)), then: [s.function.run({ fn: "agents/resume", as: "resumed", input: { run_id: ref("run_id") } })] }),
      s.set_var("record_id", withFilters(ref("a.payload"), fl.get("record_id", 0))),
      s.conditional({ when: expr(ref("record_id"), ">", c.int(0)), then: [
        s.function.run({ fn: locate, as: "place", input: { type: withFilters(ref("a.payload"), fl.get("record_type", "")), id: ref("record_id") } }),
        s.function.run({ fn: approvalChanged, as: "told_screens", input: { id: inp("approval_id"), space_id: ref("place.space_id"), crm: ref("place.crm"), op: c.text("updated") } }),
      ] }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

export const decisionTrigger = tableTrigger({
  name: "agents/on_decision",
  description: "When an approval stops being pending: a decline and an expiry have no other hook.",
  table: approvals.approval,
  actions: { update: true },
  search: and(cmp(col("OLD.status"), "=", c.text("pending")), cmp(col("NEW.status"), "!=", c.text("pending"))),
  stack: (t) => [s.function.run({ fn: afterDecisionFn, as: "told", input: { approval_id: t.new("id") } })],
});

/** Past its date, a request can't be decided. The module only refuses it, so the row is closed here. */
export const expireApprovals = defineFunction({
  name: "agents/expire_approvals",
  description: "Close every pending approval past its expiry.",
  stack: [
    s.db.query({ table: approvals.approval, where: [cmp(col("status"), "=", c.text("pending")), expr(col("expires_at"), "<=", c.now())], output: ["id"], as: "lapsed" }),
    s.foreach({ list: ref("lapsed"), as: "row", body: [
      s.db.patch({ table: approvals.approval, fieldValue: ref("row.id"), data: obj({ status: c.text("expired") }) }),
      s.function.run({ fn: afterDecisionFn, as: "told", input: { approval_id: ref("row.id") } }),
    ] }),
  ],
  response: { expired: withFilters(ref("lapsed"), fl.count()) },
});

/**
 * A request belongs with the agent's sponsor, while that sponsor can read what it's about. A new sponsor takes it over. One who can't
 * reach the record hands it to the admins, unless it's in a DM, which no admin may read: that one closes.
 */
export const rerouteApprovals = defineFunction({
  name: "agents/reroute_approvals",
  description: "Move or close sponsor-route approvals whose sponsor changed or lost the record.",
  stack: [
    s.db.query({ table: approvals.approval, where: [cmp(col("status"), "=", c.text("pending")), cmp(col("approver_roles"), "=", c.text(""))], as: "waiting" }),
    s.set_var("moved", c.int(0)),
    s.foreach({ list: ref("waiting"), as: "a", body: [
      s.set_var("agent_id", withFilters(ref("a.payload"), fl.get("agent_id", 0))),
      s.set_var("record_type", withFilters(ref("a.payload"), fl.get("record_type", ""))),
      s.set_var("record_id", withFilters(ref("a.payload"), fl.get("record_id", 0))),
      s.db.get({ table: user, fieldValue: ref("agent_id"), output: ["kind", "sponsor_id"], as: "worker" }),
      // A person's own connection has no sponsor: they asked, and they decide.
      s.conditional({ when: expr(ref("worker.kind", { safe: true }), "=", c.text("agent")), then: [
        // In a DM the person who asked may be deciding instead, and the sponsor can't read what it's about.
        s.set_var("sponsor_id", withFilters(ref("a.payload"), fl.get("decider_id", 0), fl.first_notempty(ref("worker.sponsor_id", { safe: true })))),
        s.set_var("reaches", c.bool(true)),
        s.set_var("dm_id", c.int(0)),
        s.conditional({ when: expr(ref("record_id"), ">", c.int(0)), then: [
          s.function.run({ fn: canReach, as: "reachable", input: { actor_id: ref("sponsor_id"), browser: c.bool(true), type: ref("record_type"), id: ref("record_id") } }),
          s.update_var("reaches", ref("reachable")),
          s.function.run({ fn: locate, as: "place", input: { type: ref("record_type"), id: ref("record_id") } }),
          s.update_var("dm_id", ref("place.dm_id")),
        ] }),
        s.conditional({ when: expr(c.expression("$var.sponsor_id != $var.a.user_id || $var.reaches == false"), "=", c.bool(true)), then: [
          s.update_var("moved", withFilters(ref("moved"), fl.add(c.int(1)))),
          s.function.run({ fn: closeItems, as: "closed", input: { entity: c.text("approval"), entity_id: ref("a.id"), kind: c.text("approval"), user_id: ref("a.user_id"), seq: c.int(0) } }),
          s.conditional({
            when: expr(ref("reaches"), "=", c.bool(true)),
            then: [s.db.patch({ table: approvals.approval, fieldValue: ref("a.id"), data: obj({ user_id: ref("sponsor_id") }) })],
            else: [s.conditional({
              when: expr(ref("dm_id"), ">", c.int(0)),
              then: [s.db.patch({ table: approvals.approval, fieldValue: ref("a.id"), data: obj({ status: c.text("expired"), result: obj({ reason: c.text(NOBODY_CAN) }) }) })],
              else: [s.db.patch({ table: approvals.approval, fieldValue: ref("a.id"), data: obj({ user_id: ref("agent_id"), approver_roles: c.text(ADMIN_ROUTE) }) })],
            })],
          }),
          s.db.get({ table: approvals.approval, fieldValue: ref("a.id"), output: ["status", "user_id", "approver_roles"], as: "now" }),
          s.set_var("run_id", withFilters(ref("a.payload"), fl.get("run_id", 0))),
          s.conditional({
            when: expr(ref("now.status", { safe: true }), "=", c.text("pending")),
            then: [
              s.function.run({ fn: tellDeciders, as: "told", input: { approval_id: ref("a.id") } }),
              s.conditional({ when: expr(ref("run_id"), ">", c.int(0)), then: [
                s.set_var("decider_id", c.int(0)),
                s.conditional({ when: expr(ref("now.approver_roles", { safe: true }), "=", c.text("")), then: [s.update_var("decider_id", ref("sponsor_id"))] }),
                s.db.patch({ table: agent_run, fieldValue: ref("run_id"), data: obj({ waiting_on: ref("decider_id") }) }),
              ] }),
            ],
            else: [s.function.run({ fn: afterDecisionFn, as: "ended", input: { approval_id: ref("a.id") } })],
          }),
        ] }),
      ] }),
    ] }),
  ],
  response: { moved: ref("moved") },
});

/** A decision the trigger never told anyone about: a run can't sit waiting for an answer that's already in. */
export const resumeMissed = defineFunction({
  name: "agents/resume_missed",
  description: "Queue runs still waiting on an approval that's been decided.",
  stack: [
    s.db.query({ table: agent_run, where: [cmp(col("status"), "=", c.text("waiting")), expr(col("approval_id"), ">", c.int(0))], output: ["id", "approval_id"], as: "waiting" }),
    s.foreach({ list: ref("waiting"), as: "row", body: [
      s.db.get({ table: approvals.approval, fieldValue: ref("row.approval_id"), output: ["status"], as: "asked" }),
      s.conditional({ when: expr(ref("asked.status", { safe: true }), "!=", c.text("pending")), then: [s.function.run({ fn: "agents/resume", as: "resumed", input: { run_id: ref("row.id") } })] }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

/**
 * An agent answers to someone. One whose sponsor is gone, disabled or a guest stops here: its keys end, its runs fail with a plain
 * reason, what it asked for closes, and the admins hear once.
 */
export const suspendSponsorless = defineFunction({
  name: "agents/suspend_sponsorless",
  description: "Stop agents whose sponsor has gone, and tell the admins.",
  stack: [
    s.db.query({ table: user, where: [cmp(col("kind"), "=", c.text("agent")), cmp(col("status"), "=", c.text("active"))], output: ["id", "name", "sponsor_id"], as: "agents" }),
    s.set_var("stopped", c.int(0)),
    s.foreach({ list: ref("agents"), as: "worker", body: [
      s.db.get({ table: user, fieldValue: ref("worker.sponsor_id"), output: ["status", "role", "kind"], as: "sponsor" }),
      s.set_var("sponsor_status", ref("sponsor.status", { safe: true })),
      s.set_var("sponsor_role", ref("sponsor.role", { safe: true })),
      s.conditional({ when: expr(c.expression('$var.sponsor_status != "active" || ($var.sponsor_role != "admin" && $var.sponsor_role != "member")'), "=", c.bool(true)), then: [
        s.update_var("stopped", withFilters(ref("stopped"), fl.add(c.int(1)))),
        s.db.patch({ table: user, fieldValue: ref("worker.id"), data: obj({ status: c.text("disabled") }) }),
        s.db.query({ table: conn, where: [cmp(col("user_id"), "=", ref("worker.id")), cmp(col("revoked"), "!=", c.bool(true))], output: ["id"], as: "keys" }),
        s.foreach({ list: ref("keys"), as: "key", body: [s.function.run({ fn: agent.revokeFn, as: "revoked", input: { user_id: ref("worker.id"), id: ref("key.id") } })] }),
        s.db.query({ table: agent_run, where: [cmp(col("agent_id"), "=", ref("worker.id")), cmp(col("status"), "in", c.array(LIVE_RUNS))], output: ["id"], as: "runs" }),
        s.foreach({ list: ref("runs"), as: "run", body: [s.function.run({ fn: "agents/fail", as: "failed", input: { run_id: ref("run.id"), reason: c.text("sponsor_left"), detail: c.text(""), stopped_by: c.int(0) } })] }),
        s.db.query({ table: user, where: [cmp(col("role"), "=", c.text("admin")), cmp(col("kind"), "=", c.text("human")), cmp(col("status"), "=", c.text("active"))], output: ["id"], as: "admins" }),
        s.foreach({ list: ref("admins"), as: "admin", body: [
          s.function.run({ fn: deliver, as: "told", input: {
            user_id: ref("admin.id"), kind: c.text("agent_stopped"), title: withFilters(ref("worker.name"), fl.concat(c.text(" stopped: its sponsor has left"))), body: c.text("Its keys ended and its runs failed. Give it a new sponsor to bring it back."), link: c.text("/team"), actor_id: ref("worker.id"),
            space_id: c.int(0), dm_id: c.int(0), entity: c.text(""), entity_id: c.int(0), group_key: withFilters(c.text("agent-stopped-"), fl.concat(ref("worker.id"))), seq: c.int(0),
          } }),
        ] }),
      ] }),
    ] }),
  ],
  response: { stopped: ref("stopped") },
});

/** A key lasts 90 days at most, so its sponsor hears a week before: one line per key, however often the sweep runs. */
export const warnExpiringKeys = defineFunction({
  name: "agents/warn_expiring_keys",
  description: "Tell sponsors about keys that run out within a week.",
  stack: [
    s.set_var("soon", withFilters(c.now(), fl.add(c.int(KEY_WARNING_MS)))),
    s.db.query({ table: conn, where: [cmp(col("kind"), "=", c.text("key")), cmp(col("revoked"), "!=", c.bool(true)), cmp(col("name"), "!=", c.text(SYSTEM_CONNECTION)), expr(col("expires_at"), "<=", ref("soon")), expr(col("expires_at"), ">", c.now())], output: ["id", "name", "user_id"], as: "keys" }),
    s.foreach({ list: ref("keys"), as: "key", body: [
      s.db.get({ table: user, fieldValue: ref("key.user_id"), output: ["name", "kind", "sponsor_id"], as: "owner" }),
      s.conditional({ when: expr(ref("owner.kind", { safe: true }), "=", c.text("agent")), then: [
        s.function.run({ fn: deliver, as: "told", input: {
          user_id: ref("owner.sponsor_id", { safe: true }), kind: c.text("agent_key"), title: withFilters(ref("owner.name", { safe: true }), fl.concat(c.text("'s key runs out within a week"))), body: c.text("Rotate it from the Team page, or it stops working."), link: c.text("/team"), actor_id: ref("key.user_id"),
          space_id: c.int(0), dm_id: c.int(0), entity: c.text(""), entity_id: c.int(0), group_key: withFilters(c.text("key-expiring-"), fl.concat(ref("key.id"))), seq: ref("key.id"),
        } }),
      ] }),
    ] }),
  ],
  response: { warned: withFilters(ref("keys"), fl.count()) },
});

export const sweepHourly = scheduledTask({
  name: "agents/sweep_every_hour",
  description: "Expire approvals, move ones whose sponsor left, pick up missed runs, and stop agents with no sponsor.",
  schedule: [{ startsOn: "2026-01-01 00:00:00+0000", freq: HOUR_SECONDS }],
  stack: [
    s.function.run({ fn: expireApprovals, as: "expired" }),
    s.function.run({ fn: rerouteApprovals, as: "rerouted" }),
    s.function.run({ fn: resumeMissed, as: "resumed" }),
    s.function.run({ fn: suspendSponsorless, as: "stopped" }),
    s.function.run({ fn: warnExpiringKeys, as: "warned" }),
  ],
});

export const sweepFunctions = [afterDecisionFn, expireApprovals, rerouteApprovals, resumeMissed, suspendSponsorless, warnExpiringKeys];
