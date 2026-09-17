# Running an agent turn on an installed CI-OpenClaw

How QA, the Hub, and other apps run **one headless OpenClaw turn on an install's own
configuration**, meaning the model, provider, tools and timeouts the Hub gave that install,
with no `--config`, `--model` or provider override.

## The supported path

```bash
C=ci-openclaw_ci-marketplace-ci-openclaw-1
SID="automation-$(date +%s)"

docker exec -i "$C" sh -c 'cat > /tmp/turn.txt' < prompt.txt
docker exec -w /data/workspace "$C" \
  openclaw agent --session-id "$SID" --message-file /tmp/turn.txt --json --timeout 900

# afterwards: remove the session from the app's store
docker exec "$C" openclaw sessions delete "agent:main:explicit:$SID" --yes --json
```

The turn runs inside the app's running gateway, the same process that serves its users, so
it uses exactly what they get: `agents.defaults.model.primary` (normally `ci-hub/auto`),
`models.providers.ci-hub` (the Hub pool URL, the Hub-issued key, `timeoutSeconds`), and the
app's plugins and tools. `--session-id` gives the turn its own session
(`agent:main:explicit:<id>`), with fresh context and separate from the user's main
conversation.

The JSON envelope carries `status` (`"ok"` on success), the reply in
`result.payloads[].text`, and `result.meta.agentMeta` with `provider`, `model`, `usage` and
`sessionFile`.

**Authentication.** The CLI authenticates to the gateway with `gateway.auth.token` from
`/data/.openclaw/openclaw.json`. Being able to `docker exec` into the container is the
credential, which is the trust the Hub already holds as the app's operator. Nothing is
exposed outside the container.

**Workspace.** Tools act in the app's workspace (`/data/workspace`). Use a scratch
subdirectory and remove it afterwards.

### Images before this change

The CLI reads the gateway port from `gateway.port` in `openclaw.json`. Reconcile only pins
that field from this change on. On older images the CLI falls back to port 18789, which in
this image is the **setup proxy**, not the gateway (the gateway listens on 18790). The proxy
rewrites `Origin` for the browser Control UI, so the gateway treats the CLI as a browser and
refuses every write:

```text
missing scope: operator.write
```

On those images, point the CLI at the gateway yourself. The flag does the same thing as the
pinned field:

```bash
docker exec -e OPENCLAW_GATEWAY_PORT=18790 -w /data/workspace "$C" \
  openclaw agent --session-id "$SID" --message-file /tmp/turn.txt --json
```

## What does not work, and why

| Command | Result | Why |
| --- | --- | --- |
| `openclaw agent --local` | `A Gateway is running for this state directory` | By design: the embedded agent will not share a state dir with a running gateway. |
| `openclaw agent exec` (ambient config) | `No API provider registered for api: ollama` | An upstream OpenClaw bug, described below. |
| `POST /hooks/agent` with `HUB_WAKE_SECRET` | `200 {ok, runId}` only | The hook reports that the run was admitted. The reply is not returned; it lands only in logs and the session. The route is live whenever the wake hook is on, but it is no use for anything that needs the answer back. `hooks.allowRequestSessionKey` stays `false`. |

### `agent exec` and the `ci-hub` provider (upstream)

`openclaw agent exec` is OpenClaw's isolated headless turn, and it would be the natural
path. On OpenClaw 2026.9.1 it cannot run the Hub's provider. To keep startup cheap, exec
loads only the plugins whose **manifest** owns the selected provider id
(`resolveSelectedProviderOwnerPluginIds` → `resolveOwningPluginIdsForProviderRef`, which
match `providers`, `providerAuthAliases` and `modelCatalog.aliases`). No manifest owns
`ci-hub`, so the bundled `ollama` plugin never loads, and the run fails when it looks up a
stream for `api: "ollama"`. The gateway is not affected, because it loads every startup
plugin and finds the ollama stream through the provider's `api` owner hint.

Both of these were verified against 2026.9.1 and a stub Ollama:

- `agent exec --model ollama/<id>` works. The native `ollama` provider points at the same
  Hub pool. It is **not** the installed config, though: it skips `ci-hub` and the pool's
  `auto` alias.
- A config-only workaround exists, `agents.defaults.model.fallbacks: ["ollama/<id>"]`, but
  it is deliberately **not** applied. Fallbacks run on real user turns too, and a timeout
  would re-send the whole prompt to the same pool.

The fix belongs upstream: exec should also count `models.providers.<id>.api` as an owner
hint when it selects plugins. `npm run test:agent-turn` reports on every run whether exec
still fails, so the nightly `openclaw@latest` run shows when upstream fixes it.

## How the agent's model follows the Hub

The Hub hands out `DEFAULT_MODEL` in `bootstrap.env`. On every gateway start, `reconcileConfig`
decides `agents.defaults.model.primary`:

1. A primary that is not `ci-hub/...` (say `anthropic/...` or `ollama/...`) was chosen by an
   operator and is left alone.
2. A `ci-hub/...` primary that is no longer in the ci-hub catalog, or that the pool reports
   **cannot call tools**, is replaced. A model without tool support fails every agent turn
   with `<model> does not support tools`. Capabilities that could not be read (a failed
   `/api/show`) never move it.
3. Otherwise, a primary equal to the one reconcile last applied follows the current handout.
   Any other primary is an operator's pick and stays.

The Hub's own choice is `ci-hub/auto`, which the pool resolves to its current default, so a
default change needs no config write. If the pool reports that the default cannot call tools,
reconcile uses the first installed model that can, adds it to the ci-hub catalog, and logs a
warning.

What reconcile last applied is recorded in `/data/.openclaw/ci-hub-handout.json`
(`defaultModel`, `primary`, `appliedAt`). The record lives in its own file because
OpenClaw's schema rejects unknown keys in `openclaw.json`. It is rewritten only when the
handout changes. Deleting it is safe: the next start treats a primary that matches the
handout as current, and anything else as stale.

## Fresh data directory

When `/data/.openclaw/openclaw.json` does not exist but the app is configured (the Hub
bootstrap wrote inference settings to `.env`), reconcile builds the whole config from the
handout **before** `openclaw doctor --repair` runs. Given an empty directory, doctor writes a
minimal config with no models section. The gateway then came up unconfigured on it (seen on
core-2 after its data dir was recreated, and on beta-max as
`Agent harness runtime "codex" is unavailable`) and stayed that way until the next container
restart. A config file that exists but cannot be parsed is never overwritten.
