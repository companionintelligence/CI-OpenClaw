import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { flatDockerfile } from "./helpers/dockerfile.mjs";

const require = createRequire(import.meta.url);
const {
  GATEWAY_HEALTH_PATH,
  QUICK_EXIT_MS,
  FAILED_STARTS_LIMIT,
  createGatewayHealthTracker,
  handleGatewayHealthRequest,
} = require("../gateway-health.cjs");

// A configured app, with no setup terminal open and no restart under way.
const idle = { configured: true, onboarding: false, starting: false };
const starting = { ...idle, starting: true };

/** A tracker on a clock the test moves by hand. */
function trackerAt(startMs = 1_000_000) {
  let nowMs = startMs;
  const tracker = createGatewayHealthTracker({ now: () => nowMs });
  return {
    tracker,
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

/** One gateway run that dies `afterMs` after its spawn, the way it does at boot on a Windows Hub. */
function failedRun({ tracker, advance }, afterMs = 3_000) {
  tracker.spawned();
  advance(afterMs);
  tracker.exited(1, null);
}

describe("the gateway health tracker", () => {
  test("the setup page counts as healthy before OpenClaw is configured", () => {
    const { tracker } = trackerAt();
    const { healthy, body } = tracker.describe({ ...idle, configured: false });
    assert.equal(healthy, true);
    assert.equal(body.gateway, "setup");
  });

  test("onboarding in the setup terminal counts as healthy", () => {
    const { tracker } = trackerAt();
    assert.equal(tracker.describe({ ...idle, onboarding: true }).healthy, true);
  });

  test("a gateway that is starting or running counts as healthy", () => {
    const { tracker } = trackerAt();
    assert.deepEqual(tracker.describe(starting), { healthy: true, body: { status: "ok", gateway: "starting" } });
    tracker.spawned();
    assert.deepEqual(tracker.describe(idle), { healthy: true, body: { status: "ok", gateway: "running" } });
  });

  // A stopped gateway is started again by the next request, and an unhealthy container loses its
  // Traefik routes, so on a Public Web install that request would never arrive. Stopped is only
  // down once the starts keep failing.
  test("a gateway that exited and was not restarted counts as healthy, and says how it ended", () => {
    const clock = trackerAt();
    failedRun(clock);
    assert.deepEqual(clock.tracker.describe(idle), {
      healthy: true,
      body: { status: "ok", gateway: "stopped", failedStarts: 1, exitCode: 1, signal: null },
    });
  });

  test("a gateway the agent stopped through the systemctl shim counts as healthy", () => {
    const { tracker, advance } = trackerAt();
    tracker.spawned();
    advance(10 * 60_000);
    tracker.exited(null, "SIGTERM");
    assert.deepEqual(tracker.describe(idle), {
      healthy: true,
      body: { status: "ok", gateway: "stopped", failedStarts: 0, exitCode: null, signal: "SIGTERM" },
    });
  });

  test("a gateway that crashed after a long run counts as healthy until the next request", () => {
    const { tracker, advance } = trackerAt();
    tracker.spawned();
    advance(QUICK_EXIT_MS + 1);
    tracker.exited(null, "SIGKILL");
    const { healthy, body } = tracker.describe(idle);
    assert.equal(healthy, true);
    assert.equal(body.gateway, "stopped");
    assert.equal(body.signal, "SIGKILL");
  });

  test(`a gateway stopped after ${FAILED_STARTS_LIMIT} failed starts in a row is down`, () => {
    const clock = trackerAt();
    for (let i = 0; i < FAILED_STARTS_LIMIT - 1; i++) failedRun(clock);
    assert.equal(clock.tracker.describe(idle).healthy, true, "one start short of the limit");
    failedRun(clock);
    assert.deepEqual(clock.tracker.describe(idle), {
      healthy: false,
      body: { status: "down", gateway: "failing", failedStarts: FAILED_STARTS_LIMIT, exitCode: 1, signal: null },
    });
  });

  test("a restart after one failure counts as healthy while it is under way", () => {
    const clock = trackerAt();
    failedRun(clock);
    assert.equal(clock.tracker.describe(starting).healthy, true);
    clock.tracker.spawned();
    assert.equal(clock.tracker.describe(idle).healthy, true);
  });

  // The case the Hub missed: OpenClaw's loading page reloads every 2.5 seconds, each reload
  // restarts the dead gateway, and so a check that only asked "is it stopped right now?" would
  // see "starting" nearly every time someone has the page open.
  test(`a gateway that fails to start ${FAILED_STARTS_LIMIT} times in a row is down even mid-restart`, () => {
    const clock = trackerAt();
    for (let i = 0; i < FAILED_STARTS_LIMIT; i++) failedRun(clock);
    assert.deepEqual(clock.tracker.describe(starting), {
      healthy: false,
      body: { status: "down", gateway: "failing", failedStarts: FAILED_STARTS_LIMIT, exitCode: 1, signal: null },
    });
    clock.tracker.spawned();
    assert.equal(clock.tracker.describe(idle).healthy, false, "a fresh spawn after the failures is not proof yet");
  });

  test("fewer failures than the limit still let a restart count as healthy", () => {
    const clock = trackerAt();
    for (let i = 0; i < FAILED_STARTS_LIMIT - 1; i++) failedRun(clock);
    assert.equal(clock.tracker.describe(starting).healthy, true);
  });

  test("a run that outlives the quick-exit window is up again", () => {
    const clock = trackerAt();
    for (let i = 0; i < FAILED_STARTS_LIMIT; i++) failedRun(clock);
    clock.tracker.spawned();
    clock.advance(QUICK_EXIT_MS);
    assert.deepEqual(clock.tracker.describe(idle), { healthy: true, body: { status: "ok", gateway: "running" } });
  });

  test("a crash after a long run starts a new count", () => {
    const clock = trackerAt();
    for (let i = 0; i < FAILED_STARTS_LIMIT; i++) failedRun(clock);
    failedRun(clock, QUICK_EXIT_MS + 1);
    assert.equal(clock.tracker.describe(idle).body.failedStarts, 1);
    assert.equal(clock.tracker.describe(starting).healthy, true);
  });

  test("a stop someone asked for clears the count", () => {
    for (const [code, signal] of [
      [0, null],
      [null, "SIGTERM"],
    ]) {
      const clock = trackerAt();
      for (let i = 0; i < FAILED_STARTS_LIMIT; i++) failedRun(clock);
      clock.tracker.spawned();
      clock.advance(1_000);
      clock.tracker.exited(code, signal);
      assert.equal(clock.tracker.describe(idle).body.failedStarts, 0, `exit ${code}/${signal}`);
      assert.equal(clock.tracker.describe(starting).healthy, true, `exit ${code}/${signal}`);
    }
  });

  test("setup and onboarding stay healthy whatever the gateway did before", () => {
    const clock = trackerAt();
    for (let i = 0; i < FAILED_STARTS_LIMIT; i++) failedRun(clock);
    assert.equal(clock.tracker.describe({ ...idle, configured: false }).healthy, true);
    assert.equal(clock.tracker.describe({ ...idle, onboarding: true }).healthy, true);
  });
});

describe(`GET ${GATEWAY_HEALTH_PATH}`, () => {
  let server;
  let base;
  let answer;

  before(async () => {
    server = http.createServer((req, res) => {
      if (handleGatewayHealthRequest(req, res, () => answer)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  const healthy = { healthy: true, body: { status: "ok", gateway: "running" } };
  const failing = { healthy: false, body: { status: "down", gateway: "failing", failedStarts: 3, exitCode: 1, signal: null } };

  test("answers 200 with the body while the gateway is healthy", async () => {
    answer = healthy;
    const res = await fetch(`${base}${GATEWAY_HEALTH_PATH}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), healthy.body);
  });

  test("answers 503 with the body once the gateway is down", async () => {
    answer = failing;
    const res = await fetch(`${base}${GATEWAY_HEALTH_PATH}`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), failing.body);
  });

  test("asks again on every request", async () => {
    answer = failing;
    assert.equal((await fetch(`${base}${GATEWAY_HEALTH_PATH}`)).status, 503);
    answer = healthy;
    assert.equal((await fetch(`${base}${GATEWAY_HEALTH_PATH}`)).status, 200);
  });

  test("ignores a query string", async () => {
    answer = failing;
    assert.equal((await fetch(`${base}${GATEWAY_HEALTH_PATH}?probe=1`)).status, 503);
  });

  test("HEAD gets the status without a body", async () => {
    answer = failing;
    const res = await fetch(`${base}${GATEWAY_HEALTH_PATH}`, { method: "HEAD" });
    assert.equal(res.status, 503);
    assert.equal(await res.text(), "");
  });

  test("refuses other methods", async () => {
    answer = healthy;
    const res = await fetch(`${base}${GATEWAY_HEALTH_PATH}`, { method: "POST" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
  });

  test("leaves every other path to the caller", async () => {
    answer = healthy;
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}${GATEWAY_HEALTH_PATH}/x`)).status, 404);
  });
});

describe("the image reports gateway health to Docker", () => {
  const flat = flatDockerfile();
  const healthcheck = flat.split("\n").find((line) => /^HEALTHCHECK\b/.test(line));

  test("the Dockerfile declares a HEALTHCHECK that runs /app/healthcheck.sh", () => {
    assert.ok(healthcheck, "no HEALTHCHECK line in the Dockerfile");
    assert.match(healthcheck, /\bCMD \["\/app\/healthcheck\.sh"\]$/);
  });

  test("healthcheck.sh is copied into /app and made executable", () => {
    assert.match(flat, /^COPY\b[^\n]*\bhealthcheck\.sh\b[^\n]* \/app\/$/m);
    assert.match(flat, /^RUN sudo chmod \+x [^\n]*\/app\/healthcheck\.sh\b/m);
  });

  // The Hub's update flow probes an updated app five times, two seconds apart, and rolls the
  // update back unless every container with a healthcheck reports `healthy`. Docker reports
  // `starting` until the first check passes, and without --start-interval that first check
  // waits a full --interval. So the first check has to come within a couple of seconds.
  test("the first check runs within two seconds of the container starting", () => {
    const startInterval = healthcheck?.match(/--start-interval=(\d+)s\b/);
    assert.ok(startInterval, "HEALTHCHECK has no --start-interval=<n>s");
    assert.ok(Number(startInterval[1]) <= 2, `--start-interval=${startInterval[1]}s is longer than 2s`);
    assert.match(healthcheck, /--start-period=\d+s\b/, "--start-interval only applies inside a --start-period");
  });
});

// server.cjs binds a port and requires node-pty by its container path, so it cannot be loaded
// here. These read its source, as tests/linuxbrew-seeding.test.mjs does for initializeHome().
describe("server.cjs feeds the tracker", () => {
  const server = readFileSync(new URL("../server.cjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

  // cfg.isConfigured() parses openclaw.json and copies openclaw.json.bak over it when the parse
  // fails, so a check every few seconds could restore the backup over a config doctor is writing.
  test("the health answer does not read openclaw.json", () => {
    const call = server.match(/handleGatewayHealthRequest\(req, res, \(\) =>[\s\S]*?\n {2}\) \{/);
    assert.ok(call, "the handleGatewayHealthRequest call was not found in server.cjs");
    assert.doesNotMatch(call[0], /isConfigured/);
  });

  // A spawn that fails emits 'error' and never 'exit'. Unhandled, the handle stayed set, no
  // request started the gateway again, and the check reported a run that never happened.
  test("a gateway that fails to spawn is recorded as a failed start and forgotten", () => {
    const onError = server.match(/\.on\("error", \(err\) => \{[\s\S]*?\n {4}\}\);/);
    assert.ok(onError, "the spawned gateway has no 'error' listener");
    assert.match(onError[0], /gatewayHealth\.exited\(/);
    assert.match(onError[0], /openclawProcess = null;/);
  });
});
