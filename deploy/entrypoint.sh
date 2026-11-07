#!/usr/bin/env bash
# Container entrypoint for DeepSeek Harness with dsh-cls-observability.
#
# Runs DSH as a child, forwards SIGTERM / SIGINT to it, and after DSH exits delivers
# whatever is still in the outbox (`--flush`) before the container stops. Without
# this, a container ends the moment DSH exits and the plugin's detached deliverer is
# killed with it; anything undelivered would wait for the next start on the same volume.
#
#   entrypoint.sh dsh --profile headless "run the tests"
#
# Environment:
#   AGENTOBS_PLUGIN        plugin file (default /opt/dsh-cls-observability/dsh-cls-observability.mjs)
#   AGENTOBS_FLUSH_TIMEOUT seconds allowed for the final flush (default 30)
#   CLS_AGENTOBS_*         the plugin configuration (same variables DSH sees)
set -u

plugin="${AGENTOBS_PLUGIN:-/opt/dsh-cls-observability/dsh-cls-observability.mjs}"
flush_timeout="${AGENTOBS_FLUSH_TIMEOUT:-30}"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

"$@" &
child=$!

# shellcheck disable=SC2329 # invoked through the traps below
forward() {
  kill -s "$1" "$child" 2>/dev/null
}
trap 'forward TERM' TERM
trap 'forward INT' INT

# `wait` returns early when a trapped signal arrives; keep waiting until DSH is gone.
status=0
while kill -0 "$child" 2>/dev/null; do
  wait "$child"
  status=$?
done
trap - TERM INT

if [ "${CLS_AGENTOBS_ENABLED:-}" = "true" ] && [ -f "$plugin" ]; then
  # Best effort: never turn a successful DSH run into a failed container.
  if command -v timeout >/dev/null 2>&1; then
    timeout "$flush_timeout" node "$plugin" --flush >&2
  else
    node "$plugin" --flush >&2
  fi || echo "[entrypoint] flush incomplete; undelivered spans stay in the outbox" >&2
fi

exit "$status"
