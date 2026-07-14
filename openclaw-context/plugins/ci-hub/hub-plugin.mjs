// src/mcp-client.ts
var MCP_CLIENT_PROTOCOL_VERSION = "2025-11-25";
var REQUEST_TIMEOUT_MS = 15e3;
var McpTransportError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "McpTransportError";
  }
};
async function fetchWithTimeout(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
var McpClient = class {
  hubUrl;
  apiKey;
  connected = false;
  sessionId = null;
  requestId = 0;
  backoffMs = 1e3;
  maxBackoffMs = 6e4;
  // Pending reconnect timer + a disposed flag so disconnect() can cancel the backoff loop instead of
  // reconnecting after an intentional teardown (a fired timer would otherwise revive the connection).
  reconnectTimer = null;
  disposed = false;
  log;
  constructor(hubUrl, apiKey, log) {
    this.hubUrl = hubUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.log = log;
  }
  get endpoint() {
    return `${this.hubUrl}/api/mcp`;
  }
  async connect() {
    this.disposed = false;
    try {
      this.log.info("Connecting to Hub MCP endpoint...");
      const { response, body } = await this.post("initialize", {
        protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "openclaw-plugin", version: "1.0" }
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (body.error || !body.result || !sessionId) {
        throw new Error(body.error ? body.error.message : "initialize did not establish a session");
      }
      if (this.disposed) {
        await fetchWithTimeout(this.endpoint, { method: "DELETE", headers: this.buildHeaders(sessionId) }).catch(() => void 0);
        this.log.info("MCP connect aborted (client disconnected during initialize)");
        return;
      }
      const staleSessionId = this.sessionId;
      if (staleSessionId && staleSessionId !== sessionId) {
        fetchWithTimeout(this.endpoint, { method: "DELETE", headers: this.buildHeaders(staleSessionId) }).catch(() => void 0);
      }
      this.sessionId = sessionId;
      this.connected = true;
      this.backoffMs = 1e3;
      this.log.info("MCP client connected to Hub");
    } catch (error) {
      this.connected = false;
      this.sessionId = null;
      this.log.warn(`MCP connection failed: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleReconnect();
    }
  }
  async disconnect() {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sessionId) {
      try {
        await fetchWithTimeout(this.endpoint, { method: "DELETE", headers: this.buildHeaders(this.sessionId) });
      } catch {
      }
    }
    this.sessionId = null;
    this.connected = false;
    this.log.info("MCP client disconnected");
  }
  isConnected() {
    return this.connected;
  }
  async listTools() {
    if (!this.connected) {
      throw new Error("Hub MCP server is not connected");
    }
    try {
      const body = await this.sendMessage("tools/list", {});
      if (body.error) {
        throw new Error(body.error.message);
      }
      return body.result.tools;
    } catch (error) {
      if (error instanceof McpTransportError || !this.connected) {
        this.connected = false;
        this.scheduleReconnect();
      }
      throw error;
    }
  }
  async callTool(name, args) {
    if (!this.connected) {
      return { error: "Hub MCP server is not connected" };
    }
    try {
      const body = await this.sendMessage("tools/call", { name, arguments: args });
      if (body.error) {
        return { error: body.error.message };
      }
      return body.result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof McpTransportError || !this.connected) {
        this.connected = false;
        this.scheduleReconnect();
      } else {
        this.log.warn(`MCP tool call '${name}' failed: ${message}`);
      }
      return { error: message };
    }
  }
  /** Send a JSON-RPC message over the established session; a 404 means the session expired. */
  async sendMessage(method, params) {
    const { response, body } = await this.post(method, params, this.sessionId ?? void 0);
    if (response.status === 404) {
      this.connected = false;
      this.sessionId = null;
      throw new Error("MCP session not found");
    }
    return body;
  }
  /**
   * POST a JSON-RPC request to the single MCP endpoint and parse the JSON or SSE response body.
   * ONE AbortController spans both the request and the body read, so a Hub that hangs after sending
   * headers still trips the timeout (a headers-only guard would leave `response.text()` unbounded).
   * Network faults and timeouts throw {@link McpTransportError}; an HTTP error status from a live
   * server stays a plain Error (the session may still be valid).
   */
  async post(method, params, sessionId) {
    const id = ++this.requestId;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await fetch(this.endpoint, {
          method: "POST",
          headers: this.buildHeaders(sessionId),
          body: payload,
          signal: controller.signal
        });
      } catch (error) {
        throw new McpTransportError(
          controller.signal.aborted ? `MCP request timed out after ${REQUEST_TIMEOUT_MS}ms` : `MCP request failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      const discardBody = () => void response.body?.cancel().catch(() => void 0);
      if (response.status === 502 || response.status === 504) {
        discardBody();
        throw new McpTransportError(`MCP request failed: ${response.status} ${response.statusText}`);
      }
      if (response.status === 404) {
        discardBody();
        return { response, body: { jsonrpc: "2.0", id, error: { code: -32001, message: "Session not found (HTTP 404)" } } };
      }
      if (!response.ok) {
        discardBody();
        throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
      }
      let text;
      try {
        text = await response.text();
      } catch (error) {
        throw new McpTransportError(
          controller.signal.aborted ? `MCP response timed out after ${REQUEST_TIMEOUT_MS}ms` : `MCP response body failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return { response, body: this.parseRpcBody(text, response.headers.get("content-type") ?? "") };
    } finally {
      clearTimeout(timer);
    }
  }
  buildHeaders(sessionId) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.apiKey}`
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    return headers;
  }
  /** Extract the JSON-RPC payload from a plain JSON body or the last `data:` line of an SSE frame.
   *  Pure parse — the body TEXT is read (and timeout-guarded) by post(), so parse failures here are
   *  unambiguously server-side, never transport faults. Convention: gate on `application/json` (else
   *  parse as SSE) — kept identical to the Layer-2 QA bridge (scripts/qa-mcp-bridge.ts) so both
   *  hand-rolled clients resolve an ambiguous content-type the same way. The two are intentionally
   *  NOT a shared module: the QA script is dependency-free so it ships to fleet nodes unchanged. */
  parseRpcBody(text, contentType) {
    if (contentType.includes("application/json")) {
      return JSON.parse(text);
    }
    const dataLines = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trim()).filter(Boolean);
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(dataLines[i]);
      } catch {
      }
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("no JSON-RPC payload in MCP response");
    }
  }
  scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.log.info(`Reconnecting to Hub MCP in ${delay}ms...`);
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) {
        return;
      }
      void this.connect();
    }, delay);
    timer.unref?.();
    this.reconnectTimer = timer;
  }
};

// src/wake-endpoint.ts
var URGENCY_ORDER = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3
};
function createWakeEndpointHandler(api, wakeSecret, wakeFilter) {
  return async (req) => {
    if (wakeSecret) {
      const authHeader = req.headers.authorization ?? req.headers.Authorization;
      if (!authHeader || !constantTimeEqual(authHeader, `Bearer ${wakeSecret}`)) {
        return { status: 403, body: { error: "Forbidden" } };
      }
    }
    const payload = req.body;
    if (!payload?.event || !payload?.urgency) {
      return { status: 400, body: { error: "Invalid payload" } };
    }
    if (!passesFilter(payload, wakeFilter)) {
      api.log.debug(`Wake event ${payload.event} filtered out`);
      return { status: 200, body: { received: true, filtered: true } };
    }
    const message = translateWakeMessage(payload);
    api.wake(message);
    api.log.info(`Wake triggered: ${payload.event} (${payload.urgency})`);
    return { status: 200, body: { received: true } };
  };
}
function passesFilter(payload, filter) {
  if (!filter) return true;
  if (filter.minUrgency) {
    const payloadLevel = URGENCY_ORDER[payload.urgency] ?? 0;
    const minLevel = URGENCY_ORDER[filter.minUrgency] ?? 0;
    if (payloadLevel < minLevel) return false;
  }
  if (filter.events && filter.events.length > 0) {
    if (!filter.events.includes(payload.event)) return false;
  }
  return true;
}
function translateWakeMessage(payload) {
  const { event, data, urgency } = payload;
  const parts = [`CI-Hub alert (${urgency}):`];
  switch (event) {
    case "app.crashed": {
      const appName = extractAppName(data.appUrn);
      parts.push(`App ${appName} crashed.`);
      if (data.previousStatus) parts.push(`Previous status: ${data.previousStatus}.`);
      break;
    }
    case "system.update_available":
      parts.push(`System update available: ${data.current} \u2192 ${data.latest}.`);
      break;
    case "system.mcp_ready":
      parts.push("Hub MCP server is ready.");
      break;
    case "registration.state_changed":
      parts.push(`Registration phase changed: ${data.from} \u2192 ${data.to}.`);
      break;
    default: {
      if (event.endsWith("_error") || event.endsWith("_success")) {
        const appName = data.appUrn ? extractAppName(data.appUrn) : "unknown";
        const action = event.replace(/_error$|_success$/, "").replace(/_/g, " ");
        const status = event.endsWith("_error") ? "failed" : "succeeded";
        parts.push(`App ${appName}: ${action} ${status}.`);
      } else {
        parts.push(`Event: ${event}.`);
        if (Object.keys(data).length > 0) parts.push(`Data: ${JSON.stringify(data)}`);
      }
    }
  }
  return parts.join(" ");
}
function extractAppName(appUrn) {
  if (!appUrn) return "unknown";
  const parts = appUrn.split(":");
  return parts[1] ?? appUrn;
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// src/sse-listener.ts
var SseListenerService = class {
  hubUrl;
  apiKey;
  api;
  wakeFilter;
  abortController = null;
  running = false;
  backoffMs = 1e3;
  maxBackoffMs = 6e4;
  constructor(hubUrl, apiKey, api, wakeFilter) {
    this.hubUrl = hubUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.api = api;
    this.wakeFilter = wakeFilter;
  }
  async start() {
    this.running = true;
    this.api.log.info("SSE listener starting...");
    await this.connectSse();
  }
  stop() {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    this.api.log.info("SSE listener stopped");
  }
  isRunning() {
    return this.running;
  }
  async connectSse() {
    if (!this.running) return;
    try {
      this.abortController = new AbortController();
      const response = await fetch(`${this.hubUrl}/sse/app`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: this.abortController.signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }
      this.backoffMs = 1e3;
      this.api.log.info("SSE listener connected");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              this.handleSseEvent(data);
            } catch {
            }
          }
        }
      }
    } catch (error) {
      if (this.running) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes("abort")) {
          this.api.log.warn(`SSE connection lost: ${msg}`);
          this.scheduleReconnect();
        }
      }
    }
  }
  handleSseEvent(data) {
    const sseEvent = data.event;
    if (!sseEvent) return;
    let wakePayload = null;
    if (sseEvent === "status_change") {
      const appStatus = data.appStatus;
      if (appStatus === "stopped" || appStatus === "missing") {
        wakePayload = {
          event: "app.crashed",
          data: { appUrn: data.appUrn, newStatus: appStatus },
          urgency: "high",
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        };
      }
    }
    const errorEvents = ["install_error", "update_error", "start_error", "stop_error", "restart_error", "backup_error", "restore_error"];
    if (errorEvents.includes(sseEvent)) {
      wakePayload = {
        event: sseEvent,
        data: { appUrn: data.appUrn, error: data.error },
        urgency: "high",
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    const successEvents = [
      "install_success",
      "update_success",
      "start_success",
      "stop_success",
      "restart_success",
      "backup_success",
      "restore_success"
    ];
    if (successEvents.includes(sseEvent)) {
      wakePayload = {
        event: sseEvent,
        data: { appUrn: data.appUrn },
        urgency: "info",
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    if (wakePayload && passesFilter(wakePayload, this.wakeFilter)) {
      const message = translateWakeMessage(wakePayload);
      this.api.wake(message);
      this.api.log.info(`SSE wake: ${wakePayload.event} (${wakePayload.urgency})`);
    }
  }
  scheduleReconnect() {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.api.log.info(`SSE reconnecting in ${delay}ms...`);
    setTimeout(() => this.connectSse(), delay);
  }
};

// src/index.ts
function unwrapToolResult(result) {
  const wrapped = result;
  if (!wrapped || wrapped.isError) {
    return null;
  }
  const text = wrapped.content?.[0]?.text;
  if (typeof text !== "string") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function register(rawApi, config) {
  const api = withSafeLogger(rawApi);
  const hubUrl = config.hubUrl || process.env.HUB_URL;
  const hubApiKey = config.hubApiKey || process.env.HUB_API_KEY;
  const mcpApiKey = config.mcpApiKey || process.env.HUB_MCP_API_KEY || hubApiKey;
  const wakeSecret = config.wakeSecret || process.env.HUB_WAKE_SECRET;
  if (!hubUrl || !mcpApiKey) {
    api.log.error("CI-Hub plugin requires hubUrl and mcpApiKey (via config or HUB_URL/HUB_MCP_API_KEY env vars)");
    return;
  }
  api.log.info(`CI-Hub plugin initializing (hub: ${hubUrl})`);
  if (wakeSecret) {
    api.registerHttpRoute({
      method: "POST",
      path: "/hooks/hub-wake",
      handler: createWakeEndpointHandler(api, wakeSecret, config.wakeFilter)
    });
    api.log.info("Registered wake endpoint: POST /hooks/hub-wake");
  } else {
    api.log.warn("HUB_WAKE_SECRET not set \u2014 wake endpoint disabled (would be unauthenticated otherwise)");
  }
  if (process.env.HUB_MCP_LEGACY_CLIENT === "true") {
    api.log.error(
      "HUB_MCP_LEGACY_CLIENT=true is no longer supported: OpenClaw requires plugin register() to be synchronous, so tools cannot be registered after awaiting tools/list. Hub tools are served by the native mcp.servers.ci-hub entry in openclaw.json."
    );
  } else {
    api.log.info("Hub MCP tools served via native OpenClaw mcp.servers.ci-hub config");
  }
  void probeHubHealth(api, hubUrl);
  if (config.sseEnabled) {
    const sseListener = new SseListenerService(hubUrl, mcpApiKey, api, config.wakeFilter);
    void sseListener.start().catch((error) => {
      api.log.warn(`SSE listener failed to start: ${describeError(error)}`);
    });
  }
  if (process.env.CI_HUB_PLUGIN_INFERENCE === "1") {
    const mcpClient = new McpClient(hubUrl, mcpApiKey, api.log);
    const mcpReady = mcpClient.connect().catch((error) => {
      api.log.warn(`Hub MCP client failed to connect: ${describeError(error)}`);
    });
    registerInference({ api, hubUrl, apiKey: mcpApiKey, mcpClient, mcpReady });
  } else {
    api.log.info("Inference auto-config disabled (set CI_HUB_PLUGIN_INFERENCE=1 to enable); the ci-hub provider comes from openclaw.json");
  }
}
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
function withSafeLogger(api) {
  const host = api.log;
  const fallbacks = {
    info: (message) => console.info(`[ci-hub] ${message}`),
    warn: (message) => console.warn(`[ci-hub] ${message}`),
    error: (message) => console.error(`[ci-hub] ${message}`),
    debug: (message) => console.info(`[ci-hub] ${message}`)
  };
  const emit = (level) => (message) => {
    const hostFn = host?.[level];
    if (typeof hostFn === "function") {
      hostFn.call(host, message);
      return;
    }
    fallbacks[level](message);
  };
  const log = {
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    debug: emit("debug")
  };
  return new Proxy(api, {
    get: (target, prop) => {
      if (prop === "log") return log;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
async function probeHubHealth(api, hubUrl) {
  try {
    const healthResponse = await fetchWithTimeout(`${hubUrl.replace(/\/$/, "")}/api/health`, {});
    if (!healthResponse.ok) {
      api.log.warn(`Hub health check failed: ${healthResponse.status}`);
    }
  } catch (error) {
    api.log.warn(`Hub unreachable at ${hubUrl}: ${describeError(error)}`);
  }
}
function registerInference(deps) {
  const { api, hubUrl, apiKey, mcpClient, mcpReady } = deps;
  const ollamaNativeUrl = (process.env.OLLAMA_HOST ?? "http://ci-hub-ollama:11434").replace(/\/$/, "");
  let statusPromise = null;
  const getInferenceStatus = () => {
    statusPromise ??= fetchInferenceStatus(api, hubUrl, mcpClient, mcpReady).then((status) => {
      if (!status) statusPromise = null;
      return status;
    });
    return statusPromise;
  };
  const tts = { ready: false, modelId: "kokoro-v1" };
  if (api.registerProvider) {
    api.registerProvider({
      id: "ci-hub",
      label: "CI Hub (Local)",
      resolveSyntheticAuth: () => ({
        available: true,
        apiKey
      }),
      catalog: {
        order: "simple",
        run: async () => ({
          provider: {
            baseUrl: ollamaNativeUrl,
            apiKey: "ollama",
            api: "ollama",
            models: await discoverLocalModels(api, ollamaNativeUrl, getInferenceStatus)
          }
        })
      }
    });
  }
  if (api.registerSpeechProvider) {
    const inferenceBaseUrl = `${ollamaNativeUrl}/v1`;
    api.registerSpeechProvider({
      id: "ci-hub",
      label: "CI Hub TTS (Local)",
      // Reports false until the probe below confirms Lemonade has a loaded TTS model,
      // so OpenClaw will not select this provider before it can actually serve.
      isConfigured: () => tts.ready,
      synthesize: async (req) => {
        const response = await fetch(`${inferenceBaseUrl}/audio/speech`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: tts.modelId,
            input: req.text,
            voice: req.voice ?? "default"
          })
        });
        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          api.log.error(`CI Hub TTS request failed (${response.status}): ${errorText.slice(0, 500)}`);
          throw new Error(`CI Hub TTS request failed: ${response.status} ${response.statusText}`);
        }
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        return {
          audioBuffer,
          outputFormat: "mp3",
          fileExtension: ".mp3",
          voiceCompatible: true
        };
      }
    });
  }
  void probeTtsAvailability(api, getInferenceStatus, tts);
}
async function fetchInferenceStatus(api, hubUrl, mcpClient, mcpReady) {
  await mcpReady;
  let inferenceStatus = null;
  if (mcpClient.isConnected()) {
    try {
      inferenceStatus = unwrapToolResult(await mcpClient.callTool("hub_get_inference_status", {}));
    } catch {
      api.log.debug("hub_get_inference_status not yet available \u2014 trying REST fallback");
    }
  }
  if (!inferenceStatus) {
    try {
      const response = await fetchWithTimeout(`${hubUrl.replace(/\/$/, "")}/api/inference/status`, {});
      if (response.ok) {
        inferenceStatus = await response.json();
      }
    } catch {
      api.log.debug("Inference REST endpoint not available");
    }
  }
  if (!inferenceStatus) {
    api.log.info("Hub inference not available \u2014 skipping auto-configuration");
    return null;
  }
  api.log.info(`Hub inference detected: tier=${inferenceStatus.hardwareTier}, models=${inferenceStatus.models.length}`);
  if (inferenceStatus.hardwareTier === "insufficient") {
    api.log.warn(
      "Hub hardware does not support local inference. Configure a cloud provider in Hub Settings \u2192 AI \u2192 Cloud Providers. GitHub Copilot is recommended (includes Claude, GPT, and Gemini under one subscription)."
    );
  }
  const configuredCloud = inferenceStatus.cloudProviders.filter((p) => p.configured);
  if (configuredCloud.length > 0) {
    api.log.info(`Hub has ${configuredCloud.length} cloud provider(s) configured as fallback`);
  }
  return inferenceStatus;
}
async function discoverLocalModels(api, ollamaNativeUrl, getInferenceStatus) {
  const isEmbeddingModel = (id) => /embed/i.test(id);
  let localModels = [];
  try {
    const response = await fetchWithTimeout(`${ollamaNativeUrl}/api/tags`, {});
    if (response.ok) {
      const payload = await response.json();
      localModels = (payload.models ?? []).filter((model) => typeof model.name === "string" && model.name.length > 0 && !isEmbeddingModel(model.name)).map((model) => ({
        id: model.name
      }));
    }
  } catch {
    api.log.debug("Direct Ollama model discovery unavailable \u2014 falling back to Hub inference status");
  }
  if (localModels.length === 0) {
    const inferenceStatus = await getInferenceStatus();
    localModels = (inferenceStatus?.models ?? []).filter((m) => m.local && m.modality.includes("text") && (m.state === "pulled" || m.state === "loaded" || m.state === "pinned")).map((m) => ({
      id: m.id,
      context_window: m.context_window,
      max_tokens: m.max_tokens
    })).filter((m) => m.id.includes(":"));
  }
  const hubNumCtx = Number.parseInt(process.env.CI_LLM_NUM_CTX ?? "", 10);
  const numCtx = Number.isFinite(hubNumCtx) && hubNumCtx > 0 ? hubNumCtx : void 0;
  const models = localModels.map((m) => {
    const DEFAULT_CTX = 32768;
    const effCtx = numCtx ? Math.min(numCtx, m.context_window ?? DEFAULT_CTX) : void 0;
    const contextWindow = effCtx ?? Math.min(DEFAULT_CTX, m.context_window ?? DEFAULT_CTX);
    return {
      id: m.id,
      name: m.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      // Output budget can't exceed the total context window.
      maxTokens: Math.min(m.max_tokens ?? 8192, contextWindow),
      ...effCtx ? { params: { num_ctx: effCtx } } : {}
    };
  });
  api.log.info(`CI Hub provider catalog resolved ${models.length} local model(s)`);
  return models;
}
async function probeTtsAvailability(api, getInferenceStatus, tts) {
  try {
    const inferenceStatus = await getInferenceStatus();
    if (!inferenceStatus) return;
    const ttsModels = inferenceStatus.models.filter((m) => m.local && m.modality.includes("tts") && (m.state === "loaded" || m.state === "pinned"));
    const lemonadeBackend = inferenceStatus.backends.find((b) => b.type === "lemonade");
    if (ttsModels.length > 0 && lemonadeBackend?.running) {
      tts.modelId = ttsModels[0]?.id ?? tts.modelId;
      tts.ready = true;
      api.log.info("CI Hub TTS available via OpenClaw speech provider");
    }
  } catch (error) {
    api.log.warn(`TTS availability probe failed: ${describeError(error)}`);
  }
}
export {
  register
};
