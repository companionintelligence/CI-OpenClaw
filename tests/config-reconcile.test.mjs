// Tests for config-reconcile.cjs — the layer that writes openclaw.json.
//
// Why this file exists: OpenClaw's config schema is strict, so ONE unrecognized key
// invalidates the entire file. `doctor --repair` then quarantines it and restores
// last-known-good, silently reverting everything written in the same pass. A one-word
// typo (`options` where the schema says `params`) once disabled CI-Memory on an
// appliance with no error on any channel. Nothing in this repo could have caught it.
//
// Run: node --test    (from the repo root)

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import {
  buildOllamaModelEntry,
  canonicalHubMcpUrl,
  hasCiServerCredentials,
  hasHubMcpCredentials,
  isEmbeddingModel,
  isPlainObject,
  ensureRecordPath,
  ensureRecordPathTracked,
  ensureArrayPath,
  removeArrayItem,
  normalizeEmbeddingsBaseUrl,
  makeDataDir,
  makeReconciler,
  withOllama,
  assertNoIndexKeys,
  readCfg,
  cfgPath,
  envPath,
  rmDir,
  CATALOG,
  OLLAMA_DOWN,
  PLUGIN_PATHS,
} from "./helpers/reconcile-fixture.mjs";

// POSIX mode bits are not representable on Windows: NTFS has no group/other
// permission and Node's chmod maps 0o600 onto the read-only attribute only, so
// `mode & 0o777` reads back 0o666 there. The production target for these files is
// the Linux container, where the assertion is real — on Windows we assert the file
// was written at all and let the mode go, rather than leave a permanently red suite
// that hides genuine breakage from anyone developing on Windows.
function assertPrivateFileMode(filePath, message) {
  if (process.platform === "win32") {
    // isFile(), not just existsSync: a directory at this path satisfies "exists"
    // while meaning the write went somewhere quite different from a config file.
    // Short-circuited so a missing path reports as a failed assertion rather than
    // an ENOENT thrown out of statSync.
    assert.ok(
      fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
      message ?? `${filePath} must exist as a regular file`,
    );
    return;
  }
  assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600, message);
}

let dataDir;
afterEach(() => {
  rmDir(dataDir);
  dataDir = undefined;
});

/** CI-Server memory credentials, as the Hub injects them. */
const MEM = { CI_SERVER_URL: "http://ci-server:3030", CI_SERVER_TOKEN: "t" };
/** Hub MCP credentials. */
const HUB = { HUB_URL: "https://hub.example", HUB_MCP_API_KEY: "hub-key" };

// ---------------------------------------------------------------------------
// buildOllamaModelEntry — the model-entry shape and the context clamp.
// ---------------------------------------------------------------------------
describe("buildOllamaModelEntry", () => {
  // THE motivating regression. `options: { num_ctx }` is not in OpenClaw's model
  // schema; the unrecognized key invalidates the ENTIRE openclaw.json, doctor
  // quarantines the file, and every other patch from the same pass — memory slot,
  // plugin wiring, gateway token — is silently reverted. This is the tripwire.
  test("puts num_ctx under params, never options", () => {
    const entry = buildOllamaModelEntry(
      "llama3.1:8b",
      "Llama",
      { supportsTools: true, contextLimit: 131072 },
      8192,
    );
    assert.deepStrictEqual(entry.params, { num_ctx: 8192 });
    assert.ok(!("options" in entry), "a model entry must never carry an `options` key");
  });

  // Generalizes the above: ANY unrecognized top-level key on a model entry is a
  // whole-file risk, so the key set is pinned as a set. Adding one must be a
  // deliberate edit here — and the schema gate then proves the new key is legal.
  test("emits only the keys OpenClaw's model schema recognizes", () => {
    const entry = buildOllamaModelEntry("m", "M", { contextLimit: 32000 }, 8192);
    assert.deepStrictEqual(Object.keys(entry).sort(), [
      "compat",
      "contextWindow",
      "cost",
      "id",
      "input",
      "maxTokens",
      "name",
      "params",
      "reasoning",
    ]);
  });

  test("caps num_ctx at the model's own context window", () => {
    // numCtx is sized for the Hub's big chat model; a 4k model would reject it.
    const entry = buildOllamaModelEntry("llava:7b", "LLaVA", { contextLimit: 4096 }, 131072);
    assert.strictEqual(entry.params.num_ctx, 4096);
    assert.strictEqual(entry.contextWindow, 4096);
  });

  test("uses num_ctx verbatim when it fits inside the model window", () => {
    const entry = buildOllamaModelEntry("llama3.1:8b", "L", { contextLimit: 131072 }, 16384);
    assert.strictEqual(entry.params.num_ctx, 16384);
    assert.strictEqual(entry.contextWindow, 16384);
  });

  test("falls back to the 32000 default window when the model limit is unknown", () => {
    const entry = buildOllamaModelEntry("mystery", "M", {}, 131072);
    assert.strictEqual(entry.params.num_ctx, 32000);
    assert.strictEqual(entry.contextWindow, 32000);
  });

  test("omits params entirely when no num_ctx is configured", () => {
    const entry = buildOllamaModelEntry("llama3.1:8b", "L", { contextLimit: 131072 }, null);
    assert.ok(!("params" in entry), "no num_ctx means no params key at all");
    assert.strictEqual(entry.contextWindow, 32000, "historical default");
  });

  test("clamps contextWindow to a small model window even with no num_ctx", () => {
    const entry = buildOllamaModelEntry("llava:7b", "L", { contextLimit: 4096 }, null);
    assert.strictEqual(entry.contextWindow, 4096);
  });

  test("maxTokens never exceeds contextWindow", () => {
    const small = buildOllamaModelEntry("tiny", "T", { contextLimit: 1024 }, null);
    assert.strictEqual(small.maxTokens, 1024);
    const big = buildOllamaModelEntry("big", "B", { contextLimit: 131072 }, 65536);
    assert.strictEqual(big.maxTokens, 4096);
    for (const entry of [small, big]) {
      assert.ok(entry.maxTokens <= entry.contextWindow);
    }
  });

  test("maps ollama capabilities onto the entry", () => {
    const tools = buildOllamaModelEntry("a", "A", { supportsTools: true }, null);
    assert.strictEqual(tools.compat.supportsTools, true);

    const thinking = buildOllamaModelEntry("b", "B", { reasoning: true }, null);
    assert.strictEqual(thinking.reasoning, true);

    const vision = buildOllamaModelEntry("c", "C", { vision: true }, null);
    assert.deepStrictEqual(vision.input, ["text", "image"]);
  });

  test("defaults to text-only, tools-off when capabilities are missing entirely", () => {
    const entry = buildOllamaModelEntry("x", "X", undefined, null);
    assert.deepStrictEqual(entry.input, ["text"]);
    assert.strictEqual(entry.compat.supportsTools, false);
    assert.strictEqual(entry.reasoning, false);
    assert.strictEqual(entry.name, "X");
  });

  test("falls back to the model id when no display name is given", () => {
    assert.strictEqual(buildOllamaModelEntry("only-id", "", {}, null).name, "only-id");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe("pure helpers", () => {
  test("isPlainObject rejects arrays, scalars and null", () => {
    assert.strictEqual(isPlainObject({}), true);
    assert.strictEqual(isPlainObject([]), false);
    assert.strictEqual(isPlainObject("s"), false);
    assert.strictEqual(isPlainObject(0), false);
    assert.strictEqual(isPlainObject(null), false);
    assert.strictEqual(isPlainObject(undefined), false);
  });

  test("ensureRecordPath replaces unusable nodes on the way down", () => {
    const root = { a: "scalar" };
    const leaf = ensureRecordPath(root, ["a", "b"]);
    leaf.x = 1;
    assert.deepStrictEqual(root, { a: { b: { x: 1 } } });
  });

  test("ensureRecordPath preserves existing records", () => {
    const root = { a: { keep: true } };
    ensureRecordPath(root, ["a", "b"]);
    assert.strictEqual(root.a.keep, true);
  });

  test("ensureArrayPath coerces the leaf to an array", () => {
    const root = { a: { b: "not-an-array" } };
    const arr = ensureArrayPath(root, ["a", "b"]);
    arr.push(1);
    assert.deepStrictEqual(root.a.b, [1]);
  });

  test("removeArrayItem removes every occurrence and reports whether it did", () => {
    const items = ["a", "b", "a"];
    assert.strictEqual(removeArrayItem(items, "a"), true);
    assert.deepStrictEqual(items, ["b"]);
    assert.strictEqual(removeArrayItem(items, "zzz"), false);
  });

  test("isEmbeddingModel matches embedding models, not chat models", () => {
    assert.strictEqual(isEmbeddingModel("nomic-embed-text"), true);
    assert.strictEqual(isEmbeddingModel("mxbai-embed-large"), true);
    assert.strictEqual(isEmbeddingModel("llama3.1:8b"), false);
    assert.strictEqual(isEmbeddingModel(""), false);
    assert.strictEqual(isEmbeddingModel(undefined), false);
  });

  test("normalizeEmbeddingsBaseUrl strips trailing slashes and tolerates non-strings", () => {
    assert.strictEqual(normalizeEmbeddingsBaseUrl("http://x:1/v1//"), "http://x:1/v1");
    assert.strictEqual(normalizeEmbeddingsBaseUrl("  http://x:1  "), "http://x:1");
    assert.strictEqual(normalizeEmbeddingsBaseUrl(undefined), "");
    assert.strictEqual(normalizeEmbeddingsBaseUrl(42), "");
  });

  test("hasCiServerCredentials needs url + token, and honours the literal string 'false'", () => {
    const creds = { CI_SERVER_URL: "http://ci", CI_SERVER_TOKEN: "t" };
    assert.strictEqual(hasCiServerCredentials(creds), true);
    assert.strictEqual(hasCiServerCredentials({ ...creds, CI_SERVER_ENABLED: "false" }), false);
    // These arrive from the environment as strings; only the literal "false" disables.
    assert.strictEqual(hasCiServerCredentials({ ...creds, CI_SERVER_ENABLED: "true" }), true);
    assert.strictEqual(hasCiServerCredentials({ CI_SERVER_URL: "http://ci" }), false);
    assert.strictEqual(hasCiServerCredentials({}), false);
  });

  test("hasHubMcpCredentials accepts either base url and honours HUB_MCP_ENABLED=false", () => {
    assert.strictEqual(hasHubMcpCredentials({ HUB_URL: "https://h", HUB_MCP_API_KEY: "k" }), true);
    assert.strictEqual(hasHubMcpCredentials({ HUB_MCP_URL: "https://h", HUB_MCP_API_KEY: "k" }), true);
    assert.strictEqual(
      hasHubMcpCredentials({ HUB_URL: "https://h", HUB_MCP_API_KEY: "k", HUB_MCP_ENABLED: "false" }),
      false,
    );
    assert.strictEqual(hasHubMcpCredentials({ HUB_URL: "https://h" }), false);
  });
});

// ---------------------------------------------------------------------------
// canonicalHubMcpUrl
// ---------------------------------------------------------------------------
describe("canonicalHubMcpUrl", () => {
  test("derives HUB_URL + /api/mcp", () => {
    assert.strictEqual(canonicalHubMcpUrl({ HUB_URL: "https://hub.x" }), "https://hub.x/api/mcp");
  });

  test("prefers HUB_MCP_URL over HUB_URL", () => {
    assert.strictEqual(
      canonicalHubMcpUrl({ HUB_URL: "https://a", HUB_MCP_URL: "https://b/api/mcp" }),
      "https://b/api/mcp",
    );
  });

  // CI-Hub removed the /sse route; a legacy injected URL must be normalized DOWN, not
  // have /api/mcp appended to it.
  test("normalizes a legacy /api/mcp/sse suffix down to /api/mcp", () => {
    assert.strictEqual(
      canonicalHubMcpUrl({ HUB_MCP_URL: "https://hub.x/api/mcp/sse" }),
      "https://hub.x/api/mcp",
    );
  });

  test("does not double an existing /api/mcp suffix", () => {
    assert.strictEqual(
      canonicalHubMcpUrl({ HUB_MCP_URL: "https://hub.x/api/mcp" }),
      "https://hub.x/api/mcp",
    );
  });

  test("appends /api/mcp to a bare host", () => {
    assert.strictEqual(canonicalHubMcpUrl({ HUB_MCP_URL: "https://hub.x" }), "https://hub.x/api/mcp");
  });

  test("strips trailing slashes before deciding", () => {
    assert.strictEqual(canonicalHubMcpUrl({ HUB_URL: "https://hub.x///" }), "https://hub.x/api/mcp");
    assert.strictEqual(
      canonicalHubMcpUrl({ HUB_MCP_URL: "https://hub.x/api/mcp/" }),
      "https://hub.x/api/mcp",
    );
  });

  test("returns an empty string when no base url is configured", () => {
    assert.strictEqual(canonicalHubMcpUrl({}), "");
    assert.strictEqual(canonicalHubMcpUrl({ HUB_URL: "   " }), "");
  });
});

// ---------------------------------------------------------------------------
// ensureHubMcpServer
// ---------------------------------------------------------------------------
describe("ensureHubMcpServer", () => {
  const HUB = { HUB_URL: "https://hub.x", HUB_MCP_API_KEY: "secret-key" };
  let ctx;
  beforeEach(() => {
    dataDir = makeDataDir();
    ctx = makeReconciler(dataDir);
  });

  test("registers ci-hub with the streamable-http transport and timeouts", () => {
    const config = {};
    assert.strictEqual(ctx.cfg.ensureHubMcpServer(config, HUB), true);
    assert.deepStrictEqual(config.mcp.servers["ci-hub"], {
      url: "https://hub.x/api/mcp",
      transport: "streamable-http",
      headers: { Authorization: "Bearer ${HUB_MCP_API_KEY}" },
      connectionTimeoutMs: 60000,
      requestTimeoutMs: 180000,
    });
  });

  // The Bearer value is an env TEMPLATE that OpenClaw resolves at activation. The raw
  // key must never reach openclaw.json — that file is world-readable inside the app.
  test("never persists the raw API key, only the env template", () => {
    const config = {};
    ctx.cfg.ensureHubMcpServer(config, HUB);
    assert.ok(
      !JSON.stringify(config).includes("secret-key"),
      "the raw HUB_MCP_API_KEY must not be serialized into openclaw.json",
    );
  });

  test("is idempotent: a second call reports no change", () => {
    const config = {};
    assert.strictEqual(ctx.cfg.ensureHubMcpServer(config, HUB), true);
    assert.strictEqual(ctx.cfg.ensureHubMcpServer(config, HUB), false);
  });

  test("rewrites the entry when the Hub URL changes", () => {
    const config = {};
    ctx.cfg.ensureHubMcpServer(config, HUB);
    assert.strictEqual(
      ctx.cfg.ensureHubMcpServer(config, { ...HUB, HUB_URL: "https://moved.x" }),
      true,
    );
    assert.strictEqual(config.mcp.servers["ci-hub"].url, "https://moved.x/api/mcp");
  });

  test("removes a stale entry when the credentials disappear", () => {
    const config = {};
    ctx.cfg.ensureHubMcpServer(config, HUB);
    assert.strictEqual(ctx.cfg.ensureHubMcpServer(config, {}), true);
    assert.strictEqual(config.mcp.servers["ci-hub"], undefined);
  });

  test("removes the entry when HUB_MCP_ENABLED=false", () => {
    const config = {};
    ctx.cfg.ensureHubMcpServer(config, HUB);
    assert.strictEqual(
      ctx.cfg.ensureHubMcpServer(config, { ...HUB, HUB_MCP_ENABLED: "false" }),
      true,
    );
    assert.strictEqual(config.mcp.servers["ci-hub"], undefined);
  });

  test("reports no change when disabled and there was nothing to remove", () => {
    assert.strictEqual(ctx.cfg.ensureHubMcpServer({}, {}), false);
  });

  test("preserves other MCP servers", () => {
    const config = { mcp: { servers: { other: { url: "https://other" } } } };
    ctx.cfg.ensureHubMcpServer(config, HUB);
    assert.deepStrictEqual(config.mcp.servers.other, { url: "https://other" });
  });
});

// ---------------------------------------------------------------------------
// ensureMemorySearchEmbeddings — including the stale-credential drop.
// ---------------------------------------------------------------------------
// The Hub pushes app crashes and system alerts to OpenClaw's NATIVE wake hook
// (POST /hooks/wake). It stays dark unless hooks.enabled is true AND hooks.token is set,
// so the two must always be written together — and never separately. See CI-Hub#897.
describe("ensureHooksWake", () => {
  const WAKE = { HUB_WAKE_SECRET: "wake-secret-abc" };
  let ctx;
  beforeEach(() => {
    dataDir = makeDataDir();
    ctx = makeReconciler(dataDir);
  });

  test("enables the hook and points the token at the env reference", () => {
    const config = {};
    assert.strictEqual(ctx.cfg.ensureHooksWake(config, WAKE), true);
    assert.strictEqual(config.hooks.enabled, true);
    assert.strictEqual(config.hooks.token, "${HUB_WAKE_SECRET}");
  });

  // hooks.enabled serves /hooks/agent as well as /hooks/wake. We only use wake, and a
  // token-holder must never be able to name the session an agent run lands in — that would
  // reach the user's own conversation. The upstream default is already false; pin it, so a
  // future default flip cannot silently widen us.
  test("pins allowRequestSessionKey=false so no caller can choose a session", () => {
    const config = {};
    ctx.cfg.ensureHooksWake(config, WAKE);
    assert.strictEqual(config.hooks.allowRequestSessionKey, false);
  });

  test("re-pins allowRequestSessionKey if it is flipped on", () => {
    const config = { hooks: { enabled: true, token: "${HUB_WAKE_SECRET}", allowRequestSessionKey: true } };
    assert.strictEqual(ctx.cfg.ensureHooksWake(config, WAKE), true);
    assert.strictEqual(config.hooks.allowRequestSessionKey, false);
  });

  // Same rule as the MCP Bearer: openclaw.json is readable inside the app, so the secret
  // itself must never land there. OpenClaw resolves ${VAR} across the whole config on load.
  test("never persists the raw wake secret, only the env template", () => {
    const config = {};
    ctx.cfg.ensureHooksWake(config, WAKE);
    assert.ok(
      !JSON.stringify(config).includes("wake-secret-abc"),
      "the raw HUB_WAKE_SECRET must not be serialized into openclaw.json",
    );
  });

  // enabled-without-token makes OpenClaw THROW at config resolve ("hooks.enabled requires
  // hooks.token"), which takes down the whole gateway rather than just the wake. So with
  // no secret we must leave the hook off entirely, not half-on.
  test("does not enable the hook when HUB_WAKE_SECRET is absent", () => {
    const config = {};
    assert.strictEqual(ctx.cfg.ensureHooksWake(config, {}), false);
    assert.strictEqual(config.hooks?.enabled, undefined);
    assert.strictEqual(config.hooks?.token, undefined);
  });

  // Retract everything we wrote, allowRequestSessionKey included — and take the `hooks` node
  // with it if that emptied it. A config that never had a `hooks` key must not be left with
  // `hooks: { allowRequestSessionKey: false }`; that is file churn on every boot, and it breaks
  // the repo's "hooks must not be conjured onto a config that never had it" invariant.
  test("retracts a hook it previously wrote once the secret goes away", () => {
    const config = {};
    ctx.cfg.ensureHooksWake(config, WAKE);
    assert.strictEqual(ctx.cfg.ensureHooksWake(config, {}), true);
    assert.strictEqual(config.hooks, undefined);
  });

  // ...but only the node, not a neighbour's keys. The bundled session-memory hook lives under
  // the same `hooks` parent and is written by a different helper.
  test("retracting the wake hook leaves the session-memory hook intact", () => {
    const config = {};
    ctx.cfg.disableBundledSessionMemoryHook(config);
    ctx.cfg.ensureHooksWake(config, WAKE);

    assert.strictEqual(ctx.cfg.ensureHooksWake(config, {}), true);
    assert.strictEqual(config.hooks.enabled, undefined);
    assert.strictEqual(config.hooks.token, undefined);
    assert.strictEqual(config.hooks.allowRequestSessionKey, undefined);
    assert.strictEqual(config.hooks.internal.entries["session-memory"].enabled, false);
  });

  // Only retract what WE wrote. An operator's own hooks integration is theirs to keep.
  test("leaves an operator-authored token alone when the secret is absent", () => {
    const config = { hooks: { enabled: true, token: "operators-own-token" } };
    assert.strictEqual(ctx.cfg.ensureHooksWake(config, {}), false);
    assert.strictEqual(config.hooks.enabled, true);
    assert.strictEqual(config.hooks.token, "operators-own-token");
  });

  // `openclaw doctor` ROTATES hooks.token if it ever collides with the gateway
  // shared-secret auth. That would silently desync the Hub and 401 every wake, so the
  // reconcile must re-assert the env reference on the next boot.
  test("re-asserts the token after doctor rotates it", () => {
    const config = { hooks: { enabled: true, token: "rotated-by-doctor" } };
    assert.strictEqual(ctx.cfg.ensureHooksWake(config, WAKE), true);
    assert.strictEqual(config.hooks.token, "${HUB_WAKE_SECRET}");
  });

  test("is idempotent", () => {
    const config = {};
    assert.strictEqual(ctx.cfg.ensureHooksWake(config, WAKE), true);
    assert.strictEqual(ctx.cfg.ensureHooksWake(config, WAKE), false);
  });

  // The bundled session-memory hook lives under the same `hooks` node. Enabling the wake
  // must not clobber it (and vice versa) — they are written by different helpers.
  test("coexists with the bundled session-memory hook", () => {
    const config = {};
    ctx.cfg.disableBundledSessionMemoryHook(config);
    ctx.cfg.ensureHooksWake(config, WAKE);
    assert.strictEqual(config.hooks.enabled, true);
    assert.strictEqual(config.hooks.token, "${HUB_WAKE_SECRET}");
    assert.strictEqual(config.hooks.internal.entries["session-memory"].enabled, false);
  });

  // A hand-edited scalar at `hooks` would otherwise be spread into {"0":"o","1":"n",...}
  // and invalidate the entire config. ensureRecordPathTracked coerces it; assert we report
  // that coercion as a change, and that nothing index-keyed survives.
  test("coerces a malformed scalar hooks node", () => {
    const config = { hooks: "on" };
    assert.strictEqual(ctx.cfg.ensureHooksWake(config, WAKE), true);
    assert.strictEqual(config.hooks.enabled, true);
    assertNoIndexKeys(config);
  });
});

describe("ensureMemorySearchEmbeddings", () => {
  let ctx;
  beforeEach(() => {
    dataDir = makeDataDir();
    ctx = makeReconciler(dataDir);
  });

  test("no-ops and reports no change without EMBEDDINGS_MODEL", () => {
    const config = {};
    assert.strictEqual(ctx.cfg.ensureMemorySearchEmbeddings(config, {}), false);
    assert.deepStrictEqual(config, {}, "nothing may be written without a model");
  });

  test("points memory search at the local Ollama /v1 endpoint", () => {
    const config = {};
    const env = { EMBEDDINGS_MODEL: "nomic-embed-text", OLLAMA_HOST: "http://ollama:11434" };
    assert.strictEqual(ctx.cfg.ensureMemorySearchEmbeddings(config, env), true);
    assert.deepStrictEqual(config.memory.search, {
      provider: "openai-compatible",
      model: "nomic-embed-text",
      remote: { baseUrl: "http://ollama:11434/v1" },
    });
  });

  test("is idempotent: the second call reports no change", () => {
    const config = {};
    const env = { EMBEDDINGS_MODEL: "nomic-embed-text", OLLAMA_HOST: "http://ollama:11434" };
    assert.strictEqual(ctx.cfg.ensureMemorySearchEmbeddings(config, env), true);
    const snapshot = JSON.stringify(config);
    assert.strictEqual(ctx.cfg.ensureMemorySearchEmbeddings(config, env), false);
    assert.strictEqual(JSON.stringify(config), snapshot, "node must be byte-identical");
  });

  test("does not append a second /v1 when OLLAMA_HOST already carries one", () => {
    const config = {};
    const env = { EMBEDDINGS_MODEL: "nomic-embed-text", OLLAMA_HOST: "http://ollama:11434/v1" };
    ctx.cfg.ensureMemorySearchEmbeddings(config, env);
    assert.strictEqual(config.memory.search.remote.baseUrl, "http://ollama:11434/v1");
  });

  test("derives the base url from OPENAI_API_BASE when OLLAMA_HOST is unset", () => {
    const config = {};
    const env = { EMBEDDINGS_MODEL: "nomic-embed-text", OPENAI_API_BASE: "http://ollama:11434/v1" };
    ctx.cfg.ensureMemorySearchEmbeddings(config, env);
    assert.strictEqual(config.memory.search.remote.baseUrl, "http://ollama:11434/v1");
  });

  // An apiKey in the remote block was issued FOR the endpoint the config names. If we
  // repoint embeddings elsewhere, carrying it across would send a credential to a host
  // it was never issued for.
  test("drops a stale remote.apiKey when the baseUrl is repointed", () => {
    const config = {
      memory: {
        search: {
          provider: "openai-compatible",
          remote: { baseUrl: "http://old:11434/v1", apiKey: "key-for-the-OLD-host" },
        },
      },
    };
    const env = { EMBEDDINGS_MODEL: "nomic-embed-text", OLLAMA_HOST: "http://new:11434" };
    assert.strictEqual(ctx.cfg.ensureMemorySearchEmbeddings(config, env), true);
    const remote = config.memory.search.remote;
    assert.strictEqual(remote.baseUrl, "http://new:11434/v1");
    assert.ok(!("apiKey" in remote), "a credential issued for the old host must not follow it");
  });

  test("drops a stale remote.apiKey when the provider changes", () => {
    const config = {
      memory: {
        search: {
          provider: "openai",
          remote: { baseUrl: "http://ollama:11434/v1", apiKey: "openai-key" },
        },
      },
    };
    const env = { EMBEDDINGS_MODEL: "nomic-embed-text", OLLAMA_HOST: "http://ollama:11434" };
    assert.strictEqual(ctx.cfg.ensureMemorySearchEmbeddings(config, env), true);
    assert.ok(!("apiKey" in config.memory.search.remote));
  });

  test("preserves remote.apiKey when provider and endpoint are unchanged", () => {
    const config = {
      memory: {
        search: {
          provider: "openai-compatible",
          model: "nomic-embed-text",
          remote: { baseUrl: "http://ollama:11434/v1", apiKey: "operator-key" },
        },
      },
    };
    const env = { EMBEDDINGS_MODEL: "nomic-embed-text", OLLAMA_HOST: "http://ollama:11434" };
    assert.strictEqual(ctx.cfg.ensureMemorySearchEmbeddings(config, env), false);
    assert.strictEqual(config.memory.search.remote.apiKey, "operator-key");
  });

  // A trailing slash spells the SAME endpoint. Treating it as a repoint would delete an
  // operator's credential for a host we are not actually moving away from.
  test("treats a trailing slash as the same endpoint: no rewrite, no key drop", () => {
    const config = {
      memory: {
        search: {
          provider: "openai-compatible",
          model: "nomic-embed-text",
          remote: { baseUrl: "http://ollama:11434/v1", apiKey: "operator-key" },
        },
      },
    };
    const env = { EMBEDDINGS_MODEL: "nomic-embed-text", OLLAMA_HOST: "http://ollama:11434/" };
    assert.strictEqual(ctx.cfg.ensureMemorySearchEmbeddings(config, env), false);
    assert.strictEqual(config.memory.search.remote.apiKey, "operator-key");
  });

  test("never logs the dropped key's value", () => {
    const config = {
      memory: {
        search: {
          provider: "openai-compatible",
          remote: { baseUrl: "http://old:11434/v1", apiKey: "super-secret" },
        },
      },
    };
    ctx.cfg.ensureMemorySearchEmbeddings(config, {
      EMBEDDINGS_MODEL: "nomic-embed-text",
      OLLAMA_HOST: "http://new:11434",
    });
    assert.ok(
      !ctx.logs.join("\n").includes("super-secret"),
      "the dropped credential must never be logged",
    );
    assert.ok(ctx.logs.some((l) => l.includes("dropped memory search remote.apiKey")));
  });

  test("preserves unrelated memory.search keys while repointing", () => {
    const config = { memory: { search: { topK: 7 } } };
    ctx.cfg.ensureMemorySearchEmbeddings(config, {
      EMBEDDINGS_MODEL: "nomic-embed-text",
      OLLAMA_HOST: "http://ollama:11434",
    });
    assert.strictEqual(config.memory.search.topK, 7);
  });

  test("removes legacy agents.defaults.memorySearch when writing memory.search", () => {
    const config = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            remote: { baseUrl: "http://old:11434/v1" },
          },
        },
      },
    };
    const env = { EMBEDDINGS_MODEL: "nomic-embed-text", OLLAMA_HOST: "http://ollama:11434" };
    assert.strictEqual(ctx.cfg.ensureMemorySearchEmbeddings(config, env), true);
    assert.ok(!("memorySearch" in (config.agents?.defaults || {})));
    assert.deepStrictEqual(config.memory.search, {
      provider: "openai-compatible",
      model: "nomic-embed-text",
      remote: { baseUrl: "http://ollama:11434/v1" },
    });
  });

  test("reads EMBEDDINGS_MODEL from the container env when .env lacks it", () => {
    const withContainer = makeReconciler(dataDir, {
      containerEnv: { EMBEDDINGS_MODEL: "nomic-embed-text" },
    });
    const config = {};
    assert.strictEqual(
      withContainer.cfg.ensureMemorySearchEmbeddings(config, { OLLAMA_HOST: "http://o:1" }),
      true,
    );
    assert.strictEqual(config.memory.search.model, "nomic-embed-text");
  });
});

// ---------------------------------------------------------------------------
// ensureOpenClawPlugin
// ---------------------------------------------------------------------------
describe("ensureOpenClawPlugin", () => {
  const RUNTIME = PLUGIN_PATHS.ciRuntime;
  let ctx;
  beforeEach(() => {
    dataDir = makeDataDir();
    ctx = makeReconciler(dataDir);
  });

  // Writing a load path for a directory that does not exist would make OpenClaw reject
  // the whole config — worse than doing nothing.
  test("warns and mutates nothing when the plugin directory is missing", () => {
    const config = {};
    const missing = path.join(dataDir, "does-not-exist");
    assert.strictEqual(ctx.cfg.ensureOpenClawPlugin(config, "x", missing, "X"), false);
    assert.deepStrictEqual(config, {});
    assert.ok(ctx.logs.some((l) => l.includes("not found")));
  });

  test("enables plugins, registers the load path and enables the entry", () => {
    const config = {};
    assert.strictEqual(ctx.cfg.ensureOpenClawPlugin(config, "ci-runtime", RUNTIME, "CI runtime"), true);
    assert.strictEqual(config.plugins.enabled, true);
    assert.deepStrictEqual(config.plugins.load.paths, [RUNTIME]);
    assert.strictEqual(config.plugins.entries["ci-runtime"].enabled, true);
  });

  test("is idempotent and does not duplicate the load path", () => {
    const config = {};
    ctx.cfg.ensureOpenClawPlugin(config, "ci-runtime", RUNTIME, "CI runtime");
    assert.strictEqual(ctx.cfg.ensureOpenClawPlugin(config, "ci-runtime", RUNTIME, "CI runtime"), false);
    assert.deepStrictEqual(config.plugins.load.paths, [RUNTIME]);
  });

  test("removes the plugin from an existing deny list", () => {
    const config = { plugins: { deny: ["ci-runtime", "other"] } };
    ctx.cfg.ensureOpenClawPlugin(config, "ci-runtime", RUNTIME, "CI runtime");
    assert.deepStrictEqual(config.plugins.deny, ["other"]);
  });

  test("adds the plugin to a NON-EMPTY allow list", () => {
    const config = { plugins: { allow: ["other"] } };
    ctx.cfg.ensureOpenClawPlugin(config, "ci-runtime", RUNTIME, "CI runtime");
    assert.deepStrictEqual(config.plugins.allow, ["other", "ci-runtime"]);
  });

  // An empty allow list means "allow everything". Appending to it would silently turn it
  // into an exclusive allowlist of one and deny every other plugin.
  test("leaves an EMPTY allow list alone", () => {
    const config = { plugins: { allow: [] } };
    ctx.cfg.ensureOpenClawPlugin(config, "ci-runtime", RUNTIME, "CI runtime");
    assert.deepStrictEqual(config.plugins.allow, []);
  });

  test("with enableEntry:false registers the path but disables the entry", () => {
    const config = {};
    ctx.cfg.ensureOpenClawPlugin(config, "ci-runtime", RUNTIME, "CI runtime", { enableEntry: false });
    assert.deepStrictEqual(config.plugins.load.paths, [RUNTIME]);
    assert.strictEqual(config.plugins.entries["ci-runtime"].enabled, false);
  });

  test("with enableEntry:false does not touch deny/allow", () => {
    const config = { plugins: { deny: ["ci-runtime"], allow: ["other"] } };
    ctx.cfg.ensureOpenClawPlugin(config, "ci-runtime", RUNTIME, "CI runtime", { enableEntry: false });
    assert.deepStrictEqual(config.plugins.deny, ["ci-runtime"]);
    assert.deepStrictEqual(config.plugins.allow, ["other"]);
  });

  test("preserves unrelated keys on an existing plugin entry", () => {
    const config = { plugins: { entries: { "ci-runtime": { custom: 1 } } } };
    ctx.cfg.ensureOpenClawPlugin(config, "ci-runtime", RUNTIME, "CI runtime");
    assert.strictEqual(config.plugins.entries["ci-runtime"].custom, 1);
    assert.strictEqual(config.plugins.entries["ci-runtime"].enabled, true);
  });
});

// ---------------------------------------------------------------------------
// Memory wiring
// ---------------------------------------------------------------------------
describe("memory wiring", () => {
  let ctx;
  beforeEach(() => {
    dataDir = makeDataDir();
    ctx = makeReconciler(dataDir);
  });

  test("disableBundledSessionMemoryHook turns the bundled hook off", () => {
    const config = {};
    assert.strictEqual(ctx.cfg.disableBundledSessionMemoryHook(config), true);
    assert.strictEqual(config.hooks.internal.entries["session-memory"].enabled, false);
    assert.strictEqual(ctx.cfg.disableBundledSessionMemoryHook(config), false);
  });

  test("disableBundledSessionMemoryHook preserves other hook entries", () => {
    const config = { hooks: { internal: { entries: { other: { enabled: true } } } } };
    ctx.cfg.disableBundledSessionMemoryHook(config);
    assert.deepStrictEqual(config.hooks.internal.entries.other, { enabled: true });
  });

  test("ensureMemoryConversationAccess opts the CI entry into conversation hooks", () => {
    const config = { plugins: { entries: {} } };
    assert.strictEqual(ctx.cfg.ensureMemoryConversationAccess(config), true);
    assert.strictEqual(
      config.plugins.entries.companionintelligence.hooks.allowConversationAccess,
      true,
    );
    assert.strictEqual(ctx.cfg.ensureMemoryConversationAccess(config), false);
  });

  test("ensureMemoryConversationAccess preserves other keys on the entry", () => {
    const config = { plugins: { entries: { companionintelligence: { enabled: true } } } };
    ctx.cfg.ensureMemoryConversationAccess(config);
    assert.strictEqual(config.plugins.entries.companionintelligence.enabled, true);
  });

  test("ensurePluginConversationAccess opts ci-runtime into conversation hooks", () => {
    const config = { plugins: { entries: {} } };
    assert.strictEqual(
      ctx.cfg.ensurePluginConversationAccess(config, "ci-runtime", "CI runtime context"),
      true,
    );
    assert.strictEqual(
      config.plugins.entries["ci-runtime"].hooks.allowConversationAccess,
      true,
    );
    assert.strictEqual(
      ctx.cfg.ensurePluginConversationAccess(config, "ci-runtime", "CI runtime context"),
      false,
    );
  });

  test("ensureWebAccessDefaults enables free DuckDuckGo search and Chromium browser", () => {
    const config = {};
    assert.strictEqual(ctx.cfg.ensureWebAccessDefaults(config), true);
    assert.strictEqual(config.tools.web.search.enabled, true);
    assert.strictEqual(config.tools.web.search.provider, "duckduckgo");
    assert.strictEqual(config.tools.web.fetch.enabled, true);
    assert.ok(config.tools.alsoAllow.includes("browser"));
    assert.strictEqual(config.browser.enabled, true);
    assert.strictEqual(config.browser.executablePath, "/usr/bin/chromium");
    assert.strictEqual(config.browser.headless, true);
    assert.strictEqual(config.browser.noSandbox, true);
    assert.strictEqual(config.plugins.entries.duckduckgo.enabled, true);
    assert.strictEqual(config.plugins.entries.browser.enabled, true);
    assert.ok(
      config.plugins.load.paths.some((p) => p.endsWith(`${path.sep}duckduckgo`) || p.endsWith("/duckduckgo")),
    );
    assert.strictEqual(ctx.cfg.ensureWebAccessDefaults(config), false);
  });

  test("ensureWebAccessDefaults does not clobber an operator-chosen search provider", () => {
    const config = { tools: { web: { search: { enabled: true, provider: "brave" } } } };
    ctx.cfg.ensureWebAccessDefaults(config);
    assert.strictEqual(config.tools.web.search.provider, "brave");
  });

  test("ensureWebAccessDefaults extends an existing tools.allow with browser", () => {
    const config = { tools: { allow: ["read"] } };
    ctx.cfg.ensureWebAccessDefaults(config);
    assert.deepStrictEqual(config.tools.allow, ["read", "browser"]);
  });

  test("ensureWebAccessDefaults adds browser to an existing plugins.allow list", () => {
    const config = { plugins: { allow: ["other"] } };
    ctx.cfg.ensureWebAccessDefaults(config);
    assert.ok(config.plugins.allow.includes("browser"));
    assert.ok(config.plugins.allow.includes("duckduckgo"));
  });

  test("ensureMemoryStoreToolAllowed adds memory_store to alsoAllow", () => {
    const config = {};
    assert.strictEqual(ctx.cfg.ensureMemoryStoreToolAllowed(config), true);
    assert.deepStrictEqual(config.tools.alsoAllow, ["memory_store"]);
    assert.strictEqual(ctx.cfg.ensureMemoryStoreToolAllowed(config), false);
  });

  // tools.allow is an EXCLUSIVE allowlist; inventing one would deny every other tool.
  test("ensureMemoryStoreToolAllowed does not invent a tools.allow list", () => {
    const config = {};
    ctx.cfg.ensureMemoryStoreToolAllowed(config);
    assert.strictEqual(config.tools.allow, undefined);
  });

  test("ensureMemoryStoreToolAllowed extends an allow list the operator already keeps", () => {
    const config = { tools: { allow: ["read"] } };
    ctx.cfg.ensureMemoryStoreToolAllowed(config);
    assert.deepStrictEqual(config.tools.allow, ["read", "memory_store"]);
  });
});

// ---------------------------------------------------------------------------
// env + config I/O
// ---------------------------------------------------------------------------
describe("env + config IO", () => {
  test("readEnv/writeEnv round-trip KEY=VALUE pairs", () => {
    dataDir = makeDataDir();
    const { cfg } = makeReconciler(dataDir);
    cfg.writeEnv({ FOO: "bar", NUM: "1" });
    const env = cfg.readEnv();
    assert.strictEqual(env.FOO, "bar");
    assert.strictEqual(env.NUM, "1");
  });

  test("readEnv ignores comments and blank lines", () => {
    dataDir = makeDataDir({ env: {} });
    fs.writeFileSync(envPath(dataDir), "# a comment\n\nFOO=bar\nnot a pair\n");
    const { cfg } = makeReconciler(dataDir);
    assert.deepStrictEqual(cfg.readEnv(), { FOO: "bar" });
  });

  test("readEnv keeps '=' characters inside a value", () => {
    dataDir = makeDataDir();
    fs.writeFileSync(envPath(dataDir), "TOKEN=a=b=c\n");
    assert.strictEqual(makeReconciler(dataDir).cfg.readEnv().TOKEN, "a=b=c");
  });

  test("readEnv returns {} when .env is absent", () => {
    dataDir = makeDataDir();
    assert.deepStrictEqual(makeReconciler(dataDir).cfg.readEnv(), {});
  });

  test("writeEnv drops empty values and writes 0600", () => {
    dataDir = makeDataDir();
    const { cfg } = makeReconciler(dataDir);
    cfg.writeEnv({ KEEP: "yes", DROP: "" });
    const raw = fs.readFileSync(envPath(dataDir), "utf8");
    assert.ok(raw.includes("KEEP=yes"));
    assert.ok(!raw.includes("DROP"), "an empty value must not be written");
    assertPrivateFileMode(envPath(dataDir));
  });

  test("writeConfig writes pretty JSON at 0600 and stamps the write", () => {
    dataDir = makeDataDir();
    const { cfg } = makeReconciler(dataDir);
    assert.strictEqual(cfg.configWrittenAtMs, 0);
    cfg.writeConfig({ a: 1 });
    assert.ok(cfg.configWrittenAtMs > 0, "the write must be stamped for clobber detection");
    assert.strictEqual(fs.readFileSync(cfgPath(dataDir), "utf8"), '{\n  "a": 1\n}');
    assertPrivateFileMode(cfgPath(dataDir));
  });

  // writeFileSync's `mode` applies only when it CREATES the file. openclaw.json and
  // .env are normally created before we ever write them (by `openclaw onboard` or the
  // bootstrap scripts), so without an explicit chmod these files — which hold the
  // gateway auth token and the provider API keys — keep their creator's mode.
  test("writeConfig tightens permissions on a file it did not create", () => {
    dataDir = makeDataDir();
    fs.writeFileSync(cfgPath(dataDir), "{}", { mode: 0o644 });
    fs.chmodSync(cfgPath(dataDir), 0o644);
    makeReconciler(dataDir).cfg.writeConfig({ gateway: { auth: { token: "secret" } } });
    assertPrivateFileMode(
      cfgPath(dataDir),
      "a pre-existing openclaw.json must not stay world-readable — it holds the gateway token",
    );
  });

  test("writeEnv tightens permissions on a file it did not create", () => {
    dataDir = makeDataDir();
    fs.writeFileSync(envPath(dataDir), "OLD=1\n", { mode: 0o644 });
    fs.chmodSync(envPath(dataDir), 0o644);
    makeReconciler(dataDir).cfg.writeEnv({ ANTHROPIC_API_KEY: "secret" });
    assertPrivateFileMode(envPath(dataDir));
  });

  // The clobber cutoff is compared against snapshot mtimeMs, so the stamp must come
  // from the same clock: Date.now() is whole-millisecond and can round UP, so a
  // quarantine written just after us could carry a lower fractional mtime and be missed.
  test("writeConfig stamps from the file's own mtime, not Date.now()", () => {
    dataDir = makeDataDir();
    const { cfg } = makeReconciler(dataDir);
    cfg.writeConfig({ a: 1 });
    assert.strictEqual(
      cfg.configWrittenAtMs,
      fs.statSync(cfgPath(dataDir)).mtimeMs,
      "the cutoff and the snapshot mtimes it is compared against must share a clock",
    );
  });

  test("readConfig restores from the .bak when openclaw.json is corrupt", () => {
    dataDir = makeDataDir();
    fs.writeFileSync(cfgPath(dataDir), "{ this is not json");
    fs.writeFileSync(cfgPath(dataDir) + ".bak", '{"recovered": true}');
    assert.deepStrictEqual(makeReconciler(dataDir).cfg.readConfig(), { recovered: true });
  });

  test("readConfig returns null when both the file and the backup are gone", () => {
    dataDir = makeDataDir({ config: null });
    assert.strictEqual(makeReconciler(dataDir).cfg.readConfig(), null);
  });

  test("getGatewayToken prefers .env, then the container env, then the config", () => {
    dataDir = makeDataDir({
      config: { gateway: { auth: { token: "from-config" } } },
      env: { OPENCLAW_GATEWAY_TOKEN: "from-dotenv" },
    });
    assert.strictEqual(makeReconciler(dataDir).cfg.getGatewayToken(), "from-dotenv");

    dataDir = makeDataDir({ config: { gateway: { auth: { token: "from-config" } } } });
    assert.strictEqual(makeReconciler(dataDir).cfg.getGatewayToken(), "from-config");
    const withContainer = makeReconciler(dataDir, {
      containerEnv: { OPENCLAW_GATEWAY_TOKEN: "from-container" },
    });
    assert.strictEqual(withContainer.cfg.getGatewayToken(), "from-container");
  });

  test("getGatewayToken returns null when nothing has one", () => {
    dataDir = makeDataDir();
    assert.strictEqual(makeReconciler(dataDir).cfg.getGatewayToken(), null);
  });

  test("isConfigured is true once the wizard has run", () => {
    dataDir = makeDataDir({ config: { wizard: { done: true } } });
    assert.strictEqual(makeReconciler(dataDir).cfg.isConfigured(), true);
  });

  test("isConfigured falls back to a provider key in .env or the container env", () => {
    dataDir = makeDataDir({ env: { ANTHROPIC_API_KEY: "k" } });
    assert.strictEqual(makeReconciler(dataDir).cfg.isConfigured(), true);

    dataDir = makeDataDir();
    assert.strictEqual(makeReconciler(dataDir).cfg.isConfigured(), false);
    const withContainer = makeReconciler(dataDir, { containerEnv: { OPENROUTER_API_KEY: "k" } });
    assert.strictEqual(withContainer.cfg.isConfigured(), true);
  });
});

// ---------------------------------------------------------------------------
// Resolvers — note the env precedence traps.
// ---------------------------------------------------------------------------
describe("resolvers", () => {
  let ctx;
  beforeEach(() => {
    dataDir = makeDataDir();
    ctx = makeReconciler(dataDir);
  });

  test("resolveOllamaBaseUrl prefers OLLAMA_HOST and strips a trailing slash", () => {
    assert.strictEqual(ctx.cfg.resolveOllamaBaseUrl({ OLLAMA_HOST: "http://o:11434/" }), "http://o:11434");
  });

  test("resolveOllamaBaseUrl derives the native host from OPENAI_API_BASE by dropping /v1", () => {
    assert.strictEqual(
      ctx.cfg.resolveOllamaBaseUrl({ OPENAI_API_BASE: "http://o:11434/v1" }),
      "http://o:11434",
    );
  });

  test("resolveOllamaBaseUrl falls back to host.docker.internal", () => {
    assert.strictEqual(ctx.cfg.resolveOllamaBaseUrl({}), "http://host.docker.internal:11434");
  });

  test("resolveOllamaBaseUrl lets .env win over the container env", () => {
    const withContainer = makeReconciler(dataDir, {
      containerEnv: { OLLAMA_HOST: "http://from-container:11434" },
    });
    assert.strictEqual(
      withContainer.cfg.resolveOllamaBaseUrl({ OLLAMA_HOST: "http://from-dotenv:11434" }),
      "http://from-dotenv:11434",
    );
  });

  test("resolveInferenceApiKey prefers OPENAI, then OLLAMA, then the 'ollama' placeholder", () => {
    assert.strictEqual(ctx.cfg.resolveInferenceApiKey({ OPENAI_API_KEY: "a", OLLAMA_API_KEY: "b" }), "a");
    assert.strictEqual(ctx.cfg.resolveInferenceApiKey({ OLLAMA_API_KEY: "b" }), "b");
    assert.strictEqual(ctx.cfg.resolveInferenceApiKey({}), "ollama");
  });

  // The precedence INTERLEAVES the two sources across two keys: .env OPENAI, container
  // OPENAI, .env OLLAMA, container OLLAMA. An empty-string .env value (readEnv's regex
  // captures `(.*)`, and bootstrap-from-hub.sh writes the Hub's response body straight
  // into .env) must therefore fall through to the CONTAINER's OPENAI key — not to the
  // .env OLLAMA key. Collapsing the two sources into one merged record breaks exactly this.
  test("resolveInferenceApiKey: an empty .env OPENAI key falls through to the container's OPENAI key", () => {
    const withContainer = makeReconciler(dataDir, {
      containerEnv: { OPENAI_API_KEY: "container-openai" },
    });
    assert.strictEqual(
      withContainer.cfg.resolveInferenceApiKey({ OPENAI_API_KEY: "", OLLAMA_API_KEY: "dotenv-ollama" }),
      "container-openai",
    );
  });

  test("resolveHubNumCtx reads CI_LLM_NUM_CTX, container first", () => {
    const withContainer = makeReconciler(dataDir, { containerEnv: { CI_LLM_NUM_CTX: "8192" } });
    assert.strictEqual(withContainer.cfg.resolveHubNumCtx(), 8192);
  });

  test("resolveHubNumCtx falls back to .env", () => {
    rmDir(dataDir); // release the beforeEach dir before pointing dataDir elsewhere
    dataDir = makeDataDir({ env: { CI_LLM_NUM_CTX: "4096" } });
    assert.strictEqual(makeReconciler(dataDir).cfg.resolveHubNumCtx(), 4096);
  });

  test("resolveHubNumCtx rejects zero, negative and non-numeric values", () => {
    rmDir(dataDir); // release the beforeEach dir before the loop reassigns dataDir
    for (const raw of ["0", "-1", "abc", ""]) {
      dataDir = makeDataDir({ env: { CI_LLM_NUM_CTX: raw } });
      assert.strictEqual(makeReconciler(dataDir).cfg.resolveHubNumCtx(), null, `for ${JSON.stringify(raw)}`);
      rmDir(dataDir);
    }
    dataDir = undefined;
  });
});

// ---------------------------------------------------------------------------
// discoverOllamaModels — against a real stub Ollama.
// ---------------------------------------------------------------------------
describe("discoverOllamaModels", () => {
  test("discovers chat models and skips embedding models", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir();
      const { cfg } = makeReconciler(dataDir);
      const { models } = await cfg.discoverOllamaModels(baseUrl, "");
      const ids = models.map((m) => m.id);
      assert.ok(ids.includes("llama3.1:8b"));
      assert.ok(!ids.includes("nomic-embed-text"), "embedding models must not enter the chat catalog");
    });
  });

  test("prepends an 'auto' alias for DEFAULT_MODEL and inherits its capabilities", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir();
      const { cfg } = makeReconciler(dataDir);
      const { models, defaultModelAvailable } = await cfg.discoverOllamaModels(baseUrl, "qwen3:4b");
      assert.strictEqual(models[0].id, "auto");
      assert.strictEqual(models[0].name, "Hub Auto (qwen3:4b)");
      assert.strictEqual(models[0].reasoning, true, "auto inherits qwen3's thinking capability");
      assert.strictEqual(defaultModelAvailable, "qwen3:4b");
    });
  });

  test("auto falls back to the first model when DEFAULT_MODEL is not installed", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir();
      const { cfg } = makeReconciler(dataDir);
      const { models, defaultModelAvailable } = await cfg.discoverOllamaModels(baseUrl, "not-installed");
      assert.strictEqual(models[0].id, "auto");
      assert.strictEqual(defaultModelAvailable, null);
    });
  });

  test("caps the auto entry at its target model's window", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({ env: { CI_LLM_NUM_CTX: "131072" } });
      const { cfg } = makeReconciler(dataDir);
      const { models } = await cfg.discoverOllamaModels(baseUrl, "llava:7b");
      assert.strictEqual(models[0].id, "auto");
      assert.strictEqual(models[0].params.num_ctx, 4096, "auto must not exceed llava's 4k window");
    });
  });

  test("returns no models when the catalog is empty", async () => {
    await withOllama({}, async (baseUrl) => {
      dataDir = makeDataDir();
      const { cfg } = makeReconciler(dataDir);
      const { models } = await cfg.discoverOllamaModels(baseUrl, "");
      assert.deepStrictEqual(models, []);
    });
  });

  test("tolerates /api/show failing for one model", async () => {
    await withOllama({ "llama3.1:8b": "error" }, async (baseUrl) => {
      dataDir = makeDataDir();
      const { cfg } = makeReconciler(dataDir);
      const { models } = await cfg.discoverOllamaModels(baseUrl, "");
      assert.strictEqual(models.length, 2, "the entry is still emitted (plus auto)");
      assert.strictEqual(models[1].compat.supportsTools, false, "unknown capabilities default off");
    });
  });

  test("coerces a string context_length from model_info", async () => {
    await withOllama({ "m:1": { capabilities: [], contextLength: "8192" } }, async (baseUrl) => {
      dataDir = makeDataDir();
      const { cfg } = makeReconciler(dataDir);
      const caps = await cfg.fetchOllamaModelCapabilities(baseUrl, "m:1");
      assert.strictEqual(caps.contextLimit, 8192);
    });
  });
});

// ---------------------------------------------------------------------------
// warnIfConfigClobbered
// ---------------------------------------------------------------------------
describe("warnIfConfigClobbered", () => {
  const clobber = (dir, name, mtime) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "{}");
    fs.utimesSync(file, mtime, mtime);
  };

  test("reports a quarantine newer than the cutoff", () => {
    dataDir = makeDataDir();
    clobber(dataDir, "openclaw.json.clobbered.123", new Date());
    const ctx = makeReconciler(dataDir);
    ctx.cfg.warnIfConfigClobbered(Date.now() - 60_000);
    assert.ok(ctx.logs.some((l) => l.includes("openclaw rejected openclaw.json")));
  });

  // startOpenclaw re-runs on every gateway exit; without dedupe the same historical
  // snapshot would be re-reported on every restart forever.
  test("reports each snapshot exactly once across repeated calls", () => {
    dataDir = makeDataDir();
    clobber(dataDir, "openclaw.json.clobbered.123", new Date());
    const ctx = makeReconciler(dataDir);
    const since = Date.now() - 60_000;
    ctx.cfg.warnIfConfigClobbered(since);
    ctx.cfg.warnIfConfigClobbered(since);
    const reports = ctx.logs.filter((l) => l.includes("openclaw rejected"));
    assert.strictEqual(reports.length, 1);
  });

  test("ignores snapshots older than the cutoff", () => {
    dataDir = makeDataDir();
    clobber(dataDir, "openclaw.json.clobbered.old", new Date(Date.now() - 600_000));
    const ctx = makeReconciler(dataDir);
    ctx.cfg.warnIfConfigClobbered(Date.now());
    assert.deepStrictEqual(ctx.logs, []);
  });

  test("never throws when the config dir is unreadable", () => {
    const ctx = makeReconciler("/nonexistent/data/dir");
    assert.doesNotThrow(() => ctx.cfg.warnIfConfigClobbered(0));
  });
});

// ---------------------------------------------------------------------------
// reconcileConfig — end to end, against a real stub Ollama.
// ---------------------------------------------------------------------------
describe("reconcileConfig (end to end)", () => {
  test("no-ops when openclaw.json does not exist, and creates nothing", async () => {
    dataDir = makeDataDir({ config: null });
    const { cfg } = makeReconciler(dataDir);
    await cfg.reconcileConfig();
    assert.ok(!fs.existsSync(cfgPath(dataDir)), "must not conjure a config pre-onboarding");
  });

  test("writes a coherent config from an empty one", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({ config: {}, env: { OLLAMA_HOST: baseUrl } });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();

      const config = readCfg(dataDir);
      assert.strictEqual(config.gateway.mode, "local");
      assert.strictEqual(config.gateway.auth.mode, "token");
      assert.match(config.gateway.auth.token, /^[0-9a-f]{48}$/);
      assert.ok(!("allowInsecureAuth" in config.gateway.controlUi));
      assert.ok(!("dangerouslyDisableDeviceAuth" in config.gateway.controlUi));
      assert.deepStrictEqual(config.gateway.controlUi.allowedOrigins, [
        "http://127.0.0.1:18790",
        "http://localhost:18790",
      ]);
      assert.strictEqual(config.update.checkOnStart, false);
      assert.strictEqual(config.models.mode, "merge");
      assert.strictEqual(config.models.providers["ci-hub"].api, "ollama");
      // No wake secret in this fixture, so the wake hook must stay off — and must not
      // leave a half-enabled `hooks.enabled` behind, which makes OpenClaw throw at resolve.
      assert.strictEqual(config.hooks?.enabled, undefined);
    });
  });

  // The Hub's agent-notify POSTs app crashes and system alerts to OpenClaw's native wake
  // hook. It only listens once reconcile has written BOTH keys. CI-Hub#897.
  test("enables the native wake hook when the Hub injects HUB_WAKE_SECRET", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({ config: {}, env: { OLLAMA_HOST: baseUrl } });
      const { cfg } = makeReconciler(dataDir, {
        containerEnv: { HUB_WAKE_SECRET: "wake-secret-abc" },
      });
      await cfg.reconcileConfig();

      const config = readCfg(dataDir);
      assert.strictEqual(config.hooks.enabled, true);
      assert.strictEqual(config.hooks.token, "${HUB_WAKE_SECRET}");
      assert.ok(
        !JSON.stringify(config).includes("wake-secret-abc"),
        "the raw wake secret must never be written to openclaw.json",
      );
    });
  });

  // The regression, asserted on the file we actually write.
  test("every generated model entry uses params.num_ctx and no options key", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: {},
        env: { OLLAMA_HOST: baseUrl, CI_LLM_NUM_CTX: "16384" },
      });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();

      const providers = readCfg(dataDir).models.providers;
      for (const providerId of ["ci-hub", "ollama"]) {
        const models = providers[providerId].models;
        assert.ok(models.length > 0, `${providerId} catalog must not be empty`);
        for (const model of models) {
          assert.ok(!("options" in model), `${providerId}/${model.id} carries a forbidden \`options\` key`);
          assert.ok(model.params.num_ctx > 0, `${providerId}/${model.id} is missing params.num_ctx`);
          assert.ok(
            model.params.num_ctx <= model.contextWindow,
            `${providerId}/${model.id} requests more context than it advertises`,
          );
        }
      }
      // llava lives on the native ollama provider; Hub's 16384 must clamp to its 4k window.
      const llava = providers.ollama.models.find((m) => m.id === "llava:7b");
      assert.ok(llava, "llava must be registered under models.providers.ollama");
      assert.strictEqual(llava.params.num_ctx, 4096);
    });
  });

  test("generates a gateway token and syncs it to .env", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({ config: {}, env: { OLLAMA_HOST: baseUrl } });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();

      const token = readCfg(dataDir).gateway.auth.token;
      assert.strictEqual(cfg.readEnv().OPENCLAW_GATEWAY_TOKEN, token);
    });
  });

  test("reuses an existing gateway token instead of minting a new one", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: { gateway: { auth: { token: "existing-token-value" } } },
        env: { OLLAMA_HOST: baseUrl },
      });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();
      assert.strictEqual(readCfg(dataDir).gateway.auth.token, "existing-token-value");
    });
  });

  // The `changed` -> writeConfig contract, and the reason it matters: a reconcile that
  // rewrites a steady-state config would churn the file on every single boot.
  test("a second reconcile changes nothing and does not rewrite either file", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: {},
        env: {
          OLLAMA_HOST: baseUrl,
          DEFAULT_MODEL: "llama3.1:8b",
          EMBEDDINGS_MODEL: "nomic-embed-text",
          ...MEM,
          ...HUB,
        },
      });
      const ctx = makeReconciler(dataDir);
      await ctx.cfg.reconcileConfig();
      const first = fs.readFileSync(cfgPath(dataDir), "utf8");

      // Backdate both files: if the second pass writes AT ALL — even byte-identical
      // content — the mtime moves.
      const epoch = new Date(0);
      fs.utimesSync(cfgPath(dataDir), epoch, epoch);
      fs.utimesSync(envPath(dataDir), epoch, epoch);
      ctx.logs.length = 0;

      await ctx.cfg.reconcileConfig();

      assert.deepStrictEqual(ctx.patches(), [], "a steady-state reconcile must patch nothing");
      assert.strictEqual(fs.readFileSync(cfgPath(dataDir), "utf8"), first);
      assert.strictEqual(fs.statSync(cfgPath(dataDir)).mtimeMs, 0, "changed=false must skip writeConfig");
      assert.strictEqual(fs.statSync(envPath(dataDir)).mtimeMs, 0, "token already synced -> no writeEnv");
    });
  });

  test("sets the default agent model to ci-hub/auto when DEFAULT_MODEL is installed", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: {},
        env: { OLLAMA_HOST: baseUrl, DEFAULT_MODEL: "qwen3:4b" },
      });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();
      assert.strictEqual(readCfg(dataDir).agents.defaults.model.primary, "ci-hub/auto");
    });
  });

  test("replaces a primary that points at an uninstalled model", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: { agents: { defaults: { model: { primary: "ci-hub/gone:7b" } } } },
        env: { OLLAMA_HOST: baseUrl, DEFAULT_MODEL: "qwen3:4b" },
      });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();
      assert.strictEqual(readCfg(dataDir).agents.defaults.model.primary, "ci-hub/auto");
    });
  });

  test("keeps a still-installed primary across reconciles", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        // Concrete Hub default stays on ci-hub; full-tag picks like llava live only under ollama/.
        config: { agents: { defaults: { model: { primary: "ci-hub/qwen3:4b" } } } },
        env: { OLLAMA_HOST: baseUrl, DEFAULT_MODEL: "qwen3:4b" },
      });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();
      assert.strictEqual(
        readCfg(dataDir).agents.defaults.model.primary,
        "ci-hub/qwen3:4b",
        "an operator's still-valid Hub choice must not be overridden",
      );
    });
  });

  test("splits Hub default onto ci-hub and full local tags onto ollama", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: {},
        env: { OLLAMA_HOST: baseUrl, DEFAULT_MODEL: "qwen3:4b" },
      });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();

      const config = readCfg(dataDir);
      const hubIds = config.models.providers["ci-hub"].models.map((m) => m.id);
      const ollamaIds = config.models.providers.ollama.models.map((m) => m.id);

      assert.deepStrictEqual(hubIds, ["auto", "qwen3:4b"]);
      assert.deepStrictEqual(ollamaIds, ["llama3.1:8b", "qwen3:4b", "llava:7b"]);
      assert.ok(!ollamaIds.includes("auto"), "native ollama catalog must not include Hub auto");
      assert.strictEqual(config.agents.defaults.model.primary, "ci-hub/auto");

      const agentModels = config.agents.defaults.models;
      assert.ok("ci-hub/auto" in agentModels);
      assert.ok("ci-hub/qwen3:4b" in agentModels);
      assert.ok("ollama/llama3.1:8b" in agentModels);
      assert.ok("ollama/qwen3:4b" in agentModels);
      assert.ok("ollama/llava:7b" in agentModels);
      assert.ok(!("ci-hub/llava:7b" in agentModels));
    });
  });

  test("drops stale ci-hub and ollama model keys but preserves other providers", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: {
          agents: {
            defaults: {
              models: {
                "ci-hub/gone:7b": { x: 1 },
                "ollama/gone:7b": { y: 1 },
                "anthropic/claude": { keep: true },
              },
            },
          },
        },
        env: { OLLAMA_HOST: baseUrl },
      });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();

      const models = readCfg(dataDir).agents.defaults.models;
      assert.ok(!("ci-hub/gone:7b" in models), "an uninstalled ci-hub model must be dropped");
      assert.ok(!("ollama/gone:7b" in models), "an uninstalled ollama model must be dropped");
      assert.deepStrictEqual(models["anthropic/claude"], { keep: true });
      assert.ok("ci-hub/auto" in models);
      assert.ok("ci-hub/llama3.1:8b" in models);
      assert.ok("ollama/llama3.1:8b" in models);
      assert.ok("ollama/llava:7b" in models);
      assert.ok(!("ci-hub/llava:7b" in models), "full local tags belong under ollama/, not ci-hub/");
    });
  });

  // Ollama being unreachable must never wipe a working catalog — the appliance would
  // lose every model until Ollama came back.
  test("preserves existing ci-hub and ollama catalogs when Ollama is unreachable", async () => {
    const existingHub = [{ id: "auto", name: "Hub Auto (llama3.1:8b)" }, { id: "llama3.1:8b", name: "Llama" }];
    const existingOllama = [{ id: "llama3.1:8b", name: "Llama" }, { id: "llava:7b", name: "LLaVA" }];
    dataDir = makeDataDir({
      config: {
        models: {
          providers: {
            "ci-hub": { models: existingHub },
            ollama: { models: existingOllama },
          },
        },
      },
      env: { OLLAMA_HOST: OLLAMA_DOWN },
    });
    const ctx = makeReconciler(dataDir);
    await ctx.cfg.reconcileConfig();

    const providers = readCfg(dataDir).models.providers;
    assert.deepStrictEqual(providers["ci-hub"].models, existingHub);
    assert.deepStrictEqual(providers.ollama.models, existingOllama);
    assert.ok(
      ctx.logs.some(
        (l) =>
          l.includes("Failed to sync") ||
          l.includes("preserving existing ci-hub and ollama model catalogs"),
      ),
    );
  });

  test("wires CI memory end to end when CI-Server credentials are present", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: {},
        env: { OLLAMA_HOST: baseUrl, EMBEDDINGS_MODEL: "nomic-embed-text", ...MEM },
      });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();

      const config = readCfg(dataDir);
      assert.strictEqual(config.plugins.slots.memory, "companionintelligence");
      assert.strictEqual(config.plugins.entries.companionintelligence.enabled, true);
      assert.strictEqual(
        config.plugins.entries.companionintelligence.hooks.allowConversationAccess,
        true,
      );
      assert.strictEqual(config.hooks.internal.entries["session-memory"].enabled, false);
      assert.ok(config.tools.alsoAllow.includes("memory_store"));
      assert.strictEqual(config.memory.search.provider, "openai-compatible");
      assert.strictEqual(config.memory.search.remote.baseUrl, `${baseUrl}/v1`);
      assert.strictEqual(config.plugins.load.paths.length, 4, "runtime, memory, hub, duckduckgo registered");
      assert.strictEqual(config.tools.web.search.provider, "duckduckgo");
      assert.ok(config.tools.alsoAllow.includes("browser"));
      assert.strictEqual(config.browser.executablePath, "/usr/bin/chromium");
    });
  });

  test("leaves the memory slot alone when a third-party backend is selected", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: { plugins: { slots: { memory: "someone-elses-memory" } } },
        env: { OLLAMA_HOST: baseUrl, ...MEM },
      });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();

      const config = readCfg(dataDir);
      assert.strictEqual(config.plugins.slots.memory, "someone-elses-memory");
      assert.strictEqual(config.plugins.entries.companionintelligence.enabled, false);
    });
  });

  test("keeps CI memory selected when the slot already names it, even without credentials", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: { plugins: { slots: { memory: "companionintelligence" } } },
        env: { OLLAMA_HOST: baseUrl },
      });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();
      assert.strictEqual(readCfg(dataDir).plugins.entries.companionintelligence.enabled, true);
    });
  });

  test("registers the Hub MCP server and enables the ci-hub plugin when creds exist", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({ config: {}, env: { OLLAMA_HOST: baseUrl, ...HUB } });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();

      const config = readCfg(dataDir);
      assert.strictEqual(config.mcp.servers["ci-hub"].url, "https://hub.example/api/mcp");
      assert.strictEqual(config.plugins.entries["ci-hub"].enabled, true);
      assert.ok(!JSON.stringify(config).includes("hub-key"), "the raw key must not be persisted");
    });
  });

  test("disables the ci-hub plugin entry when Hub creds are absent", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({ config: {}, env: { OLLAMA_HOST: baseUrl } });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();

      const config = readCfg(dataDir);
      assert.strictEqual(config.mcp?.servers?.["ci-hub"], undefined);
      assert.strictEqual(config.plugins.entries["ci-hub"].enabled, false);
    });
  });

  // The Hub injects credentials as container env, not into .env; a container value must
  // win over a stale persisted one (that is what makes HUB_MCP_ENABLED=false effective).
  test("Hub-authoritative container env overrides a stale .env value", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: {},
        env: { OLLAMA_HOST: baseUrl, ...MEM, CI_SERVER_ENABLED: "true" },
      });
      const { cfg } = makeReconciler(dataDir, {
        containerEnv: { CI_SERVER_ENABLED: "false" },
      });
      await cfg.reconcileConfig();
      assert.strictEqual(
        readCfg(dataDir).plugins.entries.companionintelligence.enabled,
        false,
        "a Hub CI_SERVER_ENABLED=false must disable memory despite the .env saying true",
      );
    });
  });

  test("never clobbers an unrelated key an operator added", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: { somethingCustom: { keep: "me" } },
        env: { OLLAMA_HOST: baseUrl },
      });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();
      assert.deepStrictEqual(readCfg(dataDir).somethingCustom, { keep: "me" });
    });
  });

  test("surfaces a quarantine that appeared since our last write", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({ config: {}, env: { OLLAMA_HOST: baseUrl } });
      const ctx = makeReconciler(dataDir);
      await ctx.cfg.reconcileConfig(); // stamps configWrittenAtMs

      fs.writeFileSync(path.join(dataDir, "openclaw.json.clobbered.999"), "{}");
      ctx.logs.length = 0;
      await ctx.cfg.reconcileConfig();

      assert.ok(
        ctx.logs.some((l) => l.includes("openclaw rejected openclaw.json")),
        "a quarantine after our write must be surfaced, not swallowed",
      );
    });
  });

  test("produces no index-keyed junk anywhere in the written config", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: {},
        env: { OLLAMA_HOST: baseUrl, EMBEDDINGS_MODEL: "nomic-embed-text", ...MEM, ...HUB },
      });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();
      assertNoIndexKeys(readCfg(dataDir));
    });
  });

  test("registers every CI_CLOUD_* provider alongside ci-hub and does not flip the default", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: {},
        env: {
          OLLAMA_HOST: baseUrl,
          DEFAULT_MODEL: "llama3.1:8b",
          CI_CLOUD_OPENAI_API_KEY: "sk-oai",
          CI_CLOUD_OPENAI_BASE_URL: "https://api.openai.com/v1",
          CI_CLOUD_OPENAI_MODEL: "gpt-4o",
          CI_CLOUD_ANTHROPIC_API_KEY: "sk-ant",
          CI_CLOUD_ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1",
          CI_CLOUD_ANTHROPIC_MODEL: "claude-opus-4",
          CI_CLOUD_GOOGLE_API_KEY: "g-key",
          CI_CLOUD_GOOGLE_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai",
          CI_CLOUD_GOOGLE_MODEL: "gemini-2.5-pro",
          CI_CLOUD_GITHUB_COPILOT_API_KEY: "gh-key",
          CI_CLOUD_GITHUB_COPILOT_BASE_URL: "https://api.githubcopilot.com",
          CI_CLOUD_GITHUB_COPILOT_MODEL: "gpt-4o",
        },
      });
      const { cfg, patches } = makeReconciler(dataDir);
      await cfg.reconcileConfig();

      const config = readCfg(dataDir);
      assert.strictEqual(config.models.providers["ci-hub"].api, "ollama");
      assert.strictEqual(config.agents.defaults.model.primary, "ci-hub/auto");
      assert.strictEqual(config.models.providers.openai.apiKey, "sk-oai");
      assert.strictEqual(config.models.providers.openai.api, "openai-completions");
      assert.strictEqual(config.models.providers.anthropic.api, "anthropic-messages");
      assert.strictEqual(config.models.providers.google.apiKey, "g-key");
      assert.strictEqual(config.models.providers["github-copilot"].apiKey, "gh-key");
      for (const id of ["openai", "anthropic", "google", "github-copilot"]) {
        assert.ok(
          !("hubManaged" in config.models.providers[id]),
          `${id} must not carry hubManaged (schema-invalid)`,
        );
      }
      assert.ok(patches().some((line) => line.includes("synced openai cloud provider")));

      const first = JSON.stringify(config);
      await cfg.reconcileConfig();
      assert.strictEqual(JSON.stringify(readCfg(dataDir)), first, "cloud provider sync is idempotent");
    });
  });

  test("removes a cloud provider when its Hub key is gone and strips leftover hubManaged", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({
        config: {
          models: {
            providers: {
              openai: {
                hubManaged: true,
                apiKey: "stale",
                api: "openai-completions",
                models: [],
              },
              anthropic: {
                apiKey: "sk-ant",
                api: "anthropic-messages",
                models: [],
              },
            },
          },
        },
        env: {
          OLLAMA_HOST: baseUrl,
          CI_CLOUD_ANTHROPIC_API_KEY: "sk-ant",
        },
      });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();

      const providers = readCfg(dataDir).models.providers;
      assert.strictEqual(providers.openai, undefined);
      assert.strictEqual(providers.anthropic.apiKey, "sk-ant");
      assert.ok(!("hubManaged" in providers.anthropic));
      assert.strictEqual(providers["ci-hub"].api, "ollama");
    });
  });
});

// ---------------------------------------------------------------------------
// Malformed nodes + convergence.
//
// openclaw.json is a file operators hand-edit. Every one of these seeds put a scalar
// or an array where the reconciler expects a record, and each used to fail in one of
// three ways:
//
//   THROWS         — `gateway: "local"` is truthy, so the old `if (!config.gateway)`
//                    passed it through; assigning to a primitive no-ops in sloppy mode
//                    and the next read threw. reconcileConfig's caller swallows the
//                    rejection, so the gateway came up with NO auth token.
//   INDEX-JUNK     — `{...\"http://x\"}` spreads to {"0":"h","1":"t",...}. That is
//                    schema-invalid, so OpenClaw quarantines the ENTIRE file and
//                    reverts everything written in the same pass.
//   NON-CONVERGENT — the assignment silently no-ops, `changed` is set anyway, and the
//                    file is rewritten on EVERY boot, forever.
//
// Convergence is the invariant that generalizes: a config the reconciler rewrites on
// every boot is, by definition, one it is failing to normalize.
// ---------------------------------------------------------------------------
describe("malformed nodes + convergence", () => {
  const HOSTILE = [
    ["gateway is a scalar", { gateway: "local" }],
    ["gateway is an array", { gateway: [] }],
    ["gateway.auth is a scalar", { gateway: { auth: "token" } }],
    ["update is a scalar", { update: 1 }],
    ["models is an array", { models: [] }],
    ["models.providers['ci-hub'] is a string", { models: { providers: { "ci-hub": "http://hand-edited:11434" } } }],
    ["plugins.entries[id] is a scalar", { plugins: { entries: { "ci-runtime": "x" } } }],
    ["plugins.slots is an array", { plugins: { slots: [] } }],
    ["agents is a scalar", { agents: "x" }],
    ["agents.defaults.models is a string", { agents: { defaults: { models: "abc" } } }],
    ["agents.defaults.model is a string", { agents: { defaults: { model: "x" } } }],
    ["memory.search is a scalar", { memory: { search: "openai" } }],
    ["tools.alsoAllow is a string", { tools: { alsoAllow: "memory_store" } }],
    ["hooks is a scalar", { hooks: 1 }],
    ["mcp is a scalar", { mcp: "nope" }],
  ];

  for (const [name, seed] of HOSTILE) {
    test(`${name}: reconciles, normalizes and converges`, async () => {
      await withOllama(CATALOG, async (baseUrl) => {
        dataDir = makeDataDir({
          config: seed,
          env: {
            OLLAMA_HOST: baseUrl,
            EMBEDDINGS_MODEL: "nomic-embed-text",
            ...MEM,
            ...HUB,
          },
        });
        const ctx = makeReconciler(dataDir);

        // 1. It must not throw. A throw here means no gateway token gets written.
        await ctx.cfg.reconcileConfig();

        // 2. The malformed node must be REPLACED with a record, never decorated.
        const config = readCfg(dataDir);
        assertNoIndexKeys(config);
        assert.strictEqual(config.gateway.mode, "local");
        assert.match(config.gateway.auth.token, /^[0-9a-f]{48}$/, "the gateway token must still be written");

        // 3. The result must survive a JSON round-trip unchanged (no array-with-props).
        assert.deepStrictEqual(JSON.parse(JSON.stringify(config)), config);

        // 4. It must CONVERGE: a second pass patches nothing and rewrites nothing.
        const before = fs.readFileSync(cfgPath(dataDir), "utf8");
        const epoch = new Date(0);
        fs.utimesSync(cfgPath(dataDir), epoch, epoch);
        ctx.logs.length = 0;

        await ctx.cfg.reconcileConfig();

        assert.deepStrictEqual(ctx.patches(), [], "a normalized config must not be re-patched");
        assert.strictEqual(fs.readFileSync(cfgPath(dataDir), "utf8"), before);
        assert.strictEqual(
          fs.statSync(cfgPath(dataDir)).mtimeMs,
          0,
          "rewriting on every boot means the config was never normalized",
        );
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Malformed nodes on an INACTIVE feature path.
//
// The suite above runs with Ollama reachable and full credentials, so every feature
// path executes and coerces its node. But agents/tools/hooks/mcp/plugins.slots are
// only rewritten on their active path — discovery success, or CI-Server/Hub creds. On
// an appliance with Ollama down and no creds, a hand-edited scalar there would survive
// to writeConfig (the gateway-token write forces the file to be written) and openclaw's
// strict schema would quarantine the WHOLE file. These run with NO creds and Ollama
// unreachable to pin that gap shut.
// ---------------------------------------------------------------------------
describe("malformed nodes on an inactive feature path", () => {
  const INACTIVE = [
    ["agents is a scalar", { agents: "legacy-string" }, (c) => c.agents],
    ["tools is a scalar", { tools: "x" }, (c) => c.tools],
    ["hooks is a scalar", { hooks: "x" }, (c) => c.hooks],
    ["mcp is a scalar", { mcp: "nope" }, (c) => c.mcp],
    ["plugins.slots is an array", { plugins: { slots: [] } }, (c) => c.plugins.slots],
  ];

  for (const [name, seed, pick] of INACTIVE) {
    test(`${name}: coerced to a record even with no creds and Ollama down`, async () => {
      dataDir = makeDataDir({ config: seed, env: { OLLAMA_HOST: OLLAMA_DOWN } });
      const ctx = makeReconciler(dataDir);
      await ctx.cfg.reconcileConfig();

      const config = readCfg(dataDir);
      const node = pick(config);
      assert.ok(
        node === undefined || (typeof node === "object" && !Array.isArray(node)),
        `${name} must be a record or absent, not ${JSON.stringify(node)} — a scalar/array here quarantines the whole file`,
      );
      assertNoIndexKeys(config);
      assert.match(config.gateway.auth.token, /^[0-9a-f]{48}$/, "the gateway token must still be written");
      assert.deepStrictEqual(JSON.parse(JSON.stringify(config)), config);

      // Converges: a second pass rewrites nothing.
      const before = fs.readFileSync(cfgPath(dataDir), "utf8");
      fs.utimesSync(cfgPath(dataDir), new Date(0), new Date(0));
      ctx.logs.length = 0;
      await ctx.cfg.reconcileConfig();
      assert.deepStrictEqual(ctx.patches(), []);
      assert.strictEqual(fs.readFileSync(cfgPath(dataDir), "utf8"), before);
      assert.strictEqual(fs.statSync(cfgPath(dataDir)).mtimeMs, 0);
    });
  }

  test("a minimal config gains no empty agents/hooks/mcp nodes", async () => {
    dataDir = makeDataDir({ config: {}, env: { OLLAMA_HOST: OLLAMA_DOWN } });
    const { cfg } = makeReconciler(dataDir);
    await cfg.reconcileConfig();
    const config = readCfg(dataDir);
    // tools is intentionally written by ensureWebAccessDefaults (DDG + browser).
    for (const key of ["agents", "hooks", "mcp"]) {
      assert.ok(!(key in config), `${key} must not be conjured onto a config that never had it`);
    }
    assert.strictEqual(config.tools.web.search.provider, "duckduckgo");
    assert.ok(config.tools.alsoAllow.includes("browser"));
  });

  test("bails cleanly on a non-record top-level config", async () => {
    for (const bad of ["[]", '"a string"', "42"]) {
      dataDir = makeDataDir();
      fs.writeFileSync(cfgPath(dataDir), bad);
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig(); // must not throw
      assert.strictEqual(fs.readFileSync(cfgPath(dataDir), "utf8"), bad, "a corrupt top-level config is left for .bak recovery, not churned");
      rmDir(dataDir);
    }
    dataDir = undefined;
  });
});

// ---------------------------------------------------------------------------
// ensureRecordPathTracked — the change report the `changed` protocol depends on.
// ---------------------------------------------------------------------------
describe("ensureRecordPathTracked", () => {
  test("reports replaced=false when every node on the path is already a record", () => {
    const root = { a: { b: {} } };
    const { node, replaced } = ensureRecordPathTracked(root, ["a", "b"]);
    assert.strictEqual(replaced, false, "no replacement means no reason to rewrite the file");
    assert.strictEqual(node, root.a.b, "the existing node is returned, not a copy");
  });

  test("reports replaced=true when a scalar had to be overwritten", () => {
    const root = { a: "scalar" };
    const { replaced } = ensureRecordPathTracked(root, ["a", "b"]);
    assert.strictEqual(replaced, true);
    assert.deepStrictEqual(root, { a: { b: {} } });
  });

  test("reports replaced=true for a missing path, and for an array node", () => {
    assert.strictEqual(ensureRecordPathTracked({}, ["a"]).replaced, true);
    assert.strictEqual(ensureRecordPathTracked({ a: [] }, ["a"]).replaced, true);
  });

  test("ensureRecordPath is the value-only view of the same walk", () => {
    const root = { a: 1 };
    assert.strictEqual(ensureRecordPath(root, ["a"]), root.a);
    assert.ok(isPlainObject(root.a));
  });
});
