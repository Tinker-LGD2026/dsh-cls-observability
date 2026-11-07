// Bundle src/index.ts into a single zero-dependency ESM file: dist/dsh-cls-observability.mjs
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const outfile = 'dist/dsh-cls-observability.mjs'

const result = await build({
  entryPoints: ['src/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  minify: false,
  legalComments: 'none',
  metafile: true,
  define: { __AGENTOBS_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: `// ${pkg.name} ${pkg.version} — CLS AgentObs collector for DeepSeek Harness. Zero runtime dependencies.` },
})

const external = Object.values(result.metafile.outputs)
  .flatMap((o) => o.imports ?? [])
  .filter((i) => i.external && !i.path.startsWith('node:'))
if (external.length > 0) {
  console.error('non-builtin runtime imports found:', external.map((i) => i.path))
  process.exit(1)
}
const bytes = readFileSync(outfile)
const sha = createHash('sha256').update(bytes).digest('hex')
writeFileSync(`${outfile}.sha256`, `${sha}  dsh-cls-observability.mjs\n`)
console.log(`built ${outfile} (${(bytes.length / 1024).toFixed(1)} KiB) sha256=${sha}`)
