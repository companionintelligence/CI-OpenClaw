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

function makeApi(env = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith("CI_SERVER")) delete process.env[k];
  Object.assign(process.env, env);
  const hooks = {};
  const api = {
    registerMemoryCapability() {}, registerTool() {}, registerHook() {},
    registerCommand() {}, on(name, handler) { hooks[name] = handler; },
    log: { debug() {}, info() {}, warn() {}, error() {} }, pluginConfig: {},
  };
  return { api, hooks };
}

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
const wait = () => new Promise((r) => setTimeout(r, 60));

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
    await wait();
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
    await wait();
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
    await wait();
    assert.equal(cap.length, 0);
  }));

await test("CI-Server 500 is swallowed (turn never breaks)", () =>
  withCiServer((req, res) => { res.writeHead(500); res.end('{"error":"boom"}'); }, async (port) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "k5" });
    plugin.register(api);
    await hooks.agent_end({ success: true, messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] }, {});
    await wait();
  }));

await test("failed turn (success:false) is skipped", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "k6" });
    plugin.register(api);
    await hooks.agent_end({ success: false, messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] }, {});
    await wait();
    assert.equal(cap.length, 0);
  }));

await test("user with no assistant reply posts nothing", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "k7" });
    plugin.register(api);
    await hooks.agent_end({ success: true, messages: [{ role: "user", content: "only user" }] }, {});
    await wait();
    assert.equal(cap.length, 0);
  }));

await test("unpaired assistant (no preceding user) posts nothing", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "k8" });
    plugin.register(api);
    await hooks.agent_end({ success: true, messages: [{ role: "assistant", content: "proactive ping" }] }, {});
    await wait();
    assert.equal(cap.length, 0);
  }));

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
