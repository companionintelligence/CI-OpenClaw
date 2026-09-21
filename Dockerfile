# OpenClaw Docker Image for Umbrel
# Self-hosted personal AI assistant with web-based setup

FROM node:22-trixie-slim

# Install global deps.
#
# Python is part of the agent's sandbox, not just node-gyp's build dependency.
# A bare `python3` is Debian's minimal split — no pip, no ensurepip, so even
# `python3 -m venv` fails — which is how a coding task ended with the agent
# reporting "unable to run the tests (missing pip/python packages)".
# python3-pip + python3-venv complete the interpreter; pytest and httpx ride
# along as apt packages so a test suite runs against the system interpreter
# with no network at all; python-is-python3 gives scripts that call plain
# `python` something to find. Roughly 25 MB on top of the base image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      sudo ca-certificates curl git build-essential procps file chromium \
      python3 python3-pip python3-venv python-is-python3 python3-pytest python3-httpx \
    && rm -rf /var/lib/apt/lists/* \
    # Debian marks its interpreter "externally managed" (PEP 668), which turns a
    # plain `pip install <pkg>` into an error. This interpreter exists for the
    # agent, so drop the marker: as `node`, pip then defaults to a user install
    # under $HOME (/data/.local — persistent, and on PATH below). A per-project
    # venv (python3 -m venv / uv venv) stays the recommended route.
    && rm -f /usr/lib/python3*/EXTERNALLY-MANAGED

# uv: fast venv / package / tool manager (uv venv, uv pip, uv run, uvx).
# Copied from the official image rather than curl|sh so the pin is a digest
# and the multi-arch build picks the matching static binary per platform.
# ~55 MB. Bump the version and digest together (docker buildx imagetools
# inspect ghcr.io/astral-sh/uv:<version> prints the index digest).
COPY --from=ghcr.io/astral-sh/uv:0.12.17@sha256:10787c682e4184e4f290de1171fd4703dc63de99221f10fe1c99002ce7fa9acc /uv /uvx /usr/local/bin/

# Set home directory
ENV HOME=/data
WORKDIR /data
RUN mkdir -p /data && chown node:node /data

# Install OpenClaw globally from npm.
# Keep @openclaw/duckduckgo-plugin on the same version when bumping this pin —
# it is unpacked into /app/openclaw-context/plugins/duckduckgo after COPY below.
#
# This pin and the `FROM node:` base at the top of this file are coupled: openclaw
# declares `engines.node` and its preinstall script hard-errors on an unsupported
# Node, so a pin the base cannot run fails this RUN outright. 2026.9.3 dropped
# Node 22 (`>=24.16.0 <25 || >=26.1.0`), so this base caps the pin at 2026.9.2 —
# moving past it needs the base on node:24 in the same commit. Check before bumping:
#   npm view openclaw@<new-version> engines.node
RUN npm install -g openclaw@2026.9.1

# Redirect future npm global installs to persistent volume
ENV NPM_CONFIG_PREFIX=/data/.npm-global

# Install setup server dependencies (node-pty needs build tools, do this as root)
COPY package.json package-lock.json /app/
RUN cd /app && npm ci --omit=dev && chown -R node:node /data

# Switch to non-root user
RUN echo "node ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
USER node

# Install brew
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Shim systemctl for Docker — there's no systemd in the container, but OpenClaw's
# agent calls `systemctl --user restart openclaw-gateway` to restart the gateway.
# This script skips flags like --user to find the subcommand (restart/stop/start),
# then kills the gateway process by its process title ("openclaw-gateway").
# The container's `restart: unless-stopped` policy brings everything back.
# `|| true` prevents pkill's non-zero exit code from making the restart look like
# a failure to the agent. Anchor the pkill match so it only catches the gateway
# process, not this shim's own argv (`systemctl ... openclaw-gateway.service`).
RUN printf '#!/bin/bash\n# Skip flags (e.g. --user) to find the actual subcommand\ncmd=""\nfor arg in "$@"; do\n  case "$arg" in\n    -*) ;;\n    *) cmd="$arg"; break ;;\n  esac\ndone\ncase "$cmd" in\n  restart|stop) pkill -f "^openclaw-gateway([[:space:]]|$)" 2>/dev/null || true ;;\n  start) echo "openclaw-gateway is managed by the container" ;;\n  *) exit 0 ;;\nesac\n' | sudo tee /usr/local/bin/systemctl \
    && sudo chmod +x /usr/local/bin/systemctl

# Replace apt/apt-get with a script that points the agent at the package
# managers this sandbox does have. Each of those persists under /data, so the
# hint doubles as the "where do my installs go" answer.
RUN printf '#!/bin/bash\necho "Error: apt is not available in this sandbox. Use:" >&2\necho "  system tools:    brew install <package>" >&2\necho "  python packages: python3 -m venv .venv && . .venv/bin/activate && pip install <package>" >&2\necho "                   (or uv venv / uv pip install / uv run — uv is preinstalled; pytest and httpx already are)" >&2\necho "  node packages:   npm install -g <package>" >&2\nexit 1\n' | sudo tee /usr/local/bin/use-brew \
    && sudo chmod +x /usr/local/bin/use-brew \
    && sudo ln -s /usr/local/bin/use-brew /usr/local/bin/apt \
    && sudo ln -s /usr/local/bin/use-brew /usr/local/bin/apt-get

# Copy setup UI server, static files, and managed Umbrel context.
# OpenClaw has passwordless sudo in this image, so root ownership is not a hard
# read-only boundary. These files intentionally live outside /data so container
# runtime edits are disposable and image updates overwrite the managed context.
COPY --chown=node:node server.cjs /app/setup-server.cjs
# setup-server.cjs requires this by __dirname-relative path. Copied file-by-file (no
# COPY . /app), so a new module that is not listed here is missing from the image and
# the container dies at boot with MODULE_NOT_FOUND — while working fine in local dev.
COPY --chown=node:node config-reconcile.cjs /app/config-reconcile.cjs
COPY --chown=node:node proxy-headers.cjs /app/proxy-headers.cjs
COPY --chown=node:node memory-gate.cjs /app/memory-gate.cjs
# Error reporting is opt-out. The DSN is read from the container env at runtime —
# there is no web bundle here, so nothing is compiled in the way the fleet's Vite
# apps are. But nothing supplies it at runtime either: the marketplace runs this
# published image as-is, which is why reporting has been inert since telemetry
# landed. Released images are therefore built with `--build-arg SENTRY_DSN=…`,
# re-exported as ENV below, so a marketplace install reports out of the box.
#
# Built without the arg (local `docker build`, PR CI) the ARG default is empty,
# which resolveTelemetrySettings already treats as unset: this module initialises
# nothing and never even requires @sentry/node.
#
# Baking the DSN does not weaken the kill switches — CI_TELEMETRY=off and
# CI_LOCAL_ONLY=true are separate runtime vars, both still beat a baked-in DSN,
# and a runtime `-e SENTRY_DSN=…` still overrides this value.
# See docs/operations/error-reporting.md.
ARG SENTRY_DSN=""
ARG SENTRY_RELEASE=""
ENV SENTRY_DSN=${SENTRY_DSN} \
    SENTRY_RELEASE=${SENTRY_RELEASE}
COPY --chown=node:node telemetry.cjs /app/telemetry.cjs
COPY --chown=node:node setup.html /app/setup.html
COPY --chown=node:node logo.webp /app/logo.webp
COPY --chown=node:node assets /app/assets
COPY --chown=node:node bootstrap-from-hub.sh bootstrap-ci-memory.sh bootstrap-ci-hub-mcp.sh entrypoint.sh /app/
COPY openclaw-context /app/openclaw-context
# Vendor the keyless DuckDuckGo search plugin into the image (not into /data) so
# upgrades and existing volumes still get free web_search via reconcile. Version
# must match the openclaw@ pin above.
RUN sudo mkdir -p /app/openclaw-context/plugins/duckduckgo \
  && npm pack @openclaw/duckduckgo-plugin@2026.9.1 --pack-destination /tmp \
  && sudo tar -xzf /tmp/openclaw-duckduckgo-plugin-2026.9.1.tgz \
       -C /app/openclaw-context/plugins/duckduckgo --strip-components=1 \
  && sudo chown -R node:node /app/openclaw-context/plugins/duckduckgo \
  && rm -f /tmp/openclaw-duckduckgo-plugin-2026.9.1.tgz
RUN sudo chmod +x /app/bootstrap-from-hub.sh /app/bootstrap-ci-memory.sh /app/bootstrap-ci-hub-mcp.sh /app/entrypoint.sh

# Move home to skeleton
RUN sudo mv /data /home-skeleton
RUN sudo mv /home/linuxbrew /home-skeleton/linuxbrew

# Setup PATH. /data/.local/bin is where `pip install` (user install, see the
# PEP 668 note above) and `uv tool install` put their entry points.
ENV PATH="/data/.local/bin:/data/.npm-global/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

# Run the setup/proxy server through the bootstrap entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]
EXPOSE 18789
