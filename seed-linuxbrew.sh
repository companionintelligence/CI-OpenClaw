#!/bin/sh
# Puts the image's Homebrew into /home/linuxbrew when that mount is empty.
#
# The Dockerfile installs Homebrew in /home/linuxbrew and moves it into the skeleton, because
# /home/linuxbrew is a mount at runtime. On a Hub it is mounted from <app data>/data/linuxbrew,
# which is also /data/linuxbrew while /data is a bind mount of <app data>/data, so the setup
# server's copy of the skeleton into $HOME used to fill it. A Windows Hub mounts /data as a named
# volume instead (the manifest marks it requiresPosixPermissions), the two folders come apart,
# and that copy left /home/linuxbrew empty. This fills the mount directly, on every platform.
#
# Runs from the entrypoint as `node`. LINUXBREW_DIR, LINUXBREW_SKELETON and LINUXBREW_SUDO are
# for tests/seed-linuxbrew.test.sh.
set -eu

TARGET="${LINUXBREW_DIR:-/home/linuxbrew}"
SOURCE="${LINUXBREW_SKELETON:-/home-skeleton/linuxbrew}"
SUDO="${LINUXBREW_SUDO:-sudo}"

log() {
  echo "[linuxbrew] $*"
}

if [ ! -d "${SOURCE}" ]; then
  log "no Homebrew in ${SOURCE}; nothing to seed"
  exit 0
fi

# No mount at all (a plain `docker run`): seed a folder in the container so brew still works.
if [ ! -d "${TARGET}" ]; then
  "${SUDO}" mkdir -p "${TARGET}"
fi

# The copy goes into a staging folder inside the mount and is then renamed into place. A copy cut
# short (the container stopped mid-way, a full disk, a file the mount refused) leaves only the
# staging folder, which the check below ignores, so the next start copies again. Copied straight
# into the mount, half a Homebrew would look like a finished one and never be retried.
STAGING="${TARGET}/.seeding"

# Anything else already there is Homebrew from an earlier start, with whatever the agent installed.
if [ -n "$(ls -A "${TARGET}" 2>/dev/null | grep -v -e '^\.seeding$' -e '^\.seed-write-test\.' || true)" ]; then
  exit 0
fi

# A fresh named volume, and a folder created above, are owned by root. Same gate as the
# entrypoint's /data check: write access is what matters, not ownership.
if probe="$(mktemp "${TARGET}/.seed-write-test.XXXXXX" 2>/dev/null)"; then
  rm -f "${probe}"
else
  log "${TARGET} is not writable as uid $(id -u); taking ownership"
  "${SUDO}" chown "$(id -u):$(id -g)" "${TARGET}"
fi

rm -rf "${STAGING}"
log "copying Homebrew from ${SOURCE} into ${TARGET}"
cp -a "${SOURCE}" "${STAGING}"
# Same filesystem, so each mv is a rename. The image's Homebrew has one top-level entry
# (.linuxbrew), which makes the switch a single step.
for entry in "${STAGING}"/* "${STAGING}"/.[!.]* "${STAGING}"/..?*; do
  if [ -e "${entry}" ] || [ -L "${entry}" ]; then
    mv "${entry}" "${TARGET}/"
  fi
done
rmdir "${STAGING}"
