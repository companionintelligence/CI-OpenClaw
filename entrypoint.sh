#!/bin/bash
# Container entrypoint: pull inference config from the Hub (idempotent),
# then hand off to the OpenClaw setup server.
set -e

# A fresh /data bind mount is created root-owned by the Docker daemon. This
# container runs as the unprivileged `node` user, which then cannot create
# /data/.openclaw and crash-loops on first boot (EACCES). `node` has
# passwordless sudo in this image, so take ownership of the mount point.
#
# Gate on actual writability rather than ownership: `node` may already be able
# to write /data without owning it (mode 0777, group perms, ACLs), and the only
# thing init needs is write access. Taking ownership is non-recursive — only the
# mount point matters; skeleton copies and config writes below run as `node` and
# inherit correct ownership. A failed chown is non-fatal (some network/overlay
# mounts manage permissions externally and don't allow it): we warn and continue
# so init can proceed or surface the real error itself, instead of `set -e`
# aborting a container that might have booted fine.
if probe="$(mktemp /data/.entrypoint-write-test.XXXXXX 2>/dev/null)"; then
  rm -f "$probe"
else
  echo "[entrypoint] /data is not writable as uid $(id -u) (owned by uid $(stat -c %u /data 2>/dev/null)); taking ownership"
  sudo chown "$(id -u):$(id -g)" /data \
    || echo "[entrypoint] WARN: could not chown /data; continuing (mount may manage permissions externally)"
fi

# Homebrew lives on its own mount; an empty one gets the image's copy. Without brew the agent
# still runs, so a failure here must not stop the container.
/app/seed-linuxbrew.sh || echo "[entrypoint] WARN: could not seed /home/linuxbrew; brew may be missing"

/app/bootstrap-from-hub.sh || true
/app/bootstrap-ci-memory.sh || true
/app/bootstrap-ci-hub-mcp.sh || true

exec node /app/setup-server.cjs
