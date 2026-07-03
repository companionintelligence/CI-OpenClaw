import { register as registerHubPlugin } from "./hub-plugin.mjs";

/**
 * OpenClaw plugin entry. Credentials come from Hub-injected env vars
 * (HUB_URL or HUB_MCP_URL, HUB_MCP_API_KEY, HUB_WAKE_SECRET) — never from openclaw.json.
 *
 * Hub MCP *tools* are served by OpenClaw's built-in MCP client via the
 * `mcp.servers.ci-hub` entry (written by bootstrap-ci-hub-mcp.sh / server.cjs).
 * This plugin covers the non-MCP surface: wake notifications, app-event SSE, and
 * local-inference auto-configuration.
 */
export default {
  id: "ci-hub",
  name: "CI Hub",
  description:
    "CI-Hub companion plugin (wake, app-event SSE, inference auto-config); Hub MCP tools come from the native mcp.servers.ci-hub config.",
  async register(api) {
    await registerHubPlugin(api, { sseEnabled: false });
  },
};
