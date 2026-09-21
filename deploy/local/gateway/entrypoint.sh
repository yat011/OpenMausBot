#!/bin/sh
# Container entrypoint: install gateway code into /data, start WA/SG
# gateways via the original start scripts, then exec the server.
# Gateway failures must never stop the server.
set -u
mkdir -p /data/logs
if [ -x /opt/gateway/gateway-init.sh ]; then
  /opt/gateway/gateway-init.sh >>/data/logs/gateway-init.log 2>&1 || true
fi
export HOME=/data
export PATH="/home/box/bin:$PATH"
if [ -x /home/box/bin/wacli-sync-start ]; then
  /home/box/bin/wacli-sync-start >>/data/logs/gateway-init.log 2>&1 || true
fi
if [ -x /home/box/signal/bridge/start-local-bridge.sh ]; then
  /home/box/signal/bridge/start-local-bridge.sh >>/data/logs/gateway-init.log 2>&1 || true
fi
exec "$@"
