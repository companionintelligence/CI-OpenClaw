#!/usr/bin/env bash
# Print the next free release tag for today (UTC), as YYYY.M.D[.N].
#
# Release tags name the CI-OpenClaw *image*, which CI-Marketplace's
# apps/ci-openclaw config.json version must match exactly. They are dates, not
# upstream openclaw versions — see README-docker-publish.md.
#
# Deriving the tag from the Dockerfile's openclaw@ pin (the old behaviour) put
# two different things in one namespace: upstream publishes YYYY.M.D versions
# and humans cut YYYY.M.D releases, so the names collided (2026.7.1 and
# 2026.7.21 both landed on commit 882f369) and a collision silently produced no
# release at all. A date allocated against the existing tags cannot collide.
#
# Components are unpadded to match every existing tag: 2026.7.5, not 2026.07.05.
#
# Environment:
#   RELEASE_DATE_OVERRIDE   Use this date instead of today's (tests only)
#
# The caller must have fetched tags first; this only inspects local refs.
set -euo pipefail

MAX_PER_DAY=50

base="${RELEASE_DATE_OVERRIDE:-$(date -u +%Y.%-m.%-d)}"

# Guards the override and the `date` output alike. A malformed value here becomes
# a malformed release tag, and CI-Marketplace's apps/ci-openclaw config.json
# version must match the tag exactly. It also turns a portability failure into a
# loud one: `%-m`/`%-d` are a GNU extension, so on a platform without them this
# rejects the result instead of allocating a tag nobody can reproduce.
[[ "${base}" =~ ^[0-9]{4}\.[1-9][0-9]?\.[1-9][0-9]?$ ]] \
  || { echo "not an unpadded YYYY.M.D date: ${base}" >&2; exit 1; }

if ! git rev-parse -q --verify "refs/tags/${base}" >/dev/null 2>&1; then
  printf '%s\n' "${base}"
  exit 0
fi

n=1
while git rev-parse -q --verify "refs/tags/${base}.${n}" >/dev/null 2>&1; do
  n=$((n + 1))
  if [[ ${n} -gt ${MAX_PER_DAY} ]]; then
    echo "refusing to allocate more than ${MAX_PER_DAY} releases on ${base}" >&2
    exit 1
  fi
done

printf '%s.%s\n' "${base}" "${n}"
