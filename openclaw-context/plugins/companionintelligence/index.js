const PLUGIN_ID = "companionintelligence";
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RESULTS = 5;
const RECALL_PATH = "ci-server://recall";
const PROFILE_PATH = "ci-server://profile";
const CI_MEMORY_BOOTSTRAP_GUIDANCE = [
  "",
  "## Companion Intelligence Memory",
  "",
  "Companion Intelligence is the active OpenClaw memory backend.",
  "For user profile facts, preferences, durable notes, decisions, prior-project context, and explicit remember/save requests, use the `memory_store` tool.",
  "Do not create or edit `USER.md`, `MEMORY.md`, or `memory/*.md` for memory storage while this backend is active.",
  "Do not inspect, query, edit, or write OpenClaw's local memory SQLite files such as `/data/.openclaw/memory/main.sqlite`; they are internal cache/index storage, not the Companion Intelligence memory system.",
  "Use `memory_search` for topical recall and `memory_get` with `ci-server://profile` for the CI-Server profile block.",
].join("\n");

function jsonResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

function textResult(text, details) {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePathForMatch(value) {
  return normalizeString(value).replace(/\\/g, "/");
}

function isCiMemoryActive(config) {
  return config?.plugins?.slots?.memory === PLUGIN_ID;
}

function isBlockedLocalMemoryReference(value) {
  const text = normalizePathForMatch(value);
  if (!text) return false;
  const path = text.toLowerCase();
  const basename = path.split("/").pop();
  if (basename === "user.md" || basename === "memory.md") return true;
  if (/(^|\/)memory\/[^/]+\.md(?:\s|$|["'])/u.test(path)) return true;
  if (/(^|\s|["'])\/data\/\.openclaw\/memory(?:\/|\s|$|["'])/u.test(path)) return true;
  if (/(^|\s|["'])\/data\/\.openclaw\/memory\/[^"'\s]+\.sqlite3?(?:\s|$|["'])/u.test(path)) {
    return true;
  }
  if (/(^|\s|["'])\.openclaw\/memory\/[^"'\s]+\.sqlite3?(?:\s|$|["'])/u.test(path)) {
    return true;
  }
  return false;
}

function collectToolStrings(value, strings = []) {
  if (typeof value === "string") {
    strings.push(value);
    return strings;
  }
  if (!value || typeof value !== "object") return strings;
  if (Array.isArray(value)) {
    for (const item of value) collectToolStrings(item, strings);
    return strings;
  }

  for (const entry of Object.values(value)) collectToolStrings(entry, strings);
  return strings;
}

function getToolMemoryReferences(event) {
  const strings = collectToolStrings(event?.params);
  collectToolStrings(event?.derivedPaths, strings);
  return strings;
}

function applyBootstrapMemoryGuidance(event) {
  const context = event?.context;
  if (!context || !isCiMemoryActive(context.cfg)) return;
  if (!Array.isArray(context.bootstrapFiles)) return;

  const agentsFile = context.bootstrapFiles.find((file) => file?.name === "AGENTS.md");
  if (agentsFile) {
    const content = typeof agentsFile.content === "string" ? agentsFile.content : "";
    if (!content.includes("Companion Intelligence is the active OpenClaw memory backend.")) {
      agentsFile.content = `${content.trimEnd()}\n${CI_MEMORY_BOOTSTRAP_GUIDANCE}\n`;
      agentsFile.missing = false;
    }
    return;
  }

  context.bootstrapFiles.push({
    name: "AGENTS.md",
    path: "AGENTS.md",
    missing: false,
    content: CI_MEMORY_BOOTSTRAP_GUIDANCE.trimStart(),
  });
}

function shouldBlockWorkspaceMemoryWrite(event, ctx) {
  const config = ctx?.config || ctx?.cfg || event?.config;
  if (config && !isCiMemoryActive(config)) return false;
  const toolName = normalizeString(event?.toolName).toLowerCase();
  if (toolName === "memory_store" || toolName === "memory_search" || toolName === "memory_get") {
    return false;
  }

  return getToolMemoryReferences(event).some(isBlockedLocalMemoryReference);
}

function readLivePluginConfig(api, cfg) {
  const source =
    cfg ||
    (() => {
      try {
        return api.runtime?.config?.current?.() || api.config;
      } catch {
        return api.config;
      }
    })();
  const entryConfig = source?.plugins?.entries?.[PLUGIN_ID]?.config;
  return entryConfig && typeof entryConfig === "object" && !Array.isArray(entryConfig)
    ? entryConfig
    : api.pluginConfig || {};
}

function resolveConfig(api, cfg) {
  const pluginConfig = readLivePluginConfig(api, cfg);
  const url = normalizeString(pluginConfig.url || process.env.CI_SERVER_URL);
  const token = normalizeString(pluginConfig.token || process.env.CI_SERVER_TOKEN);
  const timeoutMs =
    Number.isFinite(pluginConfig.timeoutMs) && pluginConfig.timeoutMs > 0
      ? Math.floor(pluginConfig.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  const maxResults =
    Number.isFinite(pluginConfig.maxResults) && pluginConfig.maxResults > 0
      ? Math.floor(pluginConfig.maxResults)
      : DEFAULT_MAX_RESULTS;

  return {
    url: url.replace(/\/+$/, ""),
    token,
    timeoutMs,
    maxResults,
  };
}

async function requestJson(config, path, options = {}) {
  if (!config.url || !config.token) {
    throw new Error("CI-Server URL or token is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref?.();

  try {
    const res = await fetch(`${config.url}${path}`, {
      method: options.method || "GET",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "x-api-key": config.token,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });

    const text = await res.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { text };
      }
    }

    if (!res.ok) {
      const detail =
        typeof body.error === "string"
          ? body.error
          : typeof body.message === "string"
            ? body.message
            : text.slice(0, 200);
      throw new Error(`CI-Server HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

function splitLines(text) {
  return normalizeString(text).split(/\r?\n/).filter((line) => line.trim());
}

function linesToReadResult(path, text, from = 1, lines = 120) {
  const allLines = normalizeString(text).split(/\r?\n/);
  const start = Math.max(1, Math.floor(from || 1));
  const count = Math.max(1, Math.floor(lines || 120));
  const selected = allLines.slice(start - 1, start - 1 + count);
  const more = start - 1 + count < allLines.length;
  return {
    text: selected.join("\n"),
    path,
    from: start,
    lines: selected.length,
    truncated: more,
    ...(more ? { nextFrom: start + selected.length } : {}),
  };
}

function buildSearchResults(block, query, maxResults) {
  const lines = splitLines(block);
  if (lines.length === 0) return [];

  const joined = lines.join("\n");
  const chunkSize = Math.max(1, Math.ceil(lines.length / Math.max(1, maxResults)));
  const results = [];
  for (let i = 0; i < lines.length && results.length < maxResults; i += chunkSize) {
    const chunk = lines.slice(i, i + chunkSize).join("\n");
    results.push({
      path: `${RECALL_PATH}#${results.length + 1}`,
      startLine: i + 1,
      endLine: Math.min(lines.length, i + chunkSize),
      score: results.length === 0 ? 1 : Math.max(0.1, 1 - results.length * 0.1),
      snippet: chunk || joined.slice(0, 1000),
      source: "memory",
      citation: `CI-Server recall for "${query.slice(0, 80)}"`,
    });
  }
  return results;
}

function createClient(api, cfg) {
  const config = resolveConfig(api, cfg);
  return {
    config,
    async health() {
      await requestJson(config, "/api/health");
      return true;
    },
    async context() {
      const body = await requestJson(config, "/api/memory/context");
      return normalizeString(body.block || body.text || body.context);
    },
    async recall(query, maxResults) {
      const body = await requestJson(config, "/api/memory/recall", {
        method: "POST",
        body: { query, maxResults },
      });
      return normalizeString(body.block || body.text || body.context);
    },
    async note(content, options = {}) {
      const payload = {
        content,
        ...(options.source ? { source: options.source } : {}),
        ...(options.title ? { title: options.title } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      };
      try {
        return await requestJson(config, "/api/memory/write", {
          method: "POST",
          body: payload,
        });
      } catch (error) {
        if (!String(error?.message || error).includes("HTTP 404")) throw error;
        return await requestJson(config, "/api/memory/note", {
          method: "POST",
          body: payload,
        });
      }
    },
  };
}

function buildPromptSection({ availableTools }) {
  const lines = [];
  if (availableTools.has("memory_search")) {
    lines.push(
      "## Companion Intelligence Memory",
      "Use memory_search before answering questions about prior conversations, durable user preferences, relationships, people, dates, decisions, projects, or saved context.",
    );
  }
  if (availableTools.has("memory_store")) {
    lines.push(
      "Use memory_store for explicit remember/save requests or durable facts the user clearly wants retained.",
      "Do not write memory facts to USER.md, MEMORY.md, or memory/*.md; store them with memory_store so CI-Server can ingest them.",
      "Do not inspect or write /data/.openclaw/memory/*.sqlite; those files are OpenClaw internals, not the CI memory database.",
    );
  }
  if (lines.length > 0) lines.push("");
  return lines;
}

function createMemoryManager(api, cfg, agentId) {
  const client = createClient(api, cfg);
  let lastRecall = "";

  return {
    async search(query, opts = {}) {
      const maxResults = Math.max(
        1,
        Math.min(20, opts.maxResults || client.config.maxResults),
      );
      lastRecall = await client.recall(query, maxResults);
      return buildSearchResults(lastRecall, query, maxResults);
    },
    async readFile(params) {
      const path = normalizeString(params.relPath);
      if (path.startsWith(RECALL_PATH)) {
        return linesToReadResult(path, lastRecall, params.from, params.lines);
      }
      if (path === PROFILE_PATH || path === "profile" || path === "context") {
        const profile = await client.context();
        return linesToReadResult(PROFILE_PATH, profile, params.from, params.lines);
      }
      return linesToReadResult(
        path || RECALL_PATH,
        "CI-Server memory does not expose file-backed reads for this path. Use memory_search for recall or memory_get with ci-server://profile for the profile block.",
        1,
        120,
      );
    },
    status() {
      return {
        backend: "builtin",
        provider: PLUGIN_ID,
        model: "ci-server",
        dirty: false,
        custom: {
          agentId,
          urlConfigured: Boolean(client.config.url),
          tokenConfigured: Boolean(client.config.token),
        },
      };
    },
    async sync() {
      await client.health();
    },
    getCachedEmbeddingAvailability() {
      return {
        ok: true,
        checked: true,
        cached: true,
        checkedAtMs: Date.now(),
      };
    },
    async probeEmbeddingAvailability() {
      return {
        ok: await client.health(),
        checked: true,
        checkedAtMs: Date.now(),
      };
    },
    async probeVectorAvailability() {
      return await client.health();
    },
  };
}

function createMemorySearchTool(api) {
  return {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search Companion Intelligence memory in CI-Server for prior context, preferences, people, projects, decisions, and durable facts.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const query = normalizeString(params?.query);
      if (!query) return jsonResult({ results: [], error: "query required" });
      const client = createClient(api);
      const maxResults = Math.max(
        1,
        Math.min(20, params?.maxResults || client.config.maxResults),
      );
      const block = await client.recall(query, maxResults);
      const results = buildSearchResults(block, query, maxResults);
      return jsonResult({ results });
    },
  };
}

function createMemoryGetTool(api) {
  return {
    name: "memory_get",
    label: "Memory Get",
    description:
      "Read the CI-Server profile block with path ci-server://profile. For topical recall, use memory_search.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        from: { type: "integer", minimum: 1 },
        lines: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const client = createClient(api);
      const path = normalizeString(params?.path);
      if (path === PROFILE_PATH || path === "profile" || path === "context") {
        const profile = await client.context();
        return jsonResult(linesToReadResult(PROFILE_PATH, profile, params.from, params.lines));
      }
      return jsonResult({
        path,
        found: false,
        error:
          "CI-Server memory is recall-backed, not file-backed. Use memory_search, or memory_get path ci-server://profile.",
      });
    },
  };
}

function createMemoryStoreTool(api) {
  return {
    name: "memory_store",
    label: "Memory Store",
    description:
      "Store a durable memory note in CI-Server when the user explicitly asks to remember or save context.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string" },
        title: { type: "string" },
        source: { type: "string" },
      },
      required: ["content"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const content = normalizeString(params?.content);
      if (!content) return jsonResult({ ok: false, error: "content required" });
      const client = createClient(api);
      const body = await client.note(content, {
        title: normalizeString(params?.title),
        source: normalizeString(params?.source) || "openclaw",
        sessionId: normalizeString(ctx?.sessionId || ctx?.sessionKey),
      });
      return jsonResult({ ok: true, response: body });
    },
  };
}

export default {
  id: PLUGIN_ID,
  name: "Companion Intelligence Memory",
  description: "Uses CI-Server as the active OpenClaw memory backend.",
  kind: "memory",
  register(api) {
    api.registerMemoryCapability({
      promptBuilder: buildPromptSection,
      runtime: {
        async getMemorySearchManager(params) {
          const config = resolveConfig(api, params.cfg);
          if (!config.url || !config.token) {
            return {
              manager: null,
              error: "CI-Server URL or token is not configured",
            };
          }
          return {
            manager: createMemoryManager(api, params.cfg, params.agentId),
          };
        },
        resolveMemoryBackendConfig() {
          return { backend: "builtin" };
        },
      },
    });

    api.registerTool(() => createMemorySearchTool(api), {
      name: "memory_search",
    });
    api.registerTool(() => createMemoryGetTool(api), {
      name: "memory_get",
    });
    api.registerTool((ctx) => {
      const tool = createMemoryStoreTool(api);
      return {
        ...tool,
        execute: (toolCallId, params, signal, onUpdate) =>
          tool.execute(toolCallId, params, signal, onUpdate, ctx),
      };
    }, {
      name: "memory_store",
    });

    api.registerHook?.("agent:bootstrap", applyBootstrapMemoryGuidance, {
      name: "companionintelligence-memory-bootstrap",
      description:
        "Directs OpenClaw memory writes to CI-Server when Companion Intelligence is active.",
      priority: 100,
    });

    api.on?.("before_tool_call", (event, ctx) => {
      if (!shouldBlockWorkspaceMemoryWrite(event, ctx)) return;
      return {
        block: true,
        blockReason:
          "Companion Intelligence is the active memory backend. Use memory_store instead of editing USER.md, MEMORY.md, memory/*.md, or OpenClaw's local memory SQLite files.",
      };
    }, {
      priority: 100,
    });

    api.registerCommand({
      name: "ci-memory",
      description: "Check Companion Intelligence memory connectivity.",
      acceptsArgs: false,
      handler: async () => {
        const client = createClient(api);
        try {
          await client.health();
          return textResult("Companion Intelligence memory is connected.", {
            ok: true,
            url: client.config.url,
          });
        } catch (error) {
          return textResult(
            `Companion Intelligence memory is not available: ${String(
              error?.message || error,
            )}`,
            { ok: false, url: client.config.url },
          );
        }
      },
    });
  },
};
