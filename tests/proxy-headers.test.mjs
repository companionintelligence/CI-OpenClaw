import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildGatewayHeaders, isHookPath } = require("../proxy-headers.cjs");

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
  });

  test("makes the request look local (anti-CSRF host/origin check)", () => {
    const headers = build("/api/status", { host: "openclaw.example.com", origin: "https://evil.test" });
    assert.equal(headers.host, GATEWAY);
    assert.equal(headers.origin, `http://${GATEWAY}`);
  });

  test("strips the forwarding headers the app proxy injects", () => {
    // The gateway treats a connection carrying these from a source outside trustedProxies as
    // non-local and rejects it.
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
