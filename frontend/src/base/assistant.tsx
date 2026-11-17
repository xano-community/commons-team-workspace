// The assistant, loaded the first time someone asks: the chat module is the largest thing in the app, and most sessions
// never open it from a cold start. It mounts open, because that's why it was loaded.
import { useEffect } from "react";
import { useNavigate } from "react-router";
import { decorateApprovalReply } from "@xano-sdk/agents/react";
import { ChatWidget, createChatClient, openChatWidget, type ChatTurn } from "@xano-sdk/chatbot/react";
import { WithAgents } from "./agents";
import { isLocalEngine } from "./demo-banner";
import { XANO_HOST, token } from "./request";
import { useSession } from "./session";

const client = createChatClient({ apiBaseUrl: `${XANO_HOST}/api:chat`, getToken: () => token.get() });

/**
 * On a Xano Engine on this machine the assistant can't answer: its model runs on Xano's cloud, and the engine answers
 * every message with an error. Say so where the person types, instead of "couldn't answer just now".
 */
const LOCAL_ENGINE = isLocalEngine(XANO_HOST);
const LOCAL_ASSISTANT = "You're on a local Xano Engine, where the assistant can't answer: its AI model runs on Xano's cloud. Deploy with npm run xano:deploy:ephemeral to talk to it.";

/** The approval card replaces a link to Approvals: drop that line when a reply shows one (CHATBOT.md §3). */
const decorateReply = (reply: ChatTurn) => {
  const d = decorateApprovalReply(reply);
  return d && { ...d, content: d.content.replace(/^.*\]\(\/approvals\).*$/gm, "").trim() };
};
const baseFollowUps = (reply: ChatTurn) => (reply.tools ?? []).includes("recent_activity")
  ? ["What's waiting for me?", "What's waiting for approval?"] : ["What changed today?", "What's waiting for me?"];

export type AssistantConfig = { name: string; welcome: string; suggestions: string[]; followUps?: (reply: ChatTurn) => string[] };

export { openChatWidget };

export default function Assistant({ config }: { config: AssistantConfig }) {
  const navigate = useNavigate();
  const { expire } = useSession();
  useEffect(() => { openChatWidget(); }, []);
  return (
    <WithAgents>
      <ChatWidget client={client} assistantName={config.name} launcher="none" decorateReply={decorateReply}
        followUps={config.followUps ?? baseFollowUps} onNavigate={(href) => navigate(href)}
        welcome={LOCAL_ENGINE ? LOCAL_ASSISTANT : config.welcome} suggestions={config.suggestions} onUnauthorized={expire} />
    </WithAgents>
  );
}
