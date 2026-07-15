#!/bin/bash
# Tests for scripts/check-ci-hub-plugin-drift.sh — the vendored ci-hub bundle drift check
# (companionintelligence/CI-OpenClaw#45).
#
# These exercise the network-free `--compare` seam (compare two given files) plus the argument
# and exit-code contract, so the suite needs no CI-Hub checkout, no pnpm, and no esbuild — it
# runs anywhere `npm run test:sh` does. The rebuild-from-source path is covered end-to-end by
# the ci-hub-plugin-drift workflow, which has a real CI-Hub checkout.
#
# Exit-code contract under test: 0 = in sync, 1 = drift, 2 = setup/build error.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../scripts/check-ci-hub-plugin-drift.sh"

PASS=0
FAIL=0

# assert_eq LABEL WANT GOT — string equality.
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

# assert_out_contains LABEL NEEDLE — assert the last captured OUT contains NEEDLE (substring).
assert_out_contains() {
  local label="$1" needle="$2"
  if grep -qF -- "${needle}" <<<"${OUT}"; then
    echo "  ✓ ${label}"
    PASS=$((PASS + 1))
  else
    echo "  ✗ ${label}"
    echo "    expected output to contain: ${needle}"
    echo "    ---- output ----"
    sed 's/^/      /' <<<"${OUT}"
    FAIL=$((FAIL + 1))
  fi
}

# run_drift ARGS... — run the script, capturing combined stdout+stderr into OUT and the exit
# code into RC (without tripping the suite's `set -e`).
OUT=""
RC=0
run_drift() {
  local _rc
  set +e
  OUT="$("${SCRIPT}" "$@" 2>&1)"
  _rc=$?
  set -e
  RC=${_rc}
}

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# esbuild emits a trailing newline; keep the fixtures faithful to that so `cmp` behaves like the
# real bundle comparison.
printf 'bundle-contents\n'  >"${WORK}/a.mjs"
printf 'bundle-contents\n'  >"${WORK}/a-copy.mjs"
printf 'bundle-DIFFERENT\n' >"${WORK}/b.mjs"

echo "test: identical files report no drift and exit 0"
run_drift --compare --fresh "${WORK}/a.mjs" --committed "${WORK}/a-copy.mjs"
assert_eq "exit code 0" "0" "${RC}"
assert_out_contains "reports no drift" "no drift"

echo "test: differing files report drift and exit 1"
run_drift --compare --fresh "${WORK}/b.mjs" --committed "${WORK}/a.mjs"
assert_eq "exit code 1" "1" "${RC}"
assert_out_contains "names the out-of-sync bundle" "Vendored bundle is OUT OF SYNC"
assert_out_contains "gives the re-sync command" "check-ci-hub-plugin-drift.sh --write"
assert_out_contains "points at the vendored path" "openclaw-context/plugins/ci-hub/hub-plugin.mjs"

echo "test: drift under GitHub Actions emits an ::error:: annotation"
OUT="$(GITHUB_ACTIONS=true "${SCRIPT}" --compare --fresh "${WORK}/b.mjs" --committed "${WORK}/a.mjs" 2>&1 || true)"
assert_out_contains "emits ::error:: annotation" "::error::"

echo "test: missing --fresh file is a setup error (exit 2, not drift)"
run_drift --compare --fresh "${WORK}/does-not-exist.mjs" --committed "${WORK}/a.mjs"
assert_eq "exit code 2" "2" "${RC}"

echo "test: missing --committed file is a setup error (exit 2)"
run_drift --compare --fresh "${WORK}/a.mjs" --committed "${WORK}/nope.mjs"
assert_eq "exit code 2" "2" "${RC}"

echo "test: --compare without paths is a setup error (exit 2)"
run_drift --compare
assert_eq "exit code 2" "2" "${RC}"

echo "test: no mode is a setup error (exit 2)"
run_drift
assert_eq "exit code 2" "2" "${RC}"

echo "test: unknown argument is a setup error (exit 2)"
run_drift --bogus
assert_eq "exit code 2" "2" "${RC}"

echo "test: --help prints usage and exits 0"
run_drift --help
assert_eq "exit code 0" "0" "${RC}"
assert_out_contains "usage mentions the script" "check-ci-hub-plugin-drift.sh"

echo
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
