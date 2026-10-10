#!/bin/bash
# Tests for healthcheck.sh, the image's Docker HEALTHCHECK. Each case runs the script against a
# stub setup server on a free local port and checks the exit code Docker would see.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../healthcheck.sh"

PASS=0
FAIL=0
STUB_PID=""

assert_exit() {
  local label="$1" want="$2" got="$3"
  if [[ "${want}" == "${got}" ]]; then
    echo "  ✓ ${label}"
    PASS=$((PASS + 1))
  else
    echo "  ✗ ${label}"
    echo "    want exit: ${want}"
    echo "    got exit:  ${got}"
    FAIL=$((FAIL + 1))
  fi
}

stop_stub() {
  if [[ -n "${STUB_PID}" ]]; then
    kill "${STUB_PID}" 2>/dev/null || true
    for _ in $(seq 1 40); do
      kill -0 "${STUB_PID}" 2>/dev/null || break
      sleep 0.05
    done
    STUB_PID=""
  fi
}
trap stop_stub EXIT

# Serves `status` on /__ci_health and 404 everywhere else, so a script that asks the wrong path
# cannot pass the 503 case by accident. Sets STUB_PORT.
start_stub() {
  local status="$1" port_file
  port_file="$(mktemp)"
  node -e '
    const http = require("http");
    const [status, portFile] = process.argv.slice(1);
    const server = http.createServer((req, res) => {
      const ours = req.url.split("?")[0] === "/__ci_health";
      res.writeHead(ours ? Number(status) : 404, { "Content-Type": "application/json" });
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => require("fs").writeFileSync(portFile, String(server.address().port)));
  ' "${status}" "${port_file}" >/dev/null 2>&1 &
  STUB_PID=$!
  for _ in $(seq 1 100); do
    [[ -s "${port_file}" ]] && break
    sleep 0.05
  done
  STUB_PORT="$(cat "${port_file}")"
  rm -f "${port_file}"
}

# A port nothing listens on: bind an ephemeral one, then let it go.
free_port() {
  node -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });'
}

run_check() {
  local rc=0
  SETUP_PORT="$1" sh "${SCRIPT}" >/dev/null 2>&1 || rc=$?
  echo "${rc}"
}

echo "test: the gateway is up"
start_stub 200
assert_exit "200 passes" 0 "$(run_check "${STUB_PORT}")"
stop_stub

echo "test: the gateway has exited"
start_stub 503
assert_exit "503 fails" 1 "$(run_check "${STUB_PORT}")"
stop_stub

echo "test: the setup server is not listening yet (bootstrap still running)"
assert_exit "no answer passes" 0 "$(run_check "$(free_port)")"

echo "test: only a 503 counts as the gateway being down"
start_stub 500
assert_exit "500 passes" 0 "$(run_check "${STUB_PORT}")"
stop_stub

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
