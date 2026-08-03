/**
 * Opt-out error reporting (Sentry) for the CI-OpenClaw wrapper.
 *
 * Reporting is **opt-out** — on wherever a DSN is configured, and the user turns
 * it off. With no `SENTRY_DSN` nothing is initialised, `@sentry/node` is never
 * even required, and the process makes no outbound connection: that is the
 * absence of configuration, not a privacy setting. Two kill switches disable it
 * even when a DSN has been baked into an image or injected by the Hub, so an
 * operator can always turn it off without a rebuild:
 *
 *   - `CI_TELEMETRY=off`   — explicit opt-out
 *   - `CI_LOCAL_ONLY=true` — local-only mode must mean zero phone-home
 *
 * Precedence: local-only > opt-out > no-dsn.
 *
 * This module has **no side effects on require** and no module-scope dependency
 * on the SDK — the same reason config-reconcile.cjs and proxy-headers.cjs are
 * separate files. server.cjs cannot be unit-tested (it binds a port and requires
 * node-pty by absolute container path), and ci.yml deliberately runs the suites
 * with NO `npm ci`, so every rule below has to be reachable from a test without
 * installing anything. `@sentry/node` is required lazily inside initTelemetry().
 *
 * The contract, the scrubber rules and the reference implementation are
 * CI-Server's `backend/apps/api/src/common/telemetry/`. Deviations specific to
 * this app are called out inline and in docs/operations/error-reporting.md.
 */

"use strict";

/** Sentry `component` tag. The wrapper is what is instrumented — OpenClaw itself
 * is an upstream binary in its own process and reports nothing. */
const COMPONENT = "ci-openclaw-wrapper";

// ── The telemetry gate ──────────────────────────────────────────────────────

const FALSEY = new Set(["off", "false", "0", "no", "disabled"]);
const TRUTHY = new Set(["on", "true", "1", "yes", "enabled"]);

function read(env, key) {
  const value = env && typeof env[key] === "string" ? env[key].trim() : "";
  return value ? value : null;
}

/** `CI_TELEMETRY=off` (any falsey spelling) opts out; anything else leaves the DSN in charge. */
function isTelemetryOptedOut(env) {
  const value = read(env, "CI_TELEMETRY");
  return value !== null && FALSEY.has(value.toLowerCase());
}

/** Local-only mode forbids all egress, telemetry included. */
function isLocalOnly(env) {
  const value = read(env, "CI_LOCAL_ONLY");
  return value !== null && TRUTHY.has(value.toLowerCase());
}

/**
 * Resolve the effective reporting settings from the environment.
 *
 * Order matters: report the *operator's* explicit choice ahead of "no DSN" so
 * the startup log says why reporting is off.
 */
function resolveTelemetrySettings(env, component = COMPONENT) {
  const dsn = read(env, "SENTRY_DSN");
  const deploymentVersion = read(env, "CI_OPENCLAW_VERSION") || read(env, "APP_VERSION");

  const base = {
    dsn,
    component,
    deploymentVersion,
    environment:
      read(env, "SENTRY_ENV") || read(env, "CI_ENVIRONMENT") || read(env, "NODE_ENV") || "development",
    release:
      read(env, "SENTRY_RELEASE") ||
      (deploymentVersion ? `${component}@${deploymentVersion}` : undefined),
  };

  if (isLocalOnly(env)) {
    return Object.assign({}, base, { enabled: false, disabledReason: "local-only" });
  }
  if (isTelemetryOptedOut(env)) {
    return Object.assign({}, base, { enabled: false, disabledReason: "opt-out" });
  }
  if (!dsn) {
    return Object.assign({}, base, { enabled: false, disabledReason: "no-dsn" });
  }

  return Object.assign({}, base, { enabled: true, disabledReason: null });
}

// ── The scrubber ────────────────────────────────────────────────────────────

/**
 * Labelled secrets. `api[-_ ]?key` (not the literals `apikey|api_key`) so the
 * hyphenated header form matches too — the SDK ships request headers even with
 * `sendDefaultPii: false`.
 *
 * `app[-_ ]?seed` is this app's own addition: APP_SEED is the per-install secret
 * that gates the setup terminal, and that terminal is an RCE primitive.
 */
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:api[-_ ]?key|app[-_ ]?seed|token|password|secret|jwt|auth)[\s=:"']+[^\s"',}\]]+/gi,
  /tskey-[A-Za-z0-9-]+/gi,
  // Postgres/Redis/AMQP URLs carry credentials in the authority section.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
];

/**
 * **Bare** provider API keys — an addition over the CI-Server reference, and the
 * rule this app most needs.
 *
 * The whole job of the setup UI is collecting these: the user types a provider
 * key into a PTY running `openclaw onboard`, and `openclaw doctor` failures
 * surface config contents through `execAsync`'s error message. In neither case
 * is there an `api_key=` label in front of the value for the rule above to
 * anchor on, so the key would travel as an ordinary-looking word.
 */
const BARE_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic (sk-ant-…), OpenRouter, most OpenAI-compatible
  /\bAIza[A-Za-z0-9_-]{20,}/g, // Google / Gemini
  /\bgsk_[A-Za-z0-9]{20,}/g, // Groq
  /\bxai-[A-Za-z0-9]{16,}/g, // xAI
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained
];

/**
 * Home directories leak the account name. Windows patterns FIRST: the macOS one
 * also matches the `/Users/<name>` inside `C:/Users/<name>`, and replacing that
 * leaves a stranded `C:~/…` with the drive letter still attached. Longest-prefix
 * forms have to win.
 */
const HOME_PATH_PATTERNS = [
  /[A-Za-z]:\\Users\\[^\\/\s]+/g, // Windows (backslash)
  /[A-Za-z]:\/Users\/[^/\s]+/g, // Windows (forward-slash)
  /\/Users\/[^/\s]+/g, // macOS
  /\/home\/[^/\s]+/g, // Linux
];

/**
 * Object/header keys whose *value* is filtered outright.
 *
 * `hub[-_]user` is load-bearing here: CI-OpenClaw sits behind the Hub's Traefik
 * forward-auth, which stamps `X-CI-Hub-User` (plus `-Timestamp` / `-Signature`)
 * onto every proxied request. The value is the household username — an ordinary
 * word that no secret pattern would ever match, so this key rule is the only
 * thing standing between it and Sentry.
 */
const SENSITIVE_KEY_PATTERN =
  /password|secret|token|authorization|cookie|jwt|api[-_ ]?key|dsn|pepper|private[-_]?key|hub[-_]user|app[-_ ]?seed/i;

/** Headers whose value is a URL the user navigated from — same query-string
 * exposure as request.url, and not caught by SENSITIVE_KEY_PATTERN. */
const URL_VALUED_HEADERS = ["referer", "referrer", "location"];

/**
 * Breadcrumb `data` keys whose value is a URL.
 *
 * The Node SDK's Http/NodeFetch integrations record an outgoing-request crumb
 * carrying `data.url` **with the query string**. This wrapper is a proxy: every
 * browser request is replayed to 127.0.0.1 including `/?token=<gateway token>`,
 * and the memory gate calls the Hub with the app URN in the query. Scrubbing
 * only `request.url` would leave all of that in the crumbs.
 */
const URL_VALUED_KEYS = new Set(["url", "from", "to"]);

const MAX_STRING_LENGTH = 8000;

/**
 * Strip query and hash. Deliberately a plain split rather than `new URL()`: it
 * leaves origin and path exactly as written and cannot throw.
 */
function scrubUrl(url) {
  return String(url).split(/[?#]/)[0];
}

function scrubString(value) {
  let scrubbed = String(value);

  for (const pattern of HOME_PATH_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "~");
  }
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[Filtered]");
  }
  for (const pattern of BARE_SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[Filtered]");
  }

  if (scrubbed.length > MAX_STRING_LENGTH) {
    return `${scrubbed.slice(0, MAX_STRING_LENGTH)}… [truncated]`;
  }
  return scrubbed;
}

function scrubValue(value, depth = 0) {
  // Guard against cyclic/deep structures — a runaway walk in beforeSend would
  // stall the reporting path on every captured error.
  if (depth > 8) {
    return "[Truncated]";
  }
  if (typeof value === "string") {
    return scrubString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[Filtered]" : scrubValue(nested, depth + 1);
    }
    return result;
  }
  return value;
}

/** Scrub one breadcrumb in place. */
function scrubBreadcrumb(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== "object") return;

  if (typeof breadcrumb.message === "string") {
    breadcrumb.message = scrubString(breadcrumb.message);
  }
  if (!breadcrumb.data || typeof breadcrumb.data !== "object") return;

  for (const [key, value] of Object.entries(breadcrumb.data)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      breadcrumb.data[key] = "[Filtered]";
    } else if (typeof value === "string" && URL_VALUED_KEYS.has(key)) {
      breadcrumb.data[key] = scrubUrl(scrubString(value));
    } else {
      breadcrumb.data[key] = scrubValue(value);
    }
  }
}

/**
 * `beforeSend` payload scrubber. Everything on its way to Sentry is treated as
 * hostile until proven otherwise.
 */
function scrubEvent(event) {
  if (!event || typeof event !== "object") return event;

  if (event.message) {
    event.message = scrubString(event.message);
  }

  // `logentry.message` is only the printf FORMAT string. Scrubbing it alone
  // stamps [Filtered] on the template while shipping the interpolated values.
  if (event.logentry && typeof event.logentry === "object") {
    if (typeof event.logentry.message === "string") {
      event.logentry.message = scrubString(event.logentry.message);
    }
    if (typeof event.logentry.formatted === "string") {
      event.logentry.formatted = scrubString(event.logentry.formatted);
    }
    if (event.logentry.params) {
      event.logentry.params = scrubValue(event.logentry.params);
    }
  }

  if (event.exception && Array.isArray(event.exception.values)) {
    for (const exception of event.exception.values) {
      if (exception && typeof exception.value === "string") {
        exception.value = scrubString(exception.value);
      }

      const frames = (exception && exception.stacktrace && exception.stacktrace.frames) || [];
      for (const frame of frames) {
        // Collapse the home dir only. Sentry GROUPS issues on `filename`, so
        // redacting the body of the path destroys grouping.
        if (typeof frame.filename === "string") {
          frame.filename = scrubString(frame.filename);
        }
        if (typeof frame.abs_path === "string") {
          frame.abs_path = scrubString(frame.abs_path);
        }
        // The ContextLines integration (a Node SDK default) reads the source
        // file off disk and attaches the failing line plus its neighbours. Those
        // are strings like any other and were reaching the envelope unscrubbed —
        // found by the runtime probe, not by review. A source line under
        // /data/.npm-global (the agent installs its own tooling there) is not
        // code we wrote or vetted.
        if (typeof frame.context_line === "string") {
          frame.context_line = scrubString(frame.context_line);
        }
        if (Array.isArray(frame.pre_context)) {
          frame.pre_context = scrubValue(frame.pre_context);
        }
        if (Array.isArray(frame.post_context)) {
          frame.post_context = scrubValue(frame.post_context);
        }
        // Captured locals. Inert unless `includeLocalVariables` is turned on
        // (it is not, see initTelemetry) — but on this wrapper a local is the
        // gateway token, APP_SEED, or a request's Hub identity headers.
        if (frame.vars) {
          frame.vars = scrubValue(frame.vars);
        }
      }
    }
  }

  if (event.extra) {
    event.extra = scrubValue(event.extra);
  }

  // The hostname identifies the household as surely as a home path does.
  // `includeServerName: false` at init stops the SDK setting it; this is the
  // belt-and-braces half.
  delete event.server_name;

  // Nothing user-identifying, ever. The SDK should not populate this with
  // `sendDefaultPii: false`, but the cost of being sure is one line.
  delete event.user;

  // nodeContextIntegration adds `culture: { locale, timezone }` by default. A
  // household appliance's timezone is a coarse location signal and says nothing
  // about a defect.
  if (event.contexts) {
    delete event.contexts.culture;
  }

  if (event.request) {
    // Query strings and bodies carry the user's own content; headers carry the
    // session cookie and the Hub identity headers.
    delete event.request.cookies;
    delete event.request.data;

    if (event.request.query_string) {
      event.request.query_string = "[Filtered]";
    }

    // `request.url` is built from `req.url`, which on a Node server is
    // path+query — byte-identical content to the query_string just filtered.
    // Filtering one without the other redacts nothing. On this app the query is
    // literally `?token=<gateway token>`.
    if (typeof event.request.url === "string") {
      event.request.url = scrubUrl(event.request.url);
    }

    if (event.request.headers) {
      const headers = scrubValue(event.request.headers);
      for (const [key, value] of Object.entries(headers)) {
        if (URL_VALUED_HEADERS.includes(key.toLowerCase()) && typeof value === "string") {
          headers[key] = scrubUrl(value);
        }
      }
      event.request.headers = headers;
    }
  }

  // Node ships a bare array; the `.values` shape is the Python SDK's. Handle
  // both so a change of transport can't quietly bypass this.
  const crumbs = Array.isArray(event.breadcrumbs)
    ? event.breadcrumbs
    : (event.breadcrumbs && event.breadcrumbs.values) || [];
  for (const breadcrumb of crumbs) {
    scrubBreadcrumb(breadcrumb);
  }

  return event;
}

// ── SDK lifecycle ───────────────────────────────────────────────────────────

/**
 * Integrations server.cjs handles itself, or that must not run here.
 *
 * `OnUncaughtException` / `OnUnhandledRejection`: server.cjs registers its own
 * handlers that deliberately **log and keep serving** — the wrapper surviving a
 * stray throw is what keeps the whole app from dropping. The SDK's versions can
 * terminate the process, so leaving them in would let error reporting change
 * crash behaviour, which the contract forbids.
 *
 * `Console`: console breadcrumbs would capture `openclaw doctor` stderr relayed
 * through `execAsync`'s error message — the diagnostic output of the user's own
 * agent, including its config. Not our data to collect. (Deviation from
 * CI-Server, which does not shell out to an agent CLI.)
 *
 * `ProcessSession`: release-health sends a session envelope on every container
 * start even when nothing has gone wrong, and sessions do **not** pass through
 * `beforeSend`. Every other payload this process emits is scrubbed on the way
 * out; a stream that bypasses the scrubber is the one thing the privacy posture
 * cannot vouch for, so reporting stays strictly error-driven.
 */
const DISABLED_INTEGRATIONS = new Set([
  "OnUncaughtException",
  "OnUnhandledRejection",
  "Console",
  "ProcessSession",
]);

/**
 * Drop the integrations above from the SDK defaults.
 *
 * Warns about a name that matched nothing: the filter is by string, so an
 * upstream rename would silently re-enable a behaviour we deliberately removed
 * (the process-exiting crash handlers most of all). Exported so a test can
 * verify the rule without installing the SDK.
 */
function filterIntegrations(defaults, warn = console.warn) {
  const seen = new Set(defaults.map((integration) => integration && integration.name));
  for (const name of DISABLED_INTEGRATIONS) {
    if (!seen.has(name)) {
      warn(
        `[telemetry] integration "${name}" was not in the SDK defaults — it may have been renamed upstream; re-check telemetry.cjs`,
      );
    }
  }
  return defaults.filter((integration) => !DISABLED_INTEGRATIONS.has(integration && integration.name));
}

let sentry = null;
let settings = resolveTelemetrySettings({});

/**
 * Initialise error reporting if the gate allows it. Safe to call more than once
 * and safe to call when reporting is off. Never throws: a telemetry failure must
 * not be able to stop the wrapper from booting.
 *
 * Call this before requiring anything the SDK instruments (http, ws) — it
 * patches Node internals on init and misses whatever was already wired up.
 */
function initTelemetry(env = process.env, log = console) {
  if (sentry) return settings;

  settings = resolveTelemetrySettings(env);

  if (!settings.enabled) {
    log.log(`[telemetry] error reporting disabled (${settings.disabledReason})`);
    return settings;
  }

  let sdk;
  try {
    // Lazy: with no DSN this require never happens, so a DSN-less container
    // does not even load the SDK.
    sdk = require("@sentry/node");
  } catch (err) {
    settings = Object.assign({}, settings, { enabled: false, disabledReason: "sdk-missing" });
    log.warn(`[telemetry] @sentry/node is not installed; error reporting disabled (${err.message})`);
    return settings;
  }

  try {
    sdk.init({
      dsn: settings.dsn,
      environment: settings.environment,
      release: settings.release,
      enabled: true,
      // Error reporting only. Tracing on an appliance that proxies the user's
      // whole agent session would ship request shapes we have no consent for.
      tracesSampleRate: 0,
      profilesSampleRate: 0,
      // No IPs, no cookies, no request bodies.
      sendDefaultPii: false,
      // The machine hostname identifies the household.
      includeServerName: false,
      // Left at its default (false) deliberately: frame locals in this process
      // are gateway tokens, APP_SEED and proxied request headers.
      includeLocalVariables: false,
      integrations: (defaults) => filterIntegrations(defaults, log.warn.bind(log)),
      beforeSend: scrubEvent,
    });

    sdk.setTag("component", settings.component);
    if (settings.deploymentVersion) {
      sdk.setTag("deployment_version", settings.deploymentVersion);
    }

    sentry = sdk;
    log.log(`[telemetry] error reporting enabled (${settings.environment})`);
  } catch (err) {
    settings = Object.assign({}, settings, { enabled: false, disabledReason: "init-failed" });
    log.warn(`[telemetry] Sentry.init failed; error reporting disabled (${err.message})`);
  }

  return settings;
}

/** True when `Sentry.init` actually ran; every capture below is a no-op otherwise. */
function isTelemetryEnabled() {
  return sentry !== null;
}

/** The resolved settings, for the consent endpoint. Never includes the DSN. */
function getTelemetryStatus() {
  return {
    enabled: isTelemetryEnabled(),
    reason: isTelemetryEnabled() ? null : settings.disabledReason,
    environment: settings.environment,
    release: settings.release || null,
    component: settings.component,
  };
}

/** Report an error. Never throws, never blocks, no-op when reporting is off. */
function captureException(error, context) {
  if (!sentry) return;
  try {
    sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(context || {})) {
        if (value !== undefined) scope.setExtra(key, value);
      }
      sentry.captureException(error);
    });
  } catch {
    // Reporting must never be the reason a crash handler fails.
  }
}

/**
 * Flush buffered events, bounded so a wedged network cannot hold shutdown open.
 * Resolves immediately when Sentry was never initialised, so the shutdown path
 * is byte-for-byte unchanged with reporting off.
 *
 * `Sentry.close(timeoutMs)` alone is NOT a real bound: its timeout only limits
 * how long the transport waits, and the promise still resolves on a later event
 * loop turn. Race it against a real timer so the caller's exit path always runs
 * on schedule. The timer is unref'd — it must never be the thing keeping the
 * process alive.
 */
function flushTelemetry(timeoutMs = 2000) {
  if (!sentry) return Promise.resolve();

  return Promise.race([
    Promise.resolve(sentry.close(timeoutMs)).catch(() => undefined),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      if (timer.unref) timer.unref();
    }),
  ]).then(() => undefined);
}

/** Test seam: drop the initialised client so a suite can re-run initTelemetry. */
function resetTelemetryForTests() {
  sentry = null;
  settings = resolveTelemetrySettings({});
}

module.exports = {
  COMPONENT,
  DISABLED_INTEGRATIONS,
  MAX_STRING_LENGTH,
  SENSITIVE_KEY_PATTERN,
  captureException,
  filterIntegrations,
  flushTelemetry,
  getTelemetryStatus,
  initTelemetry,
  isLocalOnly,
  isTelemetryEnabled,
  isTelemetryOptedOut,
  resetTelemetryForTests,
  resolveTelemetrySettings,
  scrubBreadcrumb,
  scrubEvent,
  scrubString,
  scrubUrl,
  scrubValue,
};
