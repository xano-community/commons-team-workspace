// Workflow tests for search and the overview: every record type through its real route, who finds what, and the agent tool's
// bounds. Each makes its own rows. What ⌘K and the overview look like needs a browser, so frontend/scripts/search-check.mjs
// proves those against a deployed backend.
import { c, fl, obj, ref, s, withFilters, workflowTest, type Value } from "@xano/sdk";
import { agent } from "../agent.js";
import { agent_run } from "../table/agents/agent_run.js";
import { company } from "../table/crm/company.js";
import { deal } from "../table/crm/deal.js";
import { pipeline_stage } from "../table/crm/pipeline_stage.js";
import { findRecords } from "../function/search/search.js";
import { overviewRoute, searchRoute } from "../query/search.js";
import { createDocRoute } from "../query/docs.js";
import { createCompanyRoute, createContactRoute, deleteCompanyRoute, restoreCompanyRoute, updateCompanyRoute } from "../query/crm.js";
import { deleteMessageRoute, editMessageRoute, postMessageRoute } from "../query/messages.js";
import { removeSpaceMemberRoute } from "../query/spaces.js";
import { createProjectRoute, createTaskRoute, deleteTaskRoute, restoreTaskRoute, updateTaskRoute } from "../query/tasks.js";
import { storeFile } from "../function/files/files.js";
import { user } from "../table/user.js";
import { bearer, channel, dm, joined, makeSpace, missesText, person, personToken, seesText, settings } from "./access.js";

const call = (api: Parameters<typeof s.api.call>[0]["api"], token: string, as: string, input: Record<string, Value> = {}) => s.api.call({ api, headers: bearer(token), as, input });
const find = (token: string, q: string, as: string) => call(searchRoute, token, as, { q: c.text(q) });
const hits = (name: string, n: number) => [
  s.expect.to_equal({ expr: withFilters(ref(`${name}.items`), fl.count()), value: c.int(n) }),
  s.expect.to_equal({ expr: ref(`${name}.total`), value: c.int(n) }),
];

/** Ada is in A and B, Ben only in A, Cy only in B, the admin in neither, and Gus a guest in B. A has a project. */
const team = [
  settings(), person("ada"), person("ben"), person("cy"), person("root", "admin"), person("gus", "guest"),
  makeSpace("a"), makeSpace("b"), joined("a", "ada", "manager"), joined("b", "ada", "manager"), joined("a", "ben"), joined("b", "cy"), joined("b", "gus"),
  channel("in_a", "a"), channel("in_b", "b"), ...dm("chat", "ada", "ben"),
  personToken("ada", "ada_token"), personToken("ben", "ben_token"), personToken("cy", "cy_token"), personToken("root", "root_token"), personToken("gus", "gus_token"),
  call(createProjectRoute, "ada_token", "work_a", { space_id: ref("a.id"), name: c.text("Plan alpha") }),
  call(createProjectRoute, "ada_token", "work_b", { space_id: ref("b.id"), name: c.text("Plan beta") }),
];
const newTask = (token: string, project: string, title: string, as: string, description = "") =>
  call(createTaskRoute, token, as, { project_id: ref(`${project}.id`), client_id: c.text(`${as}-id`), title: c.text(title), description: c.text(description), status: c.text("todo"), priority: c.text("none") });
const say = (token: string, where: string, body: string, as: string) => call(postMessageRoute, token, as, { id: ref(`${where}.id`), client_msg_id: c.text(`${as}-id`), body: c.text(body) });
const paragraph = (text: string) => obj({ type: c.text("paragraph"), content: [obj({ type: c.text("text"), text: c.text(text) })] });
const doc = (space: string, title: string, words: string, as: string) => call(createDocRoute, "ada_token", as, { space_id: ref(`${space}.id`), title: c.text(title), body: obj({ type: c.text("doc"), content: [paragraph(words)] }) });

export const searchTests = [
  workflowTest({
    name: "search: all five tools write to it through the change path",
    stack: [
      ...team,
      newTask("ada_token", "work_a", "Zebra crossing task", "zebra_task", "needs a walrus sign-off"),
      say("ada_token", "in_a", "Zebra in the channel", "zebra_message"),
      // The docs module reads who's in a space from the copy on the user row, which only a real join keeps up.
      s.db.patch({ table: user, fieldValue: ref("ada.id"), data: obj({ space_ids: withFilters(c.array([]), fl.array_push(ref("a.id"))) }) }),
      doc("a", "Zebra brief", "the narwhal section", "zebra_doc"),
      call(createCompanyRoute, "ada_token", "zebra_company", { client_id: c.text("zc"), name: c.text("Zebra Cycles"), domain: c.text("zebra.example"), industry: c.text("Bikes"), about: c.text("") }),
      s.storage.create_file_resource({ as: "zebra_res", filename: c.text("zebra-notes.txt"), filedata: c.text("hello") }),
      s.function.run({ fn: storeFile, as: "zebra_file", input: { actor_id: ref("ada.id"), browser: c.bool(true), file: ref("zebra_res"), client_id: c.text("zf"), place_type: c.text("space"), place_id: ref("a.id"), run_id: c.int(0) } }),
      find("ada_token", "zebra", "all"),
      seesText("all", "Zebra crossing task"), seesText("all", "Zebra in the channel"), seesText("all", "Zebra brief"), seesText("all", "Zebra Cycles"), seesText("all", "zebra-notes.txt"),
      find("ada_token", "walrus", "in_body"), ...hits("in_body", 1), seesText("in_body", "Zebra crossing task"),
      find("ada_token", "zebra walrus", "two_words"), ...hits("two_words", 1),
      find("ada_token", "narwhal", "in_doc"), ...hits("in_doc", 1), seesText("in_doc", "Zebra brief"),
      find("ada_token", "z", "too_short"), ...hits("too_short", 0),
    ],
  }),
  workflowTest({
    name: "search: nobody finds what they can't reach, in results or the total",
    stack: [
      ...team,
      newTask("ada_token", "work_a", "Quokka in A", "in_a_task"),
      newTask("ada_token", "work_b", "Quokka in B", "in_b_task"),
      say("ada_token", "chat", "Quokka just between us", "secret"),
      call(createCompanyRoute, "ada_token", "customer", { client_id: c.text("qc"), name: c.text("Quokka Ltd"), domain: c.text(""), industry: c.text(""), about: c.text("") }),
      find("ben_token", "quokka", "ben"), seesText("ben", "Quokka in A"), missesText("ben", "Quokka in B"), seesText("ben", "between us"),
      find("cy_token", "quokka", "cy"), seesText("cy", "Quokka in B"), missesText("cy", "Quokka in A"), missesText("cy", "between us"),
      // The admin oversees every space and passes for none of its DMs.
      find("root_token", "quokka", "root"), seesText("root", "Quokka in A"), seesText("root", "Quokka in B"), missesText("root", "between us"), seesText("root", "Quokka Ltd"),
      find("gus_token", "quokka", "guest"), ...hits("guest", 1), missesText("guest", "Quokka Ltd"), missesText("guest", "Quokka in A"),
    ],
  }),
  workflowTest({
    name: "search: losing a space takes its records out at once",
    stack: [
      ...team,
      newTask("ada_token", "work_a", "Heron task", "task_a"),
      find("ben_token", "heron", "before"), ...hits("before", 1),
      call(removeSpaceMemberRoute, "ada_token", "removed", { id: ref("a.id"), user_id: ref("ben.id") }),
      find("ben_token", "heron", "after"), ...hits("after", 0),
    ],
  }),
  workflowTest({
    name: "search: a rename shows, a delete leaves, and a restore comes back",
    stack: [
      ...team,
      newTask("ada_token", "work_a", "Badger", "task_a"),
      call(updateTaskRoute, "ada_token", "renamed", { id: ref("task_a.id"), title: c.text("Otter"), description: c.text("") }),
      find("ada_token", "badger", "old_name"), ...hits("old_name", 0),
      find("ada_token", "otter", "new_name"), ...hits("new_name", 1),
      call(deleteTaskRoute, "ada_token", "trashed", { id: ref("task_a.id") }),
      find("ada_token", "otter", "gone"), ...hits("gone", 0),
      call(restoreTaskRoute, "ada_token", "back", { id: ref("task_a.id") }),
      find("ada_token", "otter", "again"), ...hits("again", 1),
    ],
  }),
  workflowTest({
    name: "search: an edit replaces a message's words, and a delete takes them",
    stack: [
      ...team,
      say("ada_token", "in_a", "Puffin sighting", "said"),
      call(editMessageRoute, "ada_token", "edited", { id: ref("said.message.id"), body: c.text("Gannet sighting") }),
      find("ada_token", "puffin", "old_words"), ...hits("old_words", 0),
      find("ada_token", "gannet", "new_words"), ...hits("new_words", 1),
      s.expect.to_equal({ expr: ref("new_words.items.0.place"), value: c.text("Channel in_a") }),
      call(deleteMessageRoute, "ada_token", "deleted", { id: ref("said.message.id") }),
      find("ada_token", "gannet", "gone"), ...hits("gone", 0),
    ],
  }),
  workflowTest({
    name: "search: a deleted company takes its people with it, and a restore brings them back",
    stack: [
      ...team,
      call(createCompanyRoute, "ada_token", "firm", { client_id: c.text("f1"), name: c.text("Lynx Works"), domain: c.text(""), industry: c.text(""), about: c.text("") }),
      call(createContactRoute, "ada_token", "person_there", { client_id: c.text("p1"), company_id: ref("firm.id"), name: c.text("Lynx Person"), email: c.text(""), phone: c.text(""), job_title: c.text("") }),
      find("ada_token", "lynx", "both"), ...hits("both", 2),
      call(updateCompanyRoute, "ada_token", "firm2", { id: ref("firm.id"), name: c.text("Lynx Holdings"), domain: c.text(""), industry: c.text(""), about: c.text("") }),
      find("ada_token", "holdings", "renamed"), ...hits("renamed", 1),
      call(deleteCompanyRoute, "ada_token", "gone", { id: ref("firm.id") }),
      find("ada_token", "lynx", "none"), ...hits("none", 0),
      call(restoreCompanyRoute, "ada_token", "back", { id: ref("firm.id") }),
      find("ada_token", "lynx", "again"), ...hits("again", 2),
    ],
  }),
  workflowTest({
    name: "overview: its numbers cover what the person reaches, and first steps read from real rows",
    stack: [
      ...team,
      call(createTaskRoute, "ada_token", "mine_a", { project_id: ref("work_a.id"), client_id: c.text("ma"), title: c.text("For Ben"), status: c.text("todo"), priority: c.text("none"), assignee_id: ref("ben.id"), due_on: c.text("2001-01-01") }),
      call(createTaskRoute, "ada_token", "mine_b", { project_id: ref("work_a.id"), client_id: c.text("mb"), title: c.text("Also for Ben"), status: c.text("done"), priority: c.text("none"), assignee_id: ref("ben.id") }),
      call(createTaskRoute, "ada_token", "not_bens", { project_id: ref("work_b.id"), client_id: c.text("nb"), title: c.text("Done where Ben isn't"), status: c.text("done"), priority: c.text("none") }),
      s.db.add({ table: pipeline_stage, as: "open_stage", row: { name: c.text("Proposal"), kind: c.text("open"), rank: c.int(1), is_demo: c.bool(false) } }),
      s.db.add({ table: company, as: "buyer", row: { name: c.text("Ibis Ltd"), created_by: ref("ada.id"), is_demo: c.bool(false) } }),
      s.db.add({ table: deal, as: "closing", row: { company_id: ref("buyer.id"), title: c.text("Ibis site"), stage_id: ref("open_stage.id"), value: c.int(1200), close_on: withFilters(c.now(), fl.epochms_date("Y-m-d", "UTC")), created_by: ref("ada.id"), is_demo: c.bool(false) } }),
      call(overviewRoute, "ben_token", "ben_view"),
      s.expect.to_equal({ expr: ref("ben_view.tasks.open"), value: c.int(1) }),
      // The week's trend counts finished work in his spaces only, and a member who may open customers gets the pipeline.
      s.expect.to_equal({ expr: withFilters(ref("ben_view.trends.done_at"), fl.count()), value: c.int(1) }),
      s.expect.to_equal({ expr: withFilters(ref("ben_view.deals"), fl.count()), value: c.int(1) }),
      s.expect.to_equal({ expr: ref("ben_view.deals.0.value"), value: c.int(1200) }),
      call(overviewRoute, "gus_token", "guest_view"),
      s.expect.to_be_null({ expr: ref("guest_view.deals") }),
      s.expect.to_equal({ expr: ref("ben_view.tasks.late"), value: c.int(1) }),
      s.expect.to_equal({ expr: ref("ben_view.tasks.items.0.title"), value: c.text("For Ben") }),
      // Late is late on Ben's calendar: on the day it's due it isn't yet, and a day that isn't a date falls back to the server's.
      call(overviewRoute, "ben_token", "on_the_day", { today: c.text("2001-01-01") }),
      s.expect.to_equal({ expr: ref("on_the_day.tasks.late"), value: c.int(0) }),
      call(overviewRoute, "ben_token", "the_day_after", { today: c.text("2001-01-02") }),
      s.expect.to_equal({ expr: ref("the_day_after.tasks.late"), value: c.int(1) }),
      call(overviewRoute, "ben_token", "not_a_day", { today: c.text("2001-01-01' or 1=1") }),
      s.expect.to_equal({ expr: ref("not_a_day.tasks.late"), value: c.int(1) }),
      s.expect.to_equal({ expr: ref("ben_view.started.message"), value: c.int(0) }),
      say("ben_token", "in_a", "hello", "said"),
      call(overviewRoute, "ben_token", "after_saying"),
      s.expect.to_equal({ expr: ref("after_saying.started.message"), value: c.int(1) }),
      call(removeSpaceMemberRoute, "ada_token", "removed", { id: ref("a.id"), user_id: ref("ben.id") }),
      call(overviewRoute, "ben_token", "after_leaving"),
      s.expect.to_equal({ expr: ref("after_leaving.tasks.open"), value: c.int(0) }),
      s.expect.to_equal({ expr: ref("after_leaving.spaces"), value: c.int(0) }),
      s.expect.to_equal({ expr: withFilters(ref("after_leaving.trends.done_at"), fl.count()), value: c.int(0) }),
    ],
  }),
  workflowTest({
    name: "search: an agent finds only what it may, and a run only where it was asked",
    stack: [
      ...team,
      s.db.add({ table: user, as: "scout", row: { name: c.text("Agent scout"), email: c.null(), password: c.null(), role: c.text("agent"), kind: c.text("agent"), agent_mode: c.text("hosted"), brief: c.text("Help."), sponsor_id: ref("ada.id"), status: c.text("active") } }),
      joined("a", "scout"), joined("b", "scout"),
      newTask("ada_token", "work_a", "Ibis in A", "in_a_task"),
      newTask("ada_token", "work_b", "Ibis in B", "in_b_task"),
      say("ada_token", "chat", "Ibis in the DM", "private_words"),
      call(createCompanyRoute, "ada_token", "customer", { client_id: c.text("ic"), name: c.text("Ibis Ltd"), domain: c.text(""), industry: c.text(""), about: c.text("") }),
      // No run: everything the agent joined, and never a person's DM or customers, which its role doesn't open.
      s.function.call({ fn: findRecords, as: "free", input: { actor_id: ref("scout.id"), browser: c.bool(false), run_id: c.int(0), q: c.text("ibis") } }),
      seesText("free", "Ibis in A"), seesText("free", "Ibis in B"), missesText("free", "Ibis in the DM"),
      // In a run: its own space, however much else the agent has joined.
      s.db.add({ table: agent_run, as: "run", row: { agent_id: ref("scout.id"), requested_by: ref("ben.id"), status: c.text("working"), space_id: ref("a.id"), dm_id: c.int(0), attempt: c.int(1), source_type: c.text("message"), source_id: c.int(1), conversation_id: ref("in_a.id") } }),
      s.function.call({ fn: findRecords, as: "bounded", input: { actor_id: ref("scout.id"), browser: c.bool(false), run_id: ref("run.id"), q: c.text("ibis") } }),
      seesText("bounded", "Ibis in A"), missesText("bounded", "Ibis in B"), missesText("bounded", "Ibis in the DM"),
      // A person's own key reaches their joined spaces, even when they're an admin.
      s.function.call({ fn: agent.connectFn, input: { user_id: ref("root.id"), name: c.text("Laptop"), scope: c.text("read"), days: c.int(1) }, as: "key" }),
      s.function.call({ fn: findRecords, as: "own_key", input: { actor_id: ref("root.id"), browser: c.bool(false), run_id: c.int(0), q: c.text("ibis") } }),
      missesText("own_key", "Ibis in A"), missesText("own_key", "Ibis in B"), seesText("own_key", "Ibis Ltd"),
    ],
  }),
];
