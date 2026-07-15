// Load/contract smoke test for the vendored ci-hub plugin bundle
// (companionintelligence/CI-OpenClaw#45).
//
// The drift check proves the committed bundle MATCHES a rebuild from CI-Hub source. It cannot
// prove the bundle still LOADS, or that the hand-written shim (index.js) still honours the
// contract OpenClaw's loader enforces — and that contract is exactly what broke in #46/CI-Hub#894:
// OpenClaw throws "plugin register must be synchronous" if register() returns a promise, which
// silently stopped the plugin loading at all. A byte-compare is blind to that class of bug.
//
// So this drives the real vendored bundle + shim through a stub `api`, asserting:
//   1. the bundle exports a synchronous register(), and the shim wires it up,
//   2. register() returns synchronously (never a thenable) — the #46 contract,
//   3. with wake credentials present, it mounts POST /hooks/hub-wake (the plugin's core surface,
//      the wall that made the Hub's wake unreachable in CI-Hub#897).
//
// Dependency-free by design (node:test + node:assert only), so it runs under `npm run test:unit`
// with no install — matching the rest of the suite.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..", "openclaw-context", "plugins", "ci-hub");
const BUNDLE_URL = pathToFileURL(join(PLUGIN_DIR, "hub-plugin.mjs")).href;
const SHIM_URL = pathToFileURL(join(PLUGIN_DIR, "index.js")).href;

const bundle = await import(BUNDLE_URL);
const shim = (await import(SHIM_URL)).default;

// Every env var register() reads. Cleared before each case so a stray host env can't change the
// code path under test.
const ENV_KEYS = [
  "HUB_URL",
  "HUB_API_KEY",
  "HUB_MCP_API_KEY",
  "HUB_WAKE_SECRET",
  "CI_HUB_PLUGIN_INFERENCE",
  "HUB_MCP_LEGACY_CLIENT",
  "OLLAMA_HOST",
];

/**
 * Build a stub OpenClaw plugin `api` that records what the plugin registers. Provider/speech
 * registration only happens on the inference path (gated off by default); they are stubbed as
 * no-ops so the test stays green even if that path is ever exercised.
 */
function makeApi() {
  const routes = [];
  const logs = { error: [], warn: [], info: [] };
  const api = {
    registerHttpRoute(route) {
      routes.push(route);
    },
    registerProvider() {},
    registerSpeechProvider() {},
    log: {
      debug() {},
      info(m) {
        logs.info.push(m);
      },
      warn(m) {
        logs.warn.push(m);
      },
      error(m) {
        logs.error.push(m);
      },
    },
  };
  return { api, routes, logs };
}

/** True if `value` is a promise/thenable — i.e. register() failed the synchronous contract. */
function isThenable(value) {
  return value != null && typeof value.then === "function";
}

let savedEnv;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("ci-hub plugin bundle + shim load contract", () => {
  test("the bundle exports a register() function", () => {
    assert.equal(typeof bundle.register, "function", "hub-plugin.mjs must export register()");
  });

  test("the shim exposes the ci-hub plugin with a register() function", () => {
    assert.equal(shim.id, "ci-hub");
    assert.equal(typeof shim.register, "function");
  });

  test("register() returns synchronously with no credentials (the #46 contract)", () => {
    const { api, routes } = makeApi();
    const ret = shim.register(api);
    assert.equal(isThenable(ret), false, 'register() must not return a promise ("must be synchronous")');
    assert.equal(routes.length, 0, "no wake route without HUB_WAKE_SECRET");
  });

  test("register() mounts POST /hooks/hub-wake when wake credentials are present", () => {
    process.env.HUB_URL = "http://127.0.0.1:9"; // unreachable; the health probe is fire-and-forget
    process.env.HUB_MCP_API_KEY = "test-key";
    process.env.HUB_WAKE_SECRET = "test-secret";

    // The plugin's health probe uses global fetch; stub it so the test does no real network I/O.
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("fetch disabled in test"));
    try {
      const { api, routes } = makeApi();
      const ret = shim.register(api);
      assert.equal(isThenable(ret), false, "register() must stay synchronous on the credentialed path too");
      const wake = routes.find((r) => r.path === "/hooks/hub-wake");
      assert.ok(wake, "expected a /hooks/hub-wake route to be registered");
      assert.equal(wake.method, "POST");
      assert.equal(typeof wake.handler, "function");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
