import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { GATEWAY_HEALTH_PATH, describeGatewayHealth, handleGatewayHealthRequest } = require("../gateway-health.cjs");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// What server.cjs knows about the gateway at any moment. A configured app whose gateway has
// exited and is not being restarted is the case the Hub could not see: the setup server kept
// answering, so the container looked fine while the agent was gone.
const configured = { configured: true, onboarding: false, running: false, starting: false, lastExit: null };

describe("describeGatewayHealth", () => {
  test("the setup page counts as healthy before OpenClaw is configured", () => {
    const { healthy, body } = describeGatewayHealth({ ...configured, configured: false });
    assert.equal(healthy, true);
    assert.equal(body.gateway, "setup");
  });

  test("onboarding in the setup terminal counts as healthy", () => {
    assert.equal(describeGatewayHealth({ ...configured, onboarding: true }).healthy, true);
  });

  test("a gateway that is still starting counts as healthy", () => {
    const { healthy, body } = describeGatewayHealth({ ...configured, starting: true });
    assert.equal(healthy, true);
    assert.equal(body.gateway, "starting");
  });

  test("a running gateway counts as healthy", () => {
    const { healthy, body } = describeGatewayHealth({ ...configured, running: true });
    assert.equal(healthy, true);
    assert.equal(body.gateway, "running");
  });

  test("a gateway that exited and was not restarted is unhealthy, and says how it ended", () => {
    const { healthy, body } = describeGatewayHealth({ ...configured, lastExit: { code: 1, signal: null } });
    assert.equal(healthy, false);
    assert.deepEqual(body, { status: "down", gateway: "stopped", exitCode: 1, signal: null });
  });

  test("a gateway killed by a signal reports the signal", () => {
    const { healthy, body } = describeGatewayHealth({ ...configured, lastExit: { code: null, signal: "SIGKILL" } });
    assert.equal(healthy, false);
    assert.equal(body.signal, "SIGKILL");
  });

  test("an earlier exit does not count against a restart that is under way", () => {
    const state = { ...configured, starting: true, lastExit: { code: 1, signal: null } };
    assert.equal(describeGatewayHealth(state).healthy, true);
  });
});

describe(`GET ${GATEWAY_HEALTH_PATH}`, () => {
  let server;
  let base;
  let state;

  before(async () => {
    server = http.createServer((req, res) => {
      if (handleGatewayHealthRequest(req, res, () => state)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  test("answers 200 while the gateway runs", async () => {
    state = { ...configured, running: true };
    const res = await fetch(`${base}${GATEWAY_HEALTH_PATH}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { status: "ok", gateway: "running" });
  });

  test("answers 503 once the gateway has exited", async () => {
    state = { ...configured, lastExit: { code: 1, signal: null } };
    const res = await fetch(`${base}${GATEWAY_HEALTH_PATH}`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: "down", gateway: "stopped", exitCode: 1, signal: null });
  });

  test("reads the state on every request, so it follows the gateway back up", async () => {
    state = { ...configured, lastExit: { code: 1, signal: null } };
    assert.equal((await fetch(`${base}${GATEWAY_HEALTH_PATH}`)).status, 503);
    state = { ...configured, starting: true, lastExit: { code: 1, signal: null } };
    assert.equal((await fetch(`${base}${GATEWAY_HEALTH_PATH}`)).status, 200);
  });

  test("ignores a query string", async () => {
    state = { ...configured, lastExit: { code: 1, signal: null } };
    assert.equal((await fetch(`${base}${GATEWAY_HEALTH_PATH}?probe=1`)).status, 503);
  });

  test("HEAD gets the status without a body", async () => {
    state = { ...configured, lastExit: { code: 1, signal: null } };
    const res = await fetch(`${base}${GATEWAY_HEALTH_PATH}`, { method: "HEAD" });
    assert.equal(res.status, 503);
    assert.equal(await res.text(), "");
  });

  test("refuses other methods", async () => {
    state = { ...configured, running: true };
    const res = await fetch(`${base}${GATEWAY_HEALTH_PATH}`, { method: "POST" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
  });

  test("leaves every other path to the caller", async () => {
    state = { ...configured, running: true };
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}${GATEWAY_HEALTH_PATH}/x`)).status, 404);
  });
});

describe("the image reports gateway health to Docker", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  // Fold backslash continuations and drop comment lines, as tests/sandbox-toolchain.test.mjs does.
  const flat = dockerfile
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/\\\n\s*/g, " ");
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
