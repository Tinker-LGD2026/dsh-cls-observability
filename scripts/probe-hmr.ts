/**
 * DEV ONLY. Does editing $DSH_HOME/cordis.patch.yml load a plugin into a running
 * `dsh --profile web`? Uses a tiny probe plugin, no model calls, no credentials.
 *   DSH_BIN=<built dsh lib/bin.js> node scripts/probe-hmr.ts
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, '.tmp', 'hmr-probe')
rmSync(dir, { recursive: true, force: true })
mkdirSync(path.join(dir, 'home'), { recursive: true })
mkdirSync(path.join(dir, 'ws'), { recursive: true })
const probe = path.join(dir, 'probe.mjs')
writeFileSync(probe, `export const name = 'hmr-probe'
export function apply(ctx) { process.stderr.write('[hmr-probe] loaded\\n'); ctx.on('dispose', () => process.stderr.write('[hmr-probe] disposed\\n')) }
`)
const patch = path.join(dir, 'home', 'cordis.patch.yml')
const initial = process.argv.includes('--absent') ? undefined : '[]\n'
if (initial !== undefined) writeFileSync(patch, initial)

const port = await new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)) })
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const child = spawn(process.execPath, [path.resolve(process.env.DSH_BIN!), '--profile', 'web', '--no-open', '--port', String(port)], {
  cwd: path.join(dir, 'ws'),
  env: { ...process.env, DSH_HOME: path.join(dir, 'home') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => { out += d })
child.stderr.on('data', (d) => { out += d })
const mark = (label: string) => console.log(`[${label}] ${out.replace(/token=[\w-]+/g, 'token=***').split('\n').filter(Boolean).slice(-4).join(' | ')}`)

for (let i = 0; i < 60 && !out.includes('dsh web:'); i++) await sleep(500)
mark(`up, initial patch ${initial === undefined ? 'absent' : 'present'}`)
writeFileSync(patch, `- insert:\n    - id: hmr-probe\n      name: ${probe}\n`)
await sleep(12_000)
mark('12s after insert')
const t = new Date()
utimesSync(patch, t, t)
await sleep(6_000)
mark('after touch')
console.log(out.includes('[hmr-probe] loaded') ? 'HOT LOAD: YES' : 'HOT LOAD: NO')
child.kill('SIGINT')
await sleep(3_000)
if (child.exitCode === null) child.kill('SIGKILL')
