// src/mcp-client.ts
var McpClient = class {
  hubUrl;
  apiKey;
  connected = false;
  messagesUrl = null;
  requestId = 0;
  backoffMs = 1e3;
  maxBackoffMs = 6e4;
  sseAbortController = null;
  log;
  constructor(hubUrl, apiKey, log) {
    this.hubUrl = hubUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.log = log;
  }
  async connect() {
    try {
      this.sseAbortController = new AbortController();
      this.log.info("Connecting to Hub MCP SSE endpoint...");
      this.messagesUrl = await this.discoverMessagesEndpoint();
      const initResponse = await this.sendMessage("initialize", {});
      if (initResponse.result) {
        this.connected = true;
        this.backoffMs = 1e3;
        this.log.info("MCP client connected to Hub");
      }
    } catch (error) {
      this.connected = false;
      this.messagesUrl = null;
      this.log.warn(`MCP connection failed: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleReconnect();
    }
  }
  /**
   * Connect to the SSE endpoint and extract the messages URL from the
   * `endpoint` event, per MCP HTTP+SSE transport spec.
   */
  async discoverMessagesEndpoint() {
    const sseUrl = `${this.hubUrl}/api/mcp/sse`;
    const response = await fetch(sseUrl, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: this.sseAbortController?.signal
    });
    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error("SSE response has no body");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE stream ended before endpoint event");
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ") && currentEvent === "endpoint") {
          const messagesUrl = line.slice(6).trim();
          this.log.info(`Discovered MCP messages endpoint: ${messagesUrl}`);
          return messagesUrl;
        }
      }
    }
  }
  async disconnect() {
    this.sseAbortController?.abort();
    this.sseAbortController = null;
    this.messagesUrl = null;
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
    const response = await this.sendMessage("tools/list", {});
    if (response.error) {
      throw new Error(response.error.message);
    }
    return response.result.tools;
  }
  async callTool(name, args) {
    if (!this.connected) {
      return { error: "Hub MCP server is not connected" };
    }
    try {
      const response = await this.sendMessage("tools/call", { name, arguments: args });
      if (response.error) {
        return { error: response.error.message };
      }
      return response.result;
    } catch {
      this.connected = false;
      this.scheduleReconnect();
      return { error: "Hub MCP server is not connected" };
    }
  }
  async sendMessage(method, params) {
    const url = this.messagesUrl ?? `${this.hubUrl}/api/mcp/messages`;
    const id = ++this.requestId;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body,
      signal: this.sseAbortController?.signal
    });
    if (!response.ok) {
      throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  }
  scheduleReconnect() {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.log.info(`Reconnecting to Hub MCP in ${delay}ms...`);
    setTimeout(() => this.connect(), delay);
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
async function register(api, config) {
  const hubUrl = config.hubUrl || process.env.HUB_URL;
  const hubApiKey = config.hubApiKey || process.env.HUB_API_KEY;
  const mcpApiKey = config.mcpApiKey || process.env.HUB_MCP_API_KEY || hubApiKey;
  const wakeSecret = config.wakeSecret || process.env.HUB_WAKE_SECRET;
  if (!hubUrl || !mcpApiKey) {
    api.log.error("CI-Hub plugin requires hubUrl and mcpApiKey (via config or HUB_URL/HUB_MCP_API_KEY env vars)");
    return;
  }
  api.log.info(`CI-Hub plugin initializing (hub: ${hubUrl})`);
  try {
    const healthResponse = await fetch(`${hubUrl.replace(/\/$/, "")}/api/health`);
    if (!healthResponse.ok) {
      api.log.warn(`Hub health check failed: ${healthResponse.status}`);
    }
  } catch (error) {
    api.log.warn(`Hub unreachable at ${hubUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const mcpClient = new McpClient(hubUrl, mcpApiKey, api.log);
  await mcpClient.connect();
  if (mcpClient.isConnected()) {
    try {
      const tools = await mcpClient.listTools();
      for (const tool of tools) {
        api.registerTool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          handler: async (args) => mcpClient.callTool(tool.name, args)
        });
      }
      api.log.info(`Registered ${tools.length} Hub MCP tools`);
    } catch (error) {
      api.log.error(`Failed to register Hub tools: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const wakeHandler = createWakeEndpointHandler(api, wakeSecret, config.wakeFilter);
  api.registerHttpRoute({
    method: "POST",
    path: "/hooks/hub-wake",
    handler: wakeHandler
  });
  api.log.info("Registered wake endpoint: POST /hooks/hub-wake");
  if (config.sseEnabled) {
    const sseListener = new SseListenerService(hubUrl, mcpApiKey, api, config.wakeFilter);
    await sseListener.start();
  }
  await autoConfigureInference(api, hubUrl, mcpApiKey, mcpClient);
}
async function autoConfigureInference(api, hubUrl, apiKey, mcpClient) {
  try {
    let inferenceStatus = null;
    if (mcpClient.isConnected()) {
      try {
        const result = await mcpClient.callTool("hub_get_inference_status", {});
        inferenceStatus = result;
      } catch {
        api.log.debug("hub_get_inference_status not yet available \u2014 trying REST fallback");
      }
    }
    if (!inferenceStatus) {
      try {
        const response = await fetch(`${hubUrl.replace(/\/$/, "")}/api/inference/status`);
        if (response.ok) {
          inferenceStatus = await response.json();
        }
      } catch {
        api.log.debug("Inference REST endpoint not available");
      }
    }
    if (!inferenceStatus) {
      api.log.info("Hub inference not available \u2014 skipping auto-configuration");
      return;
    }
    api.log.info(`Hub inference detected: tier=${inferenceStatus.hardwareTier}, models=${inferenceStatus.models.length}`);
    if (inferenceStatus.hardwareTier === "insufficient") {
      api.log.warn(
        "Hub hardware does not support local inference. Configure a cloud provider in Hub Settings \u2192 AI \u2192 Cloud Providers. GitHub Copilot is recommended (includes Claude, GPT, and Gemini under one subscription)."
      );
    }
    const ollamaNativeUrl = (process.env.OLLAMA_HOST ?? "http://ci-hub-ollama:11434").replace(/\/$/, "");
    const isEmbeddingModel = (id) => /embed/i.test(id);
    let localModels = [];
    try {
      const response = await fetch(`${ollamaNativeUrl}/api/tags`);
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
      localModels = inferenceStatus.models.filter((m) => m.local && m.modality.includes("text") && (m.state === "pulled" || m.state === "loaded" || m.state === "pinned")).map((m) => ({
        id: m.id,
        context_window: m.context_window,
        max_tokens: m.max_tokens
      })).filter((m) => m.id.includes(":"));
    }
    const hubNumCtx = Number.parseInt(process.env.CI_LLM_NUM_CTX ?? "", 10);
    const numCtx = Number.isFinite(hubNumCtx) && hubNumCtx > 0 ? hubNumCtx : void 0;
    if (localModels.length > 0 && api.registerProvider) {
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
              models: localModels.map((m) => {
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
                  ...effCtx ? { options: { num_ctx: effCtx } } : {}
                };
              })
            }
          })
        }
      });
      api.log.info(`Registered CI Hub as OpenClaw provider with ${localModels.length} local model(s)`);
    }
    const ttsModels = inferenceStatus.models.filter((m) => m.local && m.modality.includes("tts") && (m.state === "loaded" || m.state === "pinned"));
    const lemonadeBackend = inferenceStatus.backends.find((b) => b.type === "lemonade");
    if (ttsModels.length > 0 && lemonadeBackend?.running && api.registerSpeechProvider) {
      const inferenceBaseUrl = `${(process.env.OLLAMA_HOST ?? "http://ci-hub-ollama:11434").replace(/\/$/, "")}/v1`;
      api.registerSpeechProvider({
        id: "ci-hub",
        label: "CI Hub TTS (Local)",
        isConfigured: () => true,
        synthesize: async (req) => {
          const response = await fetch(`${inferenceBaseUrl}/audio/speech`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: ttsModels[0]?.id ?? "kokoro-v1",
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
      api.log.info("Registered CI Hub TTS as OpenClaw speech provider");
    }
    const configuredCloud = inferenceStatus.cloudProviders.filter((p) => p.configured);
    if (configuredCloud.length > 0) {
      api.log.info(`Hub has ${configuredCloud.length} cloud provider(s) configured as fallback`);
    }
  } catch (error) {
    api.log.warn(`Auto-configuration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
export {
  register
};
