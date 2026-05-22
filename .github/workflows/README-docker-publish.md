# Docker Publish Workflow Setup

This repository publishes container images with:
- workflow file: `.github/workflows/docker-publish.yml`
- image registry: `ghcr.io`
- tags pushed: release tag only

## What The Workflow Does

The workflow runs when:
- a git tag is pushed
- the `Tag CI-OpenClaw Version On Merge` workflow completes successfully

It builds multi-arch images (`linux/amd64`, `linux/arm64`) and pushes:
- `${IMAGE_NAME}:${TAG}`

## Required GitHub Settings

### 1) Repository Action Permissions

In GitHub repository settings:
- `Settings` -> `Actions` -> `General`
- Ensure actions are enabled.
- Under workflow permissions, allow write access to packages.

The workflow itself already requests:
- `contents: read`
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

## Notes

- If this repository is moved/forked, set `IMAGE_NAME` explicitly.
