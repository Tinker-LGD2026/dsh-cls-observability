/**
 * DEV ONLY. Run DeepSeek Harness web (published npm build, Linux) in a local Docker
 * container with the plugin loaded, for trying it out in a browser.
 *
 *   node scripts/docker-web.ts [--port 18080]     start (or restart) the container
 *   docker logs -f dshcls-web                      follow DSH and plugin logs
 *   docker rm -f dshcls-web                        stop
 *
 * Credentials come from the dev secrets (AGENTOBS_DEV_SECRETS_FILE or environment) and
 * reach the container only as inherited environment variables (`docker run -e NAME`):
 * never on a command line, never written to disk. The agent works in a container-only
 * workspace volume; nothing from this machine is mounted except the built plugin.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { devEnv, loadDevSecrets } from './dev-secrets.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const at = args.indexOf('--port')
const port = at >= 0 ? Number(args[at + 1]) : 18080
const name = 'dshcls-web'
const image = process.env.LINUX_IMAGE ?? 'node:24-bookworm'
const plugin = path.join(root, 'dist', 'dsh-cls-observability.mjs')
if (!existsSync(plugin)) throw new Error('build the plugin first: node scripts/build.mjs')

const secrets = loadDevSecrets()
const env: Record<string, string> = {
  ...devEnv(secrets),
  CLS_AGENTOBS_ENVIRONMENT: 'dev',
  CLS_AGENTOBS_CUSTOM_ATTRIBUTES: 'trial=docker-web',
  CLS_AGENTOBS_DEBUG: 'true',
}

// Inside the container: the home patch exists before DSH starts (so later edits hot-reload),
// the plugin is inserted, and web binds the container's own address (wildcards are rejected).
const inner = `
set -e
mkdir -p "$DSH_HOME" /work
[ -f /work/README.txt ] || echo "dsh-cls-observability docker trial workspace" > /work/README.txt
printf -- '- insert:\\n    - id: cls-agentobs\\n      name: /opt/dsh-cls-observability/dsh-cls-observability.mjs\\n' > "$DSH_HOME/cordis.patch.yml"
ip=$(hostname -i | awk '{print $1}')
cd /work
exec node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open \\
  --host "$ip" --port ${port} \\
  --public-url http://localhost:${port}/ \\
  --trusted-host localhost:${port} --trusted-host 127.0.0.1:${port}
`

spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
const run = spawnSync('docker', [
  'run', '-d', '--init', '--name', name,
  '-p', `127.0.0.1:${port}:${port}`,
  '-v', 'dshcls-linux-dsh:/opt/dsh:ro',
  '-v', `${path.dirname(plugin)}:/opt/dsh-cls-observability:ro`,
  '-v', 'dshcls-web-home:/root/.dsh',
  '-v', 'dshcls-web-work:/work',
  '-e', 'DSH_HOME=/root/.dsh',
  ...Object.keys(env).flatMap((k) => ['-e', k]),
  image, 'bash', '-c', inner,
], { env: { ...process.env, ...env }, encoding: 'utf8' })
if (run.status !== 0) {
  process.stderr.write(run.stderr)
  process.exit(1)
}

// Wait for the web server and print its entry URL (token included).
for (let i = 0; i < 60; i++) {
  const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' })
  const out = `${logs.stdout}${logs.stderr}`
  const url = /dsh web:\s*(https?:\/\/\S+)/.exec(out)?.[1]
  if (url) {
    console.log(`DSH web is up (plugin ${out.includes('[cls-agentobs]') ? 'loaded' : 'NOT loaded'}).`)
    console.log(`Open: ${url}`)
    process.exit(0)
  }
  if (spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name], { encoding: 'utf8' }).stdout.trim() !== 'true') {
    console.log(out.split('\n').slice(-30).join('\n'))
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 1000))
}
console.log('timed out waiting for DSH web; see: docker logs dshcls-web')
process.exit(1)
