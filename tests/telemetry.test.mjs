import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const telemetry = require("../telemetry.cjs");

const {
  DISABLED_INTEGRATIONS,
  MAX_STRING_LENGTH,
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
} = telemetry;

const DSN = "https://abc123@o1.ingest.us.sentry.io/9999999";

// ---------------------------------------------------------------------------
// The telemetry gate. Reporting is opt-out: a configured DSN means on.
//
// Contract: no DSN -> nothing initialises and no packet leaves the container.
// Two kill switches beat a DSN that was baked into an image or injected by the
// Hub, so reporting can always be turned off without a rebuild, and the
// precedence is local-only > opt-out > no-dsn so the startup log names the
// OPERATOR's choice rather than the incidental absence of a DSN.
// ---------------------------------------------------------------------------

describe("resolveTelemetrySettings", () => {
  test("off with no DSN", () => {
    const settings = resolveTelemetrySettings({});
    assert.equal(settings.enabled, false);
    assert.equal(settings.disabledReason, "no-dsn");
    assert.equal(settings.dsn, null);
  });

  test("on with a DSN", () => {
    const settings = resolveTelemetrySettings({ SENTRY_DSN: DSN });
    assert.equal(settings.enabled, true);
    assert.equal(settings.disabledReason, null);
    assert.equal(settings.dsn, DSN);
  });

  test("a whitespace-only DSN is not a DSN", () => {
    const settings = resolveTelemetrySettings({ SENTRY_DSN: "   " });
    assert.equal(settings.enabled, false);
    assert.equal(settings.disabledReason, "no-dsn");
  });

  test("a DSN with surrounding whitespace is trimmed, not rejected", () => {
    assert.equal(resolveTelemetrySettings({ SENTRY_DSN: `  ${DSN}  ` }).dsn, DSN);
  });

  for (const value of ["off", "false", "0", "no", "disabled", "OFF", "Disabled"]) {
    test(`CI_TELEMETRY=${value} opts out even with a DSN`, () => {
      const settings = resolveTelemetrySettings({ SENTRY_DSN: DSN, CI_TELEMETRY: value });
      assert.equal(settings.enabled, false);
      assert.equal(settings.disabledReason, "opt-out");
    });
  }

  for (const value of ["on", "true", "1", "yes", "enabled"]) {
    test(`CI_TELEMETRY=${value} leaves the DSN in charge`, () => {
      assert.equal(resolveTelemetrySettings({ SENTRY_DSN: DSN, CI_TELEMETRY: value }).enabled, true);
    });
  }

  test("CI_TELEMETRY=on cannot conjure reporting without a DSN", () => {
    const settings = resolveTelemetrySettings({ CI_TELEMETRY: "on" });
    assert.equal(settings.enabled, false);
    assert.equal(settings.disabledReason, "no-dsn");
  });

  for (const value of ["true", "1", "yes", "on", "enabled", "TRUE"]) {
    test(`CI_LOCAL_ONLY=${value} disables reporting`, () => {
      const settings = resolveTelemetrySettings({ SENTRY_DSN: DSN, CI_LOCAL_ONLY: value });
      assert.equal(settings.enabled, false);
      assert.equal(settings.disabledReason, "local-only");
    });
  }

  test("CI_LOCAL_ONLY=false does not disable reporting", () => {
    assert.equal(resolveTelemetrySettings({ SENTRY_DSN: DSN, CI_LOCAL_ONLY: "false" }).enabled, true);
  });

  test("local-only outranks opt-out, so the strongest reason is the one reported", () => {
    const settings = resolveTelemetrySettings({
      SENTRY_DSN: DSN,
      CI_TELEMETRY: "off",
      CI_LOCAL_ONLY: "true",
    });
    assert.equal(settings.disabledReason, "local-only");
  });

  test("an operator's opt-out outranks the incidental absence of a DSN", () => {
    assert.equal(resolveTelemetrySettings({ CI_TELEMETRY: "off" }).disabledReason, "opt-out");
  });

  test("environment falls back SENTRY_ENV -> CI_ENVIRONMENT -> NODE_ENV -> development", () => {
    assert.equal(resolveTelemetrySettings({ SENTRY_ENV: "prod", NODE_ENV: "x" }).environment, "prod");
    assert.equal(resolveTelemetrySettings({ CI_ENVIRONMENT: "staging" }).environment, "staging");
    assert.equal(resolveTelemetrySettings({ NODE_ENV: "test" }).environment, "test");
    assert.equal(resolveTelemetrySettings({}).environment, "development");
  });

  test("release is derived from the app version, and SENTRY_RELEASE wins", () => {
    assert.equal(
      resolveTelemetrySettings({ CI_OPENCLAW_VERSION: "2026.7.1" }).release,
      "ci-openclaw-wrapper@2026.7.1",
    );
    assert.equal(
      resolveTelemetrySettings({ CI_OPENCLAW_VERSION: "2026.7.1", SENTRY_RELEASE: "pinned" }).release,
      "pinned",
    );
    assert.equal(resolveTelemetrySettings({}).release, undefined);
  });

  test("the kill-switch predicates are exported and agree with the resolver", () => {
    assert.equal(isTelemetryOptedOut({ CI_TELEMETRY: "off" }), true);
    assert.equal(isTelemetryOptedOut({ CI_TELEMETRY: "on" }), false);
    assert.equal(isTelemetryOptedOut({}), false);
    assert.equal(isLocalOnly({ CI_LOCAL_ONLY: "1" }), true);
    assert.equal(isLocalOnly({ CI_LOCAL_ONLY: "0" }), false);
    assert.equal(isLocalOnly({}), false);
  });
});

// ---------------------------------------------------------------------------
// String redaction.
//
// SCRUB_CASES is the fleet-wide list from CI-Server's
// backend/apps/api/src/common/telemetry/scrubFixtures.ts — every case there is a
// leak an adversarial review actually found in a shipped draft. Keep this copy
// in lockstep with that one; the app-specific cases follow it separately.
// ---------------------------------------------------------------------------

const SCRUB_CASES = [
  {
    name: "bearer token",
    input: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def",
    mustNotContain: ["eyJhbGciOiJIUzI1NiJ9"],
  },
  { name: "labelled api key", input: "api_key=sk-live-1234567890", mustNotContain: ["sk-live-1234567890"] },
  { name: "hyphenated api key", input: "api-key: sk-live-0987654321", mustNotContain: ["sk-live-0987654321"] },
  { name: "labelled password", input: "password: hunter2", mustNotContain: ["hunter2"] },
  { name: "tailscale auth key", input: "tskey-auth-abc123-def456", expected: "[Filtered]" },
  {
    name: "credentials in a connection URL",
    input: "postgres://ci:pgadmin_s3cure@db:5432/companion",
    mustNotContain: ["pgadmin_s3cure"],
  },
  { name: "macOS home path", input: "/Users/liam/devel/ci/file.ts", expected: "~/devel/ci/file.ts" },
  { name: "Linux home path", input: "/home/ci/data/timeline.db", expected: "~/data/timeline.db" },
  { name: "Windows home path, backslash", input: "C:\\Users\\liam\\app.log", expected: "~\\app.log" },
  {
    // Regression: the macOS rule used to match inside this and leave `C:~/…`.
    name: "Windows home path, forward slash",
    input: "C:/Users/liam/AppData/ci",
    expected: "~/AppData/ci",
  },
  {
    name: "ordinary text is untouched",
    input: 'Cannot read properties of undefined (reading "id")',
    expected: 'Cannot read properties of undefined (reading "id")',
  },
];

describe("scrubString — fleet-wide cases", () => {
  for (const testCase of SCRUB_CASES) {
    test(testCase.name, () => {
      const output = scrubString(testCase.input);
      if (testCase.expected !== undefined) {
        assert.equal(output, testCase.expected);
      }
      for (const forbidden of testCase.mustNotContain ?? []) {
        assert.ok(!output.includes(forbidden), `"${forbidden}" survived: ${output}`);
      }
    });
  }

  test("home paths are collapsed but the rest of the path survives, so Sentry can still group", () => {
    assert.equal(scrubString("/home/node/app/setup-server.cjs"), "~/app/setup-server.cjs");
  });

  test("strings over 8 KB are truncated", () => {
    const output = scrubString("x".repeat(MAX_STRING_LENGTH + 500));
    assert.ok(output.length < MAX_STRING_LENGTH + 100);
    assert.ok(output.endsWith("… [truncated]"));
  });

  test("a string at exactly the limit is left alone", () => {
    assert.equal(scrubString("x".repeat(MAX_STRING_LENGTH)).length, MAX_STRING_LENGTH);
  });
});

// ---------------------------------------------------------------------------
// App-specific redaction.
//
// This app's setup UI exists to collect provider API keys: the user types one
// into a PTY running `openclaw onboard`, and `openclaw doctor` surfaces config
// contents through execAsync's error message. Neither carries an `api_key=`
// label for the labelled-pair rule to anchor on, so bare key shapes have to be
// matched on their own. APP_SEED gates the setup terminal (an RCE primitive) and
// X-CI-Hub-User carries the household username.
// ---------------------------------------------------------------------------

describe("scrubString — bare provider keys typed into the setup terminal", () => {
  const bare = [
    ["OpenAI", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
    ["Anthropic", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
    ["OpenRouter", "sk-or-v1-abcdef0123456789abcdef0123456789"],
    ["Google", "AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q"],
    ["Groq", "gsk_abcdefghijklmnopqrstuvwxyz012345"],
    ["xAI", "xai-abcdefghijklmnopqrstuvwxyz"],
    ["GitHub PAT", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitHub fine-grained PAT", "github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz"],
  ];

  for (const [provider, key] of bare) {
    test(`an unlabelled ${provider} key does not survive`, () => {
      const output = scrubString(`openclaw doctor failed: invalid credential ${key} for provider`);
      assert.ok(!output.includes(key), `key survived: ${output}`);
      assert.ok(output.includes("[Filtered]"));
    });
  }

  test("a labelled APP_SEED does not survive", () => {
    const output = scrubString("APP_SEED=9f2c4b7e1a8d3f6b0c5e2a9d4f7b1c8e");
    assert.ok(!output.includes("9f2c4b7e1a8d3f6b0c5e2a9d4f7b1c8e"), output);
  });

  test("a gateway token in a redirect URL does not survive", () => {
    const output = scrubString("redirecting to /?token=8f3a9c2b1d4e5f60#token=8f3a9c2b1d4e5f60");
    assert.ok(!output.includes("8f3a9c2b1d4e5f60"), output);
  });

  test("ordinary words that merely start like a key are left alone", () => {
    assert.equal(scrubString("sk-short and gsk_tiny"), "sk-short and gsk_tiny");
  });
});

describe("scrubUrl", () => {
  test("strips the query string", () => {
    assert.equal(scrubUrl("/api/memory-connect/state?appUrn=urn:x&clientHost=nas.local"), "/api/memory-connect/state");
  });

  test("strips the hash, where this app puts the gateway token", () => {
    assert.equal(scrubUrl("/?token=secret#token=secret"), "/");
  });

  test("leaves a plain path untouched", () => {
    assert.equal(scrubUrl("/chat/abc"), "/chat/abc");
  });
});

describe("scrubValue", () => {
  test("filters sensitive keys by name, whatever the value is", () => {
    const output = scrubValue({
      authorization: "Bearer abc",
      cookie: "sid=1",
      "x-api-key": "sk-live-1",
      OPENCLAW_GATEWAY_TOKEN: "t",
      APP_SEED: "s",
      SENTRY_DSN: DSN,
      harmless: "kept",
    });
    assert.equal(output.authorization, "[Filtered]");
    assert.equal(output.cookie, "[Filtered]");
    assert.equal(output["x-api-key"], "[Filtered]");
    assert.equal(output.OPENCLAW_GATEWAY_TOKEN, "[Filtered]");
    assert.equal(output.APP_SEED, "[Filtered]");
    assert.equal(output.SENTRY_DSN, "[Filtered]");
    assert.equal(output.harmless, "kept");
  });

  test("filters the Hub identity headers, whose value is the household username", () => {
    const output = scrubValue({
      "x-ci-hub-user": "liam",
      "x-ci-hub-user-timestamp": "1754000000",
      "x-ci-hub-user-signature": "abc",
    });
    assert.equal(output["x-ci-hub-user"], "[Filtered]");
    assert.equal(output["x-ci-hub-user-timestamp"], "[Filtered]");
    assert.equal(output["x-ci-hub-user-signature"], "[Filtered]");
  });

  test("walks arrays and nested objects", () => {
    const output = scrubValue({ list: [{ password: "hunter2" }, "/Users/liam/x"] });
    assert.equal(output.list[0].password, "[Filtered]");
    assert.equal(output.list[1], "~/x");
  });

  test("survives a cyclic structure instead of stalling beforeSend", () => {
    const node = { name: "/Users/liam" };
    node.self = node;
    const output = scrubValue(node);
    assert.equal(output.name, "~");
    assert.equal(typeof output, "object");
  });

  test("stops at the depth guard", () => {
    let deep = "/Users/liam/leaf";
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    let cursor = scrubValue(deep);
    // Level 0 is the outermost object, so the ninth nested value is the first
    // one past the `depth > 8` guard.
    for (let i = 0; i < 8; i += 1) cursor = cursor.next;
    assert.equal(cursor.next, "[Truncated]");
  });

  test("leaves non-string primitives as they are", () => {
    assert.deepEqual(scrubValue({ n: 1, b: true, nil: null }), { n: 1, b: true, nil: null });
  });
});

// ---------------------------------------------------------------------------
// beforeSend.
// ---------------------------------------------------------------------------

describe("scrubEvent", () => {
  test("scrubs the message and every exception value", () => {
    const event = scrubEvent({
      message: "failed for /Users/liam",
      exception: { values: [{ value: "api_key=sk-live-1234567890 rejected" }] },
    });
    assert.equal(event.message, "failed for ~");
    assert.ok(!event.exception.values[0].value.includes("sk-live-1234567890"));
  });

  test("collapses home paths in stack frames without destroying the grouping key", () => {
    const event = scrubEvent({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { filename: "/Users/liam/devel/ci/server.cjs", abs_path: "/Users/liam/devel/ci/server.cjs" },
              ],
            },
          },
        ],
      },
    });
    const frame = event.exception.values[0].stacktrace.frames[0];
    assert.equal(frame.filename, "~/devel/ci/server.cjs");
    assert.equal(frame.abs_path, "~/devel/ci/server.cjs");
  });

  // Regression: the ContextLines integration (on by default in the Node SDK)
  // reads the source file off disk and attaches the failing line plus its
  // neighbours. A live-envelope probe caught these travelling unscrubbed while
  // filename/abs_path beside them were already handled.
  test("scrubs the source lines ContextLines attaches to each frame", () => {
    const event = scrubEvent({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  context_line: 'connect("postgres://ci:pgadmin_s3cure@db:5432/companion")',
                  pre_context: ["// key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
                  post_context: ["log('/Users/liam/devel')"],
                },
              ],
            },
          },
        ],
      },
    });
    const frame = event.exception.values[0].stacktrace.frames[0];
    assert.ok(!frame.context_line.includes("pgadmin_s3cure"), frame.context_line);
    assert.ok(!frame.pre_context[0].includes("sk-ant-api03"), frame.pre_context[0]);
    assert.equal(frame.post_context[0], "log('~/devel')");
  });

  test("scrubs captured frame locals", () => {
    const event = scrubEvent({
      exception: {
        values: [{ stacktrace: { frames: [{ vars: { token: "abc", note: "/home/node/x" } }] } }],
      },
    });
    const vars = event.exception.values[0].stacktrace.frames[0].vars;
    assert.equal(vars.token, "[Filtered]");
    assert.equal(vars.note, "~/x");
  });

  test("scrubs extra", () => {
    assert.equal(scrubEvent({ extra: { password: "hunter2" } }).extra.password, "[Filtered]");
  });

  test("removes server_name — the hostname identifies the household", () => {
    assert.equal("server_name" in scrubEvent({ server_name: "nas.local" }), false);
  });

  test("removes user", () => {
    assert.equal("user" in scrubEvent({ user: { id: "liam", ip_address: "10.0.0.4" } }), false);
  });

  test("removes the culture context, whose timezone is a coarse location signal", () => {
    const event = scrubEvent({ contexts: { culture: { timezone: "America/Chicago" }, runtime: { name: "node" } } });
    assert.equal("culture" in event.contexts, false);
    assert.deepEqual(event.contexts.runtime, { name: "node" });
  });

  test("drops request cookies and body outright", () => {
    const event = scrubEvent({ request: { cookies: { sid: "1" }, data: { prompt: "my private note" } } });
    assert.equal("cookies" in event.request, false);
    assert.equal("data" in event.request, false);
  });

  test("filters query_string AND the query inside request.url — filtering one alone redacts nothing", () => {
    const event = scrubEvent({
      request: { url: "http://openclaw.local/?token=8f3a9c2b1d4e5f60", query_string: "token=8f3a9c2b1d4e5f60" },
    });
    assert.equal(event.request.query_string, "[Filtered]");
    assert.equal(event.request.url, "http://openclaw.local/");
    assert.ok(!JSON.stringify(event).includes("8f3a9c2b1d4e5f60"));
  });

  test("filters request headers, which sendDefaultPii:false does NOT stop", () => {
    const event = scrubEvent({
      request: {
        headers: {
          "x-api-key": "sk-live-1234567890",
          authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def",
          cookie: "ci_memory_deferred=1",
          "x-ci-hub-user": "liam",
          "user-agent": "Mozilla/5.0",
        },
      },
    });
    assert.equal(event.request.headers["x-api-key"], "[Filtered]");
    assert.equal(event.request.headers.authorization, "[Filtered]");
    assert.equal(event.request.headers.cookie, "[Filtered]");
    assert.equal(event.request.headers["x-ci-hub-user"], "[Filtered]");
    assert.equal(event.request.headers["user-agent"], "Mozilla/5.0");
  });

  test("strips the query from URL-valued headers", () => {
    const event = scrubEvent({
      request: { headers: { referer: "http://openclaw.local/?token=abc123", Location: "/chat?q=my+search" } },
    });
    assert.equal(event.request.headers.referer, "http://openclaw.local/");
    assert.equal(event.request.headers.Location, "/chat");
  });

  test("scrubs breadcrumb messages and data", () => {
    const event = scrubEvent({
      breadcrumbs: [
        { message: "spawn failed in /Users/liam", data: { api_key: "sk-live-1", note: "password: hunter2" } },
      ],
    });
    assert.equal(event.breadcrumbs[0].message, "spawn failed in ~");
    assert.equal(event.breadcrumbs[0].data.api_key, "[Filtered]");
    assert.ok(!event.breadcrumbs[0].data.note.includes("hunter2"));
  });

  test("strips the query from breadcrumb URLs — the proxy replays every request as an http crumb", () => {
    const event = scrubEvent({
      breadcrumbs: [
        { category: "http", data: { url: "http://127.0.0.1:18790/?token=8f3a9c2b1d4e5f60", method: "GET" } },
        { category: "navigation", data: { from: "/a?q=secret+search", to: "/b?q=secret+search" } },
      ],
    });
    assert.equal(event.breadcrumbs[0].data.url, "http://127.0.0.1:18790/");
    assert.equal(event.breadcrumbs[0].data.method, "GET");
    assert.equal(event.breadcrumbs[1].data.from, "/a");
    assert.equal(event.breadcrumbs[1].data.to, "/b");
  });

  test("handles the .values breadcrumb shape too", () => {
    const event = scrubEvent({ breadcrumbs: { values: [{ message: "/home/node/x" }] } });
    assert.equal(event.breadcrumbs.values[0].message, "~/x");
  });

  test("scrubs logentry.formatted and .params, not just the format string", () => {
    const event = scrubEvent({
      logentry: { message: "doctor failed: %s", formatted: "doctor failed: api_key=sk-live-1", params: ["api_key=sk-live-1"] },
    });
    assert.ok(!event.logentry.formatted.includes("sk-live-1"));
    assert.ok(!JSON.stringify(event.logentry.params).includes("sk-live-1"));
  });

  test("a bare event survives untouched", () => {
    assert.deepEqual(scrubEvent({ level: "error" }), { level: "error" });
  });

  test("never throws on a malformed event", () => {
    assert.doesNotThrow(() => scrubEvent(null));
    assert.doesNotThrow(() => scrubEvent({ exception: { values: [null] } }));
    assert.doesNotThrow(() => scrubBreadcrumb(null));
  });
});

// ---------------------------------------------------------------------------
// Init.
//
// Only the DISABLED paths are exercised here: they return before the lazy
// `require("@sentry/node")`, so this suite stays dependency-free — ci.yml runs it
// with no `npm ci` on purpose. The enabled path is covered by the runtime probe
// documented in docs/operations/error-reporting.md.
// ---------------------------------------------------------------------------

describe("initTelemetry", () => {
  const silent = { log() {}, warn() {} };

  test("does nothing, and loads no SDK, without a DSN", () => {
    resetTelemetryForTests();
    const settings = initTelemetry({}, silent);
    assert.equal(settings.enabled, false);
    assert.equal(settings.disabledReason, "no-dsn");
    assert.equal(isTelemetryEnabled(), false);
    assert.ok(
      !Object.keys(require.cache).some((key) => key.includes("@sentry")),
      "@sentry/node was loaded despite there being no DSN",
    );
  });

  test("honours the kill switches before touching the SDK", () => {
    resetTelemetryForTests();
    assert.equal(initTelemetry({ SENTRY_DSN: DSN, CI_TELEMETRY: "off" }, silent).disabledReason, "opt-out");
    resetTelemetryForTests();
    assert.equal(initTelemetry({ SENTRY_DSN: DSN, CI_LOCAL_ONLY: "true" }, silent).disabledReason, "local-only");
    assert.equal(isTelemetryEnabled(), false);
    assert.ok(!Object.keys(require.cache).some((key) => key.includes("@sentry")));
  });

  test("logs why reporting is off", () => {
    resetTelemetryForTests();
    const lines = [];
    initTelemetry({ CI_LOCAL_ONLY: "1" }, { log: (line) => lines.push(line), warn() {} });
    assert.match(lines.join("\n"), /disabled \(local-only\)/);
  });

  test("captureException is an inert no-op when reporting is off", () => {
    resetTelemetryForTests();
    initTelemetry({}, silent);
    assert.doesNotThrow(() => telemetry.captureException(new Error("boom")));
  });

  test("flushTelemetry resolves immediately when reporting is off, so shutdown is unchanged", async () => {
    resetTelemetryForTests();
    initTelemetry({}, silent);
    const started = Date.now();
    await flushTelemetry(5000);
    assert.ok(Date.now() - started < 250, "flush blocked a shutdown path that reports nothing");
  });

  test("the consent status never contains the DSN", () => {
    resetTelemetryForTests();
    initTelemetry({ SENTRY_DSN: DSN, CI_TELEMETRY: "off" }, silent);
    const status = getTelemetryStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.reason, "opt-out");
    assert.equal(status.component, "ci-openclaw-wrapper");
    assert.ok(!JSON.stringify(status).includes("abc123"), "the DSN leaked through the consent endpoint");
  });
});

// ---------------------------------------------------------------------------
// Integration filtering.
//
// The crash-handler integrations matter most: server.cjs deliberately survives an
// uncaught exception (a stray throw must not drop the whole app), and the SDK's
// own handlers can terminate the process. Reporting is not allowed to change
// that. The filter is by string name, so a rename upstream has to be noisy.
// ---------------------------------------------------------------------------

describe("filterIntegrations", () => {
  const defaults = [
    { name: "InboundFilters" },
    { name: "Console" },
    { name: "OnUncaughtException" },
    { name: "OnUnhandledRejection" },
    { name: "ProcessSession" },
    { name: "Http" },
  ];

  test("drops exactly the integrations this app handles itself", () => {
    const kept = filterIntegrations([...defaults], () => {}).map((i) => i.name);
    assert.deepEqual(kept, ["InboundFilters", "Http"]);
  });

  test("the crash-handler integrations are in the disabled set", () => {
    assert.ok(DISABLED_INTEGRATIONS.has("OnUncaughtException"));
    assert.ok(DISABLED_INTEGRATIONS.has("OnUnhandledRejection"));
    assert.ok(DISABLED_INTEGRATIONS.has("Console"));
    assert.ok(DISABLED_INTEGRATIONS.has("ProcessSession"));
  });

  test("warns when a name matched nothing, so an upstream rename cannot silently re-enable it", () => {
    const warnings = [];
    filterIntegrations([{ name: "Http" }], (line) => warnings.push(line));
    assert.equal(warnings.length, DISABLED_INTEGRATIONS.size);
    assert.match(warnings.join("\n"), /OnUncaughtException/);
  });

  test("is silent when every name matched", () => {
    const warnings = [];
    filterIntegrations([...defaults], (line) => warnings.push(line));
    assert.equal(warnings.length, 0);
  });
});
