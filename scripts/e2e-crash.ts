/**
 * DEV ONLY. Crash recovery with a real DSH (headless):
 *  1. run a task with CLS unreachable, so every span stays in the write-ahead journal;
 *     kill -9 the host while a tool call is running (turn 1 never ends);
 *  2. resume the same session with CLS reachable: the plugin recovers the dead
 *     process's journal, and closes turn 1 from the closers DSH appends on resume;
 *  3. read everything back from CLS and check both turns.
 *
 *   DSH_BIN=<built dsh lib/bin.js> node scripts/e2e-crash.ts
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StoredSpan } from './cls-api.ts'
import { devEnv, loadDevSecrets } from './dev-secrets.ts'
import { outboxOf, verifyRun } from './verify-cls.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dshBin = process.env.DSH_BIN
if (!dshBin) throw new Error('set DSH_BIN to a built dsh lib/bin.js')
const runId = randomUUID()
const work = path.join(root, '.tmp', `e2e-crash-${runId.slice(0, 8)}`)
const home = path.join(work, 'home')
const workspace = path.join(work, 'workspace')
mkdirSync(home, { recursive: true })
mkdirSync(workspace, { recursive: true })
const patchFile = path.join(work, 'agentobs.patch.yml')
writeFileSync(patchFile, `- insert:\n    - id: cls-agentobs\n      name: ${path.join(root, 'dist', 'dsh-cls-observability.mjs')}\n`)

const secrets = loadDevSecrets()
const baseEnv: NodeJS.ProcessEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('OTEL_')) baseEnv[k] = v
Object.assign(baseEnv, devEnv(secrets), {
  DSH_HOME: home,
  CLS_AGENTOBS_DEBUG: 'true',
  CLS_AGENTOBS_ENVIRONMENT: 'dev',
  CLS_AGENTOBS_CUSTOM_ATTRIBUTES: `e2e_run=${runId}`,
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function run(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [path.resolve(dshBin!), '--profile', 'headless', '--patch', patchFile, '--json', ...args], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = { stdout: '', stderr: '' }
  child.stdout.on('data', (d) => { out.stdout += d })
  child.stderr.on('data', (d) => { out.stderr += d })
  const exited = new Promise<number | null>((resolve) => child.on('close', (c, sig) => resolve(sig ? null : c)))
  return { child, out, exited }
}
const pluginLog = (s: string) => s.split('\n').filter((l) => l.includes('[cls-agentobs]')).map((l) => l.replace(/^.*\[cls-agentobs\] /, '  '))
const outbox = outboxOf(home)

console.log(`run ${runId} (crash + resume)`)
const started = Date.now()

// 1. CLS unreachable; kill -9 while the second tool call (sleep) runs.
const first = run([
  'Use your bash tool to run exactly: echo crash-step-one . After that, use your bash tool to run exactly: sleep 60 . Then answer done.',
], { ...baseEnv, CLS_AGENTOBS_ENDPOINT: 'http://127.0.0.1:9/v1/traces' })
const until = Date.now() + 120_000
while (Date.now() < until && pluginLog(first.out.stderr).filter((l) => l.includes('span chat')).length < 2) await sleep(250)
await sleep(2_000) // the sleep 60 tool call is now running
first.child.kill('SIGKILL')
const firstExit = await first.exited
const sessionId = (JSON.parse(first.out.stdout.split('\n')[0] ?? '{}') as { sessionId?: string }).sessionId
const journals = existsSync(outbox) ? readdirSync(outbox).filter((f) => f.includes('.wal')) : []
console.log(`first run killed (exit ${String(firstExit)}), session ${sessionId?.slice(-12)}, journals left: ${journals.length}`)
console.log(pluginLog(first.out.stderr).filter((l) => !l.includes('send finished') && !l.includes('sending')).slice(0, 14).join('\n'))
if (!sessionId || journals.length === 0) {
  console.log('--- first run stderr (head) ---\n' + first.out.stderr.split('\n').slice(0, 20).join('\n'))
  console.log('E2E CRASH FAIL: nothing to recover')
  process.exit(1)
}

// 2. Resume with CLS reachable.
const second = run(['--session-id', sessionId, 'Reply with the single word: resumed'], baseEnv)
const secondExit = await second.exited
console.log(`resume run exit ${String(secondExit)}`)
console.log(pluginLog(second.out.stderr).filter((l) => /recover|released|closed crashed|stopping|stopped|spilled|handed/.test(l)).join('\n'))

// Evidence: the tail of the stored session log after the resume (DSH appends crash closers there).
const logs: string[] = []
const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(e.name)) logs.push(f) } }
if (existsSync(path.join(home, 'sessions'))) walk(path.join(home, 'sessions'))
for (const f of logs) {
  const raw = readFileSync(f)
  const text = f.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
  const events = text.split('\n').filter(Boolean).slice(1).map((l) => JSON.parse(l) as { type: string; seq: number; time: number; data?: { turn?: number; reason?: { kind?: string }; message?: { id?: string } } })
  console.log(`session log ${path.basename(path.dirname(f)).slice(-12)}: ${events.length} events; around the crash:`)
  const end1 = events.findIndex((e) => e.type === 'turn/start' && e.data?.turn === 2)
  for (const e of events.slice(Math.max(0, (end1 < 0 ? events.length : end1) - 8), end1 < 0 ? undefined : end1 + 1)) {
    console.log(`  #${e.seq} ${e.type} t=${e.time}${e.data?.turn !== undefined ? ` turn=${e.data.turn}` : ''}${e.data?.reason ? ` reason=${String(e.data.reason.kind)}` : ''}${e.data?.message?.id ? ` id=${String(e.data.message.id).slice(0, 32)}` : ''}`)
  }
}
console.log('--- resume run plugin log ---\n' + pluginLog(second.out.stderr).filter((l) => !/sending|send finished|exported/.test(l)).slice(0, 25).join('\n'))

// 3. Both turns in CLS.
const crashCheck = (spans: StoredSpan[], info: { duplicates: number }) => {
  const turn = (s: StoredSpan) => String(s.attribute['gen_ai.turn.id']).split(':').pop()
  const kind = (s: StoredSpan) => String(s.attribute['gen_ai.span.kind'])
  const t1 = spans.filter((s) => turn(s) === 't1')
  const t2 = spans.filter((s) => turn(s) === 't2')
  const closed = t1.filter((s) => s.attribute['agent.custom.closed_after_crash'] === true)
  const entry1 = t1.find((s) => kind(s) === 'entry')
  const tools1 = t1.filter((s) => kind(s) === 'tool')
  console.log(`\n== crash ==\nturn 1: ${t1.length} spans (${t1.map(kind).sort().join(',')}), closed after crash: ${closed.map(kind).sort().join(',')}`)
  console.log(`turn 1 entry: status=${entry1?.statusCode} end=${String(entry1?.attribute['agent.custom.turn_end_reason'] ?? entry1?.attribute['gen_ai.agent.turn_end_reason'] ?? '-')}`)
  for (const t of tools1) console.log(`  tool ${String(t.attribute['gen_ai.tool.call.arguments'] && JSON.stringify(t.attribute['gen_ai.tool.call.arguments']))} status=${t.statusCode} closed=${t.attribute['agent.custom.closed_after_crash'] === true}`)
  console.log(`turn 2: ${t2.length} spans (${t2.map(kind).sort().join(',')}); traces: ${new Set(spans.map((s) => s.traceID)).size}; duplicates: ${info.duplicates}`)
  return info.duplicates === 0
    && t1.filter((s) => kind(s) === 'chat').length >= 2 // journaled before the crash, recovered
    && entry1 !== undefined && entry1.statusCode !== 'OK' && closed.some((s) => kind(s) === 'entry') && closed.some((s) => kind(s) === 'agent')
    // Two tool calls, each exactly once (the sandbox may refuse them: emulated hosts lack Landlock).
    && tools1.length === 2 && new Set(tools1.map((s) => s.spanID)).size === 2
    && t2.some((s) => kind(s) === 'entry') && t2.some((s) => kind(s) === 'chat')
    && new Set(t1.map((s) => s.traceID)).size === 1
}
const verified = secondExit === 0 && await verifyRun(secrets, runId, started, outbox, crashCheck, 3)
console.log(verified ? 'E2E CRASH PASS' : 'E2E CRASH FAIL')
process.exit(verified ? 0 : 1)
