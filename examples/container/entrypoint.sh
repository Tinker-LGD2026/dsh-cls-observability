#!/usr/bin/env bash
# Example wrapper for environments that end together with DSH (a container, a CI job).
#
# Runs your command — DSH itself, or whatever starts it — as a child, forwards SIGTERM /
# SIGINT to it, and after it exits delivers what the plugin has not sent yet (`--flush`).
# Without this, the environment ends the moment its main process exits and the plugin's
# background deliverer ends with it; unsent spans then wait on disk for the next start
# on the same directory, or are lost if the directory goes too.
#
#   entrypoint.sh dsh --profile headless "run the tests"
#   entrypoint.sh /your/existing/entrypoint --your-flags
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
