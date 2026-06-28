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
