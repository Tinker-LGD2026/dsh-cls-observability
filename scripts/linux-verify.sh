#!/usr/bin/env bash
# DEV ONLY. Run the test suite and real end-to-end scenarios on Linux, in a container,
# against the published DeepSeek Harness build (npm @deepseek-ai/dsh) installed there.
#
#   scripts/linux-verify.sh [test] [e2e] [ptc] [web] [crash] [compaction]
#
# Needs: docker; a DSH source checkout (DSH_REPO, default ../deepseek-harness) for the
# session recordings; AGENTOBS_DEV_SECRETS_FILE for the scenarios that talk to CLS.
# The secrets file is mounted read-only and only read inside the container.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
dsh_repo="$(cd "${DSH_REPO:-$here/../deepseek-harness}" && pwd)"
image="${LINUX_IMAGE:-node:24-bookworm}"
dsh_version="${DSH_VERSION:-0.2.2-rc.1}"
steps="${*:-test}"

secrets_mount=()
if [ -n "${AGENTOBS_DEV_SECRETS_FILE:-}" ]; then
  secrets_mount=(-v "$(cd "$(dirname "$AGENTOBS_DEV_SECRETS_FILE")" && pwd)/$(basename "$AGENTOBS_DEV_SECRETS_FILE"):/secrets/dev.md:ro" -e AGENTOBS_DEV_SECRETS_FILE=/secrets/dev.md)
fi

docker volume create dshcls-linux-dsh >/dev/null
docker volume create dshcls-linux-nm >/dev/null

docker run --rm --init \
  -v "$here:/src:ro" \
  -v "$dsh_repo:/dsh:ro" \
  -v dshcls-linux-dsh:/opt/dsh \
  -v dshcls-linux-nm:/work/plugin/node_modules \
  ${secrets_mount[@]+"${secrets_mount[@]}"} \
  -e DSH_REPO=/dsh \
  -e DSH_SESSION_LIB=/opt/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js \
  -e DSH_BIN=/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  -e STEPS="$steps" -e DSH_VERSION="$dsh_version" \
  -w /work/plugin \
  "$image" bash -c '
set -uo pipefail
echo "== $(uname -sm), node $(node -v)"
if [ "$(node -p "require(\"/opt/dsh/node_modules/@deepseek-ai/dsh/package.json\").version" 2>/dev/null)" != "$DSH_VERSION" ]; then
  (cd /opt/dsh && echo "{\"name\":\"dsh-linux\",\"private\":true}" > package.json && npm install --no-audit --no-fund "@deepseek-ai/dsh@$DSH_VERSION" >/dev/null)
fi
echo "== dsh $(node -p "require(\"/opt/dsh/node_modules/@deepseek-ai/dsh/package.json\").version")"
(cd /src && tar --exclude=./node_modules --exclude=./.tmp --exclude=./dist --exclude=./.git -cf - .) | tar -xf -
npm ci --no-audit --no-fund >/dev/null 2>&1 || { echo "npm ci failed"; exit 1; }
node scripts/build.mjs | tail -1
status=0
for step in $STEPS; do
  echo; echo "===== $step"
  case "$step" in
    test) npx vitest run 2>&1 | grep -E "Test Files|Tests |FAIL|×" ;;
    e2e) node scripts/e2e.ts ;;
    ptc) node scripts/e2e.ts --ptc --task "Use run_code to call your bash tool twice (echo ptc-one, echo ptc-two), then delegate to a subagent the task '"'"'Reply with the word subagent-ok'"'"'. Answer with all outputs." ;;
    web) node scripts/e2e-web.ts ;;
    crash) node scripts/e2e-crash.ts ;;
    compaction) node scripts/e2e.ts --compaction ;;
    *) echo "unknown step $step"; false ;;
  esac
  rc=${PIPESTATUS[0]}
  echo "===== $step exit=$rc"
  [ "$rc" -eq 0 ] || status=1
done
exit $status
'
