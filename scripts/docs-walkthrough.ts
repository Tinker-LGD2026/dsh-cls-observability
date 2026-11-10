/**
 * DEV ONLY. Follow the README from scratch in a fresh Linux container: install the plugin
 * from its npm package tarball, enable it, run selftest, headless, web, the SDK snippet and
 * the container entrypoint; then check in CLS that the runs arrived.
 *
 *   AGENTOBS_DEV_SECRETS_FILE=… node scripts/docs-walkthrough.ts
 *
 * Uses the DSH installed by scripts/linux-verify.sh (volumes dshcls-linux-dsh, -sdk) as the
 * customer's existing DSH; credentials reach the container only as inherited variables.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { searchSpans } from './cls-api.ts'
import { devEnv, loadDevSecrets } from './dev-secrets.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = path.join(root, '.tmp', 'walkthrough-pkg')
rmSync(pkgDir, { recursive: true, force: true })
mkdirSync(pkgDir, { recursive: true })
const pack = spawnSync('npm', ['pack', '--pack-destination', pkgDir, '--silent'], { cwd: root, encoding: 'utf8' })
if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`)
console.log(`packed ${readdirSync(pkgDir).join(', ')}`)

const secrets = loadDevSecrets()
const run = randomUUID()
const env = { ...devEnv(secrets), WALK_REGION: secrets.region, WALK_TOPIC: secrets.topicId, WALK_RUN: run }
const started = Date.now()
const result = spawnSync('docker', [
  'run', '--rm', '--init',
  '-v', `${pkgDir}:/pkg:ro`,
  '-v', `${path.join(root, 'examples', 'container')}:/pkg-deploy:ro`,
  '-v', `${path.join(root, 'scripts', 'docs-walkthrough.sh')}:/walk.sh:ro`,
  '-v', 'dshcls-linux-dsh:/opt/dsh:ro',
  '-v', 'dshcls-linux-sdk:/work/sdk:ro',
  ...Object.keys(env).flatMap((k) => ['-e', k]),
  'node:24-bookworm', 'bash', '/walk.sh',
], { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const out = `${result.stdout}${result.stderr}`
console.log(out.split('\n').filter((l) => /^(#####|ok:|FAILED:|WALKTHROUGH|sdk answer|walkthrough-)/.test(l) || /\b(ok|FAIL)\s{1,3}\w/.test(l)).join('\n'))
if (result.status !== 0) console.log('--- tail ---\n' + out.split('\n').slice(-40).join('\n'))

// The runs in CLS: headless, sdk and entrypoint turns tagged with this walkthrough.
let entries: string[] = []
for (let i = 0; i < 9 && entries.length < 3; i++) {
  await new Promise((r) => setTimeout(r, 10_000))
  const spans = (await searchSpans(secrets, started - 60_000, Date.now() + 60_000, `"${run}"`).catch(() => [])).filter((s) => s.attribute['agent.custom.walkthrough'] === run)
  entries = spans.filter((s) => s.attribute['gen_ai.span.kind'] === 'entry').map((s) => String(s.attribute['gen_ai.entry.type']))
}
console.log(`entries in CLS: ${entries.sort().join(', ') || 'none'}`)
const ok = result.status === 0 && entries.filter((e) => e === 'cli').length >= 2 && entries.includes('sdk')
console.log(ok ? 'DOCS WALKTHROUGH PASS' : 'DOCS WALKTHROUGH FAIL')
rmSync(pkgDir, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
