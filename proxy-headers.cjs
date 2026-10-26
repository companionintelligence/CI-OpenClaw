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
 * A short keyed fingerprint of the gateway token. A new token gives a new tag, so a browser
 * still holding an old dashboard URL is sent through the redirect again and its hash resynced.
 */
function gatewayTokenTag(token) {
  return crypto.createHmac("sha256", TOKEN_TAG_KEY).update(String(token)).digest("hex").slice(0, 16);
}

/**
 * Where to send a browser that opened the dashboard root, or null to proxy the request as is.
 *
 * Only a `/` that lacks the current token's tag redirects. The token rides in
 * the hash, never in the query.
 *
 * The prepared message comes along. Companion Memory's "Chat in OpenClaw" opens
 * `/?title=…&prompt=…&context=…&memoryId=…&memoryKind=…`, and this redirect used to drop all of
 * it, so the message never arrived. The Control UI pre-fills its message box from `?draft=`, so
 * `prompt` is handed over under that name (an explicit `draft` wins).
 *
 * Nothing else in the query is kept. This redirect is the one response that pairs the query with
 * the real token, and the Control UI acts on more of the query than the draft: `gatewayUrl` asks
 * it to connect to another gateway, and it hands that gateway the `#token=` it finds next to it.
 * Carrying the query through would let a link to `/?gatewayUrl=wss://elsewhere` send the token
 * there after one click on a confirmation dialog.
 *
 * The request target is split on `?` the way isHookPath does it, not parsed with `new URL()`.
 * `new URL()` reads a target that starts with `//` as an authority. `GET //` throws, which an
 * async request handler never answers. `GET //chat` comes back with path `/`.
 */
function gatewayRootRedirect(rawUrl, token) {
  if (!token) return null;
  const target = String(rawUrl || "/").split("#")[0];
  const queryStart = target.indexOf("?");
  const pathname = queryStart === -1 ? target : target.slice(0, queryStart);
  if (pathname !== "/") return null;
  const query = new URLSearchParams(queryStart === -1 ? "" : target.slice(queryStart + 1));
  const tag = gatewayTokenTag(token);
  if (query.get(TOKEN_TAG_PARAM) === tag) return null;

  const next = new URLSearchParams();
  const draft = query.get("draft") || query.get("prompt");
  if (draft) next.set("draft", draft);
  next.set(TOKEN_TAG_PARAM, tag);
  return `/?${next.toString()}#token=${encodeURIComponent(token)}`;
}

module.exports = {
  gatewayTokenTag,
  gatewayRootRedirect,
  HOOKS_PATH_PREFIX,
  isHookPath,
  isProxyAttributionHeader,
  stripProxyAttributionHeaders,
  buildGatewayHeaders,
};
