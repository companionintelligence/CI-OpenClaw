#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="${ROOT}/.github/workflows/docker-publish.yml"
DOC="${ROOT}/.github/workflows/README-docker-publish.md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "${WORKFLOW}" ]] || fail "missing workflow: ${WORKFLOW}"
[[ -f "${DOC}" ]] || fail "missing doc: ${DOC}"

grep -Eq -- '--platform[[:space:]]+linux/amd64,linux/arm64' "${WORKFLOW}" \
  || fail "workflow does not build linux/amd64,linux/arm64"

grep -Fqx -- "It builds multi-arch images (\`linux/amd64\`, \`linux/arm64\`) and pushes:" "${DOC}" \
  || fail "workflow doc does not mention linux/amd64 + linux/arm64"

echo "PASS: docker publish workflow is multi-arch"
