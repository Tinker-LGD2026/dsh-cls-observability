/**
 * DEV ONLY. End-to-end: run a real DSH task with the built plugin loaded via
 * `--patch`, then read the spans back from CLS and check the tree.
 *
 *   node scripts/e2e.ts [--profile headless] [--ptc] [--task "..."]
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
import { outboxOf, verifyRun } from './verify-cls.ts'

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
const task = option('--task',
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
const tsxLoader = path.join(dsh, 'node_modules/tsx/dist/esm/index.mjs')
const dshArgs = ['--import', `file://${tsxLoader}`, path.join(dsh, 'apps/cli/src/bin.ts'), '--profile', profile]
if (!flag('--no-plugin')) dshArgs.push('--patch', patchFile)
if (flag('--ptc')) dshArgs.push('--patch', path.join(dsh, 'apps/cli/config/examples/ptc.yml'))
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
const verified = code === 0 && await verifyRun(secrets, runId, started, outboxOf(path.join(work, 'home')))
console.log(verified ? 'E2E PASS' : 'E2E FAIL')
process.exit(verified ? 0 : 1)
