#!/bin/bash
# Tests for bootstrap-from-hub.sh — verifies merge semantics, idempotency,
# and failure tolerance without touching the network.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../bootstrap-from-hub.sh"

PASS=0
FAIL=0

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
  local label="$1" needle="$2" file="$3"
  if grep -qxF "${needle}" "${file}"; then
    echo "  ✓ ${label}"
    PASS=$((PASS + 1))
  else
    echo "  ✗ ${label}"
    echo "    expected line: ${needle}"
    echo "    in file:"
    sed 's/^/      /' "${file}"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" file="$3"
  if grep -qxF "${needle}" "${file}"; then
    echo "  ✗ ${label}"
    echo "    did NOT expect line: ${needle}"
    echo "    but found it in:"
    sed 's/^/      /' "${file}"
    FAIL=$((FAIL + 1))
  else
    echo "  ✓ ${label}"
    PASS=$((PASS + 1))
  fi
}

setup_data() {
  mktemp -d
}

write_fixture() {
  local f
  f="$(mktemp)"
  printf '%s' "$1" > "${f}"
  echo "${f}"
}

run_script() {
  local data_dir="$1"
  local fixture_file="$2"
  OPENCLAW_DATA_DIR="${data_dir}" \
  BOOTSTRAP_FIXTURE_FILE="${fixture_file}" \
    "${SCRIPT}" >/dev/null 2>&1
}

# ─── Test 1: First-run writes Hub-managed keys ──────────────────────────────
echo "test: first run writes Hub-managed keys"
data_dir="$(setup_data)"
fix_body=$'OPENAI_API_BASE=http://ci-hub-ollama:11434/v1\nOPENAI_API_KEY=ollama\nDEFAULT_MODEL=hermes4-70b\nDEFAULT_MODEL_BACKEND_ID=hermes4:70b\nEMBEDDINGS_MODEL=nomic-embed-text\n'
fixture="$(write_fixture "${fix_body}")"
run_script "${data_dir}" "${fixture}"
assert_contains "OPENAI_API_BASE present" "OPENAI_API_BASE=http://ci-hub-ollama:11434/v1" "${data_dir}/.env"
assert_contains "OPENAI_API_KEY present" "OPENAI_API_KEY=ollama" "${data_dir}/.env"
assert_contains "DEFAULT_MODEL present" "DEFAULT_MODEL=hermes4-70b" "${data_dir}/.env"
assert_contains "EMBEDDINGS_MODEL present" "EMBEDDINGS_MODEL=nomic-embed-text" "${data_dir}/.env"
rm -rf "${data_dir}" "${fixture}"

# ─── Test 2: Existing non-managed keys are preserved ────────────────────────
echo "test: preserves existing non-managed keys"
data_dir="$(setup_data)"
printf 'ANTHROPIC_API_KEY=user-secret\nCLAWDBOT_GATEWAY_TOKEN=gw-token\nOPENAI_API_BASE=stale-value\n' > "${data_dir}/.env"
fixture="$(write_fixture "${fix_body}")"
run_script "${data_dir}" "${fixture}"
assert_contains "ANTHROPIC_API_KEY preserved" "ANTHROPIC_API_KEY=user-secret" "${data_dir}/.env"
assert_contains "CLAWDBOT_GATEWAY_TOKEN preserved" "CLAWDBOT_GATEWAY_TOKEN=gw-token" "${data_dir}/.env"
assert_contains "OPENAI_API_BASE overwritten with Hub value" "OPENAI_API_BASE=http://ci-hub-ollama:11434/v1" "${data_dir}/.env"
assert_not_contains "stale OPENAI_API_BASE gone" "OPENAI_API_BASE=stale-value" "${data_dir}/.env"
rm -rf "${data_dir}" "${fixture}"

# ─── Test 3: Idempotency — two runs produce identical .env ──────────────────
echo "test: idempotent across two runs"
data_dir="$(setup_data)"
printf 'ANTHROPIC_API_KEY=keep-me\n' > "${data_dir}/.env"
fixture="$(write_fixture "${fix_body}")"
run_script "${data_dir}" "${fixture}"
hash1="$(shasum "${data_dir}/.env" | awk '{print $1}')"
run_script "${data_dir}" "${fixture}"
hash2="$(shasum "${data_dir}/.env" | awk '{print $1}')"
assert_eq "two runs produce identical .env" "${hash1}" "${hash2}"
rm -rf "${data_dir}" "${fixture}"

# ─── Test 4: Hub unreachable → exit 0, .env untouched ──────────────────────
echo "test: unreachable Hub returns exit 0 and does not touch .env"
data_dir="$(setup_data)"
printf 'ANTHROPIC_API_KEY=user-secret\n' > "${data_dir}/.env"
expected_hash="$(shasum "${data_dir}/.env" | awk '{print $1}')"
OPENCLAW_DATA_DIR="${data_dir}" CI_HUB_URL="http://127.0.0.1:1" "${SCRIPT}" >/dev/null 2>&1
rc=$?
got_hash="$(shasum "${data_dir}/.env" | awk '{print $1}')"
assert_eq "exit code 0" "0" "${rc}"
assert_eq ".env unchanged" "${expected_hash}" "${got_hash}"
rm -rf "${data_dir}"

# ─── Test 5: Hub response missing managed keys → .env left alone ────────────
echo "test: response with no managed keys leaves .env alone"
data_dir="$(setup_data)"
printf 'ANTHROPIC_API_KEY=user-secret\n' > "${data_dir}/.env"
expected_hash="$(shasum "${data_dir}/.env" | awk '{print $1}')"
fixture="$(write_fixture $'GARBAGE=value\nNOT_MANAGED=other\n')"
run_script "${data_dir}" "${fixture}"
got_hash="$(shasum "${data_dir}/.env" | awk '{print $1}')"
assert_eq ".env unchanged when Hub has no managed keys" "${expected_hash}" "${got_hash}"
rm -rf "${data_dir}" "${fixture}"

# ─── Test 6: Data dir does not exist → script creates it ───────────────────
echo "test: creates data dir when missing"
data_dir="/tmp/openclaw-test-$$-missing"
[[ -d "${data_dir}" ]] && rm -rf "${data_dir}"
fixture="$(write_fixture "${fix_body}")"
run_script "${data_dir}" "${fixture}"
if [[ -f "${data_dir}/.env" ]]; then
  echo "  ✓ data dir + .env created"
  PASS=$((PASS + 1))
else
  echo "  ✗ data dir not created"
  FAIL=$((FAIL + 1))
fi
rm -rf "${data_dir}" "${fixture}"

# ─── Summary ────────────────────────────────────────────────────────────────
echo
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
