#!/bin/bash
# Container entrypoint: pull inference config from the Hub (idempotent),
# then hand off to the OpenClaw setup server.
set -e

# A fresh /data bind mount is created root-owned by the Docker daemon. This
# container runs as the unprivileged `node` user, which then cannot create
# /data/.openclaw and crash-loops on first boot (EACCES). `node` has
# passwordless sudo in this image, so take ownership of the mount point before
# any node-run initialization. Non-recursive: only the mount point needs
# fixing; skeleton copies and config writes below run as `node` and inherit
# correct ownership.
if [ "$(stat -c %u /data)" != "$(id -u)" ]; then
  echo "[entrypoint] /data is owned by uid $(stat -c %u /data); taking ownership as uid $(id -u)"
  sudo chown "$(id -u):$(id -g)" /data
fi

/app/bootstrap-from-hub.sh || true
/app/bootstrap-ci-memory.sh || true

exec node /app/setup-server.cjs
