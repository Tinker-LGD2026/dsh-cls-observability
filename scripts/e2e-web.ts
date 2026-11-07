/**
 * DEV ONLY. End-to-end against a long-running `dsh --profile web` host.
 *
 *  1. starts the web profile WITHOUT the plugin;
 *  2. enables it at runtime by writing $DSH_HOME/cordis.patch.yml (first-enable hot load);
 *  3. drives two sessions concurrently through the Web API, then a second turn in one;
 *  4. checks the spans reach CLS while the host is still running (no exit flush involved);
 *  5. stops the host and checks nothing is left in the outbox.
 *
 * Needs a DSH source checkout (DSH_REPO, default ../deepseek-harness) and dev credentials
 * (see scripts/dev-secrets.ts).
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { devEnv, loadDevSecrets } from './dev-secrets.ts'
import { verifyRun, outboxOf } from './verify-cls.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dsh = path.resolve(process.env.DSH_REPO ?? path.join(root, '../deepseek-harness'))
const secrets = loadDevSecrets()
const runId = randomUUID()
const work = path.join(root, '.tmp', `e2e-web-${runId.slice(0, 8)}`)
const home = path.join(work, 'home')
const workspace = path.join(work, 'workspace')
mkdirSync(home, { recursive: true })
mkdirSync(workspace, { recursive: true })
writeFileSync(path.join(workspace, 'notes.txt'), 'agentobs web e2e workspace\n')
// DSH 0.2.2 hot-reloads $DSH_HOME/cordis.patch.yml only if the file existed at start:
// creating it later is not picked up. Start with an empty patch, as customers should.
writeFileSync(path.join(home, 'cordis.patch.yml'), '[]\n')

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)) })
})
const port = await freePort()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const env: NodeJS.ProcessEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('OTEL_')) env[k] = v
Object.assign(env, devEnv(secrets), {
  DSH_HOME: home,
  CLS_AGENTOBS_DEBUG: 'true',
  CLS_AGENTOBS_ENVIRONMENT: 'dev',
  CLS_AGENTOBS_CUSTOM_ATTRIBUTES: `e2e_run=${runId}`,
  TSX_TSCONFIG_PATH: path.join(dsh, 'tsconfig.json'),
})

console.log(`run ${runId} profile=web port=${port}`)
const started = Date.now()
// The web profile serves built client bundles: run a built DSH (DSH_BIN, e.g. the npm
// package's lib/bin.js) when the source checkout has not been built.
const dshBin = process.env.DSH_BIN
const launch = dshBin
  ? [path.resolve(dshBin)]
  : ['--import', `file://${path.join(dsh, 'node_modules/tsx/dist/esm/index.mjs')}`, path.join(dsh, 'apps/cli/src/bin.ts')]
const child = spawn(process.execPath, [
  ...launch, '--profile', 'web', '--no-open', '--port', String(port),
], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
child.stdout.on('data', (d) => { output += d })
child.stderr.on('data', (d) => { output += d })
const exited = new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)))

const waitFor = async (what: string, test: () => boolean, ms: number) => {
  const until = Date.now() + ms
  while (Date.now() < until) { if (test()) return; await sleep(250) }
  throw new Error(`timed out waiting for ${what}\n--- output tail ---\n${output.split('\n').slice(-30).join('\n')}`)
}
const pluginLines = () => output.split('\n').filter((l) => l.includes('[cls-agentobs]'))
const count = (needle: string) => pluginLines().filter((l) => l.includes(needle)).length

let ok = false
try {
  const urlRe = new RegExp(`https?://(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}/\\S*`)
  await waitFor('the web URL', () => urlRe.test(output), 90_000)
  const url = urlRe.exec(output)![0]
  console.log(`web up after ${((Date.now() - started) / 1000).toFixed(1)}s; plugin loaded at start: ${pluginLines().length > 0}`)

  // First-enable hot load: the plugin is added while the host runs.
  writeFileSync(path.join(home, 'cordis.patch.yml'), `- insert:\n    - id: cls-agentobs\n      name: ${path.join(root, 'dist', 'dsh-cls-observability.mjs')}\n`)
  const before = output.length
  try {
    await waitFor('the plugin to hot-load', () => count('enabled:') > 0, 60_000)
  } finally {
    const after = output.slice(before).split('\n').filter((l) => l.trim() && !l.includes('[cls-agentobs]'))
    if (after.length) console.log('--- host output after enabling ---\n' + after.slice(0, 40).join('\n'))
  }
  console.log(`plugin hot-loaded after ${((Date.now() - started) / 1000).toFixed(1)}s`)

  // Token exchange → session cookie.
  const origin = `http://127.0.0.1:${port}`
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error(`no session cookie from ${new URL(url).pathname} (status ${auth.status})`)
  const call = async (method: string, args: unknown) => {
    const rpcId = randomUUID()
    const res = await fetch(`${origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} → ${res.status} ${text.slice(0, 300)}`)
    const envelope = JSON.parse(text) as { result?: { ok: boolean; value?: Record<string, unknown>; error?: unknown } }
    if (!envelope.result?.ok) throw new Error(`${method} failed: ${JSON.stringify(envelope.result?.error ?? envelope).slice(0, 400)}`)
    return envelope.result.value ?? {}
  }
  const create = async () => {
    const r = await call('session/create', { request: { cwd: workspace } })
    const id = r.sessionId as string | undefined
    if (!id) throw new Error(`unexpected create response ${JSON.stringify(r).slice(0, 200)}`)
    return id
  }
  // Remote args are named after the method parameters: create(request), prompt(request, signal).
  const prompt = (sessionId: string, text: string) =>
    call('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] } })

  const a = await create()
  const b = await create()
  console.log(`sessions ${a.slice(-8)} ${b.slice(-8)}`)
  await Promise.all([
    prompt(a, 'Use your bash tool to run exactly: echo web-a-ok . Then reply with only the output.'),
    prompt(b, 'Use your read tool to read notes.txt, then reply with its first word only.'),
  ])
  await waitFor('two turns', () => count('span entry ') >= 2, 180_000)
  await prompt(a, 'Now reply with the single word: done')
  await waitFor('the second turn', () => count('span entry ') >= 3, 120_000)
  console.log(`3 turns finished after ${((Date.now() - started) / 1000).toFixed(1)}s`)

  // Delivered while the host is still running: the eager send path, not the exit spill.
  const live = await verifyRun(secrets, runId, started, path.join(work, 'none'))
  console.log(live ? 'LIVE DELIVERY PASS' : 'LIVE DELIVERY FAIL')
  ok = live
} catch (error) {
  console.log(String(error))
} finally {
  child.kill('SIGINT')
  const code = await Promise.race([exited, sleep(15_000).then(() => -1)])
  if (code === -1) child.kill('SIGKILL')
  console.log(`web stopped (exit ${code})`)
  console.log(pluginLines().filter((l) => !/debug: (span|sending|send finished|exported)/.test(l)).join('\n'))
}
const outbox = outboxOf(home)
await sleep(3_000)
const leftover = existsSync(outbox) ? readdirSync(outbox) : []
console.log(`outbox leftover after stop: ${leftover.length}`)
const pass = ok && leftover.length === 0
console.log(pass ? 'E2E WEB PASS' : 'E2E WEB FAIL')
process.exit(pass ? 0 : 1)
