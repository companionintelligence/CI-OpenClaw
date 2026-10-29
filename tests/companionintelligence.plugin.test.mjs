#!/usr/bin/env node
// Tests for the companionintelligence memory plugin's CI-Server turn-sync.
// Drives the real plugin default export with a stub `api` and a mock CI-Server,
// verifying the agent_end / before_compaction hooks post the right
// /api/memory/turn payloads without touching the network or a real gateway.
//
// Run: node tests/companionintelligence.plugin.test.mjs

import http from "node:http";
import assert from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// `pathToFileURL`, not the bare path. A dynamic `import()` of an ABSOLUTE path
// works on POSIX by accident — the leading `/` reads as a URL path — but on
// Windows `C:\...` is parsed as a URL with scheme `c:` and Node rejects the whole
// module with ERR_UNSUPPORTED_ESM_URL_SCHEME. That took this entire suite out on
// any Windows checkout: it failed at load, so every test below silently never ran.
const PLUGIN = pathToFileURL(
  path.join(HERE, "..", "openclaw-context", "plugins", "companionintelligence", "index.js"),
).href;

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
  // ci_run_intent is off by default; the intent test opts in.
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

// A Hub wake runs as a heartbeat turn whose user message is OpenClaw's: the wake as a
// `System: [<ts>] <text>` line, then the heartbeat instruction. Memory files a turn's
// user side as the owner's own words, so a wake exchange must never reach it.
// As the Hub words an event for POST /hooks/wake (wake-text.ts).
const WAKE_ALERT =
  "System: [2026-10-29 09:14:02 PDT] CI-Hub [high] app.crashed \u2014 app \"stirling-pdf\" (stirling-pdf:umbrel) stopped unexpectedly. It was previously running.";
const WAKE_DISPATCH = "System: [2026-10-29 09:15:40 PDT] Memory dispatch job 01a061f8-755e-731f-9d11-a60906902ffa. Fetch the packet from Memory.";
// openclaw@2026.9.1's default heartbeat instruction.
const HEARTBEAT =
  "Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY.";

await test("agent_end skips a heartbeat turn by its trigger", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kw1" });
    plugin.register(api);
    await hooks.agent_end({ success: true, messages: [
      { role: "user", content: "what is on my calendar today?" },
      { role: "assistant", content: "Dentist at 3." },
      { role: "user", content: "an unmarked message" },
      { role: "assistant", content: "the reply to it" },
    ] }, { sessionId: "s1", trigger: "heartbeat" });
    assert.equal(cap.filter((c) => c.url === "/api/memory/turn").length, 0);
  }));

await test("agent_end skips the whole wake exchange, not just the wake (no pairing with the turn before)", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kw2" });
    plugin.register(api);
    // No trigger in ctx: the text is all there is to go on.
    await hooks.agent_end({ success: true, messages: [
      { role: "user", content: "what is on my calendar today?" },
      { role: "assistant", content: "Dentist at 3." },
      { role: "user", content: `${WAKE_ALERT}\n\n${HEARTBEAT}` },
      { role: "assistant", content: "stirling-pdf crashed; I restarted it." },
    ] }, { sessionId: "s1" });
    // Dropping only the wake would have posted [calendar question, "stirling-pdf crashed"].
    assert.equal(cap.filter((c) => c.url === "/api/memory/turn").length, 0);
  }));

await test("agent_end skips a dispatch wake and one the ci-hub plugin sent as its own message", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kw3" });
    plugin.register(api);
    await hooks.agent_end({ success: true, messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "CI-Hub alert (medium): App fetch-mcp: restart failed." },
      { role: "assistant", content: "Looking into fetch-mcp." },
    ] }, { sessionId: "s1" });
    await hooks.agent_end({ success: true, messages: [
      { role: "user", content: `${WAKE_DISPATCH}\n\n${HEARTBEAT}` },
      { role: "assistant", content: "Fetching the packet." },
    ] }, { sessionId: "s1" });
    await hooks.agent_end({ success: true, messages: [
      { role: "user", content: "[OpenClaw heartbeat poll]" },
      { role: "assistant", content: "HEARTBEAT_OK" },
    ] }, { sessionId: "s1" });
    assert.equal(cap.filter((c) => c.url === "/api/memory/turn").length, 0);
  }));

await test("agent_end keeps the owner's words when queued wake lines ride in front of them", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kw4" });
    plugin.register(api);
    await hooks.agent_end({ success: true, messages: [
      { role: "user", content: `${WAKE_ALERT}\n\nremind me to call the plumber` },
      { role: "assistant", content: "Reminder set." },
    ] }, { sessionId: "s1", trigger: "user" });
    const t = cap.find((c) => c.url === "/api/memory/turn");
    assert.deepEqual(t.body.messages, [
      { role: "user", content: "remind me to call the plumber" },
      { role: "assistant", content: "Reminder set." },
    ]);
  }));

await test("agent_end keeps a message the owner typed starting with System:", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kw5" });
    plugin.register(api);
    // OpenClaw rewrites a typed leading "System:" to "System (untrusted):".
    await hooks.agent_end({ success: true, messages: [
      { role: "user", content: "System (untrusted): what does this log line mean?" },
      { role: "assistant", content: "It means the disk is full." },
    ] }, { sessionId: "s1" });
    const t = cap.find((c) => c.url === "/api/memory/turn");
    assert.deepEqual(t.body.messages, [
      { role: "user", content: "System (untrusted): what does this log line mean?" },
      { role: "assistant", content: "It means the disk is full." },
    ]);
  }));

await test("before_compaction leaves wake exchanges out and keeps the owner's around them", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kw6" });
    plugin.register(api);
    await hooks.before_compaction({ messages: [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: `${WAKE_ALERT}\n\n${HEARTBEAT}` },
      { role: "assistant", content: "checking stirling-pdf" },
      { role: "tool", content: "restart ok" },
      { role: "assistant", content: "stirling-pdf is back" },
      { role: "user", content: `${WAKE_DISPATCH}\n\n${HEARTBEAT}` },
      { role: "assistant", content: "Fetching the packet." },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ] }, { sessionKey: "s2" });
    const t = cap.find((c) => c.url === "/api/memory/turn");
    assert.deepEqual(t.body.messages, [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ]);
  }));

await test("an owner message that drained a queued wake keeps the owner's words, with no trigger to go on", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kw12" });
    plugin.register(api);
    const messages = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: `${WAKE_ALERT}\n${WAKE_DISPATCH}\n\nremind me to call the plumber` },
      { role: "assistant", content: "Reminder set." },
    ];
    await hooks.before_compaction({ messages }, { sessionKey: "s2" });
    await hooks.agent_end({ success: true, messages }, { sessionId: "s2" });
    const [compacted, ended] = cap.filter((c) => c.url === "/api/memory/turn").map((c) => c.body.messages);
    assert.deepEqual(compacted, [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "remind me to call the plumber" },
      { role: "assistant", content: "Reminder set." },
    ]);
    assert.deepEqual(ended, [
      { role: "user", content: "remind me to call the plumber" },
      { role: "assistant", content: "Reminder set." },
    ]);
  }));

await test("before_compaction of nothing but wake exchanges posts nothing", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kw7" });
    plugin.register(api);
    await hooks.before_compaction({ messages: [
      { role: "user", content: `${WAKE_ALERT}\n\n${HEARTBEAT}` },
      { role: "assistant", content: "checking stirling-pdf" },
    ] }, { sessionKey: "s2" });
    assert.equal(cap.filter((c) => c.url === "/api/memory/turn").length, 0);
  }));

await test("before_compaction leaves out heartbeat turns with no wake in them", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kw9" });
    plugin.register(api);
    await hooks.before_compaction({ messages: [
      { role: "user", content: HEARTBEAT },
      { role: "assistant", content: "NO_REPLY" },
      { role: "user", content: "Run the following periodic tasks (only those due based on their intervals):\n- inbox: check mail" },
      { role: "assistant", content: "Nothing due." },
      { role: "user", content: "Delivery: queued\n\n[OpenClaw heartbeat poll]" },
      { role: "assistant", content: "NO_REPLY" },
      { role: "user", content: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly." },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ] }, { sessionKey: "s2" });
    const t = cap.find((c) => c.url === "/api/memory/turn");
    assert.deepEqual(t.body.messages, [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ]);
  }));

await test("before_compaction keeps owner messages that only mention heartbeats or a dispatch job", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kw10" });
    plugin.register(api);
    const messages = [
      { role: "user", content: "read HEARTBEAT.md and tell me what's scheduled" },
      { role: "assistant", content: "Two checks are scheduled." },
      { role: "user", content: "Memory dispatch job 01a061f8-755e-731f-9d11-a60906902ffa failed, why?" },
      { role: "assistant", content: "The packet had expired." },
    ];
    await hooks.before_compaction({ messages }, { sessionKey: "s2" });
    const t = cap.find((c) => c.url === "/api/memory/turn");
    assert.deepEqual(t.body.messages, messages);
  }));

await test("a caption-less photo after a wake ends the wake, so the reply to it is kept", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kw11" });
    plugin.register(api);
    await hooks.before_compaction({ messages: [
      { role: "user", content: `${WAKE_ALERT}\n\n${HEARTBEAT}` },
      { role: "assistant", content: "checking stirling-pdf" },
      { role: "user", content: [{ type: "image", source: { type: "base64", data: "AAAA" } }] },
      { role: "assistant", content: "That's a broken hinge." },
    ] }, { sessionKey: "s2" });
    const t = cap.find((c) => c.url === "/api/memory/turn");
    assert.deepEqual(t.body.messages, [{ role: "assistant", content: "That's a broken hinge." }]);
  }));

await test("a dispatch wake still checkpoints its job while the exchange stays out of memory", () =>
  withCiServer(created, async (port, cap) => {
    const { api, hooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kw8" });
    plugin.register(api);
    await hooks.agent_end({ success: true, messages: [
      { role: "user", content: `${WAKE_DISPATCH}\n\n${HEARTBEAT}` },
      { role: "assistant", content: "I'll fetch the packet" },
    ] }, { sessionId: "s1", trigger: "heartbeat" });
    assert.equal(cap.filter((c) => c.url === "/api/memory/turn").length, 0);
    assert.ok(cap.some((c) => c.url === "/api/v1/agent/jobs/01a061f8-755e-731f-9d11-a60906902ffa/packet"));
    const checkpoint = cap.find((c) => c.url === "/api/v1/agent/jobs/01a061f8-755e-731f-9d11-a60906902ffa/checkpoint");
    assert.ok(checkpoint, "checkpoint POST missing");
    assert.deepEqual(checkpoint.body.turns, [{ role: "assistant", content: "I'll fetch the packet" }]);
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

await test("ci_run_intent executes a catalog intent via POST /api/intents/:name/execute", () =>
  withCiServer(intentServer, async (port, cap) => {
    const { api } = makeApi({
      CI_SERVER_URL: `http://127.0.0.1:${port}`,
      CI_SERVER_TOKEN: "ki",
      CI_INTENT_TOOLS_ENABLED: "true",
    });
    const factories = {};
    api.registerTool = (factory, opts) => { factories[opts.name] = factory; };
    plugin.register(api);
    // Registered inside register(): OpenClaw drops anything registered later.
    assert.ok(factories["ci_run_intent"], "ci_run_intent registered during register()");
    assert.equal(factories["predictions_forecast"], undefined, "no per-intent tools");
    const result = await factories["ci_run_intent"]().execute("t1", { intent: "predictions.forecast", params: { horizon: "24h" } });
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

// Windows and macOS filesystems are case-insensitive, so the bootstrap entry for
// the workspace agents file can arrive as `agents.md`. An exact-case lookup would
// miss it and push a SECOND entry aliasing the same file on disk, leaving the
// user's real content without the guidance.
await test("agent:bootstrap appends to an existing lowercase agents.md rather than duplicating it", () =>
  withCiServer(contextServer("# User Context\n- Name: Test User"), async (port) => {
    const { api, regHooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kf" });
    plugin.register(api);
    const existing = { name: "agents.md", path: "agents.md", missing: false, content: "# My project rules\n" };
    const context = { cfg: CI_MEMORY_ACTIVE_CFG, bootstrapFiles: [existing] };
    await regHooks["agent:bootstrap"]({ context });
    assert.equal(context.bootstrapFiles.length, 1, "no duplicate agents file entry");
    assert.ok(existing.content.includes("# My project rules"), "original content preserved");
    assert.ok(
      existing.content.includes("Companion Intelligence is the active OpenClaw memory backend."),
      "guidance appended to the existing file",
    );
    assert.ok(existing.content.includes("<!-- ci-memory:user-context -->"), "user context appended too");
  }));

// On Linux the two names ARE two files and can both exist. The case-insensitive
// fallback above must not become "whichever happens to be first in the array", or the
// guidance quietly moves to the file the rest of the ecosystem does not read.
await test("agent:bootstrap prefers an exact AGENTS.md over a lowercase sibling", () =>
  withCiServer(contextServer("# User Context"), async (port) => {
    const { api, regHooks } = makeApi({ CI_SERVER_URL: `http://127.0.0.1:${port}`, CI_SERVER_TOKEN: "kg" });
    plugin.register(api);
    const lower = { name: "agents.md", path: "agents.md", missing: false, content: "# lower\n" };
    const exact = { name: "AGENTS.md", path: "AGENTS.md", missing: false, content: "# exact\n" };
    // Lowercase listed FIRST, so array order alone would pick the wrong one.
    const context = { cfg: CI_MEMORY_ACTIVE_CFG, bootstrapFiles: [lower, exact] };
    await regHooks["agent:bootstrap"]({ context });
    assert.equal(context.bootstrapFiles.length, 2, "neither entry duplicated");
    assert.ok(
      exact.content.includes("Companion Intelligence is the active OpenClaw memory backend."),
      "guidance went to AGENTS.md",
    );
    assert.equal(lower.content, "# lower\n", "the lowercase sibling is left alone");
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
