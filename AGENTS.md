# AGENTS.md — CI-OpenClaw

## Platform context

CI-OpenClaw is the **App** layer component of the Companion Intelligence platform — a private, local-first digital memory system.

Full architecture: `CI-Engineering/architecture/architecture.md`

## Repo summary

CI marketplace wrapper for OpenClaw. Provides headless browser setup, API key onboarding UI, and persisted node modules/brew packages between app updates.

## Stack

- Node.js
- Docker Compose
- OpenClaw upstream image

## Setup & commands

```bash
npm install   # install
docker compose up --build   # dev
npm test   # unit + bootstrap shell suites (no install needed)
npm run test:schema   # validate openclaw.json against OpenClaw's own schema (needs the openclaw CLI)
docker compose build   # build
```



## Git discipline

- Never `git reset --hard` or `git clean -f` without user confirmation.
- Commit messages: imperative mood, ≤ 72 chars.
- Reference CI-Engineering issues in PRs (e.g. `Closes companionintelligence/CI-Engineering#32`).

## Confidentiality

Private & Confidential — Property of Lifescope Inc. Do not distribute.
