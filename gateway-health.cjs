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

/**
 * @param {object} state What server.cjs knows about the gateway right now.
 * @param {boolean} state.configured openclaw.json exists, so the gateway is meant to run.
 * @param {boolean} state.onboarding The setup terminal is running `openclaw onboard`.
 * @param {boolean} state.running A gateway process exists. It may still be booting.
 * @param {boolean} state.starting Reconcile and doctor are running before the gateway spawns.
 * @param {{code: number|null, signal: string|null}|null} state.lastExit How the last gateway run ended.
 * @returns {{healthy: boolean, body: object}}
 */
function describeGatewayHealth({ configured, onboarding, running, starting, lastExit }) {
  if (!configured || onboarding) {
    return { healthy: true, body: { status: "ok", gateway: "setup" } };
  }
  if (running) {
    return { healthy: true, body: { status: "ok", gateway: "running" } };
  }
  if (starting) {
    return { healthy: true, body: { status: "ok", gateway: "starting" } };
  }
  return {
    healthy: false,
    body: {
      status: "down",
      gateway: "stopped",
      exitCode: lastExit?.code ?? null,
      signal: lastExit?.signal ?? null,
    },
  };
}

/**
 * Answers GATEWAY_HEALTH_PATH: 200 while the gateway runs, starts or waits for setup, 503 once
 * it has stopped. Only reads the state: asking must not restart the gateway, or every check
 * would rerun doctor and the gateway on an app that cannot start.
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {() => Parameters<typeof describeGatewayHealth>[0]} getState
 * @returns {boolean} Whether the request was for this path.
 */
function handleGatewayHealthRequest(req, res, getState) {
  if ((req.url || "").split("?")[0] !== GATEWAY_HEALTH_PATH) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return true;
  }
  const { healthy, body } = describeGatewayHealth(getState());
  res.writeHead(healthy ? 200 : 503, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
  return true;
}

module.exports = { GATEWAY_HEALTH_PATH, describeGatewayHealth, handleGatewayHealthRequest };
