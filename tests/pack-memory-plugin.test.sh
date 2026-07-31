#!/bin/bash
# Tests for scripts/pack-memory-plugin.sh — the npm packaging seam for the
# Companion Intelligence memory plugin.
#
# These cover the two decisions that would silently ship something wrong: the
# release-tag → npm-version mapping (a 4-segment same-day tag is not semver and npm
# rejects it), and `--compare`, which decides whether a release tag actually changed
# the plugin or is an image-only release that should not mint an npm version.
#
# Network-free: `--compare` takes two local tarballs, so the suite needs no registry
# and runs anywhere `npm run test:sh` does.
#
# Exit-code contract under test: 0 = success / tarballs equivalent, 1 = tarballs
# differ, 2 = usage or setup error.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../scripts/pack-memory-plugin.sh"
PLUGIN_DIR="${HERE}/../openclaw-context/plugins/companionintelligence"

PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

assert_eq() {
  local label="$1" want="$2" got="$3"
  if [[ "${want}" == "${got}" ]]; then
    echo "  ✓ ${label}"
    PASS=$((PASS + 1))
  else
    echo "  ✗ ${label}"
    echo "    want: ${want}"
    echo "    got:  ${got}"
    FAIL=$((FAIL + 1))
  fi
}

# run_status CMD... — run, capturing status without tripping set -e.
run_status() {
  local status=0
  "$@" >/dev/null 2>&1 || status=$?
  printf '%s' "${status}"
}

echo "pack-memory-plugin.sh"

echo "release tag → npm version"
assert_eq "plain CalVer passes through" "2026.7.28" "$("${SCRIPT}" --npm-version 2026.7.28)"
assert_eq "same-day suffix becomes a prerelease" "2026.7.7-2" "$("${SCRIPT}" --npm-version 2026.7.7.2)"
assert_eq "a leading v is tolerated" "2026.8.1" "$("${SCRIPT}" --npm-version v2026.8.1)"
assert_eq "an already-mapped version is idempotent" "2026.7.7-2" "$("${SCRIPT}" --npm-version 2026.7.7-2)"
assert_eq "a non-release tag is a setup error" "2" "$(run_status "${SCRIPT}" --npm-version latest)"
assert_eq "an empty tag is a setup error" "2" "$(run_status "${SCRIPT}" --npm-version "")"

echo "packing"
TGZ_A="$("${SCRIPT}" --pack --version 2026.8.1 --out "${WORK}/a")"
assert_eq "pack prints a path that exists" "yes" "$([[ -f "${TGZ_A}" ]] && echo yes || echo no)"

# LC_ALL=C so the expected order is the byte order everywhere; a locale-collated
# sort puts README.md in a different place on a CI runner than on a dev machine.
CONTENTS="$(tar -tzf "${TGZ_A}" | LC_ALL=C sort | tr '\n' ' ')"
assert_eq "ships exactly the plugin files, no tests" \
  "package/README.md package/index.js package/intentCatalog.js package/openclaw.plugin.json package/package.json " \
  "${CONTENTS}"

assert_eq "package.json is stamped with the release version" "2026.8.1" \
  "$(tar -xzOf "${TGZ_A}" package/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
# The manifest version is what `openclaw plugins list` shows a user. Publishing it
# unstamped means installing 2026.8.1 and being told the plugin is 1.0.0.
assert_eq "openclaw.plugin.json is stamped too" "2026.8.1" \
  "$(tar -xzOf "${TGZ_A}" package/openclaw.plugin.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"

# Staging must not write to the checkout: a publish job that mutates the tree it
# just tested is a tree nobody reviewed.
assert_eq "the working tree is left unstamped" "1.0.0" \
  "$(node -e 'console.log(require(process.argv[1]).version)' "${PLUGIN_DIR}/package.json")"

echo "comparing"
TGZ_B="$("${SCRIPT}" --pack --version 2026.9.9 --out "${WORK}/b")"
assert_eq "same plugin at two versions compares equal" "0" "$(run_status "${SCRIPT}" --compare "${TGZ_A}" "${TGZ_B}")"

# A changed plugin must compare unequal, or an image-only release skip would swallow
# a real plugin fix and never publish it.
CHANGED="${WORK}/changed"
mkdir -p "${CHANGED}"
tar -xzf "${TGZ_B}" -C "${CHANGED}"
printf '\n// a real change\n' >>"${CHANGED}/package/index.js"
tar -czf "${WORK}/changed.tgz" -C "${CHANGED}" package
assert_eq "a changed plugin compares unequal" "1" "$(run_status "${SCRIPT}" --compare "${TGZ_A}" "${WORK}/changed.tgz")"

assert_eq "a missing tarball is a setup error" "2" "$(run_status "${SCRIPT}" --compare "${TGZ_A}" "${WORK}/nope.tgz")"
assert_eq "no mode is a usage error" "2" "$(run_status "${SCRIPT}")"

echo
echo "  ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
