import { register as registerHubPlugin } from "./hub-plugin.mjs";

/**
 * OpenClaw plugin entry. Credentials come from Hub-injected env vars
 * (HUB_URL, HUB_MCP_API_KEY, HUB_WAKE_SECRET) — never from openclaw.json.
 */
export default {
  id: "ci-hub",
  name: "CI Hub",
  description: "OpenClaw plugin for controlling CI-Hub via MCP.",
  async register(api) {
    await registerHubPlugin(api, { sseEnabled: false });
  },
};
