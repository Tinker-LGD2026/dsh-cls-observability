/**
 * DEV ONLY. End-to-end through the ACP profile (the editor integration path): a minimal
 * Agent Client Protocol client over stdio JSON-RPC (ndjson) drives one session with two
 * prompts, then the spans are read back from CLS.
 *
 *   DSH_BIN=<built dsh lib/bin.js> node scripts/e2e-acp.ts [--profile acp]
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { StoredSpan } from './cls-api.ts'
import { devEnv, loadDevSecrets } from './dev-secrets.ts'
import { outboxOf, verifyRun } from './verify-cls.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dshBin = process.env.DSH_BIN
if (!dshBin) throw new Error('set DSH_BIN to a built dsh lib/bin.js')
const args = process.argv.slice(2)
const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1]! : 'acp'
const runId = randomUUID()
const work = path.join(root, '.tmp', `e2e-acp-${runId.slice(0, 8)}`)
const home = path.join(work, 'home')
const workspace = path.join(work, 'workspace')
mkdirSync(home, { recursive: true })
mkdirSync(workspace, { recursive: true })
writeFileSync(path.join(workspace, 'notes.txt'), 'acp e2e workspace\n')
const patchFile = path.join(work, 'agentobs.patch.yml')
writeFileSync(patchFile, `- insert:\n    - id: cls-agentobs\n      name: ${path.join(root, 'dist', 'dsh-cls-observability.mjs')}\n`)

const secrets = loadDevSecrets()
const env: NodeJS.ProcessEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('OTEL_')) env[k] = v
Object.assign(env, devEnv(secrets), {
  DSH_HOME: home,
  CLS_AGENTOBS_DEBUG: 'true',
  CLS_AGENTOBS_ENVIRONMENT: 'dev',
  CLS_AGENTOBS_CUSTOM_ATTRIBUTES: `e2e_run=${runId}`,
})

console.log(`run ${runId} profile=${profile}`)
const started = Date.now()
const child = spawn(process.execPath, [path.resolve(dshBin), '--profile', profile, '--patch', patchFile], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
let stderr = ''
child.stderr.on('data', (d) => { stderr += d })
const exited = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)))

// --- minimal JSON-RPC 2.0 over ndjson
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const updates: string[] = []
const send = (msg: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  send({ id, method, params })
})
createInterface({ input: child.stdout }).on('line', (line) => {
  let msg: any
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) p?.reject(new Error(JSON.stringify(msg.error)))
    else p?.resolve(msg.result)
  } else if (msg.method === 'session/update') {
    const u = msg.params?.update
    if (u?.sessionUpdate) updates.push(u.sessionUpdate)
  } else if (msg.method === 'session/request_permission' && msg.id !== undefined) {
    // Allow once: pick the first "allow" option.
    const option = (msg.params?.options ?? []).find((o: any) => String(o.kind).startsWith('allow')) ?? msg.params?.options?.[0]
    send({ id: msg.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } })
  } else if (msg.id !== undefined && msg.method) {
    send({ id: msg.id, error: { code: -32601, message: `client does not implement ${msg.method}` } })
  }
})

let ok = false
try {
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
  console.log(`initialized: protocol ${String(init?.protocolVersion)}, agent ${JSON.stringify(init?.agentInfo ?? {})}`)
  const session = await request('session/new', { cwd: workspace, mcpServers: [] })
  const sessionId = String(session.sessionId)
  console.log(`session ${sessionId.slice(-12)}`)
  const r1 = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Use your read tool to read notes.txt, then reply with its exact content.' }] })
  const r2 = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Now reply with the single word: done' }] })
  console.log(`prompts: ${String(r1?.stopReason)}, ${String(r2?.stopReason)}; updates: ${[...new Set(updates)].join(',')}`)
  ok = r1?.stopReason === 'end_turn' && r2?.stopReason === 'end_turn'
} catch (error) {
  console.log(`acp failed: ${String(error).slice(0, 800)}`)
}
child.stdin.end()
const timer = setTimeout(() => child.kill('SIGTERM'), 20_000)
const code = await exited
clearTimeout(timer)
console.log(`dsh exit=${String(code)} after ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(stderr.split('\n').filter((l) => /\[cls-agentobs\].*(enabled|stopping|stopped|spilled|handed)/.test(l)).join('\n'))

const entryCheck = (spans: StoredSpan[]) => {
  const entries = spans.filter((s) => s.attribute['gen_ai.span.kind'] === 'entry')
  const types = [...new Set(entries.map((s) => `${String(s.attribute['gen_ai.entry.type'])}/${String(s.attribute['gen_ai.entry.platform'])}`))]
  console.log(`\n== ${profile} ==\nturns: ${entries.length}, entry: ${types.join(' ')}, profile: ${String(entries[0]?.attribute['agent.custom.dsh_profile'])}`)
  return entries.length === 2 && types.length === 1 && types[0] === `${profile === 'acp' ? 'acp/acp' : `${profile}/${profile}`}`
}
const verified = ok && await verifyRun(secrets, runId, started, outboxOf(home), entryCheck)
console.log(verified ? 'E2E ACP PASS' : 'E2E ACP FAIL')
process.exit(verified ? 0 : 1)
