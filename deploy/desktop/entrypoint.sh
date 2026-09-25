#!/usr/bin/env bash
# Xvfb :7 + xfwm4 + x11vnc/noVNC + headed Google Chrome with remote CDP.
# CDP listens on all interfaces so the omb container can attach; compose must
# NOT publish 9229 to the host. noVNC (6901) is for a person to watch.
set -euo pipefail

RESOLUTION="${DESKTOP_RESOLUTION:-1920x1080x24}"
CDP_PORT="${DESKTOP_CDP_PORT:-9229}"
VNC_PORT="${DESKTOP_VNC_PORT:-5999}"
NOVNC_PORT="${DESKTOP_NOVNC_PORT:-6901}"
PROFILE="${CHROME_PROFILE:-/profile}"

mkdir -p /tmp/.X11-unix "$PROFILE"
chmod 1777 /tmp/.X11-unix

# /tmp survives `docker restart` (the writable layer is kept). Xvfb then
# reads the previous lock, finds that PID reused by a new process, and
# refuses display :7. This container owns :7 and nothing is serving it yet.
rm -f /tmp/.X7-lock /tmp/.X11-unix/X7

cleanup() {
  kill "${CHROME_PID:-}" "${NOVNC_PID:-}" "${VNC_PID:-}" "${WM_PID:-}" "${XVFB_PID:-}" 2>/dev/null || true
}
trap cleanup TERM INT

export DBUS_SESSION_BUS_ADDRESS
DBUS_SESSION_BUS_ADDRESS="$(dbus-daemon --session --fork --print-address)"

Xvfb :7 -screen 0 "$RESOLUTION" +extension RANDR &
XVFB_PID=$!
sleep 1

xfwm4 --display=:7 &
WM_PID=$!

x11vnc -display :7 -rfbport "$VNC_PORT" -localhost -shared -forever -nopw \
  -ncache 10 -ncache_cr -quiet &
VNC_PID=$!

websockify --web /usr/share/novnc "$NOVNC_PORT" "localhost:$VNC_PORT" &
NOVNC_PID=$!

google-chrome \
  --display=:7 \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port="$CDP_PORT" \
  --remote-allow-origins='*' \
  --user-data-dir="$PROFILE" \
  --no-sandbox --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check \
  --disable-session-crashed-bubble --password-store=basic \
  --window-size=1920,1080 --start-maximized \
  about:blank &
CHROME_PID=$!

wait "$CHROME_PID"
