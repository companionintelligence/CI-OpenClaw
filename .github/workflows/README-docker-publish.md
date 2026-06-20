# Docker Publish Workflow Setup

This repository publishes container images with:
- workflow file: `.github/workflows/docker-publish.yml`
- image registry: `ghcr.io`
- tags pushed: release tag only

## Cut a Release (runbook)

End-to-end steps to ship a new version of CI-OpenClaw and point the marketplace at it.
Tags are date-based and **un-prefixed**: `YYYY.M.D` (e.g. `2026.6.20`). Use `YYYY.M.D.N`
for a second release on the same day.

1. **Tag the release** from an up-to-date `master` — the tag push triggers the build:
   ```bash
   git fetch origin
   git tag 2026.6.20 origin/master    # tag the commit you want to ship
   git push origin 2026.6.20
   ```
   Or trigger it manually: `Actions` → `Docker Build and Push` → `Run workflow`, with
   the `tag` input (e.g. `2026.6.20`).
2. **Watch the build** in `Actions` → `Docker Build and Push` for the tag. It builds
   multi-arch (`amd64`/`arm64`), pushes
   `ghcr.io/companionintelligence/ci-openclaw:<TAG>`, and publishes a GitHub Release.
   Wait for it to go green before step 3 (the marketplace must not point at an image
   that does not exist yet).
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
4. **Deploy the catalog.** The `Deploy App Catalog` workflow runs on push to **`main`**,
   *not* on `dev` merges — so merging to `dev` alone does not publish anything. After
   the PR lands on `dev`, fast-forward `main` to it and push:
   ```bash
   git push origin origin/dev:main
   ```
   That triggers the deploy (ships every valid `config.json` to R2/D1, then
   `reconcile.js` prunes). CI-Hub picks up the new version on its next hourly pull of
   `/api/store`.

> The marketplace `version` and the image tag for **ci-openclaw** are both **un-prefixed**
> (`2026.6.20`) and must match exactly. (ci-hermes uses the `v`-prefixed form — see its
> own README-docker-publish.md.)

## What The Workflow Does

The workflow runs when:
- a git tag is pushed
- the `Tag CI-OpenClaw Version On Merge` workflow completes successfully
- manually via `workflow_dispatch` (requires a `tag` input)

It builds multi-arch images (`linux/amd64`, `linux/arm64`) and pushes:
- `${IMAGE_NAME}:${TAG}`

For tag-push and manual dispatch runs, it also creates or updates a published GitHub Release for `${TAG}`.

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

No custom secret is required for same-repo GHCR publishing.

The workflow uses the default `GITHUB_TOKEN` for `docker login ghcr.io`.

## Quick Verification

1. Push a test tag:
   - `git tag test-publish-1`
   - `git push origin test-publish-1`
2. Watch the `Docker Build and Push` run in Actions.
3. Verify package tags in GitHub Packages:
  - expected tags include `test-publish-1`
4. Verify a published release exists in the Releases tab:
  - expected release/tag include `test-publish-1`

Or run manually from GitHub Actions:
1. Open `Actions` -> `Docker Build and Push` -> `Run workflow`
2. Enter the `tag` input (example: `1.2.3`)
3. Run the workflow and verify the package tag in GHCR and a published release in the Releases tab

## Notes

- If this repository is moved/forked, set `IMAGE_NAME` explicitly.
