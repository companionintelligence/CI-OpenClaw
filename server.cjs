// Opt-out error reporting. MUST stay the first require + call in this file: the
// Sentry SDK patches Node internals (http, child_process, …) on init, and
// instrumentation applied after those modules are loaded misses everything they
// wired up at import time. With no SENTRY_DSN this initialises nothing, requires
// no SDK, and makes no outbound connection — see telemetry.cjs.
const telemetry = require("./telemetry.cjs");
telemetry.initTelemetry();

const http = require("http");
const net = require("net");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const memoryGate = require("./memory-gate.cjs");
const { spawn, exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const pty = require("/app/node_modules/node-pty");
const WebSocket = require("/app/node_modules/ws");
const {
  createConfigReconciler,
  hasCiServerCredentials,
} = require("./config-reconcile.cjs");
const { buildGatewayHeaders, gatewayRootRedirect } = require("./proxy-headers.cjs");
const { createGatewayHealthTracker, handleGatewayHealthRequest } = require("./gateway-health.cjs");

const CONFIG_DIR = process.env.OPENCLAW_DATA_DIR || "/data/.openclaw";
const PORT = parseInt(process.env.SETUP_PORT || "18789");
const OPENCLAW_PORT = 18790; // Internal port for OpenClaw gateway
const SKELETON_DIR = "/home-skeleton";

// Everything that reads or writes openclaw.json / .env lives in config-reconcile.cjs,
// which has no side effects on require and so can be unit-tested — this file cannot
// (it binds a port and requires node-pty by absolute container path at import time).
// Exactly ONE reconciler per process: it carries the last-write timestamp, the
// reported-quarantine set, and the num_ctx memo, all of which must persist across the
// repeated reconciles that startOpenclaw triggers on every gateway exit.
const cfg = createConfigReconciler({
  configDir: CONFIG_DIR,
  gatewayPort: OPENCLAW_PORT,
});

// Anti-CSWSH token for the setup terminal WebSocket. Browsers don't enforce the
// same-origin policy on WebSocket upgrades, so without this any site could connect
// to /api/terminal and hijack the onboarding PTY. We embed APP_SEED (per-user
// secret from CI marketplace) in the served HTML and require it on the WS URL — the
// same-origin policy prevents cross-origin pages from reading it.
const SETUP_TOKEN = process.env.APP_SEED || "";

// Dedicated per-process token for the local memory-gate dismiss actions
// (/__ci_memory/defer + /skip). Deliberately NOT SETUP_TOKEN (=APP_SEED, the
// RCE-grade terminal secret): those actions are low-value (dismiss a prompt), so
// they must not reuse — nor risk leaking — the terminal secret. Minted fresh per
// boot and carried in the POST body (never the URL) so it can't leak via proxy
// logs / Referer / history.
const MEMORY_ACTION_TOKEN = crypto.randomBytes(32).toString("hex");

/**
 * Constant-time token compare that is safe for arbitrary (incl. multi-byte)
 * input: compares BYTE lengths first, because crypto.timingSafeEqual throws a
 * RangeError on unequal-length buffers — and an attacker-supplied value can match
 * the JS string length while differing in bytes. Used by both the memory-gate
 * actions and the /api/terminal WebSocket upgrade.
 */
function tokensMatch(provided, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(provided ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let openclawProcess = null;
let openclawStarting = false;
let ptyProcess = null;
// Follows openclawProcess for the image's HEALTHCHECK (gateway-health.cjs).
const gatewayHealth = createGatewayHealthTracker();
// Set once startOpenclaw() has run: from then on the gateway is meant to be up. The healthcheck
// reads this instead of cfg.isConfigured(), which parses openclaw.json on every call and copies
// the .bak over it when the read fails, so polling it could overwrite a config doctor is writing.
let gatewayWanted = false;


function ensureShellCompletionBypass() {
  const completionDir = path.join(CONFIG_DIR, "completions");
  const completionPath = path.join(completionDir, "openclaw.bash");
  const bashrcPath = path.join(process.env.HOME, ".bashrc");

  fs.mkdirSync(completionDir, { recursive: true });
  if (!fs.existsSync(completionPath)) {
    fs.writeFileSync(
      completionPath,
      "# OpenClaw tab-completion disabled in CI marketplace.\n",
    );
  }

  let bashrc = "";
  try {
    bashrc = fs.readFileSync(bashrcPath, "utf8");
  } catch {}

  if (!bashrc.includes("# OpenClaw Completion")) {
    // OpenClaw QuickStart auto-generates shell tab-completion when it looks
    // unconfigured. That is not useful in the CI app browser terminal and can
    // take ~30s. The marker plus placeholder cache makes OpenClaw skip that
    // setup step without sourcing or executing anything on shell startup.
    const prefix = bashrc && !bashrc.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(bashrcPath, `${prefix}\n# OpenClaw Completion\n`);
  }
}

// Check if a directory is empty
async function isDirEmpty(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath);
    return entries.length === 0;
  } catch {
    return true; // If we can't read it, treat as empty
  }
}

// Copy files from /home-skeleton to $HOME if they don't exist or are empty
async function initializeHome() {
  const homeDir = process.env.HOME;

  try {
    const entries = await fsp.readdir(SKELETON_DIR, { withFileTypes: true });

    for (const entry of entries) {
      // Homebrew belongs in its own mount, /home/linuxbrew, which the entrypoint has already
      // filled (seed-linuxbrew.sh). A copy here only reached that mount while it shared a host
      // folder with /data/linuxbrew, and left an unused second Homebrew in /data when it did not.
      if (entry.name === "linuxbrew") continue;
      const srcPath = path.join(SKELETON_DIR, entry.name);
      const destPath = path.join(homeDir, entry.name);

      try {
        await fsp.access(destPath);
        // Exists - check if it's an empty directory
        if (entry.isDirectory() && (await isDirEmpty(destPath))) {
          console.log(
            `${entry.name} exists but is empty, copying contents inside...`,
          );
          await execAsync(`cp -r "${srcPath}/." "${destPath}/"`);
        } else {
          console.log(`Skipping ${entry.name} (already exists)`);
        }
      } catch {
        // Doesn't exist, copy it
        console.log(`Copying ${entry.name} to home...`);
        if (entry.isDirectory()) {
          await execAsync(`cp -r "${srcPath}" "${destPath}"`);
        } else {
          await fsp.copyFile(srcPath, destPath);
        }
      }
    }
    console.log("Home directory initialized");
  } catch (err) {
    console.error("Error initializing home:", err.message);
  }
}


// Run before gateway start to catch migration issues or config problems that
// readConfig()'s backup restore couldn't fix (e.g. schema changes across versions).
async function runDoctor() {
  // Anchor to our last config write when there is one: a quarantine can happen in
  // any openclaw invocation that reads the file, not only inside this doctor call.
  const since = cfg.configWrittenAtMs || Date.now();
  try {
    await execAsync("openclaw doctor --repair --yes --non-interactive", {
      env: cfg.buildChildEnv(),
    });
    console.log("openclaw doctor completed");
  } catch (e) {
    console.error("openclaw doctor failed:", e.message);
  }
  cfg.warnIfConfigClobbered(since);
}

function startOpenclaw({ repair = true } = {}) {
  gatewayWanted = true;
  // Guard against re-entry: runDoctor() is async, so without this flag every
  // incoming request would see openclawProcess === null and spawn another doctor run.
  if (openclawProcess || openclawStarting) {
    return;
  }

  openclawStarting = true;
  const spawnGateway = () => {
    openclawStarting = false;
    console.log("Starting OpenClaw gateway...");
    const child = spawn(
      "openclaw",
      ["gateway", "--port", OPENCLAW_PORT.toString()],
      {
        stdio: "inherit",
        env: cfg.buildChildEnv(),
      },
    );
    openclawProcess = child;
    gatewayHealth.spawned();

    child.on("exit", (code, signal) => {
      console.log(`OpenClaw exited with code ${code}${signal ? ` (${signal})` : ""}`);
      gatewayHealth.exited(code, signal);
      openclawProcess = null;
    });

    // A spawn that fails (ENOENT, EACCES, EAGAIN under a pids limit) emits 'error' and never
    // 'exit'. Without this the handle stayed set, nothing restarted the gateway, and the
    // healthcheck saw a run that never ended. Only a child with no pid failed to spawn: 'error'
    // also reports a failed kill() on a gateway that is still running.
    child.on("error", (err) => {
      console.error("OpenClaw gateway error:", err.message);
      if (child.pid === undefined && openclawProcess === child) {
        gatewayHealth.exited(null, null);
        openclawProcess = null;
      }
    });
  };

  const startAfterReconcile = () =>
    Promise.resolve(cfg.reconcileConfig()).catch((error) => {
      console.error(
        "Failed to reconcile OpenClaw config:",
        error instanceof Error ? error.message : String(error),
      );
    });

  if (!repair) {
    // Fresh onboarding just wrote this config, so avoid a full repair/migration
    // pass before the first gateway start. We still run doctor on normal
    // already-configured container starts where upgrade or stale-state repairs
    // are plausible.
    console.log("Skipping openclaw doctor after fresh onboarding");
    startAfterReconcile().finally(spawnGateway);
    return;
  }

  // .finally() ensures the gateway starts even if doctor fails or rejects —
  // a degraded gateway is better than no gateway.
  //
  // Reconcile runs FIRST, and on a fresh data dir it creates openclaw.json from the Hub
  // handout rather than skipping. Doctor must never be handed an empty dir: it writes a
  // minimal config with no models section and the gateway comes up unconfigured on it
  // (core-2 and beta-max, 2026-09-17). Doctor then validates the file we wrote, and
  // warnIfConfigClobbered reports it if doctor had to quarantine it.
  console.log("Running openclaw doctor before gateway start...");
  startAfterReconcile()
    .finally(() => runDoctor().finally(spawnGateway));
}

// Read static files at startup
const SETUP_HTML = fs.readFileSync(path.join(__dirname, "setup.html"), "utf8");
const LOGO = fs.readFileSync(path.join(__dirname, "logo.webp"));
// Companion Memory logo, shown next to the app logo on the connect interstitial
// (served at MEMORY_LOGO_PATH). Read once, guarded: a missing asset degrades the
// interstitial to just the app logo rather than crashing the wrapper on boot.
let MEMORY_LOGO = null;
try {
  MEMORY_LOGO = fs.readFileSync(path.join(__dirname, "assets", "ci-memory-logo.webp"));
} catch (err) {
  console.warn(`[ci-memory] ci-memory-logo.webp missing, interstitial will omit it: ${err.message}`);
}
// Loading page shown while the gateway is starting up. Keep the refresh in JS:
// Chrome skips meta-refresh when the URL contains a hash fragment, and our
// token redirect lands at /?ci_auth=...#token=....
const LOADING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#0D0D0D">
<meta name="color-scheme" content="dark">
<title>Starting OpenClaw...</title>
<style>
html,body{margin:0;min-height:100%;background:#0D0D0D;color:#F0EDE8}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:max(24px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));overflow:hidden}
.shell{width:min(100%,420px)}
.card{background:linear-gradient(180deg,rgba(31,31,31,.96),rgba(20,20,20,.98));border:1px solid #2A2A2A;border-radius:20px;padding:24px 20px;box-shadow:0 20px 50px rgba(0,0,0,.45),0 0 0 1px rgba(255,90,45,.06);text-align:center}
.logo{width:72px;height:72px;display:block;margin:0 auto 18px;object-fit:contain}
h1{margin:0 0 10px;font-size:clamp(24px,5vw,30px);line-height:1.15}
p{margin:0;color:#A89F99;font-size:15px;line-height:1.6}
.status{margin-top:20px;display:inline-flex;align-items:center;gap:10px;padding:10px 14px;border-radius:999px;background:#141414;border:1px solid #2A2A2A;color:#D4D0CB;font-size:14px}
.spinner{width:16px;height:16px;border:2px solid rgba(240,237,232,.18);border-top-color:#FF5A2D;border-radius:999px;animation:spin .85s linear infinite}
.progress{margin-top:18px;height:6px;border-radius:999px;background:#141414;overflow:hidden;border:1px solid #252525}
.progress::before{content:"";display:block;width:42%;height:100%;border-radius:999px;background:linear-gradient(90deg,#FF5A2D,#FF8A65);animation:slide 1.4s ease-in-out infinite}
.hint{margin-top:14px;font-size:12px;color:#6B6460}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes slide{0%{transform:translateX(-120%)}60%{transform:translateX(170%)}100%{transform:translateX(170%)}}
@media (max-width:480px){.card{padding:22px 16px;border-radius:18px}.logo{width:64px;height:64px;margin-bottom:16px}p{font-size:14px}.status{width:100%;justify-content:center;box-sizing:border-box}}
</style>
</head>
<body>
<div class="shell">
<div class="card">
<img class="logo" src="/logo.webp" alt="OpenClaw">
<h1>Starting OpenClaw</h1>
<p>Please wait while the gateway finishes booting. You’ll be redirected automatically as soon as it’s ready.</p>
<div class="status"><span class="spinner"></span><span>Checking availability…</span></div>
<div class="progress"></div>
<div class="hint">This usually only takes a moment.</div>
</div>
</div>
<script>setTimeout(function(){location.reload()},2500)</script>
</body>
</html>`;

function proxyToOpenclaw(req, res) {
  const token = cfg.getGatewayToken();

  // Redirect root to /?ci_auth=<tag>#token=… so the Control UI can authenticate,
  // keeping the rest of the query (Memory's "Chat in OpenClaw" prompt arrives there).
  // The token goes only in the hash, which the Control UI reads and the browser
  // never sends on; the tag in the query stops the redirect loop (see
  // gatewayRootRedirect in proxy-headers.cjs). If setup generated or repaired a
  // token while the browser still has an older dashboard URL, the tag no longer
  // matches and the hash is resynced. A stale token there causes WebSocket auth
  // failures even though the proxy injects the current Bearer token. The Location
  // carries the token, so nothing between here and the browser may cache it.
  const rootRedirect = gatewayRootRedirect(req.url, token);
  if (rootRedirect) {
    res.writeHead(302, { Location: rootRedirect, "Cache-Control": "no-store" });
    res.end();
    return;
  }

  // Rewrite headers so the gateway sees the request as local, and attach the gateway token
  // everywhere EXCEPT OpenClaw's hook routes — which carry their own auth, and which a
  // gateway token would silently shadow. The rules, and why, live in proxy-headers.cjs,
  // where they can be tested; this file cannot be required from a test.
  const gatewayHost = `127.0.0.1:${OPENCLAW_PORT}`;
  const headers = buildGatewayHeaders({
    reqHeaders: req.headers,
    url: req.url,
    gatewayHost,
    token,
  });

  const options = {
    hostname: "127.0.0.1",
    port: OPENCLAW_PORT,
    path: req.url,
    method: req.method,
    headers: headers,
  };

  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxy.on("error", () => {
    // OpenClaw not ready yet, show loading page
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
    });
    res.end(LOADING_HTML);
  });

  req.pipe(proxy);
}

// Handle WebSocket upgrade requests
function handleUpgrade(req, socket, head) {
  const token = cfg.getGatewayToken();

  // Connect to OpenClaw gateway
  const proxySocket = net.connect(OPENCLAW_PORT, "127.0.0.1", () => {
    // Rebuild the upgrade request with auth header
    let requestLine = `${req.method} ${req.url} HTTP/1.1\r\n`;

    // Same header rewrite as the HTTP proxy — through the shared builder, so the strip-list and
    // the /hooks token exception cannot drift between the two paths (they did once). A WS upgrade
    // never targets /hooks, so the exception is a no-op here; sharing it keeps the invariant in
    // one place regardless.
    const gatewayHost = `127.0.0.1:${OPENCLAW_PORT}`;
    const headers = buildGatewayHeaders({
      reqHeaders: req.headers,
      url: req.url,
      gatewayHost,
      token,
    });

    let headerLines = "";
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        value.forEach((v) => (headerLines += `${key}: ${v}\r\n`));
      } else {
        headerLines += `${key}: ${value}\r\n`;
      }
    }

    // Send the upgrade request to OpenClaw
    proxySocket.write(requestLine + headerLines + "\r\n");
    if (head && head.length) {
      proxySocket.write(head);
    }

    // Pipe data between client and OpenClaw
    socket.pipe(proxySocket);
    proxySocket.pipe(socket);
  });

  proxySocket.on("error", (err) => {
    console.error("WebSocket proxy error:", err.message);
    socket.end();
  });

  socket.on("error", (err) => {
    console.error("Client socket error:", err.message);
    proxySocket.end();
  });

  socket.on("close", () => {
    proxySocket.end();
  });

  proxySocket.on("close", () => {
    socket.end();
  });
}

// ── Companion Memory connect interstitial ───────────────────────────────────
// Shown before the app UI when memory is not yet connected, so the user can
// connect (or dismiss) rather than silently running without long-term memory.
// The Hub owns the OAuth-style flow; this wrapper only renders the gate and
// relays the "skip"/"defer" choices. Paths are namespaced under /__ci_memory/.
const MEMORY_DEFER_COOKIE = "ci_memory_deferred";
// Grace window (seconds) for the "Maybe later" (defer) choice. Long enough to
// carry the post-dismiss redirect, short enough that the next fresh launch/reload
// re-prompts. Deliberately NOT a session cookie — that survived tab-close +
// relaunch, making "defer" feel as permanent as "Don't ask again".
const MEMORY_DEFER_GRACE_SECONDS = 30;
const MEMORY_DEFER_PATH = "/__ci_memory/defer";
const MEMORY_SKIP_PATH = "/__ci_memory/skip";
const MEMORY_LOGO_PATH = "/__ci_memory/ci-memory-logo.webp";

/** The Hub's internal base URL (reachable from this container on the app network). */
function hubInternalBase(env) {
  return (env.CI_HUB_URL || env.HUB_URL || "").trim().replace(/\/+$/, "");
}

/** Auth header for wrapper->Hub memory-connect calls: this app's own managed key. */
function mcpAuthHeaders(env) {
  const key = (env.HUB_MCP_API_KEY || "").trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** Whether the request carries the short-lived "deferred" cookie (grace window). */
function hasMemoryDeferCookie(req) {
  const cookie = req.headers.cookie || "";
  return cookie.split(";").some((c) => c.trim().startsWith(`${MEMORY_DEFER_COOKIE}=`));
}

/**
 * Read a small urlencoded request body (bounded), resolving to parsed params.
 * The memory-gate action token travels in the POST body (not the URL), so a
 * cross-site page still cannot forge it (same-origin policy) while it no longer
 * leaks through request logs / Referer / history.
 */
function readFormBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(new URLSearchParams(value));
      }
    };
    req.on("data", (chunk) => {
      if (done) return;
      data += chunk;
      // Over the (generous) cap → treat as no token. Stop accumulating (via the
      // `done` guard) but do NOT destroy the socket here, so the awaiting handler
      // still delivers its 403 on a live connection.
      if (data.length > limit) {
        finish("");
      }
    });
    req.on("end", () => finish(data));
    req.on("error", () => finish(""));
    // Resolve on close/abort too, so a client that stalls without a clean
    // end/error can never leave this promise (and the awaiting handler) pending.
    req.on("close", () => finish(""));
  });
}

/** Escape a value for safe interpolation into an HTML attribute. */
function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Minimal, self-contained interstitial page. Matches the Companion Memory
 * (CI-Import-Tools) sign-in aesthetic: navy background, elevated card, the
 * app's own logo paired with the Companion Memory logo ("app -> memory"), and a
 * teal brand-gradient pill. The app logo is served at /logo.webp and the memory
 * logo at MEMORY_LOGO_PATH. Colors mirror the import-tools dark theme tokens
 * (with a light-scheme fallback).
 */
function renderMemoryGateHtml(connectUrl) {
  // Connector + Companion Memory mark, appended after the app logo. Omitted
  // entirely (no dangling arrow) when the mark asset is unavailable.
  const cmGlyph = MEMORY_LOGO
    ? `<svg class="link" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="12" x2="18" y2="12" /><polyline points="12 6 18 12 12 18" /></svg><img class="cm" src="${MEMORY_LOGO_PATH}" alt="Companion Memory" />`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect to Companion Memory</title>
<style>
  :root{color-scheme:dark;--bg:#041620;--card:#0a222e;--border:#1f4a55;--fg:#f5f8fa;--fg-dim:#9bb2b7;--brand-grad:linear-gradient(135deg,#0b6e74 0%,#079d99 100%);--on-accent:#fff;--shadow:0 6px 24px rgba(4,22,32,.22)}
  @media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f3f3f3;--card:#f7f7f9;--border:#d3dddf;--fg:#010f16;--fg-dim:#4f6168;--shadow:0 6px 24px rgba(4,22,32,.12)}}
  *{box-sizing:border-box}
  body{font-family:"Montserrat",system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);padding:40px 20px}
  .card{width:100%;max-width:420px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:36px 28px;box-shadow:var(--shadow)}
  .brand{display:flex;align-items:center;justify-content:center;gap:14px;margin:0 auto 22px}
  .applogo{width:56px;height:56px;object-fit:contain;background:#fff;border-radius:14px;padding:8px;box-shadow:0 2px 10px rgba(0,0,0,.28)}
  .brand .link{color:var(--fg-dim);display:flex;align-items:center}
  .cm{width:56px;height:56px;object-fit:contain;border-radius:14px;background:#000;box-shadow:0 2px 10px rgba(0,0,0,.28)}
  h1{font-size:20px;font-weight:700;margin:0 0 8px}
  p{line-height:1.5;color:var(--fg-dim);font-size:14px;margin:0 0 22px}
  .actions{display:flex;flex-direction:column;gap:10px}
  .actions form{margin:0}
  .btn{display:block;width:100%;padding:11px 20px;border-radius:999px;border:0;font-size:15px;font-weight:600;line-height:1.2;cursor:pointer;text-align:center;text-decoration:none;font-family:inherit}
  .primary{background:var(--brand-grad);color:var(--on-accent)}
  .primary:hover{filter:brightness(1.06)}
  .secondary{background:transparent;color:var(--fg-dim);border:1px solid var(--border)}
  .secondary:hover{color:var(--fg);border-color:var(--fg-dim)}
</style></head>
<body><main class="card">
  <div class="brand">
    <img class="applogo" src="/logo.webp" alt="OpenClaw" />${cmGlyph}
  </div>
  <h1>Give OpenClaw long-term memory</h1>
  <p>Connect to your Companion Memory so OpenClaw remembers your context across
     sessions. You'll sign in with Companion Intelligence and approve access; you
     can disconnect any time.</p>
  <div class="actions">
    <a class="btn primary" href="${escapeHtmlAttr(connectUrl)}">Sign in with Companion Intelligence</a>
    <form method="POST" action="${MEMORY_DEFER_PATH}"><input type="hidden" name="t" value="${MEMORY_ACTION_TOKEN}" /><button class="btn secondary" type="submit">Maybe later</button></form>
    <form method="POST" action="${MEMORY_SKIP_PATH}"><input type="hidden" name="t" value="${MEMORY_ACTION_TOKEN}" /><button class="btn secondary" type="submit">Don't ask again</button></form>
  </div>
</main></body></html>`;
}

/**
 * If memory is not yet connected and the user hasn't dismissed the prompt,
 * serve the connect interstitial and return true. Only gates the top-level HTML
 * page load; fails open (returns false → proxy through) on any uncertainty so a
 * Hub hiccup never blocks the app.
 */
async function maybeServeMemoryGate(req, res) {
  if (req.method !== "GET") return false;
  const pathname = (req.url || "/").split("?")[0];
  // Gate EVERY top-level HTML navigation, regardless of which SPA route the user
  // opens or refreshes (/, /chat, …) — not just the root — so a disconnected app
  // re-prompts everywhere. Never gate the wrapper's own /__ci_memory/* paths
  // (defer/skip/logo), nor non-navigation requests: API/XHR, static assets, and
  // WebSocket upgrades don't carry `Sec-Fetch-Dest: document` (and don't Accept
  // text/html on older browsers), so returning the interstitial HTML for them
  // would break the app.
  if (pathname.startsWith("/__ci_memory")) return false;
  const secFetchDest = String(req.headers["sec-fetch-dest"] || "");
  const isNavigation = secFetchDest ? secFetchDest === "document" : String(req.headers.accept || "").includes("text/html");
  if (!isNavigation) return false;

  // Resolve creds exactly as the spawned gateway does: .env is the base, and only
  // NON-EMPTY Hub-authoritative container vars override it. A plain
  // `{ ...readEnv(), ...process.env }` merge would let an unsubstituted compose
  // `${CI_SERVER_TOKEN}` (resolved to "") blank a real .env token and wrongly
  // re-show the interstitial to an already-configured app.
  const env = cfg.buildChildEnv();
  if (hasMemoryDeferCookie(req)) return false; // dismissed for this session

  const appUrn = (env.CI_APP_URN || "").trim();
  const hubBase = hubInternalBase(env);
  if (!appUrn || !hubBase) return false; // can't resolve — fail open

  try {
    // `clientHost` tells the Hub where the BROWSER is. This request is
    // server-to-server over the internal network, so the Hub would otherwise see
    // its own container hostname and could never tell a LAN visitor from a remote
    // one — which is what decides whether the LAN launcher is usable.
    //
    // Forward Traefik's signed Hub identity so a second family member is not
    // treated as already-connected just because the container still holds
    // someone else's CI_SERVER_TOKEN.
    const stateUrl = memoryGate.buildStateUrl(hubBase, appUrn, req.headers.host);

    const resp = await fetch(stateUrl, {
      headers: { ...mcpAuthHeaders(env), ...memoryGate.forwardAuthHeaders(req) },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return false;
    const { state, connectUrl, connectUrlLocal, reason } = await resp.json();
    // Only prompt when the user hasn't decided yet; skipped/manual/connected pass through.
    if (!memoryGate.shouldPromptForState(state)) return false;
    // Only ever link to an http(s) Hub URL — never a javascript:/data: scheme.
    // Public route first; the LAN launcher is the fallback the Hub supplies when
    // its public origin is down and this browser is on the local network.
    const safeConnectUrl = memoryGate.selectLauncher({ connectUrl, connectUrlLocal });
    if (!safeConnectUrl) {
      // Fail open, but not fail silent: a gate that vanishes reads as "memory is
      // connected". The Hub's app-detail badge still shows the app as
      // disconnected; this line is what makes the reason diagnosable here.
      console.warn(`[ci-memory] connect gate suppressed (${reason || "no launcher available"}); letting the user through`);
      return false;
    }

    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
      // Anti-clickjacking: the gate has consent-suppression buttons (skip/defer),
      // so it must never be framed (matches the CI-Server consent page).
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
    });
    res.end(renderMemoryGateHtml(memoryGate.launcherWithNext(safeConnectUrl, memoryGate.requestAbsoluteUrl(req))));
    return true;
  } catch {
    return false; // Hub unreachable → fail open
  }
}

/** Handle the interstitial's local defer/skip actions. Returns true if handled. */
async function handleMemoryAction(req, res) {
  const pathname = (req.url || "/").split("?")[0];
  if (pathname !== MEMORY_DEFER_PATH && pathname !== MEMORY_SKIP_PATH) return false;

  // POST-only + anti-CSWSH token carried in the body (byte-safe compare).
  const body = req.method === "POST" ? await readFormBody(req) : new URLSearchParams();
  if (req.method !== "POST" || !tokensMatch(body.get("t"), MEMORY_ACTION_TOKEN)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return true;
  }

  if (pathname === MEMORY_DEFER_PATH) {
    // Session cookie — reappears next browser session, per the "deferred" design.
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": `${MEMORY_DEFER_COOKIE}=1; Path=/; Max-Age=${MEMORY_DEFER_GRACE_SECONDS}; HttpOnly; SameSite=Lax`,
    });
    res.end();
    return true;
  }

  // Skip forever — relay to the Hub (only this container can reach it internally).
  const env = cfg.buildChildEnv();
  const appUrn = (env.CI_APP_URN || "").trim();
  const hubBase = hubInternalBase(env);
  if (appUrn && hubBase) {
    try {
      await fetch(`${hubBase}/api/memory-connect/apps/${encodeURIComponent(appUrn)}/skip`, {
        method: "POST",
        headers: mcpAuthHeaders(env),
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      // best-effort; the gate simply reappears if this didn't land
    }
  }
  res.writeHead(302, { Location: "/" });
  res.end();
  return true;
}

// ── Error-reporting consent ────────────────────────────────────────────────
// Reports whether THIS process is reporting errors and, if not, why — so the
// CI_TELEMETRY / CI_LOCAL_ONLY kill switches (and the marketplace "Share crash
// reports" toggle that sets them) are observable without shelling into the
// container. Unauthenticated by design: it exposes no secret — never the DSN —
// and when reporting is off there is nothing to expose at all.
//
// Namespaced under /__ci_* like the memory gate rather than sitting at the
// fleet-standard /api/config/telemetry, because everything this wrapper does not
// claim is proxied straight to OpenClaw: a wrapper-owned path under /api/ would
// silently shadow an upstream route the moment the weekly openclaw bump adds
// one. See docs/operations/error-reporting.md.
const TELEMETRY_CONFIG_PATH = "/__ci_telemetry/config";

const server = http.createServer(async (req, res) => {
  if ((req.url || "").split("?")[0] === TELEMETRY_CONFIG_PATH) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(telemetry.getTelemetryStatus()));
    return;
  }

  // The HEALTHCHECK's question. Answered before the setup redirect and the memory gate, and
  // unlike the requests below it never calls startOpenclaw() (see gateway-health.cjs).
  if (
    handleGatewayHealthRequest(req, res, () =>
      gatewayHealth.describe({
        configured: gatewayWanted,
        onboarding: Boolean(ptyProcess),
        starting: openclawStarting,
      }),
    )
  ) {
    return;
  }

  // Serve static assets for setup UI
  if (req.url === "/logo.webp") {
    res.writeHead(200, {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(LOGO);
    return;
  }

  // Companion Memory logo for the connect interstitial (served from assets/).
  if (MEMORY_LOGO && req.url === MEMORY_LOGO_PATH) {
    res.writeHead(200, {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(MEMORY_LOGO);
    return;
  }

  if (!cfg.isConfigured()) {
    if (req.url !== "/") {
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(SETUP_HTML.replace("__SETUP_TOKEN__", SETUP_TOKEN));
    return;
  }

  if (ptyProcess) {
    // OpenClaw writes config before QuickStart fully exits. Keep the browser on
    // the terminal until onboarding is done so the gateway never starts against
    // config/auth files that OpenClaw may still rewrite.
    if (req.url !== "/") {
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(SETUP_HTML.replace("__SETUP_TOKEN__", SETUP_TOKEN));
    return;
  }

  // Companion Memory connect interstitial (post-onboarding, pre-app). Handle its
  // local defer/skip actions first, then offer the gate on the top-level load.
  if (await handleMemoryAction(req, res)) {
    return;
  }
  if (await maybeServeMemoryGate(req, res)) {
    return;
  }

  // If configured but OpenClaw not running, start it
  if (!openclawProcess) {
    startOpenclaw();
  }

  // Proxy to OpenClaw
  proxyToOpenclaw(req, res);
});

// WebSocket server for the interactive terminal
const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (ws) => {
  console.log("Terminal WebSocket connected");

  // Only one setup session at a time — kill any existing PTY (e.g. stale tab).
  // Each handler below keeps its own setupPty reference so a delayed close from
  // an old browser session cannot accidentally kill the newly active session.
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch (e) {}
    ptyProcess = null;
  }

  // Spawn openclaw onboard with flags that skip everything except provider/API key selection.
  // The CLI does NOT generate a gateway token — reconcileConfig() generates one and
  // syncs it to .env when startOpenclaw() runs after setup.
  cfg.ensureConfigDir();
  ensureShellCompletionBypass();
  const setupPty = pty.spawn(
    "openclaw",
    [
      "onboard",
      "--flow",
      "quickstart",
      "--accept-risk",
      "--skip-channels",
      "--skip-skills",
      "--skip-search",
      "--skip-daemon",
      "--skip-ui",
      "--skip-health",
      "--mode",
      "local",
      "--gateway-port",
      OPENCLAW_PORT.toString(),
    ],
    {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: CONFIG_DIR,
      env: {
        ...cfg.buildChildEnv(),
        SHELL: "/bin/bash",
        TERM: "xterm-256color",
      },
    },
  );
  ptyProcess = setupPty;

  // PTY output -> WebSocket
  setupPty.onData((data) => {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    } catch (e) {
      console.error("Error sending PTY output:", e.message);
    }
  });

  // PTY exit -> notify client
  setupPty.onExit(({ exitCode }) => {
    console.log(`openclaw onboard exited with code ${exitCode}`);
    const wasActiveSession = ptyProcess === setupPty;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      }
    } catch (e) {
      console.error("Error sending exit message:", e.message);
    }
    if (wasActiveSession) {
      ptyProcess = null;
    }

    if (
      wasActiveSession &&
      exitCode === 0 &&
      cfg.isConfigured() &&
      !openclawProcess
    ) {
      console.log("OpenClaw onboarding completed, starting gateway...");
      startOpenclaw({ repair: false });
    }
  });

  // WebSocket input -> PTY
  ws.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (ptyProcess !== setupPty) {
        return;
      }
      if (parsed.type === "input") {
        setupPty.write(parsed.data);
      } else if (parsed.type === "resize") {
        setupPty.resize(parsed.cols, parsed.rows);
      }
    } catch (e) {
      console.error("Error processing terminal input:", e.message);
    }
  });

  ws.on("close", () => {
    console.log("Terminal WebSocket closed");
    if (ptyProcess === setupPty) {
      try {
        setupPty.kill();
      } catch (e) {}
      ptyProcess = null;
    }
  });
});

// Handle WebSocket upgrades
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Route /api/terminal to the PTY WebSocket server
    if (url.pathname === "/api/terminal") {
      // Validate anti-CSWSH token with a byte-safe compare: a multi-byte `token`
      // must reject cleanly rather than make crypto.timingSafeEqual throw a
      // RangeError (which, uncaught here, would crash the wrapper).
      const provided = url.searchParams.get("token") || "";
      if (!tokensMatch(provided, SETUP_TOKEN)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }

    if (!cfg.isConfigured()) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }

    if (ptyProcess) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }

    if (!openclawProcess) {
      startOpenclaw();
    }

    handleUpgrade(req, socket, head);
  } catch (err) {
    // Defense in depth: never let an upgrade-handler throw escape as an uncaught
    // exception (which would crash the wrapper). Reject the socket and move on.
    console.error("[ci-memory] upgrade handler error:", err && err.message ? err.message : err);
    telemetry.captureException(err);
    try {
      socket.destroy();
    } catch {
      /* socket already gone */
    }
  }
});

// Initialize home directory from skeleton
initializeHome();

cfg.ensureConfigDir();

// Check if already configured
if (cfg.isConfigured()) {
  console.log("OpenClaw is configured, starting gateway...");
  startOpenclaw();
} else {
  console.log("OpenClaw not configured, showing setup UI...");
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Setup server listening on port ${PORT}`);
});

// Last-resort backstop: keep a stray throw/rejection (e.g. from an event
// handler outside a request's try/catch) from hard-crashing the wrapper and
// dropping the whole app. Log and keep serving.
//
// The Sentry capture is deliberately additive: telemetry.cjs drops the SDK's own
// OnUncaughtException/OnUnhandledRejection integrations, which can terminate the
// process, so reporting cannot change the fact that the wrapper survives here.
// With no DSN both calls are no-ops on an uninitialised module.
process.on("uncaughtException", (err) => {
  console.error("[ci-memory] uncaughtException:", err && err.stack ? err.stack : err);
  telemetry.captureException(err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[ci-memory] unhandledRejection:", reason);
  telemetry.captureException(
    reason instanceof Error ? reason : new Error(String(reason ?? "Unknown unhandled rejection")),
  );
});

// Graceful shutdown: Docker sends SIGTERM on stop/restart/update.
// Without this, child processes (gateway, PTY) may get hard-killed
// mid-write and corrupt config or state files.
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch (e) {}
  }
  if (openclawProcess) {
    openclawProcess.kill("SIGTERM");
  }
  server.close();
  // Ship anything still buffered, bounded to 2s and unref'd. Returns an already
  // resolved promise when reporting is off, so with no DSN the shutdown path is
  // exactly what it was — telemetry can never delay a container stop.
  void telemetry.flushTelemetry(2000);
});
