// The template's own backend: its tables, functions, endpoints, agent tools and assistant tools (BASELINE.md).
// xano/index.ts registers everything listed here, beside the base app and the modules. Put each def in its own
// file (table/<name>.ts, query/<group>.ts, query/<group>/<name>.ts, function/<name>.ts) and list it below.
//
// Every endpoint or tool that writes one of these tables calls `changed(...)` from ./base/index.js in the same
// stack, so open screens update live and the activity feed records it (audit-bundle.mjs checks).
import { space } from "./table/spaces/space.js";
import { space_member } from "./table/spaces/space_member.js";
import { conversation } from "./table/messaging/conversation.js";
import { conversation_member } from "./table/messaging/conversation_member.js";
import { conversation_read } from "./table/messaging/conversation_read.js";
import { message } from "./table/messaging/message.js";
import { runSetup } from "./function/members/setup.js";
import { removeMember } from "./function/members/offboard.js";
import { endDemo } from "./function/members/end_demo.js";
import { clearDemo, demoCounts } from "./function/members/clear_demo.js";
import { accessFunctions } from "./function/access/reach.js";
import { afterRemoval, kickFn } from "./function/access/removal.js";
import { spaceFunctions } from "./function/access/spaces.js";
import { changeFunctions } from "./function/links/changes.js";
import { linkFunctions } from "./function/links/links.js";
import { recordFunctions } from "./function/links/records.js";
import { deliverFunctions } from "./function/inbox/deliver.js";
import { inboxFunctions } from "./function/inbox/read.js";
import { conversationFunctions } from "./function/messaging/conversations.js";
import { messageFunctions } from "./function/messaging/messages.js";
import { purgeDaily, taskFunctions } from "./function/tasks/tasks.js";
import { agent_run } from "./table/agents/agent_run.js";
import { hostedAgents as agents, runnerFunctions, sweepTask } from "./agents/runner.js";
import { hostedTools, toolFunctions } from "./agents/tools.js";
import { memberGate, stampVia, writeGate } from "./agents/member-tool.js";
import { askFunctions } from "./agents/ask.js";
import { actionFunctions } from "./agents/actions.js";
import { keyFunctions } from "./agents/keys.js";
import { manageFunctions } from "./function/agents/manage.js";
import { agentReadFunctions } from "./function/agents/read.js";
import { decisionTrigger, sweepFunctions, sweepHourly } from "./agents/sweep.js";
import { approvalFunctions } from "./function/inbox/approvals.js";
import { afterDocWrite, docFunctions, gateDocWrite, purgeDocsDaily } from "./function/docs/docs.js";
import { suggestionFunctions } from "./function/docs/suggestions.js";
import { doc_state } from "./table/docs/doc_state.js";
import { doc_suggestion } from "./table/docs/doc_suggestion.js";
import { company } from "./table/crm/company.js";
import { contact } from "./table/crm/contact.js";
import { crm_note } from "./table/crm/crm_note.js";
import { deal } from "./table/crm/deal.js";
import { pipeline_stage } from "./table/crm/pipeline_stage.js";
import { companyFunctions } from "./function/crm/companies.js";
import { contactFunctions } from "./function/crm/contacts.js";
import { dealFunctions } from "./function/crm/deals.js";
import { linkNamed } from "./function/crm/link-named.js";
import { noteFunctions } from "./function/crm/notes.js";
import { purgeCrmDaily, purgeFunctions } from "./function/crm/purge.js";
import { readFunctions } from "./function/crm/reads.js";
import { stageFunctions } from "./function/crm/stages.js";
import { file_blob } from "./table/files/file_blob.js";
import { file_record } from "./table/files/file_record.js";
import { fileFunctions, purgeFilesDaily } from "./function/files/files.js";
import { project } from "./table/tasks/project.js";
import { task } from "./table/tasks/task.js";
import { task_view } from "./table/tasks/task_view.js";
import { record_link } from "./table/links/record_link.js";
import { change_channel, change_log } from "./table/links/change_log.js";
import { changeQueries, changesGroup } from "./query/changes.js";
import { linkQueries, linksGroup } from "./query/links.js";
import { messagingGroup, messagingQueries } from "./query/messages.js";
import { memberQueries, membersGroup } from "./query/members.js";
import { spaceQueries, spacesGroup } from "./query/spaces.js";
import { taskQueries, tasksGroup } from "./query/tasks.js";
import { agentGroups, agentQueries } from "./query/agents.js";
import { docQueries, docToolsGroup } from "./query/docs.js";
import { crmGroup, crmQueries } from "./query/crm.js";
import { fileQueries, filesGroup } from "./query/files.js";
import { search_entry } from "./table/search/search_entry.js";
import { activity, notification } from "./base/tables.js";
import { SEED_ACTIVITY, SEED_NOTIFICATIONS } from "./world.js";
import { searchFunctions } from "./function/search/search.js";
import { overviewFunctions } from "./function/search/overview.js";
import { searchGroup, searchQueries } from "./query/search.js";

Object.assign(activity, { seed: SEED_ACTIVITY });
Object.assign(notification, { seed: SEED_NOTIFICATIONS });

export const tables = [search_entry, space, space_member, conversation, conversation_member, conversation_read, message, project, task, task_view, record_link, change_channel, change_log, agent_run, doc_suggestion, doc_state, pipeline_stage, company, contact, deal, crm_note, file_record, file_blob];
export const functions = [runSetup, removeMember, endDemo, clearDemo, demoCounts, ...accessFunctions, ...spaceFunctions, kickFn, afterRemoval, ...changeFunctions, ...searchFunctions, ...overviewFunctions, ...recordFunctions, ...linkFunctions, ...deliverFunctions, ...inboxFunctions, ...conversationFunctions, ...messageFunctions, ...taskFunctions, ...docFunctions, ...suggestionFunctions, linkNamed, ...companyFunctions, ...contactFunctions, ...dealFunctions, ...stageFunctions, ...noteFunctions, ...readFunctions, ...purgeFunctions, ...fileFunctions, ...approvalFunctions, memberGate, writeGate, stampVia, ...askFunctions, ...actionFunctions, ...keyFunctions, ...manageFunctions, ...agentReadFunctions, ...sweepFunctions, ...toolFunctions, ...runnerFunctions];
export const tasks = [purgeDaily, purgeDocsDaily, purgeCrmDaily, purgeFilesDaily, sweepTask, sweepHourly];
/** Fires when an approval stops being pending. A merge into an ephemeral or a tenant is refused while one exists: use a replace there. */
export const triggers = [decisionTrigger];
/** A template's own route middleware, registered before any route that names it. */
export const middlewares = [gateDocWrite, afterDocWrite];
export const hostedAgents = agents;
export const apiGroups = [membersGroup, spacesGroup, linksGroup, changesGroup, messagingGroup, tasksGroup, docToolsGroup, crmGroup, filesGroup, searchGroup, ...agentGroups];
export const queries = [...memberQueries, ...spaceQueries, ...linkQueries, ...changeQueries, ...messagingQueries, ...taskQueries, ...docQueries, ...crmQueries, ...fileQueries, ...searchQueries, ...agentQueries];

/** MCP tools (AGENT-ACCESS.md §2): `agent.tool({...})` defs, the same for hosted and connected agents. index.ts adds `approvals.checkTool("mcp")`. */
export const agentTools = hostedTools;
export const agentPrompts = [];
export const agentResources = [];

/** The assistant's domain tools (CHATBOT.md §1): `tool({...})` defs. The base adds what-changed and notifications. */
export const assistantTools = [];

/** The domain half of the assistant's system prompt: what the app is, its records and roles, which tool when. */
export const assistantPrompt = "You are the assistant inside Commons, where a team and its agents share chat, tasks, docs, customers and files.";
