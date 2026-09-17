#!/usr/bin/env node
// Agent-turn gate: run a real headless OpenClaw turn on the config reconcile writes, the way
// QA and other apps start one inside the container — `docker exec <app> openclaw agent …`,
// with no config, model, provider or port override.
//
// Why this exists (fleet, 2026-09-17): no automation path could run a turn on an install's
// own configuration.
//   - `openclaw agent` (via the gateway) failed "missing scope: operator.write". The
//     in-container CLI dials gateway.port, which reconcile never wrote, so it defaulted to
//     18789 — the setup proxy, whose browser-shaped Origin makes the gateway downgrade the
//     caller. Reconcile now pins gateway.port to the port the gateway listens on.
//   - `openclaw agent exec` fails "No API provider registered for api: ollama" for the
//     Hub's `ci-hub` provider id. That is upstream: exec loads only plugins whose MANIFEST
//     owns the selected provider id and ignores models.providers.<id>.api. Not ours to fix
//     in config without changing what users' turns do, so this gate REPORTS it (and will say
//     so on the nightly `latest` run the day upstream fixes it) rather than gating on it.
//
// What it does, all against a stub Ollama and a throwaway HOME:
//   1. reconcile a FRESH data dir from a Hub handout (no openclaw.json beforehand),
//   2. start `openclaw gateway` on the port reconcile pinned, plus a copy of server.cjs's
//      proxy (the real buildGatewayHeaders) on another port,
//   3. through the proxy: expect the fleet's refusal (reported, not gated),
//   4. with no override at all: REQUIRE a completed turn served by ci-hub, carrying the Hub key,
//   5. delete that session over the same route (reported),
//   6. `agent exec` on the ambient config (reported).
//
// Run: npm run test:agent-turn     (needs the `openclaw` binary on PATH, and npm for the
//                                   DuckDuckGo plugin the image vendors)

import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import {
  REPO,
  PLUGIN_PATHS,
  CATALOG,
  CHAT_REPLY,
  createConfigReconciler,
  withOllama,
} from "./helpers/reconcile-fixture.mjs";

const require = createRequire(import.meta.url);
const { buildGatewayHeaders } = require(path.join(REPO, "proxy-headers.cjs"));

const OUT =
  process.env.AGENT_TURN_GATE_OUTDIR ||
  fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "agent-turn-gate-"));
fs.mkdirSync(OUT, { recursive: true });

function skipOrDie(reason) {
  if (process.env.CI) {
    console.error(`FATAL: ${reason} and CI is set; this gate must not silently skip.`);
    process.exit(2);
  }
  console.log(`SKIPPED: ${reason}`);
  process.exit(0);
}

const versionRun = spawnSync("openclaw", ["--version"], { encoding: "utf8" });
if (versionRun.status !== 0) {
  skipOrDie('the openclaw binary is not on PATH (npm i -g "openclaw@$(scripts/openclaw-pin.sh)")');
}
const version = (versionRun.stdout.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/) || [])[1];
console.log(`openclaw: ${versionRun.stdout.trim()}`);
console.log(`output:   ${OUT}\n`);

// The image vendors @openclaw/duckduckgo-plugin at the openclaw version (Dockerfile), and
// reconcile points tools.web.search at it. The checkout only carries a placeholder, and a
// search provider that does not load is a runtime config error, so fetch the real one.
const ddgDir = path.join(OUT, "duckduckgo");
if (!fs.existsSync(path.join(ddgDir, "openclaw.plugin.json"))) {
  fs.mkdirSync(ddgDir, { recursive: true });
  const pack = spawnSync(
    "npm",
    ["pack", `@openclaw/duckduckgo-plugin@${version}`, "--pack-destination", OUT, "--silent"],
    { encoding: "utf8" },
  );
  const tarball = pack.stdout.trim().split("\n").pop();
  if (pack.status !== 0 || !tarball) {
    skipOrDie(`could not fetch @openclaw/duckduckgo-plugin@${version}: ${pack.stderr.trim()}`);
  }
  const untar = spawnSync("tar", ["-xzf", path.join(OUT, tarball), "-C", ddgDir, "--strip-components=1"]);
  if (untar.status !== 0) skipOrDie(`could not unpack ${tarball}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const HOME = path.join(OUT, "home");
const DATA_DIR = path.join(HOME, ".openclaw");
const WORKSPACE = path.join(OUT, "workspace");
const MESSAGE = path.join(OUT, "message.txt");
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });
fs.writeFileSync(MESSAGE, "Reply with one word.\n");

// The CLI environment of `docker exec`: the container env, and nothing that names a port or
// a config. Anything OPENCLAW_* inherited from the runner would make this pass for the wrong reason.
function cliEnv(extra = {}) {
  const env = { ...process.env, HOME, NO_COLOR: "1", ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENCLAW_") && !(key in extra)) delete env[key];
  }
  return env;
}

// Async on purpose: the stub Ollama and the proxy live in THIS process, so a spawnSync here
// would block the very event loop that has to answer the CLI's requests.
function openclaw(args, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn("openclaw", args, { cwd: WORKSPACE, env: cliEnv(extraEnv) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* reported via the raw text below */
      }
      resolve({ status, json, text: `${stdout}\n${stderr}` });
    });
  });
}

function oneLine(result) {
  const message =
    result.json?.error?.message ??
    (result.text.match(/Reason: (.*)/) || [])[1] ??
    result.text.trim().split("\n").pop();
  return String(message).slice(0, 240);
}

const GATEWAY_PORT = await freePort();
const PROXY_PORT = await freePort();
const HUB_KEY = "hub-issued-app-key";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

let gateway;
let proxy;
try {
  await withOllama(
    CATALOG,
    async (baseUrl, requests) => {
      // 1. A fresh data dir on a Hub-configured app.
      fs.writeFileSync(
        path.join(DATA_DIR, ".env"),
        [
          `OPENAI_API_BASE=${baseUrl}/v1`,
          `OPENAI_API_KEY=${HUB_KEY}`,
          `OLLAMA_HOST=${baseUrl}`,
          "DEFAULT_MODEL=qwen3:4b",
          "CI_LLM_NUM_CTX=16384",
        ].join("\n") + "\n",
      );
      const quiet = { log() {}, warn() {}, error: (...a) => console.error(...a) };
      const cfg = createConfigReconciler({
        configDir: DATA_DIR,
        containerEnv: {},
        pluginPaths: { ...PLUGIN_PATHS, duckduckgo: ddgDir },
        gatewayPort: GATEWAY_PORT,
        log: quiet,
      });
      await cfg.reconcileConfig();
      const config = cfg.readConfig();
      console.log("reconcile (fresh data dir):");
      check(config !== null, "openclaw.json created from the Hub handout");
      check(config?.gateway?.port === GATEWAY_PORT, `gateway.port pinned to ${GATEWAY_PORT}`);
      check(config?.agents?.defaults?.model?.primary === "ci-hub/auto", "primary is ci-hub/auto");
      if (!config) return;

      // 2. The gateway, as server.cjs starts it, and the setup proxy in front of it.
      const logFile = path.join(OUT, "gateway.log");
      const logStream = fs.openSync(logFile, "w");
      gateway = spawn("openclaw", ["gateway", "--port", String(GATEWAY_PORT)], {
        cwd: HOME,
        env: cliEnv(),
        stdio: ["ignore", logStream, logStream],
        detached: true,
      });
      const deadline = Date.now() + 180_000;
      let ready = false;
      while (Date.now() < deadline && gateway.exitCode === null) {
        if (/\] ready\b/.test(fs.readFileSync(logFile, "utf8"))) {
          ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      console.log("\ngateway:");
      check(ready, `openclaw gateway ready on ${GATEWAY_PORT}`, ready ? "" : `see ${logFile}`);
      if (!ready) return;

      const token = config.gateway.auth.token;
      const gatewayHost = `127.0.0.1:${GATEWAY_PORT}`;
      proxy = http.createServer((req, res) => {
        const headers = buildGatewayHeaders({ reqHeaders: req.headers, url: req.url, gatewayHost, token });
        const upstream = http.request(
          { hostname: "127.0.0.1", port: GATEWAY_PORT, path: req.url, method: req.method, headers },
          (up) => {
            res.writeHead(up.statusCode, up.headers);
            up.pipe(res);
          },
        );
        upstream.on("error", () => res.destroy());
        req.pipe(upstream);
      });
      // The same upgrade rewrite server.cjs's handleUpgrade performs.
      proxy.on("upgrade", (req, socket, head) => {
        const upstream = net.connect(GATEWAY_PORT, "127.0.0.1", () => {
          const headers = buildGatewayHeaders({ reqHeaders: req.headers, url: req.url, gatewayHost, token });
          let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
          for (const [k, v] of Object.entries(headers)) {
            for (const value of Array.isArray(v) ? v : [v]) raw += `${k}: ${value}\r\n`;
          }
          upstream.write(`${raw}\r\n`);
          if (head?.length) upstream.write(head);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
      });
      await new Promise((r) => proxy.listen(PROXY_PORT, "127.0.0.1", r));

      // 3. What the fleet saw: the CLI talking to the setup proxy. Reported, not gated — it
      //    documents the cause, and an upstream change here is not a regression of ours.
      console.log("\nthe fleet's path (CLI -> setup proxy -> gateway), reported:");
      const viaProxy = await openclaw(
        ["agent", "--session-id", "gate-via-proxy", "--message-file", MESSAGE, "--json", "--timeout", "120"],
        { OPENCLAW_GATEWAY_PORT: String(PROXY_PORT) },
      );
      console.log(`    exit ${viaProxy.status}: ${viaProxy.status === 0 ? "turn completed" : oneLine(viaProxy)}`);

      // 4. The supported path: no override of any kind.
      console.log("\nheadless turn on the installed config (`openclaw agent`, no overrides):");
      const sessionId = `gate-${process.pid}-${Date.now()}`;
      const chatsBefore = requests.filter((r) => r.url === "/api/chat").length;
      const turn = await openclaw(["agent", "--session-id", sessionId, "--message-file", MESSAGE, "--json", "--timeout", "120"]);
      fs.writeFileSync(path.join(OUT, "agent-turn.json"), turn.text);
      const meta = turn.json?.result?.meta?.agentMeta;
      const reply = (turn.json?.result?.payloads ?? []).map((p) => p.text).join("");
      check(turn.status === 0 && turn.json?.status === "ok", "turn completed", turn.status === 0 ? "" : oneLine(turn));
      check(meta?.provider === "ci-hub" && meta?.model === "auto", "served by ci-hub/auto", `${meta?.provider}/${meta?.model}`);
      check(reply.includes(CHAT_REPLY), "the model's reply came back");
      const chats = requests.filter((r) => r.url === "/api/chat").slice(chatsBefore);
      check(chats.length > 0, "the turn reached the Hub pool's /api/chat");
      check(
        chats.every((r) => r.authorization === `Bearer ${HUB_KEY}`),
        "with the Hub-issued key",
      );

      // 5. Cleanup over the same route (the fleet harness could not: this also went through the proxy).
      const sessionKey = meta?.sessionFile || `agent:main:explicit:${sessionId}`;
      const del = await openclaw(["sessions", "delete", sessionKey, "--yes", "--json"]);
      console.log(`\n  session cleanup (\`openclaw sessions delete ${sessionKey}\`), reported: exit ${del.status}` +
        (del.status === 0 ? "" : ` — ${oneLine(del)}`));

      // 6. `agent exec` on the ambient config — the upstream plugin-selection bug.
      const exec = await openclaw(["agent", "exec", "--cwd", WORKSPACE, "--message-file", MESSAGE, "--json", "--timeout", "120"]);
      fs.writeFileSync(path.join(OUT, "agent-exec.json"), exec.text);
      console.log(
        "  `openclaw agent exec` on the ambient config, reported: " +
          (exec.json?.ok === true
            ? `WORKS (${exec.json.provider}/${exec.json.model}) — upstream fixed provider-owner selection; see docs/operations/agent-automation.md`
            : `exit ${exec.status} — ${oneLine(exec)}`),
      );
    },
    { aliases: { auto: "qwen3:4b" } },
  );
} finally {
  if (proxy) proxy.close();
  if (gateway && gateway.exitCode === null) {
    try {
      process.kill(-gateway.pid, "SIGTERM");
    } catch {
      gateway.kill("SIGTERM");
    }
  }
}

console.log(failures === 0 ? "\nagent-turn gate: passed" : `\nagent-turn gate: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
