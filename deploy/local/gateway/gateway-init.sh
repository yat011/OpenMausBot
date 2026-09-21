#!/bin/sh
# Copy versioned gateway code from the image into the data volume.
# Idempotent: only missing or size-changed files are replaced. Data dirs
# are created but never touched.
set -u
SRC=/opt/gateway
mkdir -p /data/bin /data/logs /data/.config/wacli /data/signal/bin /data/signal/bridge /data/signal/logs /data/signal/config /data/signal/inbox-spool/done
rm -f /data/.config/wacli/watchdog-daemon.pid /data/signal/logs/watchdog-daemon.pid /data/signal/logs/daemon.pid /data/signal/logs/bridge.pid /data/signal/signal.sock
sync_file() {
  if [ ! -f "$2" ] || [ "$(wc -c <"$1")" != "$(wc -c <"$2")" ]; then
    cp "$1" "$2"
    echo "installed $2"
  fi
}
for f in "$SRC"/bin/*; do
  sync_file "$f" "/data/bin/$(basename "$f")"
done
chmod +x /data/bin/* 2>/dev/null || true
sync_file "$SRC/signal-bin/signal-cli" /data/signal/bin/signal-cli
chmod +x /data/signal/bin/signal-cli || true
for f in "$SRC"/signal-bridge/*; do
  sync_file "$f" "/data/signal/bridge/$(basename "$f")"
done
chmod +x /data/signal/bridge/*.sh 2>/dev/null || true
echo "gateway-init done"
