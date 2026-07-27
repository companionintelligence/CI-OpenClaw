#!/usr/bin/env bash
# Print the openclaw version pinned in the Dockerfile.
#
# The Dockerfile pin is the single source of truth for which openclaw the image
# ships. This script is the single source of truth for *reading* it — the same
# one-liner used to be copy-pasted into four workflows, two docs, and a test
# hint, and every copy shared the same bug: `[0-9]+(\.[0-9]+)*` stops at a
# hyphen, so a pin of `2026.7.1-2` read back as `2026.7.1`. Upstream publishes
# same-day patches in exactly that form (npm's own dist-tag `latest` is
# `2026.7.1-2`), so the truncation silently mismatched the shipped version.
#
# Usage: scripts/openclaw-pin.sh [path/to/Dockerfile]
set -euo pipefail

DOCKERFILE="${1:-$(cd "$(dirname "$0")/.." && pwd)/Dockerfile}"

[[ -f "${DOCKERFILE}" ]] || { echo "no Dockerfile at ${DOCKERFILE}" >&2; exit 1; }

# Match everything up to whitespace so prerelease and same-day-patch forms
# (-beta.1, -2) survive intact.
version=$(grep -oE 'openclaw@[0-9][^[:space:]]*' "${DOCKERFILE}" | head -n1 | cut -d'@' -f2)

[[ -n "${version}" ]] || { echo "no openclaw@<version> pin found in ${DOCKERFILE}" >&2; exit 1; }

printf '%s\n' "${version}"
