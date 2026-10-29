import {
  fetchIntentManifest,
  describeCatalogForPrompt,
  executePathCandidates,
} from "./intentCatalog.js";

const PLUGIN_ID = "companionintelligence";
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RESULTS = 5;
// Tight bound for the user-context fetch at agent bootstrap, kept shorter than
// DEFAULT_TIMEOUT_MS so a slow/unreachable CI-Server can't stall agent startup.
const BOOTSTRAP_CONTEXT_TIMEOUT_MS = 5000;
const RECALL_PATH = "ci-server://recall";
const PROFILE_PATH = "ci-server://profile";
// The forget line names ci_run_intent, so it is only given when that tool is
// registered (both intent flags on). Pointing the agent at a tool it does not
// have makes it call one that does not exist.
const CI_MEMORY_FORGET_GUIDANCE =
  "To forget or delete something in Companion Memory, find its id with `ci_run_intent` (`places_find`, `people_find` or `knowledge_search`), then call `ci_run_intent` with `memory_forget` and that id. The owner approves the forget on their own device.";

function bootstrapGuidance() {
  const runIntent = featureEnabled("CI_INTENTS_ENABLED") && featureEnabled("CI_INTENT_TOOLS_ENABLED");
  return [
    "",
    "## Companion Intelligence Memory",
    "",
    "Companion Intelligence is the active OpenClaw memory backend.",
    "For user profile facts, preferences, durable notes, decisions, prior-project context, and explicit remember/save requests, use the `memory_store` tool.",
    "Do not create or edit `USER.md`, `MEMORY.md`, or `memory/*.md` for memory storage while this backend is active.",
    "Do not inspect, query, edit, or write OpenClaw's local memory SQLite files — the `.openclaw/memory` directory wherever OpenClaw's state directory lives (`/data/.openclaw/memory` in the packaged app, `~/.openclaw/memory` or `%USERPROFILE%\\.openclaw\\memory` on your own install); they are internal cache/index storage, not the Companion Intelligence memory system.",
    "Use `memory_search` for topical recall and `memory_get` with `ci-server://profile` for the CI-Server profile block.",
    ...(runIntent ? [CI_MEMORY_FORGET_GUIDANCE] : []),
    "When a wake or message says `Memory dispatch job <id>`, call `ci_dispatch_packet` with that id, do the briefing, then `ci_dispatch_checkpoint` (status completed, or blocked if you need the user). Push every meaningful step. Do not wait for Memory to pull your session.",
  ].join("\n");
}

// Marker delimiting the live user-context block injected at agent bootstrap, so
// it can be deduplicated within a single bootstrap assembly.
const CI_MEMORY_USER_CONTEXT_MARKER = "<!-- ci-memory:user-context -->";

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
  // The packaged app's own memory directory, matched anywhere in a string so a
  // shell command that touches it is caught too.
  if (/(^|\s|["'])\/data\/\.openclaw\/memory(?:\/|\s|$|["'])/u.test(path)) return true;
  // OpenClaw's memory database wherever OpenClaw's state directory lives. The
  // leading `/` in the prefix class is what makes this fire on an ABSOLUTE path —
  // a native Windows install's `C:\Users\<u>\.openclaw\memory\main.sqlite`
  // (backslashes already normalized above), and `/home/<u>`, `/Users/<u>`, `~/`
  // alike. Anchoring only to start-of-string, whitespace or a quote — as this did
  // — matched the container path and essentially nothing a stock install actually
  // reports, so the guard silently never fired off-appliance.
  //
  // The `.sqlite`/`.sqlite3` filename stays required here. This rule runs against
  // EVERY string reachable from a tool's params, `content` included, so dropping
  // it would hard-block any edit whose text merely names the directory in prose —
  // this repo's README, and the plugin's own guidance above, both do.
  // `=` opens the match for the same reason a space does: `--db=.openclaw/…` attaches
  // the path to a flag, and a boundary that only knows about whitespace never sees the
  // start of it.
  if (/(^|[\s"'/=])\.openclaw\/memory\/[^"'\s]+\.sqlite3?(?:[\s"']|$)/u.test(path)) return true;

  // Shell operators terminate the filename too — but ONLY for a string that could
  // itself be a command. Without this, `sqlite3 ~/.openclaw/memory/main.sqlite|head`
  // and `…main.sqlite;rm -f …` walk through a guard whose purpose is reading shell
  // commands, because the filename is followed by an operator rather than a space.
  //
  // The single-line restriction is what stops that widening from firing on prose. A
  // `content` parameter is a whole file and effectively always multi-line, and any
  // file may legitimately QUOTE such a command: this very comment does, and admitting
  // `|` unconditionally made the plugin refuse to let anything edit its own source —
  // the same over-blocking the `.sqlite` requirement above exists to prevent. A real
  // command is one line; a document that mentions one is not.
  if (!path.includes("\n") && /(^|[\s"'/=])\.openclaw\/memory\/[^"'\s]+\.sqlite3?[|;&><]/u.test(path)) {
    return true;
  }

  // Any path UNDER the memory directory, whole-string only. The `.sqlite` rules above
  // miss OpenClaw's default store, which is lancedb: `~/.openclaw/memory/lancedb/…`
  // holds `.lance` files, not sqlite ones, so requiring that extension left the real
  // memory backend of a stock install unguarded. Whole-string keeps this safe against
  // prose, since a sentence mentioning the path is never equal to it.
  if (/^(?:[^"'\s]*\/)?\.openclaw\/memory(?:\/[^"'\s]*)?$/u.test(path)) return true;
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

// Locate the workspace AGENTS.md entry.
//
// Exact case first, then case-insensitively. The fallback is what Windows and macOS
// need: their filesystems are case-insensitive, so `agents.md` on disk IS the file
// every other consumer calls AGENTS.md, and an exact-only find would miss it and push
// a second synthetic entry aliasing the same file — leaving the user's real content
// without the guidance.
//
// The exact pass first is what keeps that off Linux, where the two are genuinely
// different files and can both exist. Preferring whichever merely came first in the
// array would have quietly moved the write to the other one.
function findAgentsFile(bootstrapFiles) {
  return (
    bootstrapFiles.find((file) => normalizeString(file?.name) === "AGENTS.md") ??
    bootstrapFiles.find((file) => normalizeString(file?.name).toLowerCase() === "agents.md")
  );
}

// Ensure the bootstrap memory guidance is present in AGENTS.md. Synchronous and
// idempotent: appends to an existing AGENTS.md (unless already present) or
// creates one.
function injectBootstrapGuidance(context) {
  const agentsFile = findAgentsFile(context.bootstrapFiles);
  if (agentsFile) {
    const content = typeof agentsFile.content === "string" ? agentsFile.content : "";
    if (!content.includes("Companion Intelligence is the active OpenClaw memory backend.")) {
      agentsFile.content = `${content.trimEnd()}\n${bootstrapGuidance()}\n`;
      agentsFile.missing = false;
    }
    return;
  }

  context.bootstrapFiles.push({
    name: "AGENTS.md",
    path: "AGENTS.md",
    missing: false,
    content: bootstrapGuidance().trimStart(),
  });
}

// Fetch the live CI-Server user-context block (current user, top preferences,
// quick stats). Best-effort: any error or missing config yields "" so bootstrap
// is never blocked or broken. The request timeout is tightened to
// BOOTSTRAP_CONTEXT_TIMEOUT_MS — requestJson() aborts on config.timeoutMs, so
// lowering it here genuinely bounds (and aborts) the in-flight fetch rather than
// just the wait.
async function fetchUserContextBlock(api, cfg) {
  try {
    const client = createClient(api, cfg);
    if (!client.config.url || !client.config.token) return "";
    client.config.timeoutMs = Math.min(client.config.timeoutMs, BOOTSTRAP_CONTEXT_TIMEOUT_MS);
    return normalizeString(await client.context());
  } catch {
    return "";
  }
}

// Inject the live user-context block into AGENTS.md so models that don't
// proactively call memory tools (e.g. small local models) still see who the
// user is without a tool round-trip. Deduplicated via the marker.
function appendUserContextBlock(context, block) {
  if (!block) return;
  const section = [
    CI_MEMORY_USER_CONTEXT_MARKER,
    "## Known User Context (Companion Intelligence Memory)",
    "",
    "Retrieved live from the active memory backend. Treat this as known facts",
    "about the current user — you do not need to call a tool to obtain it. Use",
    "memory_search for anything not covered here.",
    "",
    block,
    "",
  ].join("\n");

  const agentsFile = findAgentsFile(context.bootstrapFiles);
  if (agentsFile) {
    const content = typeof agentsFile.content === "string" ? agentsFile.content : "";
    if (content.includes(CI_MEMORY_USER_CONTEXT_MARKER)) return;
    agentsFile.content = `${content.trimEnd()}\n\n${section}`;
    agentsFile.missing = false;
    return;
  }

  context.bootstrapFiles.push({
    name: "AGENTS.md",
    path: "AGENTS.md",
    missing: false,
    content: section,
  });
}

const claimedDispatchJobs = new Set();

function appendDispatchBriefing(context, packet) {
  if (!context || !Array.isArray(context.bootstrapFiles)) return;
  const briefing = formatDispatchBriefing(packet);
  const section = [
    "",
    "## Memory dispatch briefing",
    "",
    briefing.slice(0, 2000),
    "",
    "This packet is already fetched. Do the work, then call ci_dispatch_checkpoint.",
    "",
  ].join("\n");
  const agentsFile = findAgentsFile(context.bootstrapFiles);
  if (!agentsFile) {
    context.bootstrapFiles.push({
      name: "AGENTS.md",
      path: "AGENTS.md",
      missing: false,
      content: section.trimStart(),
    });
    return;
  }
  const content = typeof agentsFile.content === "string" ? agentsFile.content : "";
  if (content.includes("## Memory dispatch briefing")) return;
  agentsFile.content = `${content.trimEnd()}\n${section}`;
  agentsFile.missing = false;
}

async function claimDispatchJob(api, cfg, jobId, context) {
  if (!jobId || claimedDispatchJobs.has(jobId)) return;
  claimedDispatchJobs.add(jobId);
  const client = createClient(api, cfg);
  if (!client.config.url || !client.config.token) return;
  try {
    const packet = await client.getPacket(jobId);
    appendDispatchBriefing(context, packet);
    await client.checkpoint(jobId, {
      turns: [{ role: "assistant", content: "Picked up the dispatch. Working it now." }],
      status: "running",
      step: "packet",
    });
  } catch (error) {
    try {
      await client.checkpoint(jobId, {
        turns: [
          {
            role: "assistant",
            content: `Could not fetch the dispatch packet: ${String(error?.message || error)}`,
          },
        ],
        status: "failed",
        failed: true,
        step: "packet",
      });
    } catch (inner) {
      api.log?.debug?.(`CI-Server dispatch claim failed: ${String(inner?.message || inner)}`);
    }
  }
}

async function applyBootstrapMemoryGuidance(event, api) {
  const context = event?.context;
  if (!context || !isCiMemoryActive(context.cfg)) return;
  if (!Array.isArray(context.bootstrapFiles)) return;

  // Static guidance first — synchronous, so it lands even if the bootstrap hook
  // runner does not await async handlers.
  injectBootstrapGuidance(context);

  const jobId = featureEnabled("CI_DISPATCH_ENABLED") ? extractDispatchJobIdFromEvent(event) : "";
  if (jobId) {
    await claimDispatchJob(api, context.cfg, jobId, context);
    return;
  }

  // The live user-context block embeds profile data (name, preferences) into the
  // prompt of whatever model is configured, including remote ones. Allow an
  // explicit opt-out (config `injectUserContext: false`) for deployments that
  // don't want profile data sent to the model; default stays on.
  const pluginConfig = readLivePluginConfig(api, context.cfg);
  if (pluginConfig.injectUserContext === false || !featureEnabled("CI_MEMORY_CONTEXT_ENABLED")) return;

  // Then inject the live user-context block. Best-effort: a failed/empty fetch
  // leaves the guidance-only behavior intact (no regression for strong models
  // that retrieve via memory_search/memory_get).
  const block = await fetchUserContextBlock(api, context.cfg);
  appendUserContextBlock(context, block);
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

// API-system feature flags. Each CI-Server API the plugin uses can be turned
// on/off independently via an env var (default on). Flag names match CI-Hermes:
//   CI_MEMORY_CONTEXT_ENABLED  — L0 profile (/api/memory/context): bootstrap block + memory_get
//   CI_MEMORY_RECALL_ENABLED   — L1 recall (/api/memory/recall): memory_search
//   CI_MEMORY_TURN_ENABLED     — turn-sync (/api/memory/turn): agent_end + before_compaction
//   CI_MEMORY_WRITE_ENABLED    — durable notes (/api/memory/write): memory_store
//   CI_INTENTS_ENABLED         — intent catalog (/api/intents): ci_list_intents + ci_run_intent
//   CI_INTENT_TOOLS_ENABLED    — ci_run_intent (POST /api/intents/:name/execute);
//                                sub-switch of CI_INTENTS_ENABLED (both default on)
//   CI_DISPATCH_ENABLED        — Memory dispatch jobs (/api/v1/agent/jobs): packet + checkpoint
const FEATURE_FALSY = new Set(["0", "false", "no", "off"]);
function featureEnabled(envName, defaultOn = true) {
  const raw = process.env[envName];
  if (raw === undefined || String(raw).trim() === "") return defaultOn;
  return !FEATURE_FALSY.has(String(raw).trim().toLowerCase());
}

function normalizeBaseUrl(url) {
  // Strip trailing slashes and a legacy `/api/mcp` suffix (matches CI-Hermes) so
  // an old config value pointing at the MCP path still resolves to the gateway base.
  const base = url.replace(/\/+$/, "");
  return base.endsWith("/api/mcp") ? base.slice(0, -"/api/mcp".length) : base;
}

const DISPATCH_JOB_LABEL_RE = /Memory dispatch job ([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})/;
const DISPATCH_JOB_UUID7_RE = /\b(01[0-9a-fA-F]{6}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/;

function extractDispatchJobId(text) {
  const source = normalizeString(text);
  if (!source) return "";
  return source.match(DISPATCH_JOB_LABEL_RE)?.[1] || source.match(DISPATCH_JOB_UUID7_RE)?.[1] || "";
}

function extractDispatchJobIdFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  for (const message of messages) {
    const text =
      typeof message?.content === "string" ? message.content : extractMessageText(message?.content);
    const id = extractDispatchJobId(text);
    if (id) return id;
  }
  return "";
}

function extractDispatchJobIdFromEvent(event) {
  return (
    extractDispatchJobIdFromMessages(event?.messages) ||
    extractDispatchJobId(event?.prompt) ||
    extractDispatchJobId(event?.text) ||
    extractDispatchJobId(event?.message)
  );
}

function formatDispatchBriefing(packet) {
  const turns = Array.isArray(packet?.turns) ? packet.turns : [];
  const body = turns
    .map((turn) => `${normalizeString(turn?.role) || "user"}: ${normalizeString(turn?.content)}`)
    .filter((line) => line.includes(": ") && !line.endsWith(": "))
    .join("\n\n");
  return body || normalizeString(packet?.source?.title) || "Empty dispatch packet.";
}

/**
 * What a turn's text tells us about the job — WITHOUT ever claiming it is done.
 *
 * This used to return "completed" for any assistant message of 80+ characters
 * that missed a narrow in-progress phrase list. The agent's first substantive
 * reply after reading the briefing — a plan, an acknowledgement, a restatement
 * of the ask — is almost always over 80 characters and matches none of those
 * phrases, so the job was checkpointed "completed" on turn one. That drove
 * finishCompleted on the server, which marks the USER'S TASK done and posts a
 * "✓" to the thread, before any real work happened.
 *
 * Length is not evidence of completion. It is evidence of length.
 *
 * The two errors are not symmetric, which is what settles the design:
 *  - Falsely "running" costs a job that idles until the 15-minute reaper closes
 *    it and hands the task back to `open`. Annoying, and self-correcting.
 *  - Falsely "completed" marks the owner's task done, and nothing corrects it.
 *
 * So completion is now something the agent must STATE, by calling
 * ci_dispatch_checkpoint with status "completed". "blocked" is still inferred
 * because that error is safe in the same way: a blocked job is resumable — the
 * server treats blocked-on-needs-user as the reply-to-resume path — and the
 * cost of missing a genuine block is the same idle-until-reaped.
 */
function inferDispatchStatus(assistantText) {
  const text = normalizeString(assistantText).toLowerCase();
  if (!text) return "running";
  if (/\b(need(s)? (you|the user)|blocked|cannot (continue|proceed)|waiting on you)\b/.test(text)) {
    return "blocked";
  }
  return "running";
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
    url: normalizeBaseUrl(url),
    token,
    timeoutMs,
    maxResults,
  };
}

// Request errors end up in /ci-memory replies and in tool results the model reads,
// so the API key must never appear in one. Node's header validation quotes the
// offending value verbatim (`Headers.append: "<key>" is an invalid header value.`)
// when a pasted key carries a stray newline.
function redactToken(message, config) {
  return config.token ? message.split(config.token).join("<api key>") : message;
}

// Node's fetch reports every network failure as a bare "fetch failed" and keeps the
// reason (ECONNREFUSED, ENOTFOUND, a TLS error) on `cause`, and our own timer shows up
// as "This operation was aborted". Neither tells a wrong address from a slow one.
function describeTransportError(error, config, timedOut) {
  if (timedOut) return `CI-Server did not answer within ${config.timeoutMs}ms`;
  let message = String(error?.message || error);
  const cause = error?.cause?.code || error?.cause?.message;
  if (cause && !message.includes(cause)) message += ` (${cause})`;
  return redactToken(message, config);
}

async function requestJson(config, path, options = {}) {
  if (!config.url || !config.token) {
    throw new Error("CI-Server URL or token is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref?.();

  try {
    let res;
    let text;
    try {
      res = await fetch(`${config.url}${path}`, {
        method: options.method || "GET",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "x-api-key": config.token,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (error) {
      throw new Error(describeTransportError(error, config, controller.signal.aborted));
    }

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
      throw new Error(
        redactToken(`CI-Server HTTP ${res.status}${detail ? `: ${detail}` : ""}`, config),
      );
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

// --- Transcript normalization -------------------------------------------------
// OpenClaw turn/compaction hooks deliver messages in mixed shapes (string
// content, or arrays of typed text blocks). These mirror OpenClaw's own
// agent_end transcript extraction so we persist the same text the runtime sees.
const TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text"]);
// Per-message content clamp before sending to CI-Server, matching Hermes.
const MAX_TURN_CONTENT_CHARS = 4000;

function readTextValue(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.value === "string") return value.value;
  return "";
}

function extractTextBlock(block) {
  if (!block || typeof block !== "object") return "";
  const type = block.type;
  if (typeof type !== "string" || !TEXT_BLOCK_TYPES.has(type)) return "";
  return readTextValue(block.text);
}

function extractMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractTextBlock).filter(Boolean).join("\n");
  return extractTextBlock(content);
}

// A Hub wake is not the owner talking. The Hub posts it to OpenClaw's POST /hooks/wake,
// which queues the text as a system event and runs a heartbeat turn on it. That turn's
// user message is OpenClaw's: the queued events as `System: [<ts>] <text>` lines, then
// the heartbeat instruction. Memory stores a turn's user side as the owner's own words,
// so these turns stay out of the sync.
//
// agent_end says which run it was (ctx.trigger). A heartbeat run is skipped whole.
// Otherwise the event lines in front of a message are dropped: OpenClaw wrote them,
// the queued Hub wake among them, even when an owner message arrived while a wake was
// still queued and carries them. What is left is the owner's, unless nothing is left
// or it is a heartbeat instruction or a wake the ci-hub plugin sent as a message of
// its own. Only then is the exchange a wake. Without a trigger (before_compaction
// always) that text is all there is to go on.
//
// The Hub's wake texts: a dispatch ("Memory dispatch job <id>. Fetch the packet from
// Memory.") and an event ("CI-Hub [<urgency>] <event> ..."). The ci-hub plugin's own
// wake route words an event as "CI-Hub alert (<urgency>): ...". A leading `System:` in
// what a person typed is rewritten to `System (untrusted):` on the way in, so it never
// reads as an event here.
const SYSTEM_EVENT_LINE = "System: ";
const HUB_EVENT_WAKE_RE = /^(?:\[[^\]\n]*\]\s*)?(?:CI-Hub \[[a-z]+\] |CI-Hub alert \()/;
const HUB_DISPATCH_WAKE_RE =
  /^(?:\[[^\]\n]*\]\s*)?Memory dispatch job [0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\. Fetch the packet from Memory\.$/;
// OpenClaw's own heartbeat instructions (2026.9.1 and the older default) and the
// marker it stores in place of one.
const HEARTBEAT_PROMPTS = [
  "Follow the heartbeat monitor scratch context when provided.",
  "Run the following periodic tasks (only those due based on their intervals):",
  "Read HEARTBEAT.md if it exists (workspace context).",
];
const HEARTBEAT_TRANSCRIPT_MARKER = "[OpenClaw heartbeat poll]";

function isHubWakeText(text) {
  return HUB_EVENT_WAKE_RE.test(text) || HUB_DISPATCH_WAKE_RE.test(text);
}

function isHeartbeatInstruction(text) {
  return (
    HEARTBEAT_PROMPTS.some((prompt) => text.startsWith(prompt)) ||
    text.split("\n").some((line) => line.trim() === HEARTBEAT_TRANSCRIPT_MARKER)
  );
}

// A transcript user message: the owner's words, or a wake. `content` is the message
// without the system event lines in front of it. `ownerRun`: the owner started this run.
function readUserText(text, ownerRun) {
  const lines = text.split("\n");
  let eventLines = 0;
  while (eventLines < lines.length && lines[eventLines].startsWith(SYSTEM_EVENT_LINE)) eventLines++;
  const content = lines.slice(eventLines).join("\n").trim();
  if (ownerRun) return { wake: false, content };
  const wake = !content || isHubWakeText(content) || isHeartbeatInstruction(content);
  return { wake, content };
}

// OpenClaw transcript messages as user/assistant text (the roles CI-Server accepts),
// each clamped the same way Hermes does. A user turn that is a wake is kept, marked
// `wake`, so its replies can be told from the owner's. A user turn with no text (a photo
// with no caption) is kept empty: it still ends the wake before it.
function readTurns(messages, { limit = MAX_TURN_CONTENT_CHARS, ownerRun = false } = {}) {
  if (!Array.isArray(messages)) return [];
  const turns = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractMessageText(message.content).trim();
    if (role === "assistant") {
      if (text) turns.push({ role, content: text.slice(0, limit) });
      continue;
    }
    const user = text ? readUserText(text, ownerRun) : { wake: false, content: "" };
    turns.push({ role, content: user.content.slice(0, limit), ...(user.wake ? { wake: true } : {}) });
  }
  return turns;
}

// The owner's exchanges as CI-Server /api/memory/turn turns. A wake and every reply
// to it, up to the owner's next message, are left out together: dropping only the wake
// would file the agent's answer to it under the owner's message before.
function normalizeTurnMessages(messages, limit = MAX_TURN_CONTENT_CHARS) {
  const turns = [];
  let inWake = false;
  for (const turn of readTurns(messages, { limit })) {
    if (turn.role === "user") inWake = Boolean(turn.wake);
    if (!inWake && turn.content) turns.push({ role: turn.role, content: turn.content });
  }
  return turns;
}

// The just-completed exchange, from readTurns: the last assistant message and the
// last user message with text before it. Mirrors Hermes sync_turn(user, assistant);
// CI-Server dedupes on the server side so re-sends are cheap. Requires BOTH a user and
// an assistant message: an unpaired assistant (e.g. a proactive turn) is not a
// conversation exchange and is skipped. So is a reply to a wake.
function latestExchange(turns) {
  let assistantIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "assistant") { assistantIdx = i; break; }
  }
  if (assistantIdx === -1) return [];
  let userIdx = -1;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (turns[i].role === "user" && (turns[i].content || turns[i].wake)) { userIdx = i; break; }
  }
  if (userIdx === -1 || turns[userIdx].wake) return [];
  return [
    { role: "user", content: turns[userIdx].content },
    { role: "assistant", content: turns[assistantIdx].content },
  ];
}

// Fire-and-forget transcript sync. Never throws into the agent run: a failed or
// unconfigured CI-Server must not break the turn (matches Hermes behavior).
async function syncTurn(api, messages, sessionId) {
  if (!messages.length) return;
  const client = createClient(api);
  if (!client.config.url || !client.config.token) return;
  try {
    await client.turn(messages, { sessionId });
  } catch (error) {
    api.log?.debug?.(`CI-Server turn sync failed: ${String(error?.message || error)}`);
  }
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
      // No 404 fallback: `/api/memory/note` was renamed to `/write` in CI-Server
      // on 2026-06-03 and no longer exists, so the fallback turned one 404 into
      // two and reported the second. Let a 404 surface as itself.
      return await requestJson(config, "/api/memory/write", {
        method: "POST",
        body: payload,
      });
    },
    async turn(messages, options = {}) {
      const payload = {
        messages,
        platform: options.platform || "openclaw",
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      };
      return await requestJson(config, "/api/memory/turn", {
        method: "POST",
        body: payload,
      });
    },
    async getPacket(jobId) {
      return await requestJson(config, `/api/v1/agent/jobs/${jobId}/packet`);
    },
    async checkpoint(jobId, input) {
      return await requestJson(config, `/api/v1/agent/jobs/${jobId}/checkpoint`, {
        method: "POST",
        body: input,
      });
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
      "Do not inspect or write the *.sqlite files in OpenClaw's own `.openclaw/memory` state directory, wherever it lives on this machine; those are OpenClaw internals, not the CI memory database.",
    );
  }
  if (availableTools.has("ci_dispatch_packet")) {
    lines.push(
      "When woken with a Memory dispatch job id, fetch the packet with ci_dispatch_packet, do that work, then ci_dispatch_checkpoint.",
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

function createDispatchPacketTool(api) {
  return {
    name: "ci_dispatch_packet",
    label: "Fetch Memory dispatch",
    description:
      "Fetch a Companion Intelligence dispatch packet by job id. Use this when woken with `Memory dispatch job <id>`.",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Dispatch job id from the wake text." },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const jobId = extractDispatchJobId(params?.jobId) || normalizeString(params?.jobId);
      if (!jobId) return jsonResult({ error: "jobId required" });
      const client = createClient(api);
      const packet = await client.getPacket(jobId);
      return jsonResult({
        jobId,
        briefing: formatDispatchBriefing(packet),
        packet,
      });
    },
  };
}

function createDispatchCheckpointTool(api) {
  return {
    name: "ci_dispatch_checkpoint",
    label: "Checkpoint Memory dispatch",
    description:
      "Push a dispatch checkpoint back to Companion Intelligence. Call after each meaningful step, and when finished or blocked. " +
      "The job stays open until you say otherwise: to finish it you MUST pass status \"completed\" explicitly — nothing infers that for you, and a job left un-finished is closed as failed after 15 minutes.",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        content: { type: "string", description: "What you did or found." },
        status: { type: "string", enum: ["running", "blocked", "completed", "failed"] },
        needsUser: { type: "boolean" },
        failed: { type: "boolean" },
        step: { type: "string" },
      },
      required: ["jobId", "content"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const jobId = extractDispatchJobId(params?.jobId) || normalizeString(params?.jobId);
      const content = normalizeString(params?.content);
      if (!jobId) return jsonResult({ error: "jobId required" });
      if (!content) return jsonResult({ error: "content required" });
      const client = createClient(api);
      // An explicitly stated status wins; the fallback can only ever say
      // "running" or "blocked" now, so an unstated status can no longer finish
      // the job by accident. That mattered here as much as in the agent_end
      // hook: a deliberate mid-work checkpoint whose content ran past 80
      // characters used to complete the job the agent was reporting progress on.
      const stated = normalizeString(params?.status);
      const body = {
        turns: [{ role: "assistant", content }],
        status: stated || inferDispatchStatus(content),
        ...(params?.needsUser ? { needsUser: true } : {}),
        ...(params?.failed ? { failed: true } : {}),
        ...(normalizeString(params?.step) ? { step: normalizeString(params.step) } : {}),
        ...(stated === "completed" ? { result: { summary: content.slice(0, 800) } } : {}),
      };
      const updated = await client.checkpoint(jobId, body);
      return jsonResult({ jobId, status: updated?.status || body.status });
    },
  };
}

// `runnable` says whether ci_run_intent is registered this session, so this tool
// can tell the agent how to run what it lists.
function createListIntentsTool(api, runnable) {
  return {
    name: "ci_list_intents",
    label: "List CI Intents",
    description:
      "List the curated Companion Intelligence intent catalog — the typed, privacy-labelled actions to prefer over raw CRUD (memory.*, knowledge.*, people.*, places.*, calendar.*, media.*). Returns each intent's tool name and parameters." +
      (runnable ? " Run one with ci_run_intent." : ""),
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const client = createClient(api);
      const manifest = await fetchIntentManifest(
        (path) => requestJson(client.config, path),
        (failures) =>
          api.log?.warn?.(
            `CI-Server intent catalog unavailable — the agent falls back to raw CRUD instead of the ` +
              `curated, privacy-labelled intents. Tried ${failures.join("; ")}`,
          ),
      );
      if (!manifest) {
        return jsonResult({ available: false, error: "CI Intent catalog unavailable" });
      }
      // When ci_run_intent is registered this session, tell the agent how to run
      // what it just listed (this rendered catalog is the one place
      // describeCatalogForPrompt output reaches the model).
      let catalog = describeCatalogForPrompt(manifest);
      if (runnable) {
        catalog +=
          "\n\nRun any intent above with `ci_run_intent`: pass its tool name as `intent` and its parameters as `params`. Destructive and external ones are queued for the owner's approval instead of running.";
      }
      return jsonResult({
        available: true,
        domains: Array.isArray(manifest.domains) ? manifest.domains.map((d) => d.key) : [],
        ...(runnable ? { runWith: "ci_run_intent" } : {}),
        catalog,
      });
    },
  };
}

// The intents ci_run_intent may run: the ones the catalog lists for this key,
// under their dotted id and their tool name. CI-Server's execute route also runs
// tools it keeps out of that catalog (a user's own MCP servers' tools, which it
// does not re-expose to outside agents), and a name the model makes up or a prompt
// injection supplies would reach them. Unlabelled intents stay out, as they did
// when each intent was its own tool. Cached briefly per CI-Server and key, so a
// run of calls costs one catalog fetch.
const INTENT_CATALOG_TTL_MS = 5 * 60 * 1000;
let intentCatalogCache = null;

async function catalogIntentNames(api, config, { fresh = false } = {}) {
  const key = `${config.url}\n${config.token}`;
  const cached = intentCatalogCache;
  if (!fresh && cached && cached.key === key && Date.now() - cached.at < INTENT_CATALOG_TTL_MS) {
    return cached.names;
  }
  const manifest = await fetchIntentManifest(
    (path) => requestJson(config, path),
    (failures) => api.log?.warn?.(`CI-Server intent catalog unavailable to ci_run_intent. Tried ${failures.join("; ")}`),
  );
  if (!manifest) return null;
  const names = new Set();
  for (const intent of Array.isArray(manifest.intents) ? manifest.intents : []) {
    if (!intent || !intent.privacy || typeof intent.privacy !== "object") continue;
    if (typeof intent.name === "string" && intent.name) names.add(intent.name);
    if (typeof intent.tool === "string" && intent.tool) names.add(intent.tool);
  }
  intentCatalogCache = { key, at: Date.now(), names };
  return names;
}

// POST the tool input to the intent's REST execute path. Tries the canonical
// agent path first and falls back to the legacy alias when the route is missing
// (HTTP 404), mirroring fetchIntentManifest's CATALOG_PATHS fallback. Rethrows
// the last error for non-route failures (auth, 5xx, timeout) — the tool's
// execute handler converts it into a structured error result.
async function executeIntentViaRest(config, intentName, input) {
  let lastError;
  for (const path of executePathCandidates(intentName)) {
    try {
      return await requestJson(config, path, { method: "POST", body: input ?? {} });
    } catch (error) {
      lastError = error;
      if (!String(error?.message || error).includes("HTTP 404")) break;
    }
  }
  throw lastError;
}

// CI-Server's answer when an intent needs the owner's say-so. It arrives as a
// normal HTTP 200 with this code in the body — NOT a 4xx — which is why it has
// to be checked for explicitly rather than falling out of the error path.
const QUEUED_ERROR_CODE = "TOOL_QUEUED";

// Run one curated CI intent through CI-Server's REST executor and shape the
// answer for the model. Mirrors the memory tools: authenticated requestJson
// transport, jsonResult payloads and a structured error result (never a throw)
// when CI-Server rejects or is down.
async function runIntentViaRest(api, intent, params) {
  const client = createClient(api);
  try {
    const payload = await executeIntentViaRest(client.config, intent, params);

    // A queue is not a failure, and must not read like one. The raw body has
    // `success: false` and an error object, which a model will treat as
    // something to retry; said plainly instead, with `retry: false` carried
    // explicitly so the instruction survives summarisation.
    if (payload && payload.error && payload.error.code === QUEUED_ERROR_CODE) {
      // `details`, not the top level. `ToolError` on the server is
      // `{ code, message, retryable, details }` and the queue metadata goes
      // in `details` — there is no top-level slot for it in the type. This
      // read was `payload.error.pendingActionId`, which is always
      // undefined, so every queued call reported `pendingActionId: null`
      // and the agent could not name the card it had just raised. The unit
      // test built its fixture flat to match, which kept the bug green.
      //
      // The flat form is tolerated as a fallback only because the two ends
      // release independently: a 90-day connect key outlives a server
      // upgrade, so a harness can be older or newer than the appliance it
      // is talking to.
      const details = payload.error.details ?? {};

      return jsonResult({
        status: "awaiting_owner_approval",
        intent,
        pendingActionId:
          details.pendingActionId ?? payload.error.pendingActionId ?? null,
        // The owner has a deadline (24h by default). Worth telling the user,
        // and it is already in the same object.
        expiresAt: details.expiresAt ?? null,
        retry: false,
        // "This intent", not "this tool": the tool is ci_run_intent, which the
        // agent still needs for every other intent.
        message:
          "Companion Memory has asked the owner to approve this. It has NOT run. Tell the user you have requested approval; do not run this intent again for the same request.",
      });
    }

    return jsonResult(payload);
  } catch (error) {
    const message = String(error?.message || error);
    return jsonResult({
      success: false,
      intent,
      error: message,
      // Both execute paths answer 404 for a name CI-Server does not know. The
      // error text is Nest's `error: "Not Found"` (requestJson prefers it over
      // `message`), so without this a mistyped name reads like an outage.
      ...(message.includes("HTTP 404")
        ? { hint: "CI-Server has no intent by that name. Check the name with ci_list_intents." }
        : {}),
    });
  }
}

// An intent's tool name (memory_forget) or dotted id (memory.forget). The model picks
// this string and it becomes a path segment of the execute URL. encodeURIComponent
// leaves `.` and `..` alone and fetch resolves them, so `..` would POST, with this
// key, to a route outside the intent executor.
const INTENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

// The intent's parameters from a ci_run_intent call. Models do not always nest
// them: some send `params` as a JSON string and some put them next to `intent`.
// Both are taken as meant rather than silently POSTing `{}` in their place, which
// would run the intent with none of what the model asked for.
function resolveIntentParams(args) {
  const { intent: _intent, params, ...rest } = args && typeof args === "object" ? args : {};
  if (params === undefined || params === null) return { params: rest };
  let value = params;
  if (typeof value === "string") {
    try {
      value = value.trim() ? JSON.parse(value) : {};
    } catch {
      value = undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "params must be a JSON object of the intent's parameters" };
  }
  return { params: value };
}

// Runs any curated CI intent by name.
//
// One generic tool rather than one tool per intent, because OpenClaw cannot take
// the per-intent kind. Its loader closes the plugin API as soon as register()
// returns (any later api.registerTool is silently dropped) and it rejects a tool
// whose name is not listed in openclaw.plugin.json `contracts.tools`. The catalog
// arrives over the network, so its tools could only be registered late and under
// names nobody declared: none of them ever reached the agent, memory_forget
// included. This tool is declared and registered synchronously. It takes the
// intent name as an argument; ci_list_intents shows which names exist.
function createRunIntentTool(api) {
  return {
    name: "ci_run_intent",
    label: "Run CI Intent",
    description:
      "Run one Companion Intelligence intent from the catalog that ci_list_intents shows, by its tool name: for example `places_find` to get a place's id, then `memory_forget` with that id. " +
      "Put the intent's parameters in `params`. Destructive and external intents do NOT run straight away: Companion Memory queues an approval card and the owner answers on their own device. When the result says it is awaiting approval, tell the user you have asked and do not run that intent again for the same request.",
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description: "The intent's tool name from ci_list_intents (e.g. memory_forget) or its dotted id (memory.forget).",
        },
        params: {
          type: "object",
          description: "The intent's parameters, as listed by ci_list_intents.",
        },
      },
      required: ["intent"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, args) => {
      const intent = normalizeString(args?.intent);
      if (!intent) return jsonResult({ success: false, error: "intent required" });
      if (!INTENT_NAME_RE.test(intent)) {
        return jsonResult({
          success: false,
          intent,
          error: "not an intent name: use a tool name from ci_list_intents, such as memory_forget",
        });
      }
      const resolved = resolveIntentParams(args);
      if (resolved.error) return jsonResult({ success: false, intent, error: resolved.error });
      const { config } = createClient(api);
      let known = await catalogIntentNames(api, config);
      // A miss may be an intent CI-Server added since the catalog was cached.
      if (known && !known.has(intent)) known = await catalogIntentNames(api, config, { fresh: true });
      if (!known) {
        return jsonResult({ success: false, intent, error: "CI Intent catalog unavailable, so no intent can be run right now" });
      }
      if (!known.has(intent)) {
        return jsonResult({
          success: false,
          intent,
          error: "the intent catalog has no intent by that name",
          hint: "Check the name with ci_list_intents.",
        });
      }
      return runIntentViaRest(api, intent, resolved.params);
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

    // Each tool is registered only when its CI-Server API system is enabled.
    if (featureEnabled("CI_MEMORY_RECALL_ENABLED")) {
      api.registerTool(() => createMemorySearchTool(api), {
        name: "memory_search",
      });
    }
    if (featureEnabled("CI_MEMORY_CONTEXT_ENABLED")) {
      api.registerTool(() => createMemoryGetTool(api), {
        name: "memory_get",
      });
    }
    if (featureEnabled("CI_MEMORY_WRITE_ENABLED")) {
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
    }

    if (featureEnabled("CI_DISPATCH_ENABLED")) {
      api.registerTool(() => createDispatchPacketTool(api), { name: "ci_dispatch_packet" });
      api.registerTool(() => createDispatchCheckpointTool(api), { name: "ci_dispatch_checkpoint" });
    }

    // Curated CI Intent catalog discovery — lets the agent learn the typed,
    // privacy-labelled vocabulary CI-Server publishes (one shared catalog instead
    // of bespoke per-harness glue) and prefer those intents over raw CRUD.
    if (featureEnabled("CI_INTENTS_ENABLED")) {
      const runnable = featureEnabled("CI_INTENT_TOOLS_ENABLED");

      api.registerTool(() => createListIntentsTool(api, runnable), {
        name: "ci_list_intents",
      });

      // Execution goes through CI-Server's REST intent executor
      // (POST /api/intents/:name/execute). Registered here, inside register(),
      // because OpenClaw ignores tools registered after it returns.
      if (runnable) {
        api.registerTool(() => createRunIntentTool(api), { name: "ci_run_intent" });
      }
    }

    api.registerHook?.("agent:bootstrap", (event) => applyBootstrapMemoryGuidance(event, api), {
      name: "companionintelligence-memory-bootstrap",
      description:
        "Directs OpenClaw memory writes to CI-Server and injects the live CI-Server user-context block at bootstrap so memory works without the model calling a tool.",
      priority: 100,
      timeoutMs: BOOTSTRAP_CONTEXT_TIMEOUT_MS,
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

    // Persist each completed exchange to CI-Server, mirroring Hermes sync_turn.
    // agent_end is a conversation hook, so the plugin entry must set
    // `hooks.allowConversationAccess: true` (the CI bootstrap does this).
    api.on?.("agent_end", async (event, ctx) => {
      const messages = event?.messages;
      // A heartbeat turn answers OpenClaw's own prompt. A Hub wake runs as one.
      if (event?.success !== false && ctx?.trigger !== "heartbeat" && featureEnabled("CI_MEMORY_TURN_ENABLED")) {
        const exchange = latestExchange(readTurns(messages, { ownerRun: ctx?.trigger === "user" }));
        await syncTurn(api, exchange, normalizeString(ctx?.sessionId || ctx?.sessionKey));
      }
      if (!featureEnabled("CI_DISPATCH_ENABLED")) return;
      const jobId = extractDispatchJobIdFromMessages(messages) || extractDispatchJobIdFromEvent(event);
      if (!jobId) return;
      const client = createClient(api);
      if (!client.config.url || !client.config.token) return;
      if (event?.success === false) {
        const err =
          normalizeString(event?.error) ||
          "OpenClaw could not finish this turn (context overflow or model error).";
        try {
          await client.checkpoint(jobId, {
            turns: [{ role: "assistant", content: err }],
            status: "failed",
            failed: true,
            step: "inference",
          });
        } catch (error) {
          api.log?.debug?.(`CI-Server dispatch failure checkpoint failed: ${String(error?.message || error)}`);
        }
        return;
      }
      // Every turn, wakes included: a dispatch job arrives as one.
      const turns = readTurns(messages);
      const assistant = [...turns].reverse().find((turn) => turn.role === "assistant");
      if (!assistant) return;
      const status = inferDispatchStatus(assistant.content);
      try {
        await client.getPacket(jobId);
        await client.checkpoint(jobId, {
          turns: [assistant],
          status,
          ...(status === "blocked" ? { needsUser: true } : {}),
          ...(status === "completed" ? { result: { summary: assistant.content.slice(0, 800) } } : {}),
        });
      } catch (error) {
        api.log?.debug?.(`CI-Server dispatch checkpoint failed: ${String(error?.message || error)}`);
      }
    }, {
      priority: 50,
      timeoutMs: 15000,
    });

    // Flush messages about to be dropped from the context window before they are
    // compacted away, mirroring Hermes on_pre_compress. before_compaction is not
    // a conversation hook and needs no extra access flag.
    api.on?.("before_compaction", async (event, ctx) => {
      if (!featureEnabled("CI_MEMORY_TURN_ENABLED")) return;
      const turns = normalizeTurnMessages(event?.messages);
      await syncTurn(api, turns, normalizeString(ctx?.sessionId || ctx?.sessionKey));
    }, {
      priority: 50,
      timeoutMs: 15000,
    });

    // A command handler answers with a reply payload (`{ text }`), not a tool result:
    // OpenClaw reads `text` and shows "No reply was generated" when it is missing.
    //
    // GET /api/health is unauthenticated on CI-Server, so passing it proves the
    // address and nothing about the key. The L0 profile route sits behind the same
    // API-key guard and memory scope the tools use, so a wrong or revoked key fails
    // there with the 401/403 the README tells people to look for.
    api.registerCommand({
      name: "ci-memory",
      description: "Check Companion Intelligence memory connectivity.",
      acceptsArgs: false,
      handler: async (ctx) => {
        const client = createClient(api, ctx?.config);
        const where = client.config.url || "(no URL set)";
        try {
          await client.health();
        } catch (error) {
          return {
            text: `Companion Intelligence memory is not available at ${where}: ${String(
              error?.message || error,
            )}`,
          };
        }
        if (!featureEnabled("CI_MEMORY_CONTEXT_ENABLED")) {
          return {
            text: `Companion Intelligence memory answers at ${where}. The API key was not checked because CI_MEMORY_CONTEXT_ENABLED is off.`,
          };
        }
        try {
          await client.context();
        } catch (error) {
          return {
            text: `Companion Intelligence memory answers at ${where}, but an authenticated request failed: ${String(
              error?.message || error,
            )}`,
          };
        }
        return { text: `Companion Intelligence memory is connected at ${where}.` };
      },
    });
  },
};

// Tests start from an empty catalog cache.
function resetIntentCatalogCache() {
  intentCatalogCache = null;
}

// Exported for unit tests (does not affect the default-export plugin entrypoint).
export {
  resetIntentCatalogCache,
  extractDispatchJobId,
  extractDispatchJobIdFromEvent,
  extractDispatchJobIdFromMessages,
  featureEnabled,
  formatDispatchBriefing,
  inferDispatchStatus,
  normalizeBaseUrl,
};
