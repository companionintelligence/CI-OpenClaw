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
 * Headers OpenClaw 2026.9.1+ treats as proxy-shaped (hasForwardedRequestHeaders).
 * Any one of these on a request from a source not in gateway.trustedProxies makes
 * Gateway-authenticated routes return 403 proxy_attribution_required. That is why
 * this proxy strips the whole class, not a fixed list of the common four: Traefik
 * also sends x-forwarded-server / x-forwarded-uri, and those alone reproduce the
 * 403 on 2026.9.1.
 */
function isProxyAttributionHeader(name) {
  const normalized = String(name || "").toLowerCase();
  return (
    normalized === "forwarded" ||
    normalized === "x-real-ip" ||
    normalized.startsWith("x-forwarded-")
  );
}

function stripProxyAttributionHeaders(headers) {
  for (const key of Object.keys(headers)) {
    if (isProxyAttributionHeader(key)) delete headers[key];
  }
}

/**
 * Rewrite an inbound request's headers for the gateway.
 *
 * Two jobs:
 *
 * 1. Make the request look local. The gateway checks Origin/Host to block cross-origin
 *    requests (anti-CSRF) and, since 2026.9.1, rejects any connection that still carries
 *    proxy-shaped headers (see isProxyAttributionHeader) from a source outside
 *    gateway.trustedProxies. Both checks are redundant here — this proxy is the only
 *    thing that should reach the gateway (reconcile pins gateway.bind to loopback), and
 *    the whole app already sits behind the CI app proxy. We do not set trustedProxies
 *    and rebuild X-Forwarded-For: a loopback client IP still fails attribution, which
 *    is exactly the LAN / localhost "Open" path.
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

  stripProxyAttributionHeaders(headers);

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
  isProxyAttributionHeader,
  stripProxyAttributionHeaders,
  buildGatewayHeaders,
};
