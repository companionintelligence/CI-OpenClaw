# CI-OpenClaw

> A Docker image for running [OpenClaw](https://openclaw.ai) on the Companion Intelligence (CI) marketplace.

⚠️ WARNING: Running this on systems other than the CI marketplace is likely very insecure. This configuration is only secure when running behind the CI app proxy.

## What is this?

This is a containerized version of OpenClaw with seamless onboarding on the CI marketplace. It provides:

- A simple setup UI to configure your API keys (no interactive onboarding CLI)
- Headless browser setup and configured out of the box
- Sandboxing so OpenClaw runs in its own environment that can't mess up other CI apps
- Automatic gateway token management
- Homebrew pre-installed for OpenClaw to install additional tools configured in a way that will persist between app updates
- apt/apt-get disabled with a message telling openclaw to use brew instead
- Globally installed node modules persisted between app updates
- A bundled `companionintelligence` memory plugin that can use CI-Server as OpenClaw's active memory backend when `CI_SERVER_URL` and `CI_SERVER_TOKEN` are configured
- Automatic Hub MCP tool access via a native `mcp.servers.ci-hub` entry in `openclaw.json` (Streamable HTTP), registered when the Hub injects `HUB_URL` / `HUB_MCP_API_KEY` (default on CI marketplace installs with MCP enabled). A bundled `ci-hub` plugin additionally provides the wake endpoint (it also implements app-event SSE, disabled by default). The `ci-hub` model provider is written to `openclaw.json` by the setup server (`config-reconcile.cjs`), not by the plugin — see the note below.
- Security features that complicate setup disabled which are not required on the CI marketplace due to OpenClaw already being protected when running behind the CI app proxy

This creates a seamless one-click install experience for OpenClaw on the CI marketplace.

## Companion Intelligence memory setup

CI-OpenClaw ships with a bundled OpenClaw memory plugin named `companionintelligence`. When CI-Server credentials are available, startup selects it as OpenClaw's active memory backend and routes memory reads/writes through CI-Server.

### Required CI-Server configuration

Provide these environment variables to the OpenClaw container:

```bash
CI_SERVER_URL=http://ci-server:8642
CI_SERVER_TOKEN=<ci-server-api-key>
```

For local Docker Compose outside the CI marketplace, `CI_SERVER_URL` is often:

```bash
CI_SERVER_URL=http://host.docker.internal:8642
```

If using the repo-level `.env` file for local development, also pass the values through `docker-compose.yml`:

```yaml
services:
  openclaw:
    environment:
      APP_SEED: ${APP_SEED:-dev}
      CI_SERVER_URL: ${CI_SERVER_URL}
      CI_SERVER_TOKEN: ${CI_SERVER_TOKEN}
```

### First-run flow

1. Start OpenClaw with the CI-Server env vars present:

   ```bash
   docker compose up --build
   ```

2. Open the setup UI:

   ```text
   http://localhost:18789
   ```

3. Complete OpenClaw onboarding for the model provider/API key.

4. Restart once if the CI-Server env vars were added after onboarding:

   ```bash
   docker compose restart openclaw
   ```

On startup, `/app/bootstrap-ci-memory.sh` and the setup server reconcile the persistent OpenClaw config at `/data/.openclaw/openclaw.json`.

### Expected OpenClaw config

When CI memory is active, the reconciled config should contain:

```json
{
  "plugins": {
    "slots": {
      "memory": "companionintelligence"
    },
    "entries": {
      "companionintelligence": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  },
  "tools": {
    "alsoAllow": ["memory_store"]
  },
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": false
        }
      }
    }
  }
}
```

`memory_store` is explicitly allowed because OpenClaw's `group:memory` profile includes `memory_search` and `memory_get`, but not memory writes.

`hooks.allowConversationAccess: true` is required for the plugin's automatic
turn-sync (see below). `agent_end` is a conversation hook, and OpenClaw only
delivers conversation hooks to a path-loaded plugin when its entry opts in. The
bootstrap and setup server both set this when CI memory is selected.

### Automatic conversation capture (turn-sync)

Beyond explicit `memory_store` calls, the plugin passively streams the
conversation into CI-Server so OpenClaw populates memory the same way Hermes
does. It registers two OpenClaw hooks:

- **`agent_end`** — after each completed turn, posts the latest user/assistant
  exchange to `POST /api/memory/turn` (mirrors the Hermes `sync_turn`).
- **`before_compaction`** — flushes the messages about to be dropped from the
  context window before they are compacted away (mirrors the Hermes
  `on_pre_compress`).

Both calls carry `platform: "openclaw"` and the session id, are fire-and-forget
(a failed or unconfigured CI-Server never breaks the turn), and rely on
CI-Server's server-side dedupe so re-sends are cheap. OpenClaw's bundled
`session-memory` hook stays disabled because CI-Server is the authoritative
transcript store.

### CI Intent catalog (discovery + execution)

The plugin also consumes CI-Server's curated intent catalog:

- **Discovery** — the `ci_list_intents` tool fetches `GET /api/agent/intents`
  (falling back to the legacy `GET /api/intents`) and renders the typed,
  privacy-labelled catalog for the agent.
- **Execution** — at startup the plugin registers one OpenClaw tool per
  **non-destructive, non-external** intent in that catalog (e.g.
  `predictions_forecast`), each POSTing its parameters to CI-Server's generic
  REST executor `POST /api/intents/:name/execute` and returning the structured
  `ToolResult`. Destructive/external intents are filtered client-side and are
  also refused (403) by the server. Failures come back as structured error
  results, never throws; if the catalog or executor is unavailable the plugin
  degrades to discovery-only.

Flags (default **on**, same convention as the memory flags):

- `CI_INTENTS_ENABLED` — the whole intent subsystem (`ci_list_intents` +
  executable intent tools)
- `CI_INTENT_TOOLS_ENABLED` — just the executable intent tools (sub-switch)

### CI-Server endpoints used

The plugin calls:

- `GET /api/health`
- `GET /api/memory/context`
- `POST /api/memory/recall`
- `POST /api/memory/write`
- `POST /api/memory/turn`
- `GET /api/agent/intents` (falls back to `GET /api/intents`)
- `POST /api/intents/:name/execute` (tried as `POST /api/agent/intents/:name/execute` first)

`POST /api/memory/write` is the durable write endpoint for explicit notes. Older
Hermes docs may mention `/api/memory/note`; CI-OpenClaw uses `/write` first and
only falls back to `/note` for compatibility. `POST /api/memory/turn` is the
transcript-ingest endpoint used by automatic turn-sync.

### Unit tests

Everything runs with no install step — the suites are dependency-free and use Node's
built-in test runner (Node 22).

```bash
npm test            # everything below
npm run test:unit   # config reconciler + CI memory plugin (node --test)
npm run test:sh     # the bootstrap shell scripts (tests/*.test.sh)
```

#### Config reconciliation

`config-reconcile.cjs` owns `openclaw.json`. OpenClaw's config schema is strict:
**one unrecognized key invalidates the entire file**, after which `openclaw doctor
--repair` quarantines it and restores last-known-good — silently reverting everything
written in the same pass (model catalog, memory wiring, gateway token). A one-word typo
(`options` where the schema says `params`) once disabled CI-Memory on an appliance with
no error on any channel.

`tests/config-reconcile.test.mjs` drives the real module against a temp
`OPENCLAW_DATA_DIR` and a real ephemeral Ollama, covering model-entry shape
(`params.num_ctx`, never `options`), context-window clamping, embeddings repointing and
credential hygiene, malformed-node hardening, and reconcile convergence.

#### Schema gate

The generalizing check: it validates the config `reconcileConfig()` **actually produces**
against **OpenClaw's own schema**, using the version pinned in the `Dockerfile`. It
proves it is really validating by feeding the validator two deliberately corrupted
canaries and requiring both to be rejected.

```bash
npm i -g "openclaw@$(scripts/openclaw-pin.sh)"
npm run test:schema
```

It runs on every PR (`.github/workflows/ci.yml`) and nightly against `openclaw@latest`
as an advisory signal. Without the CLI on `PATH` it skips locally, but hard-fails when
`CI` is set, so CI can never silently pass by not running it.

### Verify in a running container

```bash
docker compose exec openclaw openclaw plugins inspect companionintelligence --runtime --json
```

The plugin should be `loaded`, selected as the memory slot, and expose:

```text
memory_search
memory_get
memory_store
```

To re-run config repair manually:

```bash
docker compose exec openclaw /app/bootstrap-ci-memory.sh
docker compose restart openclaw
```

If OpenClaw tries to write `USER.md`, `MEMORY.md`, or `/data/.openclaw/memory/main.sqlite`, the CI memory plugin should block that path. CI-Server is the authoritative memory backend when `companionintelligence` is active.

## Hub MCP (platform tools)

On CI marketplace installs, the Hub injects MCP credentials automatically (`HUB_URL`, `HUB_MCP_URL`, `HUB_MCP_API_KEY`, `HUB_WAKE_SECRET`). Container startup runs:

1. `/app/bootstrap-from-hub.sh` — inference + Hub env
2. `/app/bootstrap-ci-memory.sh` — optional CI-Server memory plugin
3. `/app/bootstrap-ci-hub-mcp.sh` — registers the Hub as a native MCP server (`mcp.servers.ci-hub`, Streamable HTTP) and enables the `ci-hub` companion plugin

Hub MCP **tools** load through OpenClaw's built-in MCP client via the `mcp.servers.ci-hub` entry — `url: …/api/mcp`, `transport: "streamable-http"`, and `Authorization: "Bearer ${HUB_MCP_API_KEY}"` (an env-template ref, so the key is never written to `openclaw.json`). The `ci-hub` plugin provides the wake endpoint (it also implements app-event SSE, disabled by default). The setup server also reconciles both the native entry and the plugin into `openclaw.json` when credentials are present. Hub-authoritative env keys always win over stale values in `/data/.openclaw/.env`.

Two plugin behaviours are **not** what they used to be:

- **`HUB_MCP_LEGACY_CLIENT=true` is no longer a working rollback.** It registered Hub tools in-plugin after awaiting `tools/list`, but OpenClaw requires `register()` to be synchronous and closes the plugin API once it returns — a late `registerTool()` is silently discarded. The flag now logs an error instead of pretending to work. Hub tools come from `mcp.servers.ci-hub`.
- **The plugin no longer registers an inference/model provider** (the `CI_HUB_PLUGIN_INFERENCE` opt-in is gone). A provider registered through the plugin API resolves its transport against OpenClaw's api-provider registry, which has no `ollama` implementation — so a plugin-registered `ci-hub` provider with `api: "ollama"` made the first LLM call fail with `No API provider registered for api: ollama`, taking chat down. (A provider declared in `openclaw.json` resolves `ollama` fine, via a separate provider-runtime path the plugin API never reaches.) `server.cjs` / `config-reconcile.cjs` already write the working `models.providers.ci-hub` into `openclaw.json` — the single source of truth for the `ci-hub` provider on an appliance. See companionintelligence/CI-Hub#895.

If Hub MCP is disabled (`HUB_MCP_ENABLED=false` in the container env), bootstrap steps no-op gracefully (and remove any prior `mcp.servers.ci-hub` entry). Run `cihub mcp setup` on the Hub to provision a key for existing installs.

To rebuild the vendored plugin after changing `ci-hub/packages/openclaw-plugin`:

```bash
cd ci-hub/packages/openclaw-plugin && pnpm bundle
```

The bundle is written to `packages/openclaw-plugin/dist/hub-plugin.mjs` by default. To sync into this repo's vendored plugin directory:

```bash
OPENCLAW_PLUGIN_OUT_DIR=/path/to/CI-OpenClaw/openclaw-context/plugins/ci-hub pnpm bundle
```

### Bundle drift is CI-enforced

`openclaw-context/plugins/ci-hub/hub-plugin.mjs` is the copy the appliance actually loads, and it is re-synced by hand — a fix landing in CI-Hub does nothing on any appliance until this bundle is rebuilt and committed. That silent gap shipped broken plugins more than once (companionintelligence/CI-OpenClaw#45), so CI now guards it:

- **Integrity** (the `plugin-integrity` job in `.github/workflows/ci.yml`, a hard gate) rebuilds from the exact CI-Hub commit recorded in `openclaw-context/plugins/ci-hub/.ci-hub-source` and byte-compares. On PRs it runs only when the plugin dir or the drift script changed; on pushes, schedule, and releases (via `docker-publish.yml`, which runs `ci.yml` before building) it always runs — so a stale bundle can't ship in an image.
- **Freshness** (`.github/workflows/ci-hub-plugin-resync.yml`, daily) rebuilds from CI-Hub `dev` and opens an automatic re-sync PR when the source has moved ahead.

Both need cross-repo access to the private CI-Hub. Set these under **Settings → Secrets and variables → Actions** (fine-grained PATs, or a GitHub App token) — scoped for least privilege:

- **`CI_HUB_READ_TOKEN`** — CI-Hub **Contents: read**. Used by the integrity gate and the resync rebuild.
- **`CI_HUB_SYNC_TOKEN`** — this repo (CI-OpenClaw) **Contents: write + Pull requests: write**, and *no* CI-Hub access. Used only to push the resync branch and open its PR.

The recommended way to re-sync (rebuilds **and** records provenance in `.ci-hub-source` in one step):

```bash
scripts/check-ci-hub-plugin-drift.sh --write --ci-hub /path/to/CI-Hub
git add openclaw-context/plugins/ci-hub/hub-plugin.mjs openclaw-context/plugins/ci-hub/.ci-hub-source
```

Verify against a checkout without changing anything: `npm run check:ci-hub-plugin-drift -- --ci-hub /path/to/CI-Hub`. Only `hub-plugin.mjs` is byte-checked; the `index.js` shim, `openclaw.plugin.json`, and `package.json` siblings are hand-authored (a `node --test` smoke test covers that the shim still loads the bundle synchronously).

## License

MIT
