#!/usr/bin/env bash
# Unit tests for scripts/openclaw-pin.sh.
#
# The regression these guard: the previous inline pattern
# `openclaw@[0-9]+(\.[0-9]+)*` truncated at a hyphen, so `openclaw@2026.7.1-2`
# read back as `2026.7.1`. That made the bump bot compare a truncated pin
# against the full upstream version forever.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/openclaw-pin.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

PASS=0
FAIL=0

check() {
  local name="$1" pin="$2" want="$3" got
  printf 'RUN npm install -g openclaw@%s\n' "${pin}" > "${TMP}/Dockerfile"
  got="$(bash "${SCRIPT}" "${TMP}/Dockerfile")"
  if [[ "${got}" == "${want}" ]]; then
    echo "  ok   ${name}: ${pin} -> ${got}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL ${name}: ${pin} -> got '${got}', want '${want}'" >&2
    FAIL=$((FAIL + 1))
  fi
}

echo "openclaw-pin.sh"
check "plain version"        "2026.7.1"        "2026.7.1"
check "same-day patch"       "2026.7.1-2"      "2026.7.1-2"
check "prerelease"           "2026.7.2-beta.4" "2026.7.2-beta.4"
check "two-component"        "2026.7"          "2026.7"
check "four-component"       "2026.7.1.3"      "2026.7.1.3"

# A Dockerfile with no pin must fail loudly rather than print an empty string —
# an empty version silently became `openclaw@` in every caller.
printf 'FROM node:22\n' > "${TMP}/Dockerfile"
if bash "${SCRIPT}" "${TMP}/Dockerfile" >/dev/null 2>&1; then
  echo "  FAIL missing pin: expected non-zero exit" >&2
  FAIL=$((FAIL + 1))
else
  echo "  ok   missing pin: exits non-zero"
  PASS=$((PASS + 1))
fi

# The real Dockerfile must be readable by the same code path.
real="$(bash "${SCRIPT}")"
if [[ -n "${real}" ]]; then
  echo "  ok   repo Dockerfile: ${real}"
  PASS=$((PASS + 1))
else
  echo "  FAIL repo Dockerfile: empty" >&2
  FAIL=$((FAIL + 1))
fi

echo "  ${PASS} passed, ${FAIL} failed"
[[ ${FAIL} -eq 0 ]]
