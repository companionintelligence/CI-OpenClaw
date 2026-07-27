#!/usr/bin/env bash
# Unit tests for scripts/next-release-tag.sh.
#
# Runs against a throwaway repo so the collision loop can be exercised without
# touching real tags or GitHub.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/next-release-tag.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

PASS=0
FAIL=0

cd "${TMP}"
git init -q .
git -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init

check() {
  local name="$1" want="$2" got
  got="$(RELEASE_DATE_OVERRIDE=2026.7.27 bash "${SCRIPT}")"
  if [[ "${got}" == "${want}" ]]; then
    echo "  ok   ${name}: -> ${got}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL ${name}: got '${got}', want '${want}'" >&2
    FAIL=$((FAIL + 1))
  fi
}

echo "next-release-tag.sh"

check "no tag for today" "2026.7.27"

git tag 2026.7.27
check "date taken -> .1" "2026.7.27.1"

git tag 2026.7.27.1
check "and .1 taken -> .2" "2026.7.27.2"

git tag 2026.7.27.2
git tag 2026.7.27.3
check "runs of suffixes" "2026.7.27.4"

# Unrelated tags must not perturb allocation.
git tag 2026.7.26
git tag 2026.8.1
check "other dates ignored" "2026.7.27.4"

# A different day is free even though today's is exhausted.
got="$(RELEASE_DATE_OVERRIDE=2026.9.9 bash "${SCRIPT}")"
if [[ "${got}" == "2026.9.9" ]]; then
  echo "  ok   fresh date: -> ${got}"
  PASS=$((PASS + 1))
else
  echo "  FAIL fresh date: got '${got}', want '2026.9.9'" >&2
  FAIL=$((FAIL + 1))
fi

# Format must match the existing tags: unpadded components.
got="$(RELEASE_DATE_OVERRIDE="$(date -u -d 2026-07-05 +%Y.%-m.%-d 2>/dev/null || echo 2026.7.5)" bash "${SCRIPT}")"
if [[ "${got}" == "2026.7.5" ]]; then
  echo "  ok   unpadded components: -> ${got}"
  PASS=$((PASS + 1))
else
  echo "  FAIL unpadded components: got '${got}', want '2026.7.5'" >&2
  FAIL=$((FAIL + 1))
fi

# The default (no override) must produce today's UTC date in the same shape.
today="$(date -u +%Y.%-m.%-d)"
got="$(bash "${SCRIPT}")"
if [[ "${got}" == "${today}" || "${got}" == "${today}."* ]]; then
  echo "  ok   default date: -> ${got}"
  PASS=$((PASS + 1))
else
  echo "  FAIL default date: got '${got}', want '${today}[.N]'" >&2
  FAIL=$((FAIL + 1))
fi

# Exhausting the day must fail loudly rather than loop forever.
for n in $(seq 1 50); do git tag "2026.10.1.${n}" 2>/dev/null || true; done
git tag 2026.10.1 2>/dev/null || true
if RELEASE_DATE_OVERRIDE=2026.10.1 bash "${SCRIPT}" >/dev/null 2>&1; then
  echo "  FAIL exhausted day: expected non-zero exit" >&2
  FAIL=$((FAIL + 1))
else
  echo "  ok   exhausted day: exits non-zero"
  PASS=$((PASS + 1))
fi

echo "  ${PASS} passed, ${FAIL} failed"
[[ ${FAIL} -eq 0 ]]
