/**
 * What the image's Docker HEALTHCHECK (healthcheck.sh) learns about the OpenClaw gateway.
 *
 * The setup server spawns the gateway and outlives it: when the gateway exits, server.cjs only
 * starts it again on the next request, and the container keeps running either way. Docker, and
 * the Hub that reads Docker, therefore saw a healthy app while the agent was gone. On a Windows
 * Hub the gateway exited at boot and the app still showed as running.
 *
 * Pure, like proxy-headers.cjs: no side effects on require, so tests/gateway-health.test.mjs can
 * cover it. server.cjs cannot be required from a test.
 */

/**
 * Namespaced under /__ci_* like the wrapper's other paths, because everything the wrapper does
 * not claim is proxied to OpenClaw.
 */
const GATEWAY_HEALTH_PATH = "/__ci_health";

/** A gateway run that ends sooner than this after its spawn failed to start. */
const QUICK_EXIT_MS = 60_000;

/**
 * Failed starts in a row after which the gateway counts as down even while the next attempt
 * runs. Every request restarts a stopped gateway, and OpenClaw's loading page reloads itself
 * every 2.5 seconds, so while anyone has the page open a gateway that dies at boot is almost
 * always "starting". Without this the check would pass exactly when the agent is failing.
 */
const FAILED_STARTS_LIMIT = 3;

/**
 * Tracks the gateway process for the healthcheck. server.cjs calls spawned() and exited()
 * where it sets and clears its own process handle, and describe() on every check.
 *
 * @param {{now?: () => number}} [options]
 */
function createGatewayHealthTracker({ now = Date.now } = {}) {
  let spawnedAt = null;
  let lastExit = null;
  let failedStarts = 0;

  return {
    spawned() {
      spawnedAt = now();
    },

    /**
     * @param {number|null} code
     * @param {string|null} signal
     */
    exited(code, signal) {
      const ranMs = spawnedAt === null ? 0 : now() - spawnedAt;
      spawnedAt = null;
      lastExit = { code, signal };
      // A clean exit or a SIGTERM is a stop someone asked for (the systemctl shim, a shutdown),
      // not a failure. A crash after a long run starts a new count.
      const stoppedOnPurpose = code === 0 || signal === "SIGTERM" || signal === "SIGINT";
      failedStarts = stoppedOnPurpose ? 0 : ranMs < QUICK_EXIT_MS ? failedStarts + 1 : 1;
    },

    /**
     * @param {{configured: boolean, onboarding: boolean, starting: boolean}} state
     *   configured: openclaw.json exists, so the gateway is meant to run. onboarding: the setup
     *   terminal is running `openclaw onboard`. starting: reconcile and doctor are running before
     *   the next spawn.
     * @returns {{healthy: boolean, body: object}}
     */
    describe({ configured, onboarding, starting }) {
      const running = spawnedAt !== null;
      const up = (gateway) => ({ healthy: true, body: { status: "ok", gateway } });
      const down = (gateway) => ({
        healthy: false,
        body: {
          status: "down",
          gateway,
          failedStarts,
          exitCode: lastExit?.code ?? null,
          signal: lastExit?.signal ?? null,
        },
      });

      if (!configured || onboarding) return up("setup");
      // A run that has outlived the quick-exit window is up, whatever came before it.
      if (running && now() - spawnedAt >= QUICK_EXIT_MS) return up("running");
      if (failedStarts >= FAILED_STARTS_LIMIT) return down("failing");
      if (running) return up("running");
      if (starting) return up("starting");
      return down("stopped");
    },
  };
}

/**
 * Answers GATEWAY_HEALTH_PATH: 200 while the gateway runs, starts or waits for setup, 503 once
 * it has stopped or keeps failing to start. Only reads: asking must not restart the gateway, or
 * every check would rerun doctor and the gateway on an app that cannot start, and pass.
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {() => {healthy: boolean, body: object}} describe
 * @returns {boolean} Whether the request was for this path.
 */
function handleGatewayHealthRequest(req, res, describe) {
  if ((req.url || "").split("?")[0] !== GATEWAY_HEALTH_PATH) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return true;
  }
  const { healthy, body } = describe();
  res.writeHead(healthy ? 200 : 503, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
  return true;
}

module.exports = {
  GATEWAY_HEALTH_PATH,
  QUICK_EXIT_MS,
  FAILED_STARTS_LIMIT,
  createGatewayHealthTracker,
  handleGatewayHealthRequest,
};
