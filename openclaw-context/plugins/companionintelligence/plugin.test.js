import test from "node:test";
import assert from "node:assert";

import plugin, { featureEnabled, normalizeBaseUrl } from "./index.js";

const FLAGS = [
  "CI_MEMORY_CONTEXT_ENABLED",
  "CI_MEMORY_RECALL_ENABLED",
  "CI_MEMORY_TURN_ENABLED",
  "CI_MEMORY_WRITE_ENABLED",
  "CI_INTENTS_ENABLED",
];

function clearFlags() {
  for (const f of FLAGS) delete process.env[f];
}

function makeApi() {
  const tools = [];
  const toolFactories = {};
  const commands = [];
  const handlers = {};
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
    log: { debug() {}, info() {}, warn() {} },
    _tools: tools,
    _toolFactories: toolFactories,
    _commands: commands,
    _handlers: handlers,
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
// clears first.
function register(env = {}) {
  clearFlags();
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

test("agent_end posts a turn by default", async () => {
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

test("before_compaction posts a turn by default", async () => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, text: async () => "{}" };
  };
  try {
    await runBeforeCompaction(register());
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("/api/memory/turn"), calls[0]);
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
    assert.ok(Array.isArray(payload.results) && payload.results.length >= 1);
    assert.ok(payload.results[0].snippet.includes("alpha"));
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

test("memory_store.execute falls back to /api/memory/note on 404", async () => {
  const urls = [];
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/api/memory/write")) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: true, status: 200, text: async () => "{}" };
  };
  try {
    const api = register();
    const res = await api._toolFactories["memory_store"]({}).execute("id", { content: "x" });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.ok, true);
    assert.ok(urls.some((u) => u.includes("/api/memory/write")));
    assert.ok(urls.some((u) => u.includes("/api/memory/note")));
  } finally {
    global.fetch = origFetch;
    clearFlags();
  }
});
