import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildStateUrl,
  forwardAuthHeaders,
  launcherWithNext,
  requestAbsoluteUrl,
  safeHttpUrl,
  selectLauncher,
  shouldPromptForState,
} = require("../memory-gate.cjs");

// ---------------------------------------------------------------------------
// The connect gate is the only blocking screen this wrapper renders, so its
// failure mode is severe: a gate whose button points at an unreachable origin
// leaves the user stranded on a Cloudflare error page with no route back to the
// app (CI-Engineering#75). These lock down the two decisions that prevent that —
// which launcher to use, and when to stand down entirely.
// ---------------------------------------------------------------------------

describe("selectLauncher: which Hub launcher the gate points at", () => {
  test("prefers the public launcher when the Hub offers one", () => {
    const launcher = selectLauncher({
      connectUrl: "https://hub.example.com/api/memory-connect/start?app=x",
      connectUrlLocal: "http://192.168.1.9/api/memory-connect/start?app=x",
    });

    assert.equal(launcher, "https://hub.example.com/api/memory-connect/start?app=x");
  });

  test("falls back to the LAN launcher when the public route is unusable", () => {
    // The Hub nulls connectUrl once its public origin is confirmed down, and
    // supplies connectUrlLocal only to a caller that can actually route to it.
    const launcher = selectLauncher({
      connectUrl: null,
      connectUrlLocal: "http://192.168.1.9/api/memory-connect/start?app=x",
    });

    assert.equal(launcher, "http://192.168.1.9/api/memory-connect/start?app=x");
  });

  test("returns null when neither launcher is usable, so the gate stands down", () => {
    assert.equal(selectLauncher({ connectUrl: null, connectUrlLocal: null }), null);
    assert.equal(selectLauncher(undefined), null);
  });

  test("rejects a non-http(s) scheme even if the Hub sent one", () => {
    // Defence in depth: this value is interpolated into an anchor href.
    assert.equal(selectLauncher({ connectUrl: "javascript:alert(1)", connectUrlLocal: null }), null);
    assert.equal(selectLauncher({ connectUrl: "data:text/html,<script>", connectUrlLocal: null }), null);
  });

  test("skips an unusable public launcher and still finds the LAN one", () => {
    const launcher = selectLauncher({
      connectUrl: "javascript:alert(1)",
      connectUrlLocal: "http://192.168.1.9/api/memory-connect/start?app=x",
    });

    assert.equal(launcher, "http://192.168.1.9/api/memory-connect/start?app=x");
  });
});

describe("shouldPromptForState: when the gate is allowed to block", () => {
  test("prompts only for an undecided connection", () => {
    assert.equal(shouldPromptForState("unconfigured"), true);
  });

  test("never re-asks once the user has decided", () => {
    for (const state of ["connected", "skipped", "manual"]) {
      assert.equal(shouldPromptForState(state), false, `${state} must not re-prompt`);
    }
  });

  test("does not recognise a 'deferred' state", () => {
    // Both wrappers used to accept this, but the Hub's MemoryConnectionState
    // union never had it — the branch was dead and is now gone.
    assert.equal(shouldPromptForState("deferred"), false);
  });

  test("fails closed on an unknown or missing state", () => {
    assert.equal(shouldPromptForState(undefined), false);
    assert.equal(shouldPromptForState("something_new"), false);
  });
});

describe("requestAbsoluteUrl: where to send the user back to", () => {
  test("reconstructs the LAN URL the browser actually used", () => {
    const url = requestAbsoluteUrl({ url: "/chat?id=7", headers: { host: "192.168.1.9:8080" } });

    // Preserving this is what stops the Hub relocating a LAN visitor onto the
    // public origin at the end of the connect flow.
    assert.equal(url, "http://192.168.1.9:8080/chat?id=7");
  });

  test("honours X-Forwarded-Proto from the appliance gateway", () => {
    const url = requestAbsoluteUrl({
      url: "/",
      headers: { host: "app.example.com", "x-forwarded-proto": "https" },
    });

    assert.equal(url, "https://app.example.com/");
  });

  test("uses only the first proto in a comma-joined chain", () => {
    const url = requestAbsoluteUrl({
      url: "/",
      headers: { host: "app.example.com", "x-forwarded-proto": "https,http" },
    });

    assert.equal(url, "https://app.example.com/");
  });

  test("collapses a non-http(s) proto to http so `next` is never a foreign scheme", () => {
    for (const proto of ["ftp", "javascript", "file", "HTTPS://evil"]) {
      const url = requestAbsoluteUrl({
        url: "/",
        headers: { host: "app.example.com", "x-forwarded-proto": proto },
      });

      // A spoofed X-Forwarded-Proto must not produce a next the Hub would honour
      // as anything but http/https.
      assert.equal(url, "http://app.example.com/");
    }
  });

  test("ignores an off-origin request target so `next` can't escape the app's origin", () => {
    // Absolute-form / scheme-relative / non-path targets would otherwise override
    // the ${scheme}://${host} base and become an off-origin next handed to the Hub.
    for (const target of ["http://evil.com/", "//evil.com/", "https://evil.com/path", "javascript:alert(1)"]) {
      const url = requestAbsoluteUrl({ url: target, headers: { host: "app.example.com" } });

      assert.equal(url, "http://app.example.com/");
    }
  });

  test("trims a whitespace-padded Host instead of dropping the deep-link", () => {
    const url = requestAbsoluteUrl({ url: "/chat", headers: { host: "  192.168.1.9:8080  " } });

    // An untrimmed padded Host makes the base URL unparseable and returns null,
    // silently losing the return path.
    assert.equal(url, "http://192.168.1.9:8080/chat");
  });

  test("returns null without a Host rather than inventing an origin", () => {
    assert.equal(requestAbsoluteUrl({ url: "/", headers: {} }), null);
    assert.equal(requestAbsoluteUrl({ headers: {} }), null);
  });
});

describe("launcherWithNext", () => {
  test("appends next with & when the launcher already has a query", () => {
    const out = launcherWithNext("https://hub.example.com/start?app=x", "http://192.168.1.9/chat");

    assert.equal(out, "https://hub.example.com/start?app=x&next=http%3A%2F%2F192.168.1.9%2Fchat");
  });

  test("appends next with ? when the launcher has none", () => {
    const out = launcherWithNext("https://hub.example.com/start", "http://192.168.1.9/");

    assert.equal(out, "https://hub.example.com/start?next=http%3A%2F%2F192.168.1.9%2F");
  });

  test("leaves the launcher untouched when there is no next to add", () => {
    assert.equal(launcherWithNext("https://hub.example.com/start?app=x", null), "https://hub.example.com/start?app=x");
  });

  test("inserts next ahead of a fragment so the query isn't swallowed by the hash", () => {
    const out = launcherWithNext("https://hub.example.com/start#section", "http://192.168.1.9/chat");

    assert.equal(out, "https://hub.example.com/start?next=http%3A%2F%2F192.168.1.9%2Fchat#section");
  });
});

describe("forwardAuthHeaders", () => {
  test("copies the signed Hub identity Traefik planted on the browser request", () => {
    const headers = forwardAuthHeaders({
      headers: {
        "x-ci-hub-user": "hello@lifescope.io",
        "x-ci-hub-user-timestamp": "1700000000000",
        "x-ci-hub-user-signature": "abc",
        host: "openclaw.example.com",
      },
    });

    assert.deepEqual(headers, {
      "x-ci-hub-user": "hello@lifescope.io",
      "x-ci-hub-user-timestamp": "1700000000000",
      "x-ci-hub-user-signature": "abc",
    });
  });

  test("omits missing or blank identity headers", () => {
    assert.deepEqual(forwardAuthHeaders({ headers: { host: "openclaw.example.com" } }), {});
  });
});

describe("buildStateUrl", () => {
  test("carries the browser's Host so the Hub can tell a LAN visitor from a remote one", () => {
    const url = buildStateUrl("http://ci-os-hub:5002", "ci-openclaw:ci-marketplace", "192.168.1.9:8080");

    // Without clientHost the Hub only sees this container's internal hostname
    // and could never offer the LAN launcher to the callers who need it.
    assert.equal(url.pathname, "/api/memory-connect/apps/ci-openclaw%3Aci-marketplace/state");
    assert.equal(url.searchParams.get("clientHost"), "192.168.1.9:8080");
  });

  test("trims a whitespace-padded clientHost before forwarding it", () => {
    const url = buildStateUrl("http://ci-os-hub:5002", "ci-openclaw:ci-marketplace", "  192.168.1.9:8080  ");

    assert.equal(url.searchParams.get("clientHost"), "192.168.1.9:8080");
  });

  test("omits clientHost when the Host header is absent", () => {
    const url = buildStateUrl("http://ci-os-hub:5002", "ci-openclaw:ci-marketplace", undefined);

    assert.equal(url.searchParams.has("clientHost"), false);
  });

  test("percent-encodes the URN's colon", () => {
    const url = buildStateUrl("http://ci-os-hub:5002", "a:b", "h");

    assert.ok(url.toString().includes("a%3Ab"));
  });
});

describe("safeHttpUrl", () => {
  test("accepts http and https", () => {
    assert.equal(safeHttpUrl("http://a.example/x"), "http://a.example/x");
    assert.equal(safeHttpUrl("https://a.example/x"), "https://a.example/x");
  });

  test("rejects other schemes and garbage", () => {
    assert.equal(safeHttpUrl("javascript:alert(1)"), null);
    assert.equal(safeHttpUrl("file:///etc/passwd"), null);
    assert.equal(safeHttpUrl("not a url"), null);
    assert.equal(safeHttpUrl(null), null);
  });

  test("rejects embedded credentials whose userinfo can disguise the host", () => {
    // Rendered into <a href>; `trusted.com@evil.com` reads as trusted.com but
    // resolves to evil.com.
    assert.equal(safeHttpUrl("http://trusted.com@evil.com/"), null);
    assert.equal(safeHttpUrl("https://user:pass@evil.com/"), null);
  });
});
