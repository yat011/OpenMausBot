#!/bin/sh
# Boot the server from the fork repo mounted at $OMB_SRC_DIR (/src).
# - pnpm install when node_modules is missing or the lockfile changed
# - rebuild server + renderer when the git tree changed (mtime fallback)
# - stage the host SSH key for git self-update, then exec node
# Fingerprints live in /data/.omb-build so restarts are fast when idle.
set -u
SRC="${OMB_SRC_DIR:-/src}"
STATE_DIR="${OMB_STATE_DIR:-/data/.omb-build}"
HOST_SSH="${OMB_HOST_SSH:-/mnt/host-ssh}"
CONTAINER_SSH="${OMB_CONTAINER_SSH:-/data/.ssh}"

cd "$SRC" 2>/dev/null || { echo "repo-start: $SRC is not mounted" >&2; exit 1; }
[ -f package.json ] || { echo "repo-start: no package.json in $SRC" >&2; exit 1; }
mkdir -p "$STATE_DIR"

sha_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

# --- dependencies (node_modules lives on a Linux volume: pnpm symlinks
# cannot live on the Windows bind mount; same for the content store) ---
pnpm config set store-dir /data/.pnpm-store --global >/dev/null 2>&1 || true
LOCK_FP="$STATE_DIR/pnpm-lock.sha"
if [ ! -d "$SRC/node_modules" ] || [ "$(sha_of pnpm-lock.yaml)" != "$(cat "$LOCK_FP" 2>/dev/null)" ]; then
  echo "repo-start: installing dependencies"
  pnpm install --frozen-lockfile || exit 1
  sha_of pnpm-lock.yaml > "$LOCK_FP"
fi

# --- build fingerprint: committed + dirty state of the build inputs only,
# so doc-only pulls skip the rebuild (mtime fallback without git) ---
CODE_PATHS="server src shared scripts index.html public vite.config.ts package.json pnpm-lock.yaml tsconfig.json tsconfig.server.json tsconfig.server.build.json tsconfig.companion.build.json"
fingerprint() {
  if git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
    { git -C "$SRC" ls-tree -r HEAD -- $CODE_PATHS 2>/dev/null; git -C "$SRC" status --porcelain -- $CODE_PATHS; } | sha256sum | cut -d' ' -f1
  else
    echo "mtime $(find "$SRC/server" "$SRC/src" "$SRC/shared" "$SRC/scripts" "$SRC/package.json" -type f -printf '%T@\n' 2>/dev/null | sort -rn | head -1)"
  fi
}
BUILD_FP="$STATE_DIR/tree.fp"
if [ ! -f "$SRC/dist-server/index.js" ] || [ ! -f "$SRC/dist/index.html" ] || [ "$(fingerprint)" != "$(cat "$BUILD_FP" 2>/dev/null)" ]; then
  echo "repo-start: building server and renderer"
  pnpm build:server || exit 1
  pnpm exec vite build || exit 1
  fingerprint > "$BUILD_FP"
fi

# --- git self-update wiring (container files are root-owned; the mount is
# shared with the Windows host, so mark it safe explicitly) ---
git config --global --get-all safe.directory 2>/dev/null | grep -qx "$SRC" \
  || git config --global --add safe.directory "$SRC"
if [ -d "$HOST_SSH" ]; then
  mkdir -p "$CONTAINER_SSH"
  chmod 700 "$CONTAINER_SSH"
  rm -f "$CONTAINER_SSH"/id_ed25519 "$CONTAINER_SSH"/id_ecdsa "$CONTAINER_SSH"/id_rsa
  KEY=""
  for base in id_ed25519 id_ecdsa id_rsa; do
    if [ -f "$HOST_SSH/$base" ]; then KEY="$base"; break; fi
  done
  if [ -n "$KEY" ]; then
    cp "$HOST_SSH/$KEY" "$CONTAINER_SSH/$KEY"
    chmod 600 "$CONTAINER_SSH/$KEY"
    [ -f "$HOST_SSH/$KEY.pub" ] && cp "$HOST_SSH/$KEY.pub" "$CONTAINER_SSH/$KEY.pub"
    export GIT_SSH_COMMAND="ssh -i $CONTAINER_SSH/$KEY -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
    echo "repo-start: git ssh key staged ($KEY)"
  else
    echo "repo-start: no private key in $HOST_SSH; git push unavailable" >&2
  fi
  [ -f "$HOST_SSH/known_hosts" ] && cp "$HOST_SSH/known_hosts" "$CONTAINER_SSH/known_hosts"
fi

exec node "$SRC/dist-server/index.js"
