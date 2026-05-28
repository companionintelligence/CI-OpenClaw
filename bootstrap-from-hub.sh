#!/bin/bash
# Pull inference config from the Hub and merge it into OpenClaw's .env so
# the setup wizard finds working OpenAI-compatible credentials without
# manual input.
#
# Idempotent and failure-tolerant: if the Hub is unreachable the script
# logs and exits 0. OpenClaw falls back to its setup wizard.
#
# Only Hub-managed keys (OPENAI_API_BASE, OPENAI_API_KEY, DEFAULT_MODEL,
# DEFAULT_MODEL_BACKEND_ID, EMBEDDINGS_MODEL, EMBEDDINGS_MODEL_BACKEND_ID)
# are overwritten. Anything else in the .env is left as-is.
#
# Inputs:
#   CI_HUB_URL              Hub backend URL    (default: http://ci-os-hub:3000)
#   HUB_APP_SLUG            App slug           (default: openclaw)
#   OPENCLAW_DATA_DIR       Data dir           (default: /data/.openclaw)
#   BOOTSTRAP_FIXTURE_FILE  For tests: read body from this file instead of curling
#
# Outputs:
#   $OPENCLAW_DATA_DIR/.env   merged in place
set -euo pipefail

CI_HUB_URL="${CI_HUB_URL:-http://ci-os-hub:3000}"
HUB_APP_SLUG="${HUB_APP_SLUG:-openclaw}"
DATA_DIR="${OPENCLAW_DATA_DIR:-/data/.openclaw}"
ENV_FILE="${DATA_DIR}/.env"

HUB_MANAGED_KEYS=(
  OPENAI_API_BASE
  OPENAI_API_KEY
  DEFAULT_MODEL
  DEFAULT_MODEL_BACKEND_ID
  EMBEDDINGS_MODEL
  EMBEDDINGS_MODEL_BACKEND_ID
)

log() {
  echo "[hub-bootstrap] $*"
}

fetch_bootstrap() {
  if [[ -n "${BOOTSTRAP_FIXTURE_FILE:-}" ]]; then
    cat "${BOOTSTRAP_FIXTURE_FILE}"
    return 0
  fi
  local url="${CI_HUB_URL}/api/inference/apps/${HUB_APP_SLUG}/bootstrap.env"
  curl --silent --show-error --fail --max-time 5 --retry 1 --retry-delay 2 "${url}"
}

# Strip lines whose keys appear in HUB_MANAGED_KEYS. Used to drop the existing
# Hub-managed values before re-appending the fresh ones.
strip_hub_keys() {
  local pattern=""
  for k in "${HUB_MANAGED_KEYS[@]}"; do
    [[ -n "${pattern}" ]] && pattern+="|"
    pattern+="^${k}="
  done
  if [[ -z "${pattern}" ]]; then
    cat
  else
    grep -Ev "${pattern}" || true
  fi
}

# Keep only lines whose keys appear in HUB_MANAGED_KEYS. Used to filter the
# Hub response down to the keys we're allowed to write.
keep_hub_keys() {
  local pattern=""
  for k in "${HUB_MANAGED_KEYS[@]}"; do
    [[ -n "${pattern}" ]] && pattern+="|"
    pattern+="^${k}="
  done
  if [[ -z "${pattern}" ]]; then
    cat
  else
    grep -E "${pattern}" || true
  fi
}

main() {
  log "fetching ${CI_HUB_URL} → slug=${HUB_APP_SLUG}"
  local body
  if ! body="$(fetch_bootstrap)"; then
    log "WARN: Hub unreachable or returned error; leaving .env alone"
    exit 0
  fi

  if [[ -z "${body}" ]]; then
    log "WARN: empty response from Hub; nothing to apply"
    exit 0
  fi

  mkdir -p "${DATA_DIR}"

  local hub_only
  hub_only="$(printf '%s\n' "${body}" | keep_hub_keys)"
  if [[ -z "${hub_only}" ]]; then
    log "WARN: Hub response did not contain any managed keys; .env left alone"
    exit 0
  fi

  local existing=""
  if [[ -f "${ENV_FILE}" ]]; then
    existing="$(strip_hub_keys < "${ENV_FILE}")"
  fi

  local tmp
  tmp="$(mktemp)"
  {
    if [[ -n "${existing}" ]]; then
      printf '%s\n' "${existing}"
    else
      printf '# OpenClaw Configuration\n# Hub-managed keys are rewritten on every container start.\n\n'
    fi
    printf '%s\n' "${hub_only}"
  } > "${tmp}" || { rm -f "${tmp}"; log "ERROR: failed to assemble .env"; exit 0; }

  mv "${tmp}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}" 2>/dev/null || true
  log "wrote ${ENV_FILE} ($(wc -l < "${ENV_FILE}" | tr -d ' ') lines)"
}

main "$@"
