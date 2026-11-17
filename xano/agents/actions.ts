// What runs when a person says yes. Each action re-checks the person and the agent, then does the same work the agent's own tool
// does, with the agent as author and the person as approver. A refusal here leaves the approval pending, because the module runs
// these inside its decision. Called by name, because the tools reach back to this file through approvals.ts.
import { c, defineFunction, fl, inp, input, ref, s, statements, withFilters, type Value } from "@xano/sdk";

const FROM_APPROVAL = {
  /** Who said yes. The module fills this in. */
  actor_id: input.int({ required: true }),
  /** Who does the work, set from the key that asked and never by a model. */
  agent_id: input.int({ required: true }),
  connection_id: input.int(), run_id: input.int(), record_type: input.text(), record_id: input.int(),
};
const asked = { actor_id: inp("agent_id"), run_id: inp("run_id"), connection_id: inp("connection_id"), approved_by: inp("actor_id") };

const before = statements(
  s.set_var("since", c.now()),
  s.function.run({ fn: "agents/approval_checks", as: "checked", input: { approver_id: inp("actor_id"), agent_id: inp("agent_id"), record_type: inp("record_type"), record_id: inp("record_id") } }),
);
const after = (result: Value) => statements(
  s.function.run({ fn: "agents/settle_approved", as: "settled", input: { approver_id: inp("actor_id"), agent_id: inp("agent_id"), run_id: inp("run_id"), since: ref("since") } }),
  s.set_var("result", result),
);

export const approvedPost = defineFunction({
  name: "approved/post",
  description: "Post a message an agent asked to post, once a person has said yes.",
  input: { ...FROM_APPROVAL, conversation_id: input.int({ required: true }), body: input.text() },
  stack: [
    ...before,
    s.function.run({ fn: "agents/post_message", as: "said", input: { ...asked, conversation_id: inp("conversation_id"), body: inp("body"), via: c.text("") } }),
    ...after(ref("said")),
  ],
  response: ref("result"),
});

export const approvedTask = defineFunction({
  name: "approved/task",
  description: "Save a task an agent asked to save, once a person has said yes.",
  input: {
    ...FROM_APPROVAL, id: input.int(), project_id: input.int(), title: input.text(), description: input.text(), status: input.text(), priority: input.text(), due_on: input.text(), assignee_id: input.int(),
  },
  stack: [
    ...before,
    s.function.run({ fn: "agents/save_task", as: "saved", input: {
      ...asked, id: inp("id"), project_id: inp("project_id"), title: inp("title"), description: inp("description"), status: inp("status"), priority: inp("priority"), due_on: inp("due_on"), assignee_id: inp("assignee_id"),
    } }),
    ...after(ref("saved")),
  ],
  response: ref("result"),
});

export const approvedDoc = defineFunction({
  name: "approved/doc",
  description: "Start or change a doc an agent asked to, once a person has said yes.",
  input: { ...FROM_APPROVAL, id: input.int(), space_id: input.int(), title: input.text(), find: input.text(), text: input.text(), note: input.text() },
  stack: [
    ...before,
    s.function.run({ fn: "agents/save_doc", as: "saved", input: { ...asked, id: inp("id"), space_id: inp("space_id"), title: inp("title"), find: inp("find"), text: inp("text"), note: inp("note") } }),
    ...after(ref("saved")),
  ],
  response: ref("result"),
});

export const approvedCustomer = defineFunction({
  name: "approved/customer",
  description: "Save a customer record an agent asked to link into a guest space, once a person has said yes.",
  input: {
    ...FROM_APPROVAL, type: input.text({ required: true }), id: input.int(), company_id: input.int(), name: input.text(), domain: input.text(), industry: input.text(), about: input.text(),
    email: input.text(), phone: input.text(), job_title: input.text(), stage: input.text(), value: input.int(), close_on: input.text(), owner_id: input.int(), note: input.text(), link_type: input.text(), link_id: input.int(),
  },
  stack: [
    ...before,
    s.function.run({ fn: "agents/save_crm_record", as: "saved", input: {
      ...asked, type: inp("type"), id: inp("id"), company_id: inp("company_id"), name: inp("name"), domain: inp("domain"), industry: inp("industry"), about: inp("about"), email: inp("email"), phone: inp("phone"), job_title: inp("job_title"),
      stage: inp("stage"), value: inp("value"), close_on: inp("close_on"), owner_id: inp("owner_id"), note: inp("note"), link_type: inp("link_type"), link_id: inp("link_id"),
    } }),
    ...after(ref("saved")),
  ],
  response: ref("result"),
});

export const approvedFile = defineFunction({
  name: "approved/file",
  description: "Save a file an agent asked to save, once a person has said yes.",
  input: { ...FROM_APPROVAL, name: input.text(), content: input.text(), space_id: input.int(), link_type: input.text(), link_id: input.int() },
  stack: [
    ...before,
    s.function.run({ fn: "agents/save_file", as: "saved", input: { ...asked, name: inp("name"), content: inp("content"), space_id: inp("space_id"), link_type: inp("link_type"), link_id: inp("link_id") } }),
    ...after(ref("saved")),
  ],
  response: ref("result"),
});

export const approvedDelete = defineFunction({
  name: "approved/delete",
  description: "Put a record an agent asked to delete in the trash, once a person has said yes.",
  input: { ...FROM_APPROVAL },
  stack: [
    ...before,
    s.function.run({ fn: "agents/delete_record", as: "gone", input: { actor_id: inp("agent_id"), type: inp("record_type"), id: inp("record_id") } }),
    ...after(ref("gone")),
  ],
  response: ref("result"),
});

export const approvedBulk = defineFunction({
  name: "approved/bulk",
  description: "Change many tasks at once for an agent, once a person has said yes.",
  input: { ...FROM_APPROVAL, ids: input.json(), status: input.text(), priority: input.text(), assignee_id: input.int() },
  stack: [
    ...before,
    s.function.run({ fn: "agents/bulk_change", as: "changed_tasks", input: { actor_id: inp("agent_id"), run_id: inp("run_id"), ids: inp("ids"), status: inp("status"), priority: inp("priority"), assignee_id: inp("assignee_id") } }),
    ...after(ref("changed_tasks")),
  ],
  response: ref("result"),
});

export const approvedExport = defineFunction({
  name: "approved/export",
  description: "Export customers to a file for an agent, once an admin has said yes.",
  input: { ...FROM_APPROVAL, space_id: input.int({ required: true }) },
  stack: [
    ...before,
    s.function.run({ fn: "agents/export_crm", as: "exported", input: { actor_id: inp("agent_id"), space_id: inp("space_id") } }),
    ...after(ref("exported")),
  ],
  response: ref("result"),
});

export const approvedJoin = defineFunction({
  name: "approved/join",
  description: "Add an agent to a space it asked to join, once an admin has said yes.",
  input: { ...FROM_APPROVAL, space_id: input.int({ required: true }) },
  stack: [
    s.set_var("since", c.now()),
    s.function.run({ fn: "agents/approval_checks", as: "checked", input: { approver_id: inp("actor_id"), agent_id: inp("agent_id"), record_type: c.text(""), record_id: c.int(0) } }),
    s.function.run({ fn: "spaces/add_member", as: "added", input: { actor_id: inp("actor_id"), browser: c.bool(true), space_id: inp("space_id"), user_id: inp("agent_id"), history_ok: c.bool(true) } }),
    ...after(ref("added")),
  ],
  response: ref("result"),
});

export const approvedDm = defineFunction({
  name: "approved/dm",
  description: "Send a direct message an agent asked to send, once a person has said yes.",
  input: { ...FROM_APPROVAL, member_id: input.int({ required: true }), body: input.text() },
  stack: [
    ...before,
    s.function.run({ fn: "conversations/open_dm", as: "opened", input: { actor_id: inp("agent_id"), browser: c.bool(false), user_ids: withFilters(c.array([]), fl.array_push(inp("member_id"))) } }),
    s.security.create_uuid({ as: "post_key" }),
    s.function.run({ fn: "messages/post", as: "posted", input: {
      actor_id: inp("agent_id"), browser: c.bool(false), conversation_id: ref("opened.id"), client_msg_id: ref("post_key"), body: inp("body"), run_id: inp("run_id"), run_note: c.bool(false), approved_by: inp("actor_id"), via: c.text(""), held: c.bool(false),
    } }),
    ...after(ref("posted.message.id")),
  ],
  response: ref("result"),
});

export const actionFunctions = [approvedDm, approvedPost, approvedTask, approvedDoc, approvedCustomer, approvedFile, approvedDelete, approvedBulk, approvedExport, approvedJoin];
