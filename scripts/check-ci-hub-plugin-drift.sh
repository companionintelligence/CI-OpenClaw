#!/usr/bin/env bash
#
# check-ci-hub-plugin-drift.sh — detect drift between the vendored ci-hub plugin bundle
# and its CI-Hub source (companionintelligence/CI-OpenClaw#45).
#
# WHY THIS EXISTS
# ---------------
# openclaw-context/plugins/ci-hub/hub-plugin.mjs is a vendored esbuild bundle of CI-Hub's
# packages/openclaw-plugin. It is THE copy the appliance loads at runtime (server.cjs writes
# its path into openclaw.json -> plugins.load.paths; the Dockerfile bakes it into the image).
# It is re-synced BY HAND, and nothing detected when it drifted from the CI-Hub source it is
# built from. That silent gap shipped broken plugins three times:
#   - #42 / CI-Hub#892  — `options` vs `params`: the fix landed in CI-Hub but the appliance
#                         kept loading the stale bundle, so the fix was a no-op in the field.
#   - #46 / CI-Hub#894  — async-`register`: shipping the CI-Hub fix alone changed nothing, and
#                         worse, masked a bug that stopped the plugin loading at all.
#   - #895 / CI-Hub#899 ↔ #50 — the inference-provider removal, re-vendored by hand again.
# Every ci-hub plugin fix has needed a two-repo dance (fix CI-Hub source -> hand re-sync this
# bundle) with no signal when someone forgot step two. This script is that signal.
#
# INTEGRITY vs FRESHNESS
# ----------------------
# The bundle carries its provenance in a sibling file, .ci-hub-source (the CI-Hub commit SHA it
# was built from). Two distinct questions are answered by pointing the CI-Hub checkout at
# different refs before calling --check:
#   * INTEGRITY (hard fail): check out CI-Hub at the recorded .ci-hub-source SHA and --check.
#     If the rebuild differs, the committed bundle was hand-edited or a re-sync was botched.
#     Deterministic and fair — it never fails just because dev moved on.
#   * FRESHNESS (advisory): check out CI-Hub at `dev` and --check. A difference means the plugin
#     source moved ahead and the bundle needs re-vendoring (the scheduled workflow turns this
#     into an auto re-sync PR).
#
# Only ever stamp a MERGE-REACHABLE CI-Hub commit. The integrity gate checks CI-Hub out at the
# exact recorded SHA, and GitHub's git server only serves SHAs reachable from an advertised ref.
# Vendoring from an unmerged branch and then letting that branch get squash-merged and deleted
# leaves the recorded SHA unreachable, so the integrity checkout would fail for everyone until the
# bundle is re-vendored from a commit that is on `dev`. --write stamps the checkout's HEAD, so run
# it against a pushed, merge-reachable commit (the resync bot always stamps `dev` HEAD).
#
# REPRODUCIBILITY — the cwd matters
# ---------------------------------
# esbuild writes each module's banner comment (e.g. `// src/mcp-client.ts`) RELATIVE TO THE
# WORKING DIRECTORY, and CI-Hub's bundle script does not set absWorkingDir. The committed bundle
# was built with the working directory AT the plugin package, so the rebuild MUST run from there
# too — building from the CI-Hub repo root would emit `// packages/openclaw-plugin/src/...` and
# report false drift. rebuild_bundle() enforces this by cd'ing into the plugin package. esbuild
# is pinned to 0.25.0 by CI-Hub's pnpm-workspace override, so the rebuild is byte-deterministic.
#
# USAGE
#   check-ci-hub-plugin-drift.sh --check  --ci-hub <CI-Hub checkout>   # rebuild + compare
#   check-ci-hub-plugin-drift.sh --write  --ci-hub <CI-Hub checkout>   # re-vendor + restamp
#   check-ci-hub-plugin-drift.sh --compare --fresh <a> --committed <b> # compare two files only
#
# The caller (CI workflow / a developer) is responsible for putting the CI-Hub checkout at the
# intended ref; this script never mutates that checkout. --compare is the network-free seam the
# unit test drives.
#
# EXIT CODES
#   0  in sync (or --write succeeded)
#   1  drift detected (bundle differs from the rebuild)
#   2  setup/build error (bad args, missing paths, esbuild build failed) — NOT drift
#
set -euo pipefail

# --- Layout ----------------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLUGIN_REL="openclaw-context/plugins/ci-hub"
DEFAULT_COMMITTED="${REPO_ROOT}/${PLUGIN_REL}/hub-plugin.mjs"
STAMP_FILE="${REPO_ROOT}/${PLUGIN_REL}/.ci-hub-source"
# Where packages/openclaw-plugin lives inside a CI-Hub checkout.
CI_HUB_PLUGIN_SUBPATH="packages/openclaw-plugin"

# Temp dirs to clean up on exit (rebuild output lands here). rebuild_bundle appends to this from
# the top-level shell — NOT from inside a command substitution — so the EXIT trap actually sees
# the dir it created (a `$(...)` subshell's array mutation would be lost).
TMP_DIRS=()
cleanup() {
  local d
  for d in "${TMP_DIRS[@]:-}"; do
    [ -n "${d}" ] && rm -rf "${d}"
  done
  # Always succeed: an EXIT trap that returns non-zero would override the script's real exit
  # code (e.g. the empty-array short-circuit above), collapsing 0/2 into 1.
  return 0
}
trap cleanup EXIT

# --- Logging ---------------------------------------------------------------------------------
# All human logging goes to stderr so stdout stays clean for machine consumers. Under GitHub
# Actions we additionally emit workflow annotations and a step-summary line so drift surfaces
# in the PR checks UI, not just the raw log.
readonly LOG_PREFIX="[ci-hub-plugin-drift]"

log_info()  { printf '%s %s\n' "${LOG_PREFIX}" "$*" >&2; }
log_warn()  { printf '%s WARN: %s\n' "${LOG_PREFIX}" "$*" >&2; }
log_error() { printf '%s ERROR: %s\n' "${LOG_PREFIX}" "$*" >&2; }
log_ok()    { printf '%s OK: %s\n' "${LOG_PREFIX}" "$*" >&2; }

# gh_annotation LEVEL MESSAGE — emit a GitHub Actions annotation when running in CI. Written to
# stderr (like all our logging) so it is never captured by a `$(...)` around a caller — GitHub
# parses workflow commands from stderr just as it does from stdout, but a captured `::error::`
# would be swallowed into a variable and never surface in the checks UI.
gh_annotation() {
  [ "${GITHUB_ACTIONS:-}" = "true" ] || return 0
  printf '::%s::%s\n' "$1" "$2" >&2
}

# gh_summary LINE — append a line to the job step summary when running in CI.
gh_summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  printf '%s\n' "$1" >>"${GITHUB_STEP_SUMMARY}"
}

# die_setup MESSAGE — report a setup/build failure (exit 2), kept distinct from drift (exit 1)
# so a broken or mid-refactor upstream is never mistaken for a stale bundle.
die_setup() {
  log_error "$*"
  gh_annotation error "ci-hub plugin drift check could not run: $*"
  exit 2
}

# --- Provenance ------------------------------------------------------------------------------
# read_stamp — echo the recorded CI-Hub source SHA (first 40-hex token in .ci-hub-source), or
# empty if the stamp is missing/unreadable.
read_stamp() {
  [ -f "${STAMP_FILE}" ] || { echo ""; return 0; }
  grep -oE '[0-9a-f]{40}' "${STAMP_FILE}" | head -n1 || echo ""
}

# --- Rebuild ---------------------------------------------------------------------------------
# Set by rebuild_bundle to the path of the freshly built hub-plugin.mjs. Returned via a global
# (not stdout) on purpose: rebuild_bundle must run in the top-level shell so its TMP_DIRS append
# reaches the EXIT trap — capturing it as `$(rebuild_bundle …)` would run it in a subshell and
# leak the temp dir. Callers read this immediately after calling rebuild_bundle.
REBUILT_BUNDLE=""

# rebuild_bundle CI_HUB_DIR — build the plugin from the given CI-Hub checkout into a temp dir
# (registered for cleanup on exit) and set REBUILT_BUNDLE to the built hub-plugin.mjs. Runs the
# build from the plugin package directory so esbuild's cwd-relative module banners match the
# committed bundle (see the reproducibility note in the header). Must be called directly, NOT in
# a command substitution.
rebuild_bundle() {
  local ci_hub="$1"
  [ -n "${ci_hub}" ] || die_setup "--ci-hub <dir> is required for this mode"
  local plugin_dir="${ci_hub}/${CI_HUB_PLUGIN_SUBPATH}"
  [ -d "${plugin_dir}" ] || die_setup "CI-Hub plugin package not found at ${plugin_dir} (is --ci-hub a CI-Hub checkout?)"
  [ -f "${plugin_dir}/scripts/bundle-to-openclaw.mjs" ] || die_setup "bundle script missing in ${plugin_dir}/scripts"

  local out
  out="$(mktemp -d)" || die_setup "could not create a temp directory for the rebuild"
  TMP_DIRS+=("${out}")

  log_info "Rebuilding bundle from ${plugin_dir} (cwd-pinned to the plugin package)"
  # Prefer pnpm (CI-Hub's package manager; honours the workspace esbuild@0.25.0 pin). Fall back
  # to running the build script with node directly when pnpm is absent — equivalent, since the
  # package's "bundle" script is just `node scripts/bundle-to-openclaw.mjs` and esbuild resolves
  # from the plugin package's node_modules. Build chatter is redirected to stderr.
  if command -v pnpm >/dev/null 2>&1; then
    ( cd "${plugin_dir}" && OPENCLAW_PLUGIN_OUT_DIR="${out}" pnpm run bundle 1>&2 ) \
      || die_setup "esbuild bundle failed (pnpm run bundle in ${plugin_dir})"
  else
    ( cd "${plugin_dir}" && OPENCLAW_PLUGIN_OUT_DIR="${out}" node scripts/bundle-to-openclaw.mjs 1>&2 ) \
      || die_setup "esbuild bundle failed (node scripts/bundle-to-openclaw.mjs in ${plugin_dir})"
  fi

  local built="${out}/hub-plugin.mjs"
  [ -f "${built}" ] || die_setup "rebuild produced no ${built}"
  REBUILT_BUNDLE="${built}"
}

# --- Compare + report ------------------------------------------------------------------------
# report_drift FRESH COMMITTED — print an actionable drift report (human diff, remediation, CI
# annotation + step summary). Uses `diff` only for human-readable output; the pass/fail decision
# is made by `cmp -s` in check_drift (byte-exact, incl. the trailing newline esbuild emits).
report_drift() {
  local fresh="$1" committed="$2"
  log_error "Vendored bundle is OUT OF SYNC with the CI-Hub source rebuild."
  log_error "  committed: ${committed}"
  log_error "  rebuild:   ${fresh}"
  {
    echo "----- diff (committed → rebuild) -----"
    diff -u "${committed}" "${fresh}" || true
    echo "--------------------------------------"
  } >&2

  local remediation
  remediation=$(cat <<EOF
Re-vendor the bundle from the intended CI-Hub source, then commit it with its stamp:

  scripts/check-ci-hub-plugin-drift.sh --write --ci-hub <path-to-CI-Hub-checkout>
  git add ${PLUGIN_REL}/hub-plugin.mjs ${PLUGIN_REL}/.ci-hub-source

Equivalent manual steps:

  ( cd <CI-Hub>/${CI_HUB_PLUGIN_SUBPATH} && OPENCLAW_PLUGIN_OUT_DIR=/tmp/hub pnpm run bundle )
  cp /tmp/hub/hub-plugin.mjs ${PLUGIN_REL}/hub-plugin.mjs
  git -C <CI-Hub> rev-parse HEAD > ${PLUGIN_REL}/.ci-hub-source
EOF
)
  log_error "${remediation}"

  gh_annotation error "Vendored ci-hub plugin bundle is out of sync with its CI-Hub source. Re-run: scripts/check-ci-hub-plugin-drift.sh --write --ci-hub <CI-Hub>"
  gh_summary "### ❌ ci-hub plugin bundle drift"
  gh_summary ""
  gh_summary "\`${PLUGIN_REL}/hub-plugin.mjs\` does not match a rebuild from its recorded CI-Hub source."
  gh_summary ""
  gh_summary "Fix: \`scripts/check-ci-hub-plugin-drift.sh --write --ci-hub <CI-Hub checkout>\` then commit the bundle and \`.ci-hub-source\`."
}

# check_drift FRESH COMMITTED — return 0 if byte-identical, 1 if they differ (drift). Missing
# inputs are a setup error (exit 2 via die_setup), not drift.
check_drift() {
  local fresh="$1" committed="$2"
  [ -f "${fresh}" ] || die_setup "rebuilt bundle not found: ${fresh}"
  [ -f "${committed}" ] || die_setup "committed bundle not found: ${committed}"
  if cmp -s "${fresh}" "${committed}"; then
    return 0
  fi
  return 1
}

# --- Modes -----------------------------------------------------------------------------------
# mode_check CI_HUB_DIR COMMITTED — rebuild from the checkout and compare to the committed bundle.
mode_check() {
  local ci_hub="$1" committed="$2"
  local stamp; stamp="$(read_stamp)"
  local head_sha=""
  if [ -n "${stamp}" ]; then
    log_info "Recorded source (.ci-hub-source): ${stamp}"
    # If the checkout is a git repo, note whether its HEAD matches the recorded source, so a
    # local run against the wrong ref is obvious. CI checks out the recorded SHA for integrity.
    if head_sha="$(git -C "${ci_hub}" rev-parse HEAD 2>/dev/null)"; then
      log_info "CI-Hub checkout HEAD:            ${head_sha}"
      [ "${head_sha}" = "${stamp}" ] || log_warn "checkout HEAD differs from the recorded source — comparing against whatever is checked out"
    fi
  fi

  rebuild_bundle "${ci_hub}"
  local fresh="${REBUILT_BUNDLE}"
  if check_drift "${fresh}" "${committed}"; then
    log_ok "vendored bundle matches the CI-Hub source rebuild — no drift"
    gh_summary "### ✅ ci-hub plugin bundle in sync"
    return 0
  fi
  report_drift "${fresh}" "${committed}"
  return 1
}

# mode_write CI_HUB_DIR COMMITTED — rebuild from the checkout, copy over the committed bundle,
# and restamp .ci-hub-source with the checkout's HEAD SHA.
mode_write() {
  local ci_hub="$1" committed="$2"
  rebuild_bundle "${ci_hub}"
  local fresh="${REBUILT_BUNDLE}"
  # A failed copy or stamp write is a setup error (exit 2), not drift (exit 1) — keep the contract.
  cp "${fresh}" "${committed}" || die_setup "failed to copy the rebuilt bundle into ${committed}"
  local sha
  sha="$(git -C "${ci_hub}" rev-parse HEAD 2>/dev/null)" \
    || die_setup "cannot read CI-Hub HEAD (is ${ci_hub} a git checkout?)"
  printf '%s\n' "${sha}" >"${STAMP_FILE}" \
    || die_setup "failed to write the provenance stamp ${STAMP_FILE}"
  log_ok "re-vendored ${committed}"
  log_ok "stamped .ci-hub-source = ${sha}"
}

# mode_compare FRESH COMMITTED — compare two given files (the hermetic, build-free seam the unit
# test drives). Same 0/1/2 semantics as --check.
mode_compare() {
  local fresh="$1" committed="$2"
  [ -n "${fresh}" ] && [ -n "${committed}" ] || die_setup "--compare requires --fresh <path> and --committed <path>"
  if check_drift "${fresh}" "${committed}"; then
    log_ok "files are byte-identical — no drift"
    return 0
  fi
  report_drift "${fresh}" "${committed}"
  return 1
}

usage() {
  # Reprint the header comment block — everything from the line after the shebang down to the
  # first line of actual code — stripping the leading "# ". Driven off the shape of the file
  # (leading comment run) rather than magic line numbers, so it can't silently truncate or leak
  # code when the header is edited.
  awk 'NR==1 { next } /^#/ { print; next } { exit }' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# --- Arg parsing -----------------------------------------------------------------------------
main() {
  local mode="" ci_hub="${CI_HUB_DIR:-}" committed="${DEFAULT_COMMITTED}" fresh=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --check)      mode="check" ;;
      --write)      mode="write" ;;
      --compare)    mode="compare" ;;
      # Validate the value explicitly (not `${2:?}`, which exits 1 — indistinguishable from drift)
      # so a missing option-argument is reported as a setup error (exit 2), per the exit contract.
      --ci-hub)     [ $# -ge 2 ] || die_setup "--ci-hub needs a path"; ci_hub="$2"; shift ;;
      --committed)  [ $# -ge 2 ] || die_setup "--committed needs a path"; committed="$2"; shift ;;
      --fresh)      [ $# -ge 2 ] || die_setup "--fresh needs a path"; fresh="$2"; shift ;;
      -h|--help)    usage; exit 0 ;;
      *)            die_setup "unknown argument: $1 (try --help)" ;;
    esac
    shift
  done

  case "${mode}" in
    check)   mode_check "${ci_hub}" "${committed}" ;;
    write)   mode_write "${ci_hub}" "${committed}" ;;
    compare) mode_compare "${fresh}" "${committed}" ;;
    "")      die_setup "no mode given — use --check, --write, or --compare (see --help)" ;;
  esac
}

main "$@"
