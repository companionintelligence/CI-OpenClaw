#!/bin/sh
# Idempotently registers the bundled CI-Hub MCP plugin in an existing OpenClaw
# config. The setup server also reconciles this after onboarding; this script
# gives container startup a post-install repair path when Hub MCP creds are set.
set -eu

DATA_DIR="${OPENCLAW_DATA_DIR:-/data/.openclaw}"
CONFIG_FILE="${DATA_DIR}/openclaw.json"
PLUGIN_ID="ci-hub"
PLUGIN_PATH="${CI_HUB_PLUGIN_PATH:-/app/openclaw-context/plugins/ci-hub}"

log() {
  echo "[ci-hub-bootstrap] $*"
}

if [ ! -d "${DATA_DIR}" ]; then
  log "WARN: ${DATA_DIR} does not exist; skipping"
  exit 0
fi

if [ ! -d "${PLUGIN_PATH}" ]; then
  log "WARN: ${PLUGIN_PATH} does not exist; skipping"
  exit 0
fi

if [ ! -f "${CONFIG_FILE}" ]; then
  log "config not found yet; setup server will reconcile after onboarding"
  exit 0
fi

node - "${CONFIG_FILE}" "${PLUGIN_ID}" "${PLUGIN_PATH}" <<'JS'
const fs = require("fs");

const [configFile, pluginId, pluginPath] = process.argv.slice(2);
const hasCredentials = Boolean(
  (process.env.HUB_URL || process.env.HUB_MCP_URL) &&
    process.env.HUB_MCP_API_KEY &&
    process.env.HUB_MCP_ENABLED !== "false",
);

let config;
try {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
} catch (error) {
  console.error(`[ci-hub-bootstrap] WARN: cannot read ${configFile}: ${error.message}`);
  process.exit(0);
}

let changed = false;

function ensureObject(parent, key) {
  if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) {
    parent[key] = {};
    changed = true;
  }
  return parent[key];
}

function ensureArrayPath(root, keys) {
  let current = root;
  for (const key of keys.slice(0, -1)) {
    current = ensureObject(current, key);
  }
  const leaf = keys[keys.length - 1];
  if (!Array.isArray(current[leaf])) {
    current[leaf] = [];
    changed = true;
  }
  return current[leaf];
}

config.plugins = ensureObject(config, "plugins");
if (config.plugins.enabled !== true) {
  config.plugins.enabled = true;
  changed = true;
}

const paths = ensureArrayPath(config, ["plugins", "load", "paths"]);
if (!paths.includes(pluginPath)) {
  paths.push(pluginPath);
  changed = true;
}

const entries = ensureObject(config.plugins, "entries");
const entry =
  entries[pluginId] && typeof entries[pluginId] === "object" && !Array.isArray(entries[pluginId])
    ? entries[pluginId]
    : {};

const shouldEnable = hasCredentials;

if (entry.enabled !== shouldEnable) {
  entry.enabled = shouldEnable;
  entries[pluginId] = entry;
  changed = true;
}

// Register the Hub as a native OpenClaw MCP server (mcp.servers.ci-hub) so Hub
// tools load via OpenClaw's built-in Streamable HTTP client. Mirrors
// server.cjs's ensureHubMcpServer(). The Bearer token stays as the literal
// ${HUB_MCP_API_KEY} env-template ref — OpenClaw resolves it at activation, so
// the raw key is never persisted to openclaw.json.
function canonicalHubMcpUrl() {
  let raw = (process.env.HUB_MCP_URL || "").trim();
  if (!raw) {
    const base = (process.env.HUB_URL || "").trim().replace(/\/+$/, "");
    raw = base ? `${base}/api/mcp` : "";
  }
  raw = raw.replace(/\/+$/, "");
  if (raw.endsWith("/api/mcp/sse")) raw = raw.slice(0, -"/sse".length);
  if (!raw) return "";
  return raw.endsWith("/api/mcp") ? raw : `${raw}/api/mcp`;
}

const mcpUrl = shouldEnable ? canonicalHubMcpUrl() : "";
if (shouldEnable && mcpUrl) {
  const mcp = ensureObject(config, "mcp");
  const servers = ensureObject(mcp, "servers");
  const desired = {
    url: mcpUrl,
    transport: "streamable-http",
    headers: { Authorization: "Bearer ${HUB_MCP_API_KEY}" },
    connectionTimeoutMs: 60_000,
    requestTimeoutMs: 180_000,
  };
  if (JSON.stringify(servers["ci-hub"]) !== JSON.stringify(desired)) {
    servers["ci-hub"] = desired;
    changed = true;
    console.log(`[ci-hub-bootstrap] ci-hub MCP server → ${mcpUrl}`);
  }
} else if (config.mcp && config.mcp.servers && config.mcp.servers["ci-hub"]) {
  delete config.mcp.servers["ci-hub"];
  changed = true;
  console.log("[ci-hub-bootstrap] removed ci-hub MCP server (Hub MCP disabled or credentials absent)");
}

if (changed) {
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (shouldEnable) {
    console.log(`[ci-hub-bootstrap] registered ${pluginId}`);
  } else {
    console.log(`[ci-hub-bootstrap] ${pluginId} disabled (Hub MCP credentials not set)`);
  }
} else if (shouldEnable) {
  console.log(`[ci-hub-bootstrap] ${pluginId} already registered`);
} else {
  console.log(`[ci-hub-bootstrap] ${pluginId} skipped (Hub MCP credentials not set)`);
}
JS
