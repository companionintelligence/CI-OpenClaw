# Docker Publish Workflow Setup

This repository publishes container images with:
- workflow file: `.github/workflows/docker-publish.yml`
- image registry: `ghcr.io`
- tags pushed: release tag only

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
