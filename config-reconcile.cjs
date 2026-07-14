/**
 * OpenClaw config reconciliation — the layer that owns `openclaw.json`.
 *
 * This is the most consequential code in the wrapper. OpenClaw's config schema is
 * STRICT: a single unrecognized key invalidates the ENTIRE file, after which startup
 * `doctor --repair` quarantines it as `openclaw.json.clobbered.<ts>` and restores
 * last-known-good — silently reverting everything written in the same pass (model
 * catalog, memory wiring, gateway token). One wrong key anywhere takes down settings
 * that have nothing to do with it, on no error channel. Hence the tests.
 *
 * Extracted from server.cjs so it can be required and exercised without booting the
 * app. Two invariants keep it that way, and both are load-bearing:
 *
 *   1. NO SIDE EFFECTS ON REQUIRE. Nothing here listens, spawns, writes, or reads the
 *      filesystem at module scope. Requiring this file must be free.
 *   2. NO RUNTIME DEPENDENCIES. Only node builtins. server.cjs requires node-pty and
 *      ws by absolute container path (`/app/node_modules/...`), which is precisely what
 *      made this layer untestable; do not reintroduce that coupling here.
 *
 * State (the last-write timestamp, the reported-quarantine set, the num_ctx memo) lives
 * in the closure returned by createConfigReconciler, not at module scope. Production
 * constructs exactly ONE reconciler, so those lifetimes are identical to the original
 * module-level globals; tests construct one per case and get isolation for free.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** Internal port the OpenClaw gateway listens on (see server.cjs). */
const DEFAULT_GATEWAY_PORT = 18790;

const CI_PLUGIN_ID = "ci-runtime";
const CI_MEMORY_PLUGIN_ID = "companionintelligence";
const CI_HUB_PLUGIN_ID = "ci-hub";

/** Where the vendored plugins live inside the built image (see Dockerfile). */
const DEFAULT_PLUGIN_PATHS = {
  ciRuntime: "/app/openclaw-context/plugins/ci-runtime",
  ciMemory: "/app/openclaw-context/plugins/companionintelligence",
  ciHub: "/app/openclaw-context/plugins/ci-hub",
};

// Treats the embeddings endpoint as an OpenAI-compatible /v1 server (which Ollama
// serves) and, unlike the bundled remote providers, requires no API key.
const MEMORY_EMBEDDING_PROVIDER = "openai-compatible";

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

// ---------------------------------------------------------------------------
// Pure helpers. No I/O, no logging, no injected state — safe to export directly
// and to call from the bootstrap-*.sh node heredocs.
// ---------------------------------------------------------------------------

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

/**
 * Walk to a nested array, coercing every node on the way (and the leaf itself) to a
 * usable type. Array counterpart to ensureRecordPath; returns the leaf array.
 */
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

/**
 * Remove every occurrence of `item` from `items` in place. Returns true if anything
 * was removed, so callers can fold it into their `changed` flag.
 */
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

/**
 * Is CI-Server memory wired up? Note the explicit `!== "false"` string compare rather
 * than a truthiness check: these values arrive from the environment (and from .env) as
 * strings, so the literal "false" is what disables the feature — a boolean never
 * reaches us.
 */
function hasCiServerCredentials(env) {
  return !!(
    env.CI_SERVER_URL &&
    env.CI_SERVER_TOKEN &&
    env.CI_SERVER_ENABLED !== "false"
  );
}

/** Hub MCP counterpart of hasCiServerCredentials. Either base URL will do. */
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

// Trailing slashes are not meaningful in an embeddings base URL — OpenClaw strips
// them itself (normalizeBaseUrl) — so compare URLs with them removed. Without this,
// a config that merely spells the SAME endpoint with a trailing slash looks like a
// different one, and the repoint check below would delete an operator's credential.
function normalizeEmbeddingsBaseUrl(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

/** Embedding models are not chat models; they must never enter the chat catalog. */
function isEmbeddingModel(modelId) {
  return /embed/i.test(modelId || "");
}

/**
 * Build one entry for the `ci-hub` provider's model catalog.
 *
 * `numCtx` is the Hub's hardware-aware context window (CI_LLM_NUM_CTX), passed in
 * rather than read from the environment so this stays pure and the clamping below is
 * directly testable — it is the single most regression-prone computation we own.
 */
function buildOllamaModelEntry(modelId, displayName, capabilities, numCtx) {
  const hubNumCtx = numCtx || undefined;
  // Never request more context than the model supports: numCtx is computed for
  // the Hub's default chat model and may exceed a smaller model's window. When
  // the per-model limit is unknown, stay conservative at the historical 32000
  // default rather than the possibly-larger numCtx.
  const effCtx = hubNumCtx
    ? Math.min(hubNumCtx, capabilities?.contextLimit ?? 32000)
    : undefined;
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

// ---------------------------------------------------------------------------
// The reconciler.
// ---------------------------------------------------------------------------

/**
 * Construct a reconciler bound to one data directory.
 *
 * Production creates exactly one of these at module scope in server.cjs; the closure
 * state below (last-write timestamp, reported quarantines, num_ctx memo) therefore has
 * the same lifetime it had as module globals. Tests create one per case.
 *
 * Two env sources are threaded separately and MUST NOT be merged into one record:
 *   - `containerEnv` — the live container environment (process.env in production).
 *   - the `.env` record returned by readEnv() — persisted wizard/Hub output.
 * Their precedence is not uniform (resolveHubNumCtx is container-first; every other
 * reader is file-first) and resolveInferenceApiKey interleaves them across two
 * different keys, so a merged view would silently change which credential we send.
 *
 * @param {object}   deps
 * @param {string}   deps.configDir    Data dir holding openclaw.json and .env.
 * @param {object}   [deps.containerEnv] Live container env. Defaults to process.env.
 * @param {object}   [deps.pluginPaths]  Absolute paths to the vendored plugins.
 * @param {number}   [deps.gatewayPort]  Port the gateway listens on (for allowedOrigins).
 * @param {object}   [deps.log]          Console-shaped sink; injected so tests can assert
 *                                       on the "Patched config:" stream, which is the
 *                                       observable contract for "did we change anything".
 */
function createConfigReconciler({
  configDir,
  containerEnv = process.env,
  pluginPaths = DEFAULT_PLUGIN_PATHS,
  gatewayPort = DEFAULT_GATEWAY_PORT,
  log = console,
} = {}) {
  if (!configDir) {
    throw new TypeError("createConfigReconciler requires a configDir");
  }

  const CONFIG_FILE = path.join(configDir, "openclaw.json");
  const ENV_FILE = path.join(configDir, ".env");

  const CI_PLUGIN_PATH = pluginPaths.ciRuntime;
  const CI_MEMORY_PLUGIN_PATH = pluginPaths.ciMemory;
  const CI_HUB_PLUGIN_PATH = pluginPaths.ciHub;

  // When we last wrote openclaw.json. warnIfConfigClobbered uses this as the cutoff
  // so it catches a quarantine by ANY openclaw invocation after our write, not just
  // one that happens inside the doctor call.
  let configWrittenAtMs = 0;
  // Quarantines already reported. startOpenclaw re-runs on every gateway exit, and a
  // reconcile that changes nothing leaves configWrittenAtMs at the previous write, so
  // without this the same historical snapshot is re-reported on every restart.
  const reportedClobbers = new Set();

  // -------------------------------------------------------------------------
  // Env + config I/O
  // -------------------------------------------------------------------------

  /** Parse the persisted .env into a record. Missing/unreadable file yields {}. */
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
      log.error("Error reading env:", e);
    }
    return env;
  }

  // Overlay Hub-authoritative keys from the live container env onto `env`,
  // mutating and returning it. A non-empty container value wins (including
  // CI_SERVER_ENABLED="false", which must be able to disable memory over a stale
  // .env). An unset or empty-string container value is ignored — so an
  // unsubstituted docker-compose `${VAR}` that resolves to "" doesn't blank out a
  // .env / wizard value — leaving older-Hub and local-dev behavior intact.
  function applyHubAuthoritativeEnv(env) {
    for (const key of HUB_AUTHORITATIVE_ENV_KEYS) {
      const fromContainer = containerEnv[key];
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
    return applyHubAuthoritativeEnv({ ...containerEnv, ...readEnv() });
  }

  /**
   * Force 0600 on a file we just wrote.
   *
   * writeFileSync's `mode` option only applies when it CREATES the file — on an
   * existing one it is silently ignored. Both .env and openclaw.json are normally
   * created before we ever write them (by `openclaw onboard` or the bootstrap
   * scripts), so without an explicit chmod our 0600 intent never takes effect and
   * these files — which hold the gateway auth token and the provider API keys —
   * keep whatever mode their creator left behind.
   */
  function restrictToOwner(file) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Best-effort: a read-only mount or foreign owner must not break reconcile.
    }
  }

  /** Persist the .env at 0600. Falsy values are dropped rather than written empty. */
  function writeEnv(env) {
    const lines = ["# OpenClaw Configuration", "# Generated by setup wizard", ""];
    for (const [key, value] of Object.entries(env)) {
      if (value) {
        lines.push(`${key}=${value}`);
      }
    }
    fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
    restrictToOwner(ENV_FILE);
  }

  /**
   * Persist openclaw.json at 0600 and stamp the write. Only ever called when
   * reconcileConfig's `changed` flag is set — the stamp is what lets
   * warnIfConfigClobbered attribute a later quarantine to our write.
   */
  function writeConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
    restrictToOwner(CONFIG_FILE);
    // Stamp from the file's OWN mtime, not Date.now(). warnIfConfigClobbered compares
    // this against the mtimeMs of quarantine snapshots, and the two are not on the same
    // clock: Date.now() is whole milliseconds and can round UP, while mtimeMs carries
    // sub-millisecond precision. A quarantine written moments AFTER us can therefore
    // carry an mtime numerically below our stamp (776.6 < 777) and be missed entirely.
    // Reading our own mtime back puts both sides of the comparison on the same clock.
    try {
      configWrittenAtMs = fs.statSync(CONFIG_FILE).mtimeMs;
    } catch {
      configWrittenAtMs = Date.now();
    }
  }

  function ensureConfigDir() {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    const workspaceDir = path.join(configDir, "workspace");
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
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
      log.error("Config file corrupted, attempting restore from backup...");
      const backupFile = CONFIG_FILE + ".bak";
      try {
        if (fs.existsSync(backupFile)) {
          fs.copyFileSync(backupFile, CONFIG_FILE);
          log.log("Restored config from backup");
          return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
        }
      } catch (e2) {
        log.error("Backup restore also failed:", e2.message);
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Config writers. Each returns true if it mutated `config`; callers fold that
  // into `changed`, and only a truthy `changed` triggers writeConfig().
  // -------------------------------------------------------------------------

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
        log.log("Patched config: removed ci-hub MCP server (Hub MCP disabled or credentials absent)");
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
    log.log(`Patched config: registered ci-hub MCP server (Streamable HTTP, ${url})`);
    return true;
  }

  /**
   * Turn off OpenClaw's own session-memory hook. Two active memory runtimes would
   * both observe the session; the CI plugin is the one we select, so the bundled hook
   * must stand down.
   */
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
      log.log(
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
      log.log(
        "Patched config: enabled conversation access for CI memory turn-sync",
      );
    }
    return changed;
  }

  /**
   * Allow the CI plugin's `memory_store` tool.
   *
   * `tools.alsoAllow` is the additive list and is always ensured. `tools.allow` is an
   * EXCLUSIVE allowlist: it is only appended to when the operator already maintains
   * one, because creating it here would silently deny every tool not named in it.
   */
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
      log.log("Patched config: allowed Companion Intelligence memory_store tool");
    }
    if (
      Array.isArray(config.tools.allow) &&
      !config.tools.allow.includes("memory_store")
    ) {
      config.tools.allow.push("memory_store");
      changed = true;
      log.log("Patched config: added memory_store to explicit tool allowlist");
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
  function ensureMemorySearchEmbeddings(config, env) {
    const model = (env.EMBEDDINGS_MODEL || containerEnv.EMBEDDINGS_MODEL || "").trim();
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
    log.log(
      `Patched config: memory search embeddings -> ${model} @ ${baseUrl}`,
    );
    if (droppedApiKey) {
      // Never log the value, only that it is gone.
      log.log(
        "Patched config: dropped memory search remote.apiKey — it belonged to the previous embeddings endpoint",
      );
    }
    return true;
  }

  /**
   * Register a vendored plugin by path and set its entry state.
   *
   * `options.enableEntry` distinguishes "installed and available" from "installed and
   * active": the memory plugin is registered on every boot but only enabled once it is
   * the selected memory backend, so OpenClaw never loads two memory runtimes.
   *
   * If the plugin directory is missing we warn and change NOTHING — writing a load path
   * for a directory that does not exist would make OpenClaw reject the whole config.
   */
  function ensureOpenClawPlugin(config, pluginId, pluginPath, label, options = {}) {
    const enableEntry = options.enableEntry !== false;

    if (!fs.existsSync(pluginPath)) {
      log.warn(
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
      log.log("Patched config: enabled plugins");
    }

    const loadPaths = ensureArrayPath(config, ["plugins", "load", "paths"]);
    if (!loadPaths.includes(pluginPath)) {
      loadPaths.push(pluginPath);
      changed = true;
      log.log(`Patched config: added ${label} plugin path`);
    }

    if (enableEntry) {
      if (
        Array.isArray(config.plugins.deny) &&
        removeArrayItem(config.plugins.deny, pluginId)
      ) {
        changed = true;
        log.log(`Patched config: removed ${label} plugin from deny list`);
      }

      const allowedPlugins = config.plugins.allow;
      if (
        Array.isArray(allowedPlugins) &&
        allowedPlugins.length > 0 &&
        !allowedPlugins.includes(pluginId)
      ) {
        allowedPlugins.push(pluginId);
        changed = true;
        log.log(`Patched config: added ${label} plugin to allow list`);
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
      log.log(
        `Patched config: ${nextEnabled ? "enabled" : "disabled"} ${label} plugin`,
      );
    }

    return changed;
  }

  // -------------------------------------------------------------------------
  // Resolvers
  // -------------------------------------------------------------------------

  /**
   * Native Ollama host (never carrying a /v1 suffix). OPENAI_API_BASE is an
   * OpenAI-compatible URL, so its /v1 is stripped to get back to the native host.
   */
  function resolveOllamaBaseUrl(env) {
    const directHost = (env.OLLAMA_HOST || containerEnv.OLLAMA_HOST || "").replace(
      /\/$/,
      "",
    );
    if (directHost) return directHost;

    const openAiBase = (
      env.OPENAI_API_BASE ||
      containerEnv.OPENAI_API_BASE ||
      ""
    ).replace(/\/$/, "");
    if (openAiBase.endsWith("/v1")) {
      return openAiBase.slice(0, -3);
    }

    return "http://host.docker.internal:11434";
  }

  /**
   * Key for the inference endpoint, defaulting to Ollama's ignored-but-required
   * placeholder.
   *
   * Note the precedence INTERLEAVES the two env sources across two different keys:
   * .env OPENAI → container OPENAI → .env OLLAMA → container OLLAMA. It is not
   * "all of .env, then all of the container", so this cannot be rewritten against a
   * single merged env record without changing which key we send.
   */
  function resolveInferenceApiKey(env) {
    return (
      env.OPENAI_API_KEY ||
      containerEnv.OPENAI_API_KEY ||
      env.OLLAMA_API_KEY ||
      containerEnv.OLLAMA_API_KEY ||
      "ollama"
    );
  }

  // Hardware-aware context window injected by the Hub (CI_LLM_NUM_CTX). Caps both
  // the agent's token budget and the native Ollama num_ctx so OpenClaw doesn't pack
  // to Ollama's oversized memory-based default (e.g. 262144 on unified-memory APUs).
  // Memoized: the value only changes on container restart, and buildOllamaModelEntry
  // is called once per discovered model.
  let hubNumCtx;
  function resolveHubNumCtx() {
    if (hubNumCtx !== undefined) return hubNumCtx;
    const raw = containerEnv.CI_LLM_NUM_CTX || readEnv().CI_LLM_NUM_CTX || "";
    const n = Number.parseInt(raw, 10);
    hubNumCtx = Number.isFinite(n) && n > 0 ? n : null;
    return hubNumCtx;
  }

  // -------------------------------------------------------------------------
  // Ollama discovery
  // -------------------------------------------------------------------------

  /** GET/POST JSON with a hard timeout. Returns null on any non-2xx. */
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

  /** Ask Ollama what a model can do, and how much context it was trained for. */
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

  /**
   * Build the ci-hub model catalog from what Ollama actually has installed.
   *
   * Prepends an "auto" alias pointing at DEFAULT_MODEL (or the first model, if the
   * Hub's default is not installed) so the agent always has a stable model id to
   * select, and inherits that target's capabilities and context cap.
   */
  async function discoverOllamaModels(ollamaBaseUrl, defaultModel) {
    const numCtx = resolveHubNumCtx();
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
      models.push(buildOllamaModelEntry(id, name || id, capabilities, numCtx));
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
          numCtx,
        ),
      );
    }

    return { models, defaultModelAvailable, firstModelId };
  }

  // -------------------------------------------------------------------------
  // State queries used by the setup server
  // -------------------------------------------------------------------------

  /** Bearer token the setup proxy presents to the gateway. .env wins over config. */
  function getGatewayToken() {
    const env = readEnv();
    if (env.OPENCLAW_GATEWAY_TOKEN) return env.OPENCLAW_GATEWAY_TOKEN;
    if (containerEnv.OPENCLAW_GATEWAY_TOKEN)
      return containerEnv.OPENCLAW_GATEWAY_TOKEN;
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

  /**
   * Has onboarding happened? Either the CLI wizard wrote its section, or SOME
   * inference provider key exists — in .env or in the container env, since the Hub
   * delivers keys by environment and the wizard writes them to disk.
   */
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
      containerEnv.ANTHROPIC_API_KEY ||
      containerEnv.OPENAI_API_KEY ||
      containerEnv.GEMINI_API_KEY ||
      containerEnv.MOONSHOT_API_KEY ||
      containerEnv.MINIMAX_API_KEY ||
      containerEnv.DASHSCOPE_API_KEY ||
      containerEnv.ZAI_API_KEY ||
      containerEnv.VENICE_API_KEY ||
      containerEnv.XAI_API_KEY ||
      containerEnv.GROQ_API_KEY ||
      containerEnv.CEREBRAS_API_KEY ||
      containerEnv.MISTRAL_API_KEY ||
      containerEnv.COPILOT_GITHUB_TOKEN ||
      containerEnv.OLLAMA_API_KEY ||
      containerEnv.OPENROUTER_API_KEY
    );
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
        .readdirSync(configDir)
        .filter((name) => name.startsWith("openclaw.json.clobbered."))
        // OpenClaw rotates (unlinks) old snapshots once its cap is reached, so a name
        // can vanish between readdir and stat. Drop those rather than let one ENOENT
        // suppress the whole warning — the cap is hit precisely when clobbering is
        // most frequent, which is exactly when we must not go quiet.
        .filter((name) => !reportedClobbers.has(name))
        .filter((name) => {
          try {
            return fs.statSync(path.join(configDir, name)).mtimeMs >= since;
          } catch {
            return false;
          }
        });
    } catch {
      return; // Detection is best-effort; never let it break startup.
    }
    if (clobbered.length === 0) return;
    for (const name of clobbered) reportedClobbers.add(name);
    log.error(
      `openclaw rejected openclaw.json and restored last-known-good: ${clobbered.join(", ")}. ` +
        "The config we last wrote (model catalog, memory wiring) has been reverted — " +
        "inspect the quarantined file for an unrecognized key.",
    );
  }

  // -------------------------------------------------------------------------
  // The orchestrator
  // -------------------------------------------------------------------------

  /**
   * Bring openclaw.json in line with the environment the Hub gave us.
   *
   * Contract: every writer above returns whether it mutated the config, and this
   * folds those into a single `changed` flag — `changed = ensureX(...) || changed`,
   * with the call on the LEFT so it always runs (short-circuiting would skip the
   * mutation). openclaw.json is written ONCE, at the end, and only if something
   * actually changed. That is what makes reconcile converge: a steady-state boot must
   * not rewrite the file, or every restart would churn it.
   *
   * No-ops entirely if there is no config to reconcile (fresh container, pre-onboard).
   */
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
      log.log("Patched config: enabled allowInsecureAuth");
    }

    // Disable device auth (would break access in some CI proxy configurations)
    if (!config.gateway.controlUi.dangerouslyDisableDeviceAuth) {
      config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
      changed = true;
      log.log("Patched config: disabled device auth");
    }

    // The CI setup proxy rewrites Host/Origin to the local gateway origin.
    // Make sure that rewritten origin is explicitly trusted by the Control UI.
    if (!Array.isArray(config.gateway.controlUi.allowedOrigins)) {
      config.gateway.controlUi.allowedOrigins = [];
      changed = true;
    }
    const requiredOrigins = [
      `http://127.0.0.1:${gatewayPort}`,
      `http://localhost:${gatewayPort}`,
    ];
    for (const origin of requiredOrigins) {
      if (!config.gateway.controlUi.allowedOrigins.includes(origin)) {
        config.gateway.controlUi.allowedOrigins.push(origin);
        changed = true;
        log.log(`Patched config: added allowed origin ${origin}`);
      }
    }

    // Disable update checks (updates are managed by the CI marketplace via Docker image bumps)
    if (!config.update) config.update = {};
    if (config.update.checkOnStart !== false) {
      config.update.checkOnStart = false;
      changed = true;
      log.log("Patched config: disabled update check on start");
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
          log.log(
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

    // Enable the CI-Hub companion plugin (wake endpoint, app-event SSE) when Hub
    // injects MCP credentials. Tool access itself comes from the native
    // mcp.servers.ci-hub entry above, not this plugin.
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
      log.log("Patched config: generated gateway auth token");
    }

    // Required since openclaw 2026.3.7 when auth is configured.
    // Always forced to "token" — the proxy only speaks Bearer token auth.
    if (config.gateway.auth.mode !== "token") {
      config.gateway.auth.mode = "token";
      changed = true;
      log.log("Patched config: set gateway auth mode to token");
    }

    // Required since a newer openclaw release: gateway refuses to start if
    // gateway.mode is absent (exit code 78). Force "local" which is the correct
    // mode for a CI-marketplace-managed container.
    if (config.gateway.mode !== "local") {
      config.gateway.mode = "local";
      changed = true;
      log.log("Patched config: set gateway.mode to local");
    }

    // Mirror the Hub-managed Ollama defaults into OpenClaw's current config shape.
    // The newer gateway does not switch providers just because OPENAI_API_* is present;
    // it needs a concrete provider entry plus an agent default model selection.
    const ollamaBaseUrl = resolveOllamaBaseUrl(env);
    const inferenceApiKey = resolveInferenceApiKey(env);
    const defaultModel = env.DEFAULT_MODEL || containerEnv.DEFAULT_MODEL || "";

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
      log.log("Patched config: set model catalog mode to merge");
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
      log.log(
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
          log.log(
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
          log.log("Patched config: merged ci-hub model options");
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
            log.log(
              `Patched config: set default agent model to ${nextPrimaryModel}`,
            );
          }
        }
      } else {
        log.warn(
          `No Ollama chat models discovered at ${ollamaBaseUrl}; preserving existing ci-hub model catalog`,
        );
      }
    } catch (error) {
      log.warn(
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
        log.log(`Patched config: set default agent model to ${nextPrimaryModel}`);
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
      log.log("Synced gateway token to .env");
    }
  }

  return {
    // Timestamp of our last openclaw.json write; runDoctor uses it as the quarantine
    // cutoff. A getter, not a value, because it advances on every writeConfig.
    get configWrittenAtMs() {
      return configWrittenAtMs;
    },
    // env + config I/O
    readEnv,
    writeEnv,
    readConfig,
    writeConfig,
    ensureConfigDir,
    buildChildEnv,
    applyHubAuthoritativeEnv,
    // writers
    ensureHubMcpServer,
    disableBundledSessionMemoryHook,
    ensureMemoryConversationAccess,
    ensureMemoryStoreToolAllowed,
    ensureMemorySearchEmbeddings,
    ensureOpenClawPlugin,
    // resolvers + discovery
    resolveOllamaBaseUrl,
    resolveInferenceApiKey,
    resolveHubNumCtx,
    fetchOllamaModelCapabilities,
    discoverOllamaModels,
    // state queries
    getGatewayToken,
    isConfigured,
    warnIfConfigClobbered,
    // orchestrator
    reconcileConfig,
  };
}

module.exports = {
  createConfigReconciler,
  DEFAULT_PLUGIN_PATHS,
  DEFAULT_GATEWAY_PORT,
  MEMORY_EMBEDDING_PROVIDER,
  HUB_AUTHORITATIVE_ENV_KEYS,
  CI_PLUGIN_ID,
  CI_MEMORY_PLUGIN_ID,
  CI_HUB_PLUGIN_ID,
  // Stateless helpers: no I/O, no logging, no injected state.
  isPlainObject,
  ensureRecordPath,
  ensureArrayPath,
  removeArrayItem,
  hasCiServerCredentials,
  hasHubMcpCredentials,
  canonicalHubMcpUrl,
  normalizeEmbeddingsBaseUrl,
  isEmbeddingModel,
  buildOllamaModelEntry,
};
