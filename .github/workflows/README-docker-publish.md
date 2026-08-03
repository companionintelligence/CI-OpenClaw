# Docker Publish Workflow Setup

This repository publishes container images with:
- workflow file: `.github/workflows/docker-publish.yml`
- image registry: `ghcr.io`
- tags pushed: the release tag, plus `latest` when that tag is the newest release

## Cut a Release (runbook)

Releases are cut by hand — merging to `master` publishes nothing. Tags are date-based and
**un-prefixed**: `YYYY.M.D` (e.g. `2026.6.20`), with `YYYY.M.D.N` for a second release on the
same day.

1. **Tag the release** from an up-to-date `master` — the tag push triggers the build.
   `scripts/next-release-tag.sh` prints the next free tag for today, so you never have to
   check which suffixes are taken:
   ```bash
   git fetch origin --tags
   TAG="$(scripts/next-release-tag.sh)"
   git tag "$TAG" origin/master    # tag the commit you want to ship
   git push origin "$TAG"
   ```
   Or trigger it manually: `Actions` → `Docker Build and Push` → `Run workflow`, with
   the `tag` input (e.g. `2026.6.20`). The tag must already exist.
2. **Watch the build** in `Actions` → `Docker Build and Push` for the tag. It runs the full
   test suite, builds multi-arch (`amd64`/`arm64`), pushes
   `ghcr.io/companionintelligence/ci-openclaw:<TAG>` (plus `:latest` if `<TAG>` is the newest
   release tag), and publishes a GitHub Release. Wait for it to go green before step 3 (the
   marketplace must not point at an image that does not exist yet).
3. **Bump the marketplace** in `CI-Marketplace` so the appliance installs the new image:
   - `apps/ci-openclaw/config.json` → set `"version": "<TAG>"` (un-prefixed) and
     `"updated_at"` to the current time in **epoch milliseconds**
     (`echo "$(date +%s)000"`).
   - `apps/ci-openclaw/docker-compose.json` → set the `image:` tag to
     `ghcr.io/companionintelligence/ci-openclaw:<TAG>`.
   - Validate: `bun test && bun run scripts/audit-apps.ts` (expect `ERR=0` and no new
     `ci-openclaw` findings).
   - Open a PR against the marketplace default branch (`dev`) and merge it once the
     image from step 2 is published.
4. **Deploy the catalog.** After the PR lands on `dev`, fast-forward `main` to it and push:
   ```bash
   git push origin origin/dev:main
   ```
   That triggers `Deploy App Catalog` (ships every valid `config.json` to R2/D1, then
   `reconcile.js` prunes). CI-Hub picks up the new version on its next hourly pull of
   `/api/store`.

> The marketplace `version` and the image tag for **ci-openclaw** are both **un-prefixed**
> (`2026.6.20`) and must match exactly. (ci-hermes uses the `v`-prefixed form — see its
> own README-docker-publish.md.)

## Upstream OpenClaw bumps

`openclaw-release-pr.yml` runs daily, compares the `openclaw@` pin in the `Dockerfile` against
npm's `latest` dist-tag, and opens a PR when they differ. Merging that PR updates the pin;
it does **not** cut a release. Ship it with the runbook above when you want it out.

The pin is read by `scripts/openclaw-pin.sh` everywhere — workflows, docs, and the schema
gate. Do not re-inline the grep: the pattern it replaced stopped at a hyphen, so a pin of
`2026.7.1-2` (upstream's own same-day patch form) read back as `2026.7.1`.

## What The Workflow Does

The workflow runs when:
- a release tag is pushed — the glob is `[0-9]*.[0-9]*.[0-9]*`, so a tag needs at least
  three dot-separated segments starting with a digit. `2026.8.1` and `2026.8.1.2` match;
  `2026.8` and `test-publish-1` do not, and produce no run at all — no red X, no
  notification. If nothing appears in Actions after a tag push, check the tag shape first.
- manually via `workflow_dispatch` (requires a `tag` input naming an existing tag; optional
  `dry_run` builds without pushing)

It runs `ci.yml` as a gate, then builds multi-arch images (`linux/amd64`, `linux/arm64`) and
pushes:
- `${IMAGE_NAME}:${TAG}`
- `${IMAGE_NAME}:latest` — **only** when `${TAG}` is the newest release tag, so republishing
  an older tag cannot regress `latest`

It also creates or updates a published GitHub Release for `${TAG}`, and labels the image with
the bundled openclaw version (`io.companionintelligence.openclaw.version`).

Both the test gate and the build check out **the tag itself**, so the tested tree, the built
tree, and the tagged commit are always the same commit.

The `:latest` rule lives in `scripts/newest-release-tag.sh` rather than inline in the
workflow, so it is covered by `npm test`. It accepts exactly the shape
`scripts/next-release-tag.sh` allocates and prints nothing when no release tag exists — a tag
that does not match publishes its own tag and leaves `:latest` alone.

Layers are cached in the registry (`<IMAGE_NAME>:buildcache`), not in the Actions cache.
Actions cache entries are scoped to the ref that wrote them, and this workflow only ever runs
on `refs/tags/*`, so a GHA cache could never be read by the next release while still consuming
the repo's shared 10&nbsp;GB quota.

## Required GitHub Settings

### 1) Repository Action Permissions

In GitHub repository settings:
- `Settings` -> `Actions` -> `General`
- Ensure actions are enabled.
- Under workflow permissions, allow write access to packages.

The workflow itself already requests:
- `contents: write`
- `packages: write`

### 2) Repository Variables

Set these in:
- `Settings` -> `Secrets and variables` -> `Actions` -> `Variables`

Optional variables:
- `IMAGE_NAME`
  - Default: `ghcr.io/${{ github.repository }}`
  - Recommended value: `ghcr.io/companionintelligence/ci-openclaw`

### 3) Repository Secrets

No custom secret is required for same-repo GHCR publishing — the workflow uses the default
`GITHUB_TOKEN` for `docker login ghcr.io`.

`openclaw-release-pr.yml` uses `CI_HUB_SYNC_TOKEN` to open its bump PR, so that PR gets
PR-time CI (PRs opened with `GITHUB_TOKEN` do not trigger workflows).

## Quick Verification

Use a dry run against an existing tag — it exercises the full path (test gate, tag
resolution, the `:latest` decision, multi-arch build) without writing to the registry or
touching a Release:

1. `Actions` -> `Docker Build and Push` -> `Run workflow`
2. `tag`: an existing older release (e.g. `2026.7.13`); `dry_run`: checked
3. Expect in the log: `TAG=2026.7.13`, a notice that it is not the newest tag so `:latest` is
   left alone, and no push.

Do **not** verify by pushing a throwaway tag. That was the old recipe, and under the previous
`tags: ["*"]` trigger it published a real image and moved `:latest` onto it.

## Notes

- If this repository is moved/forked, set `IMAGE_NAME` explicitly.
- Known oddity: git tag `2026.7.1` exists but has no image. It was created by the old
  merge-tagger, whose publish run built the pre-merge branch tip and failed. Left in place
  rather than deleted; a date-based tag can never reuse that name.
- Known limitation: the `:latest` decision reads the tag list at checkout time, and a
  multi-arch build can take well over an hour. Cutting two releases inside one build window
  can therefore land them out of order and leave `:latest` on the older of the two. Cut one
  release at a time, or wait for the run to go green before pushing the next tag.
