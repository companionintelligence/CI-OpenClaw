#!/usr/bin/env bash
# Print the newest release tag in this repository, or nothing if there is none.
#
# This is the rule that decides whether a build moves `:latest`. It lives here
# rather than inline in docker-publish.yml so it can be tested — the publish is
# the one workflow whose mistakes are visible to every appliance, and the
# previous behaviour (push `:latest` unconditionally) meant a workflow_dispatch
# republish of an old tag silently repointed `:latest` backwards.
#
# "Newest" is the highest tag under git's version sort, which compares numeric
# components rather than bytes: 2026.7.13 outranks 2026.7.9, and 2026.7.27.1
# outranks 2026.7.27.
#
# Exits 0 with EMPTY output when no release tag exists. That is a real state — a
# fresh fork, or a hand-pushed tag that is not a release — and the caller decides
# what to do about it. Aborting instead would fail the publish with no
# explanation, because `grep` exiting 1 on no match trips `pipefail`.
#
# The caller must have fetched tags first; this only inspects local refs.
set -euo pipefail

# Exactly the shape scripts/next-release-tag.sh allocates, and deliberately
# narrower than the `[0-9]*` push trigger in docker-publish.yml: any other
# digit-leading tag that reaches the publish is not a release and must not win
# `:latest`.
#
# Components are unpadded ([1-9][0-9]? — never 07) because git's version sort
# cannot rank a padded one. `--sort=v:refname` uses strverscmp semantics, where a
# leading zero marks a fractional part, so 2026.08.01 sorts BELOW 2026.7.27
# rather than above it. Matching such a tag would mean ranking it wrongly;
# ignoring it means it publishes its own tag but never claims :latest, and the
# step logs which tag it considered newest. No existing tag is padded and
# next-release-tag.sh now rejects padded dates outright, so this is unreachable
# short of a hand-pushed tag.
RELEASE_TAG_RE='^[0-9]{4}\.[1-9][0-9]?\.[1-9][0-9]?(\.[0-9]+)?$'

# `|| true` covers both no-match (grep exits 1) and `head` closing the pipe early
# (git tag dies of SIGPIPE), neither of which is an error here.
git tag --list --sort=-v:refname | grep -E "${RELEASE_TAG_RE}" | head -n1 || true
