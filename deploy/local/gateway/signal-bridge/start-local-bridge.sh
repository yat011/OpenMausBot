#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/box/signal
export PATH="/home/box/bin:$PATH"
export LD_LIBRARY_PATH="/usr/lib/jvm/java-21-openjdk-amd64/lib/server:/usr/lib/jvm/java-21-openjdk-amd64/lib:${LD_LIBRARY_PATH:-}"
export _JAVA_OPTIONS="${_JAVA_OPTIONS:--Djava.awt.headless=true}"
mkdir -p "$ROOT/logs" "$ROOT/inbox-spool/done"

alive() {
  local pidfile="$1"
  [[ -f "$pidfile" ]] || return 1
  local pid
  pid=$(cat "$pidfile" 2>/dev/null || true)
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

# Daemon
if ! alive "$ROOT/logs/daemon.pid" || [[ ! -S "$ROOT/signal.sock" ]]; then
  # stop stale
  if [[ -f "$ROOT/logs/daemon.pid" ]]; then
    kill "$(cat "$ROOT/logs/daemon.pid")" 2>/dev/null || true
  fi
  # avoid pgrep false-positives from our own cmdline
  for pid in $(ps -eo pid=,args= | awk '/\/home\/box\/signal\/bin\/signal-cli/ && /daemon/ {print $1}'); do
    kill "$pid" 2>/dev/null || true
  done
  rm -f "$ROOT/signal.sock" 2>/dev/null || true
  nohup env LD_LIBRARY_PATH="$LD_LIBRARY_PATH" _JAVA_OPTIONS="$_JAVA_OPTIONS" \
    /home/box/bin/signal-cli -a +85295030073 daemon \
    --socket="$ROOT/signal.sock" --receive-mode=on-start --no-receive-stdout \
    >> "$ROOT/logs/daemon.log" 2>&1 &
  echo $! > "$ROOT/logs/daemon.pid"
  sleep 3
fi

# Legacy webhook + prior bridges
for pid in $(ps -eo pid=,args= | awk '/signal_webhook_bridge\.py/ {print $1}'); do
  kill "$pid" 2>/dev/null || true
done
for pid in $(ps -eo pid=,args= | awk '/signal_local_gateway_bridge\.py/ {print $1}'); do
  kill "$pid" 2>/dev/null || true
done
sleep 1

BRIDGE="$ROOT/bridge/signal_local_gateway_bridge.py"
if command -v setsid >/dev/null 2>&1; then
  setsid -f env LD_LIBRARY_PATH="$LD_LIBRARY_PATH" python3 "$BRIDGE" >> "$ROOT/logs/bridge.log" 2>&1
  sleep 0.8
  pid=$(ps -eo pid=,args= | awk '/signal_local_gateway_bridge\.py/ {print $1; exit}')
else
  nohup env LD_LIBRARY_PATH="$LD_LIBRARY_PATH" python3 "$BRIDGE" >> "$ROOT/logs/bridge.log" 2>&1 &
  pid=$!
fi
if [[ -z "${pid:-}" ]]; then
  echo "failed to start local gateway bridge" >&2
  exit 1
fi
echo "$pid" > "$ROOT/logs/bridge.pid"
echo "local-gateway bridge pid=$pid daemon_pid=$(cat "$ROOT/logs/daemon.pid")"

# Ensure standing watchdog-daemon is up (unless called FROM the daemon)
ensure_watchdog_daemon() {
  [[ "${SIGNAL_WATCHDOG_SKIP_DAEMON_ENSURE:-0}" == "1" ]] && return 0
  local pidfile="${SIGNAL_WATCHDOG_PIDFILE:-$ROOT/logs/watchdog-daemon.pid}"
  local daemon="$HOME/bin/signal-watchdog-daemon"
  local log="$HOME/logs/signal-watchdog-daemon.log"
  [[ -x "$daemon" ]] || return 0
  if [[ -f "$pidfile" ]]; then
    local pid
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      if [[ -r "/proc/$pid/cmdline" ]] && tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'signal-watchdog-daemon'; then
        echo "watchdog-daemon already running pid $pid"
        return 0
      fi
    fi
  fi
  nohup "$daemon" >>"$log" 2>&1 &
  disown 2>/dev/null || true
  sleep 0.3
  echo "started watchdog-daemon (ensure)"
}
ensure_watchdog_daemon
