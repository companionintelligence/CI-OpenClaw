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
 * constructs exactly ONE reconciler, so the first two live as long as the process; the
 * num_ctx memo is dropped at the start of every reconcile. Tests construct one per case
 * and get isolation for free.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** Internal port the OpenClaw gateway listens on (see server.cjs). */
const DEFAULT_GATEWAY_PORT = 18790;

const CI_PLUGIN_ID = "ci-runtime";
const CI_MEMORY_PLUGIN_ID = "companionintelligence";
const CI_HUB_PLUGIN_ID = "ci-hub";
const DUCKDUCKGO_PLUGIN_ID = "duckduckgo";
const BROWSER_PLUGIN_ID = "browser";
const CHROMIUM_EXECUTABLE_PATH = "/usr/bin/chromium";

/** Where the vendored plugins live inside the built image (see Dockerfile). */
const DEFAULT_PLUGIN_PATHS = {
  ciRuntime: "/app/openclaw-context/plugins/ci-runtime",
  ciMemory: "/app/openclaw-context/plugins/companionintelligence",
  ciHub: "/app/openclaw-context/plugins/ci-hub",
  duckduckgo: "/app/openclaw-context/plugins/duckduckgo",
};

// Treats the embeddings endpoint as an OpenAI-compatible /v1 server (which Ollama
// serves) and, unlike the bundled remote providers, requires no API key.
const MEMORY_EMBEDDING_PROVIDER = "openai-compatible";

// hooks.token is stored as an env reference, not the secret itself: OpenClaw resolves
// `${VAR}` across the whole config at load, so the Hub's wake secret never lands in
// openclaw.json. Same pattern as the ci-hub MCP server's `Bearer ${HUB_MCP_API_KEY}`.
const HOOKS_WAKE_TOKEN_ENV_REF = "${HUB_WAKE_SECRET}";

// Keys the Hub injects into the container environment as the source of truth.
// These must never be shadowed by a stale value persisted in .env — e.g. a
// token left behind by a prior install whose data dir survived an incomplete
// uninstall. For these keys the live container env wins, so an updated Hub
// config propagates on restart instead of the gateway re-reading the old token.
// Hub Settings → AI cloud tokens. Additive — never replace models.providers.ci-hub.
// Do not persist `hubManaged` on these entries: OpenClaw's schema rejects unknown
// keys and quarantines the whole file. Hub owns these four provider ids.
const HUB_CLOUD_PROVIDER_SPECS = [
  {
    id: "openai",
    api: "openai-completions",
    key: "CI_CLOUD_OPENAI_API_KEY",
    base: "CI_CLOUD_OPENAI_BASE_URL",
    model: "CI_CLOUD_OPENAI_MODEL",
  },
  {
    id: "anthropic",
    api: "anthropic-messages",
    key: "CI_CLOUD_ANTHROPIC_API_KEY",
    base: "CI_CLOUD_ANTHROPIC_BASE_URL",
    model: "CI_CLOUD_ANTHROPIC_MODEL",
  },
  {
    id: "google",
    api: "openai-completions",
    key: "CI_CLOUD_GOOGLE_API_KEY",
    base: "CI_CLOUD_GOOGLE_BASE_URL",
    model: "CI_CLOUD_GOOGLE_MODEL",
  },
  {
    id: "github-copilot",
    api: "openai-completions",
    key: "CI_CLOUD_GITHUB_COPILOT_API_KEY",
    base: "CI_CLOUD_GITHUB_COPILOT_BASE_URL",
    model: "CI_CLOUD_GITHUB_COPILOT_MODEL",
  },
];

/** Sidecar in the data dir recording the last Hub handout applied (see readHandoutRecord). */
const HANDOUT_RECORD_FILENAME = "ci-hub-handout.json";

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

/**
 * Walk to a nested config record, replacing any node on the way that is not a usable
 * record, and report whether anything had to be replaced.
 *
 * `replaced` is true iff at least one node on the path was not a record and was
 * overwritten — i.e. the config genuinely changed and openclaw.json must be rewritten.
 * Callers that maintain a `changed` flag MUST or-in `replaced`; getting this wrong is
 * invisible in the resulting config object and shows up only as a file that does (or
 * does not) get written, so the reporting is explicit rather than left to be
 * re-derived at each of the ~15 call sites.
 *
 * @returns {{ node: object, replaced: boolean }}
 */
function ensureRecordPathTracked(root, keys) {
  let current = root;
  let replaced = false;
  for (const key of keys) {
    if (!isPlainObject(current[key])) {
      current[key] = {};
      replaced = true;
    }
    current = current[key];
  }
  return { node: current, replaced };
}

// Walk to a nested config record, replacing any node that is not a usable record
// along the way, and return the leaf. Record counterpart to ensureArrayPath. Use
// ensureRecordPathTracked instead where a `changed` flag has to be maintained.
function ensureRecordPath(root, keys) {
  return ensureRecordPathTracked(root, keys).node;
}

/**
 * Walk to a nested array, coercing every node on the way (and the leaf itself) to a
 * usable type. Array counterpart to ensureRecordPath; returns the leaf array.
 */
function ensureArrayPath(root, keys) {
  const parent = ensureRecordPath(root, keys.slice(0, -1));
  const leaf = keys[keys.length - 1];
  if (!Array.isArray(parent[leaf])) {
    parent[leaf] = [];
  }
  return parent[leaf];
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
 * Whether two engine ids name the same model.
 *
 * The pool lists every untagged Lemonade file as `name:latest`. The Hub saves the
 * bare id. Only that implicit `:latest` is folded; a real tag (`qwen3:4b`) stays
 * verbatim, matching the Hub's `sameModelId`.
 */
function withLatestTag(id) {
  const slash = id.lastIndexOf("/");
  const colon = id.lastIndexOf(":");
  return colon > slash ? id : `${id}:latest`;
}

function sameModelId(a, b) {
  return a === b || withLatestTag(a) === withLatestTag(b);
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

/**
 * Decide agents.defaults.model.primary from what the pool has and what the Hub handed out.
 *
 * The fleet failure this exists for (2026-09-17): a node's Hub moved its default from
 * gemma3:1b — which cannot call tools — to qwen3-coder:30b, but the agent kept
 * `ci-hub/gemma3:1b` because that id was still installed, and every turn failed with
 * "gemma3:1b does not support tools". Three rules, in order:
 *
 *   1. A primary outside `ci-hub/` and `ollama/` is a cloud provider the operator chose.
 *      Leave it alone. An `ollama/` primary is a downloaded local model the picker stored;
 *      the Hub owns that default, so the next start returns the agent to the Hub choice.
 *      Otherwise a click on the old row survives every later Hub save.
 *   2. A `ci-hub/...` primary that is no longer in the ci-hub catalog, or that the pool
 *      REPORTS cannot call tools, is replaced. Unknown capabilities (a failed /api/show)
 *      are not a report and never move it.
 *   3. Otherwise, a primary equal to the one we last applied (`record.primary`) is ours
 *      and follows the current handout; any other primary is an operator's pick and stays.
 *      With no record (an install that predates it) we cannot tell, so a primary that
 *      agrees with the current handout stays and anything else is treated as stale.
 *
 * The Hub's own choice is `ci-hub/auto`: the Hub resolves `auto` itself, so the config
 * stays right across default changes without a rewrite. `auto` IS the Hub default,
 * though, so when the pool reports that model has no tool support the Hub choice steps
 * onto the first tool-capable installed model instead (added to the ci-hub catalog so the
 * ref resolves). If there is none, the Hub's pick stands and `toolless` says why turns
 * will fail.
 *
 * Pure: no I/O, no logging.
 *
 * @param {object} params
 * @param {unknown} params.existingPrimary  agents.defaults.model.primary as found.
 * @param {{defaultModel: string|null, primary: string}|null} params.record  Last handout applied.
 * @param {object[]} params.hubModels       The ci-hub catalog (`auto` plus the Hub target).
 * @param {string|null} params.hubTargetId  The installed model `auto` stands for.
 * @param {object[]} params.ollamaModels    Every installed chat model, in pool order.
 * @param {Record<string, boolean|null>} params.toolSupportById  From discoverOllamaModels.
 * @returns {{primary: string|null, hubPrimary: string|null, hubModels: object[],
 *            reason: string, toolless: string|null}}
 */
function resolveAgentPrimary({
  existingPrimary,
  record,
  hubModels,
  hubTargetId,
  ollamaModels,
  toolSupportById,
}) {
  const lacksTools = (id) => toolSupportById?.[id] === false;

  let catalog = hubModels;
  let hubPrimaryId = hubModels.some((model) => model.id === "auto")
    ? "auto"
    : hubTargetId ?? null;
  let toolless = null;
  if (hubPrimaryId && lacksTools(hubPrimaryId)) {
    toolless = hubTargetId ?? hubPrimaryId;
    const alternative = ollamaModels.find((model) => toolSupportById?.[model.id] === true);
    if (alternative) {
      hubPrimaryId = alternative.id;
      if (!catalog.some((model) => model.id === alternative.id)) {
        catalog = [...catalog, alternative];
      }
    }
  }
  const hubPrimary = hubPrimaryId ? `ci-hub/${hubPrimaryId}` : null;
  const decide = (primary, reason) => ({
    primary,
    hubPrimary,
    hubModels: catalog,
    reason,
    toolless,
  });

  if (typeof existingPrimary !== "string" || existingPrimary === "") {
    return decide(hubPrimary, "unset");
  }
  if (!existingPrimary.startsWith("ci-hub/")) {
    if (existingPrimary.startsWith("ollama/")) {
      return decide(hubPrimary, "local-catalog");
    }
    return decide(existingPrimary, "not-hub-managed");
  }
  const currentId = existingPrimary.slice("ci-hub/".length);
  if (!catalog.some((model) => model.id === currentId)) {
    return decide(hubPrimary, "not-in-catalog");
  }
  if (lacksTools(currentId)) {
    return decide(hubPrimary, "no-tool-support");
  }
  if (record) {
    return existingPrimary === record.primary
      ? decide(hubPrimary, "follows-handout")
      : decide(existingPrimary, "operator-choice");
  }
  return currentId === hubPrimaryId || currentId === hubTargetId
    ? decide(existingPrimary, "consistent-with-handout")
    : decide(hubPrimary, "stale");
}

// ---------------------------------------------------------------------------
// The reconciler.
// ---------------------------------------------------------------------------

/**
 * Construct a reconciler bound to one data directory.
 *
 * Production creates exactly one of these at module scope in server.cjs; the closure
 * state below (last-write timestamp, reported quarantines) therefore lives as long as
 * the process. The num_ctx memo lasts one reconcile. Tests create one per case.
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
  // Our own sidecar, NOT a key in openclaw.json: that schema is strict and an unknown key
  // quarantines the whole file. Deliberately not named `openclaw.json.*`, which is
  // OpenClaw's namespace for its backups and quarantine snapshots.
  const HANDOUT_FILE = path.join(configDir, HANDOUT_RECORD_FILENAME);

  const CI_PLUGIN_PATH = pluginPaths.ciRuntime;
  const CI_MEMORY_PLUGIN_PATH = pluginPaths.ciMemory;
  const CI_HUB_PLUGIN_PATH = pluginPaths.ciHub;
  const DUCKDUCKGO_PLUGIN_PATH =
    pluginPaths.duckduckgo || DEFAULT_PLUGIN_PATHS.duckduckgo;

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
        // Split on \r?\n: `.` and `$` (no /m flag) don't span a CR, so a CRLF-authored
        // line would otherwise fail the match and silently drop the key.
        content.split(/\r?\n/).forEach((line) => {
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
    } catch (e) {
      // Best-effort: a read-only mount or foreign owner must not break reconcile. But
      // this file holds the gateway token and provider keys, so a persistent failure to
      // tighten it must not be silent — surface it rather than leave it undetectable.
      log.warn(
        `Could not restrict ${path.basename(file)} to 0600: ${e.message}`,
      );
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

  /**
   * The Hub handout we last applied to agents.defaults.model.primary:
   * `{ defaultModel, primary }`, or null when none was ever recorded (fresh data dir, or
   * written by an image that predates the record).
   *
   * This is what tells a stale Hub value from an operator's choice. A primary equal to
   * `primary` here is the one WE set, so it follows the next handout; any other primary
   * was picked by someone and is kept for as long as it still works.
   */
  function readHandoutRecord() {
    try {
      const record = JSON.parse(fs.readFileSync(HANDOUT_FILE, "utf8"));
      if (isPlainObject(record) && typeof record.primary === "string") {
        return {
          defaultModel:
            typeof record.defaultModel === "string" ? record.defaultModel : null,
          primary: record.primary,
        };
      }
    } catch {
      // Missing or unreadable: behave as if nothing was recorded.
    }
    return null;
  }

  /** Persist the handout record, but only when it changed — a steady-state boot writes nothing. */
  function writeHandoutRecord(record) {
    const current = readHandoutRecord();
    if (
      current &&
      current.defaultModel === record.defaultModel &&
      current.primary === record.primary
    ) {
      return false;
    }
    fs.writeFileSync(
      HANDOUT_FILE,
      JSON.stringify({ ...record, appliedAt: new Date().toISOString() }, null, 2) + "\n",
      { mode: 0o600 },
    );
    restrictToOwner(HANDOUT_FILE);
    return true;
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

    const { node: servers, replaced } = ensureRecordPathTracked(config, ["mcp", "servers"]);
    let changed = replaced;

    const desired = {
      url,
      transport: "streamable-http",
      headers: { Authorization: "Bearer ${HUB_MCP_API_KEY}" },
      // OpenClaw 2026.9.1+: millisecond fields (legacy connectTimeout/timeout were seconds).
      connectionTimeoutMs: 60_000,
      requestTimeoutMs: 180_000,
    };

    const current = servers["ci-hub"];
    // Deep-equal on the small, fixed shape keeps reconcile idempotent. `changed` still
    // carries any replacement of a malformed mcp/servers node above, so coercing it
    // (a real config mutation) is reported even when the ci-hub entry is unchanged.
    if (JSON.stringify(current) === JSON.stringify(desired)) {
      return changed;
    }
    servers["ci-hub"] = desired;
    log.log(`Patched config: registered ci-hub MCP server (Streamable HTTP, ${url})`);
    return true;
  }

  /**
   * Turn off OpenClaw's own session-memory hook. Two active memory runtimes would
   * both observe the session; the CI plugin is the one we select, so the bundled hook
   * must stand down.
   */
  function disableBundledSessionMemoryHook(config) {
    const { node: entries, replaced } = ensureRecordPathTracked(config, [
      "hooks",
      "internal",
      "entries",
    ]);
    let changed = replaced;

    const entry = isPlainObject(entries["session-memory"])
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

  /**
   * Enable OpenClaw's native wake hook, so the Hub can push events to the agent.
   *
   * The Hub POSTs app crashes, backup results and system alerts to `POST /hooks/wake`
   * with `{ text, mode: "now" }`. OpenClaw answers by queueing a system event and
   * requesting an immediate heartbeat, which runs an agent turn. That is the whole
   * feature — no plugin code is involved. (The ci-hub plugin used to hand-roll its own
   * wake route; it never worked, and this replaces it. See CI-Hub#897.)
   *
   * `enabled` and `token` must be written together: OpenClaw's resolveHooksConfig returns
   * null unless `enabled === true`, and THROWS ("hooks.enabled requires hooks.token") when
   * enabled without a token — which would take the whole gateway down, not just the wake.
   * So with no HUB_WAKE_SECRET we leave the hook off entirely.
   *
   * The token is written as the literal env-template `${HUB_WAKE_SECRET}`, which OpenClaw
   * resolves at load (resolveConfigEnvVars walks the entire config). The raw secret is
   * never persisted to openclaw.json — same design as the ci-hub MCP server entry above.
   *
   * Re-asserted on every boot on purpose: `openclaw doctor` ROTATES hooks.token if it ever
   * collides with the gateway shared-secret auth, which would silently desync the Hub and
   * 401 every wake thereafter. Reconciling each boot heals that.
   */
  function ensureHooksWake(config, env) {
    const hasSecret = Boolean((env.HUB_WAKE_SECRET || "").trim());

    if (!hasSecret) {
      // Read `hooks` rather than ensure it: with nothing to write, conjuring an empty node
      // onto a config that never had one would churn the file on every boot.
      //
      // Only retract a hook WE wrote. An operator-authored hooks.token (any other value)
      // is theirs to keep; clearing it would break their integration.
      const existing = config.hooks;
      if (
        isPlainObject(existing) &&
        existing.enabled === true &&
        existing.token === HOOKS_WAKE_TOKEN_ENV_REF
      ) {
        // Retract every key we wrote, allowRequestSessionKey included — leaving it behind
        // would strand a `hooks: { allowRequestSessionKey: false }` node on a config that
        // never had a `hooks` key, which is the same churn the read-don't-ensure above avoids.
        delete existing.enabled;
        delete existing.token;
        delete existing.allowRequestSessionKey;
        // ...and if that emptied the node entirely, take the node with it. Another helper
        // (disableBundledSessionMemoryHook) may have put `internal` here; only drop `hooks`
        // when nothing else is using it.
        if (Object.keys(existing).length === 0) {
          delete config.hooks;
        }
        log.warn(
          "Patched config: disabled the wake hook — HUB_WAKE_SECRET is not set",
        );
        return true;
      }
      return false;
    }

    const { node: hooks, replaced } = ensureRecordPathTracked(config, ["hooks"]);
    let changed = replaced;

    // Do NOT set `hooks.path` here. The setup-server proxy (proxy-headers.cjs, HOOKS_PATH_PREFIX)
    // hardcodes the default `/hooks` mount to know which requests must keep the caller's own hook
    // token instead of the injected gateway token. Moving the mount here without updating that
    // constant would re-break the Hub's wake exactly as CI-Hub#897 — change both together.
    if (hooks.enabled !== true) {
      hooks.enabled = true;
      changed = true;
      log.log("Patched config: enabled OpenClaw's native wake hook (POST /hooks/wake)");
    }
    if (hooks.token !== HOOKS_WAKE_TOKEN_ENV_REF) {
      hooks.token = HOOKS_WAKE_TOKEN_ENV_REF;
      changed = true;
      log.log("Patched config: pointed hooks.token at the HUB_WAKE_SECRET env reference");
    }

    // `hooks.enabled` does not only serve /hooks/wake — it also serves /hooks/agent, which
    // runs an agent turn from a caller-supplied prompt. We do not use that path, and the
    // Hub never will.
    //
    // The knob that matters is allowRequestSessionKey: with it on, an /hooks/agent caller
    // holding the token could name the session to run in — including the user's own main
    // session. It defaults to false, but pin it, because a default is not a decision and a
    // future upstream flip would silently widen us. Off, a caller only ever gets an
    // isolated per-request `hook:<uuid>` session.
    if (hooks.allowRequestSessionKey !== false) {
      hooks.allowRequestSessionKey = false;
      changed = true;
      log.log("Patched config: pinned hooks.allowRequestSessionKey=false (no caller-chosen sessions)");
    }
    return changed;
  }

  /**
   * Opt a path-loaded (non-bundled) plugin into conversation hooks.
   *
   * OpenClaw 2.0+ blocks hooks like `before_prompt_build` / `agent_end` for
   * non-bundled plugins unless `plugins.entries.<id>.hooks.allowConversationAccess`
   * is true. `plugins.allow` only gates load — it does not grant this.
   */
  function ensurePluginConversationAccess(config, pluginId, label) {
    const { node: entries, replaced } = ensureRecordPathTracked(config, [
      "plugins",
      "entries",
    ]);
    let changed = replaced;

    const entry = isPlainObject(entries[pluginId]) ? entries[pluginId] : {};
    const hooks = isPlainObject(entry.hooks) ? entry.hooks : {};
    if (hooks.allowConversationAccess !== true) {
      hooks.allowConversationAccess = true;
      entry.hooks = hooks;
      entries[pluginId] = entry;
      changed = true;
      log.log(`Patched config: enabled conversation access for ${label}`);
    }
    return changed;
  }

  function ensureMemoryConversationAccess(config) {
    // The CI memory plugin's agent_end turn-sync is a conversation hook.
    return ensurePluginConversationAccess(
      config,
      CI_MEMORY_PLUGIN_ID,
      "CI memory turn-sync",
    );
  }

  // The CI plugin's tools that OpenClaw's onboarding profile (`tools.profile: "coding"`)
  // leaves out. That profile allows core tools plus group:memory (memory_search and
  // memory_get) and filters every other plugin tool before the model sees it, so these
  // are registered and still never reach the agent unless allowed here.
  const CI_MEMORY_EXTRA_TOOLS = ["memory_store", "ci_list_intents", "ci_run_intent"];

  /**
   * Allow the CI plugin's tools that the default tool profile filters out.
   *
   * `tools.alsoAllow` is the additive list and is always ensured. `tools.allow` is an
   * EXCLUSIVE allowlist: it is only appended to when the operator already maintains
   * one, because creating it here would silently deny every tool not named in it.
   */
  function ensureMemoryStoreToolAllowed(config) {
    const { node: tools, replaced } = ensureRecordPathTracked(config, ["tools"]);
    let changed = replaced;

    if (!Array.isArray(tools.alsoAllow)) {
      tools.alsoAllow = [];
      changed = true;
    }
    for (const name of CI_MEMORY_EXTRA_TOOLS) {
      if (!tools.alsoAllow.includes(name)) {
        tools.alsoAllow.push(name);
        changed = true;
        log.log(`Patched config: allowed Companion Intelligence ${name} tool`);
      }
      if (Array.isArray(tools.allow) && !tools.allow.includes(name)) {
        tools.allow.push(name);
        changed = true;
        log.log(`Patched config: added ${name} to explicit tool allowlist`);
      }
    }
    return changed;
  }

  // The Hub injects EMBEDDINGS_MODEL (e.g. nomic-embed-text) as a managed key, but
  // OpenClaw has no env-var path for embeddings — memory search resolves its provider
  // from top-level memory.search (moved off agents.defaults.memorySearch in 2026.9.1).
  // Left unset, the provider falls back to its "openai" default and semantic recall
  // silently tries api.openai.com with a key we don't have. "openai-compatible" points
  // it at the appliance's own Ollama /v1 instead, and needs no API key.
  function ensureMemorySearchEmbeddings(config, env) {
    const model = (env.EMBEDDINGS_MODEL || containerEnv.EMBEDDINGS_MODEL || "").trim();
    if (!model) return false;

    // resolveOllamaBaseUrl yields a native Ollama host (no /v1); tolerate an
    // OLLAMA_HOST that already carries the suffix rather than emitting /v1/v1.
    const ollamaBase = normalizeEmbeddingsBaseUrl(resolveOllamaBaseUrl(env));
    const baseUrl = ollamaBase.endsWith("/v1") ? ollamaBase : `${ollamaBase}/v1`;

    // Guard every node we spread or assign into: a hand-edited memory.search that is
    // a scalar or array would otherwise spread into index-keyed junk, producing the
    // very kind of schema-invalid config that gets the whole file clobbered.
    const { node: memory, replaced } = ensureRecordPathTracked(config, ["memory"]);
    let changed = replaced;
    const current = isPlainObject(memory.search) ? memory.search : {};
    const currentRemote = isPlainObject(current.remote) ? current.remote : {};

    // Drop a legacy agents.defaults.memorySearch block if present — unrecognized on
    // 2026.9.1 and would quarantine the whole file if left behind.
    if (
      isPlainObject(config.agents) &&
      isPlainObject(config.agents.defaults) &&
      "memorySearch" in config.agents.defaults
    ) {
      delete config.agents.defaults.memorySearch;
      changed = true;
      log.log("Patched config: removed legacy agents.defaults.memorySearch");
    }

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
    if (JSON.stringify(memory.search) !== JSON.stringify(next)) {
      memory.search = next;
      changed = true;
      log.log(
        `Patched config: memory search embeddings -> ${model} @ ${baseUrl}`,
      );
      if (droppedApiKey) {
        // Never log the value, only that it is gone.
        log.log(
          "Patched config: dropped memory search remote.apiKey — it belonged to the previous embeddings endpoint",
        );
      }
    }
    return changed;
  }

  /**
   * Appliance FUX: free web search + page reading without the onboarding search wizard.
   *
   * CI setup intentionally passes `--skip-search` so QuickStart stays API-key-only.
   * OpenClaw never auto-selects key-free search providers, so we:
   *   1. Path-load the image-baked DuckDuckGo plugin
   *   2. Set tools.web.search.provider=duckduckgo when unset (do not clobber Brave/etc.)
   *   3. Enable the bundled browser tool (outside the coding profile by default) and
   *      point it at the image Chromium with Docker-safe headless/noSandbox flags
   *
   * web_fetch stays on OpenClaw's built-in keyless reader; we do not force Firecrawl.
   */
  function ensureWebAccessDefaults(config) {
    let changed = false;

    changed =
      ensureOpenClawPlugin(
        config,
        DUCKDUCKGO_PLUGIN_ID,
        DUCKDUCKGO_PLUGIN_PATH,
        "DuckDuckGo search",
      ) || changed;

    const search = ensureRecordPathTracked(config, ["tools", "web", "search"]);
    changed = search.replaced || changed;
    if (search.node.enabled !== true) {
      search.node.enabled = true;
      changed = true;
      log.log("Patched config: enabled tools.web.search");
    }
    const provider = search.node.provider;
    if (provider == null || provider === "") {
      search.node.provider = DUCKDUCKGO_PLUGIN_ID;
      changed = true;
      log.log("Patched config: set tools.web.search.provider=duckduckgo (free default)");
    }

    const fetch = ensureRecordPathTracked(config, ["tools", "web", "fetch"]);
    changed = fetch.replaced || changed;
    if (fetch.node.enabled !== true) {
      fetch.node.enabled = true;
      changed = true;
      log.log("Patched config: enabled tools.web.fetch");
    }

    const { node: tools, replaced: toolsReplaced } = ensureRecordPathTracked(
      config,
      ["tools"],
    );
    changed = toolsReplaced || changed;
    if (!Array.isArray(tools.alsoAllow)) {
      tools.alsoAllow = [];
      changed = true;
    }
    if (!tools.alsoAllow.includes("browser")) {
      tools.alsoAllow.push("browser");
      changed = true;
      log.log("Patched config: allowed browser tool via tools.alsoAllow");
    }
    // tools.allow is exclusive — only extend an allowlist the operator already keeps.
    if (Array.isArray(tools.allow) && !tools.allow.includes("browser")) {
      tools.allow.push("browser");
      changed = true;
      log.log("Patched config: added browser to existing tools.allow");
    }

    const browser = ensureRecordPathTracked(config, ["browser"]);
    changed = browser.replaced || changed;
    if (browser.node.enabled !== true) {
      browser.node.enabled = true;
      changed = true;
      log.log("Patched config: enabled browser");
    }
    if (
      browser.node.executablePath == null ||
      browser.node.executablePath === ""
    ) {
      browser.node.executablePath = CHROMIUM_EXECUTABLE_PATH;
      changed = true;
      log.log(`Patched config: browser.executablePath=${CHROMIUM_EXECUTABLE_PATH}`);
    }
    if (browser.node.headless !== true) {
      browser.node.headless = true;
      changed = true;
      log.log("Patched config: browser.headless=true");
    }
    if (browser.node.noSandbox !== true) {
      browser.node.noSandbox = true;
      changed = true;
      log.log("Patched config: browser.noSandbox=true (container)");
    }

    const { node: plugins, replaced: pluginsReplaced } = ensureRecordPathTracked(
      config,
      ["plugins"],
    );
    changed = pluginsReplaced || changed;
    if (plugins.enabled !== true) {
      plugins.enabled = true;
      changed = true;
      log.log("Patched config: enabled plugins");
    }

    const { node: entries, replaced: entriesReplaced } = ensureRecordPathTracked(
      config,
      ["plugins", "entries"],
    );
    changed = entriesReplaced || changed;
    const browserEntry = isPlainObject(entries[BROWSER_PLUGIN_ID])
      ? entries[BROWSER_PLUGIN_ID]
      : {};
    if (browserEntry.enabled !== true) {
      browserEntry.enabled = true;
      entries[BROWSER_PLUGIN_ID] = browserEntry;
      changed = true;
      log.log("Patched config: enabled browser plugin");
    }

    if (
      Array.isArray(plugins.allow) &&
      plugins.allow.length > 0 &&
      !plugins.allow.includes(BROWSER_PLUGIN_ID)
    ) {
      plugins.allow.push(BROWSER_PLUGIN_ID);
      changed = true;
      log.log("Patched config: added browser plugin to allow list");
    }

    return changed;
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

    const { node: plugins, replaced } = ensureRecordPathTracked(config, ["plugins"]);
    let changed = replaced;

    if (plugins.enabled !== true) {
      plugins.enabled = true;
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
      if (Array.isArray(plugins.deny) && removeArrayItem(plugins.deny, pluginId)) {
        changed = true;
        log.log(`Patched config: removed ${label} plugin from deny list`);
      }

      const allowedPlugins = plugins.allow;
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

    const { node: entries, replaced: entriesReplaced } = ensureRecordPathTracked(
      config,
      ["plugins", "entries"],
    );
    changed = entriesReplaced || changed;

    // Guard the entry itself, not just its parent. A hand-edited scalar here is truthy,
    // so `entries[pluginId] || {}` would keep the string; assigning .enabled to it
    // no-ops in sloppy mode, the string is written back unchanged, and `changed` is set
    // on EVERY boot — an invalid config rewritten in an endless loop.
    const entry = isPlainObject(entries[pluginId]) ? entries[pluginId] : {};
    const nextEnabled = enableEntry;
    if (entry.enabled !== nextEnabled) {
      entry.enabled = nextEnabled;
      entries[pluginId] = entry;
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

  function resolveEnvValue(env, key) {
    return String(env[key] || containerEnv[key] || "").trim();
  }

  /**
   * Register every Hub-saved cloud provider alongside ci-hub. Local Ollama/vLLM
   * stays models.providers.ci-hub. Schema-safe fields only — no hubManaged.
   */
  function syncCloudProviders(config, env, providers) {
    let changed = false;
    // Registering a cloud provider in models.providers doesn't make it selectable —
    // it also needs an entry in agents.defaults.models, the same way the ci-hub and
    // ollama catalogs do a few hundred lines up. Only touch a spec's own `${id}/*`
    // keys when this sync actually owns that id this run (it's Hub-managed now, or
    // it was a moment ago) — an unrelated hand-authored `anthropic/...` entry with no
    // Hub key and no prior models.providers.anthropic is not ours to prune.
    //
    // Resolve every spec's apiKey/current up front so we can also tell, before
    // touching anything, whether no cloud provider is or was ever active — a config
    // with zero Hub cloud creds must not gain an empty agents.defaults node.
    const specStates = HUB_CLOUD_PROVIDER_SPECS.map((spec) => ({
      spec,
      apiKey: resolveEnvValue(env, spec.key),
      current: isPlainObject(providers.node[spec.id])
        ? providers.node[spec.id]
        : null,
    }));
    const anyActive = specStates.some(({ apiKey, current }) => apiKey || current);
    const defaults = anyActive
      ? ensureRecordPathTracked(config, ["agents", "defaults"])
      : null;
    if (defaults) {
      changed = defaults.replaced || changed;
    }
    const existingModels = defaults && isPlainObject(defaults.node.models)
      ? defaults.node.models
      : {};
    const mergedModels = { ...existingModels };
    let modelsChanged = false;
    for (const { spec, apiKey, current } of specStates) {
      if (!apiKey) {
        if (current) {
          delete providers.node[spec.id];
          changed = true;
          log.log(
            `Patched config: removed ${spec.id} cloud provider (Hub key absent)`,
          );
          for (const key of Object.keys(mergedModels)) {
            if (key.startsWith(`${spec.id}/`)) {
              delete mergedModels[key];
              modelsChanged = true;
            }
          }
        }
        continue;
      }
      const baseUrl = resolveEnvValue(env, spec.base);
      const modelId = resolveEnvValue(env, spec.model);
      const models = modelId
        ? [
            {
              id: modelId,
              name: modelId,
              input: ["text"],
              contextWindow: 200000,
              maxTokens: 8192,
              compat: { supportsTools: true },
            },
          ]
        : [];
      const next = {
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        api: spec.api,
        models,
      };
      const comparable = current
        ? Object.fromEntries(
            Object.entries(current).filter(([key]) => key !== "hubManaged"),
          )
        : null;
      if (JSON.stringify(comparable) !== JSON.stringify(next)) {
        providers.node[spec.id] = next;
        changed = true;
        log.log(`Patched config: synced ${spec.id} cloud provider`);
      }
      const desiredKey = modelId ? `${spec.id}/${modelId}` : null;
      for (const key of Object.keys(mergedModels)) {
        if (key.startsWith(`${spec.id}/`) && key !== desiredKey) {
          delete mergedModels[key];
          modelsChanged = true;
        }
      }
      if (desiredKey && !(desiredKey in mergedModels)) {
        mergedModels[desiredKey] = existingModels[desiredKey] || {};
        modelsChanged = true;
      }
    }
    if (defaults && modelsChanged) {
      defaults.node.models = mergedModels;
      changed = true;
      log.log("Patched config: merged cloud provider model options");
    }
    return changed;
  }

  // Hardware-aware context window injected by the Hub (CI_LLM_NUM_CTX). Caps both
  // the agent's token budget and the native Ollama num_ctx so OpenClaw doesn't pack
  // to Ollama's oversized memory-based default (e.g. 262144 on unified-memory APUs).
  // Memoized for one reconcile, since buildOllamaModelEntry is called once per discovered
  // model. reconcileConfig drops it: a Hub that answers after start (hub-handout-retry.cjs)
  // can change it while this process runs.
  let hubNumCtx;
  function resolveHubNumCtx() {
    if (hubNumCtx !== undefined) return hubNumCtx;
    const raw = containerEnv.CI_LLM_NUM_CTX || readEnv().CI_LLM_NUM_CTX || "";
    const n = Number.parseInt(raw, 10);
    hubNumCtx = Number.isFinite(n) && n > 0 ? n : null;
    return hubNumCtx;
  }

  // Idle-timeout floor for the Hub-managed providers (`models.providers.<id>.timeoutSeconds`).
  // OpenClaw's watchdog counts from the request until the first streamed byte, and a Hub
  // engine sends nothing until the whole prompt is prefilled — so the budget has to cover the
  // pool's queue wait plus a full-window prefill. Measured 2026-09-20 on core-2 through the
  // pool: a ~45k-token agent turn prefills at 450-600 tok/s on Strix Halo, first byte at
  // 70-85 s plus queue time; the previous ten-minute default was still short of the 900 s
  // that fixed the installs by hand. Budget the Hub's window at half the measured rate (for
  // slower engines and a busy pool) plus five minutes of queue headroom, never under 900 s.
  // CI_LLM_TIMEOUT_SECONDS (container, then .env) replaces the derived floor outright.
  const SELF_HOSTED_PROVIDER_TIMEOUT_SECONDS = 900;
  const PREFILL_TOKENS_PER_SECOND = 300;
  const POOL_QUEUE_HEADROOM_SECONDS = 300;
  function resolveProviderTimeoutSeconds() {
    const raw =
      containerEnv.CI_LLM_TIMEOUT_SECONDS || readEnv().CI_LLM_TIMEOUT_SECONDS || "";
    const explicit = Number.parseInt(raw, 10);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const numCtx = resolveHubNumCtx();
    const derived = numCtx
      ? Math.ceil(numCtx / PREFILL_TOKENS_PER_SECOND) + POOL_QUEUE_HEADROOM_SECONDS
      : 0;
    return Math.max(SELF_HOSTED_PROVIDER_TIMEOUT_SECONDS, derived);
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
      // Whether Ollama actually answered. A failed /api/show still yields an entry (with
      // every capability off), but "we could not ask" is not "the model cannot call tools",
      // and only the latter may move the agent's primary model.
      known: payload != null,
      supportsTools: caps.includes("tools"),
      reasoning: caps.includes("thinking"),
      vision: caps.includes("vision"),
      contextLimit,
    };
  }

  /**
   * Build the Ollama model catalog from what Ollama actually has installed.
   *
   * Returns every non-embedding tag (for models.providers.ollama) and prepends an
   * "auto" alias pointing at DEFAULT_MODEL (or the first model) so ci-hub can keep a
   * stable Hub-default selection without listing the whole local fleet.
   *
   * `toolSupportById` maps each returned id (auto included) to true/false when Ollama
   * reported capabilities, or null when /api/show failed and nobody knows.
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
    const toolSupportById = {};
    const toolSupport = (capabilities) =>
      capabilities.known ? capabilities.supportsTools === true : null;
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
      toolSupportById[id] = toolSupport(capabilities);
      return true;
    };

    for (const model of discovered) {
      await addModel(model?.id, model?.id);
    }

    // Match the tag the pool actually listed. `name` and `name:latest` are one model;
    // an exact `discoveredIds.has` misses the bare id and leaves Hub Auto on whichever
    // tag came back first, at that tag's context window.
    const defaultModelAvailable = defaultModel
      ? (discovered.find(
          (model) => typeof model?.id === "string" && sameModelId(model.id, defaultModel),
        )?.id ?? null)
      : null;
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
      toolSupportById.auto = toolSupport(autoCapabilities);
    }

    return { models, defaultModelAvailable, firstModelId, toolSupportById };
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
   * A missing openclaw.json is created from scratch when the app is already configured
   * (the Hub handed out inference settings, or a provider key exists) — see below. With
   * nothing configured (pre-onboarding, the setup wizard's job) it no-ops and creates
   * nothing.
   */
  async function reconcileConfig() {
    hubNumCtx = undefined;
    // A quarantine is not confined to the doctor call — the gateway also rejects the
    // config it reads at spawn, and the fresh-onboarding path skips doctor entirely.
    // Report anything that appeared since our last write before reconciling again.
    // No-op on first boot, when we have not written anything to attribute it to.
    if (configWrittenAtMs) warnIfConfigClobbered(configWrittenAtMs);

    let changed = false;
    let config = readConfig();
    // Fresh data dir on a Hub-configured app: there is no openclaw.json yet, but the
    // gateway is about to start anyway (isConfigured() is what startOpenclaw gates on).
    // Returning early here used to hand the empty dir to `openclaw doctor --repair`,
    // which writes a minimal config with no models section — and the gateway came up on
    // it "not onboarded", falling back to a default model whose harness the image does
    // not ship (beta-max: `Agent harness runtime "codex" is unavailable`), until the
    // container happened to restart. Build the config here instead, so doctor validates
    // a complete one, exactly as on every later boot.
    //
    // Only when the file is ABSENT. readConfig() also returns null for a file that exists
    // but cannot be parsed (and has no usable .bak); overwriting that would destroy
    // whatever an operator could still recover from it.
    if (config === null && !fs.existsSync(CONFIG_FILE) && isConfigured()) {
      config = {};
      changed = true;
      log.log("Patched config: created openclaw.json from the Hub handout (fresh data dir)");
    }
    // Bail on a non-record top-level config (a hand-edited array or scalar): walking it
    // as a record would either attach named props that JSON.stringify silently drops
    // (an array churns the file every boot) or throw on the second path segment. Such a
    // config is corrupt beyond reconcile's remit — readConfig's .bak recovery and the
    // gateway's own refusal to start are the right handlers.
    if (!isPlainObject(config)) return;
    const env = readEnv();

    // CI-Server credentials may be supplied as container environment variables
    // (the Hub injects them this way) rather than written into the .env file.
    // Mirror bootstrap-ci-memory.sh, which reads process.env, so the setup-server
    // reconcile activates CI memory consistently regardless of where creds live.
    // Same precedence as buildChildEnv(): the live container value wins over a
    // stale .env, so e.g. a Hub CI_SERVER_ENABLED="false" actually disables memory.
    applyHubAuthoritativeEnv(env);

    // The handout record to persist once openclaw.json is written (see writeHandoutRecord).
    let pendingHandoutRecord = null;

    // Control UI behind the CI app proxy: trust rewritten local Origins.
    // OpenClaw 2026.9.1 removed gateway.controlUi.allowInsecureAuth; device-auth
    // kill-switch dangerouslyDisableDeviceAuth is inert — do not write either.
    // Record-guard rather than truthiness-guard: a hand-edited `"gateway": "local"`
    // is truthy, so `if (!config.gateway)` would leave a primitive and later
    // assignments no-op / throw.
    const controlUi = ensureRecordPathTracked(config, ["gateway", "controlUi"]);
    changed = controlUi.replaced || changed;
    if ("allowInsecureAuth" in controlUi.node) {
      delete controlUi.node.allowInsecureAuth;
      changed = true;
      log.log("Patched config: removed retired allowInsecureAuth");
    }
    if ("dangerouslyDisableDeviceAuth" in controlUi.node) {
      delete controlUi.node.dangerouslyDisableDeviceAuth;
      changed = true;
      log.log("Patched config: removed inert dangerouslyDisableDeviceAuth");
    }

    // The CI setup proxy rewrites Host/Origin to the local gateway origin.
    // Make sure that rewritten origin is explicitly trusted by the Control UI.
    if (!Array.isArray(controlUi.node.allowedOrigins)) {
      controlUi.node.allowedOrigins = [];
      changed = true;
    }
    const requiredOrigins = [
      `http://127.0.0.1:${gatewayPort}`,
      `http://localhost:${gatewayPort}`,
    ];
    for (const origin of requiredOrigins) {
      if (!controlUi.node.allowedOrigins.includes(origin)) {
        controlUi.node.allowedOrigins.push(origin);
        changed = true;
        log.log(`Patched config: added allowed origin ${origin}`);
      }
    }

    // Disable update checks (updates are managed by the CI marketplace via Docker image bumps)
    const update = ensureRecordPathTracked(config, ["update"]);
    changed = update.replaced || changed;
    if (update.node.checkOnStart !== false) {
      update.node.checkOnStart = false;
      changed = true;
      log.log("Patched config: disabled update check on start");
    }

    // Enable CI-managed context through OpenClaw's supported plugin surface.
    // The runtime plugin also ships a `ci` skill, so one load path covers both the
    // always-on runtime context and deeper on-demand guidance. OpenClaw 2.0+ also
    // requires conversation-hook opt-in for path-loaded plugins' before_prompt_build.
    changed =
      ensureOpenClawPlugin(config, CI_PLUGIN_ID, CI_PLUGIN_PATH, "CI runtime") ||
      changed;
    changed =
      ensurePluginConversationAccess(
        config,
        CI_PLUGIN_ID,
        "CI runtime context",
      ) || changed;

    // Install the Companion Intelligence memory plugin as a selectable active
    // memory backend. Keep the entry disabled until selected so OpenClaw does not
    // load two active memory runtimes.
    const currentMemorySlot = isPlainObject(config.plugins?.slots)
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
        const slots = ensureRecordPathTracked(config, ["plugins", "slots"]);
        changed = slots.replaced || changed;
        if (slots.node.memory !== CI_MEMORY_PLUGIN_ID) {
          slots.node.memory = CI_MEMORY_PLUGIN_ID;
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

    // Let the Hub push events to the agent through OpenClaw's own wake hook
    // (POST /hooks/wake), gated on HUB_WAKE_SECRET. This is the transport the Hub's
    // agent-notify module targets; the ci-hub plugin's hand-rolled wake route never
    // worked and is being retired (CI-Hub#897).
    changed = ensureHooksWake(config, env) || changed;

    // Free web search + Chromium browser for appliance FUX (replaces --skip-search).
    changed = ensureWebAccessDefaults(config) || changed;

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
    const auth = ensureRecordPathTracked(config, ["gateway", "auth"]);
    changed = auth.replaced || changed;
    if (!auth.node.token) {
      auth.node.token = crypto.randomBytes(24).toString("hex");
      changed = true;
      log.log("Patched config: generated gateway auth token");
    }

    // Required since openclaw 2026.3.7 when auth is configured.
    // Always forced to "token" — the proxy only speaks Bearer token auth.
    if (auth.node.mode !== "token") {
      auth.node.mode = "token";
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

    // OpenClaw 2026.9.1 defaults container bind to "auto" → 0.0.0.0. The published
    // app port is the setup proxy (18789); only that process should reach the
    // gateway on 127.0.0.1:18790. Schema bind modes are auto/loopback/lan/tailnet/
    // custom — not a raw host. Same pin as the stock marketplace OpenClaw entrypoint.
    if (config.gateway.bind !== "loopback") {
      config.gateway.bind = "loopback";
      changed = true;
      log.log("Patched config: set gateway.bind to loopback");
    }

    // Name the port the gateway really listens on. server.cjs starts it with
    // `--port <gatewayPort>`, but that flag lives only on that one process: every OTHER
    // openclaw command in the container (`openclaw agent`, `sessions`, `status`, and the
    // agent's own shell calls) resolves the port from here and otherwise defaults to
    // 18789 — which in this image is the SETUP PROXY, not the gateway. The proxy rewrites
    // Origin for the browser Control UI, so the gateway treats the CLI as a browser
    // client and refuses every write: `missing scope: operator.write` (core-3, beta-1,
    // core-6 on 2026-09-17). Pointed straight at the gateway, the CLI authenticates with
    // this file's gateway.auth.token and gets its normal operator scopes. Precedence is
    // --port > OPENCLAW_GATEWAY_PORT > gateway.port, so the gateway process is unaffected.
    if (config.gateway.port !== gatewayPort) {
      config.gateway.port = gatewayPort;
      changed = true;
      log.log(
        `Patched config: set gateway.port to ${gatewayPort} so the in-container CLI reaches the gateway, not the setup proxy`,
      );
    }

    // Mirror Hub-managed inference into OpenClaw:
    //   - models.providers.ci-hub  → Hub default / "auto" only (stable appliance primary)
    //   - models.providers.ollama  → full local tag catalog when Ollama is reachable
    // Both use api:"ollama" against the same host; model refs differ (ci-hub/X vs ollama/X).
    // The newer gateway does not switch providers just because OPENAI_API_* is present;
    // it needs concrete provider entries plus an agent default model selection.
    const ollamaBaseUrl = resolveOllamaBaseUrl(env);
    const inferenceApiKey = resolveInferenceApiKey(env);
    const defaultModel = env.DEFAULT_MODEL || containerEnv.DEFAULT_MODEL || "";

    const models = ensureRecordPathTracked(config, ["models"]);
    changed = models.replaced || changed;
    if (models.node.mode !== "merge") {
      models.node.mode = "merge";
      changed = true;
      log.log("Patched config: set model catalog mode to merge");
    }
    const providers = ensureRecordPathTracked(config, ["models", "providers"]);
    changed = providers.replaced || changed;

    // Guard provider entries before spreading. A hand-edited string
    // ("ci-hub": "http://host:11434") is truthy, so `|| {}` keeps it, and `{...string}`
    // spreads into {"0":"h","1":"t",...} — index-keyed junk that is schema-invalid and
    // gets the ENTIRE openclaw.json quarantined on the next boot.
    // OpenClaw's model idle timeout follows `models.providers.<id>.timeoutSeconds`, and its
    // built-in default is sized for a hosted API that answers in seconds. A Hub-managed engine
    // is not that: the first byte of a streamed reply arrives only after the model is loaded and
    // the prompt evaluated, and an agent turn here is ~160 KB of system prompt, tool schemas and
    // history. The default watchdog gave up at ~2 min every time, retried (re-sending the whole
    // prompt), and surfaced "The model did not produce a response before the model idle
    // timeout". The floor is a Hub-derived budget (resolveProviderTimeoutSeconds): an operator
    // who raised it keeps their number, one who lowered it — or a config written by an older
    // image with a shorter default — is brought up to it.
    const providerTimeoutSeconds = resolveProviderTimeoutSeconds();

    function syncOllamaApiProvider(providerId, label) {
      const current = isPlainObject(providers.node[providerId])
        ? providers.node[providerId]
        : {};
      const next = {
        ...current,
        baseUrl: ollamaBaseUrl,
        apiKey: inferenceApiKey,
        api: "ollama",
        timeoutSeconds: Math.max(
          providerTimeoutSeconds,
          Number.isFinite(current.timeoutSeconds) ? current.timeoutSeconds : 0,
        ),
        models: Array.isArray(current.models) ? current.models : [],
      };
      if (
        current.baseUrl !== next.baseUrl ||
        current.apiKey !== next.apiKey ||
        current.api !== next.api ||
        current.timeoutSeconds !== next.timeoutSeconds ||
        !Array.isArray(current.models)
      ) {
        providers.node[providerId] = next;
        changed = true;
        log.log(
          `Patched config: synced ${label} Ollama provider (${ollamaBaseUrl})`,
        );
      }
      return next;
    }

    const nextHubProvider = syncOllamaApiProvider("ci-hub", "ci-hub");
    const nextOllamaProvider = syncOllamaApiProvider("ollama", "ollama");

    try {
      const {
        models: discoveredModels,
        defaultModelAvailable,
        firstModelId,
        toolSupportById,
      } = await discoverOllamaModels(ollamaBaseUrl, defaultModel);

      if (discoveredModels.length > 0) {
        const hubTargetId = defaultModelAvailable || firstModelId;
        const ollamaModels = discoveredModels.filter(
          (model) => model.id !== "auto",
        );

        // Decided before the catalogs are written: when the Hub default cannot call
        // tools, the decision adds a tool-capable model to the ci-hub catalog.
        const existingPrimary =
          isPlainObject(config.agents) &&
          isPlainObject(config.agents.defaults) &&
          isPlainObject(config.agents.defaults.model)
            ? config.agents.defaults.model.primary
            : undefined;
        const decision = resolveAgentPrimary({
          existingPrimary,
          record: readHandoutRecord(),
          hubModels: discoveredModels.filter(
            (model) =>
              model.id === "auto" ||
              (hubTargetId != null && model.id === hubTargetId),
          ),
          hubTargetId,
          ollamaModels,
          toolSupportById,
        });
        const hubModels = decision.hubModels;
        if (decision.toolless) {
          log.warn(
            decision.hubPrimary &&
              toolSupportById[decision.hubPrimary.slice("ci-hub/".length)] === true
              ? `The pool reports the Hub default model ${decision.toolless} cannot call tools; ` +
                  `using ${decision.hubPrimary} as the agent's model instead`
              : `The pool reports the Hub default model ${decision.toolless} cannot call tools, ` +
                  "and no installed model can — agent turns will fail until one is installed",
          );
        }
        if (
          JSON.stringify(nextHubProvider.models || []) !==
          JSON.stringify(hubModels)
        ) {
          providers.node["ci-hub"] = {
            ...nextHubProvider,
            models: hubModels,
          };
          changed = true;
          log.log(
            `Patched config: synced ${hubModels.length} ci-hub Hub default model(s)`,
          );
        }

        if (
          JSON.stringify(nextOllamaProvider.models || []) !==
          JSON.stringify(ollamaModels)
        ) {
          providers.node.ollama = {
            ...nextOllamaProvider,
            models: ollamaModels,
          };
          changed = true;
          log.log(
            `Patched config: synced ${ollamaModels.length} ollama local model(s)`,
          );
        }

        const defaults = ensureRecordPathTracked(config, ["agents", "defaults"]);
        changed = defaults.replaced || changed;

        // Guard before enumerating: Object.entries("abc") yields index keys, which
        // would survive the ci-hub/ / ollama/ filter straight into the merged record.
        const existingModels = isPlainObject(defaults.node.models)
          ? defaults.node.models
          : {};
        // Mutate in place rather than filter-then-rebuild: a filtered-and-reinserted
        // object always re-appends ci-hub/ollama keys after whatever other-prefixed
        // keys (e.g. a cloud provider's) happened to precede them, which reorders the
        // record and makes `changed` fire on an otherwise-idempotent reconcile every
        // time a non-ci-hub/ollama key is also present.
        const desiredModelKeys = new Set([
          ...hubModels.map((model) => `ci-hub/${model.id}`),
          ...ollamaModels.map((model) => `ollama/${model.id}`),
        ]);
        let modelsChanged = false;
        for (const key of Object.keys(existingModels)) {
          if (
            (key.startsWith("ci-hub/") || key.startsWith("ollama/")) &&
            !desiredModelKeys.has(key)
          ) {
            delete existingModels[key];
            modelsChanged = true;
          }
        }
        for (const key of desiredModelKeys) {
          if (!(key in existingModels)) {
            existingModels[key] = {};
            modelsChanged = true;
          }
        }
        if (modelsChanged) {
          defaults.node.models = existingModels;
          changed = true;
          log.log("Patched config: merged ci-hub + ollama model options");
        }

        // The chat menu asks for models.list view=configured, and that view is
        // agents.defaults.modelPolicy.allow. OpenClaw copies a legacy allowlist into
        // it once and then does not extend it when the catalog grows, so a node that
        // started with one small model keeps showing only that model. Rewrite the
        // local refs on every sync. Refs for other providers stay; an empty allow
        // would open the whole built-in catalog.
        const policy = ensureRecordPathTracked(config, ["agents", "defaults", "modelPolicy"]);
        changed = policy.replaced || changed;
        const currentAllow = Array.isArray(policy.node.allow)
          ? policy.node.allow.filter((ref) => typeof ref === "string")
          : [];
        const keptAllow = currentAllow.filter(
          (ref) => !ref.startsWith("ci-hub/") && !ref.startsWith("ollama/"),
        );
        const nextAllow = [...desiredModelKeys, ...keptAllow];
        if (JSON.stringify(currentAllow) !== JSON.stringify(nextAllow)) {
          policy.node.allow = nextAllow;
          changed = true;
          log.log(`Patched config: set model allow list to ${nextAllow.length} chat model(s)`);
        }

        if (decision.primary) {
          // Record-guard the node we assign .primary into: on a scalar the assignment
          // silently no-ops, so `changed` would be set on every boot forever.
          const model = ensureRecordPathTracked(config, ["agents", "defaults", "model"]);
          changed = model.replaced || changed;
          if (model.node.primary !== decision.primary) {
            const was = typeof existingPrimary === "string" && existingPrimary
              ? existingPrimary
              : null;
            const why = {
              "not-in-catalog": `${was} is no longer in the ci-hub catalog`,
              "no-tool-support": `the pool reports ${was} cannot call tools`,
              "follows-handout": `following the Hub handout (DEFAULT_MODEL=${defaultModel || "unset"}); was ${was}`,
              "local-catalog": `${was} is a downloaded local model; the Hub default takes over`,
              stale: `${was} is a stale Hub default`,
            }[decision.reason];
            model.node.primary = decision.primary;
            changed = true;
            log.log(
              `Patched config: set default agent model to ${decision.primary}` +
                (why ? ` (${why})` : ""),
            );
          }
        }
        if (decision.hubPrimary) {
          pendingHandoutRecord = {
            defaultModel: defaultModel || null,
            primary: decision.hubPrimary,
          };
        }
      } else {
        log.warn(
          `No Ollama chat models discovered at ${ollamaBaseUrl}; preserving existing ci-hub and ollama model catalogs`,
        );
      }
    } catch (error) {
      log.warn(
        `Failed to sync Ollama model catalogs: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (syncCloudProviders(config, env, providers)) {
      changed = true;
    }

    if (defaultModel && !config.agents?.defaults?.model?.primary) {
      const model = ensureRecordPathTracked(config, ["agents", "defaults", "model"]);
      changed = model.replaced || changed;
      const nextPrimaryModel = `ci-hub/${defaultModel}`;
      if (model.node.primary !== nextPrimaryModel) {
        model.node.primary = nextPrimaryModel;
        changed = true;
        log.log(`Patched config: set default agent model to ${nextPrimaryModel}`);
      }
      // We chose it, so the next boot with a reachable pool may move it.
      pendingHandoutRecord ??= { defaultModel, primary: nextPrimaryModel };
    }

    // Safety net for nodes reconcile only rewrites on an ACTIVE feature path. When
    // Ollama is unreachable and no CI-Server/Hub creds are set, discovery throws and
    // the memory + Hub-MCP blocks skip, so a hand-edited scalar at agents/tools/hooks/
    // mcp is never coerced — yet the gateway-token write still sets `changed`, so it
    // gets serialized verbatim and openclaw's strict schema quarantines the WHOLE file
    // (reverting the token in the same pass). Coerce any that are present-but-not-a-
    // record; leave absent ones absent so a minimal config gains no empty nodes, and a
    // well-formed one is untouched.
    for (const key of ["agents", "tools", "hooks", "mcp"]) {
      if (key in config && !isPlainObject(config[key])) {
        config[key] = {};
        changed = true;
        log.log(`Patched config: replaced malformed ${key} node with an empty record`);
      }
    }
    if (
      isPlainObject(config.plugins) &&
      "slots" in config.plugins &&
      !isPlainObject(config.plugins.slots)
    ) {
      config.plugins.slots = {};
      changed = true;
      log.log("Patched config: replaced malformed plugins.slots node with an empty record");
    }

    if (changed) {
      writeConfig(config);
    }
    // After the config, never before: a record naming a primary that never reached
    // openclaw.json would make the next boot mistake an operator's pick for ours.
    if (pendingHandoutRecord) {
      writeHandoutRecord(pendingHandoutRecord);
    }

    // Sync gateway token to .env so the proxy always has it
    const token = auth.node.token;
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
    readHandoutRecord,
    ensureConfigDir,
    buildChildEnv,
    applyHubAuthoritativeEnv,
    // writers
    ensureHubMcpServer,
    ensureHooksWake,
    disableBundledSessionMemoryHook,
    ensureMemoryConversationAccess,
    ensurePluginConversationAccess,
    ensureMemoryStoreToolAllowed,
    ensureMemorySearchEmbeddings,
    ensureWebAccessDefaults,
    ensureOpenClawPlugin,
    // resolvers + discovery
    resolveOllamaBaseUrl,
    resolveInferenceApiKey,
    resolveHubNumCtx,
    resolveProviderTimeoutSeconds,
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
  HUB_CLOUD_PROVIDER_SPECS,
  CI_PLUGIN_ID,
  CI_MEMORY_PLUGIN_ID,
  CI_HUB_PLUGIN_ID,
  DUCKDUCKGO_PLUGIN_ID,
  BROWSER_PLUGIN_ID,
  CHROMIUM_EXECUTABLE_PATH,
  HOOKS_WAKE_TOKEN_ENV_REF,
  HANDOUT_RECORD_FILENAME,
  // Stateless helpers: no I/O, no logging, no injected state.
  resolveAgentPrimary,
  isPlainObject,
  ensureRecordPath,
  ensureRecordPathTracked,
  ensureArrayPath,
  removeArrayItem,
  hasCiServerCredentials,
  hasHubMcpCredentials,
  canonicalHubMcpUrl,
  normalizeEmbeddingsBaseUrl,
  isEmbeddingModel,
  buildOllamaModelEntry,
};
