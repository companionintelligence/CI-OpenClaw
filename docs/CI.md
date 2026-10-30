# Running CI for this repo

Automatic workflow triggers in this repository are **gated**: pushing does not
start a GitHub-hosted run any more. Checks run on local hardware, and the
workflows that remain are started deliberately.

Why: GitHub Actions was costing the org $563/month, almost all of it hosted
compute for checks that run just as well on hardware we already own.

Starting a gated workflow needs the [`gh` CLI](https://cli.github.com) and push
access. `--ref` matters - the workflow file is read from that branch, so a
workflow that only exists on your feature branch must be dispatched against it.

Full cross-repo runbook: `CI-Local-CICD/RUNBOOK.md` (regenerate with
`ci-local docs`). This file is generated - do not hand-edit.

---

Default branch: `master`

### Test locally

```bash
ci-local run --repo CI-OpenClaw
```

Equivalent to:

```bash
npm ci
npm run --silent test:unit
```

### Run a check workflow on GitHub

**ci-hub plugin bundle resync** — `ci-hub-plugin-resync.yml`

```bash
gh workflow run ci-hub-plugin-resync.yml --repo companionintelligence/CI-OpenClaw --ref master -f ref=dev
```

**CI** — `ci.yml`

```bash
gh workflow run ci.yml --repo companionintelligence/CI-OpenClaw --ref master
```

### Cut a release

**Docker Build and Push** — `docker-publish.yml`

```bash
gh workflow run docker-publish.yml --repo companionintelligence/CI-OpenClaw --ref master -f tag=<string> -f dry_run=false
```

Required inputs: `tag` (Existing release tag to (re)publish (for example 2026.6.1))

**Publish memory plugin to npm** — `npm-publish.yml`

```bash
gh workflow run npm-publish.yml --repo companionintelligence/CI-OpenClaw --ref <release-tag> -f tag=<string> -f dry_run=false
```

Required inputs: `tag` (Existing release tag to publish (for example 2026.8.1))

**CI-OpenClaw Release PR** — `openclaw-release-pr.yml`

```bash
gh workflow run openclaw-release-pr.yml --repo companionintelligence/CI-OpenClaw --ref master
```
