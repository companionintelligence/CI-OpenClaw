import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { getEventListeners } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  createHubHandoutRetry,
  hubHandoutPendingFile,
  retryIntervalMs,
  runBootstrapScript,
} = require("../hub-handout-retry.cjs");

const quiet = { log() {}, warn() {}, error() {} };

// A clock the test advances by hand: `fire()` runs the one pending timer, if any.
function fakeTimers() {
  const pending = [];
  return {
    setTimer(fn, ms) {
      const handle = { fn, ms, cleared: false };
      pending.push(handle);
      return handle;
    },
    clearTimer(handle) {
      handle.cleared = true;
    },
    waiting() {
      return pending.filter((h) => !h.cleared && !h.fired);
    },
    async fire() {
      const next = this.waiting()[0];
      assert.ok(next, "no timer is waiting");
      next.fired = true;
      await next.fn();
    },
  };
}

function dataDir() {
  return mkdtempSync(join(tmpdir(), "hub-handout-retry-"));
}

describe("createHubHandoutRetry", () => {
  test("does nothing when the start-up run reached the Hub", () => {
    const dir = dataDir();
    try {
      const timers = fakeTimers();
      const retry = createHubHandoutRetry({
        pendingFile: hubHandoutPendingFile(dir),
        runBootstrap: async () => assert.fail("must not ask again"),
        onAnswered: async () => assert.fail("nothing to apply"),
        intervalMs: 30_000,
        log: quiet,
        ...timers,
      });
      assert.equal(retry.start(), false);
      assert.equal(timers.waiting().length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("asks every interval until the Hub answers, applies it once and stops", async () => {
    const dir = dataDir();
    const pending = hubHandoutPendingFile(dir);
    writeFileSync(pending, "");
    try {
      const timers = fakeTimers();
      let asked = 0;
      let applied = 0;
      const retry = createHubHandoutRetry({
        pendingFile: pending,
        // The Hub comes up on the third try, as bootstrap-from-hub.sh would show it.
        runBootstrap: async () => {
          asked++;
          if (asked === 3) rmSync(pending);
        },
        onAnswered: async () => {
          applied++;
        },
        intervalMs: 30_000,
        log: quiet,
        ...timers,
      });

      assert.equal(retry.start(), true);
      assert.equal(timers.waiting()[0].ms, 30_000, "waits before the first try: start-up just tried");
      assert.equal(asked, 0);

      await timers.fire();
      await timers.fire();
      assert.equal(asked, 2);
      assert.equal(applied, 0, "nothing applied while the Hub stays down");
      assert.equal(timers.waiting().length, 1, "still asking");

      await timers.fire();
      assert.equal(asked, 3);
      assert.equal(applied, 1, "applied once the Hub answered");
      assert.equal(timers.waiting().length, 0, "stops after the first answer");
      assert.equal(retry.start(), false, "and doesn't start over");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("waits for one try to end before timing the next", async () => {
    const dir = dataDir();
    const pending = hubHandoutPendingFile(dir);
    writeFileSync(pending, "");
    try {
      const timers = fakeTimers();
      let finishTry;
      const retry = createHubHandoutRetry({
        pendingFile: pending,
        runBootstrap: () => new Promise((resolve) => (finishTry = resolve)),
        onAnswered: async () => {},
        intervalMs: 30_000,
        log: quiet,
        ...timers,
      });
      retry.start();
      const running = timers.fire();
      assert.equal(timers.waiting().length, 0, "no second try while the first is out");
      assert.equal(retry.start(), false, "start() during a try doesn't start a second loop");
      finishTry();
      await running;
      assert.equal(timers.waiting().length, 1);
      retry.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a try that throws is logged and the next one still comes", async () => {
    const dir = dataDir();
    const pending = hubHandoutPendingFile(dir);
    writeFileSync(pending, "");
    try {
      const timers = fakeTimers();
      const errors = [];
      const retry = createHubHandoutRetry({
        pendingFile: pending,
        runBootstrap: async () => {
          throw new Error("spawn EAGAIN");
        },
        onAnswered: async () => {},
        intervalMs: 30_000,
        log: { ...quiet, error: (m) => errors.push(m) },
        ...timers,
      });
      retry.start();
      await timers.fire();
      assert.match(errors[0], /spawn EAGAIN/);
      assert.equal(timers.waiting().length, 1);
      retry.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stop() ends the asking", async () => {
    const dir = dataDir();
    const pending = hubHandoutPendingFile(dir);
    writeFileSync(pending, "");
    try {
      const timers = fakeTimers();
      const retry = createHubHandoutRetry({
        pendingFile: pending,
        runBootstrap: async () => assert.fail("stopped"),
        onAnswered: async () => assert.fail("stopped"),
        intervalMs: 30_000,
        log: quiet,
        ...timers,
      });
      retry.start();
      retry.stop();
      assert.equal(timers.waiting().length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("retryIntervalMs", () => {
  test("defaults to 30 s and reads whole seconds", () => {
    assert.equal(retryIntervalMs(undefined, quiet), 30_000);
    assert.equal(retryIntervalMs("", quiet), 30_000);
    assert.equal(retryIntervalMs("5", quiet), 5_000);
  });

  test("a value past what a timer can wait is capped", () => {
    const warnings = [];
    assert.equal(retryIntervalMs("3000000", { ...quiet, warn: (m) => warnings.push(m) }), 2_147_482_000);
    assert.match(warnings[0], /longer than a timer can wait/);
  });

  test("0 or a non-number falls back to 30 s with a warning", () => {
    for (const bad of ["0", "abc", "1.5", "-3"]) {
      const warnings = [];
      assert.equal(retryIntervalMs(bad, { ...quiet, warn: (m) => warnings.push(m) }), 30_000, bad);
      assert.match(warnings[0], new RegExp(`HUB_BOOTSTRAP_RETRY_INTERVAL=${bad.replace(".", "\\.")} is not a positive whole number`));
    }
  });
});

describe("the bootstrap script and the retry together", () => {
  test("a Hub that answers late is applied by the next try", async () => {
    const dir = dataDir();
    const fixture = join(dir, "handout.env");
    const env = { ...process.env, OPENCLAW_DATA_DIR: dir, BOOTSTRAP_FIXTURE_FILE: fixture };
    const script = join(ROOT, "bootstrap-from-hub.sh");
    const run = () => runBootstrapScript(script, quiet, env);
    try {
      // Start-up: no fixture file is a Hub that can't be reached.
      await run();
      assert.ok(existsSync(hubHandoutPendingFile(dir)), "start-up run leaves the pending file");

      const timers = fakeTimers();
      let applied = 0;
      const retry = createHubHandoutRetry({
        pendingFile: hubHandoutPendingFile(dir),
        runBootstrap: run,
        onAnswered: async () => {
          applied++;
        },
        intervalMs: 30_000,
        log: quiet,
        ...timers,
      });
      assert.equal(retry.start(), true);
      await timers.fire();
      assert.equal(applied, 0);

      writeFileSync(fixture, "OPENAI_API_BASE=http://ci-hub-ollama:11434/v1\nOPENAI_API_KEY=ollama\nDEFAULT_MODEL=qwen3.5:9b\n");
      await timers.fire();
      assert.equal(applied, 1);
      assert.ok(!existsSync(hubHandoutPendingFile(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runBootstrapScript stops the script when its signal aborts", async () => {
    const dir = dataDir();
    const script = join(dir, "slow.sh");
    // exec: the kill reaches sleep itself. A sleep left behind by a killed sh holds the
    // test runner's stdout open. The whole file then waits out its 30 s.
    writeFileSync(script, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(script, 0o700);
    try {
      const errors = [];
      const controller = new AbortController();
      const started = Date.now();
      const done = runBootstrapScript(script, { ...quiet, error: (m) => errors.push(m) }, process.env, controller.signal);
      setTimeout(() => controller.abort(), 100);
      await done;
      assert.ok(Date.now() - started < 10_000, "the script was stopped, not waited out");
      assert.deepEqual(errors, [], "an abort is not reported as a failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runBootstrapScript resolves when the script can't run", async () => {
    const dir = dataDir();
    const script = join(dir, "not-executable.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o600);
    try {
      const errors = [];
      const controller = new AbortController();
      await runBootstrapScript(script, { ...quiet, error: (m) => errors.push(m) }, process.env, controller.signal);
      assert.match(errors[0], /could not run/);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0, "a failed try leaves no listener on the signal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
