#!/bin/bash
# Tests for bootstrap-ci-hub-mcp.sh — registers the Hub as a NATIVE OpenClaw MCP
# server (mcp.servers.ci-hub, Streamable HTTP) plus the companion plugin, gated
# on Hub MCP credentials. Covers URL normalization, secret-off-disk interpolation,
# plugin enable/disable, entry removal when creds vanish, and idempotence.
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

assert_not_contains() {
  local label="$1" needle="$2" file="$3"
  if grep -qF -- "${needle}" "${file}"; then
    echo "  ✗ ${label}"
    echo "    expected to NOT contain: ${needle}"
    sed 's/^/      /' "${file}"
    FAIL=$((FAIL + 1))
  else
    echo "  ✓ ${label}"
    PASS=$((PASS + 1))
  fi
}

# Read mcp.servers["ci-hub"].<field> from an openclaw.json ("" if absent).
# field="auth" returns headers.Authorization.
mcp_field() {
  node -e '
    const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const s = (o.mcp && o.mcp.servers && o.mcp.servers["ci-hub"]) || null;
    const f = process.argv[2];
    let out = "";
    if (s) {
      if (f === "auth") out = String((s.headers || {}).Authorization || "");
      else out = String(s[f] === undefined ? "" : s[f]);
    }
    process.stdout.write(out);
  ' "$1" "$2"
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

# ─── Test 1: credentials register the native MCP server + enable the plugin ──
echo "test: Hub MCP credentials register mcp.servers.ci-hub + enable ci-hub plugin"
data_dir="$(mktemp -d)"
setup_config "${data_dir}"
run_bootstrap "${data_dir}" \
  HUB_MCP_URL="http://ci-os-hub:3000/api/mcp/sse" \
  HUB_MCP_API_KEY="test-key"
cfg="${data_dir}/openclaw.json"
assert_contains "plugin enabled" '"enabled": true' "${cfg}"
assert_contains "plugin path added" "${PLUGIN_PATH}" "${cfg}"
assert_eq "mcp server url normalized to /api/mcp" "http://ci-os-hub:3000/api/mcp" "$(mcp_field "${cfg}" url)"
assert_eq "transport is streamable-http" "streamable-http" "$(mcp_field "${cfg}" transport)"
assert_eq "auth uses env-template interpolation" 'Bearer ${HUB_MCP_API_KEY}' "$(mcp_field "${cfg}" auth)"
assert_not_contains "raw key never written to disk" "test-key" "${cfg}"
rm -rf "${data_dir}"

# ─── Test 2: HUB_URL alone (no HUB_MCP_URL) derives the /api/mcp endpoint ────
echo "test: HUB_URL + HUB_MCP_API_KEY derives the /api/mcp endpoint"
data_dir="$(mktemp -d)"
setup_config "${data_dir}"
run_bootstrap "${data_dir}" \
  HUB_URL="http://ci-os-hub:3000" \
  HUB_MCP_API_KEY="test-key"
cfg="${data_dir}/openclaw.json"
assert_eq "mcp server url derived from HUB_URL" "http://ci-os-hub:3000/api/mcp" "$(mcp_field "${cfg}" url)"
rm -rf "${data_dir}"

# ─── Test 3: an already-canonical /api/mcp URL is not corrupted ──────────────
echo "test: a canonical /api/mcp HUB_MCP_URL is left unchanged (no /sse appended)"
data_dir="$(mktemp -d)"
setup_config "${data_dir}"
run_bootstrap "${data_dir}" \
  HUB_MCP_URL="http://ci-os-hub:3000/api/mcp" \
  HUB_MCP_API_KEY="test-key"
cfg="${data_dir}/openclaw.json"
assert_eq "url stays /api/mcp" "http://ci-os-hub:3000/api/mcp" "$(mcp_field "${cfg}" url)"
assert_not_contains "no /sse suffix" "/api/mcp/sse" "${cfg}"
rm -rf "${data_dir}"

# ─── Test 4: HUB_MCP_ENABLED=false registers no MCP server + disables plugin ─
echo "test: HUB_MCP_ENABLED=false keeps plugin disabled and adds no MCP server"
data_dir="$(mktemp -d)"
setup_config "${data_dir}"
run_bootstrap "${data_dir}" \
  HUB_MCP_URL="http://ci-os-hub:3000/api/mcp" \
  HUB_MCP_API_KEY="test-key" \
  HUB_MCP_ENABLED=false
cfg="${data_dir}/openclaw.json"
assert_eq "no ci-hub MCP server" "" "$(mcp_field "${cfg}" url)"
assert_eq "plugin entry disabled" "false" "$(node -e '
  const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(((o.plugins||{}).entries||{})["ci-hub"]?.enabled ?? false).toLowerCase());
' "${cfg}")"
rm -rf "${data_dir}"

# ─── Test 5: credentials removed on a later run drop the MCP server entry ────
echo "test: a run without creds removes a previously-registered ci-hub MCP server"
data_dir="$(mktemp -d)"
setup_config "${data_dir}"
run_bootstrap "${data_dir}" HUB_MCP_URL="http://ci-os-hub:3000/api/mcp" HUB_MCP_API_KEY="test-key"
cfg="${data_dir}/openclaw.json"
assert_eq "server registered first" "http://ci-os-hub:3000/api/mcp" "$(mcp_field "${cfg}" url)"
run_bootstrap "${data_dir}"  # no Hub creds this run
assert_eq "server removed when creds vanish" "" "$(mcp_field "${cfg}" url)"
rm -rf "${data_dir}"

# ─── Test 6: idempotent second run ───────────────────────────────────────────
echo "test: second run with unchanged env is idempotent"
data_dir="$(mktemp -d)"
setup_config "${data_dir}"
env_args=(HUB_MCP_URL="http://ci-os-hub:3000/api/mcp" HUB_MCP_API_KEY="test-key")
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
