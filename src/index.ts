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
import { homedir, hostname, platform, release, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Collector, commonAttributes, type ContextLike } from './collector.ts'
import { processEnvReader, resolveConfig, type EnvReader, type EnvSource } from './config.ts'
import { DELIVER_FLAG, deliverOutbox, spawnDeliverer } from './deliver.ts'
import { encodeGzipBody, exportGzipBody, type ExporterConfig } from './exporter.ts'
import { ClosedTurnsFile, OpenSpansLedger } from './crash-closure.ts'
import { Journal } from './journal.ts'
import { limitSpanSize } from './size-limit.ts'
import { alive, Outbox } from './outbox.ts'
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
  // Without debug, a repeated warning (retries during an outage) is printed once a minute
  // with a count, so it does not flood an interactive terminal.
  const lastShown = new Map<string, { at: number; suppressed: number }>()
  return (level, message) => {
    if (level === 'debug' && !debug) return
    if (level === 'warn' && !debug) {
      const key = message.replace(/\d+/g, '#').slice(0, 60)
      const seen = lastShown.get(key)
      const now = Date.now()
      if (seen && now - seen.at < 60_000) { seen.suppressed++; return }
      if (seen?.suppressed) message += ` (${seen.suppressed} similar warnings suppressed)`
      lastShown.set(key, { at: now, suppressed: 0 })
      if (lastShown.size > 100) lastShown.delete(lastShown.keys().next().value!)
    }
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
  // Per-user name: on Linux the temp directory is shared by every account.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return path.join(tmpdir(), `dsh-cls-observability-${uid}`, 'outbox')
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
    maxQueueBytes: config.maxQueueBytes,
    ...(outboxUsable ? { outbox } : {}),
    ...(outboxUsable && config.journal ? { journal: new Journal(outbox.dir, { resource, scope }, log) } : {}),
    log,
  })

  // Turns this process has open: lets crash closure in a later process skip what was already sent.
  const openSpans = outboxUsable ? new OpenSpansLedger(outbox.dir) : undefined
  openSpans?.foldDead()
  const collector = new Collector({
    ...(outboxUsable ? { closedTurns: new ClosedTurnsFile(outbox.dir), emittedSpans: openSpans! } : {}),
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
      // CLS stores at most 8 MB per log: shrink captured content of an oversized span.
      if (config.captureContent && limitSpanSize(span)) log('debug', `span ${span.name} exceeded the CLS per-log limit; content shortened`)
      openSpans?.record(span)
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
      openSpans?.close()
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

// ---------------------------------------------------------------- operator commands

/**
 * Exporter and outbox directory from the standard CLS_AGENTOBS_* environment, for
 * commands run by an operator, an entrypoint script or a sidecar.
 */
function commandSetup(dirArg: string | undefined): { dir: string; exporter: ExporterConfig; log: (m: string) => void } {
  const result = resolveConfig(processEnvReader())
  if (!result.enabled) {
    process.stderr.write(`[cls-agentobs] ${result.reason}\n`)
    process.exit(2)
  }
  const config = result.config
  // Same default as DSH: $DSH_HOME (blank means unset), else ~/.dsh.
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path.join(homedir(), '.dsh')
  const dir = dirArg ?? config.dataDir ?? path.join(home, 'agentobs', 'outbox')
  const log = (m: string) => { if (config.debug) process.stderr.write(`[cls-agentobs] ${m}\n`) }
  return {
    dir,
    log,
    exporter: {
      endpoint: config.endpoint,
      ...(config.topicId ? { topicId: config.topicId } : {}),
      ...(config.credentials ? { credentials: config.credentials } : {}),
      timeoutMs: config.timeoutMs,
      gzip: true,
    },
  }
}

/**
 * `--flush [dir]`: deliver everything left in the outbox (including journals of dead
 * processes), waiting for a host still finishing its last batch. Exit code 0 when the
 * outbox is empty afterwards, 1 otherwise. Meant for container entrypoints after DSH exits.
 */
async function runFlush(dirArg: string | undefined): Promise<number> {
  const { dir, exporter, log } = commandSetup(dirArg)
  const attempts = Math.max(1, Number(process.env.CLS_AGENTOBS_FLUSH_ATTEMPTS ?? 4) || 4)
  const { delivered, remaining } = await deliverOutbox(dir, exporter, log, { claimWaitMs: 30_000, attempts })
  process.stderr.write(`[cls-agentobs] flush: delivered ${delivered} files, ${remaining} left in ${dir}\n`)
  return remaining === 0 ? 0 : 1
}

/**
 * `--relay [dir]`: keep delivering the outbox every few seconds (a sidecar sharing the
 * volume with DSH). On SIGTERM / SIGINT it runs a final flush and exits.
 */
async function runRelay(dirArg: string | undefined): Promise<number> {
  const { dir, exporter, log } = commandSetup(dirArg)
  const raw = Number(process.env.CLS_AGENTOBS_RELAY_INTERVAL_MS ?? 5_000)
  const interval = Number.isFinite(raw) ? Math.min(3_600_000, Math.max(500, raw)) : 5_000
  let stopping = false
  let wake: (() => void) | undefined
  const stop = () => { stopping = true; wake?.() }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.stderr.write(`[cls-agentobs] relay: delivering ${dir} every ${interval} ms\n`)
  while (!stopping) {
    await deliverOutbox(dir, exporter, log, { claimWaitMs: 0 })
    // Not unref'd: this timer is what keeps the relay process alive between rounds.
    await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, interval) })
  }
  const { remaining } = await deliverOutbox(dir, exporter, log, { claimWaitMs: 20_000 })
  process.stderr.write(`[cls-agentobs] relay stopped, ${remaining} files left\n`)
  return remaining === 0 ? 0 : 1
}

/**
 * `--selftest [dir]`: check what a DSH host would do with the current environment,
 * without writing any trace data: configuration, outbox, and an empty OTLP request that
 * CLS answers 200 (ok), 401/403 (credentials) or 404 (topic). Exit code 0 when all pass.
 */
async function runSelftest(dirArg: string | undefined): Promise<number> {
  const out = (ok: boolean | undefined, label: string, detail: string) =>
    process.stdout.write(`${ok === undefined ? '-   ' : ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}\n`)
  const result = resolveConfig(processEnvReader())
  for (const w of result.warnings) out(undefined, 'warning', w)
  if (!result.enabled) {
    out(false, 'configuration', result.reason)
    return 1
  }
  const config = result.config
  out(true, 'configuration', `endpoint ${config.endpoint}${config.topicId ? `, topic ${config.topicId}` : ''}, credentials ${config.credentials ? (config.credentialsFile ? `from ${config.credentialsFile}` : 'from environment') : 'none'}`)
  out(true, 'content', config.captureContent ? `captured (${config.maxContentChars === 1_000_000 ? 'full' : `truncated at ${config.maxContentChars}`}), redaction ${config.redactor ? 'on' : 'OFF'}` : 'not captured')
  let failed = false
  const { dir, exporter } = commandSetup(dirArg)
  const outbox = new Outbox(dir)
  const writable = outbox.ensure()
  out(writable, 'outbox', writable ? `${dir} writable, ${outbox.pending().length} files waiting` : `${dir} not writable: spans undelivered at exit or during an outage would be lost`)
  failed ||= !writable
  const started = Date.now()
  const probe = await exportGzipBody(exporter, encodeGzipBody({ resource: {}, scope: { name: 'dsh-cls-observability-selftest', version: VERSION }, spans: [] }))
  const ms = Date.now() - started
  const verdict: Record<string, string> = {
    ok: `reachable, credentials and topic accepted (${ms} ms)`,
    auth: `credentials rejected: ${'error' in probe ? probe.error.trim() : ''}`,
    config: `topic or endpoint not found: ${'error' in probe ? probe.error.trim() : ''}`,
    rejected: `request rejected: ${'error' in probe ? probe.error.trim() : ''}`,
    retryable: `not reachable: ${'error' in probe ? probe.error.trim() : ''}`,
  }
  out(probe.kind === 'ok', 'destination', verdict[probe.kind] ?? probe.kind)
  failed ||= probe.kind !== 'ok'
  return failed ? 1 : 0
}

const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
for (const [flag, run] of [['--flush', runFlush], ['--relay', runRelay], ['--selftest', runSelftest]] as const) {
  const at = process.argv.indexOf(flag)
  if (isMain && at > 0) {
    const arg = process.argv[at + 1]
    run(arg && !arg.startsWith('--') ? arg : undefined).then((code) => process.exit(code), (error) => {
      process.stderr.write(`[cls-agentobs] ${flag} failed: ${String(error)}\n`)
      process.exit(1)
    })
  }
}
