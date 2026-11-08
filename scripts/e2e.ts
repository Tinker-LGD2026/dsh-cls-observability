/**
 * DEV ONLY. End-to-end: run a real DSH task with the built plugin loaded via
 * `--patch`, then read the spans back from CLS and check the tree.
 *
 *   node scripts/e2e.ts [--profile headless] [--ptc] [--compaction] [--task "..."]
 *
 * DSH_BIN=<built dsh lib/bin.js> runs a built DSH (e.g. the npm package) instead of
 * the source checkout. --compaction lowers DSH's automatic compaction threshold and
 * gives the agent files to read until the context is compacted, then checks the
 * compaction call and the full report that follows it.
 *
 * Secrets come from the dev secrets file and are injected into the child
 * process environment only; nothing is printed.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { devEnv, loadDevSecrets } from './dev-secrets.ts'
import type { StoredSpan } from './cls-api.ts'
import { outboxOf, verifyRun, type ExtraCheck } from './verify-cls.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
// A DeepSeek Harness source checkout (default: a sibling directory).
const dsh = path.resolve(process.env.DSH_REPO ?? path.join(root, '../deepseek-harness'))
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback
}

const profile = option('--profile', 'headless')
const compaction = flag('--compaction')
const COMPACTION_FILES = 14
const task = compaction
  ? `Read the files part-01.txt through part-${String(COMPACTION_FILES).padStart(2, '0')}.txt in the current directory one at a time with your read tool, ` +
    'one read per step, in order, never several in parallel. After the last one, answer with the number of files you read.'
  : option('--task',
  'Use your bash tool to run exactly: echo agentobs-e2e-ok . Then use your read tool to read package.json in the current directory. ' +
  'Answer in one line with the command output and the package "name" field.')
const runId = randomUUID()
const work = path.join(root, '.tmp', `e2e-${runId.slice(0, 8)}`)
mkdirSync(path.join(work, 'home'), { recursive: true })
const plugin = path.join(root, 'dist', 'dsh-cls-observability.mjs')
const patchFile = path.join(work, 'agentobs.patch.yml')
writeFileSync(patchFile, `- insert:\n    - id: cls-agentobs\n      name: ${plugin}\n`)

const secrets = loadDevSecrets()
const env: NodeJS.ProcessEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('OTEL_')) env[k] = v
Object.assign(env, devEnv(secrets), {
  DSH_HOME: path.join(work, 'home'),
  // Source runs resolve workspace packages through the repo tsconfig paths; tsx reads it from cwd by default.
  TSX_TSCONFIG_PATH: path.join(dsh, 'tsconfig.json'),
  CLS_AGENTOBS_DEBUG: 'true',
  CLS_AGENTOBS_ENVIRONMENT: 'dev',
  CLS_AGENTOBS_CUSTOM_ATTRIBUTES: `e2e_run=${runId}`,
})

// Run the agent in a small workspace: with the DSH source tree as cwd, DSH's own
// skill-filesystem watcher teardown blocks the event loop for ~40s at exit.
const workspace = path.join(work, 'workspace')
mkdirSync(workspace, { recursive: true })
writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'agentobs-e2e-workspace', private: true }, null, 2))
const dshBin = process.env.DSH_BIN
const launch = dshBin
  ? [path.resolve(dshBin)]
  : ['--import', `file://${path.join(dsh, 'node_modules/tsx/dist/esm/index.mjs')}`, path.join(dsh, 'apps/cli/src/bin.ts')]
const dshArgs = [...launch, '--profile', profile]
if (!flag('--no-plugin')) dshArgs.push('--patch', patchFile)
if (flag('--ptc')) dshArgs.push('--patch', path.join(dsh, 'apps/cli/config/examples/ptc.yml'))
if (compaction) {
  // deepseek-flash has a 1M-token window: 2% (~21k tokens) is reached after a dozen reads
  // of ~5k chars (DSH's tool-result pruner caps each result at ~5k chars).
  const compactPatch = path.join(work, 'compaction.patch.yml')
  writeFileSync(compactPatch, '- id: compaction-basic\n  config:\n    thresholdRatio: 0.02\n    retainTokens: 4000\n')
  dshArgs.push('--patch', compactPatch)
  for (let i = 1; i <= COMPACTION_FILES; i++) {
    const lines = Array.from({ length: 70 }, (_, n) => `part ${i} line ${n + 1}: ${'the quick brown fox jumps over the lazy dog '.repeat(1)}${(i * 7919 + n * 104729).toString(36)}`)
    writeFileSync(path.join(workspace, `part-${String(i).padStart(2, '0')}.txt`), lines.join('\n') + '\n')
  }
}
dshArgs.push(task)

console.log(`run ${runId} profile=${profile}${flag('--ptc') ? ' +ptc' : ''}`)
const started = Date.now()
const child = spawn(process.execPath, dshArgs, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
child.stdout.on('data', (d) => { stdout += d })
child.stderr.on('data', (d) => { stderr += d })
const code: number = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? 1)))
console.log(`dsh exit=${code} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(`answer: ${stdout.trim().slice(0, 300)}`)
const pluginLines = stderr.split('\n').filter((l) => l.includes('[cls-agentobs]'))
console.log(pluginLines.join('\n') || '(no plugin log lines)')
const otherErrors = stderr.split('\n').filter((l) => l.startsWith('dsh:') && !l.startsWith('dsh: reasoning'))
if (otherErrors.length) console.log(otherErrors.slice(0, 10).join('\n'))
if (code !== 0 && pluginLines.length === 0) {
  console.log('--- dsh stderr (head) ---\n' + stderr.split('\n').slice(0, 30).join('\n'))
  process.exit(1)
}

if (flag('--skip-cls')) process.exit(code)
/** A real automatic compaction: its model call, then a full report of the rewritten context. */
const compactionCheck: ExtraCheck = (spans: StoredSpan[]) => {
  const at = (s: StoredSpan) => BigInt(String(s.raw.end ?? '0'))
  const calls = spans.filter((s) => s.attribute['agent.custom.llm_purpose'] === 'compaction')
  const main = spans.filter((s) => s.attribute['gen_ai.span.kind'] === 'chat' && !s.attribute['agent.custom.llm_purpose']).sort((a, b) => (at(a) < at(b) ? -1 : 1))
  const resets = main.filter((s) => s.attribute['agent.custom.input_delta_reset'] !== undefined)
  console.log(`\n== compaction ==\ncompaction calls: ${calls.length}`)
  for (const c of calls) {
    const a = c.attribute
    console.log(`  ${c.name} step=${String(a['gen_ai.step.id']).split(':').slice(-2).join(':')} tokens=${String(a['gen_ai.usage.input_tokens'])}->${String(a['gen_ai.usage.output_tokens'])} hasIO=${a['gen_ai.input.messages'] !== undefined}/${a['gen_ai.output.messages'] !== undefined}`)
  }
  for (const s of main) {
    const a = s.attribute
    const full = a['gen_ai.input.messages'] as unknown[] | undefined
    const delta = a['gen_ai.input.messages_delta'] as unknown[] | undefined
    console.log(`  chat ${String(a['gen_ai.step.id']).split(':').slice(-2).join(':')} in_tokens=${String(a['gen_ai.usage.input_tokens'])} ${full ? `FULL=${full.length}` : `delta=${delta?.length}`} total=${String(a['agent.custom.input_message_count'])}${a['agent.custom.input_delta_reset'] ? ` reset=${String(a['agent.custom.input_delta_reset'])}` : ''}`)
  }
  const firstReset = resets[0]
  const after = firstReset ? main.slice(main.indexOf(firstReset) + 1) : []
  return calls.length > 0 && calls.every((c) => c.attribute['gen_ai.output.messages'] !== undefined)
    && resets.length > 0 && resets.every((s) => s.attribute['gen_ai.input.messages'] !== undefined)
    && after.every((s) => s.attribute['gen_ai.input.messages_delta'] !== undefined || s.attribute['agent.custom.input_delta_reset'] !== undefined)
}
const verified = code === 0 && await verifyRun(secrets, runId, started, outboxOf(path.join(work, 'home')), compaction ? compactionCheck : undefined, compaction ? 3 : 2)
console.log(verified ? 'E2E PASS' : 'E2E FAIL')
process.exit(verified ? 0 : 1)
