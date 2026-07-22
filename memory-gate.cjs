/**
 * Pure helpers for the Companion Memory connect interstitial.
 *
 * Split out of server.cjs (mirroring proxy-headers.cjs) so the decisions that
 * decide whether a user is shown a blocking gate — and which Hub launcher that
 * gate points at — are unit-testable without standing up the server.
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
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
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

/**
 * The absolute URL the browser used to reach this app, or null when it cannot be
 * determined.
 *
 * Handed to the Hub as the connect flow's `next` so the user returns to the page
 * they started on. This matters most for a LAN visitor: without a `next` the Hub
 * falls back to the app's public URL and silently moves them off the origin they
 * deliberately chose (CI-Engineering#75, Problems 5 and 6).
 *
 * Trusts `X-Forwarded-Proto` for the scheme since the app always sits behind the
 * appliance gateway, and falls back to http for a direct LAN hit.
 */
function requestAbsoluteUrl(req) {
  const forwardedProto = String((req && req.headers && req.headers["x-forwarded-proto"]) || "")
    .split(",")[0]
    .trim();
  const host = req && req.headers && req.headers.host;
  if (!host) return null;
  try {
    return new URL((req && req.url) || "/", `${forwardedProto || "http"}://${host}`).toString();
  } catch {
    return null;
  }
}

/** Append `next` to a Hub launcher URL, preserving whatever query it already carries. */
function launcherWithNext(launcher, nextUrl) {
  if (!nextUrl) return launcher;
  const separator = launcher.includes("?") ? "&" : "?";
  return `${launcher}${separator}next=${encodeURIComponent(nextUrl)}`;
}

/**
 * Build the Hub `/state` URL for this app, carrying the browser's own Host.
 *
 * `clientHost` is load-bearing: the wrapper calls the Hub server-to-server over
 * the internal docker network, so without it the Hub sees its own container
 * hostname and can never tell a LAN visitor from a remote one — and would
 * therefore never offer the LAN launcher to the callers who need it.
 */
function buildStateUrl(hubBase, appUrn, clientHost) {
  const url = new URL(`${hubBase}/api/memory-connect/apps/${encodeURIComponent(appUrn)}/state`);
  if (clientHost) url.searchParams.set("clientHost", clientHost);
  return url;
}

module.exports = {
  buildStateUrl,
  launcherWithNext,
  requestAbsoluteUrl,
  safeHttpUrl,
  selectLauncher,
  shouldPromptForState,
};
