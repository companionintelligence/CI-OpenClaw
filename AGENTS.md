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

## Vendored ci-hub plugin bundle

`openclaw-context/plugins/ci-hub/hub-plugin.mjs` is a build artifact of CI-Hub's
`packages/openclaw-plugin`, not source — never hand-edit it. To change plugin behaviour, fix the
CI-Hub source, then re-sync: `scripts/check-ci-hub-plugin-drift.sh --write --ci-hub /path/to/CI-Hub`
(rebuilds the bundle and records the source commit in `.ci-hub-source`). CI byte-checks it against a
rebuild (the `plugin-integrity` job in `.github/workflows/ci.yml`, which also gates releases), so a
hand-edit or missed re-sync fails the check.

## Git discipline

- Never `git reset --hard` or `git clean -f` without user confirmation.
- Commit messages: imperative mood, ≤ 72 chars.
- Reference CI-Engineering issues in PRs (e.g. `Closes companionintelligence/CI-Engineering#32`).

## Confidentiality

Private & Confidential — Property of Lifescope Inc. Do not distribute.
