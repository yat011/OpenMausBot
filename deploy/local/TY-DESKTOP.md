# ty-desktop local deploy (fork addition)

`compose.yaml` + `compose.override.yaml` build the `omb` service from this
directory. Besides the committed files, the build context needs three
binary sets placed on the build host (ty-desktop). They are git-ignored on
purpose: large, platform-specific, and already versioned elsewhere.

| Path (under `deploy/local/`) | Contents | Source |
|---|---|---|
| `muse-linux/` | Muse Code Linux install: `muse` launcher, `muse-bin-<version>`, `.muse-version` | copy from a working Linux install of the same version |
| `gateway/bin/wacli` | WhatsApp CLI binary (~27 MB) | old box `/home/box/bin/wacli` (same version as the `bin/*.sh` scripts) |
| `gateway/signal-bin/signal-cli` | Signal CLI binary (~372 MB) | old box `/home/box/signal/bin/signal-cli` |

Everything else the Dockerfile copies (`Dockerfile`, `gateway/*.sh`,
`gateway/bin/*` except `wacli`, `gateway/signal-bridge/*`, `browser/*`) is
committed text. `.env` (secrets, URLs) lives only on ty-desktop and is also
ignored (see `/.env` in `.gitignore`).

The headed-browser sidecar lives in `../desktop/` (built from its own
context) and needs no host binaries.
