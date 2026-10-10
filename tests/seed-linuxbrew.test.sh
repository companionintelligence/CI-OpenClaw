#!/bin/bash
# Tests for seed-linuxbrew.sh, which copies the image's Homebrew into /home/linuxbrew when that
# mount is empty. Paths and the privileged helper are overridden, so nothing here needs root.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/../seed-linuxbrew.sh"

PASS=0
FAIL=0
SKIP=0

check() {
  local label="$1"
  shift
  if "$@"; then
    echo "  ✓ ${label}"
    PASS=$((PASS + 1))
  else
    echo "  ✗ ${label}"
    FAIL=$((FAIL + 1))
  fi
}

skip() {
  echo "  - skipped: $1"
  SKIP=$((SKIP + 1))
}

# A skeleton shaped like the image's: /home-skeleton/linuxbrew/.linuxbrew/...
make_skeleton() {
  local root="$1"
  mkdir -p "${root}/linuxbrew/.linuxbrew/bin" "${root}/linuxbrew/.linuxbrew/Homebrew"
  printf '#!/bin/sh\necho "Homebrew 4.6.0"\n' > "${root}/linuxbrew/.linuxbrew/Homebrew/brew"
  chmod +x "${root}/linuxbrew/.linuxbrew/Homebrew/brew"
  ln -s ../Homebrew/brew "${root}/linuxbrew/.linuxbrew/bin/brew" 2>/dev/null \
    || cp "${root}/linuxbrew/.linuxbrew/Homebrew/brew" "${root}/linuxbrew/.linuxbrew/bin/brew"
}

# Stands in for sudo: records each call, then runs it unprivileged. `chown` to our own uid is a
# no-op for an unprivileged user, so it also grants write access, which is what taking
# ownership of a root-owned volume achieves in the container.
make_sudo_stub() {
  local dir="$1"
  cat > "${dir}/sudo" <<'STUB'
#!/bin/sh
echo "$*" >> "$(dirname "$0")/calls.log"
if [ "$1" = "chown" ]; then
  chmod u+w "$3"
  exit 0
fi
exec "$@"
STUB
  chmod +x "${dir}/sudo"
  : > "${dir}/calls.log"
}

run_seed() {
  local skel="$1" target="$2" stub="$3" rc=0
  LINUXBREW_SKELETON="${skel}/linuxbrew" LINUXBREW_DIR="${target}" LINUXBREW_SUDO="${stub}/sudo" \
    bash "${SCRIPT}" >/dev/null 2>&1 || rc=$?
  echo "${rc}"
}

new_case() {
  CASE="$(mktemp -d)"
  make_skeleton "${CASE}/skel"
  mkdir -p "${CASE}/bin"
  make_sudo_stub "${CASE}/bin"
}

# ─── Test 1: an empty mount gets Homebrew (a fresh named volume, or a fresh bind) ──
echo "test: an empty /home/linuxbrew is seeded from the skeleton"
new_case
mkdir -p "${CASE}/target"
rc="$(run_seed "${CASE}/skel" "${CASE}/target" "${CASE}/bin")"
check "exits 0" [ "${rc}" = "0" ]
check "brew is in place" [ -f "${CASE}/target/.linuxbrew/Homebrew/brew" ]
check "brew is still executable" [ -x "${CASE}/target/.linuxbrew/Homebrew/brew" ]
if [ -L "${CASE}/skel/linuxbrew/.linuxbrew/bin/brew" ]; then
  check "symlinks stay symlinks" [ -L "${CASE}/target/.linuxbrew/bin/brew" ]
else
  skip "this filesystem cannot make the symlink fixture"
fi
check "nothing asked for root" [ ! -s "${CASE}/bin/calls.log" ]

# ─── Test 2: a mount that already has Homebrew is left alone (every later start, and every
#     bind-mounted /data, where /data/linuxbrew is the same folder) ──
echo "test: a /home/linuxbrew that already has content is untouched"
new_case
mkdir -p "${CASE}/target/.linuxbrew"
echo "installed by the user" > "${CASE}/target/.linuxbrew/marker"
rc="$(run_seed "${CASE}/skel" "${CASE}/target" "${CASE}/bin")"
check "exits 0" [ "${rc}" = "0" ]
check "existing content kept" grep -qx "installed by the user" "${CASE}/target/.linuxbrew/marker"
check "skeleton not copied over it" [ ! -e "${CASE}/target/.linuxbrew/Homebrew/brew" ]

# ─── Test 3: no skeleton (an image built without Homebrew) is a no-op ──
echo "test: no skeleton means nothing to do"
new_case
rm -rf "${CASE}/skel/linuxbrew"
mkdir -p "${CASE}/target"
rc="$(run_seed "${CASE}/skel" "${CASE}/target" "${CASE}/bin")"
check "exits 0" [ "${rc}" = "0" ]
check "target still empty" [ -z "$(ls -A "${CASE}/target")" ]

# ─── Test 4: no mount at all (plain docker run) creates the folder ──
echo "test: a missing /home/linuxbrew is created and seeded"
new_case
rc="$(run_seed "${CASE}/skel" "${CASE}/target" "${CASE}/bin")"
check "exits 0" [ "${rc}" = "0" ]
check "created through the privileged helper" grep -q "^mkdir -p ${CASE}/target$" "${CASE}/bin/calls.log"
check "brew is in place" [ -f "${CASE}/target/.linuxbrew/Homebrew/brew" ]

# ─── Test 5: a root-owned empty mount (a fresh named volume) is taken over, then seeded ──
echo "test: an unwritable empty /home/linuxbrew is taken over first"
new_case
mkdir -p "${CASE}/target"
chmod 555 "${CASE}/target"
if probe="$(mktemp "${CASE}/target/.probe.XXXXXX" 2>/dev/null)"; then
  rm -f "${probe}"
  chmod 755 "${CASE}/target"
  skip "chmod 555 does not stop writes here (Windows or root)"
else
  rc="$(run_seed "${CASE}/skel" "${CASE}/target" "${CASE}/bin")"
  check "exits 0" [ "${rc}" = "0" ]
  check "took ownership through the privileged helper" grep -q "^chown .* ${CASE}/target$" "${CASE}/bin/calls.log"
  check "brew is in place" [ -f "${CASE}/target/.linuxbrew/Homebrew/brew" ]
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped"
[[ "${FAIL}" -eq 0 ]]
