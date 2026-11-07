/**
 * DEV ONLY. End-to-end through the official TypeScript SDK — the "customer program
 * launches DSH" path. Integration is exactly what a customer adds: one entry in
 * `patches` and the CLS variables in `env` (based on the parent env: the SDK's
 * `env` replaces the child environment entirely).
 *
 * Runs DSH from source (this checkout's built lib/ predates 0.2.2), mirroring the
 * SDK's own source-launch mode. Execute under tsx:
 *   node --import <dsh>/node_modules/tsx/dist/esm/index.mjs scripts/e2e-sdk.ts
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { devEnv, loadDevSecrets } from './dev-secrets.ts'
import { outboxOf, verifyRun } from './verify-cls.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
// A DeepSeek Harness source checkout (default: a sibling directory).
const dsh = path.resolve(process.env.DSH_REPO ?? path.join(root, '../deepseek-harness'))
const { createProcessDeepSeekHarness } = await import(pathToFileURL(path.join(dsh, 'packages/sdk/client/src/api.ts')).href)

const runId = randomUUID()
const work = path.join(root, '.tmp', `e2e-sdk-${runId.slice(0, 8)}`)
const home = path.join(work, 'home')
const workspace = path.join(work, 'workspace')
mkdirSync(home, { recursive: true })
mkdirSync(workspace, { recursive: true })
writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'agentobs-sdk-workspace', private: true }, null, 2))

// The customer-side integration: one patch file + env.
const patch = path.join(work, 'agentobs.patch.yml')
writeFileSync(patch, `- insert:\n    - id: cls-agentobs\n      name: ${path.join(root, 'dist', 'dsh-cls-observability.mjs')}\n`)
const secrets = loadDevSecrets()
const parentEnv: NodeJS.ProcessEnv = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('OTEL_')) parentEnv[k] = v
const env = {
  ...parentEnv,
  ...devEnv(secrets),
  CLS_AGENTOBS_DEBUG: 'true',
  CLS_AGENTOBS_ENVIRONMENT: 'dev',
  CLS_AGENTOBS_CUSTOM_ATTRIBUTES: `e2e_run=${runId}`,
  DSH_HOME: home,
  TSX_TSCONFIG_PATH: path.join(dsh, 'apps/cli/tsconfig.json'),
}

const tsx = pathToFileURL(path.join(dsh, 'node_modules/tsx/dist/esm/index.mjs')).href
const runtime = {
  command: process.execPath,
  args: [
    '--import', tsx, path.join(dsh, 'apps/cli/src/bin.ts'), '--profile', 'sdk',
    '--patch', path.join(dsh, 'apps/cli/src/sdk-source.cordis.patch.yml'),
    '--patch', patch,
  ],
  cwd: workspace,
  environment: () => env,
  description: 'dsh profile "sdk" (source)',
  initializeTimeoutMs: 60_000,
}

console.log(`run ${runId} profile=sdk`)
const started = Date.now()
const harness = createProcessDeepSeekHarness(runtime, { cwd: workspace })
let ok = false
try {
  const result = await harness.run('Use your bash tool to run exactly: echo agentobs-sdk-ok . Then reply with only the command output.')
  console.log(`answer: ${String(result.finalResponse).trim().slice(0, 200)} (finish=${JSON.stringify(result.finishReason)})`)
  const second = await harness.run('Now reply with the single word: done', { sessionId: result.sessionId })
  console.log(`second turn: ${String(second.finalResponse).trim().slice(0, 80)}`)
  ok = true
} catch (error) {
  console.log(`sdk run failed: ${String(error).slice(0, 2000)}`)
} finally {
  await harness.close()
}
console.log(`sdk session closed after ${((Date.now() - started) / 1000).toFixed(1)}s`)
const verified = ok && await verifyRun(secrets, runId, started, outboxOf(home))
console.log(verified ? 'E2E SDK PASS' : 'E2E SDK FAIL')
process.exit(verified ? 0 : 1)
