// Shared fixtures for the config-reconcile suites.
//
// Used by tests/config-reconcile.test.mjs and by tests/config-schema.gate.mjs, which
// must validate the config the REAL reconcileConfig() produces — not a hand-written
// one, or it would only catch drift someone remembered to encode.
//
// Style follows the repo: real temp dirs and a real ephemeral HTTP server rather than
// mocks (see tests/companionintelligence.plugin.test.mjs, which stands up an actual
// node:http CI-Server instead of stubbing fetch). reconcileConfig() calls fetch with an
// AbortSignal timeout; a real socket exercises that path, a fetch mock would not.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");

// The module under test is CommonJS. createRequire is deterministic; ESM's named-export
// detection for CJS is a static-analysis heuristic that breaks on non-literal exports.
const require = createRequire(import.meta.url);
export const {
  createConfigReconciler,
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
} = require(path.join(REPO, "config-reconcile.cjs"));

// The three vendored plugin dirs really exist in a checkout, so fs.existsSync in
// ensureOpenClawPlugin runs for real and no fs mocking is needed. Point a path at a
// non-existent dir to exercise the missing-plugin branch.
export const PLUGIN_PATHS = {
  ciRuntime: path.join(REPO, "openclaw-context", "plugins", "ci-runtime"),
  ciMemory: path.join(REPO, "openclaw-context", "plugins", "companionintelligence"),
  ciHub: path.join(REPO, "openclaw-context", "plugins", "ci-hub"),
};

/**
 * A temp data dir standing in for $HOME/.openclaw, seeded with openclaw.json and .env.
 *
 * Pass `config: null` to leave openclaw.json absent — reconcileConfig() early-returns
 * when readConfig() yields null, which is itself worth asserting.
 */
export function makeDataDir({ config = {}, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-openclaw-"));
  if (config !== null) {
    fs.writeFileSync(
      path.join(dir, "openclaw.json"),
      JSON.stringify(config, null, 2),
    );
  }
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  if (lines.length) {
    fs.writeFileSync(path.join(dir, ".env"), lines.join("\n") + "\n");
  }
  return dir;
}

export const cfgPath = (dir) => path.join(dir, "openclaw.json");
export const envPath = (dir) => path.join(dir, ".env");
export const readCfg = (dir) => JSON.parse(fs.readFileSync(cfgPath(dir), "utf8"));
export const rmDir = (dir) => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
};

/**
 * A reconciler wired to a temp dir, with the log stream captured.
 *
 * The captured lines ARE the behavioral contract: every mutation announces itself with
 * a "Patched config:" line, so "a second reconcile logs nothing" is the cleanest possible
 * statement of idempotence.
 */
export function makeReconciler(dir, { containerEnv = {}, pluginPaths = PLUGIN_PATHS } = {}) {
  const logs = [];
  const sink = (...args) => logs.push(args.map(String).join(" "));
  const reconciler = createConfigReconciler({
    configDir: dir,
    containerEnv,
    pluginPaths,
    log: { log: sink, warn: sink, error: sink },
  });
  return { cfg: reconciler, logs, patches: () => logs.filter((l) => l.startsWith("Patched config:")) };
}

// Ollama's /api/show reports the trained context as "<arch>.context_length" and may
// serialize it as a number or a numeric string; both are exercised below.
export const CATALOG = {
  "llama3.1:8b": { capabilities: ["tools"], contextLength: 131072 },
  "qwen3:4b": { capabilities: ["tools", "thinking"], contextLength: 40960 },
  "llava:7b": { capabilities: ["vision"], contextLength: 4096 },
  "nomic-embed-text": { capabilities: [], contextLength: 2048 }, // must be skipped
};

/**
 * Stand up a real Ollama on an ephemeral port and hand its base URL to `fn`.
 *
 * A catalog value of "error" makes /api/show return 500 for that model, so the
 * tolerate-a-failing-model path is covered. Point OLLAMA_HOST at a closed port instead
 * of calling this to simulate Ollama being down (ECONNREFUSED is immediate, so the 5s
 * AbortSignal timeout never stalls the suite).
 */
export async function withOllama(catalog, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, body });
      const json = (code, payload) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url === "/api/tags") {
        return json(200, {
          models: Object.keys(catalog).map((name) => ({ name })),
        });
      }
      if (req.url === "/api/show") {
        const spec = catalog[body?.name];
        if (!spec) return json(404, {});
        if (spec === "error") return json(500, { error: "boom" });
        return json(200, {
          capabilities: spec.capabilities ?? [],
          model_info:
            spec.contextLength == null
              ? {}
              : { "llama.context_length": spec.contextLength },
        });
      }
      return json(404, {});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseUrl, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A port nothing is listening on, for the "Ollama is down" path. */
export const OLLAMA_DOWN = "http://127.0.0.1:1";

/**
 * Assert no record anywhere in the tree is index-keyed.
 *
 * This is the generalizing form of the malformed-node requirement: spreading a scalar
 * ({...\"http\"}) or walking an array yields records keyed "0","1","2". Nothing in a
 * valid openclaw.json looks like that, so we assert it NOWHERE — which is broader and
 * cheaper than enumerating every node we happened to remember to guard.
 */
export function assertNoIndexKeys(node, at = "$") {
  if (Array.isArray(node)) {
    node.forEach((value, i) => assertNoIndexKeys(value, `${at}[${i}]`));
    return;
  }
  if (!node || typeof node !== "object") return;
  const keys = Object.keys(node);
  assert.ok(
    !(keys.includes("0") && keys.includes("1")),
    `index-keyed junk at ${at}: {${keys.slice(0, 6).join(",")}} — a scalar was spread into a record`,
  );
  for (const [key, value] of Object.entries(node)) {
    assertNoIndexKeys(value, `${at}.${key}`);
  }
}
