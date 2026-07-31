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
openclaw plugins install npm:@companionintelligence/openclaw-memory
```

Then add your server URL and key, and select the plugin as the memory provider, in
`~/.openclaw/openclaw.json`:

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

Restart the gateway, then verify:

```bash
openclaw plugins inspect companionintelligence --runtime --json
```

You are looking for `"status": "loaded"` and `"activationReason": "selected memory slot"`.

### Why each key is needed

- **`plugins.slots.memory`** — selects this plugin as the memory provider. Installing
  from npm registers the plugin but does not claim the slot, so set it explicitly.
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
