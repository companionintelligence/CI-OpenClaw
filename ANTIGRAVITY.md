# ANTIGRAVITY.md — CI-OpenClaw

## Context

**CI-OpenClaw** — **App** layer of the Companion Intelligence platform (Lifescope Inc).

Architecture: `CI-Engineering/architecture/architecture.md`
Roadmap: `CI-Engineering/architecture/roadmap.md`

## Purpose

CI marketplace wrapper for OpenClaw. Provides headless browser setup, API key onboarding UI, and persisted node modules/brew packages between app updates.

## Stack

- Node.js
- Docker Compose
- OpenClaw upstream image

## Commands

```bash
npm install
docker compose up --build
npm test   # unit + bootstrap shell suites (no install needed)
npm run test:schema   # validate openclaw.json against OpenClaw's own schema (needs the openclaw CLI)
```

## Rules

- Package manager: do not switch or mix.
- Destructive git operations (`reset --hard`, `clean -f`) require explicit user confirmation.
- Commits reference CI-Engineering issues.
- All content is **private and confidential** — Property of Lifescope Inc.
