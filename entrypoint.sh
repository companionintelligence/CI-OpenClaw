#!/bin/bash
# Container entrypoint: pull inference config from the Hub (idempotent),
# then hand off to the OpenClaw setup server.
set -e

/app/bootstrap-from-hub.sh || true

exec node /app/setup-server.cjs
