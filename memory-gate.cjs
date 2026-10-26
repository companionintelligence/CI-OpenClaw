/**
 * Pure helpers for the Companion Memory connect interstitial.
 *
 * Split out of server.cjs into a sidecar module so the decisions that decide
 * whether a user is shown a blocking gate — and which Hub launcher that gate
 * points at — are unit-testable without standing up the server.
 *
 * The rule these encode, from CI-Engineering#75: never render a gate whose only
 * escape is a URL we cannot verify. The Hub tells us which launchers are usable
 * for THIS browser; if none are, the gate must stand down and let the user into
 * the app rather than trapping them behind a dead button.
 */

/**
 * Return `url` only if it is an http(s) URL; otherwise null.
 *
 * The value arrives from the Hub over the internal network, but it is
 * interpolated straight into an anchor `href`, so a `javascript:` or `data:`
 * scheme must never survive this.
 */
function safeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    // This value is rendered into an <a href> as defense-in-depth against Hub bugs
    // or compromised internal traffic, so require a real host and reject embedded
    // credentials: `http://trusted.com@evil.com/` reads as trusted.com but points
    // at evil.com, exactly the confusion an href must not carry.
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Choose the launcher to put behind the gate's primary action.
 *
 * Public route first; the LAN launcher is a FALLBACK the Hub only supplies when
 * its public origin is unusable and this browser is on the local network. The
 * Hub has already decided which of the two (if either) this caller can reach —
 * this only encodes the preference order and re-validates the scheme.
 *
 * Returns null when neither is usable, which is the caller's signal to suppress
 * the gate entirely.
 */
function selectLauncher(state) {
  if (!state) return null;
  return safeHttpUrl(state.connectUrl) || safeHttpUrl(state.connectUrlLocal);
}

/**
 * Whether the gate should prompt for this connection state.
 *
 * Only `unconfigured` — the user has not decided yet. `connected`, `skipped` and
 * `manual` all mean the question is settled and re-asking would be nagging.
 *
 * Note there is no `deferred` state: the wrappers used to accept one, but the
 * Hub's MemoryConnectionState union never had it, so that branch was dead. The
 * short-lived defer choice is a local cookie, checked separately.
 */
function shouldPromptForState(state) {
  return state === "unconfigured";
}

const { TOKEN_TAG_PARAM } = require("./proxy-headers.cjs");

/** Query parameters that carry dashboard auth: the gateway token itself, or the root redirect's tag. */
const DASHBOARD_AUTH_PARAMS = ["token", TOKEN_TAG_PARAM];

/**
 * The absolute URL the browser used to reach this app, or null when it cannot be
 * determined.
 *
 * Handed to the Hub as the connect flow's `next` so the user returns to the page
 * they started on. This matters most for a LAN visitor: without a `next` the Hub
 * falls back to the app's public URL and silently moves them off the origin they
 * deliberately chose (CI-Engineering#75, Problems 5 and 6).
 *
 * Reads `X-Forwarded-Proto` for the scheme since the app always sits behind the
 * appliance gateway, and falls back to http for a direct LAN hit. Only `https` is
 * honoured; every other value (empty, `ftp`, `javascript`, …) collapses to `http`
 * so a spoofed header can never make `next` a non-http(s) URL handed to the Hub.
 */
function requestAbsoluteUrl(req) {
  const forwardedProto = String((req && req.headers && req.headers["x-forwarded-proto"]) || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const scheme = forwardedProto === "https" ? "https" : "http";
  // Trim the Host: a stray leading/trailing space from an odd proxy would make
  // the base URL unparseable and silently drop the whole `next` deep-link.
  const rawHost = req && req.headers && req.headers.host;
  const host = typeof rawHost === "string" ? rawHost.trim() : "";
  if (!host) return null;
  // Only accept an origin-form request target (a single-leading-slash path).
  // Absolute-form (`http://evil/`), scheme-relative (`//evil/`) and non-path
  // targets (`javascript:...`) would otherwise override the ${scheme}://${host}
  // base inside new URL() and become an off-origin `next` handed to the Hub.
  const rawTarget = req && req.url;
  const path = typeof rawTarget === "string" && rawTarget.startsWith("/") && !rawTarget.startsWith("//") ? rawTarget : "/";
  try {
    const url = new URL(path, `${scheme}://${host}`);
    // The Hub must never see the gateway token (an old `?token=` bookmark). A
    // return to `/?ci_auth=<tag>` would skip the root redirect, so the Control UI
    // would come back with no `#token=` to sign in with. Without them, a return to
    // `/` goes through the redirect again and gets a fresh hash.
    // Only touch the query when one is there: delete() re-encodes the whole query.
    for (const param of DASHBOARD_AUTH_PARAMS) if (url.searchParams.has(param)) url.searchParams.delete(param);
    return url.toString();
  } catch {
    return null;
  }
}

/** Append `next` to a Hub launcher URL, preserving whatever query it already carries. */
function launcherWithNext(launcher, nextUrl) {
  if (!nextUrl) return launcher;
  // Insert `next` BEFORE any fragment: a query placed after `#` is part of the
  // fragment and never sent to the server, which would silently drop the return
  // path. Splitting on `#` keeps the existing encoding and separator logic.
  const hashIndex = launcher.indexOf("#");
  const base = hashIndex === -1 ? launcher : launcher.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : launcher.slice(hashIndex);
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}next=${encodeURIComponent(nextUrl)}${fragment}`;
}

/**
 * Build the Hub `/state` URL for this app, carrying the browser's own Host.
 *
 * `clientHost` is load-bearing: the wrapper calls the Hub server-to-server over
 * the internal docker network, so without it the Hub sees its own container
 * hostname and can never tell a LAN visitor from a remote one — and would
 * therefore never offer the LAN launcher to the callers who need it.
 */
/**
 * Copy Traefik's signed Hub identity onto the wrapper→Hub state call so the
 * Hub can tell which person opened the app (the S2S call is the app key).
 */
function forwardAuthHeaders(req) {
  const headers = req && req.headers ? req.headers : {};
  const out = {};
  for (const name of ["x-ci-hub-user", "x-ci-hub-user-timestamp", "x-ci-hub-user-signature"]) {
    const value = headers[name];
    if (typeof value === "string" && value.trim()) out[name] = value.trim();
  }
  return out;
}

/**
 * Where the gate's "Maybe later" and "Don't ask again" send the browser: the dashboard root,
 * keeping the prepared message the gated page carried.
 *
 * Companion Memory's "Chat in OpenClaw" opens `/?…&prompt=…`. When the gate answers that request,
 * its buttons POST to this wrapper and used to come back to a bare `/`, so the message was lost.
 * The gate page's address arrives as the POST's Referer. Only a same-origin Referer counts, only
 * its `draft` (or Memory's `prompt`) is kept and the answer is always a path on this origin, so a
 * forged Referer can't turn this into an open redirect.
 *
 * Behind the Hub the request's Host is the internal `*.localhost` name the tunnel routes on, and
 * the address the browser used arrives as X-Forwarded-Host, so either one counts.
 *
 * @param {string|undefined} referer the action POST's Referer header
 * @param {...(string|undefined)} hosts the request's Host and X-Forwarded-Host headers
 * @returns {string} "/" or "/?draft=…"
 */
function gateActionReturnPath(referer, ...hosts) {
  const ours = hosts
    .map((value) => (typeof value === "string" ? value.split(",")[0].trim().toLowerCase() : ""))
    .filter(Boolean);
  if (ours.length === 0 || typeof referer !== "string" || !referer) return "/";
  let from;
  try {
    from = new URL(referer);
  } catch {
    return "/";
  }
  if (!ours.includes(from.host.toLowerCase())) return "/";
  const draft = from.searchParams.get("draft") || from.searchParams.get("prompt");
  return draft ? `/?${new URLSearchParams({ draft })}` : "/";
}

function buildStateUrl(hubBase, appUrn, clientHost) {
  const url = new URL(`${hubBase}/api/memory-connect/apps/${encodeURIComponent(appUrn)}/state`);
  // Trim before forwarding: a whitespace-padded Host would otherwise reach the
  // Hub and skew its launcher selection.
  const trimmedHost = typeof clientHost === "string" ? clientHost.trim() : "";
  if (trimmedHost) url.searchParams.set("clientHost", trimmedHost);
  return url;
}

module.exports = {
  buildStateUrl,
  forwardAuthHeaders,
  gateActionReturnPath,
  launcherWithNext,
  requestAbsoluteUrl,
  safeHttpUrl,
  selectLauncher,
  shouldPromptForState,
};
