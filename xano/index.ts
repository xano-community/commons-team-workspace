// The workspace: the base app and every module, wired around the template's own domain (xano/domain.ts).
// Owned by the base app (modules/base). A template edits app.ts, domain.ts, rbac.ts, agent.ts and approvals.ts;
// it doesn't need to touch this file.
import { workspace } from "@xano/sdk";
import { APPROVALS_PROMPT_RULE, registerAgents } from "@xano-sdk/agents";
import { createChatbot } from "@xano-sdk/chatbot";
import { createMcpOauth } from "@xano-sdk/mcp-oauth";
import { Getting_Started_Template_create_event_log } from "./_shared.js";
import { Authentication } from "./query/authentication.js";
import { auth_login } from "./query/authentication/auth_login_POST.js";
import { auth_me } from "./query/authentication/auth_me_GET.js";
import { auth_setup } from "./query/authentication/auth_setup_POST.js";
import { auth_signup } from "./query/authentication/auth_signup_POST.js";
import { account } from "./table/account.js";
import { event_log } from "./table/event_log.js";
import { user } from "./table/user.js";
import { workspaceSettings } from "./workspace.js";
import { APP } from "./app.js";
import { BASE_ASSISTANT_RULES, baseAssistantTools, registerBase } from "./base/index.js";
import { agent, mcpOauthOptions } from "./agent.js";
import { withinToolLimit } from "./agents/tool-limit.js";
import { approvals } from "./approvals.js";
import { rbac } from "./rbac.js";
import * as domain from "./domain.js";
import { docRoutes, docs, docWrites } from "./docs.js";
import { afterDocWrite, gateDocWrite } from "./function/docs/docs.js";
import { gateActive, gateNotGuest } from "./function/members/gate.js";
import { afterDecision } from "./function/inbox/approvals.js";
import { noteClient } from "./agents/member-tool.js";
import { memberTests } from "./test/members.js";
import { accessTests } from "./test/access.js";
import { linkTests } from "./test/links.js";
import { inboxTests } from "./test/inbox.js";
import { messagingTests } from "./test/messaging.js";
import { taskTests } from "./test/tasks.js";
import { agentRunTests } from "./test/agent-runs.js";
import { docTests } from "./test/docs.js";
import { crmTests } from "./test/crm.js";
import { fileTests } from "./test/files.js";
import { searchTests } from "./test/search.js";
import { agentTests } from "./test/agents.js";
import { askTests, seedTests } from "./test/seed.js";

// A removed person's token still works until it expires, so every signed-in route runs gateActive. The agents,
// chatbot and sign-in modules have no option for it, so their defs take it here, before they register.
const staffOnly = { pre: [gateActive, gateNotGuest] };
agent.group.middleware = staffOnly;
approvals.group.middleware = staffOnly;
// A decision clears the approval's inbox items for every approver. The module has no hook, so this rides its two routes.
approvals.approve.middleware = { post: [afterDecision] };
approvals.decline.middleware = { post: [afterDecision] };
// A decision can start a run again, and a run mints a token, so nothing of these requests is kept.
approvals.approve.history = false;
approvals.decline.history = false;
// The module knows nothing of spaces, so an archived space's docs are refused here, on each route that writes.
for (const route of docWrites) route.middleware = { pre: [gateDocWrite] };
docs.endpoints.save.middleware = { pre: [gateDocWrite], post: [afterDocWrite] };
docs.endpoints.restore.middleware = { pre: [gateDocWrite], post: [afterDocWrite] };
// A save can name an agent, and that can start a run, which mints a token: nothing of this request is kept.
docs.endpoints.save.history = false;

const app = workspace(APP.slug)
  .registerWorkspace(workspaceSettings)
  .registerMiddleware([gateActive, gateNotGuest, afterDecision, noteClient, ...domain.middlewares])
  .registerTables([user, account, event_log, ...domain.tables])
  .registerFunctions([Getting_Started_Template_create_event_log, ...domain.functions])
  .registerTasks(domain.tasks)
  .registerTriggers(domain.triggers)
  .registerApiGroups([Authentication, ...domain.apiGroups])
  .registerQueries([auth_signup, auth_setup, auth_login, auth_me, ...domain.queries]);

registerBase(app);
app.registerWorkflowTests([...memberTests, ...accessTests, ...linkTests, ...inboxTests, ...messagingTests, ...taskTests, ...agentRunTests, ...agentTests, ...docTests, ...crmTests, ...fileTests, ...searchTests, ...seedTests]);
// Only the routes the app means to open: docs.register would add creating, listing and naming people outside the space rule.
app.registerTables([docs.doc, docs.doc_version]).registerFunctions(docs.functions).registerApiGroups([docs.group]).registerQueries(docRoutes);

// Agents (AGENT-ACCESS.md): the MCP server with the domain's tools, its ChatGPT/Claude sign-in twin, approvals.
const mcpTools = withinToolLimit([...domain.agentTools, approvals.checkTool("mcp")]);
agent.serve({ tools: mcpTools, prompts: domain.agentPrompts, resources: domain.agentResources });
const oauth = createMcpOauth(mcpOauthOptions, APP.slug);
// The only signed-in route in a group of public ones. It's also the one moment the app knows which client is signing in.
oauth.completeQuery.middleware = { pre: [...staffOnly.pre, noteClient] };
app.registerApiGroups([oauth.group]).registerQueries([oauth.loginQuery, oauth.requestQuery, oauth.signInQuery, oauth.completeQuery]);
registerAgents(app, { access: agent, approvals });
app.registerAgents(domain.hostedAgents);
rbac.register(app);

// The assistant (CHATBOT.md), always: the base tools, the domain's, and checking on approvals.
const assistantTools = [...baseAssistantTools, ...domain.assistantTools, approvals.checkTool("assistant")];
export const bot = createChatbot({
  authTable: user, canonical: "chat", tools: assistantTools,
  // The workspace's own chat owns `conversation` and `message`.
  names: { conversation: "assistant_conversation", message: "assistant_message" },
  llm: { type: "xano-free", systemPrompt: [domain.assistantPrompt, BASE_ASSISTANT_RULES, APPROVALS_PROMPT_RULE].join(" ") },
});
// Guests have no assistant: it reads across the workspace on their behalf, and their spaces are all they may see (U22).
bot.group.middleware = staffOnly;
app.registerTables([bot.conversation, bot.message]).registerAgents([bot.agent]).registerFunctions([bot.replyFn]).registerApiGroups([bot.group]).registerQueries(bot.queries);
app.registerTools(assistantTools);   // the package only references tools: register them on the workspace too
app.registerWorkflowTests(askTests(bot.queries));
export default app;                  // the default export must be the workspace

export { Authentication, account, auth_login, auth_me, auth_signup, event_log, user, workspaceSettings };
