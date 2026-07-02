#!/bin/bash
# Tests for bootstrap-ci-hub-mcp.sh — plugin registration idempotence and env gating.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../bootstrap-ci-hub-mcp.sh"
PLUGIN_PATH="${HERE}/../openclaw-context/plugins/ci-hub"

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
  if grep -qF -- "${needle}" "${file}"; then
    echo "  ✓ ${label}"
    PASS=$((PASS + 1))
  else
    echo "  ✗ ${label}"
    echo "    expected to contain: ${needle}"
    sed 's/^/      /' "${file}"
    FAIL=$((FAIL + 1))
  fi
}

run_bootstrap() {
  local data_dir="$1"
  shift
  OPENCLAW_DATA_DIR="${data_dir}" CI_HUB_PLUGIN_PATH="${PLUGIN_PATH}" env "$@" "${SCRIPT}" >/dev/null 2>&1
}

setup_config() {
  local data_dir="$1"
  mkdir -p "${data_dir}"
  cat > "${data_dir}/openclaw.json" <<'EOF'
{
  "plugins": {
    "enabled": false,
    "load": { "paths": [] },
    "entries": {}
  }
}
EOF
}

# ─── Test 1: credentials enable ci-hub plugin ────────────────────────────────
echo "test: Hub MCP credentials register ci-hub plugin"
data_dir="$(mktemp -d)"
setup_config "${data_dir}"
run_bootstrap "${data_dir}" \
  HUB_MCP_URL="http://ci-os-hub:3000/api/mcp/sse" \
  HUB_MCP_API_KEY="test-key"
assert_contains "plugin enabled" '"enabled": true' "${data_dir}/openclaw.json"
assert_contains "plugin path added" "${PLUGIN_PATH}" "${data_dir}/openclaw.json"
rm -rf "${data_dir}"

# ─── Test 2: HUB_URL alone is enough with MCP key ────────────────────────────
echo "test: HUB_URL + HUB_MCP_API_KEY enables plugin"
data_dir="$(mktemp -d)"
setup_config "${data_dir}"
run_bootstrap "${data_dir}" \
  HUB_URL="http://ci-os-hub:3000" \
  HUB_MCP_API_KEY="test-key"
assert_contains "plugin enabled with HUB_URL" '"ci-hub"' "${data_dir}/openclaw.json"
rm -rf "${data_dir}"

# ─── Test 3: HUB_MCP_ENABLED=false disables plugin ───────────────────────────
echo "test: HUB_MCP_ENABLED=false keeps plugin disabled"
data_dir="$(mktemp -d)"
setup_config "${data_dir}"
run_bootstrap "${data_dir}" \
  HUB_MCP_URL="http://ci-os-hub:3000/api/mcp/sse" \
  HUB_MCP_API_KEY="test-key" \
  HUB_MCP_ENABLED=false
assert_eq "plugin disabled" "false" "$(python3 - <<PY
import json
cfg = json.load(open("${data_dir}/openclaw.json"))
print(str(cfg.get("plugins", {}).get("entries", {}).get("ci-hub", {}).get("enabled", False)).lower())
PY
)"
rm -rf "${data_dir}"

# ─── Test 4: idempotent second run ───────────────────────────────────────────
echo "test: second run with unchanged env is idempotent"
data_dir="$(mktemp -d)"
setup_config "${data_dir}"
env_args=(HUB_URL="http://ci-os-hub:3000" HUB_MCP_API_KEY="test-key")
run_bootstrap "${data_dir}" "${env_args[@]}"
hash1="$(shasum "${data_dir}/openclaw.json" | awk '{print $1}')"
run_bootstrap "${data_dir}" "${env_args[@]}"
hash2="$(shasum "${data_dir}/openclaw.json" | awk '{print $1}')"
assert_eq "config unchanged" "${hash1}" "${hash2}"
rm -rf "${data_dir}"

# ─── Summary ────────────────────────────────────────────────────────────────
echo
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
