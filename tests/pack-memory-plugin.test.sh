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

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if grep -qF -- "${needle}" <<<"${haystack}"; then
    echo "  ✓ ${label}"
    PASS=$((PASS + 1))
  else
    echo "  ✗ ${label}"
    echo "    expected output to contain: ${needle}"
    echo "    got: ${haystack}"
    FAIL=$((FAIL + 1))
  fi
}

# run_status CMD... — run, capturing status without tripping set -e.
run_status() {
  local status=0
  "$@" >/dev/null 2>&1 || status=$?
  printf '%s' "${status}"
}

TREE_PKG_VERSION="$(node -e 'console.log(require(process.argv[1]).version)' "${PLUGIN_DIR}/package.json")"
TREE_MANIFEST_VERSION="$(node -e 'console.log(require(process.argv[1]).version)' "${PLUGIN_DIR}/openclaw.plugin.json")"

echo "pack-memory-plugin.sh"

echo "release tag → npm version"
assert_eq "plain CalVer passes through" "2026.7.28" "$("${SCRIPT}" --npm-version 2026.7.28)"
assert_eq "same-day suffix becomes a prerelease" "2026.7.7-2" "$("${SCRIPT}" --npm-version 2026.7.7.2)"
assert_eq "a leading v is tolerated" "2026.8.1" "$("${SCRIPT}" --npm-version v2026.8.1)"
assert_eq "an already-mapped version is idempotent" "2026.7.7-2" "$("${SCRIPT}" --npm-version 2026.7.7-2)"
assert_eq "a non-release tag is a setup error" "2" "$(run_status "${SCRIPT}" --npm-version latest)"
assert_eq "a zero-padded tag is refused" "2" "$(run_status "${SCRIPT}" --npm-version v2026.08.01)"
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
# just tested is a tree nobody reviewed. Captured before/after rather than compared
# to a literal, so a legitimate version bump in the tree does not fail this for a
# reason that has nothing to do with what it is testing.
assert_eq "package.json in the working tree is untouched" "${TREE_PKG_VERSION}" \
  "$(node -e 'console.log(require(process.argv[1]).version)' "${PLUGIN_DIR}/package.json")"
assert_eq "openclaw.plugin.json in the working tree is untouched" "${TREE_MANIFEST_VERSION}" \
  "$(node -e 'console.log(require(process.argv[1]).version)' "${PLUGIN_DIR}/openclaw.plugin.json")"
# `private: true` is what stops a stray `npm publish` from the plugin directory
# burning a version and moving the `latest` dist-tag the change-guard reads.
assert_eq "the working tree keeps private: true" "true" \
  "$(node -e 'console.log(require(process.argv[1]).private)' "${PLUGIN_DIR}/package.json")"
assert_eq "the published tarball drops private" "undefined" \
  "$(tar -xzOf "${TGZ_A}" package/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(String(JSON.parse(s).private)))')"

# The licence drifted once: LICENSE became PolyForm Noncommercial on 2026-09-10 and the
# plugin went to npm as MIT four days later, with nothing to notice. The tarball carries
# no LICENSE file, so the package.json field and the README notice are all that travel
# with it. The notice is read from LICENSE so this follows a change of licensor.
assert_eq "the published tarball declares the repository's licence" "PolyForm-Noncommercial-1.0.0" \
  "$(tar -xzOf "${TGZ_A}" package/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).license))')"
REQUIRED_NOTICE="$(sed -n 's/^> *\(Required Notice:.*\)$/\1/p' "${HERE}/../LICENSE" | head -n1)"
assert_contains "LICENSE has a Required Notice line to compare against" "Required Notice:" "${REQUIRED_NOTICE}"
assert_contains "the packed README carries the Required Notice from LICENSE" "${REQUIRED_NOTICE}" \
  "$(tar -xzOf "${TGZ_A}" package/README.md)"

echo "the files allowlist covers the plugin directory"
# The guard that stops the worst failure this script can produce. `files` is a
# hand-maintained allowlist while the appliance image copies the whole directory, so
# a new module that nobody adds to `files` ships in the image, is absent from the
# tarball, and makes every future release compare as "identical" and skip — leaving
# npm users importing a module that is not there, on a permanently green pipeline.
STRAY="${PLUGIN_DIR}/__packaging_probe.js"
printf 'export const probe = 1;\n' >"${STRAY}"
STRAY_STATUS="$(run_status "${SCRIPT}" --pack --version 2026.8.2 --out "${WORK}/stray")"
STRAY_OUT="$("${SCRIPT}" --pack --version 2026.8.2 --out "${WORK}/stray" 2>&1 || true)"
rm -f "${STRAY}"
assert_eq "an unlisted file in the plugin dir fails the pack" "2" "${STRAY_STATUS}"
assert_contains "and names the offending file" "__packaging_probe.js" "${STRAY_OUT}"

# The excluded set must still not trip it, or every pack fails and the guard gets
# deleted by the next person in a hurry.
assert_eq "the plugin's own test files do not trip it" "0" \
  "$(run_status "${SCRIPT}" --pack --version 2026.8.3 --out "${WORK}/ok")"

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

# Exit 1 means exactly one thing to the publish workflow: "the plugin changed, ship
# it". An internal failure that surfaced as 1 would silently become a release, so a
# corrupt input must be 2 and never 1.
printf 'not a tarball\n' >"${WORK}/corrupt.tgz"
assert_eq "a corrupt tarball is a setup error, not a difference" "2" \
  "$(run_status "${SCRIPT}" --compare "${TGZ_A}" "${WORK}/corrupt.tgz")"

# A version carrying JSON or regex metacharacters must be refused rather than
# silently producing a valid-looking tarball with a corrupt manifest.
assert_eq "a hostile --version is refused" "2" \
  "$(run_status "${SCRIPT}" --pack --version '1.0.0-x&y' --out "${WORK}/hostile")"
# `tar --strip-components=1` drops single-component members and still exits 0, so a
# differently rooted tarball extracts to nothing. Two of those must not compare equal.
mkdir -p "${WORK}/flat"
printf 'name: x\nversion: 1.0.0\n' >"${WORK}/flat/plugin.yaml"
tar -czf "${WORK}/flat1.tgz" -C "${WORK}/flat" plugin.yaml
tar -czf "${WORK}/flat2.tgz" -C "${WORK}/flat" plugin.yaml
assert_eq "two empty extractions are not called identical" "2" \
  "$(run_status "${SCRIPT}" --compare "${WORK}/flat1.tgz" "${WORK}/flat2.tgz")"

# One of the two tarballs is fetched from the registry, so its member names are the
# only input here this script does not produce itself. A member resolving outside the
# extraction directory must be a setup error (2), never a difference (1) — and must not
# rely on the local tar refusing it, since GNU tar errors out where bsdtar skips the
# member and still exits 0.
mkdir -p "${WORK}/evil/sub/package"
printf 'x\n' >"${WORK}/evil/ESCAPED"
printf 'x\n' >"${WORK}/evil/sub/package/index.js"
# -P keeps the `..` that tar would otherwise strip while writing the archive.
( cd "${WORK}/evil/sub" && tar -cPzf "${WORK}/traverse.tgz" package ../ESCAPED ) 2>/dev/null
# Assert the fixture itself, or a tar that strips `..` at create time would make the
# check below pass for entirely the wrong reason.
assert_contains "the traversal fixture really carries a .. member" "../ESCAPED" \
  "$(tar -tzf "${WORK}/traverse.tgz" 2>/dev/null)"
assert_eq "a path-traversing tarball is a setup error" "2" \
  "$(run_status "${SCRIPT}" --compare "${TGZ_A}" "${WORK}/traverse.tgz")"

assert_eq "no mode is a usage error" "2" "$(run_status "${SCRIPT}")"

echo
echo "  ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
