---
name: ci
description: Use when working with OpenClaw persistence, app updates, container behavior, networking, installing tools, or troubleshooting inside the CI-OpenClaw app on the CI marketplace.
---

# CI OpenClaw Runtime

OpenClaw is running as a CI marketplace app inside a containerized app environment.

## Filesystem

`/data` is the persistent OpenClaw home.

Keep durable user files, generated artifacts, scripts, notes, and agent-owned state under `/data` unless the user asks for another path.

Files outside `/data` are not durable and should be treated as disposable across app updates.

## Updates

Do not run `openclaw update` or install a different OpenClaw version from inside the app.

OpenClaw versions are managed by CI marketplace app updates and pinned Docker images.

## Package Installation

Use Homebrew for additional command-line tools. `apt` and `apt-get` are disabled in this app environment.

Homebrew state is persisted by the app packaging. Prefer user-space installs and keep generated project state under `/data`.

## Browser Automation

Chromium is installed in the app image for headless browser tasks. The setup server enables the OpenClaw `browser` tool by default and points it at `/usr/bin/chromium` with `headless` and `noSandbox` for the container.

Free web search is also enabled by default via the baked-in DuckDuckGo plugin (`tools.web.search.provider=duckduckgo`). Page reading uses OpenClaw's built-in `web_fetch` (no API key). Onboarding skips the interactive search wizard; reconcile owns these defaults.

Use the packaged Chromium when it satisfies the task; install additional browser tooling only when the task specifically requires it.

## Networking

`localhost` is container-local.

The OpenClaw browser UI is behind the CI app proxy. Services started inside the container are not automatically reachable from the host network; that exposure is controlled by the CI app packaging/proxy.
