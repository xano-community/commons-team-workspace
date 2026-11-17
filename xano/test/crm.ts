// Workflow tests for the CRM: every write through its route, who reaches what, what a company page shows each viewer, and how
// agents and connections meet the same rules. Each makes its own rows. Two real windows, a drag and the phone need a browser,
// so frontend/scripts/crm-check.mjs proves those against a deployed backend.
import { c, cmp, col, expr, fl, obj, ref, s, withFilters, workflowTest, type Value } from "@xano/sdk";
import { agent } from "../agent.js";
import { listNotifications } from "../base/queries.js";
import { notification, workspace_setting } from "../base/tables.js";
import { readRecord, requireInScope, saveCrmRecord } from "../agents/tools.js";
import { beginRun, finishRun, runContext } from "../agents/runner.js";
import { removeMember } from "../function/members/offboard.js";
import { canReach } from "../function/access/reach.js";
import { purgeCrm } from "../function/crm/purge.js";
import { listChanges } from "../query/changes.js";
import {
  addNoteRoute, assignDealRoute, companyPanelsRoute, createCompanyRoute, createContactRoute, createDealRoute, createStageRoute, crmMentionCheck, crmReadRoute, crmSearchRoute, crmSetupRoute, deleteCompanyRoute, deleteContactRoute,
  deleteDealRoute, deleteNoteRoute, deleteStageRoute, editNoteRoute, getCompanyRoute, getDealRoute, listCompaniesRoute, listContactsRoute, moveDealRoute, moveStageRoute, pipelineRoute, renameStageRoute, restoreCompanyRoute,
  setDealStageRoute, updateCompanyRoute, updateContactRoute, updateDealRoute,
} from "../query/crm.js";
import { addLink, getLinks, resolveLinks } from "../query/links.js";
import { openThreadRoute, postMessageRoute } from "../query/messages.js";
import { createProjectRoute, createTaskRoute } from "../query/tasks.js";
import { agent_run } from "../table/agents/agent_run.js";
import { company } from "../table/crm/company.js";
import { contact } from "../table/crm/contact.js";
import { crm_note } from "../table/crm/crm_note.js";
import { deal } from "../table/crm/deal.js";
import { pipeline_stage } from "../table/crm/pipeline_stage.js";
import { message } from "../table/messaging/message.js";
import { record_link } from "../table/links/record_link.js";
import { task } from "../table/tasks/task.js";
import { user } from "../table/user.js";
import { bearer, channel, dm, joined, makeSpace, missesText, no, notFound, person, personToken, rowsTest, seesText, settings, yes } from "./access.js";

const call = (api: Parameters<typeof s.api.call>[0]["api"], token: string, as: string, input: Record<string, Value> = {}) => s.api.call({ api, headers: bearer(token), as, input });
const equal = (name: string, value: Value) => s.expect.to_equal({ expr: ref(name), value });
const is = (name: string, n: number) => equal(name, c.int(n));
const text = (name: string, value: string) => equal(name, c.text(value));
const count = (name: string, n: number) => s.expect.to_equal({ expr: withFilters(ref(name), fl.count()), value: c.int(n) });
const says = (name: string, value: string) => equal(`${name}.message`, c.text(value));
const rows = (table: Parameters<typeof s.db.query>[0]["table"], as: string) => s.db.query({ table, returnType: "count", as });

const stage = (key: string, name: string, rank: number, kind = "open") => s.db.add({ table: pipeline_stage, as: key, row: { name: c.text(name), kind: c.text(kind), rank: c.int(rank), is_demo: c.bool(false) } });
const newCompany = (token: string, name: string, as: string, more: Record<string, Value> = {}) => call(createCompanyRoute, token, as, { client_id: c.text(`${as}-id`), name: c.text(name), ...more });
const newContact = (token: string, companyKey: string, name: string, as: string) => call(createContactRoute, token, as, { client_id: c.text(`${as}-id`), company_id: ref(`${companyKey}.id`), name: c.text(name) });
const newDeal = (token: string, companyKey: string, stageKey: string, title: string, as: string, more: Record<string, Value> = {}) =>
  call(createDealRoute, token, as, { client_id: c.text(`${as}-id`), company_id: ref(`${companyKey}.id`), stage_id: ref(`${stageKey}.id`), title: c.text(title), ...more });
const move = (token: string, key: string, stageKey: string, as: string, before?: string) => call(moveDealRoute, token, as, { id: ref(`${key}.id`), stage_id: ref(`${stageKey}.id`), before_id: before ? ref(`${before}.id`) : c.int(0) });
const noteOn = (token: string, type: string, key: string, body: Value, as: string) => call(addNoteRoute, token, as, { client_id: c.text(`${as}-id`), record_type: c.text(type), record_id: ref(`${key}.id`), body });
const pageOf = (token: string, key: string, as: string) => call(getCompanyRoute, token, as, { id: ref(`${key}.id`) });
const pipeline = (token: string, as: string, input: Record<string, Value> = {}) => call(pipelineRoute, token, as, input);
const chipsFor = (token: string, as: string, type: string, key: string) => call(resolveLinks, token, as, { items: withFilters(c.array([]), fl.array_push(obj({ type: c.text(type), id: ref(`${key}.id`) }))) });
const mentioning = (who: string, words: string) => withFilters(c.text("<@"), fl.concat(ref(`${who}.id`)), fl.concat(c.text(`> ${words}`)));
const named = (type: string, key: string) => withFilters(c.text(`<#${type}:`), fl.concat(ref(`${key}.id`)), fl.concat(c.text(">")));
/** The deal titles of one stage on the board, in order, as one string. */
const orderOf = (name: string, stageKey: string, as: string) => [
  s.array.filter({ expr: ref(`${name}.items`), if: expr(ref("$this.stage_id"), "=", ref(`${stageKey}.id`)), as: `${as}_rows` }),
  s.array.map({ source: ref(`${as}_rows`), as: `${as}_titles`, transform: ref("$this.title") }),
  s.set_var(as, withFilters(ref(`${as}_titles`), fl.join(","))),
];

/** Ada and Ben hold crm.read, Gus is a guest in space A, and A has a channel and a project. Ann runs the workspace. */
const team = [
  settings(), person("ann", "admin"), person("ada"), person("ben"), person("gus", "guest"), makeSpace("a"), joined("a", "ada", "manager"), joined("a", "gus"), channel("chat", "a"),
  personToken("ann", "ann_token"), personToken("ada", "ada_token"), personToken("ben", "ben_token"), personToken("gus", "gus_token"),
  stage("lead", "Lead", 1), stage("proposal", "Proposal", 2), stage("won", "Won", 3, "won"), stage("lost", "Lost", 4, "lost"),
  call(createProjectRoute, "ada_token", "launch", { space_id: ref("a.id"), name: c.text("Launch") }),
];
const newTask = (token: string, title: string, as: string) => call(createTaskRoute, token, as, { project_id: ref("launch.id"), client_id: c.text(`${as}-id`), title: c.text(title), status: c.text("todo"), priority: c.text("none") });

const scoutRow = (key: string, sponsor: string) => s.db.add({ table: user, as: key, row: {
  name: c.text(`Agent ${key}`), email: c.null(), password: c.null(), role: c.text("agent"), kind: c.text("agent"), agent_mode: c.text("hosted"), brief: c.text("Keep the pipeline honest."), sponsor_id: ref(`${sponsor}.id`), status: c.text("active"), is_demo: c.bool(false),
} });
const lineOf = (who: string, as: string) => s.db.add({ table: agent.agent_connection, as, row: { user_id: ref(`${who}.id`), name: c.text("system:hosted"), kind: c.text("key"), scope: c.text("read_write"), revoked: c.bool(false), expires_at: withFilters(c.now(), fl.add(c.int(600_000))) } });
/** A run on hand, without a mention: where it started and who asked is all the scope rule reads. */
const runIn = (as: string, requester: string, place: { space?: Value; dm?: Value }) => s.db.add({ table: agent_run, as, row: {
  agent_id: ref("scout.id"), requested_by: ref(`${requester}.id`), source_type: c.text("task"), source_id: c.int(0), space_id: place.space ?? c.int(0), dm_id: place.dm ?? c.int(0), status: c.text("working"), attempt: c.int(1), is_demo: c.bool(false), connection_id: ref("line.id"), started_at: c.now(),
} });
const paused = s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ agents_paused: c.bool(true) }) });
const save = (run: Value, as: string, input: Record<string, Value>) => s.function.call({ fn: saveCrmRecord, as, input: { actor_id: ref("scout.id"), run_id: run, approved_by: c.int(1), ...input } });
const scoped = (run: Value, type: string, id: Value, as: string) => s.function.call({ fn: requireInScope, as, input: { actor_id: ref("scout.id"), run_id: run, type: c.text(type), id } });
/** Finds a row for a refusal, because `to_throw` runs in a stack of its own. */
const firstOf = (table: Parameters<typeof s.db.query>[0]["table"], as: string) => s.db.query({ table, sort: [{ sortBy: "id", dir: "asc" }], paging: { per_page: 1, metadata: false }, as: `${as}_rows` });
const lookUp = (...steps: [Parameters<typeof s.db.query>[0]["table"], string][]) => steps.flatMap(([table, as]) => [firstOf(table, as), s.set_var(as, withFilters(ref(`${as}_rows`), fl.first()))]);
const scoutNow = s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Agent scout")), returnType: "single", as: "scout" });
const runNow = (as: string) => [s.db.query({ table: agent_run, sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: 1, metadata: false }, as: `${as}_rows` }), s.set_var(as, withFilters(ref(`${as}_rows`), fl.first()))];

export const crmTests = [
  workflowTest({
    name: "crm: a person adds a company, a contact and a deal, and a retry with the same client id makes no second one",
    stack: [
      ...team,
      newCompany("ada_token", "Marlow Cycles", "marlow", { domain: c.text("marlow.example"), industry: c.text("Bikes") }),
      newCompany("ada_token", "Marlow Cycles", "again", { client_id: c.text("marlow-id") }), equal("again.id", ref("marlow.id")),
      text("marlow.name", "Marlow Cycles"), equal("marlow.created_by", ref("ada.id")),
      newContact("ada_token", "marlow", "Riley Park", "riley"), text("riley.company_name", "Marlow Cycles"),
      newDeal("ada_token", "marlow", "lead", "Care plan", "care", { value: c.int(12000), close_on: c.text("2031-02-03") }),
      text("care.company_name", "Marlow Cycles"), is("care.value", 12000), equal("care.stage_id", ref("lead.id")), text("care.close_on", "2031-02-03"),
      rows(company, "companies"), is("companies", 1), rows(contact, "contacts"), is("contacts", 1), rows(deal, "deals"), is("deals", 1),
      pipeline("ben_token", "board"), count("board.items", 1), text("board.items.0.company_name", "Marlow Cycles"), is("board.ever", 1), is("board.open", 1),
      call(listCompaniesRoute, "ben_token", "list"), count("list.items", 1), is("list.items.0.open_deals", 1), is("list.items.0.open_value", 12000), is("list.items.0.contacts", 1), is("list.ever", 1),
      call(listContactsRoute, "ben_token", "people"), count("people.items", 1), text("people.items.0.company_name", "Marlow Cycles"),
    ],
  }),
  workflowTest({
    name: "crm: bad input says how to fix it, and nothing is made",
    stack: [
      ...team,
      newCompany("ada_token", "   ", "blank"), says("blank", "Name the company."),
      newCompany("ada_token", "x".repeat(121), "long"), says("long", "Keep the name under 120 characters."),
      newCompany("ada_token", "Marlow", "marlow"),
      newContact("ada_token", "marlow", "  ", "nameless"), says("nameless", "Name the contact."),
      call(createContactRoute, "ada_token", "bad_mail", { client_id: c.text("m"), company_id: ref("marlow.id"), name: c.text("Riley"), email: c.text("not an address") }), says("bad_mail", "Check the email address."),
      newDeal("ada_token", "marlow", "lead", " ", "untitled"), says("untitled", "Give the deal a title."),
      newDeal("ada_token", "marlow", "lead", "Big", "negative", { value: c.int(-1) }), says("negative", "A deal's value can't be below zero."),
      newDeal("ada_token", "marlow", "lead", "Big", "bad_day", { close_on: c.text("2031-02-31") }), says("bad_day", "Choose a real date."),
      rows(company, "companies"), is("companies", 1), rows(contact, "contacts"), is("contacts", 0), rows(deal, "deals"), is("deals", 0),
    ],
  }),
  workflowTest({
    name: "crm: someone without crm.read reaches nothing, sees a locked chip for a company, and it answers the same as nothing there",
    stack: [
      ...team,
      newCompany("ada_token", "Secret Co", "secret"), newContact("ada_token", "secret", "Hidden Person", "hidden"), newDeal("ada_token", "secret", "lead", "Secret deal", "plan"),
      pageOf("gus_token", "secret", "read"), notFound("read"), missesText("read", "Secret Co"),
      call(getDealRoute, "gus_token", "deal_read", { id: ref("plan.id") }), notFound("deal_read"),
      pipeline("gus_token", "board"), notFound("board"), call(listCompaniesRoute, "gus_token", "list"), notFound("list"), call(listContactsRoute, "gus_token", "people"), notFound("people"), call(crmSetupRoute, "gus_token", "setup"), notFound("setup"),
      call(crmSearchRoute, "gus_token", "found", { q: c.text("Secret") }), count("found", 0),
      newCompany("gus_token", "Sneaking in", "made"), notFound("made"),
      move("gus_token", "plan", "won", "moved"), notFound("moved"),
      noteOn("gus_token", "deal", "plan", c.text("Hello"), "noted"), notFound("noted"),
      call(deleteCompanyRoute, "gus_token", "gone", { id: ref("secret.id") }), notFound("gone"),
      call(openThreadRoute, "gus_token", "thread", { record_type: c.text("company"), record_id: ref("secret.id") }), notFound("thread"),
      call(listChanges, "gus_token", "log", { channel: c.text("crm") }), notFound("log"),
      chipsFor("gus_token", "chip", "company", "secret"), text("chip.0.state", "locked"), text("chip.0.title", ""), text("chip.0.href", ""), missesText("chip", "Secret Co"),
      chipsFor("gus_token", "deal_chip", "deal", "plan"), text("deal_chip.0.state", "locked"), missesText("deal_chip", "Secret deal"),
      chipsFor("gus_token", "person_chip", "contact", "hidden"), text("person_chip.0.state", "locked"), missesText("person_chip", "Hidden Person"),
      chipsFor("ben_token", "ben_chip", "company", "secret"), text("ben_chip.0.state", "live"), text("ben_chip.0.title", "Secret Co"),
      s.function.call({ fn: canReach, as: "gus_reaches", input: { actor_id: ref("gus.id"), browser: c.bool(true), type: c.text("company"), id: ref("secret.id") } }), no("gus_reaches"),
      s.function.call({ fn: canReach, as: "missing", input: { actor_id: ref("ben.id"), browser: c.bool(true), type: c.text("company"), id: c.int(999999) } }), no("missing"),
    ],
  }),
  rowsTest({
    name: "crm: a person's own connection reaches CRM records when that person holds crm.read, and nobody else's does",
    stack: [
      ...team,
      newCompany("ada_token", "Marlow", "marlow"), newDeal("ada_token", "marlow", "lead", "Care plan", "care"),
      s.function.call({ fn: canReach, as: "member_key", input: { actor_id: ref("ben.id"), browser: c.bool(false), type: c.text("company"), id: ref("marlow.id") } }), yes("member_key"),
      s.function.call({ fn: canReach, as: "admin_key", input: { actor_id: ref("ann.id"), browser: c.bool(false), type: c.text("deal"), id: ref("care.id") } }), yes("admin_key"),
      s.function.call({ fn: canReach, as: "guest_key", input: { actor_id: ref("gus.id"), browser: c.bool(false), type: c.text("deal"), id: ref("care.id") } }), no("guest_key"),
      s.function.call({ fn: saveCrmRecord, as: "by_key", input: { actor_id: ref("ben.id"), run_id: c.int(0), type: c.text("deal"), id: ref("care.id"), stage: c.text("Proposal") } }),
      s.db.get({ table: deal, fieldValue: ref("care.id"), as: "now" }), equal("now.stage_id", ref("proposal.id")),
      s.expect.to_throw({ exception: c.text("Not found"), body: [
        s.db.query({ table: user, where: cmp(col("name"), "=", c.text("Test gus")), returnType: "single", as: "guest" }), ...lookUp([deal, "row"]),
        s.function.call({ fn: saveCrmRecord, as: "by_guest", input: { actor_id: ref("guest.id"), run_id: c.int(0), type: c.text("deal"), id: ref("row.id"), stage: c.text("Won") } }),
      ] }),
    ],
  }),
  workflowTest({
    name: "crm: two viewers see different panels on one company, and each count is what that viewer can see",
    stack: [
      ...team, makeSpace("b"), joined("b", "ben"), channel("private", "b"),
      call(createProjectRoute, "ben_token", "side", { space_id: ref("b.id"), name: c.text("Side") }),
      newCompany("ada_token", "Marlow", "marlow"), newDeal("ada_token", "marlow", "lead", "Care plan", "care"),
      newTask("ada_token", "Shared checkout test", "mine"),
      call(createTaskRoute, "ben_token", "theirs", { project_id: ref("side.id"), client_id: c.text("t2"), title: c.text("Private pricing"), status: c.text("todo"), priority: c.text("none") }),
      call(addLink, "ada_token", "l1", { from_type: c.text("task"), from_id: ref("mine.id"), to_type: c.text("company"), to_id: ref("marlow.id") }),
      call(addLink, "ben_token", "l2", { from_type: c.text("task"), from_id: ref("theirs.id"), to_type: c.text("deal"), to_id: ref("care.id") }),
      call(addLink, "ben_token", "l3", { from_type: c.text("company"), from_id: ref("marlow.id"), to_type: c.text("conversation"), to_id: ref("private.id") }),
      pageOf("ada_token", "marlow", "as_ada"), is("as_ada.panels.tasks.total", 1), count("as_ada.panels.tasks.items", 1), text("as_ada.panels.tasks.items.0.title", "Shared checkout test"), is("as_ada.panels.chat.total", 0),
      missesText("as_ada", "Private pricing"), missesText("as_ada", "Channel private"),
      pageOf("ben_token", "marlow", "as_ben"), is("as_ben.panels.tasks.total", 1), text("as_ben.panels.tasks.items.0.title", "Private pricing"), is("as_ben.panels.chat.total", 1), missesText("as_ben", "Shared checkout test"),
      pageOf("ann_token", "marlow", "as_ann"), is("as_ann.panels.tasks.total", 2), is("as_ann.panels.chat.total", 1),
      call(companyPanelsRoute, "ada_token", "more", { id: ref("marlow.id"), limit: c.int(50) }), is("more.tasks.total", 1), missesText("more", "Private pricing"),
      call(getLinks, "ada_token", "links", { type: c.text("deal"), id: ref("care.id") }), is("links.backlinks_total", 0), missesText("links", "Private pricing"),
      is("as_ada.panels.docs.total", 0), is("as_ada.panels.files.total", 0),
    ],
  }),
  workflowTest({
    name: "crm: a trashed record drops off a panel and its count",
    stack: [
      ...team, newCompany("ada_token", "Marlow", "marlow"), newTask("ada_token", "Old task", "old"),
      call(addLink, "ada_token", "l1", { from_type: c.text("task"), from_id: ref("old.id"), to_type: c.text("company"), to_id: ref("marlow.id") }),
      s.db.patch({ table: task, fieldValue: ref("old.id"), data: obj({ deleted_at: c.now() }) }),
      pageOf("ada_token", "marlow", "page"), is("page.panels.tasks.total", 0), count("page.panels.tasks.items", 0),
    ],
  }),
  workflowTest({
    name: "crm: moving a deal keeps its place for everyone, stamps a close, and tells the crm channel with ids only",
    stack: [
      ...team, newCompany("ada_token", "Marlow", "marlow"),
      newDeal("ada_token", "marlow", "lead", "First", "first"), newDeal("ada_token", "marlow", "lead", "Second", "second"), newDeal("ada_token", "marlow", "lead", "Third", "third"),
      pipeline("ben_token", "start"), ...orderOf("start", "lead", "was"), text("was", "Third,Second,First"),
      move("ada_token", "first", "lead", "up", "third"), pipeline("ben_token", "after"), ...orderOf("after", "lead", "now"), text("now", "First,Third,Second"),
      call(listChanges, "ben_token", "head", { channel: c.text("crm"), after: c.int(-1) }),
      move("ada_token", "second", "proposal", "across"), equal("across.stage_id", ref("proposal.id")), s.expect.to_be_null({ expr: ref("across.closed_at") }),
      call(listChanges, "ben_token", "seen", { channel: c.text("crm"), after: ref("head.seq") }), count("seen.items", 1), text("seen.items.0.entity", "deal"), text("seen.items.0.op", "moved"), equal("seen.items.0.entity_id", ref("second.id")),
      missesText("seen", "Second"),
      call(setDealStageRoute, "ada_token", "closed", { id: ref("second.id"), stage_id: ref("won.id") }), s.expect.to_be_defined({ expr: ref("closed.closed_at") }), s.expect.to_be_true({ expr: withFilters(ref("closed.closed_at"), fl.is_int()) }),
      pipeline("ben_token", "won_board"), is("won_board.open", 2), is("won_board.ever", 3),
      call(setDealStageRoute, "ada_token", "reopened", { id: ref("second.id"), stage_id: ref("lead.id") }), s.expect.to_be_null({ expr: ref("reopened.closed_at") }),
      move("ada_token", "first", "won", "same_again"), move("ada_token", "first", "lead", "back"), s.expect.to_be_null({ expr: ref("back.closed_at") }),
    ],
  }),
  workflowTest({
    name: "crm: the board's filters narrow its deals, and each stage counts and sums what's left",
    stack: [
      ...team, newCompany("ada_token", "Marlow Cycles", "marlow"), newCompany("ada_token", "Fenwick", "fenwick"),
      newDeal("ada_token", "marlow", "lead", "Care plan", "care", { value: c.int(1000), owner_id: ref("ben.id") }), newDeal("ada_token", "marlow", "lead", "Spring refresh", "spring", { value: c.int(500) }), newDeal("ada_token", "fenwick", "proposal", "Outdoor site", "outdoor", { value: c.int(9000) }),
      pipeline("ada_token", "all"), is("all.stages.0.deals", 2), is("all.stages.0.value", 1500), is("all.stages.1.deals", 1), is("all.stages.1.value", 9000), is("all.stages.2.deals", 0), is("all.stages.2.value", 0),
      pipeline("ada_token", "by_name", { q: c.text("Marlow") }), count("by_name.items", 2), pipeline("ada_token", "by_title", { q: c.text("Outdoor") }), count("by_title.items", 1), is("by_title.stages.0.deals", 0),
      pipeline("ada_token", "nothing", { q: c.text("zzz") }), count("nothing.items", 0), is("nothing.ever", 3),
      pipeline("ada_token", "theirs", { owner_id: ref("ben.id") }), count("theirs.items", 1), pipeline("ada_token", "nobody", { owner_id: c.int(-1) }), count("nobody.items", 2),
      pipeline("ada_token", "there", { company_id: ref("fenwick.id") }), count("there.items", 1), text("there.items.0.title", "Outdoor site"),
      call(crmSearchRoute, "ben_token", "found", { q: c.text("Marlow") }), seesText("found", "Marlow Cycles"),
    ],
  }),
  rowsTest({
    name: "crm: a mention of a guest in a note shows the warning, offers no add, and never sends the note's text",
    stack: [
      ...team, newCompany("ada_token", "Marlow", "marlow"),
      call(crmMentionCheck, "ada_token", "check", { people: withFilters(c.array([]), fl.array_push(ref("gus.id")), fl.array_push(ref("ben.id"))) }),
      yes("check.warn"), count("check.missing", 1), text("check.missing.0.name", "Test gus"), count("check.add", 0),
      call(crmMentionCheck, "ada_token", "clear", { people: withFilters(c.array([]), fl.array_push(ref("ben.id"))) }), no("clear.warn"),
      call(crmMentionCheck, "gus_token", "guest_asks", { people: c.array([]) }), notFound("guest_asks"),
      noteOn("ada_token", "company", "marlow", mentioning("gus", "the secret pricing is 40% off"), "to_guest"),
      call(listNotifications, "gus_token", "guest_inbox"), missesText("guest_inbox", "secret pricing"), missesText("guest_inbox", "mentioned you"),
      s.db.query({ table: notification, where: cmp(col("user_id"), "=", ref("gus.id")), returnType: "count", as: "guest_items" }), is("guest_items", 0),
      noteOn("ada_token", "company", "marlow", mentioning("ben", "the secret pricing is 40% off"), "to_ben"),
      call(listNotifications, "ben_token", "ben_inbox"), seesText("ben_inbox", "mentioned you"), missesText("ben_inbox", "secret pricing"),
      s.db.query({ table: notification, where: cmp(col("user_id"), "=", ref("ben.id")), returnType: "single", as: "item" }), text("item.entity", "company"), equal("item.entity_id", ref("marlow.id")),
    ],
  }),
  workflowTest({
    name: "crm: notes keep their author, links follow their body, and only the author edits",
    stack: [
      ...team, newCompany("ada_token", "Marlow", "marlow"), newTask("ada_token", "Checkout test", "work"),
      noteOn("ada_token", "company", "marlow", c.text("  "), "blank"), says("blank", "Write something first."),
      noteOn("ada_token", "company", "marlow", named("task", "work"), "note"), equal("note.author_id", ref("ada.id")),
      call(addNoteRoute, "ada_token", "again", { client_id: c.text("note-id"), record_type: c.text("company"), record_id: ref("marlow.id"), body: c.text("Same") }), equal("again.id", ref("note.id")),
      rows(crm_note, "notes"), is("notes", 1),
      s.db.query({ table: record_link, where: [cmp(col("from_type"), "=", c.text("crm_note")), cmp(col("from_id"), "=", ref("note.id"))], returnType: "count", as: "linked" }), is("linked", 1),
      pageOf("ada_token", "marlow", "page"), is("page.panels.tasks.total", 1), count("page.notes", 1), text("page.notes.0.author_name", "Test ada"),
      call(editNoteRoute, "ben_token", "theirs", { id: ref("note.id"), body: c.text("Mine now") }), says("theirs", "Only the person who wrote a note can change it."),
      call(editNoteRoute, "ada_token", "edited", { id: ref("note.id"), body: c.text("No link now") }), text("edited.body", "No link now"),
      s.db.query({ table: record_link, where: [cmp(col("from_type"), "=", c.text("crm_note")), cmp(col("from_id"), "=", ref("note.id"))], returnType: "count", as: "left" }), is("left", 0),
      call(deleteNoteRoute, "ada_token", "gone", { id: ref("note.id") }), pageOf("ada_token", "marlow", "after"), count("after.notes", 0),
    ],
  }),
  workflowTest({
    name: "crm: linking a task to a company from chat shows it on the company page, for whoever reaches the task",
    stack: [
      ...team, newCompany("ada_token", "Marlow", "marlow"), newTask("ada_token", "Checkout test", "work"),
      call(postMessageRoute, "ada_token", "said", { id: ref("chat.id"), client_msg_id: c.text("m1"), body: withFilters(named("company", "marlow"), fl.concat(c.text(" needs ")), fl.concat(named("task", "work"))) }),
      pageOf("ada_token", "marlow", "page"), is("page.panels.tasks.total", 1), text("page.panels.tasks.items.0.title", "Checkout test"), is("page.panels.chat.total", 1),
      pageOf("ben_token", "marlow", "outsider"), is("outsider.panels.tasks.total", 0), is("outsider.panels.chat.total", 0), missesText("outsider", "Checkout test"),
      call(openThreadRoute, "ada_token", "thread", { record_type: c.text("task"), record_id: ref("work.id") }),
      newCompany("ada_token", "Fenwick", "fenwick"),
      call(postMessageRoute, "ada_token", "in_thread", { id: ref("thread.id"), client_msg_id: c.text("m2"), body: withFilters(c.text("This is for "), fl.concat(named("company", "fenwick"))) }),
      pageOf("ada_token", "fenwick", "other"), is("other.panels.tasks.total", 1),
      call(postMessageRoute, "gus_token", "guest_post", { id: ref("chat.id"), client_msg_id: c.text("m3"), body: withFilters(named("company", "fenwick"), fl.concat(c.text(" and ")), fl.concat(named("task", "work"))) }),
      s.db.query({ table: record_link, where: [cmp(col("from_type"), "=", c.text("task")), cmp(col("to_type"), "=", c.text("company")), cmp(col("to_id"), "=", ref("fenwick.id"))], returnType: "count", as: "still_one" }), is("still_one", 1),
    ],
  }),
  workflowTest({
    name: "crm: a thread on a deal opens on the deal, under its name, and tells its owner",
    stack: [
      ...team, newCompany("ada_token", "Marlow", "marlow"), newDeal("ada_token", "marlow", "lead", "Care plan", "care", { owner_id: ref("ben.id") }),
      call(openThreadRoute, "ada_token", "thread", { record_type: c.text("deal"), record_id: ref("care.id") }), yes("thread.crm"), is("thread.space_id", 0),
      call(resolveLinks, "ada_token", "chip", { items: withFilters(c.array([]), fl.array_push(obj({ type: c.text("conversation"), id: ref("thread.id") }))) }),
      text("chip.0.title", "Care plan"), s.expect.to_contain({ expr: ref("chip.0.href"), value: c.text("/crm/deals/") }),
      call(postMessageRoute, "ada_token", "said", { id: ref("thread.id"), client_msg_id: c.text("t1"), body: c.text("Any word on this?") }),
      call(listNotifications, "ben_token", "inbox"), seesText("inbox", "replied"), seesText("inbox", "/crm/deals/"),
      call(getDealRoute, "ben_token", "page", { id: ref("care.id") }), equal("page.thread_id", ref("thread.id")),
    ],
  }),
  rowsTest({
    name: "crm: a deal's owner hears once, must reach the CRM, and opening the deal reads the item",
    stack: [
      ...team, newCompany("ada_token", "Marlow", "marlow"), newDeal("ada_token", "marlow", "lead", "Care plan", "care"),
      call(assignDealRoute, "ada_token", "to_guest", { id: ref("care.id"), owner_id: ref("gus.id") }), says("to_guest", "Choose someone who can open customers."),
      call(assignDealRoute, "ada_token", "owned", { id: ref("care.id"), owner_id: ref("ben.id") }), equal("owned.owner_id", ref("ben.id")), text("owned.owner_name", "Test ben"),
      call(assignDealRoute, "ada_token", "again", { id: ref("care.id"), owner_id: ref("ben.id") }),
      s.db.query({ table: notification, where: [cmp(col("user_id"), "=", ref("ben.id")), cmp(col("kind"), "=", c.text("assigned"))], returnType: "count", as: "items" }), is("items", 1),
      call(getDealRoute, "ben_token", "page", { id: ref("care.id") }), is("page.unread_items", 1),
      call(crmReadRoute, "ben_token", "read", { entity: c.text("deal"), id: ref("care.id") }), is("read.read", 1),
      call(updateDealRoute, "ben_token", "renamed", { id: ref("care.id"), title: c.text("Care plan 2"), value: c.int(100), close_on: c.text(""), contact_id: c.int(0) }), text("renamed.title", "Care plan 2"),
      s.function.call({ fn: removeMember, as: "left", input: { actor_id: ref("ann.id"), member_id: ref("ben.id"), new_sponsor_id: c.int(0) } }),
      s.db.get({ table: deal, fieldValue: ref("care.id"), as: "after" }), is("after.owner_id", 0),
    ],
  }),
  workflowTest({
    name: "crm: deleting a company takes its people and deals with it, a restore brings the same ones back, and 30 days ends them",
    stack: [
      ...team, newCompany("ada_token", "Marlow", "marlow"), newContact("ada_token", "marlow", "Riley", "riley"), newDeal("ada_token", "marlow", "lead", "Care plan", "care"), newDeal("ada_token", "marlow", "lead", "Old deal", "old"),
      noteOn("ada_token", "deal", "care", c.text("A note"), "note"),
      call(deleteDealRoute, "ada_token", "dropped", { id: ref("old.id") }),
      call(deleteCompanyRoute, "ada_token", "gone", { id: ref("marlow.id") }),
      pipeline("ben_token", "board"), count("board.items", 0), call(listCompaniesRoute, "ben_token", "list"), count("list.items", 0), call(listContactsRoute, "ben_token", "people"), count("people.items", 0),
      chipsFor("ben_token", "chip", "company", "marlow"), text("chip.0.state", "deleted"), yes("chip.0.can_restore"), text("chip.0.title", ""),
      pageOf("ben_token", "marlow", "trashed"), yes("trashed.trashed"), no("trashed.can_edit"),
      call(updateCompanyRoute, "ben_token", "edit_trashed", { id: ref("marlow.id"), name: c.text("New"), domain: c.text(""), industry: c.text(""), about: c.text("") }), says("edit_trashed", "This record was deleted."),
      newDeal("ben_token", "marlow", "lead", "On a deleted company", "late"), says("late", "This record was deleted."),
      call(restoreCompanyRoute, "ben_token", "back", { id: ref("marlow.id") }),
      pipeline("ben_token", "after"), count("after.items", 1), text("after.items.0.title", "Care plan"), call(listContactsRoute, "ben_token", "people_after"), count("people_after.items", 1),
      call(deleteContactRoute, "ada_token", "contact_gone", { id: ref("riley.id") }), call(listContactsRoute, "ben_token", "fewer"), count("fewer.items", 0),
      call(deleteCompanyRoute, "ada_token", "gone_again", { id: ref("marlow.id") }),
      s.db.patch({ table: company, fieldValue: ref("marlow.id"), data: obj({ deleted_at: withFilters(c.now(), fl.epochms_transform("-31 days")) }) }),
      s.db.patch({ table: deal, fieldValue: ref("care.id"), data: obj({ deleted_at: withFilters(c.now(), fl.epochms_transform("-31 days")) }) }),
      s.db.patch({ table: deal, fieldValue: ref("old.id"), data: obj({ deleted_at: withFilters(c.now(), fl.epochms_transform("-31 days")) }) }),
      s.db.patch({ table: contact, fieldValue: ref("riley.id"), data: obj({ deleted_at: withFilters(c.now(), fl.epochms_transform("-31 days")) }) }),
      s.function.call({ fn: purgeCrm, as: "purged" }),
      s.db.get({ table: company, fieldValue: ref("marlow.id"), as: "row" }), s.expect.to_be_null({ expr: ref("row") }),
      s.db.get({ table: deal, fieldValue: ref("care.id"), as: "deal_row" }), s.expect.to_be_null({ expr: ref("deal_row") }),
      rows(crm_note, "notes_left"), is("notes_left", 0),
      chipsFor("ben_token", "purged_chip", "company", "marlow"), text("purged_chip.0.state", "deleted"), no("purged_chip.0.can_restore"),
    ],
  }),
  workflowTest({
    name: "crm: only admins change the pipeline's stages, and a stage holding deals can't be deleted",
    stack: [
      ...team, newCompany("ada_token", "Marlow", "marlow"), newDeal("ada_token", "marlow", "lead", "Care plan", "care"),
      call(createStageRoute, "ada_token", "refused", { name: c.text("Discovery") }), says("refused", "Only admins change the pipeline."),
      call(createStageRoute, "ann_token", "made", { name: c.text("Discovery") }), text("made.name", "Discovery"), text("made.kind", "open"),
      call(createStageRoute, "ann_token", "blank", { name: c.text("  ") }), says("blank", "Name the stage."),
      call(crmSetupRoute, "ben_token", "setup"), count("setup.stages", 5), text("setup.stages.2.name", "Discovery"), no("setup.can_manage"), call(crmSetupRoute, "ann_token", "admin_setup"), yes("admin_setup.can_manage"),
      call(moveStageRoute, "ann_token", "moved", { id: ref("made.id"), before_id: ref("lead.id") }), call(crmSetupRoute, "ben_token", "moved_setup"), text("moved_setup.stages.0.name", "Discovery"),
      call(renameStageRoute, "ann_token", "renamed", { id: ref("made.id"), name: c.text("Intro") }), text("renamed.name", "Intro"),
      call(deleteStageRoute, "ann_token", "held", { id: ref("lead.id") }), says("held", "Move this stage's deals first."),
      call(deleteStageRoute, "ann_token", "closing", { id: ref("won.id") }), says("closing", "The pipeline needs its Won and Lost stages."),
      call(deleteStageRoute, "ann_token", "dropped", { id: ref("made.id") }), call(crmSetupRoute, "ben_token", "after"), count("after.stages", 4),
    ],
  }),
  workflowTest({
    name: "crm: a contact's details change, and the board's names follow",
    stack: [
      ...team, newCompany("ada_token", "Marlow", "marlow"), newContact("ada_token", "marlow", "Riley", "riley"),
      call(updateContactRoute, "ben_token", "edited", { id: ref("riley.id"), name: c.text("Riley Park"), email: c.text("riley@marlow.example"), phone: c.text("555 0100"), job_title: c.text("Head of digital") }),
      text("edited.email", "riley@marlow.example"), text("edited.job_title", "Head of digital"),
      call(updateCompanyRoute, "ben_token", "renamed", { id: ref("marlow.id"), name: c.text("Marlow Cycles"), domain: c.text("marlow.example"), industry: c.text("Bikes"), about: c.text("Family bike maker.") }), text("renamed.about", "Family bike maker."),
      chipsFor("ben_token", "chip", "contact", "riley"), text("chip.0.title", "Riley Park"), s.expect.to_contain({ expr: ref("chip.0.href"), value: c.text("/crm/companies/") }),
    ],
  }),
  rowsTest({
    name: "crm runs: a run from a CRM thread reaches CRM only, and an agent asked in the thread updates the deal as itself",
    stack: [
      ...team, paused, scoutRow("scout", "ada"), lineOf("scout", "line"), newTask("ada_token", "Space work", "work"),
      newCompany("ada_token", "Marlow", "marlow"), newDeal("ada_token", "marlow", "lead", "Care plan", "care"),
      call(openThreadRoute, "ada_token", "thread", { record_type: c.text("deal"), record_id: ref("care.id") }),
      call(postMessageRoute, "ada_token", "asked", { id: ref("thread.id"), client_msg_id: c.text("ask"), body: mentioning("scout", "move this to Proposal and note why") }),
      ...runNow("run"), is("run.space_id", 0), is("run.dm_id", 0), text("run.status", "queued"),
      s.db.patch({ table: agent_run, fieldValue: ref("run.id"), data: obj({ status: c.text("claimed"), connection_id: ref("line.id") }) }),
      s.function.call({ fn: beginRun, as: "opened", input: { run_id: ref("run.id") } }), equal("opened", ref("thread.id")),
      s.function.call({ fn: runContext, as: "told", input: { run_id: ref("run.id") } }), s.expect.to_contain({ expr: ref("told.text"), value: c.text("Care plan") }), s.expect.to_contain({ expr: ref("told.text"), value: c.text("Proposal") }),
      save(ref("run.id"), "moved", { type: c.text("deal"), id: ref("care.id"), stage: c.text("proposal"), note: c.text("They asked for a proposal.") }),
      s.db.get({ table: deal, fieldValue: ref("care.id"), as: "now" }), equal("now.stage_id", ref("proposal.id")),
      s.db.query({ table: crm_note, returnType: "single", as: "note" }), equal("note.author_id", ref("scout.id")), text("note.record_type", "deal"),
      s.function.call({ fn: readRecord, as: "read", input: { actor_id: ref("scout.id"), run_id: ref("run.id"), type: c.text("deal"), id: ref("care.id") } }), text("read.record.title", "Care plan"),
      s.expect.to_throw({ exception: c.text("Not found"), body: [scoutNow, ...runNow("latest"), ...lookUp([task, "row"]), scoped(ref("latest.id"), "task", ref("row.id"), "out")] }),
      s.expect.to_throw({ exception: c.text("No stage called"), body: [scoutNow, ...runNow("latest"), ...lookUp([deal, "row"]), save(ref("latest.id"), "bad", { type: c.text("deal"), id: ref("row.id"), stage: c.text("Nonsense") })] }),
    ],
  }),
  rowsTest({
    name: "crm runs: a run in a space updates a linked deal when the agent and the requester hold crm.read, and not otherwise",
    stack: [
      ...team, paused, scoutRow("scout", "ada"), lineOf("scout", "line"), joined("a", "scout"), newCompany("ada_token", "Marlow", "marlow"), newDeal("ada_token", "marlow", "lead", "Care plan", "care"),
      newTask("ada_token", "Chase the proposal", "work"),
      call(addLink, "ada_token", "l1", { from_type: c.text("task"), from_id: ref("work.id"), to_type: c.text("deal"), to_id: ref("care.id") }),
      s.db.add({ table: agent_run, as: "run", row: { agent_id: ref("scout.id"), requested_by: ref("ada.id"), source_type: c.text("task"), source_id: ref("work.id"), space_id: ref("a.id"), dm_id: c.int(0), status: c.text("working"), attempt: c.int(1), is_demo: c.bool(false), connection_id: ref("line.id"), started_at: c.now() } }),
      s.function.call({ fn: runContext, as: "told", input: { run_id: ref("run.id") } }), s.expect.to_contain({ expr: ref("told.text"), value: c.text("Care plan") }),
      scoped(ref("run.id"), "deal", ref("care.id"), "allowed"),
      save(ref("run.id"), "moved", { type: c.text("deal"), id: ref("care.id"), stage: c.text("Proposal") }),
      s.db.get({ table: deal, fieldValue: ref("care.id"), as: "now" }), equal("now.stage_id", ref("proposal.id")),
      save(ref("run.id"), "made", { type: c.text("company"), name: c.text("Fenwick Outdoor") }), s.expect.to_be_true({ expr: withFilters(ref("made.id"), fl.is_int()) }),
      save(ref("run.id"), "linked", { type: c.text("company"), id: ref("made.id"), link_type: c.text("task"), link_id: ref("work.id") }),
      s.db.query({ table: record_link, where: [cmp(col("from_type"), "=", c.text("task")), cmp(col("to_type"), "=", c.text("company"))], returnType: "count", as: "links" }), is("links", 1),
      // The same run, asked for by someone who can't open customers.
      s.db.patch({ table: agent_run, fieldValue: ref("run.id"), data: obj({ requested_by: ref("gus.id") }) }),
      s.function.call({ fn: runContext, as: "kept", input: { run_id: ref("run.id") } }), s.expect.to_be_false({ expr: withFilters(ref("kept.text"), fl.contains(c.text("Care plan"))) }),
      s.expect.to_throw({ exception: c.text("Not found"), body: [scoutNow, ...runNow("latest"), ...lookUp([deal, "row"]), scoped(ref("latest.id"), "deal", ref("row.id"), "refused")] }),
      s.expect.to_throw({ exception: c.text("Not found"), body: [scoutNow, ...runNow("latest"), save(ref("latest.id"), "refused", { type: c.text("company"), name: c.text("Sneaking in") })] }),
    ],
  }),
  rowsTest({
    name: "crm runs: a run from a DM reaches only its conversation, and an agent without crm.read reaches nothing",
    stack: [
      ...team, paused, scoutRow("scout", "ada"), lineOf("scout", "line"), newCompany("ada_token", "Marlow", "marlow"), newDeal("ada_token", "marlow", "lead", "Care plan", "care"), ...dm("talk", "ada", "scout"),
      runIn("run", "ada", { dm: ref("talk.id") }),
      s.expect.to_throw({ exception: c.text("Not found"), body: [scoutNow, ...runNow("latest"), ...lookUp([deal, "row"]), scoped(ref("latest.id"), "deal", ref("row.id"), "refused")] }),
      s.db.patch({ table: user, fieldValue: ref("scout.id"), data: obj({ role: c.text("guest") }) }),
      s.function.call({ fn: canReach, as: "demoted", input: { actor_id: ref("scout.id"), browser: c.bool(false), type: c.text("deal"), id: ref("care.id") } }), no("demoted"),
    ],
  }),
  workflowTest({
    name: "crm runs: naming an agent in a note starts a run on that record, and a guest can't",
    stack: [
      ...team, paused, scoutRow("scout", "ada"), lineOf("scout", "line"), newCompany("ada_token", "Marlow", "marlow"), newDeal("ada_token", "marlow", "lead", "Care plan", "care"),
      noteOn("ada_token", "deal", "care", mentioning("scout", "please draft the next step"), "asked"),
      ...runNow("run"), text("run.source_type", "deal"), equal("run.source_id", ref("care.id")), is("run.space_id", 0), text("run.status", "queued"),
      s.db.patch({ table: agent_run, fieldValue: ref("run.id"), data: obj({ status: c.text("claimed"), connection_id: ref("line.id") }) }),
      s.function.call({ fn: beginRun, as: "opened", input: { run_id: ref("run.id") } }),
      s.function.call({ fn: runContext, as: "told", input: { run_id: ref("run.id") } }), s.expect.to_contain({ expr: ref("told.text"), value: c.text("please draft the next step") }),
      s.function.call({ fn: finishRun, as: "finished", input: { run_id: ref("run.id"), attempt: c.int(1), error: c.text(""), steps: c.array([]) } }),
      call(listNotifications, "ada_token", "inbox"), seesText("inbox", "/crm/deals/"),
      s.db.query({ table: message, where: cmp(col("conversation_id"), "=", ref("opened")), returnType: "count", as: "said" }), is("said", 0),
    ],
  }),
];
