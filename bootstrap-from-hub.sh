#!/bin/sh
# Pull inference config from the Hub and merge it into OpenClaw's .env so
# the setup wizard finds working OpenAI-compatible credentials without
# manual input.
#
# Idempotent and failure-tolerant: if the Hub is unreachable the script
# logs and exits 0. OpenClaw falls back to its setup wizard.
#
# When the Hub can't be reached, or answers 5xx, 408 or 429 while it starts, it also
# leaves $OPENCLAW_DATA_DIR/.hub-handout-pending behind. Any other answer removes the
# file: a handout once it is written, also another HTTP error, an empty answer or one
# with no managed keys, since asking again won't change those. While the file is there
# the setup server runs this script again every HUB_BOOTSTRAP_RETRY_INTERVAL seconds
# (30 by default; see hub-handout-retry.cjs), so a Hub still starting after a reboot
# reaches OpenClaw without another restart.
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
#   HUB_BOOTSTRAP_TIMEOUT   Whole seconds to wait for each handout request (default: 20)
#   BOOTSTRAP_FIXTURE_FILE          For tests: read body from this file
#   BOOTSTRAP_FIXTURE_MANAGED_KEYS  For tests: comma-sep list overriding header parse
#
# Outputs:
#   $OPENCLAW_DATA_DIR/.env                  merged in place
#   $OPENCLAW_DATA_DIR/.hub-handout-pending  present while the Hub can't be reached
set -eu

CI_HUB_URL="${CI_HUB_URL:-${HUB_URL:-http://ci-os-hub:5002}}"
HUB_APP_SLUG="${HUB_APP_SLUG:-openclaw}"
DATA_DIR="${OPENCLAW_DATA_DIR:-/data/.openclaw}"
ENV_FILE="${DATA_DIR}/.env"
PENDING_FILE="${DATA_DIR}/.hub-handout-pending"

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
    # A missing fixture is a Hub that can't be reached.
    body="$(cat "${BOOTSTRAP_FIXTURE_FILE}")" || return 1
    MANAGED_KEYS="${BOOTSTRAP_FIXTURE_MANAGED_KEYS:-}"
    return 0
  fi
  url="${CI_HUB_URL}/api/inference/apps/${HUB_APP_SLUG}/bootstrap.env"
  headers_tmp="$(mktemp)"
  # The Hub's handout can take 10 s or more: it probes Ollama addresses that may not
  # answer, 3 s each, before it replies. At 5 s per try both tries ran out and
  # OpenClaw kept its old inference settings on every start. Connecting gets 5 s,
  # so a Hub that never accepts costs about 12 s and one that accepts and then
  # stalls about 42 s.
  max_time="$(handout_timeout)"
  # Returns curl's own status: 22 is an HTTP error (--fail), so the Hub is up. But a Hub
  # that is still starting, or the proxy in front of it, answers 502, 503 or 504, and
  # asking again will change that, so a 5xx, 408 or 429 returns 75 (try again) instead.
  rc=0
  body="$(curl --silent --show-error --fail --connect-timeout 5 --max-time "${max_time}" --retry 1 --retry-delay 2 -D "${headers_tmp}" "${url}")" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    if [ "${rc}" -eq 22 ]; then
      status="$(awk '/^HTTP\// { code = $2 } END { print code }' "${headers_tmp}")"
      case "${status}" in
        5??|408|429) rc=75 ;;
      esac
    fi
    rm -f "${headers_tmp}"
    return "${rc}"
  fi
  MANAGED_KEYS="$(awk -F': ' 'tolower($1) == "x-hub-managed-keys" { sub(/\r$/, "", $2); print $2; exit }' "${headers_tmp}")"
  rm -f "${headers_tmp}"
}

# HUB_BOOTSTRAP_TIMEOUT as curl --max-time. curl reads 0 as "no limit", so a Hub
# that stalls would hang the container start, and it exits at once on a
# non-number, so every handout would be skipped. Either value falls back to 20 s.
handout_timeout() {
  t="${HUB_BOOTSTRAP_TIMEOUT:-}"
  case "${t}" in
    '') echo 20; return 0 ;;
    *[!0-9]*) ;;
    *) if [ "${t}" -gt 0 ] 2>/dev/null; then echo "${t}"; return 0; fi ;;
  esac
  log "WARN: HUB_BOOTSTRAP_TIMEOUT=${t} is not a positive whole number of seconds; using 20" >&2
  echo 20
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

# The Hub can't be reached: the setup server asks again while this file is there.
# touch, not `: >`: dash exits the whole script when a special builtin's redirection
# fails.
mark_pending() {
  if ! { mkdir -p "${DATA_DIR}" && touch "${PENDING_FILE}"; } 2>/dev/null; then
    log "WARN: could not write ${PENDING_FILE}; OpenClaw will not ask the Hub again until it restarts"
  fi
}

answered() {
  rm -f "${PENDING_FILE}"
}

main() {
  log "fetching ${CI_HUB_URL} -> slug=${HUB_APP_SLUG}"
  body=""
  MANAGED_KEYS=""
  rc=0
  fetch_bootstrap || rc=$?
  if [ "${rc}" -eq 22 ]; then
    log "WARN: Hub returned an error; leaving .env alone"
    answered
    exit 0
  fi
  if [ "${rc}" -ne 0 ]; then
    log "WARN: Hub unreachable or not ready yet; leaving .env alone"
    mark_pending
    exit 0
  fi

  if [ -z "${body}" ]; then
    log "WARN: empty response from Hub; nothing to apply"
    answered
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
    answered
    exit 0
  fi

  existing=""
  if [ -f "${ENV_FILE}" ]; then
    existing="$(strip_hub_keys < "${ENV_FILE}")"
  fi

  # Beside .env, so the mv below is a rename on the same filesystem.
  if ! tmp="$(mktemp "${ENV_FILE}.XXXXXX")"; then
    log "ERROR: cannot write beside ${ENV_FILE}; .env left alone"
    exit 0
  fi
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

  chmod 600 "${tmp}" 2>/dev/null || true
  if ! mv "${tmp}" "${ENV_FILE}"; then
    rm -f "${tmp}"
    log "ERROR: could not replace ${ENV_FILE}; .env left alone"
    exit 0
  fi
  answered
  log "wrote ${ENV_FILE} ($(wc -l < "${ENV_FILE}" | tr -d ' ') lines)"
}

main "$@"
