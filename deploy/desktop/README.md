# Desktop sidecar (GUI + Chrome)

Headed browsing for the `omb` service: Xvfb + xfwm4 + x11vnc/noVNC + Google
Chrome, mirroring the old box's headed setup (`DISPLAY :7`, CDP `9229`).

## Wiring

- `desktop` exposes CDP inside the compose network only (`9229` is NOT
  published to the host). `omb` reaches it as `http://desktop:9229`.
- `omb` sets `OMB_AGENT_BROWSER_PATH=/usr/local/bin/agent-browser-omb`; that
  wrapper injects `--cdp http://desktop:9229` into every agent-browser call
  except session management (`close`/`session`/`quit`/`exit`), so `close --all`
  can never kill the shared Chrome. When CDP is down it falls back to the
  bundled Chromium.
- Chrome's profile persists in the `chrome-profile` volume (logins survive
  rebuilds). VNC stays localhost-only inside this container.
- `127.0.0.1:6901` on the Docker host serves the noVNC viewer (watch only, no
  password on loopback).

## Verify

```sh
docker compose exec omb python3 -c 'import urllib.request; print(urllib.request.urlopen("http://desktop:9229/json/version", timeout=5).status)'
docker compose exec omb /usr/local/bin/agent-browser-omb open example.com
docker compose exec omb /usr/local/bin/agent-browser-omb snapshot
```

Then open `http://127.0.0.1:6901` on the Docker host and confirm the page is
visible in the headed Chrome.

## Notes

- Chrome runs `--no-sandbox` (standard for containerized Chrome; CDP is only
  reachable from the `omb` container).
- `google-chrome-stable` is unpinned: a rebuild picks up the latest stable.
- Env overrides (non-default ports/resolution): `DESKTOP_RESOLUTION`,
  `DESKTOP_CDP_PORT`, `DESKTOP_VNC_PORT`, `DESKTOP_NOVNC_PORT`, `CHROME_PROFILE`.
