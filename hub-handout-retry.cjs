"use strict";

// When OpenClaw starts before the Hub listens (right after a reboot, say),
// bootstrap-from-hub.sh keeps the previous handout and leaves .hub-handout-pending in the
// data dir. This asks the Hub again every HUB_BOOTSTRAP_RETRY_INTERVAL seconds (30 by
// default) by running the same script, until it answers once and removes the file. Then
// `onAnswered` takes over: the new settings are in .env, which the gateway reads only
// when it starts.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PENDING_FILE_NAME = ".hub-handout-pending";
const DEFAULT_INTERVAL_SECONDS = 30;
// setTimeout holds a signed 32-bit ms count and fires at once past it.
const MAX_INTERVAL_SECONDS = Math.floor(2 ** 31 / 1000) - 1;

function hubHandoutPendingFile(configDir) {
  return path.join(configDir, PENDING_FILE_NAME);
}

/**
 * HUB_BOOTSTRAP_RETRY_INTERVAL in ms. 0 would spin, so like a non-number it falls back to
 * 30 s. A value past what setTimeout can wait is capped.
 */
function retryIntervalMs(value, log = console) {
  const text = value === undefined || value === null ? "" : String(value).trim();
  if (text === "") return DEFAULT_INTERVAL_SECONDS * 1000;
  if (/^[0-9]+$/.test(text) && Number(text) > 0) {
    if (Number(text) > MAX_INTERVAL_SECONDS) {
      log.warn(`[hub-bootstrap] HUB_BOOTSTRAP_RETRY_INTERVAL=${text} is longer than a timer can wait; using ${MAX_INTERVAL_SECONDS}`);
      return MAX_INTERVAL_SECONDS * 1000;
    }
    return Number(text) * 1000;
  }
  log.warn(
    `[hub-bootstrap] HUB_BOOTSTRAP_RETRY_INTERVAL=${text} is not a positive whole number of seconds; using ${DEFAULT_INTERVAL_SECONDS}`,
  );
  return DEFAULT_INTERVAL_SECONDS * 1000;
}

/**
 * Run bootstrap-from-hub.sh with this process's env, its output in the container log. Never
 * rejects. Aborting `signal` stops the script. A try can wait on curl for about 42 s. Until
 * then the running child would hold a shutdown open past Docker's stop timeout.
 */
function runBootstrapScript(scriptPath, log = console, env = process.env, signal) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(scriptPath, [], { stdio: "inherit", env, ...(signal ? { signal } : {}) });
    } catch (error) {
      log.error(`[hub-bootstrap] could not run ${scriptPath}: ${error.message}`);
      resolve();
      return;
    }
    child.on("error", (error) => {
      if (error?.name !== "AbortError") {
        log.error(`[hub-bootstrap] could not run ${scriptPath}: ${error.message}`);
      }
      resolve();
    });
    child.on("exit", () => resolve());
  });
}

/**
 * @param {object}   deps
 * @param {string}   deps.pendingFile  Present while the Hub hasn't answered.
 * @param {Function} deps.runBootstrap Asks the Hub once; resolves when that is done.
 * @param {Function} deps.onAnswered   Called once, after the try that removed pendingFile.
 * @param {number}   deps.intervalMs   Wait between tries.
 */
function createHubHandoutRetry({
  pendingFile,
  runBootstrap,
  onAnswered,
  intervalMs,
  log = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  let trying = false;
  let stopped = false;

  const schedule = () => {
    timer = setTimer(tick, intervalMs);
    // The setup server's listener keeps the process alive; a pending retry should not.
    timer?.unref?.();
  };

  // One try at a time: the next wait starts after this try ends, however long the Hub
  // takes to refuse it.
  async function tick() {
    timer = null;
    if (stopped) return;
    trying = true;
    try {
      await runBootstrap();
    } catch (error) {
      log.error(`[hub-bootstrap] asking the Hub again failed: ${error?.message || error}`);
    } finally {
      trying = false;
    }
    if (stopped) return;
    if (fs.existsSync(pendingFile)) {
      schedule();
      return;
    }
    stopped = true;
    log.log("[hub-bootstrap] the Hub answered; applying its handout");
    try {
      await onAnswered();
    } catch (error) {
      log.error(`[hub-bootstrap] applying the Hub's handout failed: ${error?.message || error}`);
    }
  }

  return {
    /** Starts asking when the last start-up run left pendingFile. Returns whether it did. */
    start() {
      if (stopped || timer || trying || !fs.existsSync(pendingFile)) return false;
      log.log(`[hub-bootstrap] asking the Hub again every ${Math.round(intervalMs / 1000)} s until it answers`);
      schedule();
      return true;
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

module.exports = {
  createHubHandoutRetry,
  hubHandoutPendingFile,
  retryIntervalMs,
  runBootstrapScript,
};
