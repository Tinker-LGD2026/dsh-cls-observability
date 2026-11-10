/**
 * DEV ONLY. Verify the Kubernetes deployment on a real cluster (e.g. TKE).
 *
 *   KUBECONFIG=… TKE_IMAGE_REPO=<registry>/<ns>/<repo> AGENTOBS_DEV_SECRETS_FILE=… \
 *     node scripts/tke-verify.ts image                      # build (linux/amd64) and push
 *     node scripts/tke-verify.ts run job|graceful|kill|relay|deployment
 *     node scripts/tke-verify.ts cleanup                    # delete everything created here
 *
 * The image is built the way examples/container/Dockerfile.snippet documents, on top of a plain
 * "existing DSH image". Each scenario runs real DSH tasks, then reads the spans back from
 * CLS and compares them with what the session logs left on the volume say was emitted:
 * nothing missing, nothing extra (auxiliary calls aside), no duplicates, empty outbox.
 *
 * Everything lives in TKE_NAMESPACE (default agentobs-test) and carries the label
 * agentobs-tke=1. Credentials reach the cluster only as a Secret applied from stdin; the
 * image pull secret (TKE_PULL_SECRET, default dsh) must already exist.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { searchSpans, type StoredSpan } from './cls-api.ts'
import { loadDevSecrets, type DevSecrets } from './dev-secrets.ts'
import { verifyRun } from './verify-cls.ts'
import { readSessionLog, replaySessionGroup } from '../src/replay.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ns = process.env.TKE_NAMESPACE ?? 'agentobs-test'
const pullSecret = process.env.TKE_PULL_SECRET ?? 'dsh'
const dshVersion = process.env.DSH_VERSION ?? '0.2.2-rc.1'
const LABEL = { 'agentobs-tke': '1' }
const PLUGIN = '/opt/dsh-cls-observability/dsh-cls-observability.mjs'
const PATCH = '/opt/dsh-cls-observability/agentobs.patch.yml'
/**
 * Pods have no usable sandbox backend for DSH's bash (no bwrap / Landlock there) and a
 * headless run has no approval channel, so every command would be refused. The container
 * is the isolation boundary: run commands unconfined, as a container deployment would.
 */
const SANDBOX_PATCH = '- id: sandbox-policy\n  config:\n    mode: danger-full-access\n- id: permission\n  config:\n    defaultPreset: danger-full-access\n'
const sandboxPatch = (scenario: string) => `${home(scenario)}/container.patch.yml`
/** The image's default command (Dockerfile.snippet) plus the container patch, then the app's arguments. */
const dsh = (scenario: string, profile: string, ...app: string[]) =>
  ['dsh', '--profile', profile, ...(profile === 'headless' ? ['--patch', PATCH] : []), '--patch', sandboxPatch(scenario), ...app]
const SHORT_TASK = 'Use the bash tool to run `echo tke-ok`, then reply with its output only.'
const LONG_TASK = 'Use the bash tool ten times, one call at a time, waiting for each result: first run `sleep 4; echo step-1`, then `sleep 4; echo step-2`, and so on up to `sleep 4; echo step-10`. Then reply "done".'
const STUCK_TASK = 'Run exactly one bash command and wait for it to finish: `sleep 150; echo finished`. Then reply "done".'
const MEDIUM_TASK = 'Use the bash tool three times, one call at a time: `sleep 3; echo a`, then `sleep 3; echo b`, then `sleep 3; echo c`. Then reply "done".'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`)

function imageTag(): string {
  const repo = process.env.TKE_IMAGE_REPO
  if (!repo) throw new Error('TKE_IMAGE_REPO is required')
  const sha = readFileSync(path.join(root, 'dist', 'dsh-cls-observability.mjs.sha256'), 'utf8').slice(0, 12)
  return `${repo}:${dshVersion}-agentobs-${sha}`
}

function kubectl(args: string[], input?: string, allowFail = false): string {
  const r = spawnSync('kubectl', ['-n', ns, ...args], { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0 && !allowFail) throw new Error(`kubectl ${args.join(' ')}: ${r.stderr.trim()}`)
  return r.stdout
}
const apply = (obj: unknown) => kubectl(['apply', '-f', '-'], JSON.stringify(obj))
const labelled = (name: string) => ({ name, labels: LABEL })

// ---------------------------------------------------------------- image

function buildImage(): void {
  const tag = imageTag()
  const ctx = path.join(root, '.tmp', 'tke-build')
  rmSync(ctx, { recursive: true, force: true })
  mkdirSync(ctx, { recursive: true })
  const pack = spawnSync('npm', ['pack', '--pack-destination', ctx, '--silent'], { cwd: root, encoding: 'utf8' })
  if (pack.status !== 0) throw new Error(`npm pack: ${pack.stderr}`)
  const tgz = readdirSync(ctx).find((f) => f.endsWith('.tgz'))!
  copyFileSync(path.join(root, 'examples', 'container', 'entrypoint.sh'), path.join(ctx, 'entrypoint.sh'))
  // A customer's existing DSH image: DSH installed with npm. Packages are fetched natively and
  // their install scripts run on the target (npm under qemu leaves packages half extracted).
  const base = `# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:24-bookworm AS fetch
ARG DSH_VERSION
RUN mkdir -p /opt/dsh && cd /opt/dsh && echo '{"name":"dsh","private":true}' > package.json \\
 && npm_config_cpu=x64 npm_config_os=linux npm_config_libc=glibc npm_config_ignore_scripts=true \\
    npm install --no-audit --no-fund "@deepseek-ai/dsh@$DSH_VERSION"
FROM node:24-bookworm
COPY --from=fetch /opt/dsh /opt/dsh
RUN cd /opt/dsh && npm rebuild
ENV PATH=/opt/dsh/node_modules/.bin:$PATH
RUN mkdir -p /work && chown 1000:1000 /work
WORKDIR /work
# Offline install of the plugin package, as Dockerfile.snippet describes.
COPY ${tgz} /tmp/
`
  writeFileSync(path.join(ctx, 'Dockerfile'), `${base}\n# ---- examples/container/Dockerfile.snippet, verbatim ----\n${readFileSync(path.join(root, 'examples', 'container', 'Dockerfile.snippet'), 'utf8')}\n# The customer's choice in this test image: the wrapper in front of the command.\nENTRYPOINT ["/opt/dsh-cls-observability/entrypoint.sh"]\n`)
  const sha = readFileSync(path.join(root, 'dist', 'dsh-cls-observability.mjs.sha256'), 'utf8').split(/\s+/)[0]!
  log(`building ${tag}`)
  const r = spawnSync('docker', ['buildx', 'build', '--platform', 'linux/amd64',
    '--build-arg', `DSH_VERSION=${dshVersion}`,
    '--build-arg', `AGENTOBS_PACKAGE=/tmp/${tgz}`,
    '--build-arg', `AGENTOBS_SHA256=${sha}`,
    '-t', tag, '--push', ctx], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('image build failed')
  log(`pushed ${tag}`)
}

// ---------------------------------------------------------------- manifests

function setup(secrets: DevSecrets): void {
  apply({
    apiVersion: 'v1', kind: 'Secret', metadata: labelled('agentobs-cls'), type: 'Opaque',
    stringData: { secretId: secrets.secretId, secretKey: secrets.secretKey, deepseekApiKey: secrets.deepseekApiKey ?? '' },
  })
  apply({
    apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: labelled('dsh-home'),
    spec: { accessModes: ['ReadWriteOnce'], storageClassName: process.env.TKE_STORAGE_CLASS ?? 'cbs', resources: { requests: { storage: '10Gi' } } },
  })
}

const home = (scenario: string) => `/data/${scenario}`

function envFor(secrets: DevSecrets, scenario: string, runId: string): unknown[] {
  const fromSecret = (name: string, key: string) => ({ name, valueFrom: { secretKeyRef: { name: 'agentobs-cls', key } } })
  return [
    { name: 'DSH_HOME', value: home(scenario) },
    { name: 'CLS_AGENTOBS_ENABLED', value: 'true' },
    { name: 'CLS_AGENTOBS_REGION', value: secrets.region },
    { name: 'CLS_AGENTOBS_NETWORK', value: 'internal' },
    { name: 'CLS_AGENTOBS_TOPIC_ID', value: secrets.topicId },
    fromSecret('TENCENTCLOUD_SECRET_ID', 'secretId'),
    fromSecret('TENCENTCLOUD_SECRET_KEY', 'secretKey'),
    fromSecret('DEEPSEEK_API_KEY', 'deepseekApiKey'),
    { name: 'CLS_AGENTOBS_ENVIRONMENT', value: 'tke-test' },
    { name: 'CLS_AGENTOBS_CUSTOM_ATTRIBUTES', value: `e2e_run=${runId}` },
    { name: 'CLS_AGENTOBS_DEBUG', value: 'true' },
  ]
}

interface PodOptions { scenario: string; runId: string; extraEnv?: Record<string, string>; args?: string[]; command?: string[]; node?: string; shareProcessNamespace?: boolean; relay?: boolean; plain?: boolean }

/** examples/kubernetes/dsh-agentobs.yaml's pod: home-patch init container, optional relay sidecar, the DSH container. */
function podSpec(secrets: DevSecrets, o: PodOptions): Record<string, unknown> {
  const image = imageTag()
  const env = [...envFor(secrets, o.scenario, o.runId), ...Object.entries(o.extraEnv ?? {}).map(([name, value]) => ({ name, value }))]
  const mounts = [{ name: 'dsh-home', mountPath: '/data' }]
  const h = home(o.scenario)
  return {
    restartPolicy: 'Never',
    terminationGracePeriodSeconds: 60,
    // OnRootMismatch: the default re-grants group rw on every file at each mount, and DSH then
    // refuses its own credentials file (mode 660).
    securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
    imagePullSecrets: [{ name: pullSecret }],
    ...(o.node ? { nodeSelector: { 'kubernetes.io/hostname': o.node } } : {}),
    ...(o.shareProcessNamespace ? { shareProcessNamespace: true } : {}),
    initContainers: o.plain ? [] : [
      { name: 'dsh-home-patch', image, command: ['/bin/sh', '-c'], args: [`mkdir -p ${h} && (test -f ${h}/cordis.patch.yml || cp ${PATCH} ${h}/cordis.patch.yml) && printf '%s' '${SANDBOX_PATCH}' > ${sandboxPatch(o.scenario)}`], volumeMounts: mounts },
      ...(o.relay ? [{ name: 'agentobs-relay', image, restartPolicy: 'Always', command: ['node', PLUGIN, '--relay'], env, volumeMounts: mounts }] : []),
    ],
    containers: [{ name: 'dsh', image, env, volumeMounts: mounts, ...(o.args ? { args: o.args } : {}), ...(o.command ? { command: o.command } : {}) }],
    volumes: [{ name: 'dsh-home', persistentVolumeClaim: { claimName: 'dsh-home' } }],
  }
}

function createPod(secrets: DevSecrets, name: string, o: PodOptions): void {
  kubectl(['delete', 'pod', name, '--ignore-not-found', '--wait=true'], undefined, true)
  apply({ apiVersion: 'v1', kind: 'Pod', metadata: labelled(name), spec: podSpec(secrets, o) })
}

const podField = (name: string, jsonpath: string) => kubectl(['get', 'pod', name, '-o', `jsonpath=${jsonpath}`], undefined, true).trim()

async function waitPhase(name: string, phases: string[], timeoutMs: number): Promise<string> {
  const until = Date.now() + timeoutMs
  let phase = ''
  while (Date.now() < until) {
    phase = podField(name, '{.status.phase}')
    if (phases.includes(phase)) return phase
    await sleep(3000)
  }
  throw new Error(`pod ${name} still ${phase || 'absent'} after ${timeoutMs / 1000}s: ${podField(name, '{.status.containerStatuses[*].state}')}`)
}

/** Follow a container's log; the returned getter reads what arrived so far. */
function follow(name: string, container = 'dsh'): { text: () => string; stop: () => void } {
  let out = ''
  const child = spawn('kubectl', ['-n', ns, 'logs', '-f', name, '-c', container], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  return { text: () => out, stop: () => child.kill() }
}

async function waitLog(get: () => string, pattern: RegExp, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (pattern.test(get())) return true
    await sleep(1000)
  }
  return false
}

function pluginLines(text: string, max = 12): string {
  const lines = text.split('\n').filter((l) => l.includes('[cls-agentobs]') || l.startsWith('[entrypoint]'))
  return (lines.length > max ? [...lines.slice(0, max / 2), `  … ${lines.length - max} more …`, ...lines.slice(-max / 2)] : lines).map((l) => `    ${l}`).join('\n')
}

// ---------------------------------------------------------------- checks

/** Mount the volume in a throwaway pod: list the outbox and copy the scenario's DSH home out. */
async function inspect(secrets: DevSecrets, scenario: string, node?: string): Promise<{ leftover: string[]; dir: string }> {
  const name = 'agentobs-inspect'
  createPod(secrets, name, { scenario, runId: 'inspect', command: ['sleep', '900'], plain: true, ...(node ? { node } : {}) })
  await waitPhase(name, ['Running'], 300_000)
  const h = home(scenario)
  const leftover = kubectl(['exec', name, '-c', 'dsh', '--', 'sh', '-c', `ls -1 ${h}/agentobs/outbox 2>/dev/null || true`])
    .split('\n').filter((f) => /\.otlp\.gz|\.wal/.test(f))
  const dir = path.join(root, '.tmp', 'tke-homes', scenario)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const tar = spawnSync('sh', ['-c', `kubectl -n ${ns} exec ${name} -c dsh -- tar -C ${h} -cf - . | tar -C '${dir}' -xf -`], { encoding: 'utf8' })
  if (tar.status !== 0) log(`copy of ${h} incomplete: ${tar.stderr.trim().slice(0, 200)}`)
  kubectl(['delete', 'pod', name, '--wait=true'], undefined, true)
  return { leftover, dir }
}

function sessionLogs(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else if (/^session(\.\d+)?\.v4\.jsonl(\.zstd)?$/.test(e.name)) out.push(f)
    }
  }
  walk(dir)
  return out
}

async function clsSpans(secrets: DevSecrets, runId: string, startedMs: number): Promise<StoredSpan[]> {
  const window: [number, number] = [startedMs - 60_000, Date.now() + 60_000]
  return (await searchSpans(secrets, ...window, `"${runId}"`).catch(() => [] as StoredSpan[])).filter((s) => s.attribute['agent.custom.e2e_run'] === runId)
}

/**
 * What the session logs say was emitted (replayed: same deterministic ids) against what CLS
 * stored. Auxiliary model calls are not in session logs, so they are only counted.
 */
async function compare(secrets: DevSecrets, runId: string, startedMs: number, dir: string, waitMs = 40_000): Promise<{ ok: boolean; summary: string }> {
  const files = sessionLogs(dir)
  // The volume keeps earlier runs' sessions: only those created during this run count
  // (a minute of slack for clock skew between this machine and the nodes).
  const logs = files.map((f) => readSessionLog(f)).filter((l) => l.header.createdAt >= startedMs - 60_000)
  const expected = new Set(replaySessionGroup(logs, { captureContent: false, maxContentChars: 1000, commonAttributes: {} }).flat().map((s) => s.spanId))
  let stored: StoredSpan[] = []
  const until = Date.now() + waitMs
  for (;;) {
    stored = await clsSpans(secrets, runId, startedMs)
    const ids = new Set(stored.map((s) => s.spanID))
    if ([...expected].every((id) => ids.has(id)) || Date.now() > until) break
    await sleep(10_000)
  }
  const ids = new Set(stored.map((s) => s.spanID))
  const duplicates = stored.length - ids.size
  const aux = new Set(stored.filter((s) => s.attribute['agent.custom.llm_purpose']).map((s) => s.spanID))
  const missing = [...expected].filter((id) => !ids.has(id))
  const extra = [...ids].filter((id) => !expected.has(id) && !aux.has(id))
  const orphans = stored.filter((s) => s.parentSpanID && !ids.has(s.parentSpanID)).length
  const summary = `sessions=${logs.length} expected=${expected.size} stored=${ids.size} (+${aux.size} auxiliary) missing=${missing.length} extra=${extra.length} duplicates=${duplicates} orphans=${orphans}`
  return { ok: expected.size > 0 && missing.length === 0 && extra.length === 0 && duplicates === 0, summary }
}

function nodes(): string[] {
  return spawnSync('kubectl', ['get', 'nodes', '-o', 'jsonpath={.items[*].metadata.name}'], { encoding: 'utf8' }).stdout.trim().split(/\s+/).filter(Boolean)
}

const verdict = (name: string, checks: Record<string, boolean>) => {
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? 'ok  ' : 'FAIL'} ${k}`)
  const ok = Object.values(checks).every(Boolean)
  console.log(`TKE ${name.toUpperCase()} ${ok ? 'PASS' : 'FAIL'}`)
  return ok
}

// ---------------------------------------------------------------- scenarios

/** One task as a Job, through the image's entrypoint; the CLS intranet endpoint. */
async function scenarioJob(secrets: DevSecrets): Promise<boolean> {
  const runId = randomUUID()
  const started = Date.now()
  kubectl(['delete', 'job', 'agentobs-job', '--ignore-not-found', '--wait=true'], undefined, true)
  apply({
    apiVersion: 'batch/v1', kind: 'Job', metadata: labelled('agentobs-job'),
    spec: { backoffLimit: 0, template: { metadata: { labels: LABEL }, spec: podSpec(secrets, { scenario: 'job', runId, args: dsh('job', 'headless', SHORT_TASK) }) } },
  })
  log('job submitted')
  kubectl(['wait', '--for=condition=complete', 'job/agentobs-job', '--timeout=600s'], undefined, true)
  const status = kubectl(['get', 'job', 'agentobs-job', '-o', 'jsonpath={.status.succeeded}/{.status.failed}'], undefined, true)
  const pod = kubectl(['get', 'pods', '-l', 'job-name=agentobs-job', '-o', 'jsonpath={.items[0].metadata.name} {.items[0].spec.nodeName}'], undefined, true).trim().split(' ')
  const out = kubectl(['logs', `job/agentobs-job`, '-c', 'dsh'], undefined, true)
  log(`job succeeded/failed=${status} pod=${pod[0]} node=${pod[1]}`)
  console.log(`  answer: ${out.split('\n').find((l) => l.includes('tke-ok')) ?? '(none)'}\n${pluginLines(out)}`)
  kubectl(['delete', 'job', 'agentobs-job', '--wait=true'], undefined, true)
  const treeOk = await verifyRun(secrets, runId, started, '/nonexistent')
  const { leftover, dir } = await inspect(secrets, 'job')
  const cmp = await compare(secrets, runId, started, dir)
  log(cmp.summary)
  return verdict('job', {
    'job completed': status.startsWith('1'),
    'the agent\'s command ran in the pod': /^tke-ok\s*$/m.test(out),
    'plugin enabled with the intranet endpoint': /enabled: endpoint=https:\/\/ap-[a-z]+\.cls\.tencentyun\.com/.test(out),
    'entrypoint flushed after DSH exited': /\[cls-agentobs\] flush: delivered \d+ files, 0 left/.test(out),
    'trace complete in CLS (tree, content, spec)': treeOk,
    'session logs match CLS exactly': cmp.ok,
    'outbox empty on the volume': leftover.length === 0,
  })
}

/** `kubectl delete pod` mid-task: SIGTERM, DSH stops, the entrypoint flushes within the grace period. */
async function scenarioGraceful(secrets: DevSecrets): Promise<boolean> {
  const runId = randomUUID()
  const started = Date.now()
  const name = 'agentobs-graceful'
  createPod(secrets, name, { scenario: 'graceful', runId, args: dsh('graceful', 'headless', LONG_TASK) })
  await waitPhase(name, ['Running'], 300_000)
  const logs = follow(name)
  const sent = await waitLog(logs.text, /exported \d+ spans/, 120_000)
  await sleep(10_000)
  const t = Date.now()
  log('deleting the pod (grace period 60 s)')
  kubectl(['delete', 'pod', name, '--wait=true', '--timeout=120s'], undefined, true)
  const stopSeconds = (Date.now() - t) / 1000
  await sleep(2000)
  logs.stop()
  log(`pod gone after ${stopSeconds.toFixed(1)} s`)
  console.log(pluginLines(logs.text()))
  const { leftover, dir } = await inspect(secrets, 'graceful')
  const cmp = await compare(secrets, runId, started, dir)
  log(cmp.summary)
  return verdict('graceful', {
    'spans were being sent before the delete': sent,
    'stopped within the grace period': stopSeconds < 60,
    'entrypoint flushed after DSH exited': /\[cls-agentobs\] flush: delivered \d+ files, 0 left/.test(logs.text()),
    'session logs match CLS exactly': cmp.ok,
    'outbox empty on the volume': leftover.length === 0,
  })
}

/**
 * Every process of the pod SIGKILLed mid-task (as an OOM kill or a lost node would), then a
 * replacement pod on the other node: the volume moves with it and the plugin there takes
 * the dead pod's journal over once its claims have aged.
 */
async function scenarioKill(secrets: DevSecrets): Promise<boolean> {
  const [nodeA, nodeB] = nodes()
  if (!nodeA || !nodeB) throw new Error('needs two nodes')
  const runId = randomUUID()
  const started = Date.now()
  const name = 'agentobs-kill'
  // CLS unreachable from this pod: everything it emits stays in its write-ahead journal,
  // which the replacement must take over and deliver.
  createPod(secrets, name, {
    scenario: 'kill', runId, args: dsh('kill', 'headless', STUCK_TASK), node: nodeA, shareProcessNamespace: true,
    extraEnv: { CLS_AGENTOBS_ENDPOINT: 'https://10.255.255.1/v1/traces', CLS_AGENTOBS_EXPORT_TIMEOUT_MS: '2000' },
  })
  await waitPhase(name, ['Running'], 300_000)
  const logs = follow(name)
  // The model call that issued the command has ended: the command is running now.
  const sent = await waitLog(logs.text, /debug: span chat /, 120_000)
  await sleep(8_000)
  log(`kill -9 of every process in ${name} on ${nodeA}`)
  kubectl(['exec', name, '-c', 'dsh', '--', 'sh', '-c', 'kill -9 -1'], undefined, true)
  await waitPhase(name, ['Failed', 'Succeeded'], 120_000)
  const exitCode = podField(name, '{.status.containerStatuses[0].state.terminated.exitCode}')
  logs.stop()
  log(`container exit code ${exitCode}`)
  kubectl(['delete', 'pod', name, '--wait=true'], undefined, true)

  const before = await inspect(secrets, 'kill', nodeB)
  log(`left on the volume: ${before.leftover.join(', ') || 'nothing'}`)
  const killedAt = Date.now()
  // The replacement: a long-running host on the other node (dsh web), started right away.
  const next = 'agentobs-kill-next'
  createPod(secrets, next, { scenario: 'kill', runId, args: dsh('kill', 'web', '--no-open', '--port', '18090'), node: nodeB })
  await waitPhase(next, ['Running'], 300_000)
  const nextLogs = follow(next)
  const recovered = await waitLog(nextLogs.text, /recovered \d+ spans journaled by an earlier process/, 6 * 60_000)
  const recoverySeconds = (Date.now() - killedAt) / 1000
  log(`replacement recovered the journal: ${recovered} after ${recoverySeconds.toFixed(0)} s`)
  await sleep(15_000)
  kubectl(['delete', 'pod', next, '--wait=true', '--timeout=120s'], undefined, true)
  nextLogs.stop()
  console.log(pluginLines(nextLogs.text()))
  const after = await inspect(secrets, 'kill', nodeB)
  const cmp = await compare(secrets, runId, started, after.dir)
  log(cmp.summary)
  return verdict('kill', {
    'spans were journaled before the kill (CLS unreachable)': sent,
    'killed with SIGKILL (exit 137)': exitCode === '137',
    'journal left on the volume': before.leftover.some((f) => f.includes('.wal')),
    'replacement on the other node took it over': recovered,
    'session logs match CLS exactly': cmp.ok,
    'outbox empty on the volume': after.leftover.length === 0,
  })
}

/**
 * dsh web with the relay sidecar (its own PID namespace). Tasks run inside the DSH
 * container while the relay keeps polling the shared outbox: it must never take over
 * files the live DSH processes hold.
 */
async function scenarioRelay(secrets: DevSecrets): Promise<boolean> {
  const runId = randomUUID()
  const started = Date.now()
  const name = 'agentobs-relay'
  createPod(secrets, name, { scenario: 'relay', runId, args: dsh('relay', 'web', '--no-open', '--port', '18090'), relay: true })
  await waitPhase(name, ['Running'], 300_000)
  const relayLogs = follow(name, 'agentobs-relay')
  const webLogs = follow(name)
  await waitLog(webLogs.text, /dsh web:/, 120_000)
  for (const i of [1, 2]) {
    log(`task ${i} inside the DSH container`)
    const r = spawnSync('kubectl', ['-n', ns, 'exec', name, '-c', 'dsh', '--', 'sh', '-c', `cd /work && ${dsh('relay', 'headless', MEDIUM_TASK).map((a) => JSON.stringify(a)).join(' ')}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    console.log(`  exit ${r.status}, answer: ${r.stdout.trim().split('\n').pop()}`)
  }
  await sleep(20_000)
  log('deleting the pod')
  kubectl(['delete', 'pod', name, '--wait=true', '--timeout=120s'], undefined, true)
  relayLogs.stop()
  webLogs.stop()
  const relayText = relayLogs.text()
  console.log(`  relay:\n${pluginLines(relayText)}`)
  const { leftover, dir } = await inspect(secrets, 'relay')
  const cmp = await compare(secrets, runId, started, dir)
  log(cmp.summary)
  return verdict('relay', {
    'relay sidecar ran': /relay: delivering/.test(relayText),
    'relay never took over a live process\'s files': !/released \d+ stale|recovered \d+ spans/.test(relayText),
    'session logs match CLS exactly': cmp.ok,
    'outbox empty on the volume': leftover.length === 0,
  })
}

/**
 * A Deployment's pod deleted mid-task (as an eviction or a lost node does): the ReplicaSet
 * starts a new pod on the same PersistentVolumeClaim, and its plugin takes over what the
 * old pod left on the disk. The task runs inside the Deployment's `dsh web` container with
 * CLS unreachable, so its spans are on the disk only.
 */
async function scenarioDeployment(secrets: DevSecrets): Promise<boolean> {
  const runId = randomUUID()
  const started = Date.now()
  const name = 'agentobs-deploy'
  const selector = `app=${name}`
  const spec = { ...podSpec(secrets, { scenario: 'deployment', runId, args: dsh('deployment', 'web', '--no-open', '--port', '18090') }), restartPolicy: 'Always' }
  kubectl(['delete', 'deployment', name, '--ignore-not-found', '--wait=true'], undefined, true)
  apply({
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: labelled(name),
    spec: {
      replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: { app: name } },
      template: { metadata: { labels: { ...LABEL, app: name } }, spec },
    },
  })
  const podOf = async (exceptUid?: string): Promise<{ name: string; uid: string; node: string }> => {
    const until = Date.now() + 600_000
    while (Date.now() < until) {
      const items = kubectl(['get', 'pods', '-l', selector, '-o', 'jsonpath={range .items[*]}{.metadata.name} {.metadata.uid} {.spec.nodeName} {.status.phase} {.metadata.deletionTimestamp}{"\\n"}{end}'], undefined, true)
        .split('\n').map((l) => l.trim().split(' ')).filter((p) => p[0] && p[1] !== exceptUid && p[3] === 'Running' && !p[4])
      if (items[0]) return { name: items[0][0]!, uid: items[0][1]!, node: items[0][2] ?? '' }
      await sleep(3000)
    }
    throw new Error('no running pod of the deployment')
  }
  const volume = () => kubectl(['get', 'pvc', 'dsh-home', '-o', 'jsonpath={.spec.volumeName}'], undefined, true).trim()
  const first = await podOf()
  const volumeBefore = volume()
  log(`deployment pod ${first.name} on ${first.node}, volume ${volumeBefore}`)
  const web = follow(first.name)
  await waitLog(web.text, /dsh web:/, 120_000)

  // The task, inside the pod, with CLS unreachable: everything stays in its journal.
  const task = dsh('deployment', 'headless', STUCK_TASK).map((a) => JSON.stringify(a)).join(' ')
  let taskOut = ''
  const exec = spawn('kubectl', ['-n', ns, 'exec', first.name, '-c', 'dsh', '--', 'sh', '-c',
    `cd /work && env CLS_AGENTOBS_ENDPOINT=https://10.255.255.1/v1/traces CLS_AGENTOBS_EXPORT_TIMEOUT_MS=2000 ${task}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  exec.stdout.on('data', (d) => { taskOut += d })
  exec.stderr.on('data', (d) => { taskOut += d })
  const journaled = await waitLog(() => taskOut, /debug: span chat /, 180_000)
  await sleep(8_000)
  log(`force-deleting ${first.name} mid-task`)
  kubectl(['delete', 'pod', first.name, '--grace-period=0', '--force'], undefined, true)
  web.stop()
  exec.kill()

  const second = await podOf(first.uid)
  const volumeAfter = volume()
  log(`replacement ${second.name} on ${second.node}, volume ${volumeAfter}`)
  const next = follow(second.name)
  // Either way the old pod left its data: a journal (killed outright) or a spilled file it
  // had claimed (it got a signal and stopped, but its deliverer died with the pod).
  const recovered = await waitLog(next.text, /recovered \d+ spans journaled by an earlier process|released \d+ stale outbox claims/, 6 * 60_000)
    && await waitLog(next.text, /delivered spilled file/, 60_000)
  const how = /recovered \d+ spans journaled/.test(next.text()) ? 'journal' : 'claimed outbox file'
  log(`replacement took the old pod's data over: ${recovered} (${how})`)
  await sleep(15_000)
  kubectl(['delete', 'deployment', name, '--wait=true', '--timeout=120s'], undefined, true)
  for (let i = 0; i < 40 && kubectl(['get', 'pods', '-l', selector, '-o', 'name'], undefined, true).trim(); i++) await sleep(3000)
  next.stop()
  console.log(pluginLines(next.text()))
  const { leftover, dir } = await inspect(secrets, 'deployment')
  const cmp = await compare(secrets, runId, started, dir)
  log(cmp.summary)
  return verdict('deployment', {
    'spans journaled before the pod was deleted (CLS unreachable)': journaled,
    'the deployment started a new pod': second.uid !== first.uid,
    'the new pod mounted the same disk': volumeBefore !== '' && volumeAfter === volumeBefore,
    'the new pod took the old pod\'s data over': recovered,
    'session logs match CLS exactly': cmp.ok,
    'outbox empty on the volume': leftover.length === 0,
  })
}

function cleanup(): void {
  kubectl(['delete', 'deployment,job,pod', '-l', 'agentobs-tke=1', '--ignore-not-found', '--wait=true'], undefined, true)
  kubectl(['delete', 'secret,pvc', '-l', 'agentobs-tke=1', '--ignore-not-found', '--wait=true'], undefined, true)
  rmSync(path.join(root, '.tmp', 'tke-homes'), { recursive: true, force: true })
  rmSync(path.join(root, '.tmp', 'tke-build'), { recursive: true, force: true })
  log(`deleted everything labelled agentobs-tke=1 in ${ns}`)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'image') buildImage()
else if (command === 'cleanup') cleanup()
else if (command === 'run') {
  const secrets = loadDevSecrets()
  setup(secrets)
  const all: Record<string, (s: DevSecrets) => Promise<boolean>> = { job: scenarioJob, graceful: scenarioGraceful, kill: scenarioKill, relay: scenarioRelay, deployment: scenarioDeployment }
  let ok = true
  for (const name of rest.length ? rest : Object.keys(all)) {
    const run = all[name]
    if (!run) throw new Error(`unknown scenario ${name}`)
    console.log(`\n========== ${name}`)
    try { ok = (await run(secrets)) && ok } catch (error) { ok = false; console.log(`TKE ${name.toUpperCase()} ERROR: ${String(error)}`) }
  }
  process.exit(ok ? 0 : 1)
} else {
  console.log('usage: tke-verify.ts image | run [job|graceful|kill|relay|deployment …] | cleanup')
  process.exit(2)
}
