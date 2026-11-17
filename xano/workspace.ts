// Workspace settings — generated from a Xano bundle.
import { workspaceConfig } from "@xano/sdk";

export const workspaceSettings = workspaceConfig({
  name: "team-workspace",
  // REALTIME_KICK is `on` for a cloud deploy. It stays `off` on the local Engine, which answers 501 to a kick.
  // AGENT_RUN_SLOTS is how many hosted runs go at once: 1 suits the Engine and the small plans, and a cloud deploy sets 2.
  // AGENT_PROVIDER picks the model that hosted agents use: `anthropic` or `google-genai`, each with its own key and model.
  env: {
    MCP_OAUTH_LOGIN_URL: "", SETUP_TOKEN: "", REALTIME_KICK: "off",
    AGENT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: "claude-opus-5-5", GEMINI_API_KEY: "", GEMINI_MODEL: "gemini-3.8-flash", AGENT_RUN_SLOTS: "1",
  },
});
