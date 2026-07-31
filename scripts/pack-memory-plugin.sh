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

die() { echo "$*" >&2; exit 2; }

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
  if [[ "${tag}" =~ ^([0-9]+\.[0-9]+\.[0-9]+)\.([0-9]+)$ ]]; then
    printf '%s-%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  elif [[ "${tag}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    printf '%s\n' "${tag}"
  else
    die "tag '${1}' is not a release tag this script can map to an npm version"
  fi
}

# Stage the plugin, stamp both version fields, npm pack. Prints the tarball path.
do_pack() {
  local version="${1}" outdir="${2}"
  [[ -n "${version}" ]] || die "--pack needs --version"
  [[ -n "${outdir}" ]] || die "--pack needs --out"
  [[ -d "${PLUGIN_DIR}" ]] || die "no plugin directory at ${PLUGIN_DIR}"

  mkdir -p "${outdir}"
  local stage
  stage="$(mktemp -d)"
  trap 'rm -rf "${stage}"' RETURN

  cp -R "${PLUGIN_DIR}/." "${stage}/"

  local f
  for f in "${VERSIONED_FILES[@]}"; do
    [[ -f "${stage}/${f}" ]] || die "expected ${f} in the plugin directory"
    VERSION="${version}" node -e '
      const fs = require("node:fs");
      const p = process.argv[1];
      const doc = JSON.parse(fs.readFileSync(p, "utf8"));
      doc.version = process.env.VERSION;
      fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
    ' "${stage}/${f}"
  done

  # `npm pack` applies the `files` allowlist, so the plugin's own test files are
  # excluded here rather than by a second list this script would have to keep in
  # sync. --silent keeps stdout to the filename npm prints.
  local tarball
  tarball="$(cd "${stage}" && npm pack --silent --pack-destination "${outdir}")"
  [[ -n "${tarball}" ]] || die "npm pack produced no tarball"
  printf '%s\n' "${outdir%/}/${tarball}"
}

# Compare two packed tarballs, ignoring the stamped version fields.
#
# Network-free by design: the publish workflow downloads the published tarball with
# `npm pack <pkg>@latest` and hands both paths here, so this seam stays testable
# offline — the same split that makes check-ci-hub-plugin-drift.sh's --compare
# testable.
do_compare() {
  local a="${1}" b="${2}"
  [[ -f "${a}" ]] || die "no such tarball: ${a}"
  [[ -f "${b}" ]] || die "no such tarball: ${b}"

  local work
  work="$(mktemp -d)"
  trap 'rm -rf "${work}"' RETURN

  local side path f
  for side in a b; do
    mkdir -p "${work}/${side}"
    # npm tarballs root everything under package/; --strip-components=1 drops it so
    # the two trees compare directly.
    tar -xzf "$([[ "${side}" == a ]] && printf '%s' "${a}" || printf '%s' "${b}")" \
      -C "${work}/${side}" --strip-components=1
    for f in "${VERSIONED_FILES[@]}"; do
      path="${work}/${side}/${f}"
      [[ -f "${path}" ]] || continue
      node -e '
        const fs = require("node:fs");
        const p = process.argv[1];
        const doc = JSON.parse(fs.readFileSync(p, "utf8"));
        doc.version = "0.0.0-normalized";
        fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
      ' "${path}"
    done
  done

  if diff -r "${work}/a" "${work}/b" >/dev/null 2>&1; then
    return 0
  fi
  # The human-readable report goes to stderr so callers can still parse stdout.
  diff -r "${work}/a" "${work}/b" >&2 || true
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
