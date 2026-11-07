/**
 * CLS AgentObs collector for DeepSeek Harness — Cordis plugin entry.
 *
 * Load by path from any patch layer, e.g. `$DSH_HOME/cordis.patch.yml`:
 *   - insert:
 *       - id: cls-agentobs
 *         name: /opt/agentobs/dsh-cls-observability.mjs
 * Enable with CLS_AGENTOBS_ENABLED=true in the real process environment.
 *
 * The same file doubles as the detached outbox deliverer:
 *   node dsh-cls-observability.mjs --agentobs-deliver <outbox-dir>
 */
import { hostname, platform, release, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Collector, commonAttributes, type ContextLike } from './collector.ts'
import { processEnvReader, resolveConfig, type EnvReader, type EnvSource } from './config.ts'
import { DELIVER_FLAG, deliverOutbox, spawnDeliverer } from './deliver.ts'
import type { ExporterConfig } from './exporter.ts'
import { ClosedTurnsFile } from './crash-closure.ts'
import { Journal } from './journal.ts'
import { Outbox } from './outbox.ts'
import { ExportQueue } from './queue.ts'
import type { Attributes } from './otlp/types.ts'

declare const __AGENTOBS_VERSION__: string
export const VERSION: string = typeof __AGENTOBS_VERSION__ === 'string' ? __AGENTOBS_VERSION__ : '0.0.0-dev'

export const name = 'cls-agentobs'

interface PluginContext extends ContextLike {
  get?(key: string): unknown
  effect?(body: () => (() => unknown) | void): unknown
}

interface LaunchSnapshot {
  getFrom(name: string, sources: readonly EnvSource[]): { value: string; source: EnvSource } | undefined
}

function envReaderFor(ctx: PluginContext): EnvReader {
  const snapshot = ctx.get?.('launchEnvironment') as LaunchSnapshot | undefined
  if (snapshot && typeof snapshot.getFrom === 'function') return { getFrom: (n, s) => snapshot.getFrom(n, s) }
  // Not launched by dsh (e.g. a bare Cordis loader): only the inherited process env exists.
  return processEnvReader()
}

const loadedAt = Date.now()

function logger(debug: boolean): (level: 'debug' | 'warn', message: string) => void {
  // stderr only: in the sdk/acp profiles stdout carries the JSON-RPC protocol.
  return (level, message) => {
    if (level === 'debug' && !debug) return
    const t = debug ? ` +${((Date.now() - loadedAt) / 1000).toFixed(2)}s` : ''
    process.stderr.write(`[cls-agentobs]${t} ${level}: ${message}\n`)
  }
}

function outboxDir(ctx: PluginContext, configured: string | undefined): string {
  if (configured) return configured
  const homePath = ctx.get?.('dshHomePath')
  if (typeof homePath === 'function') {
    try { return (homePath as (...s: string[]) => string)('agentobs', 'outbox') } catch { /* fall through */ }
  }
  return path.join(tmpdir(), 'dsh-cls-observability', 'outbox')
}

export function apply(ctx: PluginContext): void {
  let result: ReturnType<typeof resolveConfig>
  try {
    const profile = (ctx.get?.('profileContext') as { name?: string } | undefined)?.name
    result = resolveConfig(envReaderFor(ctx), profile)
  } catch (error) {
    logger(false)('warn', `disabled: configuration error: ${String(error)}`)
    return
  }
  const early = logger(result.enabled && result.config.debug)
  for (const warning of result.warnings) early('warn', warning)
  if (!result.enabled) {
    early('debug', `disabled: ${result.reason}`)
    if (!result.reason.startsWith('CLS_AGENTOBS_ENABLED')) early('warn', `disabled: ${result.reason}`)
    return
  }
  const config = result.config
  const log = logger(config.debug)

  const resource: Attributes = {
    'service.name': config.serviceName,
    'service.instance.id': `${hostname()}:${process.pid}`,
    'host.name': hostname(),
    'process.pid': process.pid,
    'process.runtime.name': 'nodejs',
    'process.runtime.version': process.versions.node,
    'telemetry.sdk.name': 'dsh-cls-observability',
    'telemetry.sdk.language': 'nodejs',
    'telemetry.sdk.version': VERSION,
    'os.type': platform(),
    'os.version': release(),
    'cloud.provider': 'tencent_cloud',
    ...(config.region ? { 'cloud.region': config.region } : {}),
    ...(config.deploymentEnvironment ? { 'deployment.environment.name': config.deploymentEnvironment } : {}),
  }

  const exporter: ExporterConfig = {
    endpoint: config.endpoint,
    ...(config.topicId ? { topicId: config.topicId } : {}),
    ...(config.credentials ? { credentials: config.credentials } : {}),
    timeoutMs: config.timeoutMs,
    gzip: true,
  }
  const outbox = new Outbox(outboxDir(ctx, config.dataDir))
  const outboxUsable = outbox.ensure()
  if (!outboxUsable) log('warn', `outbox ${outbox.dir} is not writable; spans undelivered at exit will be lost`)

  const scope = { name: 'dsh-cls-observability', version: VERSION }
  const queue = new ExportQueue({
    exporter,
    resource,
    scope,
    maxBatchSpans: 512,
    flushIntervalMs: 2_000,
    maxQueueSpans: config.maxQueueSpans,
    ...(outboxUsable ? { outbox } : {}),
    ...(outboxUsable && config.journal ? { journal: new Journal(outbox.dir, { resource, scope }, log) } : {}),
    log,
  })

  const collector = new Collector({
    ...(outboxUsable ? { closedTurns: new ClosedTurnsFile(outbox.dir) } : {}),
    builder: {
      captureContent: config.captureContent,
      maxContentChars: config.maxContentChars,
      commonAttributes: commonAttributes(config),
      ...(config.redactor ? { redactor: config.redactor } : {}),
    },
    includeAuxiliary: config.includeAuxiliary,
    sampleRatio: config.sampleRatio,
    emit: (span) => {
      if (config.debug) log('debug', `span ${String(span.attributes['gen_ai.span.kind'])} ${span.name}`)
      // No immediate send at turn end: a one-shot host disposes milliseconds later, and a
      // request caught in flight at exit is the only source of duplicates. The regular
      // eager send covers long-lived hosts; at exit the batch is spilled and handed to the
      // detached deliverer instead.
      queue.push(span)
    },
    log,
  })
  collector.attach(ctx)

  const start = () => {
    queue.start()
    log('debug', `enabled: endpoint=${config.endpoint} content=${config.captureContent} entry=${config.entryType} outbox=${outboxUsable ? outbox.dir : 'none'}`)
    return async () => {
      log('debug', `stopping: ${queue.stats.pending} pending spans`)
      // Runs synchronously right after the spill, before any await: the host may
      // block the event loop or force-exit at any later point.
      const onSpill = (): boolean => {
        if (!config.detachedDelivery) return false
        const credentials = config.credentials?.()
        const spawned = spawnDeliverer({
          dir: outbox.dir,
          endpoint: config.endpoint,
          ...(config.topicId ? { topicId: config.topicId } : {}),
          ...(config.credentialsFile ? { credentialsFile: config.credentialsFile } : credentials ? { credentials } : {}),
          proxy: config.proxy,
        }, import.meta.url)
        log('debug', spawned ? 'spilled pending spans; started detached deliverer' : 'spilled pending spans; deliverer unavailable, kept in outbox')
        return spawned
      }
      await queue.stop(config.shutdownTimeoutMs, onSpill)
      const s = queue.stats
      log('debug', `stopped: enqueued=${s.enqueued} exported=${s.exported} spilled=${s.spilled} recovered=${s.recovered} dropped=${s.dropped} rejected=${s.rejected} retried=${s.retried}`)
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(start)
  else start()
}

export default { name, apply }

// ---------------------------------------------------------------- deliverer mode

async function runDeliverer(dir: string): Promise<void> {
  const endpoint = process.env.AGENTOBS_DELIVER_ENDPOINT
  if (!endpoint) process.exit(2)
  const file = process.env.AGENTOBS_DELIVER_CREDENTIALS_FILE
  let credentials: ExporterConfig['credentials']
  if (file) {
    const { resolveConfig: resolve } = await import('./config.ts')
    // Reuse the credentials-file parser through the normal config path.
    const r = resolve(processEnvReader({ CLS_AGENTOBS_ENABLED: 'true', CLS_AGENTOBS_ENDPOINT: endpoint, CLS_AGENTOBS_CREDENTIALS_FILE: file, CLS_AGENTOBS_ALLOW_HTTP: 'true' }))
    if (r.enabled && r.config.credentials) credentials = r.config.credentials
  } else if (process.env.TENCENTCLOUD_SECRET_ID && process.env.TENCENTCLOUD_SECRET_KEY) {
    const fixed = { secretId: process.env.TENCENTCLOUD_SECRET_ID, secretKey: process.env.TENCENTCLOUD_SECRET_KEY }
    credentials = () => fixed
  }
  await deliverOutbox(dir, {
    endpoint,
    ...(process.env.AGENTOBS_DELIVER_TOPIC_ID ? { topicId: process.env.AGENTOBS_DELIVER_TOPIC_ID } : {}),
    ...(credentials ? { credentials } : {}),
    timeoutMs: 15_000,
    gzip: true,
  })
}

const deliverAt = process.argv.indexOf(DELIVER_FLAG)
if (deliverAt > 0 && process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dir = process.argv[deliverAt + 1]
  if (!dir) process.exit(2)
  runDeliverer(dir).then(() => process.exit(0), () => process.exit(1))
}
