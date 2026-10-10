#!/bin/sh
# Docker HEALTHCHECK for the OpenClaw gateway. The HEALTHCHECK line is in the Dockerfile, and
# the answer comes from gateway-health.cjs.
#
# Fails only on a 503, which the setup server sends once the gateway it spawned has exited and
# nothing has restarted it, or has failed to start three times in a row. Anything else passes,
# including no answer at all: the entrypoint runs the bootstrap scripts before the setup server
# listens, and the Hub rolls an app update back unless the new container reports healthy within
# about ten seconds. If the setup server itself dies, the container exits with it, and Docker and
# the Hub see that without a healthcheck.
code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 4 \
  "http://127.0.0.1:${SETUP_PORT:-18789}/__ci_health")"
[ "${code}" != "503" ]
