/**
 * Header rewriting for the setup server's proxy to the OpenClaw gateway, plus the redirect that
 * hands the Control UI its token.
 *
 * Extracted from server.cjs for the reason config-reconcile.cjs was: server.cjs binds a port
 * and requires node-pty by absolute container path at import time, so a test cannot require
 * it. This module does no I/O, so the rules below are actually covered by
 * tests/proxy-headers.test.mjs. Its one piece of state is TOKEN_TAG_KEY, drawn at require time,
 * so gatewayTokenTag gives a different tag in every process.
 */

const crypto = require("crypto");

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

/**
 * Query parameter that marks a dashboard URL as already carrying the current token in its hash.
 *
 * The Control UI reads its gateway token only from the URL hash (`#token=…`), which the browser
 * never sends to a server. So after redirecting `/` to `/#token=…` the next request is a bare
 * `/` again. The proxy needs something it CAN see to stop redirecting. That used to be
 * `?token=<gateway token>` itself, which put the secret in the request line of every visit:
 * through Cloudflare and Traefik, into their logs and into browser history. The marker carries
 * a keyed fingerprint of the token instead (see gatewayTokenTag), which is useless to anyone who
 * reads it but still changes when the token does.
 */
const TOKEN_TAG_PARAM = "ci_auth";

/**
 * Key for gatewayTokenTag, made fresh each time the wrapper starts. The tag ends up in proxy logs
 * and browser history. A plain hash of the token there would let anyone holding those logs
 * check guesses of a weak, hand-picked token offline. A new key per start only costs one extra
 * redirect for a browser that opens `/` with a tag from before the restart.
 */
const TOKEN_TAG_KEY = crypto.randomBytes(32);

/**
 * How long a tagged `/` skips the redirect. The tag only says "this URL came out of the redirect",
 * not "this tab holds the token": the Control UI keeps the token in sessionStorage, so a new tab
 * that opens a tagged `/` from history or a bookmark has none. Past this age the same URL goes
 * through the redirect again and gets a fresh `#token=`. Two minutes covers the browser's
 * follow-up request and the loading page's reloads while the gateway starts.
 */
const TOKEN_TAG_TTL_MS = 2 * 60 * 1000;

/** How far into the future a tag's time may be, for a wall clock that steps back a little. */
const TOKEN_TAG_CLOCK_SLACK_MS = 5 * 1000;

function tagMac(issued, token) {
  return crypto.createHmac("sha256", TOKEN_TAG_KEY).update(`${issued}.${String(token)}`).digest("hex").slice(0, 16);
}

/**
 * A short keyed fingerprint of the gateway token, stamped with the time it was made:
 * `<seconds, base 36>.<16 hex digits>`. A new token gives a new tag, so a browser still holding an
 * old dashboard URL is sent through the redirect again and its hash resynced.
 */
function gatewayTokenTag(token, now = Date.now()) {
  const issued = Math.floor(now / 1000).toString(36);
  return `${issued}.${tagMac(issued, token)}`;
}

/** Was `tag` made by gatewayTokenTag for this token, in this process, less than TOKEN_TAG_TTL_MS ago? */
function isCurrentTokenTag(tag, token, now = Date.now()) {
  const match = /^([0-9a-z]{1,11})\.([0-9a-f]{16})$/.exec(String(tag || ""));
  if (!match) return false;
  const age = now - parseInt(match[1], 36) * 1000;
  if (age < -TOKEN_TAG_CLOCK_SLACK_MS || age > TOKEN_TAG_TTL_MS) return false;
  const expected = Buffer.from(tagMac(match[1], token));
  const given = Buffer.from(match[2]);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/**
 * Where to send a browser that opened the dashboard root, or null to proxy the request as is.
 *
 * Only a `/` that lacks a current tag for this token redirects. The token rides in
 * the hash, never in the query.
 *
 * The request target is split on `?` the way isHookPath does it, not parsed with `new URL()`.
 * `new URL()` reads a target that starts with `//` as an authority. `GET //` throws, which an
 * async request handler never answers. `GET //chat` comes back with path `/`.
 */
function gatewayRootRedirect(rawUrl, token, now = Date.now()) {
  if (!token) return null;
  const target = String(rawUrl || "/").split("#")[0];
  const queryStart = target.indexOf("?");
  const pathname = queryStart === -1 ? target : target.slice(0, queryStart);
  if (pathname !== "/") return null;
  const query = new URLSearchParams(queryStart === -1 ? "" : target.slice(queryStart + 1));
  if (isCurrentTokenTag(query.get(TOKEN_TAG_PARAM), token, now)) return null;
  return `/?${TOKEN_TAG_PARAM}=${gatewayTokenTag(token, now)}#token=${encodeURIComponent(token)}`;
}

module.exports = {
  TOKEN_TAG_TTL_MS,
  gatewayTokenTag,
  isCurrentTokenTag,
  gatewayRootRedirect,
  HOOKS_PATH_PREFIX,
  isHookPath,
  isProxyAttributionHeader,
  stripProxyAttributionHeaders,
  buildGatewayHeaders,
};
