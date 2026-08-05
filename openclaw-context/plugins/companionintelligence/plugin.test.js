import test from "node:test";
import assert from "node:assert";

import plugin, { featureEnabled, normalizeBaseUrl, registerIntentTools } from "./index.js";

const FLAGS = [
  "CI_MEMORY_CONTEXT_ENABLED",
  "CI_MEMORY_RECALL_ENABLED",
  "CI_MEMORY_TURN_ENABLED",
  "CI_MEMORY_WRITE_ENABLED",
  "CI_INTENTS_ENABLED",
  "CI_INTENT_TOOLS_ENABLED",
];

function clearFlags() {
  for (const f of FLAGS) delete process.env[f];
}

function makeApi() {
  const tools = [];
  const toolFactories = {};
  const commands = [];
  const handlers = {};
  const warns = [];
  return {
    pluginConfig: { url: "http://ci-server:8642", token: "tok" },
    config: {},
    runtime: {},
    registerMemoryCapability() {},
    registerTool(factory, opts) {
      tools.push(opts.name);
      toolFactories[opts.name] = factory;
    },
    registerCommand(opts) {
      commands.push(opts?.name ?? opts);
    },
    registerHook(name, fn) {
      handlers[name] = fn;
    },
    on(name, fn) {
      handlers[name] = fn;
    },
    log: { debug() {}, info() {}, warn(msg) { warns.push(String(msg)); } },
    _tools: tools,
    _toolFactories: toolFactories,
    _commands: commands,
    _handlers: handlers,
    _warns: warns,
  };
}

const MANIFEST = {
  version: "1.0.0",
  domains: [{ key: "memory", title: "Memory", description: "x" }],
  entities: [],
  intents: [
    {
      name: "memory.recall",
      tool: "memory_recall",
      domain: "memory",
      title: "Recall",
      description: "Recall stored facts.",
      parameters: { type: "object" },
      privacy: { access: "read", sensitivity: "personal", destructive: false, external: false },
      consumes: [],
      produces: ["concept"],
      phrases: [],
    },
  ],
};

// Register the plugin with the given env flags set. Flags are left in place so
// hook handlers (which re-check the flag when invoked) see them; the next call
// clears first. Executable intent tools are disabled by default here (their
// registration fetches the catalog inside register(), which would pollute the
// mocked-fetch call counts in unrelated tests); the intent-tool tests opt in.
function register(env = {}) {
  clearFlags();
  process.env.CI_INTENT_TOOLS_ENABLED = "false";
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const api = makeApi();
  plugin.register(api);
  return api;
}

// ── pure helpers ────────────────────────────────────────────────────────────

test("featureEnabled defaults on; off for falsy values", () => {
  delete process.env.CI_TEST_FLAG;
  assert.equal(featureEnabled("CI_TEST_FLAG"), true);
  for (const v of ["0", "false", "FALSE", "no", "off", " Off "]) {
    process.env.CI_TEST_FLAG = v;
    assert.equal(featureEnabled("CI_TEST_FLAG"), false, v);
  }
  for (const v of ["1", "true", "yes", "on", "whatever"]) {
    process.env.CI_TEST_FLAG = v;
    assert.equal(featureEnabled("CI_TEST_FLAG"), true, v);
  }
  delete process.env.CI_TEST_FLAG;
});

test("normalizeBaseUrl strips trailing slashes and a legacy /api/mcp suffix", () => {
  assert.equal(normalizeBaseUrl("http://ci:8642/"), "http://ci:8642");
  assert.equal(normalizeBaseUrl("http://ci:8642/api/mcp"), "http://ci:8642");
  assert.equal(normalizeBaseUrl("http://ci:8642/api/mcp/"), "http://ci:8642");
  assert.equal(normalizeBaseUrl("http://ci:8642"), "http://ci:8642");
});

// ── tool-registration gating ─────────────────────────────────────────────────

test("registers all memory + intent tools by default", () => {
  const api = register();
  assert.deepEqual([...api._tools].sort(), [
    "ci_list_intents",
    "memory_get",
    "memory_search",
    "memory_store",
  ]);
  clearFlags();
});

test("each disabled API system omits exactly its tool", () => {
  assert.ok(!register({ CI_MEMORY_RECALL_ENABLED: "false" })._tools.includes("memory_search"));
  assert.ok(!register({ CI_MEMORY_CONTEXT_ENABLED: "false" })._tools.includes("memory_get"));
  assert.ok(!register({ CI_MEMORY_WRITE_ENABLED: "false" })._tools.includes("memory_store"));
  assert.ok(!register({ CI_INTENTS_ENABLED: "false" })._tools.includes("ci_list_intents"));
  // Disabling one leaves the others registered.
  assert.deepEqual([...register({ CI_INTENTS_ENABLED: "false" })._tools].sort(), [
    "memory_get",
    "memory_search",
    "memory_store",
  ]);
  clearFlags();
});

// ── turn-sync hook gating ─────────────────────────────────────────────────────

async function runAgentEnd(api) {
  const handler = api._handlers["agent_end"];
  assert.equal(typeof handler, "function");
  await handler(
    { success: true, messages: [{ role: "user", content: "u" }, { role: "assistant", content: "a" }] },
    { sessionId: "s1" },
  );
}

test("agent_end posts a turn (POST /api/memory/turn with platform/sessionId and auth headers)", async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: true, status: 200, text: async () => "{}" };
  };
  try {
    await runAgentEnd(register());
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("/api/memory/turn"), calls[0].url);
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.headers["x-api-key"], "tok");
    assert.equal(calls[0].opts.headers["Content-Type"], "application/json");
    assert.equal(calls[0].opts.headers["Accept"], "application/json");
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.platform, "openclaw");
    assert.equal(body.sessionId, "s1");
    assert.ok(Array.isArray(body.messages) && body.messages.length >= 1);
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

test("agent_end no-ops (no fetch) when CI_MEMORY_TURN_ENABLED=off", async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (...a) => {
    calls.push(a);
    return { ok: true, status: 200, text: async () => "{}" };
  };
  try {
    await runAgentEnd(register({ CI_MEMORY_TURN_ENABLED: "false" }));
    assert.equal(calls.length, 0, "turn sync must not fire when disabled");
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

async function runBeforeCompaction(api) {
  const handler = api._handlers["before_compaction"];
  assert.equal(typeof handler, "function");
  await handler(
    { messages: [{ role: "user", content: "u" }, { role: "assistant", content: "a" }] },
    { sessionId: "s1" },
  );
}

test("before_compaction posts a turn by default (platform/sessionId in body)", async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: true, status: 200, text: async () => "{}" };
  };
  try {
    await runBeforeCompaction(register());
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("/api/memory/turn"), calls[0].url);
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.platform, "openclaw");
    assert.equal(body.sessionId, "s1");
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

test("before_compaction no-ops (no fetch) when CI_MEMORY_TURN_ENABLED=off", async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (...a) => {
    calls.push(a);
    return { ok: true, status: 200, text: async () => "{}" };
  };
  try {
    await runBeforeCompaction(register({ CI_MEMORY_TURN_ENABLED: "false" }));
    assert.equal(calls.length, 0, "turn sync must not fire when disabled");
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

// Exercise a real tool's execute() handler end-to-end (not just registration).
test("ci_list_intents tool fetches /api/intents and returns the rendered catalog", async () => {
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    assert.ok(String(url).includes("/api/intents"), String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify(MANIFEST) };
  };
  try {
    const api = register();
    const tool = api._toolFactories["ci_list_intents"]();
    const result = await tool.execute();
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.available, true);
    assert.deepEqual(payload.domains, ["memory"]);
    assert.ok(payload.catalog.includes("memory_recall"), payload.catalog);
    // No executable intent tools were registered, so no callability note.
    assert.equal(payload.executableTools, undefined);
    assert.ok(!payload.catalog.includes("directly callable"), payload.catalog);
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

// ── executable intent tools (POST /api/intents/:name/execute) ─────────────────

const INTENT_MANIFEST = {
  version: "1.0.0",
  domains: [
    { key: "predictions", title: "Predictions", description: "x" },
    { key: "memory", title: "Memory", description: "x" },
    { key: "media", title: "Media", description: "x" },
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
      consumes: [],
      produces: [],
      phrases: [],
    },
    {
      name: "memory.forget",
      tool: "memory_forget",
      domain: "memory",
      title: "Forget knowledge",
      description: "Archive or delete knowledge.",
      parameters: { type: "object" },
      privacy: { access: "delete", sensitivity: "personal", destructive: true, external: false },
      consumes: [],
      produces: [],
      phrases: [],
    },
    {
      name: "media.streamingAvailability",
      tool: "media_streamingAvailability",
      domain: "media",
      title: "Find where to stream",
      description: "Resolve streaming availability.",
      parameters: { type: "object" },
      privacy: { access: "read", sensitivity: "low", destructive: false, external: true },
      consumes: [],
      produces: [],
      phrases: [],
    },
    {
      // Read-only, but its tool name collides with the plugin's own memory_search.
      name: "memory.recallRaw",
      tool: "memory_search",
      domain: "memory",
      title: "Raw recall",
      description: "Raw recall over memory.",
      parameters: { type: "object" },
      privacy: { access: "read", sensitivity: "personal", destructive: false, external: false },
      consumes: [],
      produces: [],
      phrases: [],
    },
  ],
};

// Serves the manifest at the legacy /api/intents path (the canonical agent path
// 404s, matching current CI-Server builds).
function manifestFetch(url) {
  const u = String(url);
  if (u.includes("/api/agent/intents")) {
    return { ok: false, status: 404, text: async () => "{}" };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(INTENT_MANIFEST) };
}

test("registerIntentTools registers only non-destructive, non-external intents and skips collisions", async () => {
  const origFetch = global.fetch;
  global.fetch = async (url) => manifestFetch(url);
  try {
    const api = makeApi();
    const registered = await registerIntentTools(api);
    // destructive (memory_forget) and external (media_streamingAvailability)
    // are filtered silently; the memory_search collision is skipped + logged.
    assert.deepEqual(registered, ["predictions_forecast"]);
    assert.deepEqual(api._tools, ["predictions_forecast"]);
    assert.equal(api._warns.length, 1);
    assert.ok(api._warns[0].includes("memory_search"), api._warns[0]);
    // The registered tool carries the manifest schema.
    const tool = api._toolFactories["predictions_forecast"]();
    assert.equal(tool.name, "predictions_forecast");
    assert.equal(tool.label, "Forecast activities");
    assert.deepEqual(tool.parameters, INTENT_MANIFEST.intents[0].parameters);
  } finally {
    global.fetch = origFetch;
  }
});

test("intent tool execute POSTs params to the agent path and falls back to /api/intents on 404", async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || "GET";
    calls.push({ url: u, method, body: opts.body, headers: opts.headers });
    if (method === "GET") return manifestFetch(u);
    // POST: the canonical agent execute route is missing on this server build.
    if (u.includes("/api/agent/intents/")) {
      return { ok: false, status: 404, text: async () => '{"message":"Cannot POST"}' };
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ success: true, data: { available: true }, executionTimeMs: 3 }),
    };
  };
  try {
    const api = makeApi();
    await registerIntentTools(api);
    const res = await api._toolFactories["predictions_forecast"]().execute("id", { horizon: "24h" });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data, { available: true });
    const posts = calls.filter((c) => c.method === "POST");
    assert.deepEqual(
      posts.map((c) => new URL(c.url).pathname),
      [
        "/api/agent/intents/predictions.forecast/execute",
        "/api/intents/predictions.forecast/execute",
      ],
    );
    assert.deepEqual(JSON.parse(posts[1].body), { horizon: "24h" });
    assert.equal(posts[1].headers["x-api-key"], "tok");
  } finally {
    global.fetch = origFetch;
  }
});

test("intent tool execute returns a structured error result on non-404 failure (no fallback, no throw)", async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    if (method === "GET") return manifestFetch(url);
    calls.push(String(url));
    return {
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: "destructive intents denied" }),
    };
  };
  try {
    const api = makeApi();
    await registerIntentTools(api);
    const res = await api._toolFactories["predictions_forecast"]().execute("id", {});
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.success, false);
    assert.equal(payload.intent, "predictions.forecast");
    assert.equal(payload.tool, "predictions_forecast");
    assert.ok(payload.error.includes("403"), payload.error);
    assert.ok(payload.error.includes("destructive intents denied"), payload.error);
    // A non-404 failure must not retry the legacy path.
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = origFetch;
  }
});

test("registerIntentTools degrades silently to zero registrations when the catalog is unavailable", async () => {
  const origFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  try {
    const api = makeApi();
    assert.deepEqual(await registerIntentTools(api), []);
    assert.deepEqual(api._tools, []);
  } finally {
    global.fetch = origFetch;
  }
});

test("registerIntentTools makes no request when CI-Server is unconfigured", async () => {
  let called = false;
  const origFetch = global.fetch;
  const origUrl = process.env.CI_SERVER_URL;
  const origToken = process.env.CI_SERVER_TOKEN;
  delete process.env.CI_SERVER_URL;
  delete process.env.CI_SERVER_TOKEN;
  global.fetch = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => "{}" };
  };
  try {
    const api = makeApi();
    api.pluginConfig = {};
    assert.deepEqual(await registerIntentTools(api), []);
    assert.equal(called, false);
  } finally {
    global.fetch = origFetch;
    if (origUrl !== undefined) process.env.CI_SERVER_URL = origUrl;
    if (origToken !== undefined) process.env.CI_SERVER_TOKEN = origToken;
  }
});

test("register() with CI_INTENT_TOOLS_ENABLED wires intent tools and ci_list_intents notes callability", async () => {
  const origFetch = global.fetch;
  global.fetch = async (url) => manifestFetch(url);
  try {
    const api = register({ CI_INTENT_TOOLS_ENABLED: "true" });
    // Registration is fire-and-forget from register(); flush the promise chain.
    await new Promise((r) => setImmediate(r));
    assert.ok(api._tools.includes("predictions_forecast"), String(api._tools));
    assert.ok(!api._tools.includes("memory_forget"), "destructive intent must not register");
    assert.ok(!api._tools.includes("media_streamingAvailability"), "external intent must not register");
    const res = await api._toolFactories["ci_list_intents"]().execute();
    const payload = JSON.parse(res.content[0].text);
    assert.deepEqual(payload.executableTools, ["predictions_forecast"]);
    assert.ok(payload.catalog.includes("directly callable"), payload.catalog);
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

test("intent tools stay off when CI_INTENT_TOOLS_ENABLED or CI_INTENTS_ENABLED is disabled", async () => {
  let gets = 0;
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    gets++;
    return manifestFetch(url);
  };
  try {
    const apiOff = register({ CI_INTENT_TOOLS_ENABLED: "false" });
    await new Promise((r) => setImmediate(r));
    assert.ok(!apiOff._tools.includes("predictions_forecast"));
    assert.equal(gets, 0, "no catalog fetch when the sub-switch is off");

    // The master intents switch also disables the executable tools.
    const apiNoIntents = register({ CI_INTENTS_ENABLED: "false", CI_INTENT_TOOLS_ENABLED: "true" });
    await new Promise((r) => setImmediate(r));
    assert.ok(!apiNoIntents._tools.includes("ci_list_intents"));
    assert.ok(!apiNoIntents._tools.includes("predictions_forecast"));
    assert.equal(gets, 0, "no catalog fetch when intents are off entirely");
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

// ── memory tool execute() handlers — the core memory functionality ────────────

test("memory_search.execute recalls from /api/memory/recall and builds results", async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts?.body });
    return { ok: true, status: 200, text: async () => JSON.stringify({ block: "alpha\nbeta\ngamma" }) };
  };
  try {
    const api = register();
    const res = await api._toolFactories["memory_search"]().execute("id", { query: "hi", maxResults: 3 });
    const payload = JSON.parse(res.content[0].text);
    assert.ok(calls[0].url.includes("/api/memory/recall"), calls[0].url);
    assert.deepEqual(JSON.parse(calls[0].body), { query: "hi", maxResults: 3 });
    // 3 lines / maxResults=3 -> chunkSize 1 -> exactly 3 results, with the
    // scoring schedule [1, 0.9, 0.8] (first chunk = 1.0, others decay).
    assert.equal(payload.results.length, 3);
    assert.equal(payload.results[0].snippet, "alpha");
    assert.equal(payload.results[1].snippet, "beta");
    assert.equal(payload.results[2].snippet, "gamma");
    assert.equal(payload.results[0].score, 1);
    assert.equal(payload.results[1].score, 0.9);
    for (const r of payload.results) {
      assert.equal(r.source, "memory");
      assert.ok(r.path.startsWith("ci-server://recall#"), r.path);
      assert.ok(r.citation.includes("hi"));
    }
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

test("memory_search.execute requires a query and never calls the server", async () => {
  let called = false;
  const origFetch = global.fetch;
  global.fetch = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => "{}" };
  };
  try {
    const api = register();
    const res = await api._toolFactories["memory_search"]().execute("id", { query: "" });
    const payload = JSON.parse(res.content[0].text);
    assert.deepEqual(payload.results, []);
    assert.ok(payload.error);
    assert.equal(called, false);
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

test("memory_get.execute returns the CI-Server profile block", async () => {
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    assert.ok(String(url).includes("/api/memory/context"), String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify({ block: "PROFILE LINE 1\nLINE 2" }) };
  };
  try {
    const api = register();
    const res = await api._toolFactories["memory_get"]().execute("id", { path: "ci-server://profile" });
    assert.ok(JSON.stringify(JSON.parse(res.content[0].text)).includes("PROFILE LINE 1"));
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

test("memory_get.execute reports unsupported non-profile paths without calling the server", async () => {
  let called = false;
  const origFetch = global.fetch;
  global.fetch = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => "{}" };
  };
  try {
    const api = register();
    const res = await api._toolFactories["memory_get"]().execute("id", { path: "/some/file.md" });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.found, false);
    assert.ok(payload.error);
    assert.equal(called, false);
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

test("memory_store.execute writes a durable note with source + sessionId", async () => {
  const posts = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    posts.push({ url: String(url), body: opts?.body });
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "n1" }) };
  };
  try {
    const api = register();
    // memory_store's factory is wrapped to bake the conversation ctx in.
    const tool = api._toolFactories["memory_store"]({ sessionId: "s1" });
    const res = await tool.execute("id", { content: "remember X", title: "T" });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.ok, true);
    assert.ok(posts[0].url.includes("/api/memory/write"), posts[0].url);
    const sent = JSON.parse(posts[0].body);
    assert.equal(sent.content, "remember X");
    assert.equal(sent.source, "openclaw");
    assert.equal(sent.sessionId, "s1");
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

test("memory_store.execute requires content", async () => {
  let called = false;
  const origFetch = global.fetch;
  global.fetch = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => "{}" };
  };
  try {
    const api = register();
    const res = await api._toolFactories["memory_store"]({}).execute("id", { content: "" });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(called, false);
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

test("memory_store.execute falls back to /api/memory/note on 404 with the same POST body", async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts });
    if (u.includes("/api/memory/write")) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: true, status: 200, text: async () => "{}" };
  };
  try {
    const api = register();
    const res = await api._toolFactories["memory_store"]({}).execute("id", { content: "x" });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.includes("/api/memory/write"));
    assert.ok(calls[1].url.includes("/api/memory/note"));
    // The fallback must POST and carry the same payload — a regression that
    // sent GET, dropped the body, or shuffled fields would now fail.
    assert.equal(calls[1].opts.method, "POST");
    const body = JSON.parse(calls[1].opts.body);
    assert.equal(body.content, "x");
    assert.equal(body.source, "openclaw");
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

// ── local-memory-write guard (protects the CI memory backend's integrity) ─────

const CI_ACTIVE = { config: { plugins: { slots: { memory: "companionintelligence" } } } };

test("before_tool_call blocks the agent writing local MEMORY.md when CI memory is active", () => {
  const api = register();
  const guard = api._handlers["before_tool_call"];
  assert.equal(typeof guard, "function");
  const res = guard({ toolName: "write_file", params: { path: "MEMORY.md", content: "x" } }, CI_ACTIVE);
  assert.equal(res?.block, true);
  assert.ok(res.blockReason);
  clearFlags();
});

test("before_tool_call allows normal file writes and the plugin's own memory tools", () => {
  const api = register();
  const guard = api._handlers["before_tool_call"];
  assert.equal(guard({ toolName: "write_file", params: { path: "src/index.ts" } }, CI_ACTIVE), undefined);
  assert.equal(guard({ toolName: "memory_store", params: { content: "remember" } }, CI_ACTIVE), undefined);
  clearFlags();
});

test("before_tool_call does not block when CI memory is not the active backend", () => {
  const api = register();
  const guard = api._handlers["before_tool_call"];
  const ctx = { config: { plugins: { slots: { memory: "other-provider" } } } };
  assert.equal(guard({ toolName: "write_file", params: { path: "MEMORY.md" } }, ctx), undefined);
  clearFlags();
});

// Path matching covers the variants the guard's regex must catch; a regression in
// the regex (case, sub-path, sqlite extension, backslash) would now fail here.
for (const path of [
  "USER.md",
  "user.md",
  "MEMORY.md",
  "/repo/memory/notes.md",
  "/data/.openclaw/memory/main.sqlite",
  "/data/.openclaw/memory/index.sqlite3",
]) {
  test(`before_tool_call blocks a write referencing ${path}`, () => {
    const api = register();
    const res = api._handlers["before_tool_call"]({ toolName: "write_file", params: { path } }, CI_ACTIVE);
    assert.equal(res?.block, true, `path ${path} should be blocked`);
    clearFlags();
  });
}

// The guard has to fire on an ABSOLUTE path to OpenClaw's memory dir, not just
// the packaged app's /data one. These are the forms a stock install actually
// reports — every one of them slipped through before, so the hard block never
// fired anywhere except inside the container.
for (const path of [
  "C:\\Users\\hanzl\\.openclaw\\memory\\main.sqlite",
  "C:/Users/hanzl/.openclaw/memory/main.sqlite",
  "/home/u/.openclaw/memory/main.sqlite",
  "/Users/u/.openclaw/memory/main.sqlite",
  "~/.openclaw/memory/main.sqlite",
  ".openclaw/memory/main.sqlite",
  "sqlite3 C:/Users/hanzl/.openclaw/memory/main.sqlite .tables",
]) {
  test(`before_tool_call blocks the absolute local-memory path ${path}`, () => {
    const api = register();
    const res = api._handlers["before_tool_call"]({ toolName: "write_file", params: { path } }, CI_ACTIVE);
    assert.equal(res?.block, true, `path ${path} should be blocked`);
    clearFlags();
  });
}

// The memory directory itself, with no file under it, is still a blocked target —
// but only when the parameter IS that path, not when a string merely contains it.
for (const path of [
  "/data/.openclaw/memory",
  "~/.openclaw/memory",
  "C:\\Users\\hanzl\\.openclaw\\memory",
  "/home/u/.openclaw/memory/",
]) {
  test(`before_tool_call blocks the local-memory directory ${path}`, () => {
    const api = register();
    const res = api._handlers["before_tool_call"]({ toolName: "write_file", params: { path } }, CI_ACTIVE);
    assert.equal(res?.block, true, `path ${path} should be blocked`);
    clearFlags();
  });
}

// Prose that merely NAMES the memory directory is not a write to it. The guard
// scans every string reachable from `params`, `content` included, so a rule that
// matched the bare directory anywhere in a string would refuse edits to this
// repo's own docs (and to the plugin's guidance text) with a reason naming files
// the agent never touched.
for (const content of [
  "If OpenClaw tries to write `USER.md`, `MEMORY.md`, or `/data/.openclaw/memory/main.sqlite`, the CI memory plugin should block that path.",
  "State lives under ~/.openclaw/memory/ on your machine.\n",
  "the ~/.openclaw/memory dir holds OpenClaw's own index",
  "Do not inspect OpenClaw's local memory SQLite files — the .openclaw/memory directory.",
]) {
  test(`before_tool_call does NOT block documentation content: ${content.slice(0, 40)}…`, () => {
    const api = register();
    assert.equal(
      api._handlers["before_tool_call"](
        { toolName: "write_file", params: { path: "README.md", content } },
        CI_ACTIVE,
      ),
      undefined,
      "documenting the memory path is not writing to it",
    );
    clearFlags();
  });
}

for (const path of [
  "USER_notes.md",
  "src/memory.txt",
  "/data/.openclaw/cache/x.sqlite",
  // Widening the prefix must not start matching a directory that merely ENDS in
  // ".openclaw", nor a sibling of the memory dir.
  "C:/Users/hanzl/my.openclaw/memory/main.sqlite",
  "C:/Users/hanzl/.openclaw/memory-backup/main.sqlite",
]) {
  test(`before_tool_call does NOT block unrelated ${path}`, () => {
    const api = register();
    assert.equal(
      api._handlers["before_tool_call"]({ toolName: "write_file", params: { path } }, CI_ACTIVE),
      undefined,
      `path ${path} should not be blocked`,
    );
    clearFlags();
  });
}

// ── transport-layer (requestJson) — empty body + error-detail extraction ──────

test("memory_search.execute treats an empty server body as {} (no JSON parse throw)", async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => "" });
  try {
    const api = register();
    const res = await api._toolFactories["memory_search"]().execute("id", { query: "q" });
    const payload = JSON.parse(res.content[0].text);
    assert.deepEqual(payload.results, []); // empty block → no chunks
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});

test("memory_search.execute surfaces the server's body.error in the thrown HTTP message", async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => JSON.stringify({ error: "boom-detail" }),
  });
  try {
    const api = register();
    await assert.rejects(
      api._toolFactories["memory_search"]().execute("id", { query: "q" }),
      (err) => String(err.message).includes("boom-detail") && String(err.message).includes("500"),
    );
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});
