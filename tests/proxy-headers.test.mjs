import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const {
  buildGatewayHeaders,
  isHookPath,
  gatewayRootRedirect,
  gatewayTokenTag,
  isCurrentTokenTag,
  TOKEN_TAG_TTL_MS,
} = require("../proxy-headers.cjs");

const GATEWAY = "127.0.0.1:18790";
const GATEWAY_TOKEN = "gateway-shared-secret";
const WAKE_SECRET = "hub-wake-secret";

const build = (url, reqHeaders = {}) =>
  buildGatewayHeaders({
    reqHeaders,
    url,
    gatewayHost: GATEWAY,
    token: GATEWAY_TOKEN,
  });

// ---------------------------------------------------------------------------
// The hook-route exception.
//
// This is the second of the two walls that made the Hub's wake unreachable (CI-Hub#897).
// The first was a 404 — the plugin's route was never mounted. Fixing that only exposed this
// one: OpenClaw's extractHookToken() reads `Authorization: Bearer` FIRST and returns as soon
// as it finds a non-empty token, never falling back to X-OpenClaw-Token. So injecting the
// gateway token here SHADOWS the caller's real hook token, the hook compares the wrong secret
// against hooks.token, and every wake 401s — whichever header the Hub used.
//
// Measured on core-2 before the fix: POST /hooks/wake through this proxy -> 401, while the
// identical request straight to the gateway -> 200 {"ok":true,"mode":"now"}.
// ---------------------------------------------------------------------------
describe("buildGatewayHeaders: hook routes must keep their own auth", () => {
  test("does NOT inject the gateway token on /hooks/wake", () => {
    const headers = build("/hooks/wake", {
      "x-openclaw-token": WAKE_SECRET,
      "content-type": "application/json",
    });

    assert.equal(headers.Authorization, undefined);
    assert.equal(headers.authorization, undefined);
    // ...and the caller's real hook token is passed through untouched.
    assert.equal(headers["x-openclaw-token"], WAKE_SECRET);
  });

  test("does not shadow a caller's own Authorization on a hook route", () => {
    // The Hub sends the wake secret in BOTH headers. Bearer wins in extractHookToken, so if
    // we overwrote it with the gateway token the request would 401 even though the caller
    // authenticated correctly.
    const headers = build("/hooks/wake", {
      authorization: `Bearer ${WAKE_SECRET}`,
      "x-openclaw-token": WAKE_SECRET,
    });

    assert.equal(headers.authorization, `Bearer ${WAKE_SECRET}`);
    assert.equal(headers.Authorization, undefined);
  });

  test("covers the whole hook mount, not just /hooks/wake", () => {
    for (const url of ["/hooks", "/hooks/wake", "/hooks/agent", "/hooks/wake?x=1"]) {
      const headers = build(url, {});
      assert.equal(headers.Authorization, undefined, `gateway token leaked onto ${url}`);
    }
  });

  test("a query string cannot smuggle a hook path past the check", () => {
    assert.equal(isHookPath("/hooks/wake?mode=now"), true);
    // ...and cannot fake one either: the path, not the query, decides.
    assert.equal(isHookPath("/api/status?next=/hooks/wake"), false);
  });

  test("a lookalike prefix is NOT treated as a hook route", () => {
    // /hooksomething must still get the gateway token — it is an ordinary gateway route.
    const headers = build("/hooksomething", {});
    assert.equal(headers.Authorization, `Bearer ${GATEWAY_TOKEN}`);
    assert.equal(isHookPath("/hooksomething"), false);
  });
});

// ---------------------------------------------------------------------------
// Everything else must keep working exactly as before — this is the behavior the Control UI
// depends on, and the reason the token is injected at all.
// ---------------------------------------------------------------------------
describe("buildGatewayHeaders: ordinary gateway routes", () => {
  test("still injects the gateway token", () => {
    assert.equal(build("/", {}).Authorization, `Bearer ${GATEWAY_TOKEN}`);
    assert.equal(build("/api/status", {}).Authorization, `Bearer ${GATEWAY_TOKEN}`);
  });

  test("overwrites a client-supplied Authorization (a stale Control UI token)", () => {
    const headers = build("/api/status", { authorization: "Bearer stale-token" });
    assert.equal(headers.Authorization, `Bearer ${GATEWAY_TOKEN}`);
    // The stale lowercase key must not survive alongside the injected one — otherwise the
    // object carries two tokens and which one reaches the gateway is left to case-folding.
    assert.equal(headers.authorization, undefined);
  });

  test("makes the request look local (anti-CSRF host/origin check)", () => {
    const headers = build("/api/status", { host: "openclaw.example.com", origin: "https://evil.test" });
    assert.equal(headers.host, GATEWAY);
    assert.equal(headers.origin, `http://${GATEWAY}`);
  });

  test("strips the forwarding headers the app proxy injects", () => {
    // OpenClaw 2026.9.1 treats ANY of these as proxy-shaped. A leftover one from a
    // source outside trustedProxies is a 403 proxy_attribution_required.
    const headers = build("/api/status", {
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "openclaw.example.com",
      "x-forwarded-port": "443",
      "x-real-ip": "1.2.3.4",
      forwarded: "for=1.2.3.4",
    });

    for (const h of ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port", "x-real-ip", "forwarded"]) {
      assert.equal(headers[h], undefined, `${h} survived`);
    }
  });

  test("strips Traefik extras, not just the common four (2026.9.1 attribution)", () => {
    // Measured on ci-openclaw-core-bc after the 2026.9.1 bump: curl with only
    // x-forwarded-for/proto/host is 404 (auth passed; no /api/status), but adding
    // x-forwarded-server: traefik is 403 proxy_attribution_required. Traefik also
    // injects x-forwarded-uri for forward-auth. The old allowlist missed both.
    const headers = build("/api/status", {
      "x-forwarded-server": "traefik",
      "x-forwarded-uri": "/",
      "x-forwarded-prefix": "/",
      "x-forwarded-scheme": "https",
      "X-Forwarded-Server": "mixed-case-should-still-go",
    });

    for (const h of [
      "x-forwarded-server",
      "x-forwarded-uri",
      "x-forwarded-prefix",
      "x-forwarded-scheme",
      "X-Forwarded-Server",
    ]) {
      assert.equal(headers[h], undefined, `${h} survived`);
    }
    assert.equal(headers.Authorization, `Bearer ${GATEWAY_TOKEN}`);
  });

  test("strips forwarding headers on hook routes too", () => {
    // The hook exception is about auth only — it must not smuggle the app proxy's forwarding
    // headers through, or the gateway rejects the connection as non-local.
    const headers = build("/hooks/wake", { "x-forwarded-for": "1.2.3.4", "x-real-ip": "1.2.3.4" });
    assert.equal(headers["x-forwarded-for"], undefined);
    assert.equal(headers["x-real-ip"], undefined);
  });

  test("injects nothing when there is no gateway token", () => {
    const headers = buildGatewayHeaders({
      reqHeaders: {},
      url: "/api/status",
      gatewayHost: GATEWAY,
      token: "",
    });
    assert.equal(headers.Authorization, undefined);
  });

  test("does not mutate the caller's header object", () => {
    const reqHeaders = { host: "original.example" };
    build("/api/status", reqHeaders);
    assert.equal(reqHeaders.host, "original.example");
  });
});

// ---------------------------------------------------------------------------
// The dashboard root redirect hands the Control UI its token in the URL hash. It used to put the
// token in the query too (/?token=<token>#token=<token>), only so the next request could be told
// apart from the first. The query travels in the request line, so the gateway token went through
// Cloudflare and Traefik, into their logs and into browser history, on every visit to /.
// ---------------------------------------------------------------------------
describe("gatewayRootRedirect: the token stays out of the query", () => {
  // A fixed clock, so a test never straddles a second boundary between making a tag and checking it.
  const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
  const TAG = gatewayTokenTag(GATEWAY_TOKEN, NOW);
  const redirect = (url, token = GATEWAY_TOKEN, now = NOW) => gatewayRootRedirect(url, token, now);

  test("redirects / to a tagged URL with the token only in the hash", () => {
    const location = redirect("/", GATEWAY_TOKEN);
    assert.equal(location, `/?ci_auth=${TAG}#token=${GATEWAY_TOKEN}`);
    const [beforeHash, hash] = location.split("#");
    assert.ok(!beforeHash.includes(GATEWAY_TOKEN), "token leaked into the path or query");
    assert.equal(hash, `token=${GATEWAY_TOKEN}`);
  });

  test("the tag is a fingerprint, not the token", () => {
    assert.match(TAG, /^[0-9a-z]+\.[0-9a-f]{16}$/);
    assert.ok(!GATEWAY_TOKEN.includes(TAG) && !TAG.includes(GATEWAY_TOKEN));
    assert.equal(gatewayTokenTag(GATEWAY_TOKEN, NOW), TAG, "the same token and time give the same tag");
  });

  // The tag lands in proxy logs. An unkeyed hash there would let whoever reads them test guesses
  // of a hand-picked token offline.
  test("the tag is not a plain hash of the token", () => {
    const plain = createHash("sha256").update(GATEWAY_TOKEN).digest("hex");
    assert.ok(!plain.includes(TAG.split(".")[1]), "the tag is an unkeyed SHA-256 prefix");
  });

  test("a URL that already has the current tag goes through (no redirect loop)", () => {
    assert.equal(redirect(`/?ci_auth=${TAG}`, GATEWAY_TOKEN), null);
  });

  test("a URL tagged for an older token is redirected again, so the hash resyncs", () => {
    const stale = gatewayTokenTag("old-gateway-token", NOW);
    assert.notEqual(stale, TAG);
    assert.equal(redirect(`/?ci_auth=${stale}`, GATEWAY_TOKEN), `/?ci_auth=${TAG}#token=${GATEWAY_TOKEN}`);
  });

  test("an old ?token= bookmark is moved to the tagged form", () => {
    assert.equal(redirect(`/?token=${GATEWAY_TOKEN}`, GATEWAY_TOKEN), `/?ci_auth=${TAG}#token=${GATEWAY_TOKEN}`);
  });

  // The Control UI keeps the token in sessionStorage, so a new tab has none. A tagged / opened later
  // from history or a bookmark must be redirected again, or that tab opens with no token at all.
  test("a tag stops redirecting once it is two minutes old", () => {
    assert.equal(TOKEN_TAG_TTL_MS, 2 * 60 * 1000);
    assert.equal(redirect(`/?ci_auth=${TAG}`, GATEWAY_TOKEN, NOW + TOKEN_TAG_TTL_MS), null);
    const later = NOW + TOKEN_TAG_TTL_MS + 1000;
    assert.equal(redirect(`/?ci_auth=${TAG}`, GATEWAY_TOKEN, later), `/?ci_auth=${gatewayTokenTag(GATEWAY_TOKEN, later)}#token=${GATEWAY_TOKEN}`);
  });

  test("a tag dated in the future, forged or malformed is redirected again", () => {
    const future = gatewayTokenTag(GATEWAY_TOKEN, NOW + 60 * 1000);
    const [issued, mac] = TAG.split(".");
    const flipped = `${issued}.${mac.slice(0, -1)}${mac.endsWith("0") ? "1" : "0"}`;
    const restamped = `${(parseInt(issued, 36) + 30).toString(36)}.${mac}`;
    for (const tag of [future, flipped, restamped, mac, `${issued}.`, ".", "", `${TAG}x`]) {
      assert.equal(isCurrentTokenTag(tag, GATEWAY_TOKEN, NOW), false, tag);
      assert.notEqual(redirect(`/?ci_auth=${encodeURIComponent(tag)}`), null, tag);
    }
    assert.equal(isCurrentTokenTag(TAG, GATEWAY_TOKEN, NOW), true);
  });

  test("only the root redirects", () => {
    for (const url of ["/chat/main", "/api/status", "/assets/index.js", "/__ci_memory/skip"]) {
      assert.equal(redirect(url, GATEWAY_TOKEN), null, url);
    }
  });

  // `new URL("//", base)` throws and `new URL("//chat", base)` has path `/`. A throw here would
  // leave the request unanswered. A `//chat` misread as `/` would be bounced to the root.
  test("a target that starts with // is proxied, not parsed as a host", () => {
    for (const url of ["//", "///", "//?ci_auth=x", "//chat", "//[", "//a:b@"]) {
      assert.equal(redirect(url, GATEWAY_TOKEN), null, url);
    }
  });

  test("the tag still matches when other parameters come first", () => {
    assert.equal(redirect(`/?session=main&ci_auth=${TAG}`, GATEWAY_TOKEN), null);
  });

  test("no token, no redirect", () => {
    assert.equal(gatewayRootRedirect("/", "", NOW), null);
    assert.equal(gatewayRootRedirect("/", undefined, NOW), null);
  });

  test("a token with reserved characters is encoded in the hash", () => {
    const location = redirect("/", "a b&c#d");
    assert.ok(location.endsWith("#token=a%20b%26c%23d"), location);
  });
});

// ---------------------------------------------------------------------------
// Companion Memory's "Chat in OpenClaw" opens the dashboard root with the prepared message in the
// query. The redirect used to replace the whole query, so OpenClaw opened with an empty box.
// ---------------------------------------------------------------------------
describe("gatewayRootRedirect: Memory's prepared message survives", () => {
  const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
  const TAG = gatewayTokenTag(GATEWAY_TOKEN, NOW);
  const redirect = (url) => gatewayRootRedirect(url, GATEWAY_TOKEN, NOW);
  const query = (location) => new URLSearchParams(location.split("#")[0].split("?")[1]);

  test("Memory's prompt becomes the Control UI's draft and nothing else is carried", () => {
    const prompt = "I'd like to talk about \"Coffee with Jordan Lee\":\n\nWhen: Oct 23, 2026";
    const from = "/?" + new URLSearchParams({
      title: "Coffee with Jordan Lee",
      prompt,
      context: "When: Oct 23, 2026",
      memoryId: "f3c0a6d2-1111-4c1e-9a55-0a1b2c3d4e5f",
      memoryKind: "EventType",
    }).toString();
    const location = redirect(from);
    const q = query(location);
    assert.equal(q.get("draft"), prompt);
    assert.equal(q.has("prompt"), false, "the prompt is not sent twice");
    assert.equal(q.get("ci_auth"), TAG);
    assert.deepEqual([...q.keys()].sort(), ["ci_auth", "draft"]);
    assert.ok(location.endsWith(`#token=${GATEWAY_TOKEN}`), location);
  });

  test("the redirected URL is not redirected again, so the draft reaches the Control UI", () => {
    const location = redirect("/?prompt=hello");
    assert.equal(redirect(location.split("#")[0]), null);
  });

  test("an explicit draft wins over prompt", () => {
    const q = query(redirect("/?draft=mine&prompt=theirs"));
    assert.equal(q.get("draft"), "mine");
    assert.equal(q.has("prompt"), false);
  });

  test("a token in the incoming query is dropped, never carried into the new query", () => {
    const location = redirect(`/?token=${GATEWAY_TOKEN}&prompt=hi`);
    assert.ok(!location.split("#")[0].includes(GATEWAY_TOKEN), location);
    assert.equal(query(location).get("draft"), "hi");
  });

  // The Control UI connects to a `gatewayUrl` from the query, after a confirmation dialog, and
  // hands it the `#token=` this redirect adds. Kept, a link could ship the token anywhere.
  test("parameters the Control UI acts on are not carried next to the token", () => {
    const from = "/?" + new URLSearchParams({
      gatewayUrl: "wss://attacker.example",
      password: "x",
      session: "agent:main:x",
      draft: "hi",
    }).toString();
    const q = query(redirect(from));
    assert.deepEqual([...q.keys()].sort(), ["ci_auth", "draft"]);
    assert.equal(q.get("draft"), "hi");
  });

  test("with no prompt or draft only the tag is set", () => {
    assert.equal(redirect("/?title=x"), `/?ci_auth=${TAG}#token=${GATEWAY_TOKEN}`);
  });

  test("a stale tag is replaced, not duplicated", () => {
    const q = query(redirect("/?ci_auth=0000000000000000&prompt=hi"));
    assert.deepEqual(q.getAll("ci_auth"), [TAG]);
  });

  // The Control UI only reads `draft`, so a current tag must not let a `prompt` through untranslated.
  test("a prompt next to the current tag still becomes the draft", () => {
    const location = redirect(`/?ci_auth=${TAG}&prompt=hi`);
    assert.equal(location, `/?draft=hi&ci_auth=${TAG}#token=${GATEWAY_TOKEN}`);
    assert.equal(redirect(location.split("#")[0]), null);
  });
});
