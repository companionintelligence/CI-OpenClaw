#!/bin/sh
# Idempotently registers the bundled Companion Intelligence memory plugin in an
# existing OpenClaw config. The setup server also reconciles this after
# onboarding; this script gives container startup a post-install repair path.
set -eu

DATA_DIR="${OPENCLAW_DATA_DIR:-/data/.openclaw}"
CONFIG_FILE="${DATA_DIR}/openclaw.json"
PLUGIN_ID="companionintelligence"
PLUGIN_PATH="/app/openclaw-context/plugins/companionintelligence"

log() {
  echo "[ci-memory-bootstrap] $*"
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
  process.env.CI_SERVER_URL &&
    process.env.CI_SERVER_TOKEN &&
    process.env.CI_SERVER_ENABLED !== "false",
);

let config;
try {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
} catch (error) {
  console.error(`[ci-memory-bootstrap] WARN: cannot read ${configFile}: ${error.message}`);
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
const entry = entries[pluginId] && typeof entries[pluginId] === "object" ? entries[pluginId] : {};
const slots =
  config.plugins.slots && typeof config.plugins.slots === "object" && !Array.isArray(config.plugins.slots)
    ? config.plugins.slots
    : {};
const currentSlot = slots.memory;

const shouldSelect = (
  hasCredentials &&
  (currentSlot === undefined || currentSlot === "" || currentSlot === "memory-core" || currentSlot === pluginId)
) || currentSlot === pluginId;

if (entry.enabled !== shouldSelect) {
  entry.enabled = shouldSelect;
  entries[pluginId] = entry;
  changed = true;
}

if (shouldSelect) {
  config.plugins.slots = slots;
  if (slots.memory !== pluginId) {
    slots.memory = pluginId;
    changed = true;
  }

  // The plugin's agent_end turn-sync is a conversation hook; non-bundled
  // (path-loaded) plugins only receive it when allowConversationAccess is set.
  const entryHooks =
    entry.hooks && typeof entry.hooks === "object" && !Array.isArray(entry.hooks)
      ? entry.hooks
      : {};
  if (entryHooks.allowConversationAccess !== true) {
    entryHooks.allowConversationAccess = true;
    entry.hooks = entryHooks;
    entries[pluginId] = entry;
    changed = true;
  }

  config.hooks =
    config.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks)
      ? config.hooks
      : {};
  config.hooks.internal =
    config.hooks.internal &&
    typeof config.hooks.internal === "object" &&
    !Array.isArray(config.hooks.internal)
      ? config.hooks.internal
      : {};
  config.hooks.internal.entries =
    config.hooks.internal.entries &&
    typeof config.hooks.internal.entries === "object" &&
    !Array.isArray(config.hooks.internal.entries)
      ? config.hooks.internal.entries
      : {};

  const sessionMemoryEntry =
    config.hooks.internal.entries["session-memory"] &&
    typeof config.hooks.internal.entries["session-memory"] === "object" &&
    !Array.isArray(config.hooks.internal.entries["session-memory"])
      ? config.hooks.internal.entries["session-memory"]
      : {};
  if (sessionMemoryEntry.enabled !== false) {
    sessionMemoryEntry.enabled = false;
    config.hooks.internal.entries["session-memory"] = sessionMemoryEntry;
    changed = true;
  }

  config.tools =
    config.tools && typeof config.tools === "object" && !Array.isArray(config.tools)
      ? config.tools
      : {};
  config.tools.alsoAllow = Array.isArray(config.tools.alsoAllow)
    ? config.tools.alsoAllow
    : [];
  if (!config.tools.alsoAllow.includes("memory_store")) {
    config.tools.alsoAllow.push("memory_store");
    changed = true;
  }
  if (Array.isArray(config.tools.allow) && !config.tools.allow.includes("memory_store")) {
    config.tools.allow.push("memory_store");
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`[ci-memory-bootstrap] registered ${pluginId}`);
} else {
  console.log(`[ci-memory-bootstrap] ${pluginId} already registered`);
}
JS
