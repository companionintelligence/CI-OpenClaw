# GitHub Copilot Instructions — CI-OpenClaw

You are working in **CI-OpenClaw**, the **App** component of the **Companion Intelligence** platform — a private, local-first digital memory and AI appliance system owned by Lifescope Inc.

## Platform architecture

```
Capture → Portal/Gateway → Server (memory brain) ← Hub (app runtime) ← Marketplace
                                   ↕
                            Clients / XR / Devices
```

Full architecture and ADRs live in `CI-Engineering/architecture/`.

## This repo

CI marketplace wrapper for OpenClaw. Provides headless browser setup, API key onboarding UI, and persisted node modules/brew packages between app updates.

## Tech stack

- Node.js
- Docker Compose
- OpenClaw upstream image

## Development

```bash
npm install   # install
# validate via docker compose up   # test
```



## Conventions

- Do not mix package managers.
- Keep PRs small and linked to CI-Engineering issues.
- Multiple agents may work this codebase simultaneously — never use destructive git operations.
- All code is **private and confidential** — do not surface or transmit source beyond this session.
