#!/usr/bin/env bash
# Package the Companion Intelligence memory plugin for npm, and decide whether a
# release actually changed it.
#
# WHY THIS EXISTS
#
# The plugin is published to npm because that is OpenClaw's own plugin channel:
# `openclaw plugins install npm:@companionintelligence/openclaw-memory`. Publishing
# is triggered by the same release tags that publish the container image, so most
# tags carry no plugin change at all (an openclaw pin bump, a wrapper fix). Minting
# an npm version per image release would bury the versions that mean something in a
# stream of identical ones — hence `--compare`, which the publish workflow uses to
# skip a no-op release.
#
# TWO VERSION FIELDS, BOTH STAMPED
#
# `package.json` version is the npm coordinate. `openclaw.plugin.json` version is
# what `openclaw plugins list` shows a user — verified: the manifest drives the
# displayed version, package.json only supplies the package name. Publishing one
# without the other means a user installs 2026.8.5 and sees 1.0.0, so `--pack`
# stamps both.
#
# The working tree keeps 1.0.0 in both files. That is the version the appliance
# image ships (it copies this directory, it does not install from npm), so the tree
# value stays meaningful and no placeholder leaks into a shipped product. Stamping
# happens in a staging copy; this script never writes to the working tree.
#
# NOTE: a manual `npm publish` from the plugin directory would publish the unstamped
# 1.0.0 and burn that version. Publish through .github/workflows/npm-publish.yml.
#
# USAGE
#   pack-memory-plugin.sh --npm-version <tag>              # map a release tag to an npm version
#   pack-memory-plugin.sh --pack --version <v> --out <dir> # stage, stamp, npm pack; prints the tarball path
#   pack-memory-plugin.sh --compare <a.tgz> <b.tgz>        # 0 = same plugin, 1 = differs (version fields ignored)
#
# EXIT CODES
#   0  success, or --compare found the two tarballs equivalent
#   1  --compare found a real difference (for the publish workflow: publish)
#   2  usage or setup error
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)/openclaw-context/plugins/companionintelligence"
# Both files carry a version and both are stamped; normalising them is what makes
# --compare answer "did the plugin change" rather than "is this a different release".
VERSIONED_FILES=(package.json openclaw.plugin.json)
# Files that legitimately live in the plugin directory but must not ship. Anything
# in the directory matching none of these MUST appear in the tarball — see
# assert_files_cover_plugin_dir for why that check exists at all.
NOT_PUBLISHED=('*.test.js')

die() { echo "$*" >&2; exit 2; }

# Temp dirs are registered here and removed by a single EXIT trap. A per-function
# `trap ... RETURN` does not fire when the function exits (every `die`) or when
# errexit aborts it, which leaked a full copy of the plugin source per failure.
TMPDIRS=()
cleanup() {
  local d
  for d in "${TMPDIRS[@]:-}"; do
    if [[ -n "${d}" && -d "${d}" ]]; then rm -rf "${d}"; fi
  done
  # Explicit: the trap's exit status becomes the script's, so a falsy last command
  # here turns a successful run into a failure.
  return 0
}
trap cleanup EXIT

# Sets MKTEMP_DIR rather than printing it. A `$(mktempdir)` would run in a subshell,
# where the TMPDIRS append is discarded and the directory is never cleaned up.
MKTEMP_DIR=""
mktempdir() {
  MKTEMP_DIR="$(mktemp -d)" || die "mktemp failed"
  TMPDIRS+=("${MKTEMP_DIR}")
}

# Map a release tag to a valid npm version.
#
# Release tags are CalVer YYYY.M.D with an optional same-day suffix (2026.7.7.2).
# Four segments is not semver and npm rejects it, so the suffix becomes a
# prerelease: 2026.7.7.2 -> 2026.7.7-2.
#
# Known wart, accepted: semver sorts a prerelease BELOW its release, so
# 2026.7.7-2 ranks under 2026.7.7 even though it ships later. It does not bite in
# practice because npm's `latest` dist-tag follows publish order rather than sort
# order, and because both the docs and `cihub connect` install exact versions. The
# alternative is a 4th numeric segment, which npm cannot express at all.
npm_version() {
  local tag="${1#v}"
  [[ -n "${tag}" ]] || die "empty tag"
  # No leading zeros in any segment: npm silently rewrites 2026.08.01 to 2026.8.1 at
  # publish time, after which the registry version, the version stamped into the
  # shipped plugin, and the URL the workflow verifies all disagree.
  if [[ "${tag}" =~ (^|\.)0[0-9] ]]; then
    die "tag '${1}' has a zero-padded segment; npm would silently renumber it"
  fi
  if [[ "${tag}" =~ ^([0-9]+\.[0-9]+\.[0-9]+)\.([0-9]+)$ ]]; then
    printf '%s-%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  elif [[ "${tag}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    printf '%s\n' "${tag}"
  else
    die "tag '${1}' is not a release tag this script can map to an npm version"
  fi
}

# Fail if the plugin directory contains a file the tarball does not ship.
#
# THIS IS THE MOST IMPORTANT CHECK IN THE SCRIPT. `files` in package.json is a
# hand-maintained allowlist, but the appliance image copies the whole directory. Add
# a module (say the intent catalog gets split again) without touching `files`, and:
# the image gets it, the tarball does not, --compare finds the two tarballs identical
# so the release is logged as "image-only" and skipped, and every later release
# repeats the skip. npm users are left on a version whose remaining files import a
# module that is not there. It never self-heals and the job stays green throughout.
assert_files_cover_plugin_dir() {
  local tarball="${1}"
  local shipped missing=()
  shipped="$(tar -tzf "${tarball}" | sed 's|^package/||' | grep -v '/$' | LC_ALL=C sort)" \
    || die "could not list ${tarball}"

  # Captured before the loop rather than piped straight into `while`. A process
  # substitution discards the producer's exit status, so a `find` that failed — an
  # unreadable directory, or the GNU-only `-printf` this once used, which BSD/macOS
  # find rejects outright — fed the loop zero lines, left `missing` empty, and made
  # THIS check return success while packing a short tarball. The one check that must
  # never fail open was the one that did. `-print` plus a `./` strip is the portable
  # equivalent, and pipefail keeps a failing `find` fatal through the pipe.
  local listing
  listing="$(cd "${PLUGIN_DIR}" && find . -type f ! -path '*/node_modules/*' -print | sed 's|^\./||' | LC_ALL=C sort)" \
    || die "could not list ${PLUGIN_DIR}"
  [[ -n "${listing}" ]] || die "found no files in ${PLUGIN_DIR}"

  # Plain `if`s throughout: under errexit a bare `[[ ... ]] && cmd` whose test is
  # false returns non-zero and aborts the function rather than skipping the line.
  local rel skip pattern
  while IFS= read -r rel; do
    skip=0
    for pattern in "${NOT_PUBLISHED[@]}"; do
      # shellcheck disable=SC2053 -- glob match is intended
      if [[ "${rel}" == ${pattern} ]]; then
        skip=1
      fi
    done
    if [[ "${skip}" -eq 0 ]]; then
      if ! grep -qxF "${rel}" <<<"${shipped}"; then
        missing+=("${rel}")
      fi
    fi
  done <<<"${listing}"

  if [[ "${#missing[@]}" -gt 0 ]]; then
    printf 'These files are in the plugin directory but the published tarball does not ship them:\n' >&2
    printf '  %s\n' "${missing[@]}" >&2
    printf 'Add them to "files" in package.json, or to NOT_PUBLISHED in %s if they are deliberately excluded.\n' "$0" >&2
    exit 2
  fi
}

# Stage the plugin, stamp both version fields, npm pack. Prints the tarball path.
do_pack() {
  local version="${1}" outdir="${2}"
  [[ -n "${version}" ]] || die "--pack needs --version"
  [[ -n "${outdir}" ]] || die "--pack needs --out"
  [[ -d "${PLUGIN_DIR}" ]] || die "no plugin directory at ${PLUGIN_DIR}"
  # Validate rather than trust: the version is substituted into files, and a value
  # carrying regex or JSON metacharacters would otherwise corrupt a manifest and
  # still exit 0. The workflow always feeds this from --npm-version, but the
  # script's contract should not depend on its only caller behaving.
  #
  # The prerelease class must stay in step with npm_version's, hyphen included. It did
  # not, and the gap was reachable: tag 2026.8.1-rc-1 satisfies the publish workflow's
  # tag glob and npm_version emits it unchanged, then --pack rejected it — a release
  # that failed here, after the full CI gate had already run.
  [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] \
    || die "--version '${version}' is not a valid release version"

  mkdir -p "${outdir}" || die "could not create ${outdir}"
  # Absolute, because npm pack runs after `cd "${stage}"` and would otherwise
  # resolve a relative --out inside the staging dir, which is then deleted.
  outdir="$(cd "${outdir}" && pwd)" || die "could not resolve ${outdir}"

  local stage
  mktempdir; stage="${MKTEMP_DIR}"

  cp -R "${PLUGIN_DIR}/." "${stage}/"

  local f
  for f in "${VERSIONED_FILES[@]}"; do
    [[ -f "${stage}/${f}" ]] || die "expected ${f} in the plugin directory"
    VERSION="${version}" node -e '
      const fs = require("node:fs");
      const p = process.argv[1];
      const doc = JSON.parse(fs.readFileSync(p, "utf8"));
      doc.version = process.env.VERSION;
      // `private: true` stays in the working tree so a stray `npm publish` from the
      // plugin directory refuses; it is stripped only here, in the staging copy that
      // becomes the published artifact. Without that, a local publish would burn a
      // version number AND move the `latest` dist-tag the change-guard reads.
      delete doc.private;
      // Nothing in the published tarball can run these: `files` excludes the test
      // files, so a published `npm test` would run over nothing and exit 0.
      delete doc.scripts;
      fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
    ' "${stage}/${f}" || die "could not stamp ${f}"
  done

  # `npm pack` applies the `files` allowlist, so the plugin's own test files are
  # excluded here rather than by a second list this script would have to keep in
  # sync. --silent keeps stdout to the filename npm prints.
  local tarball
  tarball="$(cd "${stage}" && npm pack --silent --pack-destination "${outdir}")" \
    || die "npm pack failed"
  [[ -n "${tarball}" ]] || die "npm pack produced no tarball"
  assert_files_cover_plugin_dir "${outdir%/}/${tarball}"
  printf '%s\n' "${outdir%/}/${tarball}"
}

# Refuse a tarball whose member names could be written outside the extraction
# directory, before unpacking it.
#
# Not a theoretical concern to the extent that tar is already careful: GNU tar 1.35
# refuses a `..` member outright ("Member name contains '..'", exit 2) and strips a
# leading `/`, and `do_compare` dies on that non-zero exit. But bsdtar on macOS skips
# such members and still exits 0, which hands the comparison a partial tree that reads
# as "the plugin changed" — and one of the two tarballs comes from the registry, the
# only input here this script does not produce itself. Check it rather than depend on
# which tar happens to be installed.
assert_tarball_members_safe() {
  local tarball="${1}" listing member unsafe=()
  listing="$(tar -tzf "${tarball}")" || die "could not list ${tarball}"
  while IFS= read -r member; do
    case "${member}" in
      /*|../*|*/../*|*/..|..) unsafe+=("${member}") ;;
    esac
  done <<<"${listing}"
  if [[ "${#unsafe[@]}" -gt 0 ]]; then
    printf 'Refusing %s — these member names would escape the extraction directory:\n' \
      "${tarball}" >&2
    printf '  %s\n' "${unsafe[@]}" >&2
    die "unsafe tarball member names"
  fi
}

# Compare two packed tarballs, ignoring the stamped version fields.
#
# Network-free by design: the publish workflow downloads the published tarball with
# `npm pack <pkg>@latest` and hands both paths here, so this seam stays testable
# offline — the same split that makes check-ci-hub-plugin-drift.sh's --compare
# testable.
# Every failure in here `die`s with 2 rather than being allowed to surface as 1.
# Exit 1 means one thing to the caller — "the plugin changed, publish it" — so an
# internal error that leaked out as 1 would silently turn into a release. Only the
# final diff may produce 1.
do_compare() {
  local a="${1}" b="${2}"
  [[ -f "${a}" ]] || die "no such tarball: ${a}"
  [[ -f "${b}" ]] || die "no such tarball: ${b}"

  local work
  mktempdir; work="${MKTEMP_DIR}"

  local side src path f
  for side in a b; do
    mkdir -p "${work}/${side}" || die "could not create ${work}/${side}"
    if [[ "${side}" == "b" ]]; then src="${b}"; else src="${a}"; fi
    # npm tarballs root everything under package/; --strip-components=1 drops it so
    # the two trees compare directly.
    assert_tarball_members_safe "${src}"
    tar -xzf "${src}" -C "${work}/${side}" --strip-components=1 \
      || die "could not extract ${src}"
    for f in "${VERSIONED_FILES[@]}"; do
      path="${work}/${side}/${f}"
      [[ -f "${path}" ]] || continue
      node -e '
        const fs = require("node:fs");
        const p = process.argv[1];
        const doc = JSON.parse(fs.readFileSync(p, "utf8"));
        doc.version = "0.0.0-normalized";
        fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
      ' "${path}" || die "could not normalise ${f} in ${src}"
    done
  done

  # Both extracted trees must be non-empty. `tar --strip-components=1` silently drops
  # entries with fewer than two path components and still exits 0, so a differently
  # rooted tarball would extract to nothing and compare equal to another one — a
  # permanent "identical, image-only release" skip.
  local side
  for side in a b; do
    if [[ -z "$(ls -A "${work}/${side}")" ]]; then
      die "extracted an empty tree from the ${side} tarball; refusing to call that identical"
    fi
  done

  # diff exits 0 same, 1 differs, 2 TROUBLE. Mapping anything non-zero to 1 would turn
  # an unreadable file into a publish.
  local diff_status=0
  diff -r "${work}/a" "${work}/b" >/dev/null 2>&1 || diff_status=$?
  if [[ "${diff_status}" -eq 0 ]]; then
    return 0
  fi
  if [[ "${diff_status}" -ne 1 ]]; then
    die "diff failed with status ${diff_status} while comparing the tarballs"
  fi
  # The human-readable report goes to stderr so callers can still parse stdout.
  # --brief: the payload is a 34KB index.js and a full unified diff of it helps
  # nobody in a workflow log.
  diff -rq "${work}/a" "${work}/b" >&2 || true
  return 1
}

MODE=""
VERSION=""
OUTDIR=""
ARGS=()
while [[ $# -gt 0 ]]; do
  case "${1}" in
    --npm-version) MODE="npm-version"; shift; ARGS+=("${1:-}"); shift || true ;;
    --pack)        MODE="pack"; shift ;;
    --compare)     MODE="compare"; shift ;;
    --version)     shift; VERSION="${1:-}"; shift || true ;;
    --out)         shift; OUTDIR="${1:-}"; shift || true ;;
    -h|--help)
      cat <<'USAGE'
pack-memory-plugin.sh --npm-version <tag>              map a release tag to an npm version
pack-memory-plugin.sh --pack --version <v> --out <dir> stage, stamp, npm pack; prints the tarball path
pack-memory-plugin.sh --compare <a.tgz> <b.tgz>        0 = same plugin, 1 = differs (version fields ignored)
USAGE
      exit 0 ;;
    *)             ARGS+=("${1}"); shift ;;
  esac
done

case "${MODE}" in
  npm-version) npm_version "${ARGS[0]:-}" ;;
  pack)        do_pack "${VERSION}" "${OUTDIR}" ;;
  compare)     do_compare "${ARGS[0]:-}" "${ARGS[1]:-}" ;;
  *)           die "usage: $0 --npm-version <tag> | --pack --version <v> --out <dir> | --compare <a.tgz> <b.tgz>" ;;
esac
