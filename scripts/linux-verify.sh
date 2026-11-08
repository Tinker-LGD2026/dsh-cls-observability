#!/usr/bin/env bash
# DEV ONLY. Run the test suite and real end-to-end scenarios on Linux, in a container,
# against the published DeepSeek Harness build (npm @deepseek-ai/dsh) installed there.
#
#   scripts/linux-verify.sh [test] [e2e] [ptc] [web] [crash] [compaction] [sdk] [acp] [nested]
#   LINUX_PLATFORM=linux/amd64 scripts/linux-verify.sh ...   (x86_64, emulated on Apple silicon)
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

platform="${LINUX_PLATFORM:-}"
suffix=""
platform_args=()
npm_target=()
if [ -n "$platform" ]; then
  suffix="-${platform##*/}"
  platform_args=(--platform "$platform")
  # npm under qemu emulation silently leaves packages half-extracted: install natively,
  # fetching the target's native packages, and only run under emulation.
  case "${platform##*/}" in
    amd64) npm_cpu=x64 ;;
    arm64) npm_cpu=arm64 ;;
    *) npm_cpu="${platform##*/}" ;;
  esac
  # Install scripts run on the target in the rebuild step below.
  npm_target=(-e "npm_config_cpu=$npm_cpu" -e npm_config_os=linux -e npm_config_libc=glibc -e npm_config_ignore_scripts=true)
fi
docker volume create "dshcls-linux-dsh$suffix" >/dev/null
docker volume create "dshcls-linux-nm$suffix" >/dev/null
docker volume create "dshcls-linux-sdk$suffix" >/dev/null

# Install phase (native architecture): DSH from npm and the plugin's dependencies.
docker run --rm \
  -v "$here:/src:ro" \
  -v "dshcls-linux-dsh$suffix:/opt/dsh" \
  -v "dshcls-linux-nm$suffix:/work/plugin/node_modules" \
  -v "dshcls-linux-sdk$suffix:/work/sdk" \
  ${npm_target[@]+"${npm_target[@]}"} \
  -e DSH_VERSION="$dsh_version" \
  -w /work/plugin \
  "$image" bash -c '
set -euo pipefail
if [ "$(node -p "require(\"/opt/dsh/node_modules/@deepseek-ai/dsh/package.json\").version" 2>/dev/null)" != "$DSH_VERSION" ]; then
  rm -rf /opt/dsh/node_modules /opt/dsh/package-lock.json
  (cd /opt/dsh && echo "{\"name\":\"dsh-linux\",\"private\":true}" > package.json && npm install --no-audit --no-fund "@deepseek-ai/dsh@$DSH_VERSION" >/dev/null)
fi
cp /src/package.json /src/package-lock.json .
npm ci --no-audit --no-fund >/dev/null
# The published SDK client as a customer program installs it (it brings its own same-version DSH).
if [ "$(node -p "require(\"/work/sdk/node_modules/@deepseek-ai/dsh-sdk-client/package.json\").version" 2>/dev/null)" != "$DSH_VERSION" ]; then
  rm -rf /work/sdk/node_modules /work/sdk/package-lock.json
  (cd /work/sdk && echo "{\"name\":\"sdk-consumer\",\"private\":true}" > package.json && npm install --no-audit --no-fund "@deepseek-ai/dsh-sdk-client@$DSH_VERSION" >/dev/null)
fi
echo "== installed dsh $DSH_VERSION and plugin dependencies${npm_config_cpu:+ for linux/$npm_config_cpu}"
[ -n "${npm_config_cpu:-}" ] && touch /opt/dsh/.needs-rebuild /work/sdk/.needs-rebuild node_modules/.needs-rebuild
true
'

# Cross-architecture installs: run the packages' install scripts on the target once.
if [ -n "$platform" ]; then
  docker run --rm "${platform_args[@]}" \
    -v "dshcls-linux-dsh$suffix:/opt/dsh" \
    -v "dshcls-linux-nm$suffix:/work/plugin/node_modules" \
    -v "dshcls-linux-sdk$suffix:/work/sdk" \
    -v "$here:/src:ro" \
    -w /work/plugin \
    "$image" bash -c '
set -euo pipefail
for dir in /opt/dsh /work/sdk /work/plugin; do
  marker="$dir/.needs-rebuild"; [ "$dir" = /work/plugin ] && marker=node_modules/.needs-rebuild
  [ -f "$marker" ] || continue
  [ "$dir" = /work/plugin ] && cp /src/package.json /src/package-lock.json .
  (cd "$dir" && npm rebuild >/dev/null) && rm -f "$marker"
  echo "== rebuilt native packages in $dir for $(uname -m)"
done
'
fi

docker run --rm --init ${platform_args[@]+"${platform_args[@]}"} \
  -v "$here:/src:ro" \
  -v "$dsh_repo:/dsh:ro" \
  -v "dshcls-linux-dsh$suffix:/opt/dsh" \
  -v "dshcls-linux-nm$suffix:/work/plugin/node_modules" \
  -v "dshcls-linux-sdk$suffix:/work/sdk" \
  ${secrets_mount[@]+"${secrets_mount[@]}"} \
  -e DSH_REPO=/dsh \
  -e DSH_SESSION_LIB=/opt/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js \
  -e DSH_BIN=/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  -e STEPS="$steps" -e DSH_VERSION="$dsh_version" -e LINUX_EMULATED="${platform:+1}" \
  -w /work/plugin \
  "$image" bash -c '
set -uo pipefail
echo "== $(uname -sm), node $(node -v)"
echo "== dsh $(node -p "require(\"/opt/dsh/node_modules/@deepseek-ai/dsh/package.json\").version")"
(cd /src && tar --exclude=./node_modules --exclude=./.tmp --exclude=./dist --exclude=./.git -cf - .) | tar -xf -
node scripts/build.mjs | tail -1
status=0
for step in $STEPS; do
  echo; echo "===== $step"
  case "$step" in
    # Unit tests are architecture-independent JavaScript; under qemu the esbuild service that
    # vitest relies on crashes, so emulated platforms skip them (CI runs them natively on x86_64).
    test)
      if [ -n "${LINUX_EMULATED:-}" ]; then echo "skipped under emulation (esbuild is unreliable on qemu)"; true
      else npx vitest run 2>&1 | grep -E "Test Files|Tests |FAIL|×|Error"; fi ;;
    e2e) node scripts/e2e.ts ;;
    ptc) node scripts/e2e.ts --ptc --task "Use run_code to call your bash tool twice (echo ptc-one, echo ptc-two), then delegate to a subagent the task '"'"'Reply with the word subagent-ok'"'"'. Answer with all outputs." ;;
    web) node scripts/e2e-web.ts ;;
    crash) node scripts/e2e-crash.ts ;;
    compaction) node scripts/e2e.ts --compaction ;;
    nested) node scripts/e2e.ts --nested ;;
    acp) node scripts/e2e-acp.ts ;;
    sdk|sdk-minimal)
      SDK_CLIENT=/work/sdk/node_modules/@deepseek-ai/dsh-sdk-client SDK_PROFILE="$step" node scripts/e2e-sdk.ts ;;
    *) echo "unknown step $step"; false ;;
  esac
  rc=${PIPESTATUS[0]}
  echo "===== $step exit=$rc"
  [ "$rc" -eq 0 ] || status=1
done
exit $status
'
