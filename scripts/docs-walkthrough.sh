#!/usr/bin/env bash
# DEV ONLY. Runs inside a fresh node:24-bookworm container (see docs-walkthrough.ts):
# DSH on PATH, the plugin package tarball in /pkg, and only the commands of the README.
set -uo pipefail
export PATH=/opt/dsh/node_modules/.bin:$PATH
step() { echo; echo "##### $*"; }
fail=0
check() { if "$@"; then echo "ok: $*"; else echo "FAILED: $*"; fail=1; fi; }

step "Install: npm install, copy the file, check the sha256 (README: Install)"
mkdir -p /tmp/get && cd /tmp/get && npm install --no-audit --no-fund /pkg/dsh-cls-observability-*.tgz >/dev/null 2>&1
mkdir -p /opt/dsh-cls-observability
cp node_modules/dsh-cls-observability/dist/dsh-cls-observability.mjs node_modules/dsh-cls-observability/dist/dsh-cls-observability.mjs.sha256 /opt/dsh-cls-observability/
check bash -c 'cd /opt/dsh-cls-observability && sha256sum -c dsh-cls-observability.mjs.sha256'

step "Enable 1: home patch (README: Enable)"
export DSH_HOME=/root/.dsh
mkdir -p "$DSH_HOME"
cat > "$DSH_HOME/cordis.patch.yml" <<'YAML'
- insert:
    - id: cls-agentobs
      name: /opt/dsh-cls-observability/dsh-cls-observability.mjs
YAML

step "Enable 2: environment"
export CLS_AGENTOBS_ENABLED=true CLS_AGENTOBS_REGION="$WALK_REGION" CLS_AGENTOBS_TOPIC_ID="$WALK_TOPIC"
export CLS_AGENTOBS_CUSTOM_ATTRIBUTES="walkthrough=$WALK_RUN" CLS_AGENTOBS_ENVIRONMENT=dev

step "Enable 3: selftest"
check node /opt/dsh-cls-observability/dsh-cls-observability.mjs --selftest

step "Enable 4: dsh headless"
mkdir -p /work && cd /work || exit 1
check dsh headless "Reply with the single word: walkthrough-headless"

step "web: start with the plugin, debug on, see it enabled"
( CLS_AGENTOBS_DEBUG=true dsh web --no-open --port 18090 > /tmp/web.log 2>&1 & echo $! > /tmp/web.pid )
for _ in $(seq 1 60); do grep -q "dsh web:" /tmp/web.log && break; sleep 1; done
check grep -q "\[cls-agentobs\].*enabled" /tmp/web.log
kill -INT "$(cat /tmp/web.pid)"; sleep 6

step "SDK: the README snippet in a program"
mkdir -p /tmp/sdkapp && cd /tmp/sdkapp || exit 1
ln -s /work/sdk/node_modules node_modules
cat > app.mjs <<'JS'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
const harness = new DeepSeekHarness({
  patches: ['/opt/dsh-cls-observability/agentobs.patch.yml'],
  env: { ...process.env, CLS_AGENTOBS_ENABLED: 'true', CLS_AGENTOBS_REGION: process.env.WALK_REGION, CLS_AGENTOBS_TOPIC_ID: process.env.WALK_TOPIC },
})
try {
  const r = await harness.run('Reply with the single word: walkthrough-sdk')
  console.log('sdk answer:', String(r.finalResponse).trim())
} finally { await harness.close() }
JS
# The README's SDK snippet references this file; create it as the README now tells.
printf -- '- insert:\n    - id: cls-agentobs\n      name: /opt/dsh-cls-observability/dsh-cls-observability.mjs\n' > /opt/dsh-cls-observability/agentobs.patch.yml
rm -f "$DSH_HOME/cordis.patch.yml"
check node app.mjs

step "Container entrypoint: dsh exits, the entrypoint flushes"
cp /pkg-deploy/entrypoint.sh /opt/dsh-cls-observability/entrypoint.sh && chmod +x /opt/dsh-cls-observability/entrypoint.sh
cd /work || exit 1
check /opt/dsh-cls-observability/entrypoint.sh dsh --profile headless --patch /opt/dsh-cls-observability/agentobs.patch.yml "Reply with the single word: walkthrough-entrypoint"
# shellcheck disable=SC2016 # expanded by the inner shell
check bash -c '[ -z "$(ls "$DSH_HOME/agentobs/outbox" 2>/dev/null | grep -E "otlp|wal")" ]'

echo; echo "WALKTHROUGH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
