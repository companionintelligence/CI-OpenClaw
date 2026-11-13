// Companion Memory's intents as native OpenClaw MCP tools (mcp.servers.ci-memory),
// and the plugin env that turns its generic ci_run_intent off to match.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

import {
  applyMemoryMcpEnv,
  canonicalMemoryMcpUrl,
  hasMemoryMcp,
  CI_MEMORY_MCP_TOOLS,
  makeDataDir,
  makeReconciler,
  readCfg,
  rmDir,
  withOllama,
  CATALOG,
} from "./helpers/reconcile-fixture.mjs";

const MEM = { CI_SERVER_URL: "http://gateway:8642", CI_SERVER_TOKEN: "secret-token" };

describe("canonicalMemoryMcpUrl", () => {
  test("appends /api/mcp to the CI-Server base", () => {
    assert.strictEqual(canonicalMemoryMcpUrl(MEM), "http://gateway:8642/api/mcp");
    assert.strictEqual(canonicalMemoryMcpUrl({ CI_SERVER_URL: "http://gateway:8642/" }), "http://gateway:8642/api/mcp");
  });

  test("does not double a base that already ends in /api/mcp", () => {
    assert.strictEqual(canonicalMemoryMcpUrl({ CI_SERVER_URL: "http://gateway:8642/api/mcp/" }), "http://gateway:8642/api/mcp");
  });

  test("is empty with no base", () => {
    assert.strictEqual(canonicalMemoryMcpUrl({}), "");
    assert.strictEqual(canonicalMemoryMcpUrl({ CI_SERVER_URL: "  " }), "");
  });
});

describe("hasMemoryMcp", () => {
  test("follows the CI-Server credentials, and CI_MEMORY_MCP_ENABLED=false turns it off", () => {
    assert.strictEqual(hasMemoryMcp(MEM), true);
    assert.strictEqual(hasMemoryMcp({ CI_SERVER_URL: MEM.CI_SERVER_URL }), false);
    assert.strictEqual(hasMemoryMcp({ ...MEM, CI_SERVER_ENABLED: "false" }), false);
    assert.strictEqual(hasMemoryMcp({ ...MEM, CI_MEMORY_MCP_ENABLED: "false" }), false);
  });
});

describe("applyMemoryMcpEnv", () => {
  test("names the server and turns the plugin's intent tools off", () => {
    const env = applyMemoryMcpEnv(MEM);
    assert.strictEqual(env.CI_MEMORY_MCP_SERVER, "ci-memory");
    assert.strictEqual(env.CI_INTENTS_ENABLED, "false");
  });

  test("keeps an operator's own CI_INTENTS_ENABLED", () => {
    assert.strictEqual(applyMemoryMcpEnv({ ...MEM, CI_INTENTS_ENABLED: "true" }).CI_INTENTS_ENABLED, "true");
  });

  // With no MCP server the plugin's ci_run_intent is the only way to run an intent.
  test("leaves the env alone when Memory is not reachable over MCP", () => {
    const off = { ...MEM, CI_MEMORY_MCP_ENABLED: "false" };
    assert.strictEqual(applyMemoryMcpEnv(off), off);
    assert.strictEqual(applyMemoryMcpEnv({}).CI_INTENTS_ENABLED, undefined);
  });

  test("does not mutate its input", () => {
    const env = { ...MEM };
    applyMemoryMcpEnv(env);
    assert.deepStrictEqual(env, MEM);
  });
});

describe("ensureMemoryMcpServer", () => {
  let dataDir;
  let ctx;
  beforeEach(() => {
    dataDir = makeDataDir();
    ctx = makeReconciler(dataDir);
  });
  afterEach(() => rmDir(dataDir));

  test("registers ci-memory over streamable-http with the intent tool filter", () => {
    const config = {};
    assert.strictEqual(ctx.cfg.ensureMemoryMcpServer(config, MEM), true);
    assert.deepStrictEqual(config.mcp.servers["ci-memory"], {
      url: "http://gateway:8642/api/mcp",
      transport: "streamable-http",
      headers: { Authorization: "Bearer ${CI_SERVER_TOKEN}" },
      connectionTimeoutMs: 60000,
      requestTimeoutMs: 180000,
      toolFilter: { include: CI_MEMORY_MCP_TOOLS },
    });
  });

  test("never persists the raw token, only the env template", () => {
    const config = {};
    ctx.cfg.ensureMemoryMcpServer(config, MEM);
    assert.ok(!JSON.stringify(config).includes("secret-token"));
  });

  // memory_recall / memory_remember overlap the plugin's memory_search / memory_store, and
  // the plugin keeps those. Everything else is exposed: a missing tool made the model hunt
  // for workarounds (and, without planning_scheduleTask, claim a task was on the calendar).
  test("exposes every intent except the two the plugin already has", () => {
    for (const name of [
      "knowledge_search",
      "media_findPhotos",
      "memory_forget",
      "planning_scheduleTask",
      "planning_plannedBlocks",
      "forecast_read",
      "import_scan_inbox",
      "import_import_path",
    ]) {
      assert.ok(CI_MEMORY_MCP_TOOLS.includes(name), name);
    }
    for (const name of ["memory_recall", "memory_remember"]) assert.ok(!CI_MEMORY_MCP_TOOLS.includes(name), name);
    assert.strictEqual(CI_MEMORY_MCP_TOOLS.length, 30);
    assert.strictEqual(new Set(CI_MEMORY_MCP_TOOLS).size, CI_MEMORY_MCP_TOOLS.length, "no duplicates");
  });

  test("is idempotent", () => {
    const config = {};
    assert.strictEqual(ctx.cfg.ensureMemoryMcpServer(config, MEM), true);
    assert.strictEqual(ctx.cfg.ensureMemoryMcpServer(config, MEM), false);
  });

  test("removes the entry when Memory is disconnected or the switch is off", () => {
    for (const env of [{}, { ...MEM, CI_MEMORY_MCP_ENABLED: "false" }, { ...MEM, CI_SERVER_ENABLED: "false" }]) {
      const config = {};
      ctx.cfg.ensureMemoryMcpServer(config, MEM);
      assert.strictEqual(ctx.cfg.ensureMemoryMcpServer(config, env), true, JSON.stringify(env));
      assert.strictEqual(config.mcp.servers["ci-memory"], undefined);
    }
    assert.strictEqual(ctx.cfg.ensureMemoryMcpServer({}, {}), false);
  });

  test("leaves the Hub's MCP server and others alone", () => {
    const config = { mcp: { servers: { "ci-hub": { url: "https://hub" }, other: { url: "https://other" } } } };
    ctx.cfg.ensureMemoryMcpServer(config, MEM);
    ctx.cfg.ensureMemoryMcpServer(config, {});
    assert.deepStrictEqual(config.mcp.servers, { "ci-hub": { url: "https://hub" }, other: { url: "https://other" } });
  });
});

// Both halves must switch together: the MCP entry (reconcile) and the plugin's intent
// tools (gateway env). Otherwise the agent gets every intent twice, or none.
describe("buildChildEnv with Memory over MCP", () => {
  let dataDir;
  afterEach(() => rmDir(dataDir));

  test("Hub-injected CI-Server creds turn the plugin's intent tools off", () => {
    dataDir = makeDataDir({ env: {} });
    const { cfg } = makeReconciler(dataDir, { containerEnv: MEM });
    const env = cfg.buildChildEnv();
    assert.strictEqual(env.CI_MEMORY_MCP_SERVER, "ci-memory");
    assert.strictEqual(env.CI_INTENTS_ENABLED, "false");
  });

  test("a compose-level CI_MEMORY_MCP_ENABLED=false keeps ci_run_intent", () => {
    dataDir = makeDataDir({ env: {} });
    const { cfg } = makeReconciler(dataDir, { containerEnv: { ...MEM, CI_MEMORY_MCP_ENABLED: "false" } });
    const env = cfg.buildChildEnv();
    assert.strictEqual(env.CI_MEMORY_MCP_SERVER, undefined);
    assert.strictEqual(env.CI_INTENTS_ENABLED, undefined);
  });
});

describe("reconcileConfig", () => {
  let dataDir;
  afterEach(() => rmDir(dataDir));

  test("writes the ci-memory MCP server when Memory is connected, without the raw token", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({ config: {}, env: { OLLAMA_HOST: baseUrl, ...MEM } });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();
      const config = readCfg(dataDir);
      assert.strictEqual(config.mcp.servers["ci-memory"].url, "http://gateway:8642/api/mcp");
      assert.deepStrictEqual(config.mcp.servers["ci-memory"].toolFilter, { include: CI_MEMORY_MCP_TOOLS });
      assert.ok(!JSON.stringify(config).includes("secret-token"));
    });
  });

  test("writes no ci-memory server without Memory credentials", async () => {
    await withOllama(CATALOG, async (baseUrl) => {
      dataDir = makeDataDir({ config: {}, env: { OLLAMA_HOST: baseUrl } });
      const { cfg } = makeReconciler(dataDir);
      await cfg.reconcileConfig();
      assert.strictEqual(readCfg(dataDir).mcp?.servers?.["ci-memory"], undefined);
    });
  });
});
