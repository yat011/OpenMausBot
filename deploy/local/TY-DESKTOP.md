# ty-desktop mount setup (fork addition)

The `omb` image is runtime-only (toolchain, engine CLIs, gateway binaries,
browser wrapper). It contains no server source: the host fork checkout
bind-mounts at `/src`, and `repo-start.sh` installs deps + rebuilds on boot
only when inputs changed (fingerprints in `/data/.omb-build`). Fork updates
are `git pull` + container restart -- no image rebuild.

The headed-browser sidecar in `../desktop/` is a separate image and is
unaffected (rebuild it only when its own Dockerfile changes).

## First-time setup on ty-desktop

Host checkout must be a real git repo with LF endings (scripts are baked
into the Linux image from this checkout):

```cmd
cd /d C:\Users\devya\OpenMausBot
git init
git remote add origin git@github.com:yat011/OpenMausBot.git
git config core.autocrlf false
git config core.fileMode false
git fetch origin
git reset origin/main
git stash -u -m "ty-desktop pre-git snapshot"
git branch -m main
git branch --set-upstream-to=origin/main main
```

Place the three binary sets beside this file (git-ignored, see below), then
build once. Over SSH the Windows credential helper is unusable, so pre-pull
base images and build with `--pull=false` (direct `docker build`, not
`compose build`, which has no pull=false):

```cmd
docker pull node:24-bookworm-slim
docker build --pull=false --build-arg ENGINES= -f deploy/local/Dockerfile -t openmausbot-local:latest deploy/local
docker pull debian:bookworm-slim
docker build --pull=false -f deploy/desktop/Dockerfile -t openmausbot-desktop:latest deploy/desktop
docker compose up -d
```

First boot runs `pnpm install` + full build (minutes); later boots skip both
when idle (seconds).

## Daily updates

```cmd
git pull
docker compose restart omb
```

`repo-start.sh` detects the new tree, rebuilds, and starts it. To update the
bot from inside itself: `git pull` in `/src`, then exit the server process --
`restart: unless-stopped` boots the new tree automatically.

Rebuild `openmausbot-local` only when this directory's runtime files change
(Dockerfile, repo-start.sh, gateway/, browser/, muse-linux/). Rebuild
`openmausbot-desktop` only when `../desktop/` changes.

## Binaries (git-ignored, on the build host only)

| Path (under `deploy/local/`) | Contents | Source |
|---|---|---|
| `muse-linux/` | Muse Code Linux install: `muse` launcher, `muse-bin-<version>`, `.muse-version` | copy from a working Linux install of the same version |
| `gateway/bin/wacli` | WhatsApp CLI binary (~27 MB) | old box `/home/box/bin/wacli` (same version as the `bin/*.sh` scripts) |
| `gateway/signal-bin/signal-cli` | Signal CLI binary (~372 MB) | old box `/home/box/signal/bin/signal-cli` |

## SSH key for git self-update

Compose mounts the host's `%USERPROFILE%\.ssh` read-only at `/mnt/host-ssh`;
`repo-start.sh` copies the first private key (`id_ed25519`, `id_ecdsa`,
`id_rsa`) to `/data/.ssh` with mode 0600 and exports `GIT_SSH_COMMAND` for
the server. Requirements:

- A passphrase-less private key with GitHub access (`ssh -T git@github.com`
  works from the host). If a new key is generated, its `.pub` must be added
  to GitHub before the bot can push.
- `BatchMode=yes` is set: a passphrase-protected key fails fast instead of
  hanging the boot.

## Notes

- The server runs as root: the repo is a Windows bind mount, so a non-root
  user cannot reliably write build outputs. Container-only; the bot already
  runs Full-access inside.
- `node_modules` lives on the `omb-node-modules` volume (pnpm symlinks
  cannot live on the Windows mount). Build outputs (`dist/`,
  `dist-server/`) stay in the host checkout.
- The whole checkout -- including `.env` -- is visible inside the container
  at `/src`. Same trust as the gateway secrets already there.
- `OMB_BASE_IMAGE` in `.env` is now unused (kept for history).
