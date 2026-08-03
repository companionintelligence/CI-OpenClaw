# Error reporting (Sentry)

CI-OpenClaw's wrapper can report its own crashes to [Sentry](https://sentry.io).
It is **opt-in and off by default**: with no DSN configured, no Sentry code
initialises, `@sentry/node` is never even `require`d, and the container makes no
outbound connection.

This follows the fleet contract set by CI-Server
(`backend/apps/api/src/common/telemetry/`), which CI-Import-Tools and
Companion-Planning also implement. Deviations specific to this app are called out
below.

## What is (and is not) instrumented

Only the **wrapper** — `server.cjs`, the setup/proxy server that this repo owns.
OpenClaw itself is an upstream npm package running as a separate child process
with `stdio: "inherit"`; nothing it prints or throws passes through the wrapper's
process, and it is not instrumented. Every event carries the tag
`component: ci-openclaw-wrapper`.

## Privacy posture

This app is a proxy in front of an AI agent that holds the user's provider API
keys, so reporting is deliberately narrower than a default Sentry install:

| Setting | Value | Why |
|---|---|---|
| `sendDefaultPii` | `false` | No IPs, cookies, or request bodies. |
| `tracesSampleRate` | `0` | Errors only. Traces would ship the shape of every proxied agent request. |
| `profilesSampleRate` | `0` | — |
| Session replay | not installed | — |
| `includeServerName` | `false` | The hostname identifies the household. |
| `includeLocalVariables` | `false` | Frame locals here are gateway tokens, `APP_SEED`, and proxied request headers. |
| `beforeSend` | `scrubEvent` | See below. |

Two kill switches disable reporting even when a DSN has been injected by the Hub
or baked into an image, so an operator can turn it off without a rebuild:

| Variable | Effect |
|---|---|
| `CI_TELEMETRY=off` | Explicit opt-out (also `false`, `0`, `no`, `disabled`). |
| `CI_LOCAL_ONLY=true` | Local-only mode means zero phone-home (also `1`, `yes`, `on`, `enabled`). |

`CI_LOCAL_ONLY` takes precedence over `CI_TELEMETRY`, which takes precedence over
the DSN. The reported `disabledReason` names the strongest reason, so the startup
log says the *operator's* choice rather than the incidental absence of a DSN.

## What gets scrubbed

`telemetry.cjs` implements the fleet rules:

- Bearer tokens, `api_key=` / `password:` / `token:` / `app_seed=` style pairs,
  Tailscale `tskey-…`, and credentials in connection URLs → `[Filtered]`
- Home directories (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`) → `~`.
  The Windows patterns run **before** the macOS one, or `/Users/<name>` matches
  inside `C:/Users/<name>` and leaves a stranded `C:~/…`
- Object and header keys matching
  `password|secret|token|authorization|cookie|jwt|api[-_ ]?key|dsn|pepper|private_key|hub[-_]user|app[-_ ]?seed`
  → `[Filtered]`. Two of those matter especially here:
  - **`hub[-_]user`** — this app sits behind the Hub's Traefik forward-auth,
    which stamps `X-CI-Hub-User` (plus `-Timestamp` / `-Signature`) onto every
    proxied request. The value is the household username: an ordinary word that
    no secret pattern would match, so this key rule is the only thing stopping
    it. `sendDefaultPii: false` does **not** stop request headers — it only
    resolves an IP-oriented deny list applied to span attributes, not to
    `event.request.headers`.
  - **`app[-_ ]?seed`** — `APP_SEED` gates the setup terminal, which is an RCE
    primitive.
- Request cookies and bodies dropped; **query strings removed from
  `request.query_string`, from `request.url`, from the `referer`/`location`
  headers, and from breadcrumb `url`/`from`/`to`**. The SDK builds `request.url`
  from `req.url`, which on a Node server is path+query, so filtering only
  `query_string` redacts nothing — and on this app the query string is literally
  `?token=<gateway token>`, because the wrapper redirects `/` to
  `/?token=…#token=…` so the Control UI can authenticate.
- Stack frame `filename` / `abs_path` (home dir collapsed only — Sentry *groups*
  issues on `filename`, so redacting the body of the path would destroy
  grouping), captured `vars`, and the source lines the `ContextLines` integration
  attaches (`context_line`, `pre_context`, `post_context`)
- `server_name` and `user` removed, and `contexts.culture`, whose `timezone` is a
  coarse location signal for a household appliance
- `logentry.formatted` and `logentry.params`, not just `logentry.message` —
  `message` is only the printf *format string*, so scrubbing it alone stamps
  `[Filtered]` on the template while shipping the interpolated values
- Breadcrumbs: message and every `data` value, in both the bare-array (Node) and
  `.values` (Python SDK) shapes
- Strings over 8 KB truncated; the object walk is depth-guarded and cyclic-safe

### Bare provider API keys — an addition over the reference

The reference scrubber only catches *labelled* secrets (`api_key=…`). The whole
job of this app's setup UI is collecting unlabelled ones: the user types a
provider key into a PTY running `openclaw onboard`, and an `openclaw doctor`
failure surfaces config contents through `execAsync`'s error message. So bare key
shapes are matched on their own: `sk-…` (OpenAI / Anthropic / OpenRouter),
`AIza…` (Google), `gsk_…` (Groq), `xai-…`, `ghp_…` / `github_pat_…`.

### Integrations that are removed

| Integration | Why |
|---|---|
| `OnUncaughtException`, `OnUnhandledRejection` | `server.cjs` registers its own handlers that deliberately **log and keep serving** — the wrapper surviving a stray throw is what keeps the whole app from dropping. The SDK's versions can terminate the process, which would let error reporting change crash behaviour. |
| `Console` | Console breadcrumbs would capture `openclaw doctor` stderr relayed through `execAsync`'s error message — the diagnostic output of the user's own agent, including its config. (Deviation from CI-Server, which does not shell out to an agent CLI.) |
| `ProcessSession` | Release health sends a session envelope on every container start even when nothing went wrong, and session envelopes do **not** pass through `beforeSend`. Opt-in *error* reporting should not include an uptime heartbeat. |

The filter is by integration name, so `filterIntegrations` warns when a name
matched nothing — an upstream rename must not silently restore a
process-terminating crash handler.

## No browser reporting

There is no browser-side Sentry, deliberately:

- The only page this repo serves is `setup.html`, a static page with an inline
  `<script>`. There is no bundler and no `import.meta.env`, so the reference's
  tree-shaken `VITE_SENTRY_DSN` shape does not apply; the SDK would have to be
  pulled from a third-party CDN at runtime.
- That page is the API-key onboarding terminal. Its DOM and console contain the
  provider key as the user types it — the worst possible place to add breadcrumb
  collection.
- After onboarding, every page is OpenClaw's own upstream Control UI, proxied
  through. It is not our bundle and we cannot instrument it.

The consent endpoint exists anyway (see below), so a future browser client — or
an operator — can read the effective state.

### The consent endpoint

```
GET /__ci_telemetry/config  →  {"enabled":false,"reason":"opt-out","environment":"…","release":null,"component":"ci-openclaw-wrapper"}
```

Unauthenticated by design: it exposes no secret — **never the DSN** — and when
reporting is off there is nothing to expose at all. It reports whether *this
process* is reporting, so the kill switches (and the marketplace "Share crash
reports" toggle that would set them) are observable without shelling into the
container.

**Deviation:** the fleet path is `/api/config/telemetry`. This wrapper proxies
every path it does not claim straight to OpenClaw, so a wrapper-owned route under
`/api/` would silently shadow an upstream route the moment the weekly
`openclaw` version bump added one. The repo already namespaces its own routes
under `/__ci_memory/*` for exactly this reason; this follows that precedent.

## Sentry project

One project per marketplace app id: CI-OpenClaw reports into **`ci-openclaw`** in
the `companion-intelligence` org, matching `ci-memory` (CI-Server) and
`ci-import-tools`.

The project is **not created yet** — the org sets
`allowMemberProjectCreation: false`, so an owner has to create it. Nothing here
depends on it existing: with no DSN the code stays inert.

```
sentry issue list companion-intelligence/ci-openclaw --query "is:unresolved"
```

## Enabling it

```bash
# .env — all optional, all off by default
SENTRY_DSN=https://<key>@o<org>.ingest.us.sentry.io/<project-id>
SENTRY_ENV=production
CI_OPENCLAW_VERSION=2026.7.1-2
```

`docker-compose.yml` passes `SENTRY_DSN`, `SENTRY_ENV`, `CI_OPENCLAW_VERSION`,
`CI_TELEMETRY` and `CI_LOCAL_ONLY` through with empty defaults, so setting them in
`.env` is enough and leaving them unset keeps reporting off. The DSN is a
**runtime** value — deliberately not a Docker build `ARG`, so no DSN is ever baked
into the published image.

Turning it off again:

```bash
CI_TELEMETRY=off docker compose up -d
```

## Verifying

The gate has four states. To check them without a Sentry account, run the wrapper
with a throwaway DSN (`https://abc123@o1.ingest.us.sentry.io/9999999`) and read
the consent endpoint:

```bash
curl -s localhost:18789/__ci_telemetry/config
```

Expected: `enabled: true` only in the DSN-and-no-kill-switch case; `no-dsn`,
`opt-out` and `local-only` otherwise. In the three disabled cases `@sentry/node`
is never loaded at all, which is the strongest form of "no outbound traffic".

## Where it hooks in

| Path | Role |
|---|---|
| `telemetry.cjs` | The gate, the scrubber, `Sentry.init`, the bounded flush |
| `server.cjs` (top of file) | `initTelemetry()` — must stay the first require + call, before `http`/`ws` are loaded |
| `server.cjs` `uncaughtException` / `unhandledRejection` | Capture, additively; the wrapper still logs and keeps serving |
| `server.cjs` `upgrade` handler catch | Captures a WebSocket-upgrade throw |
| `server.cjs` `SIGTERM` | Bounded 2 s flush, unref'd; a no-op when reporting is off |
| `server.cjs` `/__ci_telemetry/config` | Runtime consent state |
| `tests/telemetry.test.mjs` | The gate + every scrubber rule above |

## Not wired up yet

- **Marketplace plumbing.** `CI-Marketplace/apps/ci-openclaw/docker-compose.json`
  passes only `APP_SEED`, so a Hub-installed app gets no `SENTRY_DSN` and no
  "Share crash reports" form field. Both are one-line manifest additions in that
  repo; nothing in this repo needs to change for them.
- **Release + source map upload in CI.** `docker-publish.yml` does not pass
  `SENTRY_RELEASE` or upload source maps. Not needed while the wrapper ships
  unbundled CommonJS.
