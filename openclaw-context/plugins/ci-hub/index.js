import { register as registerHubPlugin } from "./hub-plugin.mjs";

/**
 * OpenClaw plugin entry. Credentials come from Hub-injected env vars
 * (HUB_URL, HUB_MCP_API_KEY, HUB_WAKE_SECRET) — never from openclaw.json.
 *
 * Hub MCP *tools* are served by OpenClaw's built-in MCP client via the
 * `mcp.servers.ci-hub` entry (written by bootstrap-ci-hub-mcp.sh / server.cjs).
 * This plugin covers the non-MCP surface: the wake webhook. (It also implements
 * app-event SSE, but that is disabled here — see `sseEnabled: false` below.)
 * It does NOT configure inference — the working `models.providers.ci-hub` (native
 * Ollama transport, live model discovery) is written to openclaw.json by
 * server.cjs / config-reconcile.cjs. A provider registered through the plugin API
 * cannot resolve the `ollama` transport and would break chat (CI-Hub#895).
 *
 * register() MUST be synchronous. OpenClaw's loader throws "plugin register must be
 * synchronous" if it returns a promise, which fails the whole plugin — an `async`
 * here is enough to stop the plugin loading at all. registerHubPlugin() is likewise
 * synchronous and defers its network work internally, so do not await it.
 */
export default {
  id: "ci-hub",
  name: "CI Hub",
  description:
    "CI-Hub companion plugin (wake webhook; app-event SSE implemented but disabled here); Hub MCP tools come from the native mcp.servers.ci-hub config, and the ci-hub model provider from openclaw.json.",
  register(api) {
    registerHubPlugin(api, { sseEnabled: false });
  },
};
