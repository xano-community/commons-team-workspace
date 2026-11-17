// Chat is where a task and a customer meet. A message naming both links them, and so does naming a customer in a task's own thread,
// so the task shows on the company page without anyone leaving the conversation. `links/create` still asks for reach on both ends:
// here a refusal just means no link, as a message must send whatever it names.
import { c, defineFunction, expr, fl, inp, input, ref, s, withFilters } from "@xano/sdk";
import { canReach } from "../access/reach.js";
import { createLink } from "../links/links.js";
import { conversation } from "../../table/messaging/conversation.js";

const CUSTOMERS = ["company", "contact", "deal"];

export const linkNamed = defineFunction({
  name: "crm/link_named",
  description: "Link the tasks and customers a message names to each other, for a sender who reaches both.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), conversation_id: input.int({ required: true }), records: input.json() },
  stack: [
    s.db.get({ table: conversation, fieldValue: inp("conversation_id"), output: ["record_type", "record_id"], as: "place" }),
    s.array.filter({ expr: inp("records"), if: expr(withFilters(c.array(CUSTOMERS), fl.in(ref("$this.type"))), "=", c.bool(true)), as: "customers" }),
    s.array.filter({ expr: inp("records"), if: expr(ref("$this.type"), "=", c.text("task")), as: "named_tasks" }),
    s.array.map({ source: ref("named_tasks"), as: "tasks", transform: ref("$this.id") }),
    s.conditional({ when: expr(ref("place.record_type", { safe: true }), "=", c.text("task")), then: [s.update_var("tasks", withFilters(ref("tasks"), fl.array_push(ref("place.record_id", { safe: true })), fl.unique()))] }),
    s.foreach({ list: ref("customers"), as: "customer", body: [
      s.function.run({ fn: canReach, as: "reaches_customer", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: ref("customer.type"), id: ref("customer.id") } }),
      s.conditional({ when: expr(ref("reaches_customer"), "=", c.bool(true)), then: [
        s.foreach({ list: ref("tasks"), as: "task_id", body: [
          s.function.run({ fn: canReach, as: "reaches_task", input: { actor_id: inp("actor_id"), browser: inp("browser"), type: c.text("task"), id: ref("task_id") } }),
          s.conditional({ when: expr(ref("reaches_task"), "=", c.bool(true)), then: [
            s.function.run({ fn: createLink, as: "linked", input: { actor_id: inp("actor_id"), browser: inp("browser"), from_type: c.text("task"), from_id: ref("task_id"), to_type: ref("customer.type"), to_id: ref("customer.id") } }),
          ] }),
        ] }),
      ] }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});
