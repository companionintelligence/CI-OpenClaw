#!/bin/sh
# Pull inference config from the Hub and merge it into OpenClaw's .env so
# the setup wizard finds working OpenAI-compatible credentials without
# manual input.
#
# Idempotent and failure-tolerant: if the Hub is unreachable the script
# logs and exits 0. OpenClaw falls back to its setup wizard.
#
# The list of Hub-managed keys (which keys to overwrite vs preserve) is
# read from the X-Hub-Managed-Keys response header. Falls back to a
# hardcoded list if the header is missing (older Hub).
#
# POSIX sh — no bashisms. Runs in any /bin/sh including dash.
#
# Inputs:
#   CI_HUB_URL              Hub backend URL    (default: http://ci-os-hub:5002)
#                           Falls back to HUB_URL when Hub injects MCP env at install time.
#   HUB_APP_SLUG            App slug           (default: openclaw)
#   OPENCLAW_DATA_DIR       Data dir           (default: /data/.openclaw)
#   BOOTSTRAP_FIXTURE_FILE          For tests: read body from this file
#   BOOTSTRAP_FIXTURE_MANAGED_KEYS  For tests: comma-sep list overriding header parse
#
# Outputs:
#   $OPENCLAW_DATA_DIR/.env   merged in place
set -eu

CI_HUB_URL="${CI_HUB_URL:-${HUB_URL:-http://ci-os-hub:5002}}"
HUB_APP_SLUG="${HUB_APP_SLUG:-openclaw}"
DATA_DIR="${OPENCLAW_DATA_DIR:-/data/.openclaw}"
ENV_FILE="${DATA_DIR}/.env"

# Fallback list used when the Hub doesn't send X-Hub-Managed-Keys
# (older Hub releases). Kept in sync with AppBootstrapService's
# OPENCLAW env keys as a last resort.
FALLBACK_MANAGED_KEYS="OPENAI_API_BASE,OPENAI_API_KEY,DEFAULT_MODEL,DEFAULT_MODEL_BACKEND_ID,EMBEDDINGS_MODEL,EMBEDDINGS_MODEL_BACKEND_ID,OLLAMA_HOST,CI_LLM_NUM_CTX,CI_CLOUD_OPENAI_API_KEY,CI_CLOUD_OPENAI_BASE_URL,CI_CLOUD_OPENAI_MODEL,CI_CLOUD_ANTHROPIC_API_KEY,CI_CLOUD_ANTHROPIC_BASE_URL,CI_CLOUD_ANTHROPIC_MODEL,CI_CLOUD_GOOGLE_API_KEY,CI_CLOUD_GOOGLE_BASE_URL,CI_CLOUD_GOOGLE_MODEL,CI_CLOUD_GITHUB_COPILOT_API_KEY,CI_CLOUD_GITHUB_COPILOT_BASE_URL,CI_CLOUD_GITHUB_COPILOT_MODEL"

log() {
  echo "[hub-bootstrap] $*"
}

# Fetch body + capture the X-Hub-Managed-Keys header value into MANAGED_KEYS.
# Globals: body, MANAGED_KEYS
fetch_bootstrap() {
  MANAGED_KEYS=""
  if [ -n "${BOOTSTRAP_FIXTURE_FILE:-}" ]; then
    body="$(cat "${BOOTSTRAP_FIXTURE_FILE}")"
    MANAGED_KEYS="${BOOTSTRAP_FIXTURE_MANAGED_KEYS:-}"
    return 0
  fi
  url="${CI_HUB_URL}/api/inference/apps/${HUB_APP_SLUG}/bootstrap.env"
  headers_tmp="$(mktemp)"
  if ! body="$(curl --silent --show-error --fail --max-time 5 --retry 1 --retry-delay 2 -D "${headers_tmp}" "${url}")"; then
    rm -f "${headers_tmp}"
    return 1
  fi
  MANAGED_KEYS="$(awk -F': ' 'tolower($1) == "x-hub-managed-keys" { sub(/\r$/, "", $2); print $2; exit }' "${headers_tmp}")"
  rm -f "${headers_tmp}"
}

# Convert a comma-separated key list into an alternation regex pattern.
# Echoes the pattern; empty input echoes nothing.
keys_to_pattern() {
  csv="$1"
  if [ -z "${csv}" ]; then
    echo ""
    return 0
  fi
  printf '%s' "${csv}" | tr ',' '\n' | awk 'NF { printf("%s^%s=", sep, $0); sep="|" }'
}

# Strip lines whose key is in MANAGED_KEYS. Reads stdin, writes stdout.
strip_hub_keys() {
  pattern="$(keys_to_pattern "${MANAGED_KEYS}")"
  if [ -z "${pattern}" ]; then
    cat
  else
    grep -Ev "${pattern}" || true
  fi
}

# Keep only lines whose key is in MANAGED_KEYS. Reads stdin, writes stdout.
keep_hub_keys() {
  pattern="$(keys_to_pattern "${MANAGED_KEYS}")"
  if [ -z "${pattern}" ]; then
    cat
  else
    grep -E "${pattern}" || true
  fi
}

main() {
  log "fetching ${CI_HUB_URL} -> slug=${HUB_APP_SLUG}"
  body=""
  MANAGED_KEYS=""
  if ! fetch_bootstrap; then
    log "WARN: Hub unreachable or returned error; leaving .env alone"
    exit 0
  fi

  if [ -z "${body}" ]; then
    log "WARN: empty response from Hub; nothing to apply"
    exit 0
  fi

  if [ -z "${MANAGED_KEYS}" ]; then
    log "WARN: X-Hub-Managed-Keys header missing; falling back to hardcoded key list"
    MANAGED_KEYS="${FALLBACK_MANAGED_KEYS}"
  else
    log "managed keys from header: ${MANAGED_KEYS}"
  fi

  mkdir -p "${DATA_DIR}"

  hub_only="$(printf '%s\n' "${body}" | keep_hub_keys)"
  if [ -z "${hub_only}" ]; then
    log "WARN: Hub response did not contain any managed keys; .env left alone"
    exit 0
  fi

  existing=""
  if [ -f "${ENV_FILE}" ]; then
    existing="$(strip_hub_keys < "${ENV_FILE}")"
  fi

  tmp="$(mktemp)"
  if ! {
    if [ -n "${existing}" ]; then
      printf '%s\n' "${existing}"
    else
      printf '# OpenClaw Configuration\n# Hub-managed keys are rewritten on every container start.\n\n'
    fi
    printf '%s\n' "${hub_only}"
  } > "${tmp}"; then
    rm -f "${tmp}"
    log "ERROR: failed to assemble .env"
    exit 0
  fi

  mv "${tmp}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}" 2>/dev/null || true
  log "wrote ${ENV_FILE} ($(wc -l < "${ENV_FILE}" | tr -d ' ') lines)"
}

main "$@"
