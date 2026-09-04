# Companion Intelligence memory for OpenClaw

Makes a self-hosted [Companion Memory](https://docs.ci.computer) server OpenClaw's
active memory backend: conversations are captured passively as they happen, and
relevant context is injected into later sessions automatically.

Beyond the three memory tools (`memory_search`, `memory_get`, `memory_store`), the
plugin registers hooks that stream each completed turn to your server, so memory
fills up without the agent having to decide to store anything.

You do not need the packaged Companion Intelligence OpenClaw app to use this. A
stock `openclaw` install is enough.

## Requirements

- OpenClaw (tested against the version this plugin is released alongside — see
  "Version compatibility" below)
- A reachable Companion Memory server
- A Companion Memory API key with the `memory` scope, minted in the server's web UI
  under **Settings → API Keys**

## Install

```bash
openclaw plugins install npm:@companionintelligence/openclaw-memory --accept-capabilities
```

OpenClaw 2026.9.1+ claims `plugins.slots.memory` for this plugin on install. Then add
your server URL and key in `~/.openclaw/openclaw.json` (keep the slot pin so upgrades
stay explicit):

```json
{
  "plugins": {
    "slots": { "memory": "companionintelligence" },
    "entries": {
      "companionintelligence": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "url": "https://memory.example.com",
          "token": "<your-api-key>"
        }
      }
    }
  },
  "tools": { "alsoAllow": ["memory_store"] },
  "hooks": { "internal": { "entries": { "session-memory": { "enabled": false } } } }
}
```

Use your own server's address in place of `https://memory.example.com` — see
[Which URL do I use?](#which-url-do-i-use) if your hub answers on more than one.

Restart the gateway, then verify:

```bash
openclaw plugins inspect companionintelligence --runtime --json
```

You are looking for `"status": "loaded"` and `"activationReason": "selected memory slot"`.

That confirms OpenClaw loaded the plugin and handed it the memory slot. It does **not**
contact your server: a plugin pointed at an unreachable `url` still reports `loaded`. To
check the connection itself, run `/ci-memory` in a session — it calls `GET /api/health`
and reports back the URL it used.

### Why each key is needed

- **`plugins.slots.memory`** — selects this plugin as the memory provider. OpenClaw
  2026.9.1+ sets this on install for `kind: memory` plugins; keep it in config so the
  selection survives hand-edits and older CLI behaviour.
- **`hooks.allowConversationAccess: true`** — required for passive capture. `agent_end`
  is a conversation hook, and OpenClaw only delivers conversation hooks to a plugin
  whose entry opts in. Without it you get the tools but no automatic capture.
- **`tools.alsoAllow: ["memory_store"]`** — OpenClaw's `group:memory` profile includes
  `memory_search` and `memory_get` but not memory writes. `alsoAllow` is additive; do
  not use `tools.allow` unless you already maintain one, because it is an exclusive
  allowlist and creating it denies every tool not named in it.
- **`hooks.internal.entries.session-memory.enabled: false`** — turns off OpenClaw's
  bundled session-memory hook. Two memory runtimes observing the same session both
  write, and you get duplicates.

> OpenClaw's config schema is strict: one unrecognized key invalidates the whole
> file, after which `openclaw doctor --repair` quarantines it and restores the last
> known good copy — silently reverting anything else written in the same pass. Copy
> the block above as-is, and check `openclaw doctor --lint` after editing.

## Which URL do I use?

Companion Memory runs as an app on your Companion Hub, and a hub can answer on more than
one address at the same time. Which one belongs in `url` depends on where this agent
runs, not on which address is the "real" one. The plugin calls the server from the agent
process rather than from a browser, so no origin or CORS restriction applies: any address
the agent's machine can route to will work.

The app's exposure is set in the hub under **App → Settings**. Each setting produces a
different address:

| Exposure | Address shape | Reachable from |
| --- | --- | --- |
| Local network (default) | `http://ci-memory.ci.lan` — or `http://<hub-ip>:8642` if Traefik routing is not set up | Devices on the hub's LAN |
| Private VPN (Tailscale) | `https://<hub>.<tailnet>.ts.net:8642` | Any device signed into your tailnet |
| Public (**Expose app**) | `https://<the domain you configured>` | Anywhere |

`ci.lan` is the default local domain and can be changed in **Settings → General**; `8642`
is Companion Memory's app port. Use `http://localhost:8642` only when the agent runs on
the hub host itself.

This value is written to your config once and never re-resolved, so it does not follow
you between networks. An agent that always runs on the hub's LAN is served by the local
address, and its traffic never leaves your network. An agent on a machine that moves — a
laptop that leaves the house — keeps working only on an address reachable from wherever
it goes, which means joining the tailnet or exposing the app publicly; exposing it puts
the memory server on the internet, where its API key is the only thing guarding it. The
three forms differ in reach and in what they ask of you, not in what the plugin can do
with them.

### If it does not connect

`"status": "loaded"` says nothing about reachability. Run `/ci-memory`: on failure it
prints the error alongside the URL it tried, which is usually enough to separate a wrong
address from a wrong key. A timeout or a refused connection points at the address; a
`401` points at the key.

## Configuration

All keys under `plugins.entries.companionintelligence.config`:

| Key | Default | Meaning |
| --- | --- | --- |
| `url` | `CI_SERVER_URL` | Companion Memory base URL. A trailing `/api/mcp` is stripped, so either form works. |
| `token` | `CI_SERVER_TOKEN` | API key, sent as `x-api-key`. |
| `maxResults` | `5` | Default recall result count (1–20). |
| `timeoutMs` | `10000` | Per-request timeout in ms (1000–60000). |

`url` and `token` fall back to the environment variables shown when not set in the
config, which is how the packaged app injects them.

Capture and recall can be narrowed with environment variables, all enabled by
default: `CI_MEMORY_CONTEXT_ENABLED`, `CI_MEMORY_RECALL_ENABLED`,
`CI_MEMORY_TURN_ENABLED`, `CI_MEMORY_WRITE_ENABLED`, `CI_INTENTS_ENABLED`,
`CI_INTENT_TOOLS_ENABLED`. Set any to `false` to disable that behaviour.

## What it talks to

`GET /api/health`, `GET /api/memory/context`, `POST /api/memory/recall`,
`POST /api/memory/write`, `POST /api/memory/turn`, and the agent intents endpoints.
No third-party services, and the plugin has no dependencies — it uses the platform's
own `fetch`.

## Version compatibility

Releases are dated (`YYYY.M.D`) and cut alongside the Companion Intelligence OpenClaw
app, which pins a specific upstream OpenClaw version. A release is tested against
that pinned version. Newer OpenClaw releases generally work; if a config schema
change breaks loading, upgrade the plugin.

## Uninstall

```bash
openclaw plugins uninstall companionintelligence
```

This removes the plugin, its config entry, and resets the memory slot to
`memory-core`. Your data on the Companion Memory server is untouched.

## License

MIT
