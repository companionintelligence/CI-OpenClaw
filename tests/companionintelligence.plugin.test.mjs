#!/usr/bin/env node
// Tests for the companionintelligence memory plugin's CI-Server turn-sync.
// Drives the real plugin default export with a stub `api` and a mock CI-Server,
// verifying the agent_end / before_compaction hooks post the right
// /api/memory/turn payloads without touching the network or a real gateway.
//
// Run: node tests/companionintelligence.plugin.test.mjs

import http from "node:http";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(
  HERE,
  "..",
  "openclaw-context",
  "plugins",
  "companionintelligence",
  "index.js",
);

let PASS = 0;
let FAIL = 0;
function ok(label) { console.log(`  ✓ ${label}`); PASS++; }
function bad(label, err) { console.log(`  ✗ ${label}\n    ${err}`); FAIL++; }
async function test(label, fn) {
  try { await fn(); ok(label); } catch (err) { bad(label, err?.message || err); }
}

const plugin = (await import(PLUGIN)).default;

function makeApi(env = {}, pluginConfig = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith("CI_SERVER")) delete process.env[k];
  // Executable intent tools fetch the catalog inside register(); keep them off
  // by default so each test's captured-request assertions stay deterministic.
  process.env.CI_INTENT_TOOLS_ENABLED = "false";
  Object.assign(process.env, env);
  const hooks = {};
  const regHooks = {};
  const api = {
    registerMemoryCapability() {}, registerTool() {},
    registerHook(name, handler) { regHooks[name] = handler; },
    registerCommand() {}, on(name, handler) { hooks[name] = handler; },
    log: { debug() {}, info() {}, warn() {}, error() {} }, pluginConfig,
  };
  return { api, hooks, regHooks };
}

const CI_MEMORY_ACTIVE_CFG = { plugins: { slots: { memory: "companionintelligence" } } };

async function withCiServer(handler, fn) {
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push({ method: req.method, url: req.url, key: req.headers["x-api-key"], body: body ? JSON.parse(body) : null });
      handler(req, res);
    });
  });
  await new Promise((r) => server.listen(0, r));
  try { await fn(server.address().port, captured); }
  finally { await new Promise((r) => server.close(r)); }
}
const created = (req, res) => { res.writeHead(201, { "Content-Type": "application/json" }); res.end("{}"); };

await test("registers agent_end + before_compaction (and keeps before_tool_call)", () => {
  const { api, hooks } = makeApi();
  plugin.register(api);
  assert.ok(hooks.agent_end && hooks.before_compaction && hooks.before_tool_call);
});

await test("agent_end posts only the latest user/assistant exchange", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "k1" });
    plugin.register(api);
    await hooks.agent_end({ success: true, messages: [
      { role: "user", content: "first q" },
      { role: "assistant", content: [{ type: "text", text: "first a" }] },
      { role: "user", content: "second q" },
      { role: "tool", content: "noise" },
      { role: "assistant", content: [{ type: "output_text", text: "second a" }] },
    ] }, { sessionId: "s1" });
    const t = cap.find((c) => c.url === "/api/memory/turn");
    assert.equal(t.key, "k1");
    assert.equal(t.body.platform, "openclaw");
    assert.equal(t.body.sessionId, "s1");
    assert.deepEqual(t.body.messages, [
      { role: "user", content: "second q" },
      { role: "assistant", content: "second a" },
    ]);
  }));

await test("before_compaction flushes the dropped user/assistant messages", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "k2" });
    plugin.register(api);
    await hooks.before_compaction({ messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ] }, { sessionKey: "s2" });
    const t = cap.find((c) => c.url === "/api/memory/turn");
    assert.equal(t.body.sessionId, "s2");
    assert.deepEqual(t.body.messages, [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ]);
  }));

await test("unconfigured CI-Server: no network call, no throw", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi(); // no CI_SERVER_* env
    plugin.register(api);
    await hooks.agent_end({ success: true, messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] }, {});
    assert.equal(cap.length, 0);
  }));

await test("CI-Server 500 is swallowed (turn never breaks)", () =>
  withCiServer((req, res) => { res.writeHead(500); res.end('{"error":"boom"}'); }, async (port) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "k5" });
    plugin.register(api);
    await hooks.agent_end({ success: true, messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] }, {});
  }));

await test("failed turn (success:false) is skipped", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "k6" });
    plugin.register(api);
    await hooks.agent_end({ success: false, messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] }, {});
    assert.equal(cap.length, 0);
  }));

await test("user with no assistant reply posts nothing", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "k7" });
    plugin.register(api);
    await hooks.agent_end({ success: true, messages: [{ role: "user", content: "only user" }] }, {});
    assert.equal(cap.length, 0);
  }));

await test("unpaired assistant (no preceding user) posts nothing", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "k8" });
    plugin.register(api);
    await hooks.agent_end({ success: true, messages: [{ role: "assistant", content: "proactive ping" }] }, {});
    assert.equal(cap.length, 0);
  }));

const INTENT_MANIFEST = {
  version: "1.0.0",
  domains: [
    { key: "predictions", title: "Predictions", description: "x" },
    { key: "memory", title: "Memory", description: "x" },
  ],
  entities: [],
  intents: [
    {
      name: "predictions.forecast",
      tool: "predictions_forecast",
      domain: "predictions",
      title: "Forecast activities",
      description: "Forecast the user's likely activities.",
      parameters: { type: "object", properties: { horizon: { type: "string" } } },
      privacy: { access: "read", sensitivity: "personal", destructive: false, external: false },
      consumes: [], produces: [], phrases: [],
    },
    {
      name: "memory.forget",
      tool: "memory_forget",
      domain: "memory",
      title: "Forget knowledge",
      description: "Archive or delete knowledge.",
      parameters: { type: "object" },
      privacy: { access: "delete", sensitivity: "personal", destructive: true, external: false },
      consumes: [], produces: [], phrases: [],
    },
  ],
};

// Mirrors a current CI-Server build: catalog served from the legacy /api/intents
// path only, and the generic execute endpoint likewise under /api/intents.
const intentServer = (req, res) => {
  const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "GET" && req.url === "/api/intents") return json(200, INTENT_MANIFEST);
  if (req.method === "POST" && req.url === "/api/intents/predictions.forecast/execute") {
    return json(200, { success: true, data: { available: true }, executionTimeMs: 2 });
  }
  json(404, {});
};

await test("intent tools register from the catalog and execute via POST /api/intents/:name/execute", () =>
  withCiServer(intentServer, async (port, cap) => {
    const { api } = makeApi({
      CI_SERVER_URL: `http://127.0.0.1:${port}`,
      CI_SERVER_TOKEN: "ki",
      CI_INTENT_TOOLS_ENABLED: "true",
    });
    const factories = {};
    api.registerTool = (factory, opts) => { factories[opts.name] = factory; };
    plugin.register(api);
    // Registration is fire-and-forget over real HTTP; poll briefly.
    for (let i = 0; i < 200 && !factories["predictions_forecast"]; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(factories["predictions_forecast"], "intent tool registered from the catalog");
    assert.ok(!factories["memory_forget"], "destructive intent must not register");
    const result = await factories["predictions_forecast"]().execute("t1", { horizon: "24h" });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data, { available: true });
    const exec = cap.find((c) => c.url === "/api/intents/predictions.forecast/execute");
    assert.ok(exec, "execute POST reached the server");
    assert.equal(exec.method, "POST");
    assert.equal(exec.key, "ki");
    assert.deepEqual(exec.body, { horizon: "24h" });
    // The canonical agent execute path was tried first and fell back on 404.
    assert.ok(cap.some((c) => c.url === "/api/agent/intents/predictions.forecast/execute"));
  }));

const contextServer = (block) => (req, res) => {
  if (req.url === "/api/memory/context") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ block }));
    return;
  }
  res.writeHead(404); res.end("{}");
};

await test("agent:bootstrap injects guidance + live user-context into AGENTS.md", () =>
  withCiServer(contextServer("# User Context\n- Name: Test User\n- Pref: Bowling"), async (port, cap) => {
    const { api, regHooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kb" });
    plugin.register(api);
    const context = { cfg: CI_MEMORY_ACTIVE_CFG, bootstrapFiles: [] };
    await regHooks["agent:bootstrap"]({ context });
    const agents = context.bootstrapFiles.find((f) => f.name === "AGENTS.md");
    assert.ok(agents, "AGENTS.md created");
    assert.ok(agents.content.includes("Companion Intelligence is the active OpenClaw memory backend."), "guidance present");
    assert.ok(agents.content.includes("- Name: Test User"), "live profile present");
    assert.ok(agents.content.includes("- Pref: Bowling"), "preferences present");
    assert.ok(cap.some((c) => c.url === "/api/memory/context" && c.key === "kb"), "context fetched with key");
  }));

await test("agent:bootstrap is idempotent (no duplicate user-context block)", () =>
  withCiServer(contextServer("# User Context\n- Name: Test User"), async (port) => {
    const { api, regHooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kb2" });
    plugin.register(api);
    const context = { cfg: CI_MEMORY_ACTIVE_CFG, bootstrapFiles: [] };
    await regHooks["agent:bootstrap"]({ context });
    await regHooks["agent:bootstrap"]({ context });
    const agents = context.bootstrapFiles.find((f) => f.name === "AGENTS.md");
    const markers = agents.content.split("<!-- ci-memory:user-context -->").length - 1;
    assert.equal(markers, 1, "user-context injected exactly once");
  }));

await test("agent:bootstrap degrades to guidance-only when context fetch fails", () =>
  withCiServer((req, res) => { res.writeHead(500); res.end("{}"); }, async (port) => {
    const { api, regHooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kc" });
    plugin.register(api);
    const context = { cfg: CI_MEMORY_ACTIVE_CFG, bootstrapFiles: [] };
    await regHooks["agent:bootstrap"]({ context });
    const agents = context.bootstrapFiles.find((f) => f.name === "AGENTS.md");
    assert.ok(agents.content.includes("Companion Intelligence is the active OpenClaw memory backend."), "guidance still present");
    assert.ok(!agents.content.includes("<!-- ci-memory:user-context -->"), "no profile block on failure");
  }));

await test("agent:bootstrap respects injectUserContext:false opt-out (guidance only, no fetch)", () =>
  withCiServer(contextServer("# User Context\n- Name: Test User"), async (port, cap) => {
    const { api, regHooks } = makeApi(
      { CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "ke" },
      { injectUserContext: false },
    );
    plugin.register(api);
    const context = { cfg: CI_MEMORY_ACTIVE_CFG, bootstrapFiles: [] };
    await regHooks["agent:bootstrap"]({ context });
    const agents = context.bootstrapFiles.find((f) => f.name === "AGENTS.md");
    assert.ok(agents.content.includes("Companion Intelligence is the active OpenClaw memory backend."), "guidance present");
    assert.ok(!agents.content.includes("<!-- ci-memory:user-context -->"), "no profile block when opted out");
    assert.ok(!cap.some((c) => c.url === "/api/memory/context"), "no context fetch when opted out");
  }));

await test("agent:bootstrap is a no-op when CI memory is not the active backend", () =>
  withCiServer(contextServer("# User Context"), async (port, cap) => {
    const { api, regHooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kd" });
    plugin.register(api);
    const context = { cfg: { plugins: { slots: { memory: "memory-core" } } }, bootstrapFiles: [] };
    await regHooks["agent:bootstrap"]({ context });
    assert.equal(context.bootstrapFiles.length, 0, "nothing injected");
    assert.equal(cap.length, 0, "no context fetch");
  }));

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
