const http = require("http");
const net = require("net");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const { spawn, exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const pty = require("/app/node_modules/node-pty");
const WebSocket = require("/app/node_modules/ws");

const CONFIG_DIR = process.env.OPENCLAW_DATA_DIR || "/data/.openclaw";
const CONFIG_FILE = path.join(CONFIG_DIR, "openclaw.json");
const ENV_FILE = path.join(CONFIG_DIR, ".env");
const PORT = parseInt(process.env.SETUP_PORT || "18789");
const OPENCLAW_PORT = 18790; // Internal port for OpenClaw gateway
const SKELETON_DIR = "/home-skeleton";
const CI_PLUGIN_ID = "ci-runtime";
const CI_PLUGIN_PATH = "/app/openclaw-context/plugins/ci-runtime";
const CI_MEMORY_PLUGIN_ID = "companionintelligence";
const CI_MEMORY_PLUGIN_PATH =
  "/app/openclaw-context/plugins/companionintelligence";
const CI_HUB_PLUGIN_ID = "ci-hub";
const CI_HUB_PLUGIN_PATH = "/app/openclaw-context/plugins/ci-hub";
// Treats the embeddings endpoint as an OpenAI-compatible /v1 server (which Ollama
// serves) and, unlike the bundled remote providers, requires no API key.
const MEMORY_EMBEDDING_PROVIDER = "openai-compatible";
// Anti-CSWSH token for the setup terminal WebSocket. Browsers don't enforce the
// same-origin policy on WebSocket upgrades, so without this any site could connect
// to /api/terminal and hijack the onboarding PTY. We embed APP_SEED (per-user
// secret from CI marketplace) in the served HTML and require it on the WS URL — the
// same-origin policy prevents cross-origin pages from reading it.
const SETUP_TOKEN = process.env.APP_SEED || "";

// Dedicated per-process token for the local memory-gate dismiss actions
// (/__ci_memory/defer + /skip). Deliberately NOT SETUP_TOKEN (=APP_SEED, the
// RCE-grade terminal secret): those actions are low-value (dismiss a prompt), so
// they must not reuse — nor risk leaking — the terminal secret. Minted fresh per
// boot and carried in the POST body (never the URL) so it can't leak via proxy
// logs / Referer / history.
const MEMORY_ACTION_TOKEN = crypto.randomBytes(32).toString("hex");

/**
 * Constant-time token compare that is safe for arbitrary (incl. multi-byte)
 * input: compares BYTE lengths first, because crypto.timingSafeEqual throws a
 * RangeError on unequal-length buffers — and an attacker-supplied value can match
 * the JS string length while differing in bytes. Used by both the memory-gate
 * actions and the /api/terminal WebSocket upgrade.
 */
function tokensMatch(provided, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(provided ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let openclawProcess = null;
let openclawStarting = false;
let ptyProcess = null;

function readEnv() {
  const env = {};
  try {
    if (fs.existsSync(ENV_FILE)) {
      const content = fs.readFileSync(ENV_FILE, "utf8");
      content.split("\n").forEach((line) => {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (match) {
          env[match[1]] = match[2];
        }
      });
    }
  } catch (e) {
    console.error("Error reading env:", e);
  }
  return env;
}

// Keys the Hub injects into the container environment as the source of truth.
// These must never be shadowed by a stale value persisted in .env — e.g. a
// token left behind by a prior install whose data dir survived an incomplete
// uninstall. For these keys the live container env wins, so an updated Hub
// config propagates on restart instead of the gateway re-reading the old token.
const HUB_AUTHORITATIVE_ENV_KEYS = [
  "CI_SERVER_URL",
  "CI_SERVER_TOKEN",
  "CI_SERVER_ENABLED",
  "HUB_URL",
  "HUB_MCP_URL",
  "HUB_MCP_API_KEY",
  "HUB_WAKE_SECRET",
  "HUB_MCP_ENABLED",
];

// Overlay Hub-authoritative keys from the live container env onto `env`,
// mutating and returning it. A non-empty container value wins (including
// CI_SERVER_ENABLED="false", which must be able to disable memory over a stale
// .env). An unset or empty-string container value is ignored — so an
// unsubstituted docker-compose `${VAR}` that resolves to "" doesn't blank out a
// .env / wizard value — leaving older-Hub and local-dev behavior intact.
function applyHubAuthoritativeEnv(env) {
  for (const key of HUB_AUTHORITATIVE_ENV_KEYS) {
    const fromContainer = process.env[key];
    if (fromContainer !== undefined && fromContainer !== "") {
      env[key] = fromContainer;
    }
  }
  return env;
}

// Build the environment for spawned OpenClaw processes (gateway, doctor,
// onboard). The persisted .env provides most values — wizard output and the
// inference keys the Hub delivers only over HTTP — but Hub-authoritative keys
// are taken from the live container env so a stale persisted copy can't shadow
// them.
function buildChildEnv() {
  return applyHubAuthoritativeEnv({ ...process.env, ...readEnv() });
}

function writeEnv(env) {
  const lines = ["# OpenClaw Configuration", "# Generated by setup wizard", ""];
  for (const [key, value] of Object.entries(env)) {
    if (value) {
      lines.push(`${key}=${value}`);
    }
  }
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
}

// When we last wrote openclaw.json. warnIfConfigClobbered uses this as the cutoff
// so it catches a quarantine by ANY openclaw invocation after our write, not just
// one that happens inside the doctor call.
let configWrittenAtMs = 0;
// Quarantines already reported. startOpenclaw re-runs on every gateway exit, and a
// reconcile that changes nothing leaves configWrittenAtMs at the previous write, so
// without this the same historical snapshot is re-reported on every restart.
const reportedClobbers = new Set();

function writeConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
  configWrittenAtMs = Date.now();
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const workspaceDir = path.join(CONFIG_DIR, "workspace");
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }
}

function ensureShellCompletionBypass() {
  const completionDir = path.join(CONFIG_DIR, "completions");
  const completionPath = path.join(completionDir, "openclaw.bash");
  const bashrcPath = path.join(process.env.HOME, ".bashrc");

  fs.mkdirSync(completionDir, { recursive: true });
  if (!fs.existsSync(completionPath)) {
    fs.writeFileSync(
      completionPath,
      "# OpenClaw tab-completion disabled in CI marketplace.\n",
    );
  }

  let bashrc = "";
  try {
    bashrc = fs.readFileSync(bashrcPath, "utf8");
  } catch {}

  if (!bashrc.includes("# OpenClaw Completion")) {
    // OpenClaw QuickStart auto-generates shell tab-completion when it looks
    // unconfigured. That is not useful in the CI app browser terminal and can
    // take ~30s. The marker plus placeholder cache makes OpenClaw skip that
    // setup step without sourcing or executing anything on shell startup.
    const prefix = bashrc && !bashrc.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(bashrcPath, `${prefix}\n# OpenClaw Completion\n`);
  }
}

// Check if a directory is empty
async function isDirEmpty(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath);
    return entries.length === 0;
  } catch {
    return true; // If we can't read it, treat as empty
  }
}

// Copy files from /home-skeleton to $HOME if they don't exist or are empty
async function initializeHome() {
  const homeDir = process.env.HOME;

  try {
    const entries = await fsp.readdir(SKELETON_DIR, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(SKELETON_DIR, entry.name);
      const destPath = path.join(homeDir, entry.name);

      try {
        await fsp.access(destPath);
        // Exists - check if it's an empty directory
        if (entry.isDirectory() && (await isDirEmpty(destPath))) {
          console.log(
            `${entry.name} exists but is empty, copying contents inside...`,
          );
          await execAsync(`cp -r "${srcPath}/." "${destPath}/"`);
        } else {
          console.log(`Skipping ${entry.name} (already exists)`);
        }
      } catch {
        // Doesn't exist, copy it
        console.log(`Copying ${entry.name} to home...`);
        if (entry.isDirectory()) {
          await execAsync(`cp -r "${srcPath}" "${destPath}"`);
        } else {
          await fsp.copyFile(srcPath, destPath);
        }
      }
    }
    console.log("Home directory initialized");
  } catch (err) {
    console.error("Error initializing home:", err.message);
  }
}

// Config corruption recovery:
// - Mid-run: the gateway keeps its in-memory config and stays up — no action needed.
// - On restart: the gateway tries to boot from the corrupt file and refuses to start.
//   We have two layers of defense:
//   1. readConfig() restores from OpenClaw's native .bak file (covers parse failures).
//   2. runDoctor() runs `openclaw doctor --repair` before gateway start (catches
//      migration issues or structural problems that valid JSON + .bak can't fix).
// - If both .json and .bak are gone/corrupt, readConfig() returns null. isConfigured()
//   falls through to checking .env for API keys. API keys live in a separate file
//   (auth-profiles.json), not in openclaw.json, so they survive config corruption.
//   If auth-profiles.json itself corrupts, the user would need to re-onboard — we
//   intentionally don't cover that edge case to avoid coupling to OpenClaw internals.
function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Config file corrupted, attempting restore from backup...");
    const backupFile = CONFIG_FILE + ".bak";
    try {
      if (fs.existsSync(backupFile)) {
        fs.copyFileSync(backupFile, CONFIG_FILE);
        console.log("Restored config from backup");
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      }
    } catch (e2) {
      console.error("Backup restore also failed:", e2.message);
    }
  }
  return null;
}

// A config node we can safely read keys from and spread. Arrays and scalars are
// not usable as config records: spreading a string yields index-keyed junk, and
// assigning a property to a scalar silently no-ops in sloppy mode.
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Walk to a nested config record, replacing any node that is not a usable record
// along the way, and return the leaf. Record counterpart to ensureArrayPath.
function ensureRecordPath(root, keys) {
  let current = root;
  for (const key of keys) {
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key];
  }
  return current;
}

function ensureArrayPath(root, keys) {
  let current = root;
  for (const key of keys.slice(0, -1)) {
    if (
      !current[key] ||
      typeof current[key] !== "object" ||
      Array.isArray(current[key])
    ) {
      current[key] = {};
    }
    current = current[key];
  }

  const leaf = keys[keys.length - 1];
  if (!Array.isArray(current[leaf])) {
    current[leaf] = [];
  }
  return current[leaf];
}

function removeArrayItem(items, item) {
  let changed = false;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i] === item) {
      items.splice(i, 1);
      changed = true;
    }
  }
  return changed;
}

function hasCiServerCredentials(env) {
  return !!(
    env.CI_SERVER_URL &&
    env.CI_SERVER_TOKEN &&
    env.CI_SERVER_ENABLED !== "false"
  );
}

function hasHubMcpCredentials(env) {
  return !!(
    (env.HUB_URL || env.HUB_MCP_URL) &&
    env.HUB_MCP_API_KEY &&
    env.HUB_MCP_ENABLED !== "false"
  );
}

// Canonical Streamable HTTP MCP endpoint for the Hub. CI-Hub serves MCP at a
// single `/api/mcp` endpoint (the legacy `/api/mcp/sse` route was removed).
// Prefer HUB_MCP_URL; fall back to HUB_URL + `/api/mcp`. A legacy `/api/mcp/sse`
// suffix is normalized down to `/api/mcp` (never appended) so an already-correct
// injected URL is not corrupted. Returns "" when no base URL is available.
function canonicalHubMcpUrl(env) {
  let raw = (env.HUB_MCP_URL || "").trim();
  if (!raw) {
    const base = (env.HUB_URL || "").trim().replace(/\/+$/, "");
    raw = base ? `${base}/api/mcp` : "";
  }
  raw = raw.replace(/\/+$/, "");
  if (raw.endsWith("/api/mcp/sse")) {
    raw = raw.slice(0, -"/sse".length);
  }
  if (!raw) return "";
  return raw.endsWith("/api/mcp") ? raw : `${raw}/api/mcp`;
}

// Register (or remove) the Hub as a native OpenClaw MCP server under
// `mcp.servers.ci-hub`, so Hub tools load through OpenClaw's built-in Streamable
// HTTP MCP client rather than the plugin's legacy hand-rolled client.
//
// The Bearer token is written as the literal env-template `${HUB_MCP_API_KEY}`,
// which OpenClaw resolves at gateway activation — the raw key is never persisted
// to openclaw.json (matching the plugin's original env-only credential design).
// When Hub MCP creds are absent/disabled, an existing `ci-hub` server entry is
// removed so the agent doesn't keep a dead endpoint. Returns true if it changed.
function ensureHubMcpServer(config, env) {
  const enabled = hasHubMcpCredentials(env);
  const url = enabled ? canonicalHubMcpUrl(env) : "";

  if (!enabled || !url) {
    // Remove any previously-written entry when creds are gone/disabled.
    const existing = config.mcp && config.mcp.servers && config.mcp.servers["ci-hub"];
    if (existing) {
      delete config.mcp.servers["ci-hub"];
      console.log("Patched config: removed ci-hub MCP server (Hub MCP disabled or credentials absent)");
      return true;
    }
    return false;
  }

  if (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp)) {
    config.mcp = {};
  }
  if (!config.mcp.servers || typeof config.mcp.servers !== "object" || Array.isArray(config.mcp.servers)) {
    config.mcp.servers = {};
  }

  const desired = {
    url,
    transport: "streamable-http",
    headers: { Authorization: "Bearer ${HUB_MCP_API_KEY}" },
    timeout: 180,
    connectTimeout: 60,
  };

  const current = config.mcp.servers["ci-hub"];
  // Deep-equal on the small, fixed shape keeps reconcile idempotent.
  if (JSON.stringify(current) === JSON.stringify(desired)) {
    return false;
  }
  config.mcp.servers["ci-hub"] = desired;
  console.log(`Patched config: registered ci-hub MCP server (Streamable HTTP, ${url})`);
  return true;
}

function disableBundledSessionMemoryHook(config) {
  let changed = false;
  if (
    !config.hooks ||
    typeof config.hooks !== "object" ||
    Array.isArray(config.hooks)
  ) {
    config.hooks = {};
    changed = true;
  }
  if (
    !config.hooks.internal ||
    typeof config.hooks.internal !== "object" ||
    Array.isArray(config.hooks.internal)
  ) {
    config.hooks.internal = {};
    changed = true;
  }
  if (
    !config.hooks.internal.entries ||
    typeof config.hooks.internal.entries !== "object" ||
    Array.isArray(config.hooks.internal.entries)
  ) {
    config.hooks.internal.entries = {};
    changed = true;
  }

  const entries = config.hooks.internal.entries;
  const entry =
    entries["session-memory"] &&
    typeof entries["session-memory"] === "object" &&
    !Array.isArray(entries["session-memory"])
      ? entries["session-memory"]
      : {};
  if (entry.enabled !== false) {
    entry.enabled = false;
    entries["session-memory"] = entry;
    changed = true;
    console.log(
      "Patched config: disabled bundled session-memory hook for CI memory",
    );
  }
  return changed;
}

function ensureMemoryConversationAccess(config) {
  // The CI memory plugin's agent_end turn-sync is a conversation hook; a
  // path-loaded (non-bundled) plugin only receives it when its entry opts in
  // via hooks.allowConversationAccess.
  let changed = false;
  if (
    !config.plugins.entries ||
    typeof config.plugins.entries !== "object" ||
    Array.isArray(config.plugins.entries)
  ) {
    config.plugins.entries = {};
    changed = true;
  }
  const existingEntry = config.plugins.entries[CI_MEMORY_PLUGIN_ID];
  const entry =
    existingEntry && typeof existingEntry === "object" && !Array.isArray(existingEntry)
      ? existingEntry
      : {};
  const hooks =
    entry.hooks && typeof entry.hooks === "object" && !Array.isArray(entry.hooks)
      ? entry.hooks
      : {};
  if (hooks.allowConversationAccess !== true) {
    hooks.allowConversationAccess = true;
    entry.hooks = hooks;
    config.plugins.entries[CI_MEMORY_PLUGIN_ID] = entry;
    changed = true;
    console.log(
      "Patched config: enabled conversation access for CI memory turn-sync",
    );
  }
  return changed;
}

function ensureMemoryStoreToolAllowed(config) {
  let changed = false;
  if (
    !config.tools ||
    typeof config.tools !== "object" ||
    Array.isArray(config.tools)
  ) {
    config.tools = {};
    changed = true;
  }
  if (!Array.isArray(config.tools.alsoAllow)) {
    config.tools.alsoAllow = [];
    changed = true;
  }
  if (!config.tools.alsoAllow.includes("memory_store")) {
    config.tools.alsoAllow.push("memory_store");
    changed = true;
    console.log("Patched config: allowed Companion Intelligence memory_store tool");
  }
  if (
    Array.isArray(config.tools.allow) &&
    !config.tools.allow.includes("memory_store")
  ) {
    config.tools.allow.push("memory_store");
    changed = true;
    console.log("Patched config: added memory_store to explicit tool allowlist");
  }
  return changed;
}

// The Hub injects EMBEDDINGS_MODEL (e.g. nomic-embed-text) as a managed key, but
// OpenClaw has no env-var path for embeddings — memory search resolves its provider
// from agents.defaults.memorySearch. Left unset, the provider falls back to its
// "openai" default and semantic recall silently tries api.openai.com with a key we
// don't have (memory_search then reports provider=openai model=text-embedding-3-small
// while quietly returning nothing). "openai-compatible" points it at the appliance's
// own Ollama /v1 instead, and needs no API key.
// Trailing slashes are not meaningful in an embeddings base URL — OpenClaw strips
// them itself (normalizeBaseUrl) — so compare URLs with them removed. Without this,
// a config that merely spells the SAME endpoint with a trailing slash looks like a
// different one, and the repoint check below would delete an operator's credential.
function normalizeEmbeddingsBaseUrl(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function ensureMemorySearchEmbeddings(config, env) {
  const model = (env.EMBEDDINGS_MODEL || process.env.EMBEDDINGS_MODEL || "").trim();
  if (!model) return false;

  // resolveOllamaBaseUrl yields a native Ollama host (no /v1); tolerate an
  // OLLAMA_HOST that already carries the suffix rather than emitting /v1/v1.
  const ollamaBase = normalizeEmbeddingsBaseUrl(resolveOllamaBaseUrl(env));
  const baseUrl = ollamaBase.endsWith("/v1") ? ollamaBase : `${ollamaBase}/v1`;

  // Guard every node we spread or assign into: a hand-edited memorySearch that is
  // a scalar or array would otherwise spread into index-keyed junk, producing the
  // very kind of schema-invalid config that gets the whole file clobbered.
  const defaults = ensureRecordPath(config, ["agents", "defaults"]);
  const current = isPlainObject(defaults.memorySearch) ? defaults.memorySearch : {};
  const currentRemote = isPlainObject(current.remote) ? current.remote : {};

  // Are we moving embeddings to a different provider or endpoint than the config
  // currently names? If so, any apiKey already in the remote block was issued for
  // the OLD endpoint — remote.apiKey is OpenClaw's canonical secret target — and
  // carrying it across would send a credential to a host it was never issued for.
  // Drop it. A key the operator set for the endpoint we already point at is theirs
  // and is left untouched.
  const repointing =
    current.provider !== MEMORY_EMBEDDING_PROVIDER ||
    normalizeEmbeddingsBaseUrl(currentRemote.baseUrl) !== baseUrl;
  const nextRemote = { ...currentRemote, baseUrl };
  const droppedApiKey = repointing && "apiKey" in nextRemote;
  if (droppedApiKey) delete nextRemote.apiKey;

  const next = {
    ...current,
    provider: MEMORY_EMBEDDING_PROVIDER,
    model,
    remote: nextRemote,
  };
  if (JSON.stringify(defaults.memorySearch) === JSON.stringify(next)) return false;

  defaults.memorySearch = next;
  console.log(
    `Patched config: memory search embeddings -> ${model} @ ${baseUrl}`,
  );
  if (droppedApiKey) {
    // Never log the value, only that it is gone.
    console.log(
      "Patched config: dropped memory search remote.apiKey — it belonged to the previous embeddings endpoint",
    );
  }
  return true;
}

function ensureOpenClawPlugin(config, pluginId, pluginPath, label, options = {}) {
  const enableEntry = options.enableEntry !== false;

  if (!fs.existsSync(pluginPath)) {
    console.warn(
      `CI context: ${pluginPath} not found; plugin config will be reconciled on next startup`,
    );
    return false;
  }

  let changed = false;
  if (
    !config.plugins ||
    typeof config.plugins !== "object" ||
    Array.isArray(config.plugins)
  ) {
    config.plugins = {};
  }
  if (config.plugins.enabled !== true) {
    config.plugins.enabled = true;
    changed = true;
    console.log("Patched config: enabled plugins");
  }

  const pluginPaths = ensureArrayPath(config, ["plugins", "load", "paths"]);
  if (!pluginPaths.includes(pluginPath)) {
    pluginPaths.push(pluginPath);
    changed = true;
    console.log(`Patched config: added ${label} plugin path`);
  }

  if (enableEntry) {
    if (
      Array.isArray(config.plugins.deny) &&
      removeArrayItem(config.plugins.deny, pluginId)
    ) {
      changed = true;
      console.log(`Patched config: removed ${label} plugin from deny list`);
    }

    const allowedPlugins = config.plugins.allow;
    if (
      Array.isArray(allowedPlugins) &&
      allowedPlugins.length > 0 &&
      !allowedPlugins.includes(pluginId)
    ) {
      allowedPlugins.push(pluginId);
      changed = true;
      console.log(`Patched config: added ${label} plugin to allow list`);
    }
  }

  if (
    !config.plugins.entries ||
    typeof config.plugins.entries !== "object" ||
    Array.isArray(config.plugins.entries)
  ) {
    config.plugins.entries = {};
  }
  const entry = config.plugins.entries[pluginId] || {};
  const nextEnabled = enableEntry;
  if (entry.enabled !== nextEnabled) {
    entry.enabled = nextEnabled;
    config.plugins.entries[pluginId] = entry;
    changed = true;
    console.log(
      `Patched config: ${nextEnabled ? "enabled" : "disabled"} ${label} plugin`,
    );
  }

  return changed;
}

function resolveOllamaBaseUrl(env) {
  const directHost = (env.OLLAMA_HOST || process.env.OLLAMA_HOST || "").replace(
    /\/$/,
    "",
  );
  if (directHost) return directHost;

  const openAiBase = (
    env.OPENAI_API_BASE ||
    process.env.OPENAI_API_BASE ||
    ""
  ).replace(/\/$/, "");
  if (openAiBase.endsWith("/v1")) {
    return openAiBase.slice(0, -3);
  }

  return "http://host.docker.internal:11434";
}

function resolveInferenceApiKey(env) {
  return (
    env.OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    env.OLLAMA_API_KEY ||
    process.env.OLLAMA_API_KEY ||
    "ollama"
  );
}

function isEmbeddingModel(modelId) {
  return /embed/i.test(modelId || "");
}

async function fetchJson(url, init) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function fetchOllamaModelCapabilities(ollamaBaseUrl, modelId) {
  const payload = await fetchJson(`${ollamaBaseUrl}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelId }),
  });
  const caps = Array.isArray(payload?.capabilities) ? payload.capabilities : [];
  // model_info exposes the model's trained context as "<arch>.context_length".
  const info = payload?.model_info && typeof payload.model_info === "object" ? payload.model_info : {};
  const ctxEntry = Object.entries(info).find(([k]) => k.endsWith(".context_length"));
  // model_info may serialize the value as a number or a numeric string — coerce.
  const ctxNum = ctxEntry ? Number(ctxEntry[1]) : Number.NaN;
  const contextLimit = Number.isFinite(ctxNum) && ctxNum > 0 ? ctxNum : undefined;
  return {
    supportsTools: caps.includes("tools"),
    reasoning: caps.includes("thinking"),
    vision: caps.includes("vision"),
    contextLimit,
  };
}

// Hardware-aware context window injected by the Hub (CI_LLM_NUM_CTX). Caps both
// the agent's token budget and the native Ollama num_ctx so OpenClaw doesn't pack
// to Ollama's oversized memory-based default (e.g. 262144 on unified-memory APUs).
// Memoized: the value only changes on container restart, and buildOllamaModelEntry
// is called once per discovered model.
let _hubNumCtx;
function resolveHubNumCtx() {
  if (_hubNumCtx !== undefined) return _hubNumCtx;
  const raw = process.env.CI_LLM_NUM_CTX || readEnv().CI_LLM_NUM_CTX || "";
  const n = Number.parseInt(raw, 10);
  _hubNumCtx = Number.isFinite(n) && n > 0 ? n : null;
  return _hubNumCtx;
}

function buildOllamaModelEntry(modelId, displayName, capabilities) {
  const numCtx = resolveHubNumCtx() || undefined;
  // Never request more context than the model supports: numCtx is computed for
  // the Hub's default chat model and may exceed a smaller model's window. When
  // the per-model limit is unknown, stay conservative at the historical 32000
  // default rather than the possibly-larger numCtx.
  const effCtx = numCtx ? Math.min(numCtx, capabilities?.contextLimit ?? 32000) : undefined;
  // Without an explicit num_ctx, advertise the historical 32000 default but never
  // more than the model's known window (small-window models would be rejected).
  const contextWindow = effCtx ?? Math.min(32000, capabilities?.contextLimit ?? 32000);
  return {
    id: modelId,
    name: displayName || modelId,
    reasoning: capabilities?.reasoning === true,
    input: capabilities?.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    // Output budget can't exceed the total context window (keeps small-context
    // models internally consistent).
    maxTokens: Math.min(4096, contextWindow),
    compat: { supportsTools: capabilities?.supportsTools === true },
    // `params`, not `options`: OpenClaw's model-entry schema is strict, so an
    // unrecognized key fails validation for the ENTIRE openclaw.json. Startup
    // `doctor --repair` then quarantines the file and restores last-known-good,
    // silently reverting anything else written in the same pass — including the
    // memory-connect wiring (plugins.slots.memory, companionintelligence).
    ...(effCtx ? { params: { num_ctx: effCtx } } : {}),
  };
}

async function discoverOllamaModels(ollamaBaseUrl, defaultModel) {
  const tagsPayload = await fetchJson(`${ollamaBaseUrl}/api/tags`);
  const discovered = Array.isArray(tagsPayload?.models)
    ? tagsPayload.models.map((model) => ({ id: model?.name || model?.model || "" }))
    : [];
  const discoveredIds = new Set(
    discovered
      .map((model) => model?.id)
      .filter((id) => typeof id === "string" && id.length > 0),
  );

  const models = [];
  const seen = new Set();
  const addModel = async (id, name) => {
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      seen.has(id) ||
      isEmbeddingModel(id) ||
      !discoveredIds.has(id)
    ) {
      return false;
    }
    seen.add(id);
    const capabilities = await fetchOllamaModelCapabilities(ollamaBaseUrl, id);
    models.push(buildOllamaModelEntry(id, name || id, capabilities));
    return true;
  };

  for (const model of discovered) {
    await addModel(model?.id, model?.id);
  }

  const defaultModelAvailable =
    defaultModel && discoveredIds.has(defaultModel) ? defaultModel : null;
  const firstModelId = models.find((model) => model.id !== "auto")?.id ?? null;
  const autoTargetId = defaultModelAvailable || firstModelId;

  if (autoTargetId) {
    const autoCapabilities = await fetchOllamaModelCapabilities(
      ollamaBaseUrl,
      autoTargetId,
    );
    models.unshift(
      buildOllamaModelEntry(
        "auto",
        `Hub Auto (${autoTargetId})`,
        autoCapabilities,
      ),
    );
  }

  return { models, defaultModelAvailable, firstModelId };
}

function getGatewayToken() {
  const env = readEnv();
  if (env.OPENCLAW_GATEWAY_TOKEN) return env.OPENCLAW_GATEWAY_TOKEN;
  if (process.env.OPENCLAW_GATEWAY_TOKEN)
    return process.env.OPENCLAW_GATEWAY_TOKEN;
  const config = readConfig();
  if (
    config &&
    config.gateway &&
    config.gateway.auth &&
    config.gateway.auth.token
  ) {
    return config.gateway.auth.token;
  }
  return null;
}

function isConfigured() {
  // Check if the CLI onboard has been completed (writes wizard section to config)
  const config = readConfig();
  if (config && config.wizard) {
    return true;
  }

  const env = readEnv();
  return !!(
    env.ANTHROPIC_API_KEY ||
    env.OPENAI_API_KEY ||
    env.GEMINI_API_KEY ||
    env.MOONSHOT_API_KEY ||
    env.MINIMAX_API_KEY ||
    env.DASHSCOPE_API_KEY ||
    env.ZAI_API_KEY ||
    env.VENICE_API_KEY ||
    env.XAI_API_KEY ||
    env.GROQ_API_KEY ||
    env.CEREBRAS_API_KEY ||
    env.MISTRAL_API_KEY ||
    env.COPILOT_GITHUB_TOKEN ||
    env.OLLAMA_API_KEY ||
    env.OPENROUTER_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.MOONSHOT_API_KEY ||
    process.env.MINIMAX_API_KEY ||
    process.env.DASHSCOPE_API_KEY ||
    process.env.ZAI_API_KEY ||
    process.env.VENICE_API_KEY ||
    process.env.XAI_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.CEREBRAS_API_KEY ||
    process.env.MISTRAL_API_KEY ||
    process.env.COPILOT_GITHUB_TOKEN ||
    process.env.OLLAMA_API_KEY ||
    process.env.OPENROUTER_API_KEY
  );
}

async function reconcileConfig() {
  // A quarantine is not confined to the doctor call — the gateway also rejects the
  // config it reads at spawn, and the fresh-onboarding path skips doctor entirely.
  // Report anything that appeared since our last write before reconciling again.
  // No-op on first boot, when we have not written anything to attribute it to.
  if (configWrittenAtMs) warnIfConfigClobbered(configWrittenAtMs);

  const config = readConfig();
  if (!config) return;
  const env = readEnv();

  // CI-Server credentials may be supplied as container environment variables
  // (the Hub injects them this way) rather than written into the .env file.
  // Mirror bootstrap-ci-memory.sh, which reads process.env, so the setup-server
  // reconcile activates CI memory consistently regardless of where creds live.
  // Same precedence as buildChildEnv(): the live container value wins over a
  // stale .env, so e.g. a Hub CI_SERVER_ENABLED="false" actually disables memory.
  applyHubAuthoritativeEnv(env);

  let changed = false;

  // Ensure allowInsecureAuth is set (needed for the CI app proxy)
  if (!config.gateway) config.gateway = {};
  if (!config.gateway.controlUi) config.gateway.controlUi = {};
  if (!config.gateway.controlUi.allowInsecureAuth) {
    config.gateway.controlUi.allowInsecureAuth = true;
    changed = true;
    console.log("Patched config: enabled allowInsecureAuth");
  }

  // Disable device auth (would break access in some CI proxy configurations)
  if (!config.gateway.controlUi.dangerouslyDisableDeviceAuth) {
    config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
    changed = true;
    console.log("Patched config: disabled device auth");
  }

  // The CI setup proxy rewrites Host/Origin to the local gateway origin.
  // Make sure that rewritten origin is explicitly trusted by the Control UI.
  if (!Array.isArray(config.gateway.controlUi.allowedOrigins)) {
    config.gateway.controlUi.allowedOrigins = [];
    changed = true;
  }
  const requiredOrigins = [
    `http://127.0.0.1:${OPENCLAW_PORT}`,
    `http://localhost:${OPENCLAW_PORT}`,
  ];
  for (const origin of requiredOrigins) {
    if (!config.gateway.controlUi.allowedOrigins.includes(origin)) {
      config.gateway.controlUi.allowedOrigins.push(origin);
      changed = true;
      console.log(`Patched config: added allowed origin ${origin}`);
    }
  }

  // Disable update checks (updates are managed by the CI marketplace via Docker image bumps)
  if (!config.update) config.update = {};
  if (config.update.checkOnStart !== false) {
    config.update.checkOnStart = false;
    changed = true;
    console.log("Patched config: disabled update check on start");
  }

  // Enable CI-managed context through OpenClaw's supported plugin surface.
  // The runtime plugin also ships a `ci` skill, so one load path covers both the
  // always-on runtime context and deeper on-demand guidance.
  changed =
    ensureOpenClawPlugin(config, CI_PLUGIN_ID, CI_PLUGIN_PATH, "CI runtime") ||
    changed;

  // Install the Companion Intelligence memory plugin as a selectable active
  // memory backend. Keep the entry disabled until selected so OpenClaw does not
  // load two active memory runtimes.
  const currentMemorySlot =
    config.plugins &&
    config.plugins.slots &&
    typeof config.plugins.slots === "object" &&
    !Array.isArray(config.plugins.slots)
      ? config.plugins.slots.memory
      : undefined;
  const shouldSelectCiMemory =
    (hasCiServerCredentials(env) || currentMemorySlot === CI_MEMORY_PLUGIN_ID) &&
    (currentMemorySlot === undefined ||
      currentMemorySlot === "" ||
      currentMemorySlot === "memory-core" ||
      currentMemorySlot === CI_MEMORY_PLUGIN_ID);
  changed =
    ensureOpenClawPlugin(
      config,
      CI_MEMORY_PLUGIN_ID,
      CI_MEMORY_PLUGIN_PATH,
      "Companion Intelligence memory",
      { enableEntry: shouldSelectCiMemory },
    ) || changed;
  if (fs.existsSync(CI_MEMORY_PLUGIN_PATH)) {
    if (shouldSelectCiMemory) {
      if (
        !config.plugins.slots ||
        typeof config.plugins.slots !== "object" ||
        Array.isArray(config.plugins.slots)
      ) {
        config.plugins.slots = {};
      }
      if (config.plugins.slots.memory !== CI_MEMORY_PLUGIN_ID) {
        config.plugins.slots.memory = CI_MEMORY_PLUGIN_ID;
        changed = true;
        console.log(
          "Patched config: selected Companion Intelligence memory plugin",
        );
      }
      changed = disableBundledSessionMemoryHook(config) || changed;
      changed = ensureMemoryConversationAccess(config) || changed;
      changed = ensureMemoryStoreToolAllowed(config) || changed;
    }
  }

  // Point semantic memory search at the appliance's local embeddings server.
  changed = ensureMemorySearchEmbeddings(config, env) || changed;

  // Register Hub tools through OpenClaw's built-in MCP client (native
  // mcp.servers.ci-hub), gated on Hub MCP credentials.
  changed = ensureHubMcpServer(config, env) || changed;

  // Enable the CI-Hub companion plugin (wake endpoint, app-event SSE, inference
  // auto-config) when Hub injects MCP credentials. Tool access itself comes from
  // the native mcp.servers.ci-hub entry above, not this plugin.
  changed =
    ensureOpenClawPlugin(
      config,
      CI_HUB_PLUGIN_ID,
      CI_HUB_PLUGIN_PATH,
      "CI Hub MCP",
      { enableEntry: hasHubMcpCredentials(env) },
    ) || changed;

  // Ensure a gateway auth token exists — the onboard CLI does not generate one,
  // so without this the Control UI WebSocket fails with "token_missing".
  if (!config.gateway.auth) config.gateway.auth = {};
  if (!config.gateway.auth.token) {
    config.gateway.auth.token = crypto.randomBytes(24).toString("hex");
    changed = true;
    console.log("Patched config: generated gateway auth token");
  }

  // Required since openclaw 2026.3.7 when auth is configured.
  // Always forced to "token" — the proxy only speaks Bearer token auth.
  if (config.gateway.auth.mode !== "token") {
    config.gateway.auth.mode = "token";
    changed = true;
    console.log("Patched config: set gateway auth mode to token");
  }

  // Required since a newer openclaw release: gateway refuses to start if
  // gateway.mode is absent (exit code 78). Force "local" which is the correct
  // mode for a CI-marketplace-managed container.
  if (config.gateway.mode !== "local") {
    config.gateway.mode = "local";
    changed = true;
    console.log("Patched config: set gateway.mode to local");
  }

  // Mirror the Hub-managed Ollama defaults into OpenClaw's current config shape.
  // The newer gateway does not switch providers just because OPENAI_API_* is present;
  // it needs a concrete provider entry plus an agent default model selection.
  const ollamaBaseUrl = resolveOllamaBaseUrl(env);
  const inferenceApiKey = resolveInferenceApiKey(env);
  const defaultModel = env.DEFAULT_MODEL || process.env.DEFAULT_MODEL || "";

  if (
    !config.models ||
    typeof config.models !== "object" ||
    Array.isArray(config.models)
  ) {
    config.models = {};
    changed = true;
  }
  if (config.models.mode !== "merge") {
    config.models.mode = "merge";
    changed = true;
    console.log("Patched config: set model catalog mode to merge");
  }
  if (
    !config.models.providers ||
    typeof config.models.providers !== "object" ||
    Array.isArray(config.models.providers)
  ) {
    config.models.providers = {};
    changed = true;
  }

  const currentHubProvider = config.models.providers["ci-hub"] || {};
  const nextHubProvider = {
    ...currentHubProvider,
    baseUrl: ollamaBaseUrl,
    apiKey: inferenceApiKey,
    api: "ollama",
    models: Array.isArray(currentHubProvider.models)
      ? currentHubProvider.models
      : [],
  };
  if (
    currentHubProvider.baseUrl !== nextHubProvider.baseUrl ||
    currentHubProvider.apiKey !== nextHubProvider.apiKey ||
    currentHubProvider.api !== nextHubProvider.api ||
    !Array.isArray(currentHubProvider.models)
  ) {
    config.models.providers["ci-hub"] = nextHubProvider;
    changed = true;
    console.log(
      `Patched config: synced ci-hub Ollama provider (${ollamaBaseUrl})`,
    );
  }

  try {
    const {
      models: discoveredModels,
      defaultModelAvailable,
      firstModelId,
    } = await discoverOllamaModels(ollamaBaseUrl, defaultModel);

    if (discoveredModels.length > 0) {
      if (
        JSON.stringify(currentHubProvider.models || []) !==
        JSON.stringify(discoveredModels)
      ) {
        config.models.providers["ci-hub"] = {
          ...nextHubProvider,
          models: discoveredModels,
        };
        changed = true;
        console.log(
          `Patched config: synced ${discoveredModels.length} ci-hub Ollama model(s)`,
        );
      }

      config.agents = config.agents || {};
      config.agents.defaults = config.agents.defaults || {};
      const existingModels = config.agents.defaults.models || {};
      const mergedModels = Object.fromEntries(
        Object.entries(existingModels).filter(
          ([key]) => !key.startsWith("ci-hub/"),
        ),
      );
      for (const model of discoveredModels) {
        const key = `ci-hub/${model.id}`;
        mergedModels[key] = existingModels[key] || {};
      }
      if (
        JSON.stringify(config.agents.defaults.models || {}) !==
        JSON.stringify(mergedModels)
      ) {
        config.agents.defaults.models = mergedModels;
        changed = true;
        console.log("Patched config: merged ci-hub model options");
      }

      const existingPrimary = config.agents.defaults.model?.primary;
      let primaryId = null;
      if (
        typeof existingPrimary === "string" &&
        existingPrimary.startsWith("ci-hub/")
      ) {
        const currentId = existingPrimary.slice("ci-hub/".length);
        if (discoveredModels.some((model) => model.id === currentId)) {
          primaryId = currentId;
        }
      }
      if (!primaryId) {
        primaryId = defaultModelAvailable || firstModelId;
      }
      if (primaryId) {
        config.agents.defaults.model = config.agents.defaults.model || {};
        const nextPrimaryModel = `ci-hub/${primaryId}`;
        if (config.agents.defaults.model.primary !== nextPrimaryModel) {
          config.agents.defaults.model.primary = nextPrimaryModel;
          changed = true;
          console.log(
            `Patched config: set default agent model to ${nextPrimaryModel}`,
          );
        }
      }
    } else {
      console.warn(
        `No Ollama chat models discovered at ${ollamaBaseUrl}; preserving existing ci-hub model catalog`,
      );
    }
  } catch (error) {
    console.warn(
      `Failed to sync ci-hub Ollama model catalog: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (defaultModel && !config.agents?.defaults?.model?.primary) {
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.agents.defaults.model = config.agents.defaults.model || {};
    const nextPrimaryModel = `ci-hub/${defaultModel}`;
    if (config.agents.defaults.model.primary !== nextPrimaryModel) {
      config.agents.defaults.model.primary = nextPrimaryModel;
      changed = true;
      console.log(`Patched config: set default agent model to ${nextPrimaryModel}`);
    }
  }

  if (changed) {
    writeConfig(config);
  }

  // Sync gateway token to .env so the proxy always has it
  const token = config.gateway.auth.token;
  if (env.OPENCLAW_GATEWAY_TOKEN !== token) {
    env.OPENCLAW_GATEWAY_TOKEN = token;
    writeEnv(env);
    console.log("Synced gateway token to .env");
  }
}

// OpenClaw silently quarantines an openclaw.json it considers invalid as
// <name>.clobbered.<ts> and restores last-known-good — reverting, with no error on
// any channel, everything reconcileConfig just wrote (model catalog, memory wiring,
// gateway token). A single unrecognized key is enough to trigger it, so surface the
// quarantine instead of letting the app come up silently misconfigured.
function warnIfConfigClobbered(since) {
  let clobbered;
  try {
    clobbered = fs
      .readdirSync(CONFIG_DIR)
      .filter((name) => name.startsWith("openclaw.json.clobbered."))
      // OpenClaw rotates (unlinks) old snapshots once its cap is reached, so a name
      // can vanish between readdir and stat. Drop those rather than let one ENOENT
      // suppress the whole warning — the cap is hit precisely when clobbering is
      // most frequent, which is exactly when we must not go quiet.
      .filter((name) => !reportedClobbers.has(name))
      .filter((name) => {
        try {
          return fs.statSync(path.join(CONFIG_DIR, name)).mtimeMs >= since;
        } catch {
          return false;
        }
      });
  } catch {
    return; // Detection is best-effort; never let it break startup.
  }
  if (clobbered.length === 0) return;
  for (const name of clobbered) reportedClobbers.add(name);
  console.error(
    `openclaw rejected openclaw.json and restored last-known-good: ${clobbered.join(", ")}. ` +
      "The config we last wrote (model catalog, memory wiring) has been reverted — " +
      "inspect the quarantined file for an unrecognized key.",
  );
}

// Run before gateway start to catch migration issues or config problems that
// readConfig()'s backup restore couldn't fix (e.g. schema changes across versions).
async function runDoctor() {
  // Anchor to our last config write when there is one: a quarantine can happen in
  // any openclaw invocation that reads the file, not only inside this doctor call.
  const since = configWrittenAtMs || Date.now();
  try {
    await execAsync("openclaw doctor --repair --yes --non-interactive", {
      env: buildChildEnv(),
    });
    console.log("openclaw doctor completed");
  } catch (e) {
    console.error("openclaw doctor failed:", e.message);
  }
  warnIfConfigClobbered(since);
}

function startOpenclaw({ repair = true } = {}) {
  // Guard against re-entry: runDoctor() is async, so without this flag every
  // incoming request would see openclawProcess === null and spawn another doctor run.
  if (openclawProcess || openclawStarting) {
    return;
  }

  openclawStarting = true;
  const spawnGateway = () => {
    openclawStarting = false;
    console.log("Starting OpenClaw gateway...");
    openclawProcess = spawn(
      "openclaw",
      ["gateway", "--port", OPENCLAW_PORT.toString()],
      {
        stdio: "inherit",
        env: buildChildEnv(),
      },
    );

    openclawProcess.on("exit", (code) => {
      console.log(`OpenClaw exited with code ${code}`);
      openclawProcess = null;
    });
  };

  const startAfterReconcile = () =>
    Promise.resolve(reconcileConfig()).catch((error) => {
      console.error(
        "Failed to reconcile OpenClaw config:",
        error instanceof Error ? error.message : String(error),
      );
    });

  if (!repair) {
    // Fresh onboarding just wrote this config, so avoid a full repair/migration
    // pass before the first gateway start. We still run doctor on normal
    // already-configured container starts where upgrade or stale-state repairs
    // are plausible.
    console.log("Skipping openclaw doctor after fresh onboarding");
    startAfterReconcile().finally(spawnGateway);
    return;
  }

  // .finally() ensures the gateway starts even if doctor fails or rejects —
  // a degraded gateway is better than no gateway.
  console.log("Running openclaw doctor before gateway start...");
  startAfterReconcile()
    .finally(() => runDoctor().finally(spawnGateway));
}

// Read static files at startup
const SETUP_HTML = fs.readFileSync(path.join(__dirname, "setup.html"), "utf8");
const LOGO = fs.readFileSync(path.join(__dirname, "logo.webp"));
// Companion Memory logo, shown next to the app logo on the connect interstitial
// (served at MEMORY_LOGO_PATH). Read once, guarded: a missing asset degrades the
// interstitial to just the app logo rather than crashing the wrapper on boot.
let MEMORY_LOGO = null;
try {
  MEMORY_LOGO = fs.readFileSync(path.join(__dirname, "assets", "ci-memory-logo.webp"));
} catch (err) {
  console.warn(`[ci-memory] ci-memory-logo.webp missing, interstitial will omit it: ${err.message}`);
}
// Loading page shown while the gateway is starting up. Keep the refresh in JS:
// Chrome skips meta-refresh when the URL contains a hash fragment, and our
// token redirect lands at /?token=...#token=....
const LOADING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#0D0D0D">
<meta name="color-scheme" content="dark">
<title>Starting OpenClaw...</title>
<style>
html,body{margin:0;min-height:100%;background:#0D0D0D;color:#F0EDE8}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:max(24px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));overflow:hidden}
.shell{width:min(100%,420px)}
.card{background:linear-gradient(180deg,rgba(31,31,31,.96),rgba(20,20,20,.98));border:1px solid #2A2A2A;border-radius:20px;padding:24px 20px;box-shadow:0 20px 50px rgba(0,0,0,.45),0 0 0 1px rgba(255,90,45,.06);text-align:center}
.logo{width:72px;height:72px;display:block;margin:0 auto 18px;object-fit:contain}
h1{margin:0 0 10px;font-size:clamp(24px,5vw,30px);line-height:1.15}
p{margin:0;color:#A89F99;font-size:15px;line-height:1.6}
.status{margin-top:20px;display:inline-flex;align-items:center;gap:10px;padding:10px 14px;border-radius:999px;background:#141414;border:1px solid #2A2A2A;color:#D4D0CB;font-size:14px}
.spinner{width:16px;height:16px;border:2px solid rgba(240,237,232,.18);border-top-color:#FF5A2D;border-radius:999px;animation:spin .85s linear infinite}
.progress{margin-top:18px;height:6px;border-radius:999px;background:#141414;overflow:hidden;border:1px solid #252525}
.progress::before{content:"";display:block;width:42%;height:100%;border-radius:999px;background:linear-gradient(90deg,#FF5A2D,#FF8A65);animation:slide 1.4s ease-in-out infinite}
.hint{margin-top:14px;font-size:12px;color:#6B6460}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes slide{0%{transform:translateX(-120%)}60%{transform:translateX(170%)}100%{transform:translateX(170%)}}
@media (max-width:480px){.card{padding:22px 16px;border-radius:18px}.logo{width:64px;height:64px;margin-bottom:16px}p{font-size:14px}.status{width:100%;justify-content:center;box-sizing:border-box}}
</style>
</head>
<body>
<div class="shell">
<div class="card">
<img class="logo" src="/logo.webp" alt="OpenClaw">
<h1>Starting OpenClaw</h1>
<p>Please wait while the gateway finishes booting. You’ll be redirected automatically as soon as it’s ready.</p>
<div class="status"><span class="spinner"></span><span>Checking availability…</span></div>
<div class="progress"></div>
<div class="hint">This usually only takes a moment.</div>
</div>
</div>
<script>setTimeout(function(){location.reload()},2500)</script>
</body>
</html>`;

function proxyToOpenclaw(req, res) {
  const token = getGatewayToken();

  // Redirect root to a tokenized URL so the Control UI can authenticate.
  // The token goes in two places:
  //   ?token=… — prevents a redirect loop (server checks searchParams)
  //   #token=… — delivers the token to the Control UI JS, which reads auth
  //              exclusively from the hash fragment, not query params
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (
    token &&
    url.pathname === "/" &&
    url.searchParams.get("token") !== token
  ) {
    // If setup generated or repaired a token while the browser still has an
    // older dashboard URL, force the URL hash back in sync. The Control UI reads
    // auth from the hash, so a stale token there causes WebSocket auth failures
    // even though the proxy injects the current Bearer token.
    const encodedToken = encodeURIComponent(token);
    res.writeHead(302, {
      Location: `/?token=${encodedToken}#token=${encodedToken}`,
    });
    res.end();
    return;
  }

  // Rewrite headers so the gateway sees requests as local.
  // The gateway checks Origin/Host to block cross-origin requests (anti-CSRF),
  // but that's redundant here — our proxy is the only thing that can reach the
  // gateway (it binds to 127.0.0.1 inside the container), and on the CI marketplace the
  // entire app is already behind the CI app proxy.
  // We also strip forwarding headers (X-Forwarded-For, etc.) that the CI app proxy
  // reverse proxy injects — if the gateway sees these from a source not in
  // gateway.trustedProxies it treats the connection as non-local and rejects it.
  const gatewayHost = `127.0.0.1:${OPENCLAW_PORT}`;
  const headers = { ...req.headers };
  headers["host"] = gatewayHost;
  headers["origin"] = `http://${gatewayHost}`;
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-proto"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-port"];
  delete headers["x-real-ip"];
  delete headers["forwarded"];
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const options = {
    hostname: "127.0.0.1",
    port: OPENCLAW_PORT,
    path: req.url,
    method: req.method,
    headers: headers,
  };

  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxy.on("error", () => {
    // OpenClaw not ready yet, show loading page
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
    });
    res.end(LOADING_HTML);
  });

  req.pipe(proxy);
}

// Handle WebSocket upgrade requests
function handleUpgrade(req, socket, head) {
  const token = getGatewayToken();

  // Connect to OpenClaw gateway
  const proxySocket = net.connect(OPENCLAW_PORT, "127.0.0.1", () => {
    // Rebuild the upgrade request with auth header
    let requestLine = `${req.method} ${req.url} HTTP/1.1\r\n`;

    // Rewrite headers to appear local (same rationale as HTTP proxy above)
    const gatewayHost = `127.0.0.1:${OPENCLAW_PORT}`;
    const headers = { ...req.headers };
    headers["host"] = gatewayHost;
    headers["origin"] = `http://${gatewayHost}`;
    delete headers["x-forwarded-for"];
    delete headers["x-forwarded-proto"];
    delete headers["x-forwarded-host"];
    delete headers["x-forwarded-port"];
    delete headers["x-real-ip"];
    delete headers["forwarded"];
    if (token) {
      headers["authorization"] = `Bearer ${token}`;
    }

    let headerLines = "";
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        value.forEach((v) => (headerLines += `${key}: ${v}\r\n`));
      } else {
        headerLines += `${key}: ${value}\r\n`;
      }
    }

    // Send the upgrade request to OpenClaw
    proxySocket.write(requestLine + headerLines + "\r\n");
    if (head && head.length) {
      proxySocket.write(head);
    }

    // Pipe data between client and OpenClaw
    socket.pipe(proxySocket);
    proxySocket.pipe(socket);
  });

  proxySocket.on("error", (err) => {
    console.error("WebSocket proxy error:", err.message);
    socket.end();
  });

  socket.on("error", (err) => {
    console.error("Client socket error:", err.message);
    proxySocket.end();
  });

  socket.on("close", () => {
    proxySocket.end();
  });

  proxySocket.on("close", () => {
    socket.end();
  });
}

// ── Companion Memory connect interstitial ───────────────────────────────────
// Shown before the app UI when memory is not yet connected, so the user can
// connect (or dismiss) rather than silently running without long-term memory.
// The Hub owns the OAuth-style flow; this wrapper only renders the gate and
// relays the "skip"/"defer" choices. Paths are namespaced under /__ci_memory/.
const MEMORY_DEFER_COOKIE = "ci_memory_deferred";
// Grace window (seconds) for the "Maybe later" (defer) choice. Long enough to
// carry the post-dismiss redirect, short enough that the next fresh launch/reload
// re-prompts. Deliberately NOT a session cookie — that survived tab-close +
// relaunch, making "defer" feel as permanent as "Don't ask again".
const MEMORY_DEFER_GRACE_SECONDS = 30;
const MEMORY_DEFER_PATH = "/__ci_memory/defer";
const MEMORY_SKIP_PATH = "/__ci_memory/skip";
const MEMORY_LOGO_PATH = "/__ci_memory/ci-memory-logo.webp";

/** The Hub's internal base URL (reachable from this container on the app network). */
function hubInternalBase(env) {
  return (env.CI_HUB_URL || env.HUB_URL || "").trim().replace(/\/+$/, "");
}

/** Auth header for wrapper->Hub memory-connect calls: this app's own managed key. */
function mcpAuthHeaders(env) {
  const key = (env.HUB_MCP_API_KEY || "").trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** Whether the request carries the short-lived "deferred" cookie (grace window). */
function hasMemoryDeferCookie(req) {
  const cookie = req.headers.cookie || "";
  return cookie.split(";").some((c) => c.trim().startsWith(`${MEMORY_DEFER_COOKIE}=`));
}

/**
 * Read a small urlencoded request body (bounded), resolving to parsed params.
 * The memory-gate action token travels in the POST body (not the URL), so a
 * cross-site page still cannot forge it (same-origin policy) while it no longer
 * leaks through request logs / Referer / history.
 */
function readFormBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(new URLSearchParams(value));
      }
    };
    req.on("data", (chunk) => {
      if (done) return;
      data += chunk;
      // Over the (generous) cap → treat as no token. Stop accumulating (via the
      // `done` guard) but do NOT destroy the socket here, so the awaiting handler
      // still delivers its 403 on a live connection.
      if (data.length > limit) {
        finish("");
      }
    });
    req.on("end", () => finish(data));
    req.on("error", () => finish(""));
    // Resolve on close/abort too, so a client that stalls without a clean
    // end/error can never leave this promise (and the awaiting handler) pending.
    req.on("close", () => finish(""));
  });
}

/** Escape a value for safe interpolation into an HTML attribute. */
function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Return `url` only if it is an http(s) URL; otherwise null (reject javascript:, data:, etc.). */
function safeHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Minimal, self-contained interstitial page. Matches the Companion Memory
 * (CI-Import-Tools) sign-in aesthetic: navy background, elevated card, the
 * app's own logo paired with the Companion Memory logo ("app -> memory"), and a
 * teal brand-gradient pill. The app logo is served at /logo.webp and the memory
 * logo at MEMORY_LOGO_PATH. Colors mirror the import-tools dark theme tokens
 * (with a light-scheme fallback).
 */
function renderMemoryGateHtml(connectUrl) {
  // Connector + Companion Memory mark, appended after the app logo. Omitted
  // entirely (no dangling arrow) when the mark asset is unavailable.
  const cmGlyph = MEMORY_LOGO
    ? `<svg class="link" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="12" x2="18" y2="12" /><polyline points="12 6 18 12 12 18" /></svg><img class="cm" src="${MEMORY_LOGO_PATH}" alt="Companion Memory" />`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect to Companion Memory</title>
<style>
  :root{color-scheme:dark;--bg:#041620;--card:#0a222e;--border:#1f4a55;--fg:#f5f8fa;--fg-dim:#9bb2b7;--brand-grad:linear-gradient(135deg,#0b6e74 0%,#079d99 100%);--on-accent:#fff;--shadow:0 6px 24px rgba(4,22,32,.22)}
  @media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f3f3f3;--card:#f7f7f9;--border:#d3dddf;--fg:#010f16;--fg-dim:#4f6168;--shadow:0 6px 24px rgba(4,22,32,.12)}}
  *{box-sizing:border-box}
  body{font-family:"Montserrat",system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);padding:40px 20px}
  .card{width:100%;max-width:420px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:36px 28px;box-shadow:var(--shadow)}
  .brand{display:flex;align-items:center;justify-content:center;gap:14px;margin:0 auto 22px}
  .applogo{width:56px;height:56px;object-fit:contain;background:#fff;border-radius:14px;padding:8px;box-shadow:0 2px 10px rgba(0,0,0,.28)}
  .brand .link{color:var(--fg-dim);display:flex;align-items:center}
  .cm{width:56px;height:56px;object-fit:contain;border-radius:14px;background:#000;box-shadow:0 2px 10px rgba(0,0,0,.28)}
  h1{font-size:20px;font-weight:700;margin:0 0 8px}
  p{line-height:1.5;color:var(--fg-dim);font-size:14px;margin:0 0 22px}
  .actions{display:flex;flex-direction:column;gap:10px}
  .actions form{margin:0}
  .btn{display:block;width:100%;padding:11px 20px;border-radius:999px;border:0;font-size:15px;font-weight:600;line-height:1.2;cursor:pointer;text-align:center;text-decoration:none;font-family:inherit}
  .primary{background:var(--brand-grad);color:var(--on-accent)}
  .primary:hover{filter:brightness(1.06)}
  .secondary{background:transparent;color:var(--fg-dim);border:1px solid var(--border)}
  .secondary:hover{color:var(--fg);border-color:var(--fg-dim)}
</style></head>
<body><main class="card">
  <div class="brand">
    <img class="applogo" src="/logo.webp" alt="OpenClaw" />${cmGlyph}
  </div>
  <h1>Give OpenClaw long-term memory</h1>
  <p>Connect to your Companion Memory so OpenClaw remembers your context across
     sessions. You'll sign in with Companion Intelligence and approve access; you
     can disconnect any time.</p>
  <div class="actions">
    <a class="btn primary" href="${escapeHtmlAttr(connectUrl)}">Sign in with Companion Intelligence</a>
    <form method="POST" action="${MEMORY_DEFER_PATH}"><input type="hidden" name="t" value="${MEMORY_ACTION_TOKEN}" /><button class="btn secondary" type="submit">Maybe later</button></form>
    <form method="POST" action="${MEMORY_SKIP_PATH}"><input type="hidden" name="t" value="${MEMORY_ACTION_TOKEN}" /><button class="btn secondary" type="submit">Don't ask again</button></form>
  </div>
</main></body></html>`;
}

/**
 * If memory is not yet connected and the user hasn't dismissed the prompt,
 * serve the connect interstitial and return true. Only gates the top-level HTML
 * page load; fails open (returns false → proxy through) on any uncertainty so a
 * Hub hiccup never blocks the app.
 */
async function maybeServeMemoryGate(req, res) {
  if (req.method !== "GET") return false;
  const pathname = (req.url || "/").split("?")[0];
  // Gate EVERY top-level HTML navigation, regardless of which SPA route the user
  // opens or refreshes (/, /chat, …) — not just the root — so a disconnected app
  // re-prompts everywhere. Never gate the wrapper's own /__ci_memory/* paths
  // (defer/skip/logo), nor non-navigation requests: API/XHR, static assets, and
  // WebSocket upgrades don't carry `Sec-Fetch-Dest: document` (and don't Accept
  // text/html on older browsers), so returning the interstitial HTML for them
  // would break the app.
  if (pathname.startsWith("/__ci_memory")) return false;
  const secFetchDest = String(req.headers["sec-fetch-dest"] || "");
  const isNavigation = secFetchDest ? secFetchDest === "document" : String(req.headers.accept || "").includes("text/html");
  if (!isNavigation) return false;

  // Resolve creds exactly as the spawned gateway does: .env is the base, and only
  // NON-EMPTY Hub-authoritative container vars override it. A plain
  // `{ ...readEnv(), ...process.env }` merge would let an unsubstituted compose
  // `${CI_SERVER_TOKEN}` (resolved to "") blank a real .env token and wrongly
  // re-show the interstitial to an already-configured app.
  const env = buildChildEnv();
  if (hasCiServerCredentials(env)) return false; // connected or manually configured
  if (hasMemoryDeferCookie(req)) return false; // dismissed for this session

  const appUrn = (env.CI_APP_URN || "").trim();
  const hubBase = hubInternalBase(env);
  if (!appUrn || !hubBase) return false; // can't resolve — fail open

  try {
    const resp = await fetch(`${hubBase}/api/memory-connect/apps/${encodeURIComponent(appUrn)}/state`, {
      headers: mcpAuthHeaders(env),
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return false;
    const { state, connectUrl } = await resp.json();
    // Only prompt when the user hasn't decided yet; skipped/manual/connected pass through.
    if (state !== "unconfigured" && state !== "deferred") return false;
    // Only ever link to an http(s) Hub URL — never a javascript:/data: scheme.
    const safeConnectUrl = safeHttpUrl(connectUrl);
    if (!safeConnectUrl) return false;

    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
      // Anti-clickjacking: the gate has consent-suppression buttons (skip/defer),
      // so it must never be framed (matches the CI-Server consent page).
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
    });
    res.end(renderMemoryGateHtml(safeConnectUrl));
    return true;
  } catch {
    return false; // Hub unreachable → fail open
  }
}

/** Handle the interstitial's local defer/skip actions. Returns true if handled. */
async function handleMemoryAction(req, res) {
  const pathname = (req.url || "/").split("?")[0];
  if (pathname !== MEMORY_DEFER_PATH && pathname !== MEMORY_SKIP_PATH) return false;

  // POST-only + anti-CSWSH token carried in the body (byte-safe compare).
  const body = req.method === "POST" ? await readFormBody(req) : new URLSearchParams();
  if (req.method !== "POST" || !tokensMatch(body.get("t"), MEMORY_ACTION_TOKEN)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return true;
  }

  if (pathname === MEMORY_DEFER_PATH) {
    // Session cookie — reappears next browser session, per the "deferred" design.
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": `${MEMORY_DEFER_COOKIE}=1; Path=/; Max-Age=${MEMORY_DEFER_GRACE_SECONDS}; HttpOnly; SameSite=Lax`,
    });
    res.end();
    return true;
  }

  // Skip forever — relay to the Hub (only this container can reach it internally).
  const env = buildChildEnv();
  const appUrn = (env.CI_APP_URN || "").trim();
  const hubBase = hubInternalBase(env);
  if (appUrn && hubBase) {
    try {
      await fetch(`${hubBase}/api/memory-connect/apps/${encodeURIComponent(appUrn)}/skip`, {
        method: "POST",
        headers: mcpAuthHeaders(env),
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      // best-effort; the gate simply reappears if this didn't land
    }
  }
  res.writeHead(302, { Location: "/" });
  res.end();
  return true;
}

const server = http.createServer(async (req, res) => {
  // Serve static assets for setup UI
  if (req.url === "/logo.webp") {
    res.writeHead(200, {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(LOGO);
    return;
  }

  // Companion Memory logo for the connect interstitial (served from assets/).
  if (MEMORY_LOGO && req.url === MEMORY_LOGO_PATH) {
    res.writeHead(200, {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(MEMORY_LOGO);
    return;
  }

  if (!isConfigured()) {
    if (req.url !== "/") {
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(SETUP_HTML.replace("__SETUP_TOKEN__", SETUP_TOKEN));
    return;
  }

  if (ptyProcess) {
    // OpenClaw writes config before QuickStart fully exits. Keep the browser on
    // the terminal until onboarding is done so the gateway never starts against
    // config/auth files that OpenClaw may still rewrite.
    if (req.url !== "/") {
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(SETUP_HTML.replace("__SETUP_TOKEN__", SETUP_TOKEN));
    return;
  }

  // Companion Memory connect interstitial (post-onboarding, pre-app). Handle its
  // local defer/skip actions first, then offer the gate on the top-level load.
  if (await handleMemoryAction(req, res)) {
    return;
  }
  if (await maybeServeMemoryGate(req, res)) {
    return;
  }

  // If configured but OpenClaw not running, start it
  if (!openclawProcess) {
    startOpenclaw();
  }

  // Proxy to OpenClaw
  proxyToOpenclaw(req, res);
});

// WebSocket server for the interactive terminal
const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (ws) => {
  console.log("Terminal WebSocket connected");

  // Only one setup session at a time — kill any existing PTY (e.g. stale tab).
  // Each handler below keeps its own setupPty reference so a delayed close from
  // an old browser session cannot accidentally kill the newly active session.
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch (e) {}
    ptyProcess = null;
  }

  // Spawn openclaw onboard with flags that skip everything except provider/API key selection.
  // The CLI does NOT generate a gateway token — reconcileConfig() generates one and
  // syncs it to .env when startOpenclaw() runs after setup.
  ensureConfigDir();
  ensureShellCompletionBypass();
  const setupPty = pty.spawn(
    "openclaw",
    [
      "onboard",
      "--flow",
      "quickstart",
      "--accept-risk",
      "--skip-channels",
      "--skip-skills",
      "--skip-search",
      "--skip-daemon",
      "--skip-ui",
      "--skip-health",
      "--mode",
      "local",
      "--gateway-port",
      OPENCLAW_PORT.toString(),
    ],
    {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: CONFIG_DIR,
      env: {
        ...buildChildEnv(),
        SHELL: "/bin/bash",
        TERM: "xterm-256color",
      },
    },
  );
  ptyProcess = setupPty;

  // PTY output -> WebSocket
  setupPty.onData((data) => {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    } catch (e) {
      console.error("Error sending PTY output:", e.message);
    }
  });

  // PTY exit -> notify client
  setupPty.onExit(({ exitCode }) => {
    console.log(`openclaw onboard exited with code ${exitCode}`);
    const wasActiveSession = ptyProcess === setupPty;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      }
    } catch (e) {
      console.error("Error sending exit message:", e.message);
    }
    if (wasActiveSession) {
      ptyProcess = null;
    }

    if (
      wasActiveSession &&
      exitCode === 0 &&
      isConfigured() &&
      !openclawProcess
    ) {
      console.log("OpenClaw onboarding completed, starting gateway...");
      startOpenclaw({ repair: false });
    }
  });

  // WebSocket input -> PTY
  ws.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (ptyProcess !== setupPty) {
        return;
      }
      if (parsed.type === "input") {
        setupPty.write(parsed.data);
      } else if (parsed.type === "resize") {
        setupPty.resize(parsed.cols, parsed.rows);
      }
    } catch (e) {
      console.error("Error processing terminal input:", e.message);
    }
  });

  ws.on("close", () => {
    console.log("Terminal WebSocket closed");
    if (ptyProcess === setupPty) {
      try {
        setupPty.kill();
      } catch (e) {}
      ptyProcess = null;
    }
  });
});

// Handle WebSocket upgrades
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Route /api/terminal to the PTY WebSocket server
    if (url.pathname === "/api/terminal") {
      // Validate anti-CSWSH token with a byte-safe compare: a multi-byte `token`
      // must reject cleanly rather than make crypto.timingSafeEqual throw a
      // RangeError (which, uncaught here, would crash the wrapper).
      const provided = url.searchParams.get("token") || "";
      if (!tokensMatch(provided, SETUP_TOKEN)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }

    if (!isConfigured()) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }

    if (ptyProcess) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }

    if (!openclawProcess) {
      startOpenclaw();
    }

    handleUpgrade(req, socket, head);
  } catch (err) {
    // Defense in depth: never let an upgrade-handler throw escape as an uncaught
    // exception (which would crash the wrapper). Reject the socket and move on.
    console.error("[ci-memory] upgrade handler error:", err && err.message ? err.message : err);
    try {
      socket.destroy();
    } catch {
      /* socket already gone */
    }
  }
});

// Initialize home directory from skeleton
initializeHome();

ensureConfigDir();

// Check if already configured
if (isConfigured()) {
  console.log("OpenClaw is configured, starting gateway...");
  startOpenclaw();
} else {
  console.log("OpenClaw not configured, showing setup UI...");
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Setup server listening on port ${PORT}`);
});

// Last-resort backstop: keep a stray throw/rejection (e.g. from an event
// handler outside a request's try/catch) from hard-crashing the wrapper and
// dropping the whole app. Log and keep serving.
process.on("uncaughtException", (err) => {
  console.error("[ci-memory] uncaughtException:", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[ci-memory] unhandledRejection:", reason);
});

// Graceful shutdown: Docker sends SIGTERM on stop/restart/update.
// Without this, child processes (gateway, PTY) may get hard-killed
// mid-write and corrupt config or state files.
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch (e) {}
  }
  if (openclawProcess) {
    openclawProcess.kill("SIGTERM");
  }
  server.close();
});
