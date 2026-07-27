#!/usr/bin/env bash
# Unit tests for scripts/newest-release-tag.sh.
#
# This script decides whether a build moves `:latest`, so the cases that matter
# are the ones where "newest" is not the lexicographically last tag, and the ones
# where there is no release tag at all — that used to abort the publish, because
# grep exiting 1 on no match trips `pipefail`.
#
# Runs against a throwaway repo so tag sets can be constructed freely.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/newest-release-tag.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

PASS=0
FAIL=0

cd "${TMP}"
git init -q .
git -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init

# Each case starts from a clean tag set.
reset_tags() {
  local t
  for t in $(git tag --list); do git tag -d "${t}" >/dev/null; done
}

check() {
  local name="$1" want="$2" got status
  set +e
  got="$(bash "${SCRIPT}")"
  status=$?
  set -e
  if [[ ${status} -ne 0 ]]; then
    echo "  FAIL ${name}: exited ${status}, want 0" >&2
    FAIL=$((FAIL + 1))
  elif [[ "${got}" == "${want}" ]]; then
    echo "  ok   ${name}: -> '${got}'"
    PASS=$((PASS + 1))
  else
    echo "  FAIL ${name}: got '${got}', want '${want}'" >&2
    FAIL=$((FAIL + 1))
  fi
}

echo "newest-release-tag.sh"

# No tags at all must be empty output and exit 0, not a failed pipeline.
check "no tags -> empty, exit 0" ""

# Digit-leading tags that are not releases still reach the publish (the push
# trigger is `[0-9]*`), and must not win :latest.
git tag 1.2.3
git tag 2026.7
git tag test-publish-1
check "no release tags -> empty" ""

reset_tags
git tag 2026.7.9
git tag 2026.7.13
git tag 2026.7.27
# Byte order would pick 2026.7.9 here; version sort must pick 2026.7.27.
check "numeric components, not bytes" "2026.7.27"

git tag 2026.7.27.1
check "same-day suffix outranks bare date" "2026.7.27.1"

git tag 2026.7.27.2
check "runs of suffixes" "2026.7.27.2"

# A later month must win even though its day is smaller.
git tag 2026.8.1
check "month dominates day" "2026.8.1"

reset_tags
git tag 2026.7.27
git tag v2026.8.1
git tag 2026.8.1.2.3
git tag 2026.8.1-rc1
check "prefixed/overlong/prerelease forms ignored" "2026.7.27"

# Zero-padded components are ignored on purpose. git's version sort gives them
# strverscmp's fractional reading, so `--sort=-v:refname` puts 2026.08.01 BELOW
# 2026.7.27 — matching them would rank them wrongly. Nothing allocates a padded
# tag, so this only fires for a hand-pushed one, which then publishes its own tag
# without claiming :latest.
reset_tags
git tag 2026.7.27
git tag 2026.08.01
check "zero-padded tag ignored, not mis-ranked" "2026.7.27"

echo "  ${PASS} passed, ${FAIL} failed"
[[ ${FAIL} -eq 0 ]]
