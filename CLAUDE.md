# CLAUDE.md — CI-OpenClaw

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

## Platform role

**CI-OpenClaw** sits in the **App** layer of the Companion Intelligence platform.

Architecture: `CI-Engineering/architecture/architecture.md`
Roadmap: `CI-Engineering/architecture/roadmap.md`
Issues: <https://github.com/companionintelligence/CI-Engineering/issues>

## What this repo does

CI marketplace wrapper for OpenClaw. Provides headless browser setup, API key onboarding UI, and persisted node modules/brew packages between app updates.

## Stack

- Node.js
- Docker Compose
- OpenClaw upstream image

## Key commands

```bash
# Install dependencies
npm install

# Start development server / service
docker compose up --build

# Run tests (config reconciler, CI memory plugin, bootstrap shell suites; no install needed)
npm test

# Validate the generated openclaw.json against OpenClaw's own strict schema.
# Needs the CLI: npm i -g "openclaw@$(grep -oE 'openclaw@[0-9.]+' Dockerfile | head -1 | cut -d@ -f2)"
npm run test:schema

# Build for production
docker compose build
```

## Package manager

**npm** — use exclusively; do not mix with npm/yarn/pnpm/bun unless the repo explicitly requires it.

## Cross-repo connections

- Installed via CI-Hub from CI-Marketplace catalog
- Protected by CI app proxy — not exposed directly



## Multi-agent safety

Multiple AI agents work these repos in parallel. Never use `git reset --hard`, `git clean -f`, or any destructive git command without explicit confirmation from the user.

## Confidentiality

Private & Confidential — Property of Lifescope Inc. Do not distribute.
