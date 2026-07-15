/**
 * Header rewriting for the setup server's proxy to the OpenClaw gateway.
 *
 * Extracted from server.cjs for the reason config-reconcile.cjs was: server.cjs binds a port
 * and requires node-pty by absolute container path at import time, so a test cannot require
 * it. This module is pure — no I/O, no side effects on require — so the rules below are
 * actually covered by tests/proxy-headers.test.mjs.
 */

/**
 * Where OpenClaw mounts its own webhook routes (POST /hooks/wake, POST /hooks/agent).
 *
 * This is OpenClaw's default mount point, and `config-reconcile.cjs` (ensureHooksWake) never
 * sets `hooks.path`, so the prefix is fixed at the default. The two are coupled: if reconcile
 * ever writes a non-default `hooks.path`, the real hook routes move but this exception keeps
 * excepting `/hooks`, so the gateway token is re-injected onto the live hook route and every
 * wake silently 401s again (CI-Hub#897). Change both together — the reciprocal note is on
 * ensureHooksWake in config-reconcile.cjs.
 */
const HOOKS_PATH_PREFIX = "/hooks";

/** Whether a proxied request is bound for one of OpenClaw's hook routes. */
function isHookPath(rawUrl) {
  const pathname = String(rawUrl || "").split("?")[0];
  return (
    pathname === HOOKS_PATH_PREFIX ||
    pathname.startsWith(`${HOOKS_PATH_PREFIX}/`)
  );
}

/**
 * Rewrite an inbound request's headers for the gateway.
 *
 * Two jobs:
 *
 * 1. Make the request look local. The gateway checks Origin/Host to block cross-origin
 *    requests (anti-CSRF) and rejects a connection carrying forwarding headers from a source
 *    outside gateway.trustedProxies. Both checks are redundant here — the gateway binds to
 *    127.0.0.1 inside the container, so this proxy is the only thing that can reach it, and
 *    the whole app already sits behind the CI app proxy.
 *
 * 2. Attach the gateway token — EXCEPT on the hook routes.
 *
 * That exception is load-bearing, and its absence is what made the Hub's wake unreachable
 * (CI-Hub#897). OpenClaw's hook auth reads the token like this:
 *
 *     function extractHookToken(req) {
 *       const auth = req.headers.authorization ?? "";
 *       if (auth.toLowerCase().startsWith("bearer ")) {
 *         const token = auth.slice(7).trim();
 *         if (token) return token;      // <-- returns here; x-openclaw-token is never read
 *       }
 *       return req.headers["x-openclaw-token"] || undefined;
 *     }
 *
 * `Authorization: Bearer` WINS, and there is no fallback. So injecting the gateway token on a
 * hook request does not merely fail to help — it SHADOWS the caller's real hook token. The
 * hook then compares the gateway token against `hooks.token`, they differ, and the request
 * 401s. Every wake, regardless of which header the Hub sent it in.
 *
 * Leaving Authorization alone on these routes is safe: OpenClaw guards them with `hooks.token`
 * itself, so an unauthenticated caller still gets a 401 — from the hook, which is the thing
 * that should be deciding.
 */
function buildGatewayHeaders({ reqHeaders, url, gatewayHost, token }) {
  const headers = { ...reqHeaders };

  headers["host"] = gatewayHost;
  headers["origin"] = `http://${gatewayHost}`;

  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-proto"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-port"];
  delete headers["x-real-ip"];
  delete headers["forwarded"];

  if (token && !isHookPath(url)) {
    // Node lowercases inbound header names, so the caller's own Authorization arrives as
    // `authorization`. Drop it before setting the canonical `Authorization`, or the object
    // carries BOTH and the gateway sees whichever the HTTP layer happens to keep. On the
    // gateway routes that is the point — the injected token must be the only one — so make the
    // object say exactly that rather than leaning on downstream case-folding.
    delete headers["authorization"];
    headers["Authorization"] = `Bearer ${token}`;
  }

  return headers;
}

module.exports = {
  HOOKS_PATH_PREFIX,
  isHookPath,
  buildGatewayHeaders,
};
