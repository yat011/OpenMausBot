# Browser debugging runbook (OpenMausBot)

How the browser stack fits together, how to tell which layer is stuck, and
what bit us before (2026-09-27/28 tab-close + wedged-browser incidents).
Read this before restarting things blindly.

## Architecture (5 layers)

1. **Desktop sidecar Chrome** — real Chrome with remote debugging, served by the
   `desktop` container, CDP on `127.0.0.1:9229` inside the shared `desktop`
   network namespace (all of `omb`, `desktop`, `caddy` share one netns).
   Source of truth for tabs. `GET /json/list` shows live targets.
2. **Daemon** (`agent-browser` 0.37.0, vendored in `deploy/local/browser/`) —
   skills CLI in `~/skills/agent-browser/` inside `omb`. Owns daemon
   sessions (`~/.agent-browser/sessions/<name>/`), each attached to sidecar
   Chrome. Tabs get daemon ids (`t1`, `t2`, …). **Daemon tab ids die with the
   tab and are NEVER reused** — a new tab always gets the next higher id.
3. **Wrapper** (`deploy/local/browser/agent-browser-omb`) — bash shim around
   the daemon that exports `AGENT_BROWSER_CDP` (and other env), retries
   `session attach` for ~30s, and routes `session …` subcommands.
4. **Server** (`server/browser-runtime.ts`) — spawns the wrapper via
   `execFile` with a 30s timeout, appends `--json --no-webmcp` and parses JSON stdout. Owns
   ownership/hold semantics (take-control/restart gating).
5. **Panel** (`src/components/BrowserPanel.tsx`) — SSE stream
   (`pacing=ack`: server only sends the next frame after the client ACKs),
   click/drag/take-control buttons.

## Golden signals (in order)

| # | Check | Command (from repo root, Windows) | Healthy |
|---|-------|-----------------------------------|---------|
| 1 | Sidecar Chrome alive | `docker compose exec omb node -e "fetch('http://127.0.0.1:9229/json/version').then(r=>r.text()).then(t=>console.log(t.slice(0,120)))"` | returns `Browser:` + `webSocketDebuggerUrl` in <1s |
| 2 | Sidecar tabs | same with `/json/list`, count `"type": "page"` | matches what you expect to see |
| 3 | Daemon session alive | `docker compose exec omb agent-browser-omb --session omb-live session info --json` | `success:true` (`active:true` once a session is attached) |
| 4 | omb server healthy | `docker compose ps` | `omb … healthy` |
| 5 | Server view | browser panel stream | connects, tab ids match `tab list` |

If 1 fails but the containers are up → sidecar Chrome itself wedged
(restart `desktop`, or full down/up). If 1 passes but 3 fails → daemon
session detached/crashed (server restart flow should recover). If 3 passes
but 5 shows stale → server/panel state is stale (reconnect view).

## Copy-paste commands

```powershell
# full restart (ALWAYS all services together — never `up -d omb` alone,
# omb/desktop/caddy share a network namespace and a lone recreate strands it)
docker compose down
docker compose up -d --build

# health + versions
docker compose ps
docker compose exec omb agent-browser-omb --version

# daemon session state / tabs / close a tab (real sidecar!)
docker compose exec omb agent-browser-omb --session omb-live session info --json
docker compose exec omb agent-browser-omb --session omb-live tab list --json
docker compose exec omb agent-browser-omb --session omb-live tab close t3 --json

# watch server-side browser operations live
docker compose logs -f omb | Select-String "browser"
```

## Lessons learnt (incidents 2026-09-27/28)

### 1. Wrapper must match the subcommand, not any arg (`agent-browser-omb`)

The old wrapper classified a call as session-management when **any**
argument matched `close|session|quit|exit`. A call like
`tab close --session omb-live …` contains `close`, so the call was exec'd
**without** `--cdp` and the sidecar env: detached from the sidecar Chrome.
The daemon then reported `not_found` for tabs `tab list` had just shown,
and every tab close "worked" (exit 0) yet closed nothing.
**Fix:** match only `$1`; `tab …` is a page command and always attaches.
**Test:** `server/browser-live-daemon-flags.test.ts` asserts the argv shape.

### 2. Stale daemon tab ids must REFUSE, never latch (`browser-live.ts`)

(The daemon documents this itself in `tab --help`: "An id is never reused
within a session"; only CDP target ids stay stable across daemon restarts.)

Daemon ids are never reused, so a "tab not found" for `t3` while live tabs
are `t5,t6` means the panel/session state is stale — not that the tab needs
looking up. The old code latched an "uncertain" flag and blocked every later
tab op (browser looked completely stuck, refresh didn't help because the
latch was server-side).
**Fix:** refuse with `tab_stale` + live id list, no latch, no state change.
Panel shows "tab list changed, refresh tabs" instead of wedging.

### 3. Uncertain latch needs an escape hatch (`browser-runtime.ts`)

Any latch that survives its owner wedges the browser for everyone (human +
agent). Restart is now allowed to bypass an abandoned uncertain hold when
the owner has been quiet 60s (`RESTART_QUIET_MS`), then clears it. Same
principle applies to any future hold/latch: **timeout + bypass + clear**.

### 4. Never `up -d omb` / recreate omb alone

`omb`, `desktop`, `caddy` share one network namespace
(`network_mode: service:desktop`-style wiring). Recreating only `omb`
strands its view of `127.0.0.1:9229` even though Chrome is fine → every tab
op fails with `not_found`/connection errors that look like daemon bugs.
**Always** `down` then `up -d` the whole stack.

### 5. Test the wrapper the way node calls it

`execFile` runs the wrapper with **no shell**, a 30s timeout, and empty
stdout on kill. Debugging traps we hit:
- Passing `-e AGENT_BROWSER_CDP=…` (or any env) on a manual `docker exec`
  **overrides/sets what the wrapper itself exports** and can mask a wrapper
  env bug — reproduce with a bare env first.
- `curl /json` (no `/list`) returns `{"error":…}`-ish junk, not targets;
  always use `/json/list`.
- Wrapper `session attach` retry loop is ~30s; node kills at 30s. Empty
  stdout + empty stderr + exit 0/killed ⇒ the wrapper was still retrying
  when node gave up, not a daemon failure.
- `session info --json` is the cheapest daemon probe (daemon-local, no
  sidecar round-trip); `tab list --json` proves the sidecar attach by
  enumerating live tabs.

### 6. Screencast frames: pacing=ack + viewers

- `BrowserFrameBroadcaster` only advances when the panel ACKs each frame.
  A panel that stops ACKing (tab hidden, SSE dropped) looks like a frozen
  view while the daemon is fine → "Reconnect view" re-subscribes; viewers
  that never ACK are reaped after `VIEWER_STALE_MS`.
- Static tabs (about:blank, finished pages) send no new frames; "no frames"
  ≠ stuck. Cross-check with `tab list --json` before restarting.
- `stream.enabled` (API) vs `screencasting` (daemon) are different flags;
  the panel derives its banner from the combination — check both.

### 7. Proof scripts live outside the repo

`C:/tmp/prove-*.mts` + `run-prove.ps1` are the live-daemon proof harness
(real sidecar, port-forwarded CDP). They intentionally live in `/tmp`, not
the repo. Re-run before/after any daemon/wrapper/server change touching
tabs, sessions, or restart.

## "Browser completely stuck" checklist

1. Signals 1–3 above: find the lowest failing layer.
2. If daemon detached but Chrome alive: panel **Restart browser** (bypasses
   abandoned holds after 60s quiet) — do NOT hammer it; one click, then
   watch `logs -f omb`.
3. If Chrome itself dead: full `down` + `up -d` (see §4).
4. If server healthy but panel stale: refresh page, **Reconnect view**, then
   compare panel tab ids vs `tab list` — mismatched ids mean stale panel
   state (`tab_stale`), not a stuck browser.
5. Still stuck: capture `session info --json`, `tab list --json`, `/json/list`, and the last
   50 `omb` log lines mentioning `browser`, then look at §1–§6 before
   changing code.
