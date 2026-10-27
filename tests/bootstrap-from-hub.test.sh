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
printf 'ANTHROPIC_API_KEY=user-secret\nOPENCLAW_GATEWAY_TOKEN=gw-token\nOPENAI_API_BASE=stale-value\n' > "${data_dir}/.env"
fixture="$(write_fixture "${fix_body}")"
run_script "${data_dir}" "${fixture}"
assert_contains "ANTHROPIC_API_KEY preserved" "ANTHROPIC_API_KEY=user-secret" "${data_dir}/.env"
assert_contains "OPENCLAW_GATEWAY_TOKEN preserved" "OPENCLAW_GATEWAY_TOKEN=gw-token" "${data_dir}/.env"
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
rc=0
OPENCLAW_DATA_DIR="${data_dir}" CI_HUB_URL="http://127.0.0.1:1" "${SCRIPT}" >/dev/null 2>&1 || rc=$?
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

# ─── Test 7: Header-driven managed keys overrides hardcoded fallback ────────
echo "test: header X-Hub-Managed-Keys drives the managed-key list"
data_dir="$(setup_data)"
printf 'OPENAI_API_BASE=user-value\nNEW_HUB_KEY=user-old\n' > "${data_dir}/.env"
# Hub response has NEW_HUB_KEY which is not in the hardcoded fallback list.
# Header tells the script that NEW_HUB_KEY (plus OPENAI_API_BASE) are managed.
fixture="$(write_fixture $'OPENAI_API_BASE=http://hub/v1\nNEW_HUB_KEY=hub-value\n')"
OPENCLAW_DATA_DIR="${data_dir}" \
BOOTSTRAP_FIXTURE_FILE="${fixture}" \
BOOTSTRAP_FIXTURE_MANAGED_KEYS="OPENAI_API_BASE,NEW_HUB_KEY" \
  "${SCRIPT}" >/dev/null 2>&1
assert_contains "NEW_HUB_KEY overwritten using header-driven list" "NEW_HUB_KEY=hub-value" "${data_dir}/.env"
assert_contains "OPENAI_API_BASE overwritten" "OPENAI_API_BASE=http://hub/v1" "${data_dir}/.env"
assert_not_contains "stale NEW_HUB_KEY removed" "NEW_HUB_KEY=user-old" "${data_dir}/.env"
rm -rf "${data_dir}" "${fixture}"

# ─── Test 8: Missing header falls back to hardcoded list ────────────────────
echo "test: missing header falls back to hardcoded list, NEW_HUB_KEY treated as user-set"
data_dir="$(setup_data)"
printf 'NEW_HUB_KEY=user-old\nOLLAMA_HOST=http://old-host:11434\n' > "${data_dir}/.env"
fixture="$(write_fixture $'OPENAI_API_BASE=http://hub/v1\nNEW_HUB_KEY=hub-value\nOLLAMA_HOST=http://new-host:11434\n')"
# No BOOTSTRAP_FIXTURE_MANAGED_KEYS — script falls back to hardcoded list
# which doesn't include NEW_HUB_KEY, so user's NEW_HUB_KEY=user-old is preserved
# and NEW_HUB_KEY=hub-value is dropped because it's not in the managed list.
OPENCLAW_DATA_DIR="${data_dir}" \
BOOTSTRAP_FIXTURE_FILE="${fixture}" \
  "${SCRIPT}" >/dev/null 2>&1
assert_contains "OPENAI_API_BASE in hardcoded fallback present" "OPENAI_API_BASE=http://hub/v1" "${data_dir}/.env"
assert_contains "OLLAMA_HOST in hardcoded fallback overwritten" "OLLAMA_HOST=http://new-host:11434" "${data_dir}/.env"
assert_contains "user NEW_HUB_KEY preserved (not in hardcoded list)" "NEW_HUB_KEY=user-old" "${data_dir}/.env"
assert_not_contains "Hub's NEW_HUB_KEY dropped (not in hardcoded list)" "NEW_HUB_KEY=hub-value" "${data_dir}/.env"
rm -rf "${data_dir}" "${fixture}"

# ─── Test 9: CI_LLM_NUM_CTX retained via hardcoded fallback (no header) ──────
echo "test: CI_LLM_NUM_CTX is in the hardcoded fallback and is overwritten from Hub"
data_dir="$(setup_data)"
printf 'CI_LLM_NUM_CTX=8192\n' > "${data_dir}/.env"
fixture="$(write_fixture $'OPENAI_API_BASE=http://hub/v1\nCI_LLM_NUM_CTX=32768\n')"
# No BOOTSTRAP_FIXTURE_MANAGED_KEYS — falls back to the hardcoded list, which now
# includes CI_LLM_NUM_CTX, so the Hub value overwrites the stale local one.
OPENCLAW_DATA_DIR="${data_dir}" \
BOOTSTRAP_FIXTURE_FILE="${fixture}" \
  "${SCRIPT}" >/dev/null 2>&1
assert_contains "CI_LLM_NUM_CTX overwritten from Hub via fallback" "CI_LLM_NUM_CTX=32768" "${data_dir}/.env"
assert_not_contains "stale CI_LLM_NUM_CTX dropped" "CI_LLM_NUM_CTX=8192" "${data_dir}/.env"
rm -rf "${data_dir}" "${fixture}"

# ─── Test 10: CI_CLOUD_* keys persist via hardcoded fallback (no header) ─────
echo "test: CI_CLOUD_* keys are in the hardcoded fallback and are written from Hub"
data_dir="$(setup_data)"
printf 'CI_CLOUD_OPENAI_API_KEY=stale-oai\nANTHROPIC_API_KEY=user-secret\n' > "${data_dir}/.env"
fixture="$(write_fixture $'OPENAI_API_BASE=http://hub/v1\nCI_CLOUD_OPENAI_API_KEY=sk-oai\nCI_CLOUD_OPENAI_BASE_URL=https://api.openai.com/v1\nCI_CLOUD_ANTHROPIC_API_KEY=sk-ant\n')"
OPENCLAW_DATA_DIR="${data_dir}" \
BOOTSTRAP_FIXTURE_FILE="${fixture}" \
  "${SCRIPT}" >/dev/null 2>&1
assert_contains "CI_CLOUD_OPENAI_API_KEY overwritten from Hub" "CI_CLOUD_OPENAI_API_KEY=sk-oai" "${data_dir}/.env"
assert_contains "CI_CLOUD_OPENAI_BASE_URL written" "CI_CLOUD_OPENAI_BASE_URL=https://api.openai.com/v1" "${data_dir}/.env"
assert_contains "CI_CLOUD_ANTHROPIC_API_KEY written" "CI_CLOUD_ANTHROPIC_API_KEY=sk-ant" "${data_dir}/.env"
assert_contains "user ANTHROPIC_API_KEY preserved (alias not in fallback)" "ANTHROPIC_API_KEY=user-secret" "${data_dir}/.env"
assert_not_contains "stale cloud OpenAI key dropped" "CI_CLOUD_OPENAI_API_KEY=stale-oai" "${data_dir}/.env"
rm -rf "${data_dir}" "${fixture}"

# ─── A slow handout still arrives ───────────────────────────────────────────────
# The Hub's handout can take 10 s (it probes Ollama addresses that may not answer,
# 3 s each). With --max-time 5 both tries timed out and OpenClaw kept its old
# inference settings on every start. This stand-in Hub answers after 6 s.
slow_hub() {  # $1 delay seconds, $2 file to write the port to
  python3 -c '
import http.server, sys, time
delay = float(sys.argv[1])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(delay)
        body = b"DEFAULT_MODEL=qwen3.5:9b\nOPENAI_API_KEY=ollama\n"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Hub-Managed-Keys", "DEFAULT_MODEL,OPENAI_API_KEY")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(sys.argv[2], "w").write(str(s.server_address[1]))
s.serve_forever()
' "$1" "$2" &
}

if command -v python3 >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
  echo "test: a handout that takes 6 s to arrive is still merged"
  data_dir="$(mktemp -d)"
  port_file="$(mktemp)"
  slow_hub 6 "${port_file}"
  hub_pid=$!
  for _ in $(seq 1 50); do [[ -s "${port_file}" ]] && break; sleep 0.1; done
  assert_eq "test Hub started" "yes" "$([[ -s "${port_file}" ]] && echo yes || echo no)"
  OPENCLAW_DATA_DIR="${data_dir}" CI_HUB_URL="http://127.0.0.1:$(cat "${port_file}")" sh "${SCRIPT}" >/dev/null 2>&1 || true
  touch "${data_dir}/.env"
  assert_contains "handout merged" "DEFAULT_MODEL=qwen3.5:9b" "${data_dir}/.env"

  echo "test: HUB_BOOTSTRAP_TIMEOUT still bounds the wait"
  rm -f "${data_dir}/.env"
  start=$(date +%s)
  OPENCLAW_DATA_DIR="${data_dir}" HUB_BOOTSTRAP_TIMEOUT=1 CI_HUB_URL="http://127.0.0.1:$(cat "${port_file}")" sh "${SCRIPT}" >/dev/null 2>&1 || true
  took=$(( $(date +%s) - start ))
  assert_eq "no handout when the Hub is slower than the limit" "no" "$([[ -s "${data_dir}/.env" ]] && echo yes || echo no)"
  # 2 tries of 1 s plus the 2 s delay is 4 s. The lower bound proves both tries
  # waited; a request that failed at once would also leave no handout.
  assert_eq "waited for both tries (at least 3 s)" "yes" "$([[ ${took} -ge 3 ]] && echo yes || echo no)"
  assert_eq "gave up within the limit" "yes" "$([[ ${took} -le 6 ]] && echo yes || echo no)"
  kill "${hub_pid}" 2>/dev/null || true
  wait "${hub_pid}" 2>/dev/null || true
  rm -rf "${data_dir}" "${port_file}"
else
  echo "test: SKIPPED slow-handout tests (need python3 and curl)" >&2
fi

echo "test: HUB_BOOTSTRAP_TIMEOUT=0 or a non-number falls back to 20 s"
# curl reads --max-time 0 as no limit and exits at once on a non-number.
data_dir="$(mktemp -d)"
for bad in 0 abc 1.5 -3; do
  out="$(OPENCLAW_DATA_DIR="${data_dir}" HUB_BOOTSTRAP_TIMEOUT="${bad}" CI_HUB_URL="http://127.0.0.1:1" sh "${SCRIPT}" 2>&1 || true)"
  assert_eq "HUB_BOOTSTRAP_TIMEOUT=${bad} is refused" "yes" \
    "$(grep -qF "HUB_BOOTSTRAP_TIMEOUT=${bad} is not a positive whole number of seconds; using 20" <<<"${out}" && echo yes || echo no)"
done
out="$(OPENCLAW_DATA_DIR="${data_dir}" HUB_BOOTSTRAP_TIMEOUT=7 CI_HUB_URL="http://127.0.0.1:1" sh "${SCRIPT}" 2>&1 || true)"
assert_eq "HUB_BOOTSTRAP_TIMEOUT=7 is accepted" "no" "$(grep -qF "not a positive whole number" <<<"${out}" && echo yes || echo no)"
rm -rf "${data_dir}"

# ─── Summary ────────────────────────────────────────────────────────────────
echo
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
