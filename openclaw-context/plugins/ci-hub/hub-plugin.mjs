// src/http.ts
var REQUEST_TIMEOUT_MS = 15e3;
async function fetchWithTimeout(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
  api.log.info(
    "ci-hub chat models come from openclaw.json (models.providers.ci-hub, written by config-reconcile); this plugin registers no LLM or speech provider \u2014 see CI-Hub#895"
  );
}
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
function createSafeLogger(api) {
  const fallbacks = {
    info: (message) => console.info(`[ci-hub] ${message}`),
    warn: (message) => console.warn(`[ci-hub] ${message}`),
    error: (message) => console.error(`[ci-hub] ${message}`),
    debug: (message) => console.info(`[ci-hub] ${message}`)
  };
  const emit = (level) => (message) => {
    const host = api;
    for (const candidate of [host.logger, host.log]) {
      const hostFn = candidate?.[level];
      if (typeof hostFn === "function") {
        hostFn.call(candidate, message);
        return;
      }
    }
    fallbacks[level](message);
  };
  return { info: emit("info"), warn: emit("warn"), error: emit("error"), debug: emit("debug") };
}
function withSafeLogger(api) {
  const wrapped = Object.create(api);
  Object.defineProperty(wrapped, "log", {
    value: createSafeLogger(api),
    enumerable: true,
    configurable: true
  });
  return wrapped;
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
export {
  register,
  withSafeLogger
};
