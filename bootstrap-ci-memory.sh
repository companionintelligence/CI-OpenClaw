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
}

if (changed) {
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`[ci-memory-bootstrap] registered ${pluginId}`);
} else {
  console.log(`[ci-memory-bootstrap] ${pluginId} already registered`);
}
JS
